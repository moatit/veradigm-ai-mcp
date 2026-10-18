import { auditToolCall } from '../../audit';
import { callBindings } from '../../call-binding';
import { AgentConfig, HandoffAction } from './config';
import { emergencyDetected } from './guard';
import { ALL_CONFERENCE_LEGS, CallStart, GwCommand, GwEvent } from './protocol';
import { Clip, MODEL_SCRIPTS, ScriptId } from './scripts';
import { CallTranscript } from './transcript';
import { fillerFor, WARM_TOOLS } from './tools';
import { ProviderEvents, VoiceProvider } from './providers/types';
import { Transcriber, TranscriberFactory } from './providers/transcriber';

/**
 * One phone call through the voice harness, in the Drawbridge server process.
 *
 *  - The call ID is minted here (voice_<uuid>); the model and the gateway never choose it. Every Unity tool runs
 *    through executeAgentTool under that ID (deps.runAgentTool): staff-only refusal, call binding (identity before
 *    information), minimum necessary, idempotent writes, audit with channel "voice". Tools not enabled on this
 *    agent are refused and audited before anything runs.
 *  - Scripted lines are pre-rendered clips played byte for byte; safety clips are not interruptible. An emergency
 *    phrase in the caller's words plays EMERGENCY_911 even if the model did not ask for it.
 *  - Audio routing by leg: the model hears only the human legs it is meant to hear (never its own output; the
 *    gateway also gates line echo), and its audio goes to one leg or to the conference.
 *  - Warm transfer: hold the caller, dial an allow-listed extension, the model briefs staff, then a local
 *    conference (or attended REFER), with ring and hold timeouts.
 *  - Transcript with speaker labels by leg; per-turn latency; handoffs; call quality.
 */
export interface GwLink {
  send(cmd: GwCommand): void;
  sendAudio(leg: number, pcm: Buffer): void;
}

export interface SessionDeps {
  runAgentTool(name: string, args: any, callId: string, callerPhone: string | undefined): Promise<any>;
  toVoiceSummary(name: string, result: any): string;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(h: unknown): void;
}
const realTimers: Timers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface SessionOptions {
  callId: string;
  start: CallStart;
  agent: AgentConfig;
  provider: VoiceProvider;
  link: GwLink;
  deps: SessionDeps;
  transcript: CallTranscript;
  scripts: Record<string, string>;
  clip: (text: string) => Clip | undefined;
  allowedTools: Set<string>;
  realm: string;
  afterHours: boolean;
  transcriber?: TranscriberFactory;
  timers?: Timers;
  log?: (line: string) => void;
}

type WarmPhase = 'holding' | 'ringing' | 'consult' | 'joining' | 'joined';
interface WarmState {
  phase: WarmPhase;
  ext: string;
  reason: string;
  name: string;
  verified: boolean;
  leg: number;
  requestId: string;
  holdTimer: unknown;
  toolCallId: string;
}

const STRIP_ARGS = ['call_id', 'callId', 'call', 'x-call-id'];

export class CallSession {
  readonly callId: string;
  private o: SessionOptions;
  private t: Timers;
  private rate: number;
  private segN = 0;
  /** response id -> gateway segment */
  private respSeg = new Map<string, string>();
  private respLeg = new Map<string, number>();
  private respText = new Map<string, string>();
  private suppressed = new Set<string>();
  private currentResp: string | null = null;
  /** segment -> callback when fully played */
  private onSegDone = new Map<string, () => void>();
  private segResp = new Map<string, string>();
  /** non-interruptible clips currently queued or playing */
  private protectedSegs = new Set<string>();
  private playing = new Set<number>();
  private modelIn = new Set<number>([0]);
  private agentOut = 0;
  private agentPresent = true;
  private agentMuted = false;
  private mixBuf = new Map<number, Buffer>();
  private legsUp = new Set<number>();
  private transcribers = new Map<number, Transcriber>();
  private lastEmergencyAt = 0;
  private turnTools: Array<{ name: string; ms: number; ok: boolean }> = [];
  private turnScript = false;
  private speechStoppedAt = 0;
  private providerMs: number | undefined;
  /** This caller turn: when the provider heard the caller stop, its metric once audio started, an answer pending. */
  private turnStartAt = 0;
  private lastTurn: import('./transcript').TurnMetric | null = null;
  private awaitingAnswer = false;
  private warm: WarmState | null = null;
  private ended = false;
  private endReason = '';
  private quality: Record<string, unknown> = {};
  private reqN = 0;
  private transferReq = new Map<string, { action: HandoffAction; toolCallId: string }>();

