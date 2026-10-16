import { UnityActions, UnityTargetSystem } from '../config/unity-endpoints';
import { scrubLogText } from './unity-diagnostics';
import { auditToolCall } from '../../platform/audit';
import type { SystemStatus } from '../../platform/system-status';
import { errorSummary } from '../../utils/safe-log';

/**
 * Veradigm health checker and token keep-warm.
 *
 * Health check (every UNITY_HEALTH_CHECK_MIN minutes, default 15; a smaller value is raised to 2 minutes,
 * Veradigm's polling rule; "off" disables it): for each configured target (PM, EHR)
 *   1. GetToken (only when the cached token is due: the probe uses the same session as the tools, so it
 *      never mints a token per probe),
 *   2. GetUserAuthentication (same rule),
 *   3. one cheap read with no patient data: UNITY_HEALTH_ACTION (default GetServerInfo).
 * Each probe gives up after UNITY_HEALTH_TIMEOUT_SEC (default 15). The result goes to SystemStatus
 * (src/platform/system-status.ts) with an error class and a scrubbed detail ("GetToken: Access is denied").
 * Successful probes are not audited (one line per probe per system would bury the audit log);
 * failed probes are audit lines (kind "action", channel "health"); status changes are security/ops events.
 * A real Veradigm call that fails with a network, timeout, auth or server error asks for an early probe.
 * Floor guard: a system is never probed when it was probed, or answered a real call, less than 2 minutes
 * ago, whatever starts the probe (start-up, interval tick or early probe).
 *
 * Keep-warm: while a phone-agent tool ran in the last UNITY_KEEP_WARM_MINUTES (default 30; 0 = off), a
 * target's session is renewed UNITY_KEEP_WARM_LEAD_SEC (default 120) before the cached token is due, so
 * the first search after a pause never waits for GetToken + GetUserAuthentication (measured up to 8.8 s
 * cold). Retell's inbound-call webhook also warms the sessions when a call starts. After a failed renewal
 * a target waits 2 minutes before the next try, doubling up to 30 minutes, back to normal after a success;
 * a target whose sign-in Veradigm refused (auth latch, unity-auth.service.ts) is skipped.
 */
export const MIN_POLL_MS = 2 * 60_000;

const num = (v: unknown, d: number, min: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : d;
};

/** Keep-warm retry delay after a failed renewal: 2 minutes, doubling up to 30. */
export const KEEP_WARM_BACKOFF_MIN_MS = MIN_POLL_MS;
export const KEEP_WARM_BACKOFF_MAX_MS = 30 * 60_000;

/** Probe interval in ms (default 15 minutes, clamped to the 2-minute floor), or 0 when UNITY_HEALTH_CHECK_MIN is off/0. */
export function healthIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env.UNITY_HEALTH_CHECK_MIN ?? '').trim();
  if (/^(off|false|no|0)$/i.test(raw)) return 0;
  return Math.max(MIN_POLL_MS, num(raw, 15, 0.01) * 60_000);
}
export const healthTimeoutMs = () => num(process.env.UNITY_HEALTH_TIMEOUT_SEC, 15, 2) * 1000;
export const healthAction = () => String(process.env.UNITY_HEALTH_ACTION || '').trim() || UnityActions.Admin.GET_SERVER_INFO;
export const keepWarmWindowMs = () => num(process.env.UNITY_KEEP_WARM_MINUTES, 30, 0) * 60_000;
export const keepWarmLeadSec = () => num(process.env.UNITY_KEEP_WARM_LEAD_SEC, 120, 10);

/** Error classes that say "the system is not answering properly" (worth an early probe). */
const INFRA = new Set(['NETWORK_ERROR', 'TIMEOUT_ERROR', 'AUTH_ERROR', 'SERVER_ERROR', 'UNKNOWN_ERROR', 'API_ERROR', 'FORBIDDEN']);

export interface ProbeResult {
  target: UnityTargetSystem;
  ok: boolean;
  error_class: string;
  detail: string;
  latency_ms: number;
}

