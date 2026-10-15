import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import express, { NextFunction, Request, Response, Router } from 'express';
import { LoginThrottle, loginWindowMs, passwordProblem, SessionRevocations, totpMatch } from './staff-auth';

/**
 * Drawbridge app shell: one login, one layout, one nav for every staff-facing screen.
 * Feature modules render their body HTML with `esc()` and hand it to `page()`.
 *
 *   DRAWBRIDGE_USERNAME / DRAWBRIDGE_PASSWORD   staff login (falls back to ONCALL_USERNAME / ONCALL_PASSWORD)
 *   DRAWBRIDGE_USERS_FILE                        named staff logins instead: one "username:scrypt$N$r$p$salt$hash"
 *                                                line per person (npm run staff:user), optionally ":totp=<base32>" for a
 *                                                second factor; re-read when it changes; when set, the single login above
 *                                                is not accepted. Removing a line or changing a password ends that person's sessions.
 *   DRAWBRIDGE_SESSION_SECRET                    cookie signing key (falls back to ONCALL_SESSION_SECRET, else random per process)
 *   DRAWBRIDGE_IDLE_MINUTES                      session ends after this long without a request (default 15, sliding);
 *                                                the absolute limit stays 12 hours from sign-in
 *   CLINIC_TIMEZONE                              display timezone (default America/Boise)
 * Brute-force lockout, password policy, TOTP and revocation: staff-auth.ts. Every page is served with a
 * Content-Security-Policy that allows no inline script (page behaviour lives in /app/assets/drawbridge.js).
 */
const USERNAME = () => process.env.DRAWBRIDGE_USERNAME || process.env.ONCALL_USERNAME || '';
const PASSWORD = () => process.env.DRAWBRIDGE_PASSWORD || process.env.ONCALL_PASSWORD || '';
const USERS_FILE = () => String(process.env.DRAWBRIDGE_USERS_FILE || '').trim();

