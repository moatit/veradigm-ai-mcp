import * as fs from 'fs';
import * as path from 'path';
import { AlertInput, AlertKind, HelpdeskNotifier } from './helpdesk';
import { securityEvent } from './security-events';
import { errorSummary } from '../utils/safe-log';

/**
 * System status of the Veradigm connection (Veradigm® PM and Veradigm® EHR through Unity), for the staff
 * dashboard, the phone agent and the MOATiT help desk.
 *
 * - Each configured target (PM, EHR) is a component: up / down / unknown. The health checker
 *   (src/unity/services/unity-health.ts) reports probe results; a component goes DOWN after
 *   UNITY_HEALTH_FAILS_TO_DOWN consecutive failed probes (default 2) and UP after one good probe or one
 *   successful real Veradigm call. Real-call failures never flip a component by themselves; they only
 *   ask for an early probe.
 * - Overall: up (all up), degraded (some down), down (all down), unknown (nothing checked yet).
 *   While overall is DOWN the phone agent's Veradigm tools answer RECORDS_UNAVAILABLE at once
 *   (UNITY_FAIL_FAST_WHEN_DOWN, default on) so callers don't wait through timeouts.
 * - Help desk (helpdesk.ts), de-duplicated: one alert when overall leaves UP, a reminder every
 *   HELPDESK_REMINDER_HOURS (default 4) while it stays down or degraded, one alert when it recovers. A
 *   failed send is retried at the next status check (at most every 5 minutes).
 * - Every transition and every alert is a security/ops event in the audit log (system_down,
 *   system_recovered, helpdesk_alert, helpdesk_alert_failed). No PHI anywhere in this file.
 * - State is kept in <CALL_RECORDS_DIR>/system-status.json (mode 0600) so a restart neither forgets an
 *   outage nor sends the down alert twice.
 */
export type ComponentState = 'up' | 'down' | 'unknown';
export type OverallState = 'up' | 'degraded' | 'down' | 'unknown';

export interface ComponentStatus {
  target: string;
  state: ComponentState;
  since: string;
  last_ok_at: string;
  last_probe_at: string;
  last_error_class: string;
  last_error_detail: string;
  last_error_at: string;
  consecutive_failures: number;
}

export interface OutageInfo {
  started_at: string;
  messages_taken: number;
  down_alerted: boolean;
  last_alert_at: string;
  last_attempt_at: string;
  alerts_sent: number;
}

export interface StatusEvent {
  at: string;
  event: string;
  detail: string;
}

export interface StatusSnapshot {
  system: string;
  overall: OverallState;
  overall_since: string;
  components: ComponentStatus[];
  outage: OutageInfo | null;
  history: StatusEvent[];
  helpdesk_configured: boolean;
}

const COMPONENT_LABEL: Record<string, string> = { PM: 'Veradigm PM', EHR: 'Veradigm EHR' };
const SYSTEM = 'Veradigm Unity (Veradigm EHR/PM)';
const HISTORY_MAX = 50;
const RETRY_MS = 5 * 60_000;

