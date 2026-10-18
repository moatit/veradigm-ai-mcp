import { randomUUID } from 'crypto';
import * as http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { auditToolCall } from '../../audit';
import { securityEvent, throttledSecurityEvent } from '../../security-events';
import { currentMode } from '../../../unity/oncall/call-mode';
import { ToolDef } from '../../agent-tools';
import { activeAgent, AgentConfig } from './config';
import { AUTH_HEADER, CallStart, decodeFrame, GwCommand, GwEvent, GwStatus, NonceCache, verifyAuth } from './protocol';
import { ClipStore, elevenLabsTts, openAiTts, REQUIRED_SCRIPTS, scriptTexts, TtsRenderer } from './scripts';
import { CallSession, SessionDeps } from './session';
import { CallTranscript } from './transcript';
import { agentToolSpecs, allowedToolNames, nowInClinicTz, promptTemplate, renderPrompt } from './tools';
import { OpenAiRealtime } from './providers/openai-realtime';
import { ElevenLabsConvai } from './providers/elevenlabs';
import { openAiTranscriber, TranscriberFactory } from './providers/transcriber';
import { VoiceProvider } from './providers/types';
import { AGENT_TOOLS } from '../../agent-tools';

/**
 * The harness end of the gateway link: a WebSocket server on the internal Docker network only (VOICE_HARNESS_PORT,
 * default 3010; never published, nginx never proxies it), started inside the Unity server process when
 * VOICE_ENABLED=on and VOICE_GW_SECRET (32+ characters) is set. Fails closed: without the secret nothing listens.
 *
 * Call admission (else the gateway answers 480/503 and the PBX's no-answer route takes the call):
 *  - an active agent configuration and its provider key (OPENAI_API_KEY / ELEVENLABS_API_KEY) in the environment;
 *    ElevenLabs only with VOICE_ALLOW_NON_BAA_PROVIDER=synthetic-only (no BAA yet);
 *  - SRTP on the call, unless VOICE_ALLOW_PLAIN_RTP=synthetic-only (test calls with synthetic patients only);
 *  - the safety clips rendered and checksum-verified;
 *  - fewer than VOICE_MAX_SESSIONS (default 4) calls in progress;
 *  - the model connected.
 */
export interface HarnessDeps extends SessionDeps {
  toolDefinitions(): ToolDef[];
  callStartVariables(): Record<string, string>;
  warm?(): void;
}

const on = (v: unknown) => /^(1|on|true|yes)$/i.test(String(v || '').trim());

export class VoiceHarness {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private nonces = new NonceCache();
  private clips = new ClipStore();
  private sessions = new Map<string, CallSession>();
  status: GwStatus | null = null;
  statusAt = 0;

  constructor(
    private readonly deps: HarnessDeps,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly factories: {
      provider?: (agent: AgentConfig) => VoiceProvider | null;
      tts?: (agent: AgentConfig) => TtsRenderer | null;
      transcriber?: () => TranscriberFactory | undefined;
    } = {}
  ) {}

  get secret(): string {
    return String(this.env.VOICE_GW_SECRET || '');
  }

  activeCalls(): number {
    return this.sessions.size;
  }

  start(port = Number(this.env.VOICE_HARNESS_PORT || 3010), host = this.env.VOICE_HARNESS_HOST || '0.0.0.0'): Promise<number> {
    if (this.secret.length < 32) {
      console.warn('[Voice] VOICE_GW_SECRET missing or shorter than 32 characters: the voice harness is not listening (fail closed).');
      return Promise.resolve(0);
    }
    this.server = http.createServer((_req, res) => {
      res.writeHead(404).end();
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
    this.server.on('upgrade', (req, socket, head) => {
      const ip = String(req.socket.remoteAddress || '');
      if ((req.url || '').split('?')[0] !== '/voice-gw') {
        socket.destroy();
        return;
      }
      const check = verifyAuth(req.headers[AUTH_HEADER], this.secret, this.nonces);
      if (!check.ok) {
        throttledSecurityEvent('voice_gw_rejected', { ip, code: check.reason.toUpperCase(), object: '/voice-gw', channel: 'voice' });
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => (check.kind === 'control' ? this.onControl(ws) : this.onCall(ws)));
    });
    void this.prepareClips(activeAgent(this.env));
    return new Promise((resolve) => {
      this.server!.listen(port, host, () => {
        const a = this.server!.address();
        const p = typeof a === 'object' && a ? a.port : port;
        console.log(`[Voice] harness listening on ${host}:${p} (gateway link; internal network only)`);
        resolve(p);
      });
    });
  }

  close(): void {
    for (const s of this.sessions.values()) s.finish('shutdown');
    this.wss?.close();
    this.server?.close();
  }

  // ── Control link: registration status ────────────────────────────────────────────────────────────────────

  private onControl(ws: WebSocket): void {
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      let m: any;
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (m?.type === 'status') this.onStatus(m as GwStatus);
      else if (m?.type === 'security' && m.event === 'srtp_refused') {
        securityEvent('srtp_refused', { code: String(m.proto || 'RTP_AVP').replace(/[^A-Za-z0-9_]/g, '_'), object: 'voice-gw', channel: 'voice' });
      }
    });
  }