/** Error class + short scrubbed detail for a failed probe step. No secrets: messages only, never the request. */
export function classifyProbeError(stage: string, err: unknown): { error_class: string; detail: string } {
  const e = err as any;
  const code = typeof e?.code === 'string' ? e.code : '';
  const status = Number(e?.response?.status) || 0;
  const raw = String(e?.message || err || '');
  const msg = raw.replace(/^Unity authentication failed:\s*/i, '').replace(/^User authentication failed:\s*/i, '');
  let cls = '';
  if (code === 'TIMEOUT_ERROR' || code === 'ECONNABORTED' || /time(d)? ?out/i.test(raw)) cls = 'TIMEOUT_ERROR';
  else if (code === 'NETWORK_ERROR' || /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up|unreachable/i.test(raw + code)) cls = 'NETWORK_ERROR';
  else if (code === 'AUTH_ERROR' || /authentication failed|access is denied|denied|not valid|locked|unauthori[sz]ed/i.test(raw) || status === 401 || status === 403) cls = 'AUTH_ERROR';
  else if (code === 'SERVER_ERROR' || status >= 500) cls = 'SERVER_ERROR';
  else cls = code && /^[A-Z_]+$/.test(code) ? code : 'UNITY_ERROR';
  // Mask the service username / Ubiquity prefix if Veradigm ever echoes it, plus the usual dates and numbers.
  const detail = scrubLogText(msg.replace(/[A-Za-z0-9]+\^\d+\^[^\s,;]+/g, '[account]'), 100);
  return { error_class: cls, detail: `${stage}: ${detail || cls}`.slice(0, 120) };
}

export interface HealthAuth {
  getSecurityToken(target: UnityTargetSystem): Promise<string>;
  getAuthenticatedSession(target: UnityTargetSystem): Promise<unknown>;
}
export interface HealthUnity {
  executeAction(action: string, params?: any, patientId?: string, target?: any): Promise<any>;
}

export interface HealthOptions {
  auth: HealthAuth;
  unity: HealthUnity;
  status: SystemStatus;
  targets: () => UnityTargetSystem[];
  now?: () => number;
  log?: (l: string) => void;
}

