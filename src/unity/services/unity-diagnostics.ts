import * as fs from 'fs';
import * as path from 'path';
import { UnityActions, UnityTargetSystem } from '../config/unity-endpoints';
import { pick, unityRows } from '../utils/unity-rows';
import { errorSummary } from '../../utils/safe-log';
import { BackgroundContact, backgroundContact } from './background-contact';

/**
 * Veradigm connection diagnostics: the two admin actions Veradigm requires certified apps to use.
 *
 *  - GetServerInfo: called once per configured target (PM, EHR) at server start, after the first
 *    token, then at most every UNITY_SERVER_INFO_REFRESH_HOURS (default 6). Only product, version,
 *    time zone and server time are kept. A failure is logged and shown as "unavailable"; it never
 *    stops the server.
 *  - LastLogs: when an action fails with a server-side error (HTTP 500, an unexpected Unity
 *    exception), LastLogs is called once for that target, at most once per
 *    UNITY_LASTLOGS_MIN_INTERVAL_SEC (default 60) per target. Never for a failed LastLogs (no loop).
 *    Kept: timestamp, action and a trimmed, scrubbed message per entry (dates, long numbers and
 *    e-mail addresses masked), written to the server log and to the unity-diagnostics record
 *    (<CALL_RECORDS_DIR>/unity-diagnostics.json, mode 0600, last 50) that staff see under
 *    "Veradigm connection".
 */
type ExecuteAction = (action: string, params?: any, patientId?: string, target?: any) => Promise<any>;
export interface DiagnosticsUnity {
  executeAction: ExecuteAction;
}

export type ServerInfoStatus = 'ok' | 'unavailable' | 'not_checked';

export interface ServerInfoSummary {
  target: UnityTargetSystem;
  status: ServerInfoStatus;
  checked_at: string;
  product: string;
  version: string;
  time_zone: string;
  server_time: string;
  /** Error code when unavailable (never the raw reply). */
  error_code: string;
}

export interface LastLogsEntry {
  timestamp: string;
  action: string;
  message: string;
}

export interface LastLogsRecord {
  at: string;
  target: UnityTargetSystem;
  /** The action whose failure triggered this LastLogs call, and its error code. */
  trigger_action: string;
  trigger_code: string;
  status: 'ok' | 'failed';
  error_code: string;
  entries: LastLogsEntry[];
}

const num = (v: unknown, d: number, min: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : d;
};
export const serverInfoRefreshMs = () => num(process.env.UNITY_SERVER_INFO_REFRESH_HOURS, 6, 1) * 3_600_000;
export const lastLogsMinIntervalMs = () => num(process.env.UNITY_LASTLOGS_MIN_INTERVAL_SEC, 60, 10) * 1000;
const RECORDS_MAX = 50;
const ENTRIES_MAX = 20;

