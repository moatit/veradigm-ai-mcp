import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { newTotpSecret, otpauthUrl, PASSWORD_HISTORY, passwordProblem, StaffEntry, totpMatch, USERNAME_RE, utcDay } from './staff-auth';

/**
 * Staff logins managed in the app (Staff logins screen, Drawbridge administrators only), next to the server-managed
 * users file (DRAWBRIDGE_USERS_FILE, written by `npm run staff:user`). Sign-in reads both (shell.ts staffUsers());
 * a name in the users file always wins, and an invitation can't take a name that is already there.
 *
 *   DRAWBRIDGE_STAFF_ACCOUNTS_FILE  store (default <CALL_RECORDS_DIR>/staff-accounts.json, mode 0600, written atomically)
 *
 * Invitation (by email, from the help-desk sender):
 *  - a 256-bit token, stored only as a domain-separated SHA-256, sent as https://<DRAWBRIDGE_PUBLIC_URL>/app/invite#<token>
 *    (fragment: never sent to a server, never in logs); single use; 24 hours; a new invitation replaces the old one;
 *  - step 1: the person chooses their password (same policy as staff:user, not one of their last 5); a TOTP secret is
 *    generated and shown as a QR code; nothing is active yet;
 *  - step 2: the first 6-digit code from the authenticator activates the login (password, TOTP, password date) and
 *    ends the invitation. Five wrong codes end the invitation; step 1 must be finished within 15 minutes.
 * Re-inviting an active login (lost phone, expired password) turns it off at once: its old password and TOTP stop
 * working and its sessions end (the caller revokes them). Removing a login deletes it and ends its sessions.
 * The store holds hashes only: no password, token or code in clear. Emails are the usernames.
 */

export type ManagedRole = 'staff' | 'admin';
export const INVITE_TTL_MS = 24 * 3600_000;
export const SETUP_WINDOW_MS = 15 * 60_000;
export const MAX_INVITE_ATTEMPTS = 5;
const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/;

interface Invite {
  hash: string;
  expires: number;
  attempts: number;
  /** Step 1 done: chosen password (scrypt entry) and the TOTP secret shown as a QR code, waiting for the first code. */
  pendingHash?: string;
  pendingTotp?: string;
  pendingAt?: number;
}

export interface ManagedAccount {
  name: string;
  role: ManagedRole;
  status: 'invited' | 'active';
  hash?: string;
  totp?: string;
  pwset?: string;
  hist: string[];
  invite?: Invite;
  invitedBy: string;
  invitedAt: number;
  activatedAt?: number;
}

export interface AccountView {
  user: string;
  name: string;
  role: ManagedRole;
  status: 'invited' | 'active' | 'invitation expired';
  invitedBy: string;
  invitedAt: number;
  activatedAt?: number;
  pwset?: string;
}

export const accountsFile = (): string =>
  String(process.env.DRAWBRIDGE_STAFF_ACCOUNTS_FILE || '').trim() ||
  path.join(process.env.CALL_RECORDS_DIR || path.join(process.cwd(), 'data'), 'staff-accounts.json');

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(`drawbridge-staff-invite:${token}`, 'utf8').digest('hex');
}

export function normalizeEmail(v: unknown): string | null {
  const e = String(v ?? '').trim().toLowerCase();
  return EMAIL_RE.test(e) && USERNAME_RE.test(e) ? e : null;
}

const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

export interface StaffAccountsDeps {
  file?: () => string;
  now?: () => number;
  /** scrypt entry for a new password (shell.ts scryptEntry). */
  hashPassword: (password: string) => string;
  /** Constant-time check of a password against a scrypt entry (shell.ts verifyStaffPassword). */
  verifyPassword: (entry: string, password: string) => boolean;
}

export type InviteResult = { ok: true; token: string; expiresAt: number; reinvite: boolean } | { ok: false; error: string };
export type SetupResult =
  | { ok: true; user: string; name: string; otpauth: string }
  | { ok: false; error: string; fixable?: boolean };
export type ConfirmResult = { ok: true; user: string; step: number } | { ok: false; error: string; ended?: boolean };