  constructor(o: SessionOptions) {
    this.o = o;
    this.callId = o.callId;
    this.t = o.timers || realTimers;
    this.rate = o.provider.pcmRate;
  }

  private log(line: string): void {
    (this.o.log || ((l: string) => console.log(l)))(`[Voice] ${this.callId} ${line}`);
  }

  private audit(action: string, success: boolean, errorCode?: string, object?: string, latencyMs = 0): void {
    auditToolCall({ server: 'unity', kind: 'tool', tool: `voice_${action}`, callId: this.callId, success, errorCode, latencyMs, channel: 'voice', object });
  }

  /** Provider event sink. */
  events(): ProviderEvents {
    return {
      audio: (pcm, id) => this.onModelAudio(pcm, id),
      agentTranscript: (text, final, id) => {
        if (final) this.respText.set(id, text);
      },
      callerTranscript: (text) => this.onCallerText(text),
      speechStarted: () => this.onBargeIn(),
      speechStopped: () => {
        // A new caller turn: what follows (tools, clips, the reply) belongs to it.
        this.speechStoppedAt = Date.now();
        this.turnStartAt = this.speechStoppedAt;
        this.providerMs = undefined;
        this.turnTools = [];
        this.turnScript = false;
        this.lastTurn = null;
        this.awaitingAnswer = false;
      },
      toolCall: (c) => void this.onToolCall(c.id, c.name, c.args),
      responseStarted: (id) => {
        this.currentResp = id;
      },
      responseDone: (id) => this.onResponseDone(id),
      error: (code, fatal) => {
        this.log(`provider error ${code}${fatal ? ' (fatal)' : ''}`);
        if (fatal) this.failHard('provider_error');
      },
      closed: (code) => {
        if (!this.ended && this.agentPresent) {
          this.log(`provider closed ${code}`);
          this.failHard('provider_closed');
        }
      },
    };
  }

  // ── Gateway events ─────────────────────────────────────────────────────────────────────────────────────────

  onGwEvent(ev: GwEvent): void {
    switch (ev.type) {
      case 'answered':
        this.legsUp.add(0);
        this.o.transcript.setMedia(ev.codec || '', !!ev.srtp);
        this.audit('call_answered', true, undefined, ev.srtp ? 'srtp' : 'rtp');
        this.playScript(0, this.o.afterHours ? 'GREETING_AFTER_HOURS' : 'GREETING', { tellModel: true });
        break;
      case 'media_warning':
        this.o.transcript.event(`media warning: ${ev.reason || ''}`, ev.leg);
        break;
      case 'media_update':
        if (ev.leg === 0) this.o.transcript.markFarEnd();
        break;
      case 'playout_started':
        this.playing.add(ev.leg);
        if (ev.leg === this.agentOut || this.agentOut === ALL_CONFERENCE_LEGS) this.closeTurn(ev.latency_ms);
        break;
      case 'playout_idle':
        this.playing.delete(ev.leg);
        break;
      case 'segment_done':
        this.segmentFinished(ev.segment || '', ev.played_ms || 0, false);
        break;
      case 'cleared':
        if (ev.segment) this.segmentFinished(ev.segment, ev.played_ms || 0, true);
        break;
      case 'dtmf':
        this.onDtmf(ev.leg, ev.digit || '');
        break;
      case 'transfer_result':
      case 'transfer_progress':
        this.onTransferEvent(ev);
        break;
      case 'leg_ringing':
        if (this.warm && ev.request_id === this.warm.requestId) this.o.transcript.event(`ringing extension ${this.warm.ext}`, ev.leg);
        break;
      case 'leg_answered':
        this.legsUp.add(ev.leg);
        this.onStaffAnswered(ev);
        break;
      case 'leg_failed':
        this.onStaffFailed(ev);
        break;
      case 'leg_hangup':
        this.onLegHangup(ev.leg);
        break;
      case 'leg_quality':
        this.quality[`leg${ev.leg}`] = ev.quality;
        break;
      case 'hold_result':
      case 'resume_result':
        this.audit(ev.type === 'hold_result' ? 'hold' : 'resume', ev.code === 200, ev.code === 200 ? undefined : `SIP_${ev.code || 0}`, `leg:${ev.leg}`);
        break;
      case 'hangup':
        this.finish(ev.by === 'agent' ? 'agent_hangup' : 'caller_hangup');
        break;
    }
  }

