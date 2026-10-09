import * as fs from 'fs';
import * as path from 'path';

/**
 * Drawbridge audit log (spec §4 rule 8): one line per agent tool call.
 *
 * Append-only JSONL, one file per clinic-local day: <AUDIT_DIR>/audit/YYYY-MM-DD.jsonl (mode 0600).
 * A line holds the call's metadata only: time, server, call ID, tool, patient ID (when the
 * arguments carry one as patientId/patient), outcome, error code, latency and channel.
 * Never arguments, results, names, birth dates or chart contents.
 *
 * Writes are queued and asynchronous; nothing here throws into the request path.
 *
 *   AUDIT_DIR              base directory (default CALL_RECORDS_DIR, else ./data)
 *   AUDIT_RETENTION_DAYS   delete day files older than this (default 30); checked at the
 *                          first write of each day and by pruneAudit() at startup
 */
export type AuditServer = 'unity' | 'fhir';

export interface AuditEntry {
  ts: string;
  server: AuditServer;
  call_id: string;
  tool: string;
  patient_id: string;
  success: boolean;
  error_code: string;
  latency_ms: number;
  channel: string;
}

export interface AuditInput {
  server: AuditServer;
  tool: string;
  /** Tool arguments: read only to pick out a patient ID. Never stored. */
  args?: unknown;
  callId?: string;
  success: boolean;
  errorCode?: string;
  latencyMs: number;
  channel?: string;
}

export function auditBaseDir(): string {
  return process.env.AUDIT_DIR || process.env.CALL_RECORDS_DIR || path.join(process.cwd(), 'data');
}
export function auditDir(): string {
  return path.join(auditBaseDir(), 'audit');
}
export function retentionDays(): number {
  const n = Number(process.env.AUDIT_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 30;
}

/** YYYY-MM-DD in the clinic's timezone. */
export function dayKey(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.CLINIC_TIMEZONE || 'America/Boise',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDayKey = (s: unknown): s is string => typeof s === 'string' && DAY_RE.test(s);

/** Identifiers only: anything that doesn't look like an opaque ID (e.g. a name) is dropped. */
const ID_RE = /^[A-Za-z0-9._:\-]{1,64}$/;
export function safeId(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  return typeof v === 'string' && ID_RE.test(v.trim()) ? v.trim() : '';
}
const safeToken = (v: unknown, max = 64): string =>
  typeof v === 'string' ? v.replace(/[^A-Za-z0-9._:\-]/g, '').slice(0, max) : '';

/** Patient ID from tool arguments (patientId / patient), only when it is a plain ID. */
export function patientIdFrom(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  return safeId(a.patientId) || safeId(a.patient);
}

export function toEntry(input: AuditInput, now: Date = new Date()): AuditEntry {
  return {
    ts: now.toISOString(),
    server: input.server === 'fhir' ? 'fhir' : 'unity',
    call_id: safeId(input.callId),
    tool: safeToken(input.tool, 80),
    patient_id: patientIdFrom(input.args),
    success: !!input.success,
    error_code: input.success ? '' : safeToken(input.errorCode) || 'UNKNOWN_ERROR',
    latency_ms: Math.max(0, Math.round(Number(input.latencyMs) || 0)),
    channel: safeToken(input.channel, 32).toLowerCase(),
  };
}

let queue: Promise<void> = Promise.resolve();
let warned = false;
let lastPruneDay = '';

function warnOnce(e: unknown): void {
  if (warned) return;
  warned = true;
  console.warn(`[Drawbridge audit] write failed: ${(e as any)?.code || 'error'} (further audit errors suppressed)`);
}

/** Record one tool call. Fire-and-forget: returns immediately, never throws. */
export function auditToolCall(input: AuditInput): void {
  let entry: AuditEntry;
  try {
    if (!input || typeof input.tool !== 'string' || !input.tool) return;
    entry = toEntry(input);
  } catch (e) {
    warnOnce(e);
    return;
  }
  const day = dayKey(new Date(entry.ts));
  const line = JSON.stringify(entry) + '\n';
  queue = queue
    .then(async () => {
      const dir = auditDir();
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.promises.appendFile(path.join(dir, `${day}.jsonl`), line, { mode: 0o600 });
      if (day !== lastPruneDay) {
        lastPruneDay = day;
        await pruneAudit();
      }
    })
    .catch(warnOnce);
}

/** Resolves when queued audit writes are on disk (tests, shutdown). */
export function flushAudit(): Promise<void> {
  return queue;
}

/** Delete day files older than AUDIT_RETENTION_DAYS. Never throws. Returns files removed. */
export async function pruneAudit(now: Date = new Date()): Promise<number> {
  let removed = 0;
  try {
    const cutoff = dayKey(new Date(now.getTime() - retentionDays() * 86_400_000));
    const files = await fs.promises.readdir(auditDir()).catch(() => [] as string[]);
    for (const f of files) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (m && m[1] < cutoff) {
        await fs.promises.unlink(path.join(auditDir(), f)).then(
          () => removed++,
          () => undefined
        );
      }
    }
  } catch (e) {
    warnOnce(e);
  }
  return removed;
}

/** All entries for one day, oldest first. Malformed lines are skipped. */
export async function readAuditDay(day: string): Promise<AuditEntry[]> {
  if (!isDayKey(day)) return [];
  let text = '';
  try {
    text = await fs.promises.readFile(path.join(auditDir(), `${day}.jsonl`), 'utf8');
  } catch {
    return [];
  }
  const out: AuditEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e.tool === 'string' && typeof e.ts === 'string') out.push(e as AuditEntry);
    } catch {
      // skip partial line
    }
  }
  return out;
}

/** Day files on disk, newest first. */
export async function auditDays(): Promise<string[]> {
  const files = await fs.promises.readdir(auditDir()).catch(() => [] as string[]);
  return files
    .map((f) => f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/)?.[1])
    .filter((d): d is string => !!d)
    .sort()
    .reverse();
}

export interface ToolMetrics {
  tool: string;
  count: number;
  errors: number;
  error_rate: number; // 0..1
  p50_ms: number;
  p95_ms: number;
}

/** Nearest-rank percentile of an ascending-sorted list (0 for empty). */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** Per-tool count, error rate and p50/p95 latency; busiest tool first. */
export function toolMetrics(entries: AuditEntry[]): ToolMetrics[] {
  const by = new Map<string, AuditEntry[]>();
  for (const e of entries) {
    const rows = by.get(e.tool);
    if (rows) rows.push(e);
    else by.set(e.tool, [e]);
  }
  return [...by.entries()]
    .map(([tool, rows]) => {
      const lat = rows.map((r) => Number(r.latency_ms) || 0).sort((a, b) => a - b);
      const errors = rows.filter((r) => !r.success).length;
      return {
        tool,
        count: rows.length,
        errors,
        error_rate: rows.length ? errors / rows.length : 0,
        p50_ms: percentile(lat, 50),
        p95_ms: percentile(lat, 95),
      };
    })
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
}
