import WebSocket from 'ws';
import { ProviderEvents, ProviderInit, ToolSpec, VoiceProvider } from './types';

/**
 * ElevenLabs Conversational AI over WebSocket. The agent (prompt defaults, tools as "client tools", voice, audio
 * formats, privacy) lives in ElevenLabs and is provisioned from our configuration (provisionElevenLabsAgent);
 * each call fetches a signed URL with the API key (ELEVENLABS_API_KEY, header xi-api-key, never in the URL) and
 * overrides the prompt and voice for the call. Client tool calls come back to the orchestrator and run in
 * Drawbridge under the call ID Drawbridge minted, exactly like OpenAI's function calls.
 *
 * Audio: PCM 16 kHz both ways (user_input_audio_format / agent_output_audio_format pcm_16000).
 * HIPAA: ElevenLabs needs an Enterprise BAA with zero-retention mode before any real patient call; until then the
 * harness refuses ElevenLabs agents unless VOICE_ALLOW_NON_BAA_PROVIDER=synthetic-only (test calls only).
 */
export class ElevenLabsConvai implements VoiceProvider {
  readonly name = 'elevenlabs' as const;
  readonly pcmRate = 16000;
  private ws: WebSocket | null = null;
  private ev: ProviderEvents | null = null;
  private n = 0;
  private current: string | null = null;
  private doneTimer: NodeJS.Timeout | null = null;
  private answered = false;
  private closedOnce = false;

  constructor(
    private readonly apiKey: string,
    private readonly api = 'https://api.elevenlabs.io',
    private readonly WS: typeof WebSocket = WebSocket
  ) {}