  /** Human audio from one leg (PCM at the session rate). */
  onGwAudio(leg: number, pcm: Buffer): void {
    if (this.ended) return;
    const tr = this.transcribers.get(leg);
    if (tr) tr.send(pcm);
    if (!this.agentPresent || !this.modelIn.has(leg)) return;
    if (this.modelIn.size === 1) {
      this.o.provider.sendAudio(pcm);
      return;
    }
    // Several human legs feed the model (agent stayed in a conference): mix them on the lowest leg's clock.
    this.mixBuf.set(leg, Buffer.concat([this.mixBuf.get(leg) || Buffer.alloc(0), pcm]).subarray(-this.rate)); // cap 0.5 s
    const clock = Math.min(...this.modelIn);
    if (leg !== clock) return;
    const base = this.mixBuf.get(clock)!;
    this.mixBuf.set(clock, Buffer.alloc(0));
    const out = Buffer.from(base);
    for (const other of this.modelIn) {
      if (other === clock) continue;
      const b = this.mixBuf.get(other) || Buffer.alloc(0);
      const n = Math.min(out.length, b.length) & ~1;
      for (let i = 0; i < n; i += 2) out.writeInt16LE(Math.max(-32768, Math.min(32767, out.readInt16LE(i) + b.readInt16LE(i))), i);
      this.mixBuf.set(other, b.subarray(n));
    }
    this.o.provider.sendAudio(out);
  }

  // ── Model audio and turns ──────────────────────────────────────────────────────────────────────────────────

  private nextSeg(prefix: string): string {
    return `${prefix}${++this.segN}`;
  }

  private onModelAudio(pcm: Buffer, id: string): void {
    if (this.ended || this.suppressed.has(id) || !this.agentPresent || this.agentMuted) return;
    let seg = this.respSeg.get(id);
    if (!seg) {
      seg = this.nextSeg('r');
      this.respSeg.set(id, seg);
      this.segResp.set(seg, id);
      this.respLeg.set(id, this.agentOut);
      this.o.link.send({ type: 'segment', leg: this.agentOut, segment: seg });
      if (this.speechStoppedAt && this.providerMs === undefined) this.providerMs = Date.now() - this.speechStoppedAt;
      if (this.awaitingAnswer && this.turnStartAt) {
        // The answer after a tool result started: the number a caller feels on a lookup.
        this.awaitingAnswer = false;
        const answer = Date.now() - this.turnStartAt;
        if (this.lastTurn) {
          this.lastTurn.answer_ms = answer;
          this.lastTurn.kind = 'tool';
          this.o.transcript.turnChanged();
        }
        this.log(`answer after tool answer_ms=${answer} tools=${(this.lastTurn?.tools || this.turnTools).map((t) => `${t.name}:${t.ms}`).join(',')}`);
      }
    }
    this.o.link.sendAudio(this.respLeg.get(id)!, pcm);
  }

  private onResponseDone(id: string): void {
    if (this.currentResp === id) this.currentResp = null;
    const seg = this.respSeg.get(id);
    if (seg) this.o.link.send({ type: 'segment_end', leg: this.respLeg.get(id)!, segment: seg });
    else {
      const text = this.respText.get(id);
      if (text && !this.suppressed.has(id)) this.o.transcript.agentSpeech(this.agentOut === ALL_CONFERENCE_LEGS ? 0 : this.agentOut, text);
      this.respText.delete(id);
    }
  }

  private segmentFinished(seg: string, playedMs: number, cut: boolean): void {
    const resp = this.segResp.get(seg);
    if (resp) {
      const text = this.respText.get(resp) || '';
      const leg = this.respLeg.get(resp) ?? 0;
      if (cut) {
        this.o.provider.truncate(resp, playedMs);
        this.suppressed.add(resp);
      }
      if (text) this.o.transcript.agentSpeech(leg === ALL_CONFERENCE_LEGS ? 0 : leg, text, cut);
      this.respText.delete(resp);
      this.segResp.delete(seg);
    }
    this.protectedSegs.delete(seg);
    const cb = this.onSegDone.get(seg);
    if (cb) {
      this.onSegDone.delete(seg);
      cb();
    }
  }