/** Short, printable, single-line text. */
const clip = (v: unknown, max: number) =>
  String(v ?? '')
    .replace(/[^ -~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** Mask what could identify a patient in a troubleshooting message: dates, long numbers, e-mail addresses. */
export function scrubLogText(v: unknown, max = 300): string {
  return clip(v, 2000)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b/g, '[date]')
    .replace(/\d{4,}/g, '[n]')
    .slice(0, max);
}

/** Product / version / time zone / server time only, whatever else GetServerInfo returns. */
export function parseServerInfo(target: UnityTargetSystem, data: unknown, now: Date): ServerInfoSummary {
  const row = unityRows(data)[0];
  return {
    target,
    status: 'ok',
    checked_at: now.toISOString(),
    product: clip(pick(row, 'System', 'Product', 'ProductName', 'ServerName'), 80),
    version: clip(pick(row, 'ProductVersion', 'Version', 'ServerVersion'), 40),
    time_zone: clip(pick(row, 'ServerTimeZone', 'TimeZone'), 60),
    server_time: clip(pick(row, 'ServerTime', 'ServerDateTime', 'DateTime'), 40),
    error_code: '',
  };
}

/** Timestamp / action / scrubbed message per LastLogs row (newest Veradigm order kept), at most 20. */
export function parseLastLogs(data: unknown): LastLogsEntry[] {
  return unityRows(data)
    .map((r) => ({
      timestamp: clip(pick(r, 'Timestamp', 'LogDate', 'LogDateTime', 'DateTime', 'Date', 'Time', 'CreatedDate'), 40),
      action: clip(pick(r, 'Action', 'ActionName', 'Method', 'Operation'), 60),
      message: scrubLogText(pick(r, 'Message', 'ErrorMessage', 'Error', 'Exception', 'Description', 'Detail')),
    }))
    .filter((e) => e.timestamp || e.action || e.message)
    .slice(0, ENTRIES_MAX);
}

/** Error codes that point at Veradigm's side (worth a LastLogs look); not network, auth or validation. */
export function isServerSideError(code: string): boolean {
  return code === 'SERVER_ERROR' || code === 'UNKNOWN_ERROR' || code === 'UNITY_ERROR';
}

/** A Unity reply with success:false whose text reads like an unexpected server exception (not a validation message). */
export function isUnexpectedUnityError(message: unknown): boolean {
  return /magic error|exception|unexpected|internal (server )?error|object reference|sql/i.test(String(message || ''));
}

export interface DiagnosticsOptions {
  unity: DiagnosticsUnity;
  /** Targets with a configured login (PM is optional). */
  targets: () => UnityTargetSystem[];
  now?: () => number;
  /** Directory for unity-diagnostics.json (default CALL_RECORDS_DIR, else ./data). Empty string: memory only. */
  dir?: string;
  log?: (line: string) => void;
  /** Background-contact clock (the health probe's 2-minute floor); default the process-wide one. */
  contact?: BackgroundContact;
}

export class UnityDiagnostics {
  private info = new Map<UnityTargetSystem, ServerInfoSummary>();
  private lastInfoCheck = 0;
  private lastLogsAt = new Map<UnityTargetSystem, number>();
  private lastLogsRunning = new Set<UnityTargetSystem>();
  private records: LastLogsRecord[] | null = null;
  private refreshing: Promise<ServerInfoSummary[]> | null = null;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private opts: DiagnosticsOptions) {
    this.now = opts.now || Date.now;
    this.log = opts.log || ((l) => console.error(l));
  }

  private file(): string {
    const dir = this.opts.dir ?? (process.env.CALL_RECORDS_DIR || path.join(process.cwd(), 'data'));
    return dir ? path.join(dir, 'unity-diagnostics.json') : '';
  }

  /** Cached GetServerInfo results, one per configured target ("not_checked" before the first run). */
  serverInfo(): ServerInfoSummary[] {
    return this.opts.targets().map(
      (t) =>
        this.info.get(t) || { target: t, status: 'not_checked', checked_at: '', product: '', version: '', time_zone: '', server_time: '', error_code: '' }
    );
  }

  /** Call GetServerInfo for every configured target unless checked within the refresh window (or `force`). Never throws. */
  async refreshServerInfo(force = false): Promise<ServerInfoSummary[]> {
    if (!force && this.lastInfoCheck && this.now() - this.lastInfoCheck < serverInfoRefreshMs()) return this.serverInfo();
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      this.lastInfoCheck = this.now();
      for (const target of this.opts.targets()) {
        const at = new Date(this.now());
        let summary: ServerInfoSummary;
        (this.opts.contact || backgroundContact).note(target, this.now());
        try {
          const res = await this.opts.unity.executeAction(UnityActions.Admin.GET_SERVER_INFO, {}, '', target);
          summary = res?.success
            ? parseServerInfo(target, res.data, at)
            : { ...parseServerInfo(target, null, at), status: 'unavailable', error_code: 'UNITY_ERROR' };
        } catch (e: any) {
          summary = { ...parseServerInfo(target, null, at), status: 'unavailable', error_code: clip(e?.code || 'UNKNOWN_ERROR', 40) };
        }
        this.info.set(target, summary);
        this.log(
          summary.status === 'ok'
            ? `[Veradigm] GetServerInfo ${target}: ${summary.product || '?'} ${summary.version || '?'} (${summary.time_zone || 'time zone ?'})`
            : `[Veradigm] GetServerInfo ${target} unavailable (${summary.error_code})`
        );
      }
      return this.serverInfo();
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** First GetServerInfo now, then every refresh window. Returns a stop function. */
  start(): () => void {
    void this.refreshServerInfo(true);
    const timer = setInterval(() => void this.refreshServerInfo(), serverInfoRefreshMs());
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /**
   * An action failed on Veradigm's side: fetch LastLogs for that target (rate-limited, fire-and-forget).
   * Returns the promise for tests; callers never await it.
   */
  onServerError(action: string, target: UnityTargetSystem, code: string): Promise<LastLogsRecord | null> {
    if (action === UnityActions.Admin.LAST_LOG) return Promise.resolve(null); // a failing LastLogs never triggers LastLogs
    if (this.lastLogsRunning.has(target)) return Promise.resolve(null);
    const last = this.lastLogsAt.get(target) || 0;
    if (last && this.now() - last < lastLogsMinIntervalMs()) return Promise.resolve(null);
    this.lastLogsAt.set(target, this.now());
    this.lastLogsRunning.add(target);
    return (async () => {
      const rec: LastLogsRecord = {
        at: new Date(this.now()).toISOString(),
        target,
        trigger_action: clip(action, 60),
        trigger_code: clip(code, 40),
        status: 'ok',
        error_code: '',
        entries: [],
      };
      try {
        const res = await this.opts.unity.executeAction(UnityActions.Admin.LAST_LOG, {}, '', target);
        if (res?.success) rec.entries = parseLastLogs(res.data);
        else Object.assign(rec, { status: 'failed', error_code: 'UNITY_ERROR' });
      } catch (e: any) {
        Object.assign(rec, { status: 'failed', error_code: clip(e?.code || 'UNKNOWN_ERROR', 40) });
      }
      this.log(
        rec.status === 'ok'
          ? `[Veradigm] LastLogs ${target} after ${rec.trigger_action} ${rec.trigger_code}: ${rec.entries.length} entr${rec.entries.length === 1 ? 'y' : 'ies'}` +
              rec.entries.slice(0, 5).map((e) => `\n  ${e.timestamp} ${e.action} ${e.message.slice(0, 200)}`).join('')
          : `[Veradigm] LastLogs ${target} after ${rec.trigger_action} ${rec.trigger_code} failed (${rec.error_code})`
      );
      this.save(rec);
      return rec;
    })()
      .catch((e) => {
        this.log(`[Veradigm] LastLogs record failed: ${errorSummary(e)}`);
        return null;
      })
      .finally(() => this.lastLogsRunning.delete(target));
  }

  /** LastLogs records, newest first. */
  lastLogs(): LastLogsRecord[] {
    return [...this.load()].reverse();
  }

  private load(): LastLogsRecord[] {
    if (this.records) return this.records;
    this.records = [];
    const f = this.file();
    if (!f) return this.records;
    try {
      const rows = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Array.isArray(rows)) this.records = rows.slice(-RECORDS_MAX);
    } catch {
      // No file yet: start empty.
    }
    return this.records;
  }

  private save(rec: LastLogsRecord): void {
    const rows = this.load();
    rows.push(rec);
    if (rows.length > RECORDS_MAX) rows.splice(0, rows.length - RECORDS_MAX);
    const f = this.file();
    if (!f) return;
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, f);
    } catch (e) {
      this.log(`[Veradigm] diagnostics record not saved: ${errorSummary(e)}`);
    }
  }
}

let current: UnityDiagnostics | null = null;
/** The running server's diagnostics (null in tools that never call Veradigm). */
export function getUnityDiagnostics(): UnityDiagnostics | null {
  return current;
}
export function setUnityDiagnostics(d: UnityDiagnostics | null): void {
  current = d;
}
