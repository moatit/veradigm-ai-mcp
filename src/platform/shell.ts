import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import express, { NextFunction, Request, Response, Router } from 'express';
import { FAVICON_SVG, LOCKUP_SVG } from './brand/marks';
import { brandFont } from './brand/fonts';
import { FONT_LICENSES } from './brand/licenses';
import { shellCss } from './brand/styles';
import { clinicLabel } from './clinic';
import { clientIp, securityEvent, throttledSecurityEvent } from './security-events';
import {
  formatStaffLine,
  LoginThrottle,
  loginWindowMs,
  parseStaffLine,
  passwordExpired,
  passwordMaxAgeDays,
  passwordProblem,
  requireTotp,
  SessionRevocations,
  StaffEntry,
  StaffRole,
  totpMatch,
  USERNAME_RE,
  utcDay,
} from './staff-auth';

/**
 * Drawbridge app shell: one login, one layout, one nav for every staff-facing screen.
 * Feature modules render their body HTML with `esc()` and hand it to `page()`.
 *
 *   DRAWBRIDGE_USERS_FILE                        named staff logins: one "username:scrypt$N$r$p$salt$hash:totp=..:pwset=.."
 *                                                line per person (npm run staff:user -- <name> --totp; format in
 *                                                staff-auth.ts); re-read when it changes. Removing a line or changing a
 *                                                password ends that person's sessions. Every login needs password + TOTP code
 *                                                (DRAWBRIDGE_REQUIRE_TOTP) and a password younger than
 *                                                DRAWBRIDGE_PASSWORD_MAX_AGE_DAYS (default 90).
 *   DRAWBRIDGE_USERNAME / DRAWBRIDGE_PASSWORD   single shared login for local development only (falls back to ONCALL_*):
 *                                                refused when the users file is set, when TOTP is required (the default)
 *                                                and always in production; it is not a unique user ID (HIPAA 164.312(a)(2)(i))
 *   DRAWBRIDGE_SESSION_SECRET                    cookie signing key (falls back to ONCALL_SESSION_SECRET, else random per process)
 *   DRAWBRIDGE_IDLE_MINUTES                      session ends after this long without a request (default 15, sliding);
 *                                                the absolute limit stays 12 hours from sign-in (4 hours for the emergency
 *                                                login). Pages also blank themselves and go to the sign-in page when the
 *                                                idle time is up (automatic logoff, 164.312(a)(2)(iii))
 *   CLINIC_TIMEZONE                              display timezone (default America/Boise)
 *   CLINIC_NAME                                  practice name in the header (clinic.ts; "Drawbridge" when unset)
 * Brute-force lockout, password policy, TOTP, expiry and revocation: staff-auth.ts. Sign-ins, failures, lockouts and
 * logouts are security events in the audit log (security-events.ts). Every page is served with a
 * Content-Security-Policy that allows no inline script (page behaviour lives in /app/assets/drawbridge.js).
 */
const USERNAME = () => process.env.DRAWBRIDGE_USERNAME || process.env.ONCALL_USERNAME || '';
const PASSWORD = () => process.env.DRAWBRIDGE_PASSWORD || process.env.ONCALL_PASSWORD || '';
const USERS_FILE = () => String(process.env.DRAWBRIDGE_USERS_FILE || '').trim();
const isProduction = () => String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';