  private closeTurn(e2eMs?: number): void {
    if (e2eMs === undefined && !this.turnTools.length && this.providerMs === undefined) return;
    const kind: 'plain' | 'tool' | 'script' = this.turnTools.length ? 'tool' : this.turnScript ? 'script' : 'plain';
    this.lastTurn = this.o.transcript.turn({ e2e_ms: e2eMs, provider_ms: this.providerMs, tools: this.turnTools, kind });
    this.log(`turn kind=${kind} e2e_ms=${e2eMs ?? '-'} provider_ms=${this.providerMs ?? '-'} tools=${this.turnTools.map((t) => `${t.name}:${t.ms}`).join(',') || '-'}`);
    this.turnTools = [];
    this.turnScript = false;
    this.speechStoppedAt = 0;
    this.providerMs = undefined;
  }

  /** The caller started talking: stop the agent unless a protected clip is playing. */
  private onBargeIn(): void {
    if (this.ended || !this.agentPresent) return;
    const leg = this.agentOut;
    if ([...this.protectedSegs].length) return; // safety lines play to the end
    if (this.currentResp) this.suppressed.add(this.currentResp);
    if (this.playing.has(leg) || leg === ALL_CONFERENCE_LEGS) this.o.link.send({ type: 'clear', leg });
  }

  // ── Scripts ────────────────────────────────────────────────────────────────────────────────────────────────

  /** Play a scripted clip on a leg. Safety and orchestrator lines are protected from barge-in. */
  playScript(leg: number, id: ScriptId | string, opts: { tellModel?: boolean; protect?: boolean; onDone?: () => void } = {}): boolean {
    const text = this.o.scripts[id];
    const clip = text ? this.o.clip(text) : undefined;
    if (!text || !clip) {
      this.log(`clip ${id} unavailable`);
      this.audit('say_script', false, 'CLIP_UNAVAILABLE', String(id));
      opts.onDone?.();
      return false;
    }
    const seg = this.nextSeg('s');
    this.o.link.send({ type: 'segment', leg, segment: seg });
    const chunk = Math.floor(this.rate / 5) * 2; // 200 ms
    for (let i = 0; i < clip.pcm.length; i += chunk) this.o.link.sendAudio(leg, clip.pcm.subarray(i, i + chunk));
    this.o.link.send({ type: 'segment_end', leg, segment: seg });
    if (opts.protect !== false) this.protectedSegs.add(seg);
    if (opts.onDone) this.onSegDone.set(seg, opts.onDone);
    this.turnScript = true;
    if (!id.startsWith('FILLER')) {
      this.o.transcript.script(leg === ALL_CONFERENCE_LEGS ? 0 : leg, id, text);
      this.audit('say_script', true, undefined, String(id));
    }
    if (opts.tellModel) this.o.provider.addAssistantText(text);
    return true;
  }

  private onCallerText(text: string): void {
    // The model's input transcription is one leg's words only while exactly one leg feeds the model and that leg
    // has no transcriber of its own (a conference uses per-leg transcribers instead).
    if (this.modelIn.size !== 1) return;
    const leg = [...this.modelIn][0];
    if (this.transcribers.has(leg)) return;
    this.o.transcript.humanSpeech(leg, text);
    if (leg === 0 && emergencyDetected(text) && Date.now() - this.lastEmergencyAt > 60_000) this.emergencyBackstop();
  }

  private emergencyBackstop(): void {
    this.lastEmergencyAt = Date.now();
    this.log('emergency backstop');
    this.audit('emergency_backstop', true, undefined, 'EMERGENCY_911');
    this.o.provider.cancelResponse();
    if (this.currentResp) this.suppressed.add(this.currentResp);
    this.o.link.send({ type: 'clear', leg: 0 });
    this.playScript(0, 'EMERGENCY_911', {
      tellModel: true,
      onDone: () => this.o.provider.addSystemNote('ORCHESTRATOR: The emergency line was just played to the caller. Offer to transfer them to staff now; do not continue routine tasks.', true),
    });
  }

  // ── Tools ──────────────────────────────────────────────────────────────────────────────────────────────────

