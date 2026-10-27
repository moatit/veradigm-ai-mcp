import * as fs from 'fs';
import * as path from 'path';
import { safeId } from '../../audit';
import { retentionDaysFrom } from '../../retention';
import { upsertCallIndex } from '../activity/retell-events';
import { callRecords } from '../../../unity/oncall/call-records';
import { voiceDir } from './config';
import { CallUsage } from './usage';

/**
 * Voice call records with live transcripts (PHI): one JSON file per call on the data volume
 * (<CALL_RECORDS_DIR>/voice/calls/<call_id>.json, mode 0600), kept CALL_RECORDS_RETENTION_DAYS (default 30) like
 * the on-call call records. The server log never carries transcript text, only IDs, codes and timings.
 *
 * Speaker labels come from the leg the audio arrived on, never from diarization:
 *   agent          our model or a scripted clip
 *   caller         leg 0 (the inbound call)
 *   far_end        leg 0 after the PBX changed that leg's media itself (it may have joined a third party there;
 *                  those voices arrive mixed in one stream, so they are not told apart)
 *   staff:<ext>    a leg this call dialled (warm transfer), named by the extension
 *   system         orchestrator events (tool calls, transfers, hold), no speech
 * The calls index (<AUDIT_DIR>/calls.json) gets the call too, with the caller's last 4 digits only.
 */
export type Speaker = 'agent' | 'caller' | 'far_end' | 'system' | `staff:${string}`;

export interface TranscriptEntry {
  at: string;
  ms: number;
  speaker: Speaker;
  leg: number;
  kind: 'speech' | 'script' | 'tool' | 'event';
  text: string;
  script?: string;
  tool?: string;
  ok?: boolean;
  /** Agent speech cut off by the caller: only what was played is kept. */
  truncated?: boolean;
}

export interface TurnMetric {
  at: string;
  /** Caller end of speech (gateway energy detector) -> first agent audio leaving the gateway. */
  e2e_ms?: number;
  /** Provider end of speech (its voice detector) -> first audio from the provider. */
  provider_ms?: number;
  /** Tool turns: provider end of speech -> first audio of the answer after the tool result. */
  answer_ms?: number;
  tools: Array<{ name: string; ms: number; ok: boolean }>;
  kind: 'plain' | 'tool' | 'script';
}

export interface VoiceCallRecord {
  call_id: string;
  started_at: string;
  ended_at: string;
  agent_id: string;
  provider: string;
  model: string;
  voice: string;
  caller_last4: string;
  mode: 'business_hours' | 'after_hours';
  media: { transport: 'tls'; codec: string; srtp: boolean };
  entries: TranscriptEntry[];
  turns: TurnMetric[];
  handoffs: Array<{ at: string; action: string; target: string; result: string }>;
  quality: Record<string, unknown>;
  /** Billing counts and estimated cost (no content). */
  usage?: CallUsage;
  end_reason: string;
}

const MAX_ENTRIES = 2000;
const dir = () => path.join(voiceDir(), 'calls');
const fileOf = (id: string) => path.join(dir(), `${id}.json`);

export function readVoiceCall(callId: string): VoiceCallRecord | null {
  const id = safeId(callId);
  if (!id) return null;
  try {
    return JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
  } catch {
    return null;
  }
}

export type VoiceCallRow = Pick<VoiceCallRecord, 'call_id' | 'started_at' | 'ended_at' | 'caller_last4' | 'provider' | 'end_reason'> & {
  turns: number;
  p50_ms: number | null;
  cost_usd: number | null;
  per_minute_usd: number | null;
  duration_s: number | null;
};

export function listVoiceCalls(limit = 100): VoiceCallRow[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir()).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const rows: VoiceCallRow[] = [];
  for (const n of names) {
    try {
      const r: VoiceCallRecord = JSON.parse(fs.readFileSync(path.join(dir(), n), 'utf8'));
      const lat = r.turns.map((t) => t.e2e_ms).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
      rows.push({
        call_id: r.call_id,
        started_at: r.started_at,
        ended_at: r.ended_at,
        caller_last4: r.caller_last4,
        provider: r.provider,
        end_reason: r.end_reason,
        turns: r.turns.length,
        p50_ms: lat.length ? lat[Math.floor((lat.length - 1) / 2)] : null,
        cost_usd: r.usage?.cost?.total_usd ?? null,
        per_minute_usd: r.usage?.cost?.per_minute_usd ?? null,
        duration_s: r.usage?.duration_s ?? null,
      });
    } catch {
      // skip a partial file
    }
  }
  return rows.sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, limit);
}

export function pruneVoiceCalls(days = retentionDaysFrom('CALL_RECORDS_RETENTION_DAYS'), now = Date.now()): number {
  let removed = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir());
  } catch {
    return 0;
  }
  for (const n of names) {
    const f = path.join(dir(), n);
    try {
      if (now - fs.statSync(f).mtimeMs > days * 86_400_000) {
        fs.unlinkSync(f);
        removed++;
      }
    } catch {
      // ignore
    }
  }
  return removed;
}