  onStatus(s: GwStatus): void {
    const prev = this.status;
    this.status = s;
    this.statusAt = Date.now();
    if (prev?.registered && !s.registered) securityEvent('sip_registration_lost', { code: (s.last_error || 'UNKNOWN').toUpperCase(), object: 'voice-gw', channel: 'voice' });
    if ((!prev || !prev.registered) && s.registered) securityEvent('sip_registered', { code: (s.tls_version || '').replace(/[^A-Za-z0-9]/g, '_'), object: 'voice-gw', channel: 'voice' });
    if (s.last_error && s.last_error.startsWith('tls_') && prev?.last_error !== s.last_error) {
      securityEvent('sip_tls_failure', { code: s.last_error.toUpperCase(), object: 'voice-gw', channel: 'voice' });
    }
  }

  // ── Clips ────────────────────────────────────────────────────────────────────────────────────────────────

  private providerRate(agent: AgentConfig): number {
    return agent.provider === 'elevenlabs' ? 16000 : 24000;
  }

  texts(): Record<string, string> {
    const t: Record<string, string> = { ...scriptTexts(this.env.CLINIC_NAME || '') };
    for (const spec of Object.values(AGENT_TOOLS)) if (spec.filler) t[`FILLER:${spec.filler}`] = spec.filler;
    return t;
  }

  private tts(agent: AgentConfig): TtsRenderer | null {
    if (this.factories.tts) return this.factories.tts(agent);
    if (agent.provider === 'openai' && this.env.OPENAI_API_KEY) return openAiTts(String(this.env.OPENAI_API_KEY));
    if (agent.provider === 'elevenlabs' && this.env.ELEVENLABS_API_KEY) return elevenLabsTts(String(this.env.ELEVENLABS_API_KEY));
    return null;
  }

  /** Render (or load) every clip for the agent's voice. Returns the required scripts that are still missing. */
  async prepareClips(agent: AgentConfig): Promise<string[]> {
    const tts = this.tts(agent);
    if (!tts) return [...REQUIRED_SCRIPTS];
    const missing = await this.clips.ensure(agent.provider, agent.voice, this.providerRate(agent), this.texts(), tts);
    return missing.filter((m) => (REQUIRED_SCRIPTS as string[]).includes(m));
  }

  clipStore(): ClipStore {
    return this.clips;
  }

  // ── Calls ────────────────────────────────────────────────────────────────────────────────────────────────

  private provider(agent: AgentConfig): VoiceProvider | null {
    if (this.factories.provider) return this.factories.provider(agent);
    if (agent.provider === 'openai') return this.env.OPENAI_API_KEY ? new OpenAiRealtime(String(this.env.OPENAI_API_KEY)) : null;
    if (agent.provider === 'elevenlabs') return this.env.ELEVENLABS_API_KEY ? new ElevenLabsConvai(String(this.env.ELEVENLABS_API_KEY)) : null;
    return null;
  }