export const GENERIC_INVITE_ERROR =
  'This invitation link did not work. Links work once and expire after 24 hours; ask your Drawbridge administrator for a new invitation.';

export class StaffAccounts {
  private cache: { file: string; stamp: string; data: Record<string, ManagedAccount> } | null = null;
  constructor(private deps: StaffAccountsDeps) {}

  private file(): string {
    return (this.deps.file || accountsFile)();
  }
  private now(): number {
    return (this.deps.now || Date.now)();
  }

  /** Current store (re-read when the file changes on disk). A missing file is an empty store. */
  load(): Record<string, ManagedAccount> {
    const f = this.file();
    let stamp = 'none';
    try {
      const st = fs.statSync(f);
      stamp = `${st.size}:${st.mtimeMs}`;
    } catch {
      // no store yet
    }
    if (this.cache && this.cache.file === f && this.cache.stamp === stamp) return this.cache.data;
    let data: Record<string, ManagedAccount> = {};
    if (stamp !== 'none') {
      // An unreadable or corrupt store is an error, not "nobody": sign-in then refuses these logins (fail closed).
      const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
      data = parsed && typeof parsed.accounts === 'object' ? parsed.accounts : {};
    }
    this.cache = { file: f, stamp, data };
    return data;
  }

  /** File stamp, so callers can tell when the store changed. */
  stamp(): string {
    try {
      const st = fs.statSync(this.file());
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return 'none';
    }
  }