/** One call's transcript + metrics, written to disk as it grows (debounced) and at the end. */
export class CallTranscript {
  readonly rec: VoiceCallRecord;
  private t0 = Date.now();
  private timer: NodeJS.Timeout | null = null;
  private farEnd = false;
  private staffExt = new Map<number, string>();

  constructor(init: Omit<VoiceCallRecord, 'entries' | 'turns' | 'handoffs' | 'quality' | 'ended_at' | 'end_reason' | 'started_at'>) {
    this.rec = { ...init, started_at: new Date().toISOString(), ended_at: '', entries: [], turns: [], handoffs: [], quality: {}, end_reason: '' };
    upsertCallIndex({ call_id: init.call_id, start: this.rec.started_at, direction: 'inbound', from_last4: init.caller_last4, agent_id: `voice:${init.agent_id}` });
    this.flushSoon();
  }

  /** Leg 0's audio may now carry more than one far-end voice (the PBX re-negotiated that leg itself). */
  markFarEnd(): void {
    this.farEnd = true;
  }

  /** ext: an extension, or "...1234" for an outside number (never the full number). */
  setStaffLeg(leg: number, ext: string): void {
    this.staffExt.set(leg, ext.replace(/[^0-9.]/g, '').slice(0, 8));
  }

  /** The speaker label for human audio on a leg. */
  speakerOf(leg: number): Speaker {
    if (leg === 0) return this.farEnd ? 'far_end' : 'caller';
    return `staff:${this.staffExt.get(leg) || String(leg)}`;
  }

  add(e: Omit<TranscriptEntry, 'at' | 'ms'>): TranscriptEntry {
    const entry: TranscriptEntry = { at: new Date().toISOString(), ms: Date.now() - this.t0, ...e, text: String(e.text || '').slice(0, 4000) };
    if (this.rec.entries.length < MAX_ENTRIES) this.rec.entries.push(entry);
    this.flushSoon();
    return entry;
  }

  humanSpeech(leg: number, text: string): void {
    const t = String(text || '').trim();
    if (t) this.add({ speaker: this.speakerOf(leg), leg, kind: 'speech', text: t });
  }

  agentSpeech(leg: number, text: string, truncated = false): void {
    const t = String(text || '').trim();
    if (t) this.add({ speaker: 'agent', leg, kind: 'speech', text: t, truncated: truncated || undefined });
  }

  script(leg: number, id: string, text: string): void {
    this.add({ speaker: 'agent', leg, kind: 'script', script: id, text });
  }

  /** Tool calls: name and outcome only (results are not speech and stay out of the transcript). */
  tool(name: string, ok: boolean, errorCode?: string): void {
    this.add({ speaker: 'system', leg: -1, kind: 'tool', tool: name, ok, text: ok ? '' : String(errorCode || 'error').slice(0, 40) });
  }

  event(text: string, leg = -1): void {
    this.add({ speaker: 'system', leg, kind: 'event', text });
  }

  turn(m: Omit<TurnMetric, 'at'>): TurnMetric {
    const t: TurnMetric = { at: new Date().toISOString(), ...m };
    if (this.rec.turns.length < 1000) this.rec.turns.push(t);
    this.flushSoon();
    return t;
  }

  /** A turn object returned by turn() was updated (tool timings, answer time). */
  turnChanged(): void {
    this.flushSoon();
  }

  handoff(action: string, target: string, result: string): void {
    this.rec.handoffs.push({ at: new Date().toISOString(), action, target, result });
    this.flushSoon();
  }

  setMedia(codec: string, srtp: boolean): void {
    this.rec.media = { transport: 'tls', codec, srtp };
  }

  finish(reason: string, quality: Record<string, unknown>, usage?: CallUsage): void {
    this.rec.ended_at = new Date().toISOString();
    if (usage) this.rec.usage = usage;
    this.rec.end_reason = reason.slice(0, 40);
    this.rec.quality = quality;
    this.flush();
    upsertCallIndex({ call_id: this.rec.call_id, end: this.rec.ended_at, disconnection_reason: this.rec.end_reason });
    // An on-call notebook record for this call (after-hours) points at the transcript, like Retell's.
    const nb = callRecords.get(this.rec.call_id);
    if (nb) {
      callRecords.upsert(this.rec.call_id, nb.mode, {
        transcript_ref: `voice:${this.rec.call_id}`,
        call_meta: { ...(nb.call_meta || {}), ended_at: this.rec.ended_at, duration_ms: Date.parse(this.rec.ended_at) - Date.parse(this.rec.started_at), disconnection_reason: this.rec.end_reason },
      });
    }
  }

  private flushSoon(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 1000);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
      const f = fileOf(this.rec.call_id);
      fs.writeFileSync(`${f}.tmp`, JSON.stringify(this.rec), { mode: 0o600 });
      fs.renameSync(`${f}.tmp`, f);
    } catch (e: any) {
      console.error(`[Voice] transcript write failed: ${e?.code || 'error'}`);
    }
  }
}
