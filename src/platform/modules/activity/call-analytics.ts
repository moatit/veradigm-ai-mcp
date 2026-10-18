import * as fs from 'fs';
import * as path from 'path';
import { createHmac, randomBytes } from 'crypto';
import { AuditEntry, auditBaseDir, dayKey, readAuditRange, safeId } from '../../audit';

/**
 * One minimum-necessary call analytics record per phone call, built inside this practice's Drawbridge
 * stack from the voice platform's call_ended / call_analyzed events plus this stack's own audit log.
 * It is NOT de-identified under HIPAA Safe Harbor (it keeps the date and hour of the call): it is
 * handled as PHI under the BAA, by this stack and by the admin app that receives it.
 *
 * What a record holds (CallAnalyticsRecord): a call reference (keyed hash of the vendor call ID, not the
 * ID itself), practice ID, agent ID and version, the start hour in clinic local time, duration, direction,
 * disconnection reason (fixed list), the post-call analysis values (fixed enums and booleans only),
 * repeat-caller counts, and the tools used with their outcomes (name, calls, failed).
 *
 * What it never holds: the vendor call ID, transcript, summary text, any free text from the analysis,
 * phone numbers (full, partial or hashed), patient IDs, names, tool arguments or results, or an exact
 * start time.
 *
 * Repeat callers are counted here, in the stack: a keyed hash (HMAC-SHA256) of the caller's number
 * and the call start time go into <AUDIT_DIR>/caller-history.json (mode 0600, 8 days kept). Only the
 * counts leave the stack. The key is CALL_ANALYTICS_HASH_KEY (required in production, from the secret
 * store); outside production a random key is generated once into <AUDIT_DIR>/caller-history.key.
 * See docs/drawbridge/CALL_ANALYTICS.md.
 */

export const RECORD_SCHEMA = 1;

/** What the call was about (custom analysis field `call_reason`). */
export const CALL_REASONS = [
  'appointment_new',
  'appointment_change',
  'appointment_cancel',
  'appointment_confirm',
  'prescription_refill',
  'test_results',
  'billing_insurance',
  'records_forms',
  'referral',
  'clinical_question',
  'message_for_staff',
  'office_info',
  'wrong_number',
  'other',
] as const;

/** What kind of request it was (custom analysis field `request_category`). */
export const REQUEST_CATEGORIES = ['question', 'action_request', 'problem', 'follow_up', 'urgent', 'other'] as const;

/** Built-in analysis field `user_sentiment`, lower-cased. */
export const SENTIMENTS = ['positive', 'neutral', 'negative', 'unknown'] as const;

/**
 * The voice platform's documented disconnection reasons. Anything else becomes "other".
 * Check this list against the vendor's current API reference when the platform adds reasons.
 */
export const DISCONNECTION_REASONS = [
  'user_hangup',
  'agent_hangup',
  'call_transfer',
  'transfer_bridged',
  'transfer_cancelled',
  'voicemail_reached',
  'machine_detected',
  'inactivity',
  'max_duration_reached',
  'concurrency_limit_reached',
  'no_valid_payment',
  'scam_detected',
  'user_declined',
  'dial_busy',
  'dial_failed',
  'dial_no_answer',
  'registered_call_timeout',
  'error_inbound_webhook',
  'error_llm_websocket_open',
  'error_llm_websocket_lost_connection',
  'error_llm_websocket_runtime',
  'error_llm_websocket_corrupt_payload',
  'error_frontend_corrupted_payload',
  'error_no_audio_received',
  'error_user_not_joined',
  'error_asr',
  'error_twilio',
  'error_retell',
  'error_unknown',
  'other',
] as const;

export type CallReason = (typeof CALL_REASONS)[number];
export type RequestCategory = (typeof REQUEST_CATEGORIES)[number];
export type Sentiment = (typeof SENTIMENTS)[number];

export interface CallAnalyticsRecord {
  schema: number;
  /** "cr_" + 32 hex: HMAC of the vendor call ID under the stack-only key. Stable per call, so the admin
   *  app can upsert by it, but it can't be used to open the call at the vendor. */
  call_id: string;
  practice_id: string;
  agent_id: string;
  agent_version: number | null;
  /** Start of the hour the call began, in clinic local time, with its UTC offset (e.g. 2026-10-14T10:00:00-06:00). */
  started_at: string;
  duration_s: number | null;
  direction: 'inbound' | 'outbound' | 'web' | '';
  disconnection_reason: string;
  /** True once call_analyzed arrived; the analysis fields stay null before that. */
  analyzed: boolean;
  call_reason: CallReason | null;
  request_category: RequestCategory | null;
  resolved: boolean | null;
  transferred_to_staff: boolean | null;
  caller_sentiment: Sentiment | null;
  call_successful: boolean | null;
  in_voicemail: boolean | null;
  /** Earlier calls from the same number to this practice; null when there is no caller number (outbound, web). */
  prior_calls_24h: number | null;
  prior_calls_7d: number | null;
  tools: { name: string; calls: number; failed: number }[];
}

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 8;
const HISTORY_MAX = 50_000;
const TOOLS_MAX = 40;

