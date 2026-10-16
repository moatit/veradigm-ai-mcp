import { createHmac } from 'crypto';
import { clinicLabel } from './clinic';
import { errorSummary } from '../utils/safe-log';

/**
 * Help-desk notifications for system status changes (Veradigm connection down / still down / recovered).
 *
 * Transports (any combination; with none configured nothing is sent and the status screen says so):
 *   HELPDESK_SMTP_URL        SMTP server as a URL: smtps://user:pass@host:465 or smtp://user:pass@host:587
 *                            (STARTTLS is required on smtp://). A secret: .env / AWS SSM only.
 *   HELPDESK_ALERT_TO        recipients, comma-separated (default help@moatit.com)
 *   HELPDESK_ALERT_FROM      sender address (default drawbridge-alerts@moatit.com)
 *   HELPDESK_WEBHOOK_URL     https URL of a ticketing / chat webhook; receives a JSON POST
 *   HELPDESK_WEBHOOK_SECRET  optional: adds x-drawbridge-signature: sha256=<HMAC-SHA256 of the body>
 *   DRAWBRIDGE_PUBLIC_URL    optional: base URL for the "open the status screen" link
 *
 * An alert never carries patient information: system name, status, times, error class, a scrubbed
 * Veradigm error detail (from a health probe, which uses no patient data) and the number of messages
 * the phone agent took while the system was down. Never names, dates of birth, phone numbers or IDs.
 */
export type AlertKind = 'down' | 'reminder' | 'recovered';

export interface AlertComponent {
  name: string;
  state: string;
  since: string;
  error_class: string;
  error_detail: string;
  last_ok_at: string;
}

export interface AlertInput {
  kind: AlertKind;
  system: string;
  overall: string;
  since: string;
  components: AlertComponent[];
  messages_taken: number;
  /** Outage length in minutes (recovered alerts). */
  duration_min?: number;
  at: string;
}

export interface AlertMessage {
  subject: string;
  text: string;
  json: Record<string, unknown>;
}

export interface AlertTransport {
  name: string;
  send(msg: AlertMessage): Promise<void>;
}

export interface SendResult {
  ok: boolean;
  sent: string[];
  failed: Array<{ transport: string; code: string }>;
}

const tz = () => process.env.CLINIC_TIMEZONE || 'America/Boise';

/** "Oct 15, 2:02 PM MDT" in the clinic's time zone. */
export function clinicTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz(),
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
}

const oneLine = (v: unknown, max: number) =>
  String(v ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^ -~]/g, '')
    .trim()
    .slice(0, max);

export function buildAlert(a: AlertInput): AlertMessage {
  const clinic = clinicLabel();
  const label = a.kind === 'recovered' ? 'RECOVERED' : a.overall.toUpperCase();
  const head =
    a.kind === 'recovered'
      ? `${a.system} RECOVERED${a.duration_min !== undefined ? ` after ${a.duration_min} min` : ''}`
      : `${a.system} ${label} since ${clinicTime(a.since)}${a.kind === 'reminder' ? ' (reminder: still down)' : ''}`;
  const subject = oneLine(`[Drawbridge] ${clinic}: ${head}`, 200);
  const base = String(process.env.DRAWBRIDGE_PUBLIC_URL || '').replace(/\/+$/, '');
  const link = base ? `${base}/app/veradigm` : '';
  const lines = [
    `Clinic: ${clinic}`,
    `System: ${a.system}`,
    `Status: ${label}${a.kind === 'recovered' ? '' : ` since ${clinicTime(a.since)}`}`,
    ...a.components.map(
      (c) =>
        `- ${c.name}: ${c.state.toUpperCase()}` +
        (c.state !== 'up' && c.since ? ` since ${clinicTime(c.since)}` : '') +
        (c.error_class ? `; last error ${c.error_class}${c.error_detail ? ` (${c.error_detail})` : ''}` : '') +
        (c.last_ok_at ? `; last OK ${clinicTime(c.last_ok_at)}` : '')
    ),
    `Messages the phone agent took while the system was down: ${a.messages_taken}`,
    a.kind === 'recovered'
      ? 'The phone agent is using the records system again. Staff should return the calls from the messages in the on-call notebook.'
      : 'The phone agent tells callers it cannot reach the records system and takes a message or transfers to staff.',
    link ? `Status screen: ${link}` : '',
    'No patient information is included in this alert.',
    `Sent ${clinicTime(a.at)} by Drawbridge.`,
  ].filter(Boolean);
  return {
    subject,
    text: lines.map((l) => oneLine(l, 400)).join('\n'),
    json: {
      source: 'drawbridge',
      event: `system_${a.kind === 'down' ? 'down' : a.kind}`,
      clinic,
      system: a.system,
      status: a.kind === 'recovered' ? 'up' : a.overall,
      since: a.since,
      duration_min: a.duration_min ?? null,
      components: a.components.map((c) => ({ ...c, error_detail: oneLine(c.error_detail, 160) })),
      messages_taken: a.messages_taken,
      status_url: link || null,
      sent_at: a.at,
      phi: false,
    },
  };
}

