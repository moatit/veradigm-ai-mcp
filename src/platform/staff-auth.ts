import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Staff login safeguards used by the app shell (shell.ts):
 *  - LoginThrottle: brute-force lockout per username and per client IP
 *  - passwordProblem(): password policy for new staff logins (npm run staff:user)
 *  - TOTP (RFC 6238) for named staff who opted in (users file `:totp=<base32>`)
 *  - SessionRevocations: per-user "sessions valid after" time, so logout, removal from the users
 *    file and a password change end every existing session cookie of that user
 *
 *   DRAWBRIDGE_LOGIN_MAX_FAILS      failed sign-ins per username before it is locked (default 5)
 *   DRAWBRIDGE_LOGIN_WINDOW_MIN     window for counting failures and lock length, minutes (default 15)
 *   DRAWBRIDGE_LOGIN_IP_MAX_FAILS   failed sign-ins per client IP in the window before that IP is locked (default 30;
 *                                   behind a proxy set DRAWBRIDGE_TRUST_PROXY, or every client shares one IP)
 *   DRAWBRIDGE_SESSIONS_FILE        revocation list (default <CALL_RECORDS_DIR>/staff-sessions.json, mode 0600)
 */
const int = (v: unknown, d: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : d;
};
export const loginMaxFails = () => int(process.env.DRAWBRIDGE_LOGIN_MAX_FAILS, 5, 1, 100);
export const loginWindowMs = () => int(process.env.DRAWBRIDGE_LOGIN_WINDOW_MIN, 15, 1, 24 * 60) * 60_000;
export const loginIpMaxFails = () => int(process.env.DRAWBRIDGE_LOGIN_IP_MAX_FAILS, 30, 1, 100_000);

// ---------------------------------------------------------------------------
// Brute-force lockout
// ---------------------------------------------------------------------------

const MAX_KEYS = 10_000;

/**
 * Failed sign-ins per username (any name typed, existing or not, so a lock says nothing about
 * whether the user exists) and per client IP. A key with too many failures inside the window is
 * locked for the window length; while locked, even the right password is refused with the same
 * generic message. Memory only: a restart clears it.
 */
export class LoginThrottle {
  private fails = new Map<string, number[]>();
  private locked = new Map<string, number>();

  constructor(private now: () => number = () => Date.now()) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - loginWindowMs();
    const list = (this.fails.get(key) || []).filter((t) => t > cutoff);
    if (list.length) this.fails.set(key, list);
    else this.fails.delete(key);
    return list;
  }

  private isLocked(key: string): boolean {
    const until = this.locked.get(key);
    if (!until) return false;
    if (until > this.now()) return true;
    this.locked.delete(key);
    return false;
  }

  /** True when this username or this IP is locked right now. */
  blocked(user: string, ip: string): boolean {
    return this.isLocked(`u:${user.toLowerCase()}`) || (!!ip && this.isLocked(`ip:${ip}`));
  }

  /** Record a failed sign-in. Returns what got locked by this failure (for the server log). */
  fail(user: string, ip: string): { user: boolean; ip: boolean } {
    const out = { user: false, ip: false };
    const add = (key: string, max: number): boolean => {
      const list = this.recent(key);
      list.push(this.now());
      this.fails.set(key, list);
      if (list.length >= max && !this.isLocked(key)) {
        this.locked.set(key, this.now() + loginWindowMs());
        this.fails.delete(key);
        return true;
      }
      return false;
    };
    out.user = add(`u:${user.toLowerCase()}`, loginMaxFails());
    if (ip) out.ip = add(`ip:${ip}`, loginIpMaxFails());
    this.trim();
    return out;
  }

  /** A successful sign-in clears that username's failures (not the IP's). */
  success(user: string): void {
    this.fails.delete(`u:${user.toLowerCase()}`);
  }

  private trim(): void {
    for (const m of [this.fails, this.locked] as Map<string, unknown>[]) {
      while (m.size > MAX_KEYS) m.delete(m.keys().next().value as string);
    }
  }
}

// ---------------------------------------------------------------------------
// Password policy
// ---------------------------------------------------------------------------

/** Words that make up most leaked passwords (after lower-casing, de-leeting and trimming digits/symbols). */
const COMMON = new Set([
  'password', 'passwords', 'passwd', 'welcome', 'letmein', 'qwerty', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'admin',
  'administrator', 'iloveyou', 'changeme', 'default', 'secret', 'login', 'master', 'monkey', 'dragon', 'sunshine',
  'princess', 'football', 'baseball', 'basketball', 'soccer', 'hockey', 'superman', 'batman', 'starwars', 'trustno',
  'shadow', 'michael', 'jennifer', 'jordan', 'summer', 'winter', 'spring', 'autumn', 'january', 'february', 'march',
  'april', 'october', 'november', 'december', 'computer', 'internet', 'whatever', 'freedom', 'flower', 'hello',
  'helloworld', 'abc', 'abcdef', 'abcdefg', 'test', 'testing', 'guest', 'user', 'doctor', 'nurse', 'hospital', 'clinic',
  'kidney', 'health', 'healthcare', 'medical', 'patient', 'veradigm', 'allscripts', 'drawbridge', 'moatit', 'idaho',
  'boise', 'company', 'office', 'access', 'security', 'temp', 'temporary', 'newpassword', 'mypassword', 'yourpassword',
]);
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i' };
const SEQUENCES = ['01234567890123456789', '98765432109876543210', 'abcdefghijklmnopqrstuvwxyz', 'zyxwvutsrqponmlkjihgfedcba', 'qwertyuiopasdfghjklzxcvbnm'];

