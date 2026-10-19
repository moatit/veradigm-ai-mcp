import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Drawbridge audit log (spec §4 rule 8): one line per agent tool call, and one line per Veradigm
 * action a module sends directly (intake filing and observer reads, huddle/outreach/scheduling
 * reads, GetServerInfo/LastLogs) with kind "action" and the action name in `tool`.
 *
 * Append-only JSONL, one file per clinic-local day: <AUDIT_DIR>/audit/YYYY-MM-DD.jsonl (mode 0600).
 * A line holds the call's metadata only: time, server, call ID, tool, patient ID (when the
 * arguments carry one as patientId/patient), outcome, error code, latency and channel.
 * Never arguments, results, names, birth dates or chart contents.
 *
 * Tamper evidence: every line carries `prev` (the hash of the previous line written by the same
 * server in that day file; the first line chains from sha256("drawbridge-audit|<day>|<server>"))
 * and `hash` = sha256 of the line without `hash`. Editing, deleting or reordering a line breaks the
 * chain; `npm run audit:verify -- <YYYY-MM-DD>` checks a day file (verifyAuditDay). Truncating the
 * end of a file or deleting a whole day file is not detectable this way: keep the files on
 * append-only / backed-up storage for that (docs/drawbridge/SECURITY_CONTROLS.md).
 *
 * Staff access (HIPAA 164.312(b)): every staff screen request writes a line too, kind "view" (GET) or
 * "staff" (POST), with the staff `user`, the screen in `tool`, the opaque path in `object` and the
 * patient ID when the screen is about one patient (app.ts staffAudit). Security events (sign-ins,
 * failures, lockouts, expired passwords, rejected keys and webhooks, integrity failures, export
 * volume alerts) are kind "security" (security-events.ts) and may carry the client `ip`.
 *
 * Writes are queued and asynchronous; nothing here throws into the request path.
 *
 *   AUDIT_DIR              base directory (default CALL_RECORDS_DIR, else ./data)
 *   AUDIT_RETENTION_DAYS   delete day files older than this (default 2190 = 6 years, HIPAA
 *                          164.316(b)(2) and the 6-year accounting window of 164.528); checked at
 *                          the first write of each day and by pruneAudit() at startup
 */
export type AuditServer = 'unity' | 'fhir';
/**
 * tool: an agent/staff tool call; action: a Veradigm action a module sent directly;
 * view: a staff screen was shown; staff: a staff change (POST); security: a security event.
 */
export type AuditKind = 'tool' | 'action' | 'view' | 'staff' | 'security';
const KINDS: AuditKind[] = ['tool', 'action', 'view', 'staff', 'security'];

/** The server name this process writes when a caller doesn't say (the FHIR server sets 'fhir'). */
let defaultServer: AuditServer = 'unity';
export function setDefaultAuditServer(s: AuditServer): void {
  defaultServer = s === 'fhir' ? 'fhir' : 'unity';
}
export const defaultAuditServer = (): AuditServer => defaultServer;

export interface AuditEntry {
  ts: string;
  server: AuditServer;
  kind: AuditKind;
  call_id: string;
  tool: string;
  patient_id: string;
  success: boolean;
  error_code: string;
  latency_ms: number;
  channel: string;
  /** Staff username (view / staff / security lines only). */
  user?: string;
  /** What was viewed or acted on: an opaque path or ID, never a name (view / staff / security lines only). */
  object?: string;
  /** Client IP (security lines only). */
  ip?: string;
  /** Hash of the previous line from the same server in this day file (chain start: genesis hash). */
  prev?: string;
  /** sha256 of this line without `hash`. */
  hash?: string;
}

export interface AuditInput {
  server: AuditServer;
  kind?: AuditKind;
  tool: string;
  /** Tool arguments: read only to pick out a patient ID. Never stored. */
  args?: unknown;
  /** Patient ID passed explicitly (Veradigm actions), only kept when it is a plain ID. */
  patientId?: unknown;
  callId?: string;
  success: boolean;
  errorCode?: string;
  latencyMs: number;
  channel?: string;
  /** Staff username. */
  user?: unknown;
  /** Opaque path or ID of what was viewed or acted on. */
  object?: unknown;
  /** Client IP (security events). */
  ip?: unknown;
}

