import type { Request } from 'express';
import { auditToolCall, AuditServer, defaultAuditServer, safeUser } from './audit';

/**
 * Security events (HIPAA 164.308(a)(1)(ii)(D) activity review, 164.308(a)(5)(ii)(C) log-in monitoring,
 * 164.308(a)(6) incident detection, 164.404-410 breach investigation support).
 *
 * Each event is one audit line (kind "security", event name in `tool`) plus one server-log line that
 * starts with "[SECURITY]" (event, user, client IP; never a password, a typed unknown username, a
 * patient name or a document). Alert on that prefix in the log store (CloudWatch metric filter or the
 * data-center log shipper); see docs/drawbridge/HIPAA_TECHNICAL_SAFEGUARDS.md.
 *
 * Events: login_ok, login_failed, login_locked, login_ip_locked, login_password_expired,
 * login_no_totp, logout, emergency_access_login, tool_key_rejected, webhook_rejected,
 * integrity_failed, export, export_volume_alert, view_volume_alert, and the ops events system_down,
 * system_recovered (Veradigm connection status, system-status.ts), helpdesk_alert and
 * helpdesk_alert_failed (MOATiT help-desk notification sent / not sent), and the phone-agent call-binding
 * refusals (src/platform/call-binding.ts): agent_not_verified, agent_verified_limit, agent_search_limit
 * (POSSIBLE_ENUMERATION) and agent_no_call_id, each with the call ID and the tool, never a name, and the
 * Veradigm sign-in latch (unity-auth.service.ts): unity_signin_latched (Veradigm refused a login; no more
 * logins for that system, code = PM/EHR) and unity_signin_retry (an operator cleared it, with the user), and the
 * voice harness: voice_gw_rejected (a connection to the gateway link without a valid HMAC), sip_registered,
 * sip_registration_lost and sip_tls_failure (the extension's registration), srtp_refused (a call offered no SRTP).
 *
 *   DRAWBRIDGE_EXPORT_ALERT_PER_HOUR   exports (document downloads, disclosure reports) by one user in
 *                                      60 minutes before an export_volume_alert (default 20)
 *   DRAWBRIDGE_VIEW_ALERT_PER_HOUR     patient-record screens opened by one user in 60 minutes before a
 *                                      view_volume_alert (default 200)
 */
export type SecurityEvent =
  | 'login_ok'
  | 'login_failed'
  | 'login_locked'
  | 'login_ip_locked'
  | 'login_password_expired'
  | 'login_no_totp'
  | 'logout'
  | 'emergency_access_login'
  | 'tool_key_rejected'
  | 'webhook_rejected'
  | 'integrity_failed'
  | 'export'
  | 'export_volume_alert'
  | 'view_volume_alert'
  | 'system_down'
  | 'system_recovered'
  | 'helpdesk_alert'
  | 'helpdesk_alert_failed'
  | 'agent_not_verified'
  | 'agent_verified_limit'
  | 'agent_search_limit'
  | 'agent_no_call_id'
  | 'cross_site_request'
  | 'unity_signin_latched'
  | 'unity_signin_retry'
  // Drawbridge voice harness (src/platform/modules/voice): gateway link and SIP extension health
  | 'voice_gw_rejected'
  | 'sip_registered'
  | 'sip_registration_lost'
  | 'sip_tls_failure'
  | 'srtp_refused';

/** Events that are failures or alerts (success=false in the audit line, console.warn in the log). */
const ALERTS = new Set<SecurityEvent>([
  'login_failed',
  'login_locked',
  'login_ip_locked',
  'login_password_expired',
  'login_no_totp',
  'emergency_access_login',
  'tool_key_rejected',
  'webhook_rejected',
  'integrity_failed',
  'export_volume_alert',
  'view_volume_alert',
  'system_down',
  'helpdesk_alert_failed',
  'agent_not_verified',
  'agent_verified_limit',
  'agent_search_limit',
  'agent_no_call_id',
  'cross_site_request',
  'unity_signin_latched',
  'voice_gw_rejected',
  'sip_registration_lost',
  'sip_tls_failure',
  'srtp_refused',
]);

export interface SecurityDetails {
  user?: string;
  ip?: string;
  /** Short reason code (BAD_PASSWORD, BAD_TOTP, LOCKED, ...). */
  code?: string;
  /** Opaque object (path, item ID). */
  object?: string;
  patientId?: string;
  server?: AuditServer;
  channel?: string;
  /** Retell call ID (phone-agent events). */
  callId?: string;
}

