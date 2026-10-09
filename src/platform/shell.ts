import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import express, { NextFunction, Request, Response, Router } from 'express';

/**
 * Drawbridge app shell: one login, one layout, one nav for every staff-facing screen.
 * Feature modules render their body HTML with `esc()` and hand it to `page()`.
 *
 *   DRAWBRIDGE_USERNAME / DRAWBRIDGE_PASSWORD   staff login (falls back to ONCALL_USERNAME / ONCALL_PASSWORD)
 *   DRAWBRIDGE_SESSION_SECRET                    cookie signing key (falls back to ONCALL_SESSION_SECRET, else random per process)
 *   CLINIC_TIMEZONE                              display timezone (default America/Boise)
 */
const USERNAME = () => process.env.DRAWBRIDGE_USERNAME || process.env.ONCALL_USERNAME || '';
const PASSWORD = () => process.env.DRAWBRIDGE_PASSWORD || process.env.ONCALL_PASSWORD || '';
const SECRET =
  process.env.DRAWBRIDGE_SESSION_SECRET || process.env.ONCALL_SESSION_SECRET || randomBytes(32).toString('hex');
const COOKIE = 'drawbridge_session';
const SESSION_HOURS = 12;
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

export function currentUser(req: Request): string | null {
  const value = verify(readCookie(req, COOKIE));
  const [user, exp] = (value || '').split('|');
  return user && Number(exp) > Date.now() ? user : null;
}

/** Express middleware: staff login required. */
export function requireLogin(req: Request, res: Response, next: NextFunction): void {
  const user = currentUser(req);
  if (user) {
    (req as any).drawbridgeUser = user;
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
<title>${esc(title)}</title><style>${CSS}</style></head><body>
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
    next();
  });

  router.get('/login', (req, res) => {
    if (!USERNAME() || !PASSWORD()) {
      res
        .status(503)
        .send(page('Drawbridge', '<div class="card">Login is not configured. Set DRAWBRIDGE_USERNAME and DRAWBRIDGE_PASSWORD.</div>'));
      return;
    }
    const next = typeof req.query.next === 'string' && req.query.next.startsWith(APP_BASE) ? req.query.next : APP_BASE;
    const failed = req.query.e ? '<p style="color:var(--urgent)">Wrong username or password.</p>' : '';
    res.send(
      page(
        'Sign in · Drawbridge',
        `<div class="card" style="max-width:360px;margin:40px auto"><h2 style="margin-top:0">Sign in</h2>${failed}
<form method="post" action="${APP_BASE}/login"><input type="hidden" name="next" value="${esc(next)}">
<p><label>Username<input name="u" autocomplete="username" required></label></p>
<p><label>Password<input name="p" type="password" autocomplete="current-password" required></label></p><button>Sign in</button></form></div>`
      )
    );
  });

  router.post('/login', (req, res) => {
    const u = String(req.body?.u || '');
    const p = String(req.body?.p || '');
    const ok = !!USERNAME() && !!PASSWORD() && sameSecret(u, USERNAME()) && sameSecret(p, PASSWORD());
    if (!ok) {
      setTimeout(() => res.redirect(`${APP_BASE}/login?e=1`), 800);
      return;
    }
    const next = typeof req.body?.next === 'string' && req.body.next.startsWith(APP_BASE) ? req.body.next : APP_BASE;
    const value = sign(`${u}|${Date.now() + SESSION_HOURS * 3600_000}`);
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`
    );
    res.redirect(next);
  });

  router.post('/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    res.redirect(`${APP_BASE}/login`);
  });

  return router;
}