  private save(data: Record<string, ManagedAccount>): void {
    const f = this.file();
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ accounts: data }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, f);
    this.cache = null;
  }

  /** Active logins as users-file entries for sign-in (invited ones can't sign in). */
  activeEntries(): Map<string, StaffEntry> {
    const out = new Map<string, StaffEntry>();
    for (const [user, a] of Object.entries(this.load())) {
      if (a.status === 'active' && a.hash && a.totp) out.set(user, { hash: a.hash, totp: a.totp, pwset: a.pwset, hist: a.hist || [], role: a.role });
    }
    return out;
  }

  list(): AccountView[] {
    const now = this.now();
    return Object.entries(this.load())
      .map(([user, a]) => ({
        user,
        name: a.name,
        role: a.role,
        status: (a.status === 'invited' && (!a.invite || a.invite.expires <= now) ? 'invitation expired' : a.status) as AccountView['status'],
        invitedBy: a.invitedBy,
        invitedAt: a.invitedAt,
        activatedAt: a.activatedAt,
        pwset: a.pwset,
      }))
      .sort((x, y) => x.name.localeCompare(y.name));
  }

  /**
   * Invite a new person, or re-invite a managed login (which turns its current password and TOTP off at once).
   * `fileUsers` are the names in the server users file: those can't be invited here.
   */
  invite(input: { email: unknown; name: unknown; role: unknown; by: string }, fileUsers: Set<string>): InviteResult {
    const user = normalizeEmail(input.email);
    if (!user) return { ok: false, error: 'Enter a valid email address.' };
    const name = String(input.name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80);
    if (name.length < 2) return { ok: false, error: 'Enter the person’s name.' };
    const role: ManagedRole = input.role === 'admin' ? 'admin' : 'staff';
    if (fileUsers.has(user)) return { ok: false, error: 'That login is managed on the server; it can’t be invited here.' };
    const data = { ...this.load() };
    const now = this.now();
    const token = randomBytes(32).toString('base64url');
    const prev = data[user];
    data[user] = {
      name,
      role,
      status: 'invited',
      hist: prev ? [prev.hash, ...(prev.hist || [])].filter((h): h is string => !!h).slice(0, PASSWORD_HISTORY - 1) : [],
      invite: { hash: hashInviteToken(token), expires: now + INVITE_TTL_MS, attempts: 0 },
      invitedBy: input.by,
      invitedAt: now,
    };
    this.save(data);
    return { ok: true, token, expiresAt: now + INVITE_TTL_MS, reinvite: !!prev };
  }

  remove(user: string): boolean {
    const data = { ...this.load() };
    const key = String(user || '').toLowerCase();
    if (!data[key]) return false;
    delete data[key];
    this.save(data);
    return true;
  }

  private findByToken(token: unknown): [string, ManagedAccount] | null {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const h = hashInviteToken(token);
    const now = this.now();
    for (const [user, a] of Object.entries(this.load())) {
      if (a.status === 'invited' && a.invite && a.invite.expires > now && sameHash(a.invite.hash, h)) return [user, a];
    }
    return null;
  }

  /** Name of the person a valid link is for (to greet them), or null. */
  peek(token: unknown): { user: string; name: string } | null {
    const hit = this.findByToken(token);
    return hit ? { user: hit[0], name: hit[1].name } : null;
  }

  /** Step 1: chosen password. Returns the authenticator link to show as a QR code. Nothing is active yet. */
  setPassword(token: unknown, password: unknown, confirm: unknown): SetupResult {
    const hit = this.findByToken(token);
    if (!hit) return { ok: false, error: GENERIC_INVITE_ERROR };
    const [user, a] = hit;
    const pw = String(password ?? '');
    if (pw !== String(confirm ?? '')) return { ok: false, error: 'The two passwords do not match.', fixable: true };
    const problem = passwordProblem(user, pw);
    if (problem) return { ok: false, error: `Choose a different password: ${problem}.`, fixable: true };
    if ((a.hist || []).some((h) => this.deps.verifyPassword(h, pw))) {
      return { ok: false, error: 'Choose a password you have not used for this login before.', fixable: true };
    }
    const data = { ...this.load() };
    const secret = newTotpSecret();
    data[user] = { ...a, invite: { ...a.invite!, pendingHash: this.deps.hashPassword(pw), pendingTotp: secret, pendingAt: this.now() } };
    this.save(data);
    return { ok: true, user, name: a.name, otpauth: otpauthUrl(user, secret) };
  }

  /** Authenticator link to show again (a wrong first code), while step 1 is done and within the setup window. */
  pendingOtpauth(token: unknown, now: number = this.now()): string | null {
    const hit = this.findByToken(token);
    const inv = hit?.[1].invite;
    if (!hit || !inv?.pendingTotp || !inv.pendingAt || now - inv.pendingAt > SETUP_WINDOW_MS) return null;
    return otpauthUrl(hit[0], inv.pendingTotp);
  }

  /** Step 2: the first code from the authenticator activates the login and ends the invitation. */
  confirm(token: unknown, code: unknown): ConfirmResult {
    const hit = this.findByToken(token);
    if (!hit) return { ok: false, error: GENERIC_INVITE_ERROR, ended: true };
    const [user, a] = hit;
    const inv = a.invite!;
    const now = this.now();
    if (!inv.pendingHash || !inv.pendingTotp || !inv.pendingAt || now - inv.pendingAt > SETUP_WINDOW_MS) {
      return { ok: false, error: 'Setup timed out. Open your invitation link again to start over.', ended: false };
    }
    const step = totpMatch(inv.pendingTotp, String(code ?? '').replace(/\s+/g, ''), now);
    const data = { ...this.load() };
    if (step < 0) {
      const attempts = inv.attempts + 1;
      if (attempts >= MAX_INVITE_ATTEMPTS) {
        data[user] = { ...a, invite: undefined };
        this.save(data);
        return { ok: false, error: 'Too many wrong codes: this invitation has ended. Ask your Drawbridge administrator for a new one.', ended: true };
      }
      data[user] = { ...a, invite: { ...inv, attempts } };
      this.save(data);
      return { ok: false, error: 'That code did not work. Check that your phone’s time is set automatically and enter the current code.' };
    }
    data[user] = {
      name: a.name,
      role: a.role,
      status: 'active',
      hash: inv.pendingHash,
      totp: inv.pendingTotp,
      pwset: utcDay(now),
      hist: a.hist || [],
      invitedBy: a.invitedBy,
      invitedAt: a.invitedAt,
      activatedAt: now,
    };
    this.save(data);
    return { ok: true, user, step };
  }
}