  private async onToolCall(id: string, name: string, rawArgs: any): Promise<void> {
    if (this.ended) return;
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? { ...rawArgs } : {};
    for (const k of STRIP_ARGS) delete args[k]; // never a caller- or model-chosen call ID
    if (!this.o.allowedTools.has(name)) {
      auditToolCall({ server: 'unity', tool: name, args, callId: this.callId, success: false, errorCode: 'TOOL_NOT_ENABLED', latencyMs: 0, channel: 'voice' });
      this.o.transcript.tool(name, false, 'TOOL_NOT_ENABLED');
      this.o.provider.sendToolResult(id, `TOOL_ERROR (TOOL_NOT_ENABLED, retryable=no). ${name} is not available on this line. Offer a transfer or a message instead.`, true);
      return;
    }
    switch (name) {
      case 'say_script':
        return this.toolSayScript(id, args);
      case 'end_call':
        return this.toolEndCall(id);
      case 'transfer_to_staff':
        return this.toolTransfer(id, args);
      case 'warm_transfer':
        return this.toolWarmTransfer(id, args);
      case 'connect_caller':
      case 'staff_declined':
        return this.toolWarmDecision(id, name);
    }
    // A Unity tool: play its filler if nothing is playing, run it in-process through the same gate as Retell.
    const filler = fillerFor(name);
    if (filler && !this.playing.has(this.agentOut) && this.o.scripts[`FILLER:${filler}`]) this.playScript(this.agentOut, `FILLER:${filler}`, { protect: false });
    const t0 = Date.now();
    let text: string;
    let ok = true;
    try {
      const result = await this.o.deps.runAgentTool(name, args, this.callId, this.o.start.from || undefined);
      ok = !(result && result.success === false);
      text = this.o.deps.toVoiceSummary(name, result);
      this.o.transcript.tool(name, ok, ok ? undefined : String(result?.error_code || ''));
    } catch {
      ok = false;
      text = 'TOOL_ERROR (INTERNAL, retryable=no). The lookup failed. Say "I\'m having trouble pulling that up right now." and offer a transfer or a message.';
      this.o.transcript.tool(name, false, 'INTERNAL');
    }
    const ms = Date.now() - t0;
    if (this.lastTurn) {
      this.lastTurn.tools.push({ name, ms, ok });
      this.o.transcript.turnChanged();
    } else this.turnTools.push({ name, ms, ok });
    this.awaitingAnswer = true;
    if (!this.ended) this.o.provider.sendToolResult(id, text, true);
  }

  private toolSayScript(id: string, args: any): void {
    const sid = String(args.id || '');
    if (!(MODEL_SCRIPTS as readonly string[]).includes(sid)) {
      this.o.provider.sendToolResult(id, `TOOL_ERROR (UNKNOWN_SCRIPT). Use one of: ${MODEL_SCRIPTS.join(', ')}.`, true);
      return;
    }
    const leg = this.agentOut;
    if (sid === 'EMERGENCY_911') {
      this.lastEmergencyAt = Date.now();
      if (this.currentResp) this.suppressed.add(this.currentResp);
      this.o.link.send({ type: 'clear', leg });
    }
    const text = this.o.scripts[sid];
    const played = this.playScript(leg, sid, {
      onDone: () => this.o.provider.sendToolResult(id, `PLAYED to the caller, exactly: "${text}". Do not repeat it.`, sid !== 'GOODBYE'),
    });
    if (!played) this.o.provider.sendToolResult(id, `CLIP_UNAVAILABLE: say exactly "${text}"`, true);
  }

  private toolEndCall(id: string): void {
    this.o.provider.sendToolResult(id, 'Ending the call now.', false);
    this.audit('hangup', true, undefined, 'end_call');
    this.playScript(this.agentOut === ALL_CONFERENCE_LEGS ? 0 : this.agentOut, 'GOODBYE', { onDone: () => this.o.link.send({ type: 'hangup', leg: -1 }) });
  }

  private reqId(): string {
    return `q${++this.reqN}`;
  }