/** Why a new staff password is not acceptable, or null when it is. */
export function passwordProblem(username: string, password: string): string | null {
  if (typeof password !== 'string' || password.length < 12) return 'at least 12 characters';
  if (password.length > 256) return 'at most 256 characters';
  const lower = password.toLowerCase();
  const compact = lower.replace(/\s+/g, '');
  if (/^(.)\1+$/.test(compact) || new Set(compact).size < 4) return 'too simple (use more different characters)';
  if (SEQUENCES.some((s) => s.includes(compact))) return 'too simple (a keyboard or number sequence)';
  const user = String(username || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (user.length >= 3 && compact.replace(/[^a-z0-9]/g, '').includes(user)) return 'must not contain the username';
  // "Password2026!", "P@ssw0rd!!", "Welcome123456", "summer2026summer": common word plus digits/symbols
  const core = compact
    .replace(/[^a-z0-9@$!]/g, '')
    .replace(/[0-9@$!]+$/g, '')
    .replace(/^[0-9@$!]+/g, '');
  const deleet = core.replace(/[013457@$!]/g, (c) => LEET[c] || c);
  const halves = (s: string) => (s.length % 2 === 0 && s.slice(0, s.length / 2) === s.slice(s.length / 2) ? s.slice(0, s.length / 2) : s);
  const stripped = (s: string) => s.replace(/\d+/g, '');
  for (const c of new Set([core, deleet, halves(deleet), stripped(core), halves(stripped(core)), stripped(deleet), halves(stripped(deleet))])) {
    if (COMMON.has(c)) return 'too common (pick a passphrase of unrelated words)';
  }
  if (/^\d+$/.test(compact)) return 'too simple (digits only)';
  return null;
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238, SHA-1, 6 digits, 30 s) for named staff who opted in
// ---------------------------------------------------------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** New random TOTP secret (160 bits, base32). */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The 6-digit code for one 30-second step. */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

/** Step the code matches (current ±1 for clock drift), or -1. Constant-time compare per step. */
export function totpMatch(secret: string, code: string, nowMs: number = Date.now()): number {
  if (!/^\d{6}$/.test(code)) return -1;
  const step = Math.floor(nowMs / 30_000);
  for (const s of [step, step - 1, step + 1]) {
    let want: string;
    try {
      want = totpCode(secret, s);
    } catch {
      return -1;
    }
    if (timingSafeEqual(Buffer.from(want), Buffer.from(code))) return s;
  }
  return -1;
}

/** otpauth:// URL for an authenticator app (shown once by npm run staff:user -- <name> --totp). */
export function otpauthUrl(username: string, secret: string, issuer = 'Drawbridge'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ---------------------------------------------------------------------------
// Session revocation
// ---------------------------------------------------------------------------

export const sessionsFile = () =>
  String(process.env.DRAWBRIDGE_SESSIONS_FILE || '').trim() ||
  path.join(process.env.CALL_RECORDS_DIR || path.join(process.cwd(), 'data'), 'staff-sessions.json');

/**
 * Per-user "sessions valid after" time (ms). A session cookie issued at or before it is refused.
 * Kept in memory and in a small JSON file (mode 0600) so a restart keeps logouts and removals.
 */
export class SessionRevocations {
  private validAfter: Map<string, number> | null = null;
  private file = '';

  private load(): Map<string, number> {
    const f = sessionsFile();
    if (this.validAfter && this.file === f) return this.validAfter;
    this.file = f;
    this.validAfter = new Map();
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const [u, t] of Object.entries(data?.valid_after || {})) if (Number.isFinite(Number(t))) this.validAfter.set(u, Number(t));
    } catch {
      // No file yet: nothing revoked.
    }
    return this.validAfter;
  }

  /** Sessions of `user` issued at or before this time are refused (0 = none). */
  validAfterFor(user: string): number {
    return this.load().get(user.toLowerCase()) || 0;
  }

  /** End every existing session of `user` (logout, removal, password change). */
  revoke(user: string, at: number = Date.now()): void {
    const m = this.load();
    const u = user.toLowerCase();
    m.set(u, Math.max(at, m.get(u) || 0));
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ valid_after: Object.fromEntries(m) }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e: any) {
      console.error(`[Drawbridge] session revocation not saved (${e?.code || 'error'}); it holds until restart`);
    }
  }
}