const oneOf = <T extends readonly string[]>(list: T, v: unknown): T[number] | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!s) return null;
  return (list as readonly string[]).includes(s) ? (s as T[number]) : list.includes('other') ? ('other' as T[number]) : null;
};
const bool = (v: unknown): boolean | null => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && /^(true|yes)$/i.test(v.trim())) return true;
  if (typeof v === 'string' && /^(false|no)$/i.test(v.trim())) return false;
  return null;
};
/** A documented disconnection reason, "other" for anything else, "" when none was sent. */
export function disconnectionReason(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) return '';
  const s = v.trim().toLowerCase();
  return (DISCONNECTION_REASONS as readonly string[]).includes(s) ? s : 'other';
}

const isProduction = () => process.env.NODE_ENV === 'production';

/** The clinic's UTC offset at `ms`, in milliseconds (east positive). */
function tzOffsetMs(ms: number, timeZone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value])
  );
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Start of the clinic-local hour containing `ms`, as ISO 8601 with the local offset. */
export function hourStartLocal(ms: number, timeZone: string = process.env.CLINIC_TIMEZONE || 'America/Boise'): string {
  const off = tzOffsetMs(ms, timeZone);
  const local = new Date(Math.floor((ms + off) / 3_600_000) * 3_600_000);
  const sign = off < 0 ? '-' : '+';
  const mins = Math.round(Math.abs(off) / 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${local.toISOString().slice(0, 13)}:00:00${sign}${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
}

export function practiceId(): string {
  const v = String(process.env.DRAWBRIDGE_PRACTICE_ID || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(v) ? v : '';
}

// ── Repeat callers (stays in the stack) ──────────────────────────────────────

interface HistoryEntry {
  id: string;
  h: string;
  t: number;
}

const historyFile = () => path.join(auditBaseDir(), 'caller-history.json');
const keyFile = () => path.join(auditBaseDir(), 'caller-history.key');

/**
 * Write a private file atomically: directory 0700 when created, a fresh temp file (a stale one is
 * removed first, so its mode is never inherited) opened exclusively with 0600, chmod 0600 regardless
 * of umask, then rename over the target.
 */
export function writePrivateFile(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
const writePrivate = writePrivateFile;

/** CALL_ANALYTICS_HASH_KEY is set (32+ characters). Production requires it; nothing is generated there. */
export function hashKeyFromEnv(): boolean {
  return String(process.env.CALL_ANALYTICS_HASH_KEY || '').trim().length >= 32;
}

function hashKey(): string {
  const env = String(process.env.CALL_ANALYTICS_HASH_KEY || '').trim();
  if (env.length >= 32) return env;
  // In production the key comes from the secret store, never from a file next to the hashes.
  if (isProduction()) throw new Error('CALL_ANALYTICS_HASH_KEY is required in production');
  try {
    const k = fs.readFileSync(keyFile(), 'utf8').trim();
    if (k.length >= 32) return k;
  } catch {
    // generated below
  }
  const k = randomBytes(32).toString('hex');
  writePrivate(keyFile(), k);
  return k;
}

/** The call reference sent instead of the vendor call ID. */
export function callRef(callId: string): string {
  return 'cr_' + createHmac('sha256', hashKey()).update(`drawbridge-call|${callId}`).digest('hex').slice(0, 32);
}

/** Digits of a phone number, US numbers without the leading 1. Empty when it isn't a phone number. */
export function normalizeNumber(v: unknown): string {
  if (typeof v !== 'string') return '';
  let d = v.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length >= 7 && d.length <= 15 ? d : '';
}

function readHistory(): HistoryEntry[] {
  try {
    const rows = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
    return Array.isArray(rows) ? rows.filter((r) => r && typeof r.h === 'string' && typeof r.t === 'number') : [];
  } catch {
    return [];
  }
}

/**
 * Note this call in the caller history and count earlier calls from the same number.
 * Idempotent per call ID (a second event for the same call doesn't count twice).
 */
export function repeatCounts(callId: string, number: string, startMs: number, now: Date = new Date()): { d1: number; d7: number } {
  const h = createHmac('sha256', hashKey()).update(`drawbridge-caller|${number}`).digest('hex').slice(0, 32);
  const cutoff = now.getTime() - HISTORY_DAYS * DAY_MS;
  const rows = readHistory().filter((r) => r.t >= cutoff && r.id !== callId);
  const prior = rows.filter((r) => r.h === h && r.t < startMs);
  const d1 = prior.filter((r) => r.t >= startMs - DAY_MS).length;
  const d7 = prior.filter((r) => r.t >= startMs - 7 * DAY_MS).length;
  rows.push({ id: callId, h, t: startMs });
  writePrivate(historyFile(), JSON.stringify(rows.slice(-HISTORY_MAX)));
  return { d1, d7 };
}

/** Drop caller-history entries older than 8 days (daily retention job). */
export function pruneCallerHistory(now: Date = new Date()): number {
  const rows = readHistory();
  const kept = rows.filter((r) => r.t >= now.getTime() - HISTORY_DAYS * DAY_MS);
  if (kept.length !== rows.length) writePrivate(historyFile(), JSON.stringify(kept));
  return rows.length - kept.length;
}

// ── Tools used on the call (from this stack's audit log) ─────────────────────

export function toolsForCall(entries: AuditEntry[], callId: string): CallAnalyticsRecord['tools'] {
  const by = new Map<string, { name: string; calls: number; failed: number }>();
  for (const e of entries) {
    if (e.call_id !== callId || (e.kind && e.kind !== 'tool')) continue;
    const name = safeId(e.tool);
    if (!name) continue;
    const t = by.get(name) || { name, calls: 0, failed: 0 };
    t.calls++;
    if (!e.success) t.failed++;
    by.set(name, t);
  }
  return [...by.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)).slice(0, TOOLS_MAX);
}

// ── The record ───────────────────────────────────────────────────────────────

/**
 * Build the record from the event's `call` object. Allow-list only: every field is copied by name and
 * checked; enums outside the fixed lists become "other" (or null where there is no "other").
 */
export async function buildCallRecord(event: string, call: any, now: Date = new Date()): Promise<CallAnalyticsRecord | null> {
  const callId = safeId(call?.call_id);
  if (!callId) return null;
  const startMs = typeof call.start_timestamp === 'number' && call.start_timestamp > 0 ? call.start_timestamp : NaN;
  const endMs = typeof call.end_timestamp === 'number' && call.end_timestamp > 0 ? call.end_timestamp : NaN;
  const durationMs =
    typeof call.duration_ms === 'number' && call.duration_ms >= 0 ? call.duration_ms : Number.isFinite(startMs) && Number.isFinite(endMs) ? endMs - startMs : NaN;

  const direction: CallAnalyticsRecord['direction'] =
    call.call_type === 'web_call' ? 'web' : call.direction === 'inbound' ? 'inbound' : call.direction === 'outbound' ? 'outbound' : '';

  const a = call.call_analysis && typeof call.call_analysis === 'object' ? call.call_analysis : null;
  const custom = a?.custom_analysis_data && typeof a.custom_analysis_data === 'object' ? a.custom_analysis_data : {};
  const analyzed = event === 'call_analyzed' && !!a;

  let prior: { d1: number; d7: number } | null = null;
  const caller = direction === 'inbound' ? normalizeNumber(call.from_number) : '';
  if (caller && Number.isFinite(startMs)) prior = repeatCounts(callId, caller, startMs, now);

  let tools: CallAnalyticsRecord['tools'] = [];
  // Day files from the call's start to now (tool lines are written when the tool runs; analysis arrives later).
  const days = [startMs, endMs, now.getTime()].filter(Number.isFinite).map((t) => dayKey(new Date(t))).sort();
  try {
    tools = toolsForCall(await readAuditRange(days[0], days[days.length - 1], 3), callId);
  } catch {
    tools = [];
  }

  const version = Number(call.agent_version);
  return {
    schema: RECORD_SCHEMA,
    call_id: callRef(callId),
    practice_id: practiceId(),
    agent_id: safeId(call.agent_id),
    agent_version: Number.isInteger(version) && version >= 0 ? version : null,
    started_at: Number.isFinite(startMs) ? hourStartLocal(startMs) : '',
    duration_s: Number.isFinite(durationMs) ? Math.round(durationMs / 1000) : null,
    direction,
    disconnection_reason: disconnectionReason(call.disconnection_reason),
    analyzed,
    call_reason: analyzed ? oneOf(CALL_REASONS, custom.call_reason) : null,
    request_category: analyzed ? oneOf(REQUEST_CATEGORIES, custom.request_category) : null,
    resolved: analyzed ? bool(custom.resolved) : null,
    // A transfer the platform reports as the disconnection reason counts even if the field was left empty.
    transferred_to_staff: analyzed ? bool(custom.transferred_to_staff) ?? (disconnectionReason(call.disconnection_reason) === 'call_transfer' || null) : null,
    caller_sentiment: analyzed ? oneOf(SENTIMENTS, a.user_sentiment) : null,
    call_successful: analyzed ? bool(a.call_successful) : null,
    in_voicemail: analyzed ? bool(a.in_voicemail) : null,
    prior_calls_24h: prior ? prior.d1 : null,
    prior_calls_7d: prior ? prior.d7 : null,
    tools,
  };
}