const clip = (v: unknown, max: number) =>
  String(v ?? '')
    .replace(/[^ -~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const num = (v: unknown, d: number, min: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : d;
};
export const failsToDown = () => Math.floor(num(process.env.UNITY_HEALTH_FAILS_TO_DOWN, 2, 1));
export const reminderMs = () => num(process.env.HELPDESK_REMINDER_HOURS, 4, 0.25) * 3_600_000;
export const failFastWhenDown = () => !/^(0|false|off|no)$/i.test(String(process.env.UNITY_FAIL_FAST_WHEN_DOWN || '').trim());

export interface SystemStatusOptions {
  targets: () => string[];
  notifier?: HelpdeskNotifier;
  now?: () => number;
  /** Directory for system-status.json (default CALL_RECORDS_DIR, else ./data). Empty string: memory only. */
  dir?: string;
  log?: (line: string) => void;
  /** Audit/security hook (tests). */
  event?: (name: 'system_down' | 'system_recovered' | 'helpdesk_alert' | 'helpdesk_alert_failed', code: string, object: string) => void;
}

interface Persisted {
  components: Record<string, ComponentStatus>;
  overall: OverallState;
  overall_since: string;
  outage: OutageInfo | null;
  history: StatusEvent[];
}

export class SystemStatus {
  private state: Persisted;
  private readonly now: () => number;
  private readonly log: (l: string) => void;
  private readonly notifier: HelpdeskNotifier;
  private sending: Promise<void> | null = null;

  constructor(private readonly opts: SystemStatusOptions) {
    this.now = opts.now || Date.now;
    this.log = opts.log || ((l) => console.warn(l));
    this.notifier = opts.notifier || new HelpdeskNotifier();
    this.state = this.load();
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private file(): string {
    const dir = this.opts.dir ?? (process.env.CALL_RECORDS_DIR || path.join(process.cwd(), 'data'));
    return dir ? path.join(dir, 'system-status.json') : '';
  }

  private load(): Persisted {
    const empty: Persisted = { components: {}, overall: 'unknown', overall_since: '', outage: null, history: [] };
    const f = this.file();
    if (!f) return empty;
    try {
      const s = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (s && typeof s === 'object' && s.components) return { ...empty, ...s, history: Array.isArray(s.history) ? s.history.slice(-HISTORY_MAX) : [] };
    } catch {
      // first start
    }
    return empty;
  }

  private save(): void {
    const f = this.file();
    if (!f) return;
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, f);
    } catch (e) {
      this.log(`[Drawbridge] system status not saved: ${errorSummary(e)}`);
    }
  }

  private emit(name: 'system_down' | 'system_recovered' | 'helpdesk_alert' | 'helpdesk_alert_failed', code: string, object = 'veradigm_unity'): void {
    try {
      if (this.opts.event) this.opts.event(name, code, object);
      else securityEvent(name, { code, object, channel: 'system_status' });
    } catch {
      // never into the caller
    }
  }

  private history(event: string, detail: string): void {
    this.state.history.push({ at: this.iso(), event, detail: clip(detail, 200) });
    if (this.state.history.length > HISTORY_MAX) this.state.history.splice(0, this.state.history.length - HISTORY_MAX);
  }

  private component(target: string): ComponentStatus {
    let c = this.state.components[target];
    if (!c) {
      c = { target, state: 'unknown', since: '', last_ok_at: '', last_probe_at: '', last_error_class: '', last_error_detail: '', last_error_at: '', consecutive_failures: 0 };
      this.state.components[target] = c;
    }
    return c;
  }

  private setState(c: ComponentStatus, s: ComponentState): void {
    if (c.state === s) return;
    const was = c.state;
    c.state = s;
    c.since = this.iso();
    if (was !== 'unknown' || s === 'down') {
      this.history(`${COMPONENT_LABEL[c.target] || c.target} ${s.toUpperCase()}`, s === 'down' ? `${c.last_error_class} ${c.last_error_detail}`.trim() : '');
    }
  }

  /** One health-probe result for a target. */
  recordProbe(target: string, ok: boolean, errorClass = '', detail = ''): void {
    const c = this.component(target);
    c.last_probe_at = this.iso();
    if (ok) {
      c.consecutive_failures = 0;
      c.last_ok_at = this.iso();
      this.setState(c, 'up');
    } else {
      c.consecutive_failures++;
      c.last_error_class = clip(errorClass || 'UNKNOWN_ERROR', 40);
      c.last_error_detail = clip(detail, 120);
      c.last_error_at = this.iso();
      if (c.consecutive_failures >= failsToDown()) this.setState(c, 'down');
    }
    this.recompute();
  }

  /**
   * A real Veradigm call finished. Success brings a DOWN (or not yet checked) component UP at once (the
   * health probe skips a system that answered in the last 2 minutes); a failure records the error class
   * (no detail: real calls carry patient context) and returns true when an early probe is worth running.
   */
  recordPassive(target: string, ok: boolean, errorClass = ''): boolean {
    const c = this.component(target);
    if (ok) {
      const changed = c.state !== 'up';
      c.last_ok_at = this.iso();
      c.consecutive_failures = 0;
      if (changed) {
        this.setState(c, 'up');
        this.recompute();
      }
      return false;
    }
    c.last_error_class = clip(errorClass || 'UNKNOWN_ERROR', 40);
    c.last_error_at = this.iso();
    return true;
  }

  private overallFrom(): OverallState {
    const targets = this.opts.targets();
    if (!targets.length) return 'unknown';
    const states = targets.map((t) => this.component(t).state);
    if (states.every((s) => s === 'down')) return 'down';
    if (states.some((s) => s === 'down')) return 'degraded';
    if (states.every((s) => s === 'up')) return 'up';
    return this.state.overall === 'up' ? 'up' : 'unknown';
  }

  private recompute(): void {
    const prev = this.state.overall;
    const next = this.overallFrom();
    if (next !== prev) {
      this.state.overall = next;
      this.state.overall_since = this.iso();
      const bad = (s: OverallState) => s === 'down' || s === 'degraded';
      if (bad(next) && !bad(prev)) {
        const since = this.downComponents().map((c) => c.since).sort()[0] || this.iso();
        this.state.outage = { started_at: since, messages_taken: 0, down_alerted: false, last_alert_at: '', last_attempt_at: '', alerts_sent: 0 };
        const cls = this.downComponents()[0]?.last_error_class || 'UNKNOWN_ERROR';
        this.history(`Overall ${next.toUpperCase()}`, this.headline());
        this.emit('system_down', cls);
        this.log(`[SYSTEM] ${SYSTEM} ${next.toUpperCase()}: ${this.headline()}`);
        this.save();
        void this.deliver('down');
        return;
      }
      if (next === 'up' && bad(prev)) {
        const outage = this.state.outage;
        this.history('Overall UP', outage ? `down ${this.minutesSince(outage.started_at)} min, ${outage.messages_taken} message(s) taken` : '');
        this.emit('system_recovered', 'RECOVERED');
        this.log(`[SYSTEM] ${SYSTEM} recovered`);
        this.save();
        if (outage?.down_alerted) void this.deliver('recovered', outage);
        this.state.outage = null;
        this.save();
        return;
      }
      if (bad(next) && bad(prev)) this.history(`Overall ${next.toUpperCase()}`, this.headline());
    }
    this.save();
  }

  private minutesSince(iso: string): number {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? Math.max(0, Math.round((this.now() - t) / 60_000)) : 0;
  }

  private downComponents(): ComponentStatus[] {
    return this.opts.targets().map((t) => this.component(t)).filter((c) => c.state === 'down');
  }

  /** "Veradigm PM: DOWN since ... (AUTH_ERROR: GetToken: Access is denied)" style one-liner, no PHI. */
  headline(): string {
    const down = this.downComponents();
    if (!down.length) return this.state.overall === 'up' ? 'All Veradigm systems answering' : 'Not checked yet';
    return down
      .map((c) => `${COMPONENT_LABEL[c.target] || c.target} down (${c.last_error_class}${c.last_error_detail ? `: ${c.last_error_detail}` : ''})`)
      .join('; ');
  }

  /** The phone agent took a message while records were unreachable. Returns the outage's count. */
  noteMessageTaken(): number {
    if (!this.state.outage) return 0;
    this.state.outage.messages_taken++;
    this.save();
    return this.state.outage.messages_taken;
  }

  isDown(): boolean {
    return this.state.overall === 'down';
  }

  overall(): OverallState {
    return this.state.overall;
  }

  /** Reminders and retries of failed alerts. Call after each health check. Never throws. */
  async tick(): Promise<void> {
    const o = this.state.outage;
    if (!o || this.state.overall === 'up') return;
    const now = this.now();
    if (!o.down_alerted) {
      if (!o.last_attempt_at || now - Date.parse(o.last_attempt_at) >= RETRY_MS) await this.deliver('down');
      return;
    }
    if (o.last_alert_at && now - Date.parse(o.last_alert_at) >= reminderMs()) await this.deliver('reminder');
  }

  private alertInput(kind: AlertKind, outage: OutageInfo | null): AlertInput {
    return {
      kind,
      system: SYSTEM,
      overall: this.state.overall,
      since: outage?.started_at || this.state.overall_since,
      components: this.opts.targets().map((t) => {
        const c = this.component(t);
        return {
          name: COMPONENT_LABEL[t] || t,
          state: c.state,
          since: c.since,
          error_class: c.state === 'up' ? '' : c.last_error_class,
          error_detail: c.state === 'up' ? '' : c.last_error_detail,
          last_ok_at: c.last_ok_at,
        };
      }),
      messages_taken: outage?.messages_taken || 0,
      duration_min: kind === 'recovered' && outage ? this.minutesSince(outage.started_at) : undefined,
      at: this.iso(),
    };
  }

  /** Send one alert (serialised: never two at once). Records the outcome on the outage and as an event. */
  private deliver(kind: AlertKind, outageForRecovery?: OutageInfo): Promise<void> {
    const run = async () => {
      const outage = kind === 'recovered' ? outageForRecovery || null : this.state.outage;
      if (kind !== 'recovered' && (!outage || this.state.overall === 'up')) return;
      if (kind === 'down' && outage?.down_alerted) return;
      const res = await this.notifier.send(this.alertInput(kind, outage));
      const at = this.iso();
      if (outage && kind !== 'recovered') outage.last_attempt_at = at;
      if (res.ok) {
        if (outage && kind !== 'recovered') {
          outage.down_alerted = true;
          outage.last_alert_at = at;
          outage.alerts_sent++;
        }
        this.history(`Help desk notified (${kind})`, res.sent.join(', '));
        this.emit('helpdesk_alert', kind.toUpperCase(), `helpdesk:${res.sent.join('+')}`);
      } else {
        const code = res.failed.map((f) => f.code).join('+') || 'SEND_FAILED';
        this.history(`Help desk alert NOT sent (${kind})`, code);
        this.emit('helpdesk_alert_failed', code, `helpdesk:${kind}`);
      }
      this.save();
    };
    const p = (this.sending || Promise.resolve()).then(run, run).catch((e) => this.log(`[Drawbridge] help-desk alert error: ${errorSummary(e)}`));
    this.sending = p.finally(() => {
      if (this.sending === p) this.sending = null;
    });
    return p;
  }

  /** Resolves when queued alerts are done (tests, shutdown). */
  flush(): Promise<void> {
    return this.sending || Promise.resolve();
  }

  snapshot(): StatusSnapshot {
    return {
      system: SYSTEM,
      overall: this.state.overall,
      overall_since: this.state.overall_since,
      components: this.opts.targets().map((t) => ({ ...this.component(t) })),
      outage: this.state.outage ? { ...this.state.outage } : null,
      history: [...this.state.history].reverse(),
      helpdesk_configured: this.notifier.configured(),
    };
  }

  /** Values for the phone agent at call start (Retell dynamic variable records_status). */
  agentStatus(): 'UP' | 'DOWN' | 'DEGRADED' | 'UNKNOWN' {
    const o = this.state.overall;
    return o === 'up' ? 'UP' : o === 'down' ? 'DOWN' : o === 'degraded' ? 'DEGRADED' : 'UNKNOWN';
  }
}

let current: SystemStatus | null = null;
/** The running server's status (null where nothing connects to Veradigm). */
export function getSystemStatus(): SystemStatus | null {
  return current;
}
export function setSystemStatus(s: SystemStatus | null): void {
  current = s;
}