/** "scrypt$N$r$p$salt$hash" of one password (salt and hash base64). */
export function scryptEntry(password: string, salt: Buffer = randomBytes(16)): string {
  const [N, r, p] = [16384, 8, 1];
  const hash = scryptSync(password, salt, 32, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * "username:scrypt$N$r$p$salt$hash:pwset=<today>" for one staff member, after the password policy.
 * Add ":totp=<secret>" (mandatory to sign in) with npm run staff:user -- <name> --totp.
 */
export function hashStaffPassword(username: string, password: string, salt: Buffer = randomBytes(16)): string {
  if (!USERNAME_RE.test(username)) throw new Error('username: 2-64 letters, digits, . _ @ -');
  const problem = passwordProblem(username, password);
  if (problem) throw new Error(`password: ${problem}`);
  return formatStaffLine(username, { hash: scryptEntry(password, salt), pwset: utcDay(), hist: [], role: 'staff' });
}

const revocations = new SessionRevocations();
const throttle = new LoginThrottle();
/** Last TOTP step accepted per user: a code works once. */
const usedTotpStep = new Map<string, number>();
/** Absolute session limit of the sealed emergency (break-glass) login. */
const EMERGENCY_HOURS = 4;

let usersCache: { file: string; stamp: string; users: Map<string, StaffEntry> } | null = null;
/** Named staff from DRAWBRIDGE_USERS_FILE; null when unset. An unreadable file means nobody can sign in. */
function staffUsers(): Map<string, StaffEntry> | null {
  const file = USERS_FILE();
  if (!file) return null;
  try {
    const st = fs.statSync(file);
    const stamp = `${st.size}:${st.mtimeMs}`;
    if (usersCache && usersCache.file === file && usersCache.stamp === stamp) return usersCache.users;
    const users = new Map<string, StaffEntry>();
    // A later line for the same name replaces an earlier one (a re-issued login appended to the file).
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const parsed = parseStaffLine(line);
      if (parsed) users.set(parsed.user, parsed.entry);
    }
    // Someone removed from the file, or with a new password: their existing sessions end now,
    // and stay ended if the same name is added back later.
    if (usersCache && usersCache.file === file) {
      for (const [u, old] of usersCache.users) {
        const now = users.get(u);
        if (!now || now.hash !== old.hash) revocations.revoke(u);
      }
    }
    usersCache = { file, stamp, users };
    return users;
  } catch {
    usersCache = null;
    return new Map();
  }
}

/** Constant-time check of a password against one "scrypt$..." entry (current or a history entry). */
export function verifyStaffPassword(entry: string, password: string): boolean {
  const [, n, r, p, salt, hash] = entry.split('$');
  try {
    const want = Buffer.from(hash, 'base64');
    const got = scryptSync(password, Buffer.from(salt, 'base64'), want.length, { N: +n, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
    return want.length >= 16 && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

/** The single shared login: development only (no users file, TOTP explicitly off, not production). */
const sharedLoginAllowed = (): boolean => !USERS_FILE() && !!USERNAME() && !!PASSWORD() && !requireTotp() && !isProduction();
const loginConfigured = (): boolean => (USERS_FILE() ? true : sharedLoginAllowed());
const SECRET =
  process.env.DRAWBRIDGE_SESSION_SECRET || process.env.ONCALL_SESSION_SECRET || randomBytes(32).toString('hex');
/** __Host- prefix: browsers only accept it Secure, for this exact host and Path=/ (no subdomain can set or overwrite it). */
const COOKIE = '__Host-drawbridge_session';
const SESSION_HOURS = 12;
export const idleMinutes = (): number => {
  const n = Number(process.env.DRAWBRIDGE_IDLE_MINUTES);
  return Number.isFinite(n) && n >= 1 && n <= SESSION_HOURS * 60 ? Math.floor(n) : 15;
};
/** The idle clock in the cookie is refreshed at most this often (one Set-Cookie per minute, not per request). */
const TOUCH_MS = 60_000;
export const APP_BASE = '/app';

export interface NavItem {
  path: string; // relative to APP_BASE, e.g. "/oncall"
  label: string;
  order?: number;
}

const nav: NavItem[] = [];
export function registerNav(item: NavItem): void {
  if (!nav.some((n) => n.path === item.path)) nav.push(item);
  nav.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
}
export function navItems(): NavItem[] {
  return [...nav];
}

export const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function fmtTime(iso: string | Date, style: 'datetime' | 'time' | 'date' = 'datetime'): string {
  const tz = process.env.CLINIC_TIMEZONE || 'America/Boise';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (!d || isNaN(d.getTime())) return String(iso ?? '');
  const opts: Intl.DateTimeFormatOptions =
    style === 'time'
      ? { timeZone: tz, timeStyle: 'short' }
      : style === 'date'
        ? { timeZone: tz, dateStyle: 'medium' }
        : { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' };
  return d.toLocaleString('en-US', opts);
}

function sign(value: string): string {
  return `${value}.${createHmac('sha256', SECRET).update(value).digest('hex')}`;
}

function verify(signed: string | undefined): string | null {
  if (!signed) return null;
  const i = signed.lastIndexOf('.');
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const a = Buffer.from(sign(value));
  const b = Buffer.from(signed);
  return a.length === b.length && timingSafeEqual(a, b) ? value : null;
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k !== name) continue;
    try {
      return decodeURIComponent(v.join('='));
    } catch {
      return undefined; // malformed cookie: signed out, never a 500
    }
  }
  return undefined;
}

/**
 * GET/HEAD always pass. Otherwise a browser request must be same-origin: Sec-Fetch-Site (set by the browser, so
 * proxies cannot change it) must be same-origin or none; without it, an Origin header must name this host (Host or
 * X-Forwarded-Host, or DRAWBRIDGE_PUBLIC_URL). Non-browser clients send neither and still need the session cookie.
 */
export function sameOriginRequest(req: Request): boolean {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site) return site === 'same-origin' || site === 'none';
  const origin = String(req.headers.origin || '');
  if (!origin) return true;
  let host = '';
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const hosts = [req.headers.host, req.headers['x-forwarded-host']]
    .flatMap((h) => String(h || '').split(','))
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  try {
    if (process.env.DRAWBRIDGE_PUBLIC_URL) hosts.push(new URL(process.env.DRAWBRIDGE_PUBLIC_URL).host.toLowerCase());
  } catch {
    // ignore a malformed setting
  }
  return hosts.includes(host);
}

function sameSecret(a: string, b: string): boolean {
  const x = createHmac('sha256', SECRET).update(a).digest();
  const y = createHmac('sha256', SECRET).update(b).digest();
  return timingSafeEqual(x, y);
}

/**
 * Session cookie value (signed): "v2|<user>|<issued ms>|<last activity ms>". Valid while
 * - issued less than 12 hours ago (absolute limit),
 * - last activity less than DRAWBRIDGE_IDLE_MINUTES ago (sliding idle limit),
 * - issued after the user's revocation time (logout, removal, password change),
 * - and, with named staff, the user is still in the users file, still has TOTP (when required) and the
 *   password has not expired since sign-in. The emergency login's limit is 4 hours.
 */
interface Session {
  user: string;
  issued: number;
  last: number;
}

function readSession(req: Request, now: number = Date.now()): Session | null {
  const [v, user, issued, last] = (verify(readCookie(req, COOKIE)) || '').split('|');
  const s = { user, issued: Number(issued), last: Number(last) };
  if (v !== 'v2' || !user || !Number.isFinite(s.issued) || !Number.isFinite(s.last)) return null;
  if (now - s.issued >= SESSION_HOURS * 3600_000 || now - s.last >= idleMinutes() * 60_000 || s.last > now + 60_000) return null;
  // Named staff: someone taken out of the users file is signed out at once. Read the file first:
  // a removal or password change found now revokes before the check below.
  const staff = staffUsers();
  if (staff) {
    const entry = staff.get(user);
    if (!entry || (requireTotp() && !entry.totp) || passwordExpired(entry, now)) return null;
    if (entry.role === 'emergency' && now - s.issued >= EMERGENCY_HOURS * 3600_000) return null;
  } else if (!sharedLoginAllowed()) return null;
  return s.issued <= revocations.validAfterFor(user) ? null : s;
}

/** Role of a signed-in user: from the users file; the development shared login counts as admin. */
export function userRole(user: string | null | undefined): StaffRole | null {
  if (!user) return null;
  const staff = staffUsers();
  if (!staff) return sharedLoginAllowed() ? 'admin' : null;
  return staff.get(user.toLowerCase())?.role || null;
}

/** Express middleware after requireLogin: admin role (users file `:role=admin`) required. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as any).drawbridgeUser as string | undefined;
  if (userRole(user) === 'admin') {
    next();
    return;
  }
  res
    .status(403)
    .send(page('Not allowed · Drawbridge', '<div class="card">This screen is for Drawbridge administrators (privacy or security officer) only.</div>', { user }));
}

function setSessionCookie(res: Response, s: Session): void {
  const maxAge = Math.max(0, Math.floor((s.issued + SESSION_HOURS * 3600_000 - Date.now()) / 1000));
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(sign(`v2|${s.user}|${s.issued}|${s.last}`))}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`
  );
}

export function currentUser(req: Request): string | null {
  return readSession(req)?.user || null;
}

/** Express middleware: staff login required. Each request counts as activity (sliding idle timeout). */
export function requireLogin(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  const s = readSession(req, now);
  if (s) {
    if (now - s.last >= TOUCH_MS) setSessionCookie(res, { ...s, last: now });
    (req as any).drawbridgeUser = s.user;
    next();
    return;
  }
  res.redirect(`${APP_BASE}/login?next=${encodeURIComponent(req.originalUrl)}`);
}

const CSS = shellCss(APP_BASE);

/**
 * Content-Security-Policy for every staff page. Scripts only from this origin (no inline script,
 * no inline event handlers); styles allow 'unsafe-inline' because the server-rendered pages use
 * style attributes. No frames, plugins, <base> changes or cross-origin form posts.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

/**
 * Served at /app/assets/drawbridge.js. Behaviour the pages used to carry inline:
 *  - <form data-confirm="..."> asks before submitting (outreach "Call approved now")
 *  - [data-print] prints the page (huddle brief)
 *  - #intake-upload sends the chosen file to data-upload-url as JSON (intake upload)
 */
const APP_JS = `(function () {
  document.addEventListener('submit', function (ev) {
    var f = ev.target;
    if (f && f.hasAttribute && f.hasAttribute('data-confirm') && !window.confirm(f.getAttribute('data-confirm'))) ev.preventDefault();
  }, true);
  document.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('[data-print]') : null;
    if (b) { ev.preventDefault(); window.print(); }
  });
  // Automatic logoff: the server session ends after the idle time without a request, so the page
  // blanks itself (no patient data left on screen) and goes to the sign-in page at the same moment.
  document.addEventListener('DOMContentLoaded', function () {
    var ms = Number(document.body.getAttribute('data-idle-ms') || 0);
    var to = document.body.getAttribute('data-logoff-url');
    if (!ms || !to) return;
    setTimeout(function () { document.body.innerHTML = ''; window.location.replace(to); }, ms);
  });
  document.addEventListener('DOMContentLoaded', function () {
    var form = document.getElementById('intake-upload');
    if (!form) return;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var f = form.file.files[0], msg = document.getElementById('intake-upload-msg');
      if (!f) return;
      msg.textContent = 'Uploading…';
      var r = new FileReader();
      r.onload = function () {
        var b64 = String(r.result).split(',')[1] || '';
        fetch(form.getAttribute('data-upload-url'), { method: 'POST', headers: { 'Content-Type': form.getAttribute('data-upload-type') }, credentials: 'same-origin',
          body: JSON.stringify({ name: f.name, mime: f.type, data_base64: b64, text: form.text.value }) })
          .then(function (res) { return res.json().then(function (j) { return { ok: res.ok, j: j }; }); })
          .then(function (o) { if (o.ok && o.j.id) location.href = form.getAttribute('data-item-url') + encodeURIComponent(o.j.id); else msg.textContent = o.j.error || 'Upload failed.'; })
          .catch(function () { msg.textContent = 'Upload failed.'; });
      };
      r.readAsDataURL(f);
    });
  });
})();
`;

/** SYSTEM STATUS banner provider (status-ui.ts): HTML shown above every signed-in page, '' when all is well. */
let statusBannerFn: (() => string) | null = null;
export function setStatusBanner(fn: (() => string) | null): void {
  statusBannerFn = fn;
}
function statusBannerHtml(): string {
  try {
    return statusBannerFn ? statusBannerFn() : '';
  } catch {
    return '';
  }
}

/** Full page with header, nav and body. `active` is the nav path to highlight. */
export function page(title: string, body: string, opts: { user?: string | null; active?: string } = {}): string {
  const tabs = opts.user
    ? `<nav class="tabs">${navItems()
        .map((n) =>
          /^https?:\/\//.test(n.path)
            ? `<a href="${esc(n.path)}" target="_blank" rel="noopener">${esc(n.label)} ↗</a>`
            : `<a href="${APP_BASE}${n.path}" class="${opts.active === n.path ? 'on' : ''}">${esc(n.label)}</a>`
        )
        .join('')}</nav>`
    : '';
  const who = opts.user
    ? `<span class="who">${esc(opts.user)}</span><form method="post" action="${APP_BASE}/logout" style="margin:0"><button class="link">Sign out</button></form>`
    : '';
  const emergency =
    opts.user && userRole(opts.user) === 'emergency'
      ? `<div class="notice urgent">Emergency access session. Everything you open is logged and reviewed by the privacy officer. Sign out as soon as the emergency is handled.</div>`
      : '';
  // Signed-in pages log themselves off when the idle time is up (see APP_JS).
  const idle = opts.user ? ` data-idle-ms="${idleMinutes() * 60_000}" data-logoff-url="${APP_BASE}/login?timeout=1"` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="icon" href="${APP_BASE}/assets/favicon.svg" type="image/svg+xml"><style>${CSS}</style><script src="${APP_BASE}/assets/drawbridge.js" defer></script></head><body${idle}>
<header><h1 class="vh">Drawbridge</h1><div class="brand">${LOCKUP_SVG}<span class="org">A MOATiT Service · ${esc(clinicLabel())}</span></div><span class="sp"></span>${who}</header>
${emergency}${opts.user ? statusBannerHtml() : ''}${tabs}<main>${body}</main></body></html>`;
}

/** Sign-in page messages (codes in ?e=, never user data). */
const LOGIN_MESSAGES: Record<string, string> = {
  '1': 'Wrong username or password.',
  expired: 'Your password has expired. Ask the Drawbridge administrator to issue a new one.',
  mfa: 'Two-factor sign-in is not set up for your login. Ask the Drawbridge administrator to enrol you.',
};

/** Common headers + login/logout routes. Mount at APP_BASE before module routers. */
export function shellRouter(): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false }));
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', CSP);
    // HTTPS only (the session cookie is Secure and __Host-); browsers ignore this header over plain HTTP.
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  // Cross-site requests: SameSite=Strict still sends the cookie from a sibling subdomain of the same site, so a
  // browser's state-changing request (sign-in, sign-out, file, call, mode) must also come from this origin.
  router.use((req, res, next) => {
    if (sameOriginRequest(req)) {
      next();
      return;
    }
    throttledSecurityEvent('cross_site_request', { ip: clientIp(req), code: 'CROSS_SITE', object: String(req.originalUrl || '').split('?')[0] });
    res.status(403).type('text/plain').send('Cross-site request refused.');
  });

  // Page behaviour (upload, confirm, print) as a same-origin script: no inline script anywhere.
  router.get('/assets/drawbridge.js', (_req, res) => {
    res.type('application/javascript').send(APP_JS);
  });
  // Brand assets for every page, the sign-in page included: self-hosted fonts (CSP default-src 'self'), their OFL
  // license, and the favicon. Fixed bytes with no patient data, so these three routes (and only these) may be cached:
  // fonts and license for a year (a new font gets a new file name), the favicon for a week (it can change with the logo).
  const FONT_CACHE = 'public, max-age=31536000, immutable';
  router.get('/assets/fonts/LICENSE.txt', (_req, res) => {
    res.setHeader('Cache-Control', FONT_CACHE);
    res.type('text/plain').send(FONT_LICENSES);
  });
  router.get('/assets/fonts/:name.woff2', (req, res) => {
    const font = brandFont(req.params.name);
    if (!font) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    res.setHeader('Cache-Control', FONT_CACHE);
    res.type('font/woff2').send(font);
  });
  router.get('/assets/favicon.svg', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.type('image/svg+xml').send(FAVICON_SVG);
  });

  router.get('/login', (req, res) => {
    if (!loginConfigured()) {
      res
        .status(503)
        .send(
          page(
            'Drawbridge',
            '<div class="card">Login is not configured. Set DRAWBRIDGE_USERS_FILE with one line per person (npm run staff:user -- &lt;name&gt; --totp). The single shared login works only for local development with DRAWBRIDGE_REQUIRE_TOTP=off.</div>'
          )
        );
      return;
    }
    const next = typeof req.query.next === 'string' && req.query.next.startsWith(APP_BASE) ? req.query.next : APP_BASE;
    const code = typeof req.query.e === 'string' ? req.query.e : '';
    const msg = LOGIN_MESSAGES[code] || (code ? LOGIN_MESSAGES['1'] : '');
    const failed = msg ? `<p style="color:var(--urgent)">${esc(msg)}</p>` : '';
    const timedOut = req.query.timeout ? `<p class="muted">You were signed out after ${idleMinutes()} minutes without activity.</p>` : '';
    // Shown to everyone when a second factor is required or any login uses one, so it says nothing about one user.
    const otp =
      requireTotp() || [...(staffUsers()?.values() || [])].some((e) => e.totp)
        ? '<p><label>Authenticator code<input name="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label></p>'
        : '';
    res.send(
      page(
        'Sign in · Drawbridge',
        `<div class="card signin"><h2 style="margin-top:0">Sign in</h2>${failed}${timedOut}
<form method="post" action="${APP_BASE}/login"><input type="hidden" name="next" value="${esc(next)}">
<p><label>Username<input name="u" autocomplete="username" required></label></p>
<p><label>Password<input name="p" type="password" autocomplete="current-password" required></label></p>${otp}<button>Sign in</button></form>
<p class="muted" style="font-size:12px;margin-bottom:0">Passwords expire every ${passwordMaxAgeDays()} days. Forgot your password, lost your authenticator or locked out? Ask the Drawbridge administrator.</p></div>`
      )
    );
  });

  router.post('/login', (req, res) => {
    let u = String(req.body?.u || '');
    const p = String(req.body?.p || '');
    const ip = clientIp(req);
    const key = u.trim().toLowerCase();
    const staff = staffUsers();
    // Only names that exist go into the logs: a typed unknown name may be a password typed in the wrong box.
    const known = staff?.has(key) ? key : '';
    // Same answer, same delay for a wrong password, an unknown user, a wrong code and a locked account.
    const refuse = (e = '1') => setTimeout(() => res.redirect(`${APP_BASE}/login?e=${e}`), 800);
    if (throttle.blocked(key, ip)) {
      securityEvent('login_failed', { user: known, ip, code: 'LOCKED' });
      refuse();
      return;
    }
    let ok: boolean;
    let failCode = 'BAD_PASSWORD';
    let entry: StaffEntry | undefined;
    if (staff) {
      entry = staff.get(key);
      ok = !!entry && verifyStaffPassword(entry.hash, p);
      if (!entry) failCode = 'UNKNOWN_USER';
      if (ok && entry!.totp) {
        const step = totpMatch(entry!.totp, String(req.body?.otp || '').replace(/\s+/g, ''));
        ok = step >= 0 && step > (usedTotpStep.get(key) ?? -1);
        if (ok) usedTotpStep.set(key, step);
        else failCode = 'BAD_TOTP';
      } else if (ok && requireTotp()) {
        // Right password, but no second factor enrolled: refused until the administrator enrols them (not a guess, not counted).
        securityEvent('login_no_totp', { user: key, ip, code: 'TOTP_NOT_ENROLLED' });
        refuse('mfa');
        return;
      }
      u = key;
    } else {
      ok = sharedLoginAllowed() && sameSecret(u, USERNAME()) && sameSecret(p, PASSWORD());
    }
    if (!ok || u.includes('|')) {
      const locked = throttle.fail(key, ip);
      securityEvent('login_failed', { user: known, ip, code: failCode });
      if (locked.user) securityEvent('login_locked', { user: known, ip, code: `LOCKED_${loginWindowMs() / 60_000}_MIN` });
      if (locked.ip) securityEvent('login_ip_locked', { ip, code: `LOCKED_${loginWindowMs() / 60_000}_MIN` });
      refuse();
      return;
    }
    throttle.success(key);
    // Password and code were right, but the password is too old: only now is that said (it reveals nothing to a guesser).
    if (entry && passwordExpired(entry)) {
      securityEvent('login_password_expired', { user: key, ip, code: entry.pwset ? 'PASSWORD_EXPIRED' : 'PASSWORD_DATE_MISSING' });
      refuse('expired');
      return;
    }
    if (entry?.role === 'emergency') {
      securityEvent('emergency_access_login', { user: key, ip, code: 'BREAK_GLASS' });
      console.error(`[SECURITY] EMERGENCY ACCESS: sealed login "${key}" signed in. Review this session and rotate the login afterwards.`);
    } else securityEvent('login_ok', { user: u, ip });
    const next = typeof req.body?.next === 'string' && req.body.next.startsWith(APP_BASE) ? req.body.next : APP_BASE;
    // Issued strictly after any revocation of this user (logout a moment ago in the same millisecond).
    const issued = Math.max(Date.now(), revocations.validAfterFor(u) + 1);
    setSessionCookie(res, { user: u, issued, last: issued });
    res.redirect(next);
  });

  // Server-side logout: every session of this user ends (this browser and any other).
  router.post('/logout', (req, res) => {
    const s = readSession(req);
    if (s) {
      revocations.revoke(s.user);
      securityEvent('logout', { user: s.user, ip: clientIp(req) });
    }
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    res.redirect(`${APP_BASE}/login`);
  });

  return router;
}