function withTimeout<T>(p: Promise<T>, ms: number, stage: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${stage} timed out after ${ms} ms`), { code: 'TIMEOUT_ERROR' })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class UnityHealthChecker {
  private lastRun = 0;
  /** Per target: when the last probe started, and when a real call last got an answer (floor guard). */
  private lastProbe = new Map<UnityTargetSystem, number>();
  private lastAnswer = new Map<UnityTargetSystem, number>();
  private running: Promise<ProbeResult[]> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly log: (l: string) => void;

  constructor(private readonly opts: HealthOptions) {
    this.now = opts.now || Date.now;
    this.log = opts.log || ((l) => console.error(l));
  }

  /** One probe of one target. Never throws. */
  async probe(target: UnityTargetSystem): Promise<ProbeResult> {
    const t0 = this.now();
    const done = (ok: boolean, c = { error_class: '', detail: '' }): ProbeResult => ({ target, ok, ...c, latency_ms: this.now() - t0 });
    const budget = healthTimeoutMs();
    let stage = 'GetToken';
    try {
      await withTimeout(this.opts.auth.getSecurityToken(target), budget, stage);
      stage = 'GetUserAuthentication';
      await withTimeout(this.opts.auth.getAuthenticatedSession(target), budget, stage);
      stage = healthAction();
      const res = await withTimeout(this.opts.unity.executeAction(stage, {}, '', target), budget, stage);
      if (res?.success) return done(true);
      return done(false, { error_class: 'UNITY_ERROR', detail: `${stage}: ${scrubLogText(res?.error, 100) || 'error reply'}` });
    } catch (e) {
      return done(false, classifyProbeError(stage, e));
    }
  }

  /** True when the target was probed, or answered a real call, less than 2 minutes ago (Veradigm polling floor). */
  private tooSoon(target: UnityTargetSystem): boolean {
    const last = Math.max(this.lastProbe.get(target) || 0, this.lastAnswer.get(target) || 0);
    return last > 0 && this.now() - last < MIN_POLL_MS;
  }

  /**
   * Probe every configured target once (single flight) and update the status. A target inside the 2-minute
   * floor is skipped (left out of the result, status unchanged). Never throws.
   */
  runOnce(): Promise<ProbeResult[]> {
    if (this.running) return this.running;
    this.lastRun = this.now();
    this.running = (async () => {
      const out: ProbeResult[] = [];
      for (const t of this.opts.targets()) {
        if (this.tooSoon(t)) continue;
        this.lastProbe.set(t, this.now());
        const r = await this.probe(t);
        out.push(r);
        this.opts.status.recordProbe(t, r.ok, r.error_class, r.detail);
        if (!r.ok) {
          auditToolCall({ server: 'unity', kind: 'action', tool: healthAction(), success: false, errorCode: r.error_class, latencyMs: r.latency_ms, channel: 'health' });
          this.log(`[Veradigm] health ${t} FAILED ${r.error_class} (${r.detail})`);
        }
      }
      await this.opts.status.tick();
      return out;
    })()
      .catch((e) => {
        this.log(`[Veradigm] health check error: ${errorSummary(e)}`);
        return [] as ProbeResult[];
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /** A real call finished: feed the status; an infrastructure failure may trigger an early probe. */
  onActionOutcome(action: string, target: UnityTargetSystem, ok: boolean, code: string): void {
    if (!this.opts.targets().includes(target)) return;
    if (ok) this.lastAnswer.set(target, this.now());
    const wantProbe = this.opts.status.recordPassive(target, ok, code);
    if (!ok && wantProbe && INFRA.has(code)) this.requestEarlyProbe();
  }

  /** Probe now unless one ran in the last 2 minutes (Veradigm polling floor). */
  requestEarlyProbe(): boolean {
    if (!healthIntervalMs() || this.running || this.now() - this.lastRun < MIN_POLL_MS) return false;
    void this.runOnce();
    return true;
  }

  /** First probe once `firstAfter` settles (the start-up GetServerInfo, so a system that just answered is skipped), then every interval. */
  start(firstAfter: Promise<unknown> = Promise.resolve()): () => void {
    const every = healthIntervalMs();
    if (!every) {
      this.log('[Veradigm] health check off (UNITY_HEALTH_CHECK_MIN)');
      return () => undefined;
    }
    void firstAfter.catch(() => undefined).then(() => this.runOnce());
    this.timer = setInterval(() => void this.runOnce(), every);
    this.timer.unref?.();
    return () => {
      if (this.timer) clearInterval(this.timer);
    };
  }
}

export interface KeepWarmAuth {
  tokenSecondsLeft(target: UnityTargetSystem): number | undefined;
  refreshSession(target: UnityTargetSystem): Promise<boolean>;
  getAuthenticatedSession(target: UnityTargetSystem): Promise<unknown>;
}

export class TokenKeepWarm {
  private lastActivity = 0;
  private busy = new Set<UnityTargetSystem>();
  /** Per target after a failed renewal: no new try before `at`; `delay` doubles per failure (2 to 30 minutes). */
  private backoff = new Map<UnityTargetSystem, { at: number; delay: number }>();
  private readonly now: () => number;
  private readonly log: (l: string) => void;
  /** Sessions renewed by keep-warm (status screen / tests). */
  refreshed = 0;

  constructor(
    private readonly auth: KeepWarmAuth,
    private readonly targets: () => UnityTargetSystem[],
    opts: { now?: () => number; log?: (l: string) => void } = {}
  ) {
    this.now = opts.now || Date.now;
    this.log = opts.log || ((l) => console.error(l));
  }

  /** A phone-agent tool ran (or a call is starting). */
  noteActivity(): void {
    this.lastActivity = this.now();
  }

  active(): boolean {
    const w = keepWarmWindowMs();
    return w > 0 && this.lastActivity > 0 && this.now() - this.lastActivity <= w;
  }

  /**
   * Renew every target whose token is missing or due within the lead time, while there is activity.
   * A target that failed recently waits out its backoff (2 minutes, doubling up to 30).
   */
  async tick(): Promise<number> {
    if (!this.active()) return 0;
    let n = 0;
    for (const t of this.targets()) {
      const left = this.auth.tokenSecondsLeft(t);
      if (left !== undefined && left > keepWarmLeadSec()) continue;
      if (this.busy.has(t)) continue;
      const wait = this.backoff.get(t);
      if (wait && this.now() < wait.at) continue;
      this.busy.add(t);
      try {
        await this.auth.refreshSession(t);
        this.backoff.delete(t);
        this.refreshed++;
        n++;
      } catch (e) {
        const delay = wait ? Math.min(wait.delay * 2, KEEP_WARM_BACKOFF_MAX_MS) : KEEP_WARM_BACKOFF_MIN_MS;
        this.backoff.set(t, { at: this.now() + delay, delay });
        this.log(`[Unity Auth] keep-warm ${t} failed (next try in ${Math.round(delay / 60_000)} min): ${errorSummary(e, 120)}`);
      } finally {
        this.busy.delete(t);
      }
    }
    return n;
  }

  /** A call is starting: make sure every target has a session (no-op when cached). Never throws. */
  async warmNow(): Promise<void> {
    this.noteActivity();
    await Promise.all(
      this.targets().map((t) =>
        this.auth.getAuthenticatedSession(t).catch((e) => this.log(`[Unity Auth] warm ${t} failed: ${errorSummary(e, 120)}`))
      )
    );
  }

  start(): () => void {
    if (keepWarmWindowMs() <= 0) return () => undefined;
    const timer = setInterval(() => void this.tick(), 30_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}