  private toolTransfer(id: string, args: any): void {
    const action = this.o.agent.handoffs.find((h) => h.id === String(args.destination || ''));
    if (!action) {
      this.audit('transfer', false, 'NOT_ALLOWED', 'unknown');
      this.o.provider.sendToolResult(id, 'TOOL_ERROR (NOT_ALLOWED). That destination is not available on this line. Offer to take a message.', true);
      return;
    }
    const line: ScriptId = action.kind === 'voicemail' ? 'TRANSFER_VOICEMAIL' : action.kind === 'transfer' ? 'TRANSFER' : 'PARK';
    this.o.provider.sendToolResult(id, `TRANSFER STARTED (${action.label}). The transfer line is playing; say nothing until you are told the result.`, false);
    this.o.transcript.handoff(action.kind, action.target, 'started');
    const req = this.reqId();
    this.transferReq.set(req, { action, toolCallId: id });
    this.playScript(0, line, {
      tellModel: true,
      onDone: () => {
        this.audit('transfer', true, undefined, `${action.kind}:${action.target}`);
        this.o.link.send({ type: 'transfer', leg: 0, target: `sip:${action.target}@${this.o.realm}`, request_id: req });
      },
    });
  }

  private onTransferEvent(ev: GwEvent): void {
    const req = ev.request_id ? this.transferReq.get(ev.request_id) : undefined;
    if (!req) {
      if (this.warm?.phase === 'joining' && ev.type === 'transfer_result' && ev.code !== 202) this.warmFallbackToConference();
      return;
    }
    const failed = (ev.type === 'transfer_result' && ev.code !== 202) || (ev.type === 'transfer_progress' && (ev.code || 0) >= 300);
    if (ev.type === 'transfer_progress' && ev.code && ev.code >= 200 && ev.code < 300) {
      this.o.transcript.handoff(req.action.kind, req.action.target, 'connected');
      this.transferReq.delete(ev.request_id!);
      return;
    }
    if (!failed) return;
    this.transferReq.delete(ev.request_id!);
    this.audit('transfer', false, `SIP_${ev.code || 0}`, `${req.action.kind}:${req.action.target}`);
    this.o.transcript.handoff(req.action.kind, req.action.target, `failed ${ev.code || ev.reason || ''}`);
    this.playScript(0, 'TRANSFER_FAILED', {
      tellModel: true,
      onDone: () => this.o.provider.addSystemNote('ORCHESTRATOR: The transfer did not go through and the caller is still with you. Offer to take a message (drawbridge_take_message) or a staff task.', true),
    });
  }

  // ── Warm transfer ──────────────────────────────────────────────────────────────────────────────────────────

  private toolWarmTransfer(id: string, args: any): void {
    const ext = String(args.extension || '');
    if (!this.o.agent.warm_transfer.enabled || !this.o.agent.dial_allow.includes(ext) || !/^\d{2,8}$/.test(ext)) {
      this.audit('dial', false, 'NOT_ALLOWED', 'ext:refused');
      this.o.provider.sendToolResult(id, 'TOOL_ERROR (NOT_ALLOWED). That extension cannot be dialled from this line. Offer transfer_to_staff or a message.', true);
      return;
    }
    if (this.warm) {
      this.o.provider.sendToolResult(id, 'TOOL_ERROR (BUSY). A warm transfer is already in progress.', false);
      return;
    }
    const verified = callBindings.verified(this.callId).length > 0;
    this.warm = {
      phase: 'holding',
      ext,
      reason: String(args.reason || '').slice(0, 200),
      name: verified ? String(args.caller_name || '').slice(0, 80) : '',
      verified,
      leg: -1,
      requestId: this.reqId(),
      holdTimer: null,
      toolCallId: id,
    };
    this.o.provider.sendToolResult(id, 'WARM TRANSFER STARTED. The caller hears the hold line and is then on hold; say nothing until the next ORCHESTRATOR note.', false);
    this.o.transcript.handoff('warm_transfer', ext, 'started');
    this.playScript(0, 'HOLD', {
      tellModel: true,
      onDone: () => {
        if (!this.warm || this.ended) return;
        this.modelIn = new Set();
        this.o.link.send({ type: 'hold', leg: 0, request_id: this.warm.requestId });
        this.warm.phase = 'ringing';
        this.warm.holdTimer = this.t.set(() => this.warmGiveUp('hold_timeout'), this.o.agent.warm_transfer.hold_timeout_s * 1000);
        this.audit('dial', true, undefined, `ext:${ext}`);
        this.o.link.send({ type: 'dial', target: `sip:${ext}@${this.o.realm}`, timeout_s: this.o.agent.warm_transfer.ring_timeout_s, request_id: this.warm.requestId });
      },
    });
  }