export function auditBaseDir(): string {
  return process.env.AUDIT_DIR || process.env.CALL_RECORDS_DIR || path.join(process.cwd(), 'data');
}
export function auditDir(): string {
  return path.join(auditBaseDir(), 'audit');
}
export function retentionDays(): number {
  const n = Number(process.env.AUDIT_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2190;
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

/** Staff usernames as the users file allows them (letters, digits, . _ @ + -, up to 128), lower case. */
export const safeUser = (v: unknown): string =>
  typeof v === 'string' && /^[A-Za-z0-9._@+-]{1,128}$/.test(v.trim()) ? v.trim().toLowerCase() : '';
/** Opaque paths and IDs ("/call/call_abc", "in_x1"): no spaces, no query strings, at most 120 characters. */
const safeObject = (v: unknown): string => (typeof v === 'string' ? v.split('?')[0].replace(/[^A-Za-z0-9._:\-/]/g, '').slice(0, 120) : '');

export function toEntry(input: AuditInput, now: Date = new Date()): AuditEntry {
  const entry: AuditEntry = {
    ts: now.toISOString(),
    server: input.server === 'fhir' ? 'fhir' : 'unity',
    kind: KINDS.includes(input.kind as AuditKind) ? (input.kind as AuditKind) : 'tool',
    call_id: safeId(input.callId),
    tool: safeToken(input.tool, 80),
    patient_id: safeId(input.patientId) || patientIdFrom(input.args),
    success: !!input.success,
    error_code: input.success ? '' : safeToken(input.errorCode) || 'UNKNOWN_ERROR',
    latency_ms: Math.max(0, Math.round(Number(input.latencyMs) || 0)),
    channel: safeToken(input.channel, 32).toLowerCase(),
  };
  // Only on lines that have them, so tool and action lines keep their shape.
  const user = safeUser(input.user);
  const object = safeObject(input.object);
  const ip = safeToken(input.ip, 64);
  if (user) entry.user = user;
  if (object) entry.object = object;
  if (ip) entry.ip = ip;
  return entry;
}

let queue: Promise<void> = Promise.resolve();
let warned = false;
let lastPruneDay = '';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
/** First `prev` of a server's chain in a day file. */
export const genesisHash = (day: string, server: string) => sha256(`drawbridge-audit|${day}|${server}`);
/** hash of a line = sha256 of its JSON without `hash` (key order as written). */
export const lineHash = (entryWithPrev: Omit<AuditEntry, 'hash'>) => sha256(JSON.stringify(entryWithPrev));

/** Last hash per "<day file>|<server>" written by this process (read back from the file after a restart). */
const chainHeads = new Map<string, string>();

async function chainHead(file: string, day: string, server: string): Promise<string> {
  const key = `${file}|${server}`;
  const known = chainHeads.get(key);
  if (known) return known;
  let head = genesisHash(day, server);
  const text = await fs.promises.readFile(file, 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.server === server && typeof e.hash === 'string') head = e.hash;
    } catch {
      // partial line: ignored here, reported by verifyAuditDay
    }
  }
  chainHeads.set(key, head);
  return head;
}

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
  queue = queue
    .then(async () => {
      const dir = auditDir();
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${day}.jsonl`);
      // Chain: computed inside the queue so lines from this process are hashed in write order.
      const withPrev = { ...entry, prev: await chainHead(file, day, entry.server) };
      const hash = lineHash(withPrev);
      await fs.promises.appendFile(file, JSON.stringify({ ...withPrev, hash }) + '\n', { mode: 0o600 });
      chainHeads.set(`${file}|${entry.server}`, hash);
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

export interface AuditVerifyResult {
  ok: boolean;
  file: string;
  lines: number;
  /** Lines with a valid place in their server's chain. */
  chained: number;
  /** Lines written before the chain existed (no hash), before the first chained line of their server. */
  unchained: number;
  errors: Array<{ line: number; reason: string }>;
}

/**
 * Check the hash chain of one day file (or a file path). Each server's lines must chain from the
 * genesis hash in order, each hash must match its line, and nothing unparsable or unchained may
 * follow a chained line. Never throws; a missing file is an error result.
 */
export async function verifyAuditDay(dayOrFile: string): Promise<AuditVerifyResult> {
  const file = isDayKey(dayOrFile) ? path.join(auditDir(), `${dayOrFile}.jsonl`) : dayOrFile;
  const day = isDayKey(dayOrFile) ? dayOrFile : path.basename(file).replace(/\.jsonl$/, '');
  const out: AuditVerifyResult = { ok: false, file, lines: 0, chained: 0, unchained: 0, errors: [] };
  let text: string;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (e: any) {
    out.errors.push({ line: 0, reason: `cannot read file (${e?.code || 'error'})` });
    return out;
  }
  const heads = new Map<string, string>();
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  rows.forEach((raw, i) => {
    const n = i + 1;
    out.lines++;
    let e: any;
    try {
      e = JSON.parse(raw);
    } catch {
      out.errors.push({ line: n, reason: 'not valid JSON (edited or truncated line)' });
      return;
    }
    const server = String(e?.server || '');
    if (typeof e?.hash !== 'string') {
      if (heads.has(server)) out.errors.push({ line: n, reason: `line without hash after the ${server} chain started` });
      else out.unchained++;
      return;
    }
    const expectedPrev = heads.get(server) ?? genesisHash(day, server);
    const { hash, ...rest } = e;
    if (rest.prev !== expectedPrev) {
      out.errors.push({ line: n, reason: `${server} chain broken: prev does not match the previous ${server} line (line removed, inserted or reordered)` });
    } else if (lineHash(rest) !== hash) {
      out.errors.push({ line: n, reason: 'hash does not match the line (line edited)' });
    } else {
      out.chained++;
    }
    heads.set(server, hash);
  });
  out.ok = out.errors.length === 0 && out.lines > 0;
  if (!out.lines) out.errors.push({ line: 0, reason: 'empty file' });
  return out;
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

/** All entries of the day files from `from` to `to` (inclusive, YYYY-MM-DD), oldest first. At most `maxDays` files. */
export async function readAuditRange(from: string, to: string, maxDays = 2200): Promise<AuditEntry[]> {
  if (!isDayKey(from) || !isDayKey(to) || from > to) return [];
  const days = (await auditDays()).filter((d) => d >= from && d <= to).sort().slice(-maxDays);
  const out: AuditEntry[] = [];
  for (const d of days) out.push(...(await readAuditDay(d)));
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
