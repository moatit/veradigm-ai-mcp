import { createHash, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { auditBaseDir, retentionDays, safeId } from '../../audit';
import { callRecords } from '../../../unity/oncall/call-records';

/**
 * Retell call events (call_started, call_ended, call_analyzed).
 *
 * - Keeps a lightweight calls index in <AUDIT_DIR>/calls.json: call ID, start/end, direction,
 *   last 4 digits of the from/to numbers, agent ID, disconnection reason and whether a summary
 *   exists. No transcript, no summary text, no full phone numbers.
 * - When the on-call notebook already has a record for the call, attaches transcript_ref
 *   "retell:<id>", duration, disconnection reason and the call summary (max 1000 chars).
 *   Events never create notebook records.
 */
export const RETELL_EVENTS = new Set(['call_started', 'call_ended', 'call_analyzed']);
export const SECRET_HEADER = 'x-drawbridge-webhook-secret';
const SUMMARY_MAX = 1000;
const INDEX_MAX = 5000;

export interface CallIndexEntry {
  call_id: string;
  start: string;
  end: string;
  direction: string;
  from_last4: string;
  to_last4: string;
  agent_id: string;
  disconnection_reason: string;
  summary_present: boolean;
  updated_at: string;
}

// ── Webhook verification ─────────────────────────────────────────────────────

type SdkVerify = (body: string, apiKey: string, signature: string) => boolean | Promise<boolean>;
let sdkVerify: SdkVerify | null | undefined;

/**
 * Retell's own verifier (`Retell.verify` from the retell-sdk package) when that package is
 * installed. It is not a dependency today (installing it needs network), so this returns null
 * and the shared-secret header is required instead.
 */
export function loadRetellSdkVerify(): SdkVerify | null {
  if (sdkVerify !== undefined) return sdkVerify;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('retell-sdk');
    const R = mod?.default ?? mod?.Retell ?? mod;
    sdkVerify = typeof R?.verify === 'function' ? (R.verify.bind(R) as SdkVerify) : null;
  } catch {
    sdkVerify = null;
  }
  return sdkVerify;
}

function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

export interface VerifyResult {
  ok: boolean;
  status: number;
  reason: string;
}

/**
 * Accept a webhook when either:
 *  1. RETELL_WEBHOOK_SECRET is set and the request carries it in `x-drawbridge-webhook-secret`, or
 *  2. RETELL_API_KEY is set, retell-sdk is installed, and Retell.verify() accepts `x-retell-signature`
 *     over the raw body.
 * With neither configured the endpoint is closed (503).
 */
export async function verifyWebhook(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  opts: { sdkVerify?: SdkVerify | null } = {}
): Promise<VerifyResult> {
  const h = (k: string) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] || '' : v || '';
  };
  const secret = process.env.RETELL_WEBHOOK_SECRET || '';
  const apiKey = process.env.RETELL_API_KEY || '';
  const verify = opts.sdkVerify !== undefined ? opts.sdkVerify : loadRetellSdkVerify();
  const sdkReady = !!(apiKey && verify);

  if (!secret && !sdkReady) return { ok: false, status: 503, reason: 'webhook not configured' };

  const given = h(SECRET_HEADER);
  if (secret && given && safeEqual(given, secret)) return { ok: true, status: 200, reason: 'shared secret' };

  const sig = h('x-retell-signature');
  if (sdkReady && sig) {
    try {
      if ((await verify!(rawBody, apiKey, sig)) === true) return { ok: true, status: 200, reason: 'retell signature' };
    } catch {
      // fall through to reject
    }
  }
  return { ok: false, status: 401, reason: 'bad signature' };
}

// ── Calls index ──────────────────────────────────────────────────────────────

const indexFile = () => path.join(auditBaseDir(), 'calls.json');