  private onStaffAnswered(ev: GwEvent): void {
    const w = this.warm;
    if (!w || ev.request_id !== w.requestId) return;
    w.leg = ev.leg;
    w.phase = 'consult';
    this.o.transcript.setStaffLeg(ev.leg, w.ext);
    this.o.transcript.event(`staff extension ${w.ext} answered`, ev.leg);
    this.startTranscriber(ev.leg);
    this.modelIn = new Set([ev.leg]);
    this.agentOut = ev.leg;
    const who = w.verified ? `a caller verified on this call${w.name ? ` as ${w.name}` : ''}` : 'a caller who is NOT verified';
    this.o.provider.addSystemNote(
      `ORCHESTRATOR: You are now speaking privately with the staff member at extension ${w.ext}; the caller is on hold and cannot hear you. ` +
        `Briefly say you have ${who}, calling about: ${w.reason || 'a question'}. Share nothing else from the record. Ask if they can take the call ` +
        '(they may also press 1 to accept or 2 to decline). If they accept, call connect_caller; if they cannot, call staff_declined.',
      true
    );
  }

  private onStaffFailed(ev: GwEvent): void {
    const w = this.warm;
    if (!w || ev.request_id !== w.requestId) return;
    this.audit('dial', false, ev.code ? `SIP_${ev.code}` : String(ev.reason || 'FAILED').toUpperCase().slice(0, 40), `ext:${w.ext}`);
    this.warmGiveUp(ev.reason || 'no_answer');
  }

  private onDtmf(leg: number, digit: string): void {
    if (this.warm?.phase === 'consult' && leg === this.warm.leg) {
      if (digit === '1') this.warmConnect();
      else if (digit === '2') this.warmGiveUp('declined');
      return;
    }
    this.o.transcript.event(`keypad ${digit}`, leg);
  }

  private toolWarmDecision(id: string, name: string): void {
    if (!this.warm || this.warm.phase !== 'consult') {
      this.o.provider.sendToolResult(id, 'TOOL_ERROR (NO_WARM_TRANSFER). There is no staff member waiting.', false);
      return;
    }
    this.o.provider.sendToolResult(id, name === 'connect_caller' ? 'Connecting the caller now. Say nothing more.' : 'Understood.', false);
    if (name === 'connect_caller') this.warmConnect();
    else this.warmGiveUp('declined');
  }

  private warmConnect(): void {
    const w = this.warm;
    if (!w || w.phase !== 'consult') return;
    w.phase = 'joining';
    this.t.clear(w.holdTimer);
    if (this.currentResp) this.suppressed.add(this.currentResp);
    this.o.link.send({ type: 'clear', leg: w.leg });
    if (this.o.agent.warm_transfer.mode === 'attended_refer') {
      this.audit('transfer', true, undefined, `attended:${w.ext}`);
      this.o.link.send({ type: 'transfer', leg: 0, replaces_leg: w.leg });
      return;
    }
    this.joinConference();
  }

  private warmFallbackToConference(): void {
    if (this.warm?.phase !== 'joining') return;
    this.o.transcript.event('attended transfer refused by the PBX; local conference instead');
    this.joinConference();
  }

  private joinConference(): void {
    const w = this.warm!;
    w.phase = 'joined';
    this.o.link.send({ type: 'resume', leg: 0 });
    this.o.link.send({ type: 'conference', legs: [0, w.leg] });
    this.audit('conference_join', true, undefined, `ext:${w.ext}`);
    this.o.transcript.handoff('warm_transfer', w.ext, 'joined');
    const after = this.o.agent.warm_transfer;
    if (after.agent_after_join === 'leave') {
      this.agentPresent = false;
      this.modelIn = new Set();
      this.o.provider.close();
      this.audit('conference_leave', true, undefined, 'agent');
      this.o.transcript.event('agent left the conference');
      if (after.transcribe_after_agent_leaves) {
        this.startTranscriber(0);
      } else {
        for (const [, tr] of this.transcribers) tr.close();
        this.transcribers.clear();
      }
    } else {
      // Stays connected and listens to both people (mixed), muted.
      this.agentMuted = true;
      this.agentOut = ALL_CONFERENCE_LEGS;
      this.modelIn = new Set([0, w.leg]);
      this.startTranscriber(0);
      this.o.provider.addSystemNote('ORCHESTRATOR: The caller and staff are now talking to each other. Stay silent.', false);
    }
  }

