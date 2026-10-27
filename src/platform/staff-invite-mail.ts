/**
 * Staff invitation email (Staff logins screen). Sent with the help-desk mail settings:
 *   HELPDESK_SMTP_URL     smtps://user:pass@host:465 (or smtp://...:587, upgraded with STARTTLS; TLS required and the
 *                         certificate verified, TLS 1.2 or later; no query string)
 *   HELPDESK_ALERT_FROM   sender, e.g. monitor@moatit.com
 *   DRAWBRIDGE_PUBLIC_URL https:// address staff open (the invitation link points there)
 * The message carries the link only: never a password, a code or patient data. Failures are logged by error code.
 */
import { clinicName } from './clinic';

export function inviteMailProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = String(env.HELPDESK_SMTP_URL || '').trim();
  if (!/^smtps?:\/\/\S+$/.test(url)) return 'HELPDESK_SMTP_URL is not set';
  if (/[?#]/.test(url.replace(/^smtps?:\/\/[^@/]*@/, ''))) return 'HELPDESK_SMTP_URL must not carry a query string';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(env.HELPDESK_ALERT_FROM || '').trim())) return 'HELPDESK_ALERT_FROM is not set';
  if (!/^https:\/\/[^\s/]+/.test(String(env.DRAWBRIDGE_PUBLIC_URL || '').trim())) return 'DRAWBRIDGE_PUBLIC_URL must be an https:// address';
  return null;
}

export function inviteLink(token: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${String(env.DRAWBRIDGE_PUBLIC_URL || '').trim().replace(/\/+$/, '')}/app/invite#${token}`;
}

export interface StaffInvite {
  to: string;
  name: string;
  invitedBy: string;
  token: string;
  expiresAt: number;
  reset: boolean;
}

export function inviteMessage(m: StaffInvite, env: NodeJS.ProcessEnv = process.env): { subject: string; text: string } {
  const expires = new Date(m.expiresAt).toLocaleString('en-US', {
    timeZone: env.CLINIC_TIMEZONE || 'America/Boise',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const where = clinicName();
  const text = [
    `Hello ${m.name},`,
    '',
    m.reset
      ? `${m.invitedBy} has reset your Drawbridge sign-in${where ? ` for ${where}` : ''}. Your old password and authenticator no longer work.`
      : `${m.invitedBy} has invited you to Drawbridge${where ? ` for ${where}` : ''}.`,
    '',
    `1. Open this link on a computer (it works once, until ${expires}):`,
    inviteLink(m.token, env),
    '2. Choose your password.',
    '3. Scan the QR code with an authenticator app on your phone (Microsoft Authenticator, Google Authenticator, 1Password or Authy) and enter the 6-digit code it shows.',
    '',
    `You are then signed in. Next time, sign in with ${m.to}, your password and a fresh 6-digit code.`,
    '',
    'If you did not expect this email, do not open the link and tell help@moatit.com or (208) 900-6628.',
    '',
    'Drawbridge, a MOATiT service',
  ].join('\n');
  return { subject: m.reset ? 'Your Drawbridge sign-in was reset' : 'Your Drawbridge invitation', text };
}

/** Connection settings with TLS forced on and verified (one options object). Exported for tests. */
export function transportOptions(env: NodeJS.ProcessEnv = process.env) {
  const u = new URL(String(env.HELPDESK_SMTP_URL).trim());
  const secure = u.protocol === 'smtps:';
  return {
    host: u.hostname,
    port: Number(u.port) || (secure ? 465 : 587),
    secure,
    requireTLS: true,
    ignoreTLS: false,
    auth: u.username ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } : undefined,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' as const, servername: u.hostname },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  };
}

/** Sends the invitation; false (logged by code only) when mail isn't configured or the send fails. */
export async function sendStaffInvite(m: StaffInvite, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const problem = inviteMailProblem(env);
  if (problem) {
    console.error(`[Drawbridge] staff invitation not sent: ${problem}`);
    return false;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodemailer = require('nodemailer');
    const msg = inviteMessage(m, env);
    await nodemailer.createTransport(transportOptions(env)).sendMail({ from: String(env.HELPDESK_ALERT_FROM).trim(), to: m.to, ...msg });
    return true;
  } catch (err: any) {
    const code = typeof err?.code === 'string' ? err.code.slice(0, 32) : 'ERROR';
    const stage = typeof err?.command === 'string' ? ` at ${err.command.slice(0, 16)}` : '';
    console.error(`[Drawbridge] staff invitation not sent (${code}${stage})`);
    return false;
  }
}