  private onCall(ws: WebSocket): void {
    let session: CallSession | null = null;
    const startTimer = setTimeout(() => ws.close(1008, 'no call_start'), 5000);
    const send = (cmd: GwCommand) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(cmd));
    ws.on('message', async (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        const f = decodeFrame(data as Buffer);
        if (f && session) session.onGwAudio(f.leg, f.pcm);
        return;
      }
      let m: any;
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!session) {
        if (m?.type !== 'call_start') return;
        clearTimeout(startTimer);
        session = await this.admit(m as CallStart, send, ws);
        return;
      }
      session.onGwEvent(m as GwEvent);
    });
    ws.on('close', () => {
      clearTimeout(startTimer);
      if (session) {
        session.finish('gateway_closed');
        this.sessions.delete(session.callId);
      }
    });
    ws.on('error', () => undefined);
  }

  private reject(send: (c: GwCommand) => void, code: 480 | 503, reason: string): null {
    console.warn(`[Voice] call refused: ${reason}`);
    auditToolCall({ server: 'unity', kind: 'tool', tool: 'voice_call_refused', success: false, errorCode: reason.toUpperCase().slice(0, 40), latencyMs: 0, channel: 'voice' });
    send({ type: 'reject', code, reason });
    return null;
  }

  async admit(start: CallStart, send: (c: GwCommand) => void, ws?: WebSocket): Promise<CallSession | null> {
    const t0 = Date.now();
    if (!on(this.env.VOICE_ENABLED)) return this.reject(send, 480, 'voice_disabled');
    if (this.sessions.size >= Math.max(1, Number(this.env.VOICE_MAX_SESSIONS || 4))) return this.reject(send, 480, 'max_sessions');
    if (!start.srtp && this.env.VOICE_ALLOW_PLAIN_RTP !== 'synthetic-only') {
      securityEvent('srtp_refused', { code: 'NO_SRTP_OFFER', object: 'voice-harness', channel: 'voice' });
      return this.reject(send, 503, 'no_srtp');
    }
    const agent = activeAgent(this.env);
    if (agent.provider === 'elevenlabs' && this.env.VOICE_ALLOW_NON_BAA_PROVIDER !== 'synthetic-only') return this.reject(send, 503, 'provider_without_baa');
    const provider = this.provider(agent);
    if (!provider) return this.reject(send, 503, 'provider_not_configured');
    const missing = await this.prepareClips(agent);
    if (missing.length) return this.reject(send, 503, 'clips_missing');
    const realm = String(this.env.SIP_REALM || this.env.SIP_SERVER || '').trim().toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(realm)) return this.reject(send, 503, 'no_realm');

    const callId = `voice_${randomUUID()}`;
    const afterHours = currentMode() === 'after_hours';
    const base = this.deps.callStartVariables();
    const vars: Record<string, string> = {
      ...base,
      // The harness offers the Unity tools only; the FHIR backups live in the FHIR process.
      fhir_tools: 'OFF',
      call_type: 'phone_call',
      'current_time_America/Boise': nowInClinicTz(),
      current_time: nowInClinicTz(),
    };
    let instructions: string;
    try {
      instructions = renderPrompt(promptTemplate(agent, this.env), vars);
    } catch {
      return this.reject(send, 503, 'prompt_unavailable');
    }
    let tools;
    try {
      tools = agentToolSpecs(agent, this.deps.toolDefinitions());
    } catch {
      // A listed tool or parameter is missing from the code's own schemas: never offer the model a guess.
      return this.reject(send, 503, 'tool_schema_drift');
    }
    const rate = provider.pcmRate;
    const transcript = new CallTranscript({
      call_id: callId,
      agent_id: agent.id,
      provider: agent.provider,
      model: agent.model,
      voice: agent.voice,
      caller_last4: String(start.from || '').replace(/\D/g, '').slice(-4),
      mode: afterHours ? 'after_hours' : 'business_hours',
      media: { transport: 'tls', codec: '', srtp: !!start.srtp },
    });
    const link = {
      send,
      sendAudio: (leg: number, pcm: Buffer) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          const b = Buffer.allocUnsafe(pcm.length + 1);
          b[0] = leg & 0xff;
          pcm.copy(b, 1);
          ws.send(b);
        }
      },
    };
    const session = new CallSession({
      callId,
      start,
      agent,
      provider,
      link,
      deps: this.deps,
      transcript,
      scripts: this.texts(),
      clip: (text) => this.clips.get(agent.provider, agent.voice, rate, text),
      allowedTools: allowedToolNames(agent, tools),
      realm,
      afterHours,
      transcriber: this.factories.transcriber ? this.factories.transcriber() : this.env.OPENAI_API_KEY ? openAiTranscriber(String(this.env.OPENAI_API_KEY)) : undefined,
    });
    try {
      await Promise.race([
        provider.connect(
          { model: agent.model, voice: agent.voice, instructions, tools, language: agent.language, turn: agent.turn, agentId: agent.elevenlabs_agent_id, vars },
          session.events()
        ),
        new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
      ]);
    } catch (e: any) {
      provider.close();
      transcript.finish('provider_connect_failed', {});
      return this.reject(send, 503, 'provider_connect_failed');
    }
    this.deps.warm?.();
    this.sessions.set(callId, session);
    send({ type: 'accept', call_id: callId, pcm_rate: rate });
    auditToolCall({ server: 'unity', kind: 'tool', tool: 'voice_call_start', callId, success: true, latencyMs: Date.now() - t0, channel: 'voice', object: start.srtp ? 'srtp' : 'rtp' });
    console.log(`[Voice] ${callId} accepted (${agent.provider}/${agent.model}, ${Date.now() - t0} ms, caller ...${transcript.rec.caller_last4})`);
    return session;
  }
}

let harness: VoiceHarness | null = null;

/** Called by the Unity server after its tool runner exists. No-op unless VOICE_ENABLED=on. */
export function startVoiceHarness(deps: HarnessDeps): VoiceHarness | null {
  if (!on(process.env.VOICE_ENABLED)) return null;
  harness = new VoiceHarness(deps);
  void harness.start();
  return harness;
}

export function getVoiceHarness(): VoiceHarness | null {
  return harness;
}