  private warmGiveUp(reason: string): void {
    const w = this.warm;
    if (!w || w.phase === 'joined') return;
    this.warm = null;
    this.t.clear(w.holdTimer);
    this.log(`warm transfer ended: ${reason}`);
    this.o.transcript.handoff('warm_transfer', w.ext, reason);
    if (w.leg >= 0 && this.legsUp.has(w.leg)) this.o.link.send({ type: 'hangup', leg: w.leg });
    const tr = this.transcribers.get(w.leg);
    tr?.close();
    this.transcribers.delete(w.leg);
    if (!this.legsUp.has(0)) return;
    this.o.link.send({ type: 'resume', leg: 0 });
    this.modelIn = new Set([0]);
    this.agentOut = 0;
    this.playScript(0, 'STAFF_UNAVAILABLE', {
      tellModel: true,
      onDone: () =>
        this.o.provider.addSystemNote(
          'ORCHESTRATOR: Staff could not take the call and the caller is back with you. Offer voicemail (transfer_to_staff with a voicemail destination) or a message for staff.',
          true
        ),
    });
  }

  private startTranscriber(leg: number): void {
    if (!this.o.transcriber || this.transcribers.has(leg)) return;
    try {
      this.transcribers.set(leg, this.o.transcriber(this.rate, (text) => this.o.transcript.humanSpeech(leg, text)));
    } catch {
      this.log(`transcriber for leg ${leg} unavailable`);
    }
  }

  private onLegHangup(leg: number): void {
    this.legsUp.delete(leg);
    this.playing.delete(leg);
    this.transcribers.get(leg)?.close();
    this.transcribers.delete(leg);
    if (leg === 0) {
      // The caller left: nobody else stays on the line for them.
      if (this.warm && this.warm.leg >= 0 && this.legsUp.has(this.warm.leg)) this.o.link.send({ type: 'hangup', leg: this.warm.leg });
      return;
    }
    if (this.warm && leg === this.warm.leg) {
      if (this.warm.phase === 'joined') {
        // Staff hung up after the hand-off: the call is over for the caller too unless the agent stayed.
        this.warm = null;
        if (!this.agentPresent && this.legsUp.has(0)) this.o.link.send({ type: 'hangup', leg: 0 });
        else if (this.legsUp.has(0)) {
          this.agentMuted = false;
          this.agentOut = 0;
          this.modelIn = new Set([0]);
          this.o.provider.addSystemNote('ORCHESTRATOR: The staff member left; the caller is back with you only.', true);
        }
      } else {
        this.warmGiveUp('staff_hung_up');
      }
    }
  }

  // ── End ────────────────────────────────────────────────────────────────────────────────────────────────────

  private failHard(reason: string): void {
    if (this.ended) return;
    this.endReason = reason;
    // The model is gone: tell the caller and hand them to the first transfer destination, else end the call.
    const fallback = this.o.agent.handoffs.find((h) => h.kind === 'transfer');
    this.agentPresent = false;
    if (fallback && this.legsUp.has(0)) {
      this.playScript(0, 'TRANSFER', {
        onDone: () => this.o.link.send({ type: 'transfer', leg: 0, target: `sip:${fallback.target}@${this.o.realm}`, request_id: this.reqId() }),
      });
    } else {
      this.o.link.send({ type: 'hangup', leg: -1 });
    }
  }

  finish(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    if (this.warm) this.t.clear(this.warm.holdTimer);
    this.o.provider.close();
    for (const [, tr] of this.transcribers) tr.close();
    this.transcribers.clear();
    callBindings.forget(this.callId);
    this.o.transcript.finish(this.endReason || reason, this.quality);
    this.audit('call_end', true, undefined, (this.endReason || reason).slice(0, 40), Date.now() - Date.parse(this.o.transcript.rec.started_at));
    this.log(`ended ${this.endReason || reason}`);
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** Test/inspection helpers. */
  state() {
    return { modelIn: [...this.modelIn], agentOut: this.agentOut, agentPresent: this.agentPresent, agentMuted: this.agentMuted, warm: this.warm ? { phase: this.warm.phase, leg: this.warm.leg } : null };
  }
}

export { WARM_TOOLS };