/** Client IP as Express sees it (DRAWBRIDGE_TRUST_PROXY makes this the real client behind nginx). */
export function clientIp(req: Request): string {
  return String(req.ip || req.socket?.remoteAddress || '');
}

/** Write one security event to the audit log and the server log. Never throws. */
export function securityEvent(event: SecurityEvent, d: SecurityDetails = {}): void {
  try {
    const alert = ALERTS.has(event);
    auditToolCall({
      server: d.server || defaultAuditServer(),
      kind: 'security',
      tool: event,
      success: !alert,
      errorCode: alert ? d.code || event.toUpperCase() : undefined,
      latencyMs: 0,
      channel: d.channel || 'security',
      user: d.user,
      ip: d.ip,
      object: d.object,
      patientId: d.patientId,
      callId: d.callId,
    });
    const who = safeUser(d.user || '') || '-';
    const line = `[SECURITY] ${event}${d.code ? ` ${String(d.code).replace(/[^A-Za-z0-9_]/g, '').slice(0, 40)}` : ''} user=${who} ip=${String(d.ip || '-').replace(/[^A-Za-z0-9.:]/g, '').slice(0, 64) || '-'}`;
    if (alert) console.warn(line);
    else console.log(line);
  } catch {
    // never into the request path
  }
}

/**
 * The same noisy event from the same source (a scanner hitting a tool endpoint) is written at most
 * once a minute; the next line says how many were skipped (object "repeats:<n>").
 */
const lastNoisy = new Map<string, { at: number; skipped: number }>();
export function throttledSecurityEvent(event: SecurityEvent, d: SecurityDetails = {}, now: number = Date.now()): void {
  const key = `${event}|${d.ip || ''}|${d.object || ''}`;
  const seen = lastNoisy.get(key);
  if (seen && now - seen.at < 60_000) {
    seen.skipped++;
    return;
  }
  const skipped = seen?.skipped || 0;
  lastNoisy.set(key, { at: now, skipped: 0 });
  if (lastNoisy.size > 5000) lastNoisy.delete(lastNoisy.keys().next().value as string);
  securityEvent(event, skipped ? { ...d, object: `repeats:${skipped}` } : d);
}

const perHour = (name: string, d: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : d;
};
export const exportAlertPerHour = () => perHour('DRAWBRIDGE_EXPORT_ALERT_PER_HOUR', 20);
export const viewAlertPerHour = () => perHour('DRAWBRIDGE_VIEW_ALERT_PER_HOUR', 200);

/**
 * Counts one kind of access per user in a sliding 60-minute window and raises one alert event when a
 * user goes over the limit (then at most one more per window). Memory only.
 */
export class VolumeMonitor {
  private hits = new Map<string, number[]>();
  private alerted = new Map<string, number>();

  constructor(
    private readonly event: 'export_volume_alert' | 'view_volume_alert',
    private readonly limit: () => number,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Record one access by `user`. Returns true when this access raised an alert. */
  record(user: string, ip = ''): boolean {
    const u = safeUser(user) || 'unknown';
    const t = this.now();
    const list = (this.hits.get(u) || []).filter((x) => x > t - 3600_000);
    list.push(t);
    this.hits.set(u, list);
    if (this.hits.size > 5000) this.hits.delete(this.hits.keys().next().value as string);
    if (list.length <= this.limit()) return false;
    const last = this.alerted.get(u);
    if (last !== undefined && t - last < 3600_000) return false;
    this.alerted.set(u, t);
    securityEvent(this.event, { user: u, ip, code: `OVER_${this.limit()}_PER_HOUR` });
    return true;
  }
}

export const exportMonitor = new VolumeMonitor('export_volume_alert', exportAlertPerHour);
export const viewMonitor = new VolumeMonitor('view_volume_alert', viewAlertPerHour);

/** One staff export of PHI (document download, disclosure report): an audit line and the volume check. */
export function recordExport(req: Request, what: string, patientId = ''): void {
  const user = String((req as any).drawbridgeUser || '');
  securityEvent('export', { user, ip: clientIp(req), object: what, patientId });
  exportMonitor.record(user, clientIp(req));
}
