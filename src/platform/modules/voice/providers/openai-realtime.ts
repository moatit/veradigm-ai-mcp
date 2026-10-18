import WebSocket from 'ws';
import { ProviderEvents, ProviderInit, VoiceProvider } from './types';

/**
 * OpenAI Realtime (GA interface) over WebSocket: wss://api.openai.com/v1/realtime?model=<model>.
 * PCM 24 kHz both ways, server-side turn detection with barge-in, input transcription for the caller's side of the
 * transcript, function tools. The key comes from OPENAI_API_KEY (the MOATiT project under the BAA) and is only
 * ever sent in the Authorization header of this TLS connection.
 *
 * Event names checked against developers.openai.com (Oct 18 2026): response.output_audio.delta,
 * response.output_audio_transcript.delta/.done, conversation.item.input_audio_transcription.completed,
 * input_audio_buffer.speech_started/.speech_stopped, response.function_call_arguments.done, response.done,
 * conversation.item.truncate, conversation.item.create (function_call_output, assistant output_text, system input_text).
 */
export class OpenAiRealtime implements VoiceProvider {
  readonly name = 'openai' as const;
  readonly pcmRate = 24000;
  private ws: WebSocket | null = null;
  private ev: ProviderEvents | null = null;
  private seenCalls = new Set<string>();
  /** response id -> assistant audio item id (for truncation). */
  private audioItem = new Map<string, string>();
  private active: string | null = null;
  private closedOnce = false;

  constructor(
    private readonly apiKey: string,
    private readonly url = 'wss://api.openai.com/v1/realtime',
    private readonly WS: typeof WebSocket = WebSocket
  ) {}

  connect(init: ProviderInit, events: ProviderEvents): Promise<void> {
    this.ev = events;
    return new Promise((resolve, reject) => {
      const ws = new this.WS(`${this.url}?model=${encodeURIComponent(init.model)}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        handshakeTimeout: 8000,
        maxPayload: 8 << 20,
      });
      this.ws = ws;
      let opened = false;
      ws.on('open', () => {
        opened = true;
        this.send({ type: 'session.update', session: this.session(init) });
        resolve();
      });
      ws.on('message', (data: WebSocket.RawData) => this.onMessage(data));
      ws.on('error', (e: any) => {
        if (!opened) reject(new Error(`realtime connect failed (${e?.code || 'error'})`));
        else events.error('ws_error', true);
      });
      ws.on('unexpected-response', (_req: any, res: any) => {
        reject(new Error(`realtime connect refused (http ${res?.statusCode || 0})`));
      });
      ws.on('close', (code: number) => {
        if (this.closedOnce) return;
        this.closedOnce = true;
        events.closed(String(code));
      });
    });
  }

  private session(init: ProviderInit) {
    const turn =
      init.turn.vad === 'server_vad'
        ? { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: init.turn.silence_ms, create_response: true, interrupt_response: true }
        : { type: 'semantic_vad', eagerness: init.turn.eagerness || 'auto', create_response: true, interrupt_response: true };
    return {
      type: 'realtime',
      instructions: init.instructions,
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          noise_reduction: { type: 'near_field' },
          transcription: { model: process.env.VOICE_OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-transcribe', language: init.language || 'en' },
          turn_detection: turn,
        },
        output: { format: { type: 'audio/pcm', rate: 24000 }, voice: init.voice },
      },
      tools: init.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })),
      tool_choice: 'auto',
    };
  }

  private send(obj: unknown): void {
    if (this.ws && this.ws.readyState === this.WS.OPEN) this.ws.send(JSON.stringify(obj));
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
      case 'response.created':
        this.active = m.response?.id || null;
        if (this.active) ev.responseStarted(this.active);
        break;
      case 'response.output_item.added':
        if (m.item?.type === 'message' && m.response_id && m.item.id) this.audioItem.set(m.response_id, m.item.id);
        break;
      case 'response.output_audio.delta':
        if (typeof m.delta === 'string') ev.audio(Buffer.from(m.delta, 'base64'), m.response_id || this.active || '');
        break;
      case 'response.output_audio_transcript.delta':
        if (typeof m.delta === 'string') ev.agentTranscript(m.delta, false, m.response_id || '');
        break;
      case 'response.output_audio_transcript.done':
        if (typeof m.transcript === 'string') ev.agentTranscript(m.transcript, true, m.response_id || '');
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (typeof m.transcript === 'string') ev.callerTranscript(m.transcript);
        if (m.usage) ev.transcriptionUsage?.(m.usage);
        break;
      case 'input_audio_buffer.speech_started':
        ev.speechStarted();
        break;
      case 'input_audio_buffer.speech_stopped':
        ev.speechStopped();
        break;
      case 'response.function_call_arguments.done':
        this.toolCall(m.call_id, m.name, m.arguments);
        break;
      case 'response.done': {
        const r = m.response || {};
        for (const item of Array.isArray(r.output) ? r.output : []) {
          if (item?.type === 'function_call') this.toolCall(item.call_id, item.name, item.arguments);
        }
        if (this.active === r.id) this.active = null;
        if (r.usage) ev.usage?.(r.usage);
        ev.responseDone(r.id || '', (r.status as any) || 'completed');
        break;
      }
      case 'error': {
        // Codes only: the message can quote conversation content.
        const code = String(m.error?.code || m.error?.type || 'error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60);
        // The parameter name (never its value) says which request was refused.
        const param = String(m.error?.param || '').replace(/[^A-Za-z0-9_.\[\]-]/g, '').slice(0, 60);
        ev.error(param ? `${code}:${param}` : code, false);
        break;
      }
    }
  }

  private toolCall(callId: unknown, name: unknown, args: unknown): void {
    if (typeof callId !== 'string' || typeof name !== 'string' || this.seenCalls.has(callId)) return;
    this.seenCalls.add(callId);
    let parsed: any = {};
    try {
      parsed = typeof args === 'string' && args.trim() ? JSON.parse(args) : {};
    } catch {
      parsed = { __unparsable: true };
    }
    this.ev!.toolCall({ id: callId, name, args: parsed });
  }

  sendAudio(pcm: Buffer): void {
    this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
  }

  sendToolResult(callId: string, output: string, respond: boolean): void {
    this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output } });
    if (respond) this.send({ type: 'response.create' });
  }

  addAssistantText(text: string): void {
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
  }

  addSystemNote(text: string, respond: boolean): void {
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] } });
    if (respond) this.send({ type: 'response.create' });
  }

  truncate(responseId: string, playedMs: number): void {
    const item = this.audioItem.get(responseId);
    if (item) this.send({ type: 'conversation.item.truncate', item_id: item, content_index: 0, audio_end_ms: Math.max(0, Math.round(playedMs)) });
  }

  cancelResponse(): void {
    if (this.active) this.send({ type: 'response.cancel' });
  }

  requestResponse(): void {
    this.send({ type: 'response.create' });
  }

  close(): void {
    this.closedOnce = true;
    try {
      this.ws?.close(1000);
    } catch {
      // ignore
    }
    this.ws = null;
  }
}