export function readCallsIndex(): CallIndexEntry[] {
  try {
    const rows = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function writeCallsIndex(rows: CallIndexEntry[]): void {
  const file = indexFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Calls newest first. */
export function recentCalls(limit = 200): CallIndexEntry[] {
  return readCallsIndex()
    .sort((a, b) => (b.start || b.updated_at).localeCompare(a.start || a.updated_at))
    .slice(0, limit);
}

const last4 = (v: unknown): string => (typeof v === 'string' ? v.replace(/\D/g, '').slice(-4) : '');
const isoFromMs = (v: unknown): string =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? new Date(v).toISOString() : '';
const token = (v: unknown, max = 64): string =>
  typeof v === 'string' ? v.replace(/[^A-Za-z0-9 ._:\-]/g, '').slice(0, max) : '';

// ── Event handling ───────────────────────────────────────────────────────────

export interface EventOutcome {
  status: number;
  event: string;
  call_id: string;
  record_updated: boolean;
}

export function handleRetellEvent(body: any, now: Date = new Date()): EventOutcome {
  const event = typeof body?.event === 'string' ? body.event : '';
  const call = body?.call || body?.data || {};
  const callId = safeId(call?.call_id);
  if (!RETELL_EVENTS.has(event)) return { status: 204, event: token(event), call_id: callId, record_updated: false };
  if (!callId) return { status: 400, event, call_id: '', record_updated: false };

  const start = isoFromMs(call.start_timestamp);
  const end = isoFromMs(call.end_timestamp);
  const disconnection = token(call.disconnection_reason);
  const summaryText =
    typeof call.call_analysis?.call_summary === 'string' ? call.call_analysis.call_summary.trim() : '';
  const duration =
    typeof call.duration_ms === 'number' && call.duration_ms >= 0
      ? Math.round(call.duration_ms)
      : typeof call.start_timestamp === 'number' && typeof call.end_timestamp === 'number'
        ? Math.max(0, call.end_timestamp - call.start_timestamp)
        : undefined;

  // 1. Calls index (always)
  const rows = readCallsIndex();
  const i = rows.findIndex((r) => r.call_id === callId);
  const prev: CallIndexEntry = i >= 0 ? rows[i] : {
    call_id: callId, start: '', end: '', direction: '', from_last4: '', to_last4: '',
    agent_id: '', disconnection_reason: '', summary_present: false, updated_at: '',
  };
  const direction = token(call.direction, 16) || (call.call_type === 'web_call' ? 'web' : '');
  const next: CallIndexEntry = {
    call_id: callId,
    start: start || prev.start,
    end: end || prev.end,
    direction: direction || prev.direction,
    from_last4: last4(call.from_number) || prev.from_last4,
    to_last4: last4(call.to_number) || prev.to_last4,
    agent_id: safeId(call.agent_id) || prev.agent_id,
    disconnection_reason: disconnection || prev.disconnection_reason,
    summary_present: prev.summary_present || !!summaryText,
    updated_at: now.toISOString(),
  };
  if (i >= 0) rows[i] = next;
  else rows.push(next);
  const cutoff = new Date(now.getTime() - retentionDays() * 86_400_000).toISOString();
  const kept = rows
    .filter((r) => (r.start || r.updated_at) >= cutoff)
    .sort((a, b) => (b.start || b.updated_at).localeCompare(a.start || a.updated_at))
    .slice(0, INDEX_MAX);
  writeCallsIndex(kept);

  // 2. Notebook record, only if one already exists for this call
  const rec = callRecords.get(callId);
  if (!rec) return { status: 204, event, call_id: callId, record_updated: false };
  const meta = { ...(rec.call_meta || {}) };
  if (end) meta.ended_at = end;
  if (duration !== undefined) meta.duration_ms = duration;
  if (disconnection) meta.disconnection_reason = disconnection;
  if (summaryText) meta.summary = summaryText.slice(0, SUMMARY_MAX);
  callRecords.upsert(callId, rec.mode, { transcript_ref: `retell:${callId}`, call_meta: meta });
  return { status: 204, event, call_id: callId, record_updated: true };
}