  async connect(init: ProviderInit, events: ProviderEvents): Promise<void> {
    this.ev = events;
    if (!init.agentId) throw new Error('no ElevenLabs agent configured');
    const r = await fetch(`${this.api}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(init.agentId)}`, {
      headers: { 'xi-api-key': this.apiKey },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`signed url http ${r.status}`);
    const { signed_url } = (await r.json()) as { signed_url?: string };
    if (!signed_url || !signed_url.startsWith('wss://')) throw new Error('signed url missing');
    await new Promise<void>((resolve, reject) => {
      const ws = new this.WS(signed_url, { handshakeTimeout: 8000, maxPayload: 8 << 20 });
      this.ws = ws;
      let opened = false;
      ws.on('open', () => {
        opened = true;
        this.send({
          type: 'conversation_initiation_client_data',
          conversation_config_override: {
            agent: { prompt: { prompt: init.instructions }, first_message: '', language: init.language || 'en' },
            tts: { voice_id: init.voice },
          },
          dynamic_variables: init.vars,
        });
        resolve();
      });
      ws.on('message', (d: WebSocket.RawData) => this.onMessage(d));
      ws.on('error', (e: any) => {
        if (!opened) reject(new Error(`convai connect failed (${e?.code || 'error'})`));
        else events.error('ws_error', true);
      });
      ws.on('close', (code: number) => {
        if (this.closedOnce) return;
        this.closedOnce = true;
        events.closed(String(code));
      });
    });
  }

  private send(o: unknown): void {
    if (this.ws && this.ws.readyState === this.WS.OPEN) this.ws.send(JSON.stringify(o));
  }

  private startResponse(): string {
    if (!this.current) {
      this.current = `el-${++this.n}`;
      this.answered = false;
      this.ev!.responseStarted(this.current);
    }
    return this.current;
  }

  private endResponseSoon(status: 'completed' | 'cancelled'): void {
    if (this.doneTimer) clearTimeout(this.doneTimer);
    const fire = () => {
      this.doneTimer = null;
      if (this.current) {
        const id = this.current;
        this.current = null;
        this.ev!.responseDone(id, status);
      }
    };
    if (status === 'cancelled') fire();
    else this.doneTimer = setTimeout(fire, 700);
  }

  private onMessage(data: WebSocket.RawData): void {
    let m: any;
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    const ev = this.ev!;
    switch (m.type) {
      case 'conversation_initiation_metadata': {
        const meta = m.conversation_initiation_metadata_event || {};
        if (meta.user_input_audio_format !== 'pcm_16000' || meta.agent_output_audio_format !== 'pcm_16000') ev.error('audio_format_mismatch', true);
        break;
      }
      case 'audio': {
        const b64 = m.audio_event?.audio_base_64;
        if (typeof b64 === 'string') {
          const id = this.startResponse();
          ev.audio(Buffer.from(b64, 'base64'), id);
          if (this.answered) this.endResponseSoon('completed');
        }
        break;
      }
      case 'agent_response': {
        const id = this.startResponse();
        const t = m.agent_response_event?.agent_response;
        if (typeof t === 'string') ev.agentTranscript(t, true, id);
        this.answered = true;
        this.endResponseSoon('completed');
        break;
      }
      case 'user_transcript': {
        const t = m.user_transcription_event?.user_transcript;
        if (typeof t === 'string') ev.callerTranscript(t);
        break;
      }
      case 'interruption':
        ev.speechStarted();
        this.endResponseSoon('cancelled');
        break;
      case 'ping':
        this.send({ type: 'pong', event_id: m.ping_event?.event_id });
        break;
      case 'client_tool_call': {
        const c = m.client_tool_call || {};
        if (typeof c.tool_call_id === 'string' && typeof c.tool_name === 'string') {
          ev.toolCall({ id: c.tool_call_id, name: c.tool_name, args: c.parameters && typeof c.parameters === 'object' ? c.parameters : {} });
        }
        break;
      }
    }
  }

  sendAudio(pcm: Buffer): void {
    this.send({ user_audio_chunk: pcm.toString('base64') });
  }

  sendToolResult(callId: string, output: string): void {
    this.send({ type: 'client_tool_result', tool_call_id: callId, result: output, is_error: false });
  }

  addAssistantText(text: string): void {
    this.send({ type: 'contextual_update', text: `The assistant just said to the caller, exactly: "${text}"` });
  }

  addSystemNote(text: string): void {
    this.send({ type: 'contextual_update', text });
  }

  truncate(): void {
    // ElevenLabs tracks interruptions itself.
  }

  cancelResponse(): void {
    // No client-side cancel; the orchestrator drops this response's audio.
  }

  requestResponse(): void {
    // The agent speaks on the next caller turn.
  }

  close(): void {
    this.closedOnce = true;
    if (this.doneTimer) clearTimeout(this.doneTimer);
    try {
      this.ws?.close(1000);
    } catch {
      // ignore
    }
    this.ws = null;
  }
}

/**
 * Create (or update) the ElevenLabs agent that carries one Drawbridge voice configuration: client tools, prompt,
 * voice, 16 kHz PCM, per-call overrides allowed, audio recording off and zero retention requested. Returns the
 * agent ID (store it on the configuration; it is not a secret). Not run automatically: an administrator triggers it.
 */
export async function provisionElevenLabsAgent(
  apiKey: string,
  opts: { agentId?: string; name: string; instructions: string; voice: string; language: string; llm: string; tools: ToolSpec[] },
  api = 'https://api.elevenlabs.io'
): Promise<string> {
  const body = {
    name: opts.name.slice(0, 80),
    conversation_config: {
      agent: {
        first_message: '',
        language: opts.language || 'en',
        prompt: {
          prompt: opts.instructions,
          llm: opts.llm,
          tools: opts.tools.map((t) => ({ type: 'client', name: t.name, description: t.description, parameters: t.parameters, expects_response: true, response_timeout_secs: 20 })),
        },
      },
      asr: { user_input_audio_format: 'pcm_16000' },
      tts: { voice_id: opts.voice, agent_output_audio_format: 'pcm_16000' },
    },
    platform_settings: {
      overrides: { conversation_config_override: { agent: { prompt: { prompt: true }, first_message: true, language: true }, tts: { voice_id: true } } },
      privacy: { record_voice: false, retention_days: 0 },
    },
  };
  const url = opts.agentId ? `${api}/v1/convai/agents/${encodeURIComponent(opts.agentId)}` : `${api}/v1/convai/agents/create`;
  const r = await fetch(url, {
    method: opts.agentId ? 'PATCH' : 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`agent ${opts.agentId ? 'update' : 'create'} http ${r.status}`);
  const j = (await r.json().catch(() => ({}))) as { agent_id?: string };
  const id = opts.agentId || j.agent_id || '';
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new Error('no agent id returned');
  return id;
}