/** "username:scrypt$N$r$p$salt$hash" for one staff member (salt and hash base64). */
export function hashStaffPassword(username: string, password: string, salt: Buffer = randomBytes(16)): string {
  if (!/^[A-Za-z0-9._@-]{2,64}$/.test(username)) throw new Error('username: 2-64 letters, digits, . _ @ -');
  const problem = passwordProblem(username, password);
  if (problem) throw new Error(`password: ${problem}`);
  const [N, r, p] = [16384, 8, 1];
  const hash = scryptSync(password, salt, 32, { N, r, p });
  return `${username}:scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** One named staff login: the scrypt entry and, when the person enrolled, a TOTP secret. */
interface StaffEntry {
  hash: string;
  totp?: string;
}

const revocations = new SessionRevocations();
const throttle = new LoginThrottle();
/** Last TOTP step accepted per user: a code works once. */
const usedTotpStep = new Map<string, number>();

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
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.trim().match(/^([A-Za-z0-9._@-]{2,64}):(scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+)(?::totp=([A-Z2-7]{16,128}))?$/);
      if (m) users.set(m[1].toLowerCase(), { hash: m[2], ...(m[3] ? { totp: m[3] } : {}) });
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

/** Constant-time check of one staff member's password against the users file entry. */
function checkStaffPassword(entry: string, password: string): boolean {
  const [, n, r, p, salt, hash] = entry.split('$');
  try {
    const want = Buffer.from(hash, 'base64');
    const got = scryptSync(password, Buffer.from(salt, 'base64'), want.length, { N: +n, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
    return want.length >= 16 && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

const loginConfigured = (): boolean => (USERS_FILE() ? true : !!USERNAME() && !!PASSWORD());
const SECRET =
  process.env.DRAWBRIDGE_SESSION_SECRET || process.env.ONCALL_SESSION_SECRET || randomBytes(32).toString('hex');
const COOKIE = 'drawbridge_session';
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
  if (isNaN(d.getTime())) return String(iso);
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
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
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
 * - and, with named staff, the user is still in the users file.
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
  if (staff && !staff.has(user)) return null;
  return s.issued <= revocations.validAfterFor(user) ? null : s;
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

const MARK = `<svg viewBox="0 0 256 256" width="28" height="28" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M52 172V64h20V48h20v16h16V48h40v16h16V48h20v16h20v108ZM104 172v-48a24 24 0 0 1 48 0v48Z"/><path d="M100 118 82 200M156 118l18 82" stroke="#3FB4E8" stroke-width="5" stroke-linecap="round"/><path d="M104 172h48l26 34H78Z" fill="#2F6DB0"/><path d="M20 222c24-12 40-12 64 0s40 12 64 0 40-12 64 0" stroke="#E8A13A" stroke-width="9" stroke-linecap="round" fill="none"/></svg>`;

const CSS = `
:root{--bg:#f6f7fb;--card:#fff;--ink:#1d2140;--muted:#5d6380;--line:#e3e6ef;--brand:#2B2F7A;--accent:#2F6DB0;--urgent:#c0392b;--urgent-bg:#fdecea;--ok:#1e7a46;--ok-bg:#e7f6ee;--warn:#9a6200;--warn-bg:#fdf3e1}
@media (prefers-color-scheme:dark){:root{--bg:#12142a;--card:#1b1e3a;--ink:#eceefa;--muted:#a3a8c7;--line:#2c3058;--brand:#9aa2ff;--accent:#6fa8ff;--urgent:#ff7b6b;--urgent-bg:#3a1d22;--ok:#5fd396;--ok-bg:#16352a;--warn:#ffc266;--warn-bg:#3a2e14}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--card);color:var(--brand);flex-wrap:wrap}
header h1{font-size:17px;margin:0;color:var(--ink)}header .sp{flex:1}
nav.tabs{display:flex;gap:4px;flex-wrap:wrap;padding:0 16px;background:var(--card);border-bottom:1px solid var(--line)}
nav.tabs a{padding:9px 12px;color:var(--muted);text-decoration:none;border-bottom:2px solid transparent;font-size:14px}
nav.tabs a.on{color:var(--ink);border-bottom-color:var(--brand);font-weight:600}
main{max-width:1040px;margin:0 auto;padding:16px}a{color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:10px}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;text-decoration:none;color:inherit}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.pill{font-size:12px;font-weight:600;border-radius:999px;padding:2px 9px;background:var(--line);color:var(--muted)}
.pill.urgent{background:var(--urgent-bg);color:var(--urgent)}.pill.ok{background:var(--ok-bg);color:var(--ok)}.pill.warn{background:var(--warn-bg);color:var(--warn)}
.muted{color:var(--muted)}h2{font-size:15px;margin:18px 0 8px}h3{font-size:14px;margin:12px 0 6px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
ul{margin:4px 0 0;padding-left:18px}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
.scroll{overflow-x:auto}
button,input,select,textarea{font:inherit}button{background:var(--brand);color:#fff;border:0;border-radius:8px;padding:7px 12px;cursor:pointer}
button.secondary{background:var(--line);color:var(--ink)}button.link{background:none;color:var(--muted);padding:0;text-decoration:underline}
input,select,textarea{width:100%;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
.empty{text-align:center;padding:36px 16px}.stat{font-size:26px;font-weight:700}
`;

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
    ? `<span class="muted" style="font-size:13px">${esc(opts.user)}</span><form method="post" action="${APP_BASE}/logout" style="margin:0"><button class="link">Sign out</button></form>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style><script src="${APP_BASE}/assets/drawbridge.js" defer></script></head><body>
<header>${MARK}<h1>Drawbridge</h1><span class="muted" style="font-size:13px">VeradigmAI · Idaho Kidney Institute</span><span class="sp"></span>${who}</header>
${tabs}<main>${body}</main></body></html>`;
}

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
    next();
  });

  // Page behaviour (upload, confirm, print) as a same-origin script: no inline script anywhere.
  router.get('/assets/drawbridge.js', (_req, res) => {
    res.type('application/javascript').send(APP_JS);
  });

  router.get('/login', (req, res) => {
    if (!loginConfigured()) {
      res
        .status(503)
        .send(page('Drawbridge', '<div class="card">Login is not configured. Set DRAWBRIDGE_USERNAME and DRAWBRIDGE_PASSWORD, or DRAWBRIDGE_USERS_FILE.</div>'));
      return;
    }
    const next = typeof req.query.next === 'string' && req.query.next.startsWith(APP_BASE) ? req.query.next : APP_BASE;
    const failed = req.query.e ? '<p style="color:var(--urgent)">Wrong username or password.</p>' : '';
    // Shown to everyone when any named login uses a second factor, so it says nothing about one user.
    const otp = [...(staffUsers()?.values() || [])].some((e) => e.totp)
      ? '<p><label>Authenticator code (if you set one up)<input name="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></label></p>'
      : '';
    res.send(
      page(
        'Sign in · Drawbridge',
        `<div class="card" style="max-width:360px;margin:40px auto"><h2 style="margin-top:0">Sign in</h2>${failed}
<form method="post" action="${APP_BASE}/login"><input type="hidden" name="next" value="${esc(next)}">
<p><label>Username<input name="u" autocomplete="username" required></label></p>
<p><label>Password<input name="p" type="password" autocomplete="current-password" required></label></p>${otp}<button>Sign in</button></form></div>`
      )
    );
  });

  router.post('/login', (req, res) => {
    let u = String(req.body?.u || '');
    const p = String(req.body?.p || '');
    const ip = req.ip || req.socket?.remoteAddress || '';
    const key = u.trim().toLowerCase();
    // Same answer, same delay for a wrong password, an unknown user, a wrong code and a locked account.
    const refuse = () => setTimeout(() => res.redirect(`${APP_BASE}/login?e=1`), 800);
    if (throttle.blocked(key, ip)) {
      refuse();
      return;
    }
    const staff = staffUsers();
    let ok: boolean;
    if (staff) {
      const entry = staff.get(key);
      ok = !!entry && checkStaffPassword(entry.hash, p);
      if (ok && entry!.totp) {
        const step = totpMatch(entry!.totp, String(req.body?.otp || '').replace(/\s+/g, ''));
        ok = step >= 0 && step > (usedTotpStep.get(key) ?? -1);
        if (ok) usedTotpStep.set(key, step);
      }
      u = key;
    } else {
      ok = !!USERNAME() && !!PASSWORD() && sameSecret(u, USERNAME()) && sameSecret(p, PASSWORD());
    }
    if (!ok || u.includes('|')) {
      const locked = throttle.fail(key, ip);
      if (locked.user) console.warn(`[Drawbridge] staff login: a username was locked for ${loginWindowMs() / 60_000} min after repeated failures`);
      if (locked.ip) console.warn(`[Drawbridge] staff login: client ${ip} locked for ${loginWindowMs() / 60_000} min after repeated failures`);
      refuse();
      return;
    }
    throttle.success(key);
    const next = typeof req.body?.next === 'string' && req.body.next.startsWith(APP_BASE) ? req.body.next : APP_BASE;
    // Issued strictly after any revocation of this user (logout a moment ago in the same millisecond).
    const issued = Math.max(Date.now(), revocations.validAfterFor(u) + 1);
    setSessionCookie(res, { user: u, issued, last: issued });
    res.redirect(next);
  });

  // Server-side logout: every session of this user ends (this browser and any other).
  router.post('/logout', (req, res) => {
    const s = readSession(req);
    if (s) revocations.revoke(s.user);
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    res.redirect(`${APP_BASE}/login`);
  });

  return router;
}