// ── Transports ──────────────────────────────────────────────────────────────

export function smtpTransport(url: string, to: string[], from: string): AlertTransport {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodemailer = require('nodemailer');
  const u = new URL(url);
  const secure = u.protocol === 'smtps:';
  if (!secure && u.protocol !== 'smtp:') throw new Error('HELPDESK_SMTP_URL must be smtp:// or smtps://');
  const transporter = nodemailer.createTransport({
    host: u.hostname,
    port: Number(u.port) || (secure ? 465 : 587),
    secure,
    ...(u.username ? { auth: { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } } : {}),
    // smtp:// must upgrade with STARTTLS: never send the alert or the SMTP password in clear text.
    ...(secure ? {} : { requireTLS: true }),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    ...(process.env.HELPDESK_SMTP_ALLOW_SELF_SIGNED === 'test-only' ? { tls: { rejectUnauthorized: false } } : {}),
  });
  return {
    name: 'smtp',
    async send(msg) {
      await transporter.sendMail({ from, to: to.join(', '), subject: msg.subject, text: msg.text });
    },
  };
}

export function webhookTransport(url: string, secret = ''): AlertTransport {
  return {
    name: 'webhook',
    async send(msg) {
      const body = JSON.stringify(msg.json);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (secret) headers['x-drawbridge-signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 10_000);
      try {
        const res = await fetch(url, { method: 'POST', headers, body, signal: ctl.signal });
        if (!res.ok) throw Object.assign(new Error(`webhook answered HTTP ${res.status}`), { code: `HTTP_${res.status}` });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

const list = (v: string | undefined, d: string) =>
  String(v || d)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** The transports configured in the environment (none when nothing is set). */
export function transportsFromEnv(env: NodeJS.ProcessEnv = process.env): AlertTransport[] {
  const out: AlertTransport[] = [];
  const smtp = String(env.HELPDESK_SMTP_URL || '').trim();
  if (smtp) out.push(smtpTransport(smtp, list(env.HELPDESK_ALERT_TO, 'help@moatit.com'), String(env.HELPDESK_ALERT_FROM || 'drawbridge-alerts@moatit.com').trim()));
  const hook = String(env.HELPDESK_WEBHOOK_URL || '').trim();
  if (hook) {
    if (!/^https:\/\//i.test(hook) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(hook)) {
      console.warn('[Drawbridge] HELPDESK_WEBHOOK_URL must be https (ignored)');
    } else out.push(webhookTransport(hook, String(env.HELPDESK_WEBHOOK_SECRET || '')));
  }
  return out;
}

/** Recipients and transport names for the status screen (never the SMTP URL: it holds a password). */
export function helpdeskSummary(env: NodeJS.ProcessEnv = process.env): { transports: string[]; to: string } {
  const transports: string[] = [];
  if (String(env.HELPDESK_SMTP_URL || '').trim()) transports.push('e-mail');
  if (String(env.HELPDESK_WEBHOOK_URL || '').trim()) transports.push('webhook');
  return { transports, to: list(env.HELPDESK_ALERT_TO, 'help@moatit.com').join(', ') };
}

export class HelpdeskNotifier {
  constructor(private readonly transports: () => AlertTransport[] = (() => {
    let cached: AlertTransport[] | null = null;
    return () => (cached ??= transportsFromEnv());
  })()) {}

  configured(): boolean {
    return this.transports().length > 0;
  }

  /** Send one alert on every transport. Never throws. */
  async send(input: AlertInput): Promise<SendResult> {
    const msg = buildAlert(input);
    const result: SendResult = { ok: false, sent: [], failed: [] };
    const ts = this.transports();
    if (!ts.length) {
      result.failed.push({ transport: 'none', code: 'NO_TRANSPORT' });
      return result;
    }
    for (const t of ts) {
      try {
        await t.send(msg);
        result.sent.push(t.name);
      } catch (e: any) {
        const code = String(e?.code || e?.responseCode || 'SEND_FAILED').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'SEND_FAILED';
        result.failed.push({ transport: t.name, code });
        console.warn(`[Drawbridge] help-desk alert via ${t.name} failed: ${errorSummary(e, 120)}`);
      }
    }
    result.ok = result.sent.length > 0;
    return result;
  }
}
