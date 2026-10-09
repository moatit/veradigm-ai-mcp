import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import express, { NextFunction, Request, Response, Router } from 'express';
import { callRecords, CallRecord } from './call-records';
import { currentMode, getOverride, scheduledMode, setOverride } from './call-mode';

/**
 * Drawbridge on-call notebook (spec §6): tonight's calls (urgent first, newest first) and a
 * detail page per call. Login required, even for the demo.
 *
 *   ONCALL_USERNAME, ONCALL_PASSWORD   notebook login (notebook is off if unset)
 *   ONCALL_SESSION_SECRET              cookie signing key (random per process if unset)
 *
 * Served by the Unity container under /oncall.
 */
const SECRET = process.env.ONCALL_SESSION_SECRET || randomBytes(32).toString('hex');
const COOKIE = 'db_oncall';
const SESSION_HOURS = 12;

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

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
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
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

function requireLogin(req: Request, res: Response, next: NextFunction): void {
  const value = verify(readCookie(req, COOKIE));
  const [user, exp] = (value || '').split('|');
  if (user && Number(exp) > Date.now()) {
    (req as any).oncallUser = user;
    next();
    return;
  }
  res.redirect('/oncall/login');
}

const MARK = `<svg viewBox="0 0 256 256" width="28" height="28" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M52 172V64h20V48h20v16h16V48h40v16h16V48h20v16h20v108ZM104 172v-48a24 24 0 0 1 48 0v48Z"/><path d="M100 118 82 200M156 118l18 82" stroke="#3FB4E8" stroke-width="5" stroke-linecap="round"/><path d="M104 172h48l26 34H78Z" fill="#2F6DB0"/><path d="M20 222c24-12 40-12 64 0s40 12 64 0 40-12 64 0" stroke="#E8A13A" stroke-width="9" stroke-linecap="round" fill="none"/></svg>`;

function page(title: string, body: string, user?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{--bg:#f6f7fb;--card:#fff;--ink:#1d2140;--muted:#5d6380;--line:#e3e6ef;--brand:#2B2F7A;--urgent:#c0392b;--urgent-bg:#fdecea;--ok:#1e7a46;--ok-bg:#e7f6ee}
@media (prefers-color-scheme:dark){:root{--bg:#12142a;--card:#1b1e3a;--ink:#eceefa;--muted:#a3a8c7;--line:#2c3058;--brand:#9aa2ff;--urgent:#ff7b6b;--urgent-bg:#3a1d22;--ok:#5fd396;--ok-bg:#16352a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line);background:var(--card);color:var(--brand)}
header h1{font-size:17px;margin:0;color:var(--ink)}header .sp{flex:1}header a,header form button{color:var(--muted);font-size:13px}
main{max-width:960px;margin:0 auto;padding:16px}a{color:var(--brand)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:10px}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;text-decoration:none;color:inherit}
.pill{font-size:12px;font-weight:600;border-radius:999px;padding:2px 9px;background:var(--line);color:var(--muted)}
.pill.urgent{background:var(--urgent-bg);color:var(--urgent)}.pill.ok{background:var(--ok-bg);color:var(--ok)}
.muted{color:var(--muted)}h2{font-size:15px;margin:18px 0 8px}dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
ul{margin:4px 0 0;padding-left:18px}button,input{font:inherit}button{background:var(--brand);color:#fff;border:0;border-radius:8px;padding:7px 12px;cursor:pointer}
button.link{background:none;color:var(--muted);padding:0;text-decoration:underline}input{width:100%;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
.mode{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.empty{text-align:center;padding:40px 16px}
</style></head><body><header>${MARK}<h1>Drawbridge · On-call notebook</h1><span class="sp"></span>${
    user ? `<span class="muted" style="font-size:13px">${esc(user)}</span><form method="post" action="/oncall/logout" style="margin:0"><button class="link">Sign out</button></form>` : ''
  }</header><main>${body}</main></body></html>`;
}

function fmtTime(iso: string): string {
  const tz = process.env.CLINIC_TIMEZONE || 'America/Boise';
  return new Date(iso).toLocaleString('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
}

const listOrDash = (items: string[]) => (items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '<span class="muted">Not captured</span>');

function detail(r: CallRecord): string {
  return `<p><a href="/oncall">← All calls</a></p>
<div class="card"><div class="row">
<strong style="font-size:17px">${r.verified ? esc(r.patient_name || 'Verified caller') : 'Unverified caller'}</strong>
<span class="pill ${r.urgency === 'urgent' ? 'urgent' : ''}">${esc(r.urgency)}</span>
<span class="pill ${r.verified ? 'ok' : ''}">${r.verified ? 'identity verified' : 'not verified'}</span>
<span class="pill">${r.mode === 'after_hours' ? 'after hours' : 'business hours'}</span></div>
<h2>Message</h2><p style="margin:0;white-space:pre-wrap">${esc(r.reason_verbatim) || '<span class="muted">No message</span>'}</p>
<h2>Caller</h2><dl><dt>Started</dt><dd>${esc(fmtTime(r.started_at))}</dd><dt>Phone</dt><dd>${esc(r.caller_phone) || '—'}</dd>
<dt>Date of birth</dt><dd>${esc(r.dob) || '—'}</dd><dt>Record</dt><dd>${r.patient_ref.id ? `${r.patient_ref.system === 'veradigm_ehr' ? 'Veradigm® EHR' : 'Veradigm® PM'} · ${esc(r.patient_ref.id)}` : '—'}</dd>
<dt>Staff task</dt><dd>${esc(r.staff_task_id) || '—'}</dd><dt>Alert</dt><dd>${r.alert.sent ? `Sent to ${esc(r.alert.to)} at ${esc(fmtTime(r.alert.at || r.updated_at))}${r.alert.note ? ` <span class="muted">(${esc(r.alert.note)})</span>` : ''}` : '—'}</dd></dl>
<h2>Chart context</h2><dl><dt>Medications</dt><dd>${listOrDash(r.chart_snapshot.medications)}</dd><dt>Allergies</dt><dd>${listOrDash(r.chart_snapshot.allergies)}</dd>
<dt>Problems</dt><dd>${listOrDash(r.chart_snapshot.problems)}</dd><dt>Latest results</dt><dd>${listOrDash(r.chart_snapshot.latest_observations)}</dd>
<dt>Next appointment</dt><dd>${esc(r.chart_snapshot.next_appointment) || '<span class="muted">Not captured</span>'}</dd></dl>
<h2>Actions taken</h2>${r.actions_taken.length ? `<ul>${r.actions_taken.map((a) => `<li>${esc(fmtTime(a.at))} · ${esc(a.tool)} · ${a.result === 'success' ? 'ok' : '<strong>failed</strong>'}${a.detail ? ` · ${esc(a.detail)}` : ''}</li>`).join('')}</ul>` : '<span class="muted">None</span>'}
<p class="muted" style="font-size:13px;margin-top:16px">Call ${esc(r.call_id)}${r.transcript_ref ? ` · transcript ${esc(r.transcript_ref)}` : ''}</p></div>`;
}

export function onCallNotebook(): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false }));
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  const configured = !!(process.env.ONCALL_USERNAME && process.env.ONCALL_PASSWORD);

  router.get('/login', (req, res) => {
    if (!configured) {
      res.status(503).send(page('On-call notebook', '<div class="card">The notebook is not configured. Set ONCALL_USERNAME and ONCALL_PASSWORD.</div>'));
      return;
    }
    const failed = req.query.e ? '<p style="color:var(--urgent)">Wrong username or password.</p>' : '';
    res.send(page('Sign in · On-call notebook', `<div class="card" style="max-width:360px;margin:40px auto"><h2 style="margin-top:0">Sign in</h2>${failed}
<form method="post" action="/oncall/login"><p><label>Username<input name="u" autocomplete="username" required></label></p>
<p><label>Password<input name="p" type="password" autocomplete="current-password" required></label></p><button>Sign in</button></form></div>`));
  });

  router.post('/login', (req, res) => {
    const u = String(req.body?.u || '');
    const p = String(req.body?.p || '');
    const ok = configured && sameSecret(u, process.env.ONCALL_USERNAME!) && sameSecret(p, process.env.ONCALL_PASSWORD!);
    if (!ok) {
      setTimeout(() => res.redirect('/oncall/login?e=1'), 800);
      return;
    }
    const value = sign(`${u}|${Date.now() + SESSION_HOURS * 3600_000}`);
    res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(value)}; Path=/oncall; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`);
    res.redirect('/oncall');
  });

  router.post('/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/oncall; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    res.redirect('/oncall/login');
  });

  router.post('/mode', requireLogin, (req, res) => {
    const m = String(req.body?.mode || '');
    setOverride(m === 'after_hours' || m === 'business_hours' ? m : null);
    res.redirect('/oncall');
  });

  router.get('/', requireLogin, (req, res) => {
    const mode = currentMode();
    const override = getOverride();
    const rows = callRecords.list();
    const modeBar = `<div class="card mode"><strong>Line mode:</strong>
<span class="pill ${mode === 'after_hours' ? 'urgent' : 'ok'}">${mode === 'after_hours' ? 'After hours' : 'Business hours'}</span>
<span class="muted" style="font-size:13px">${override ? 'manual override' : `by schedule (${esc(process.env.CLINIC_HOURS || 'Mon-Fri 08:00-17:00')})`}</span><span style="flex:1"></span>
<form method="post" action="/oncall/mode" style="margin:0"><input type="hidden" name="mode" value="${mode === 'after_hours' ? 'business_hours' : 'after_hours'}">
<button>Switch to ${mode === 'after_hours' ? 'business hours' : 'after hours'}</button></form>
${override ? `<form method="post" action="/oncall/mode" style="margin:0"><input type="hidden" name="mode" value=""><button class="link">Back to schedule (${scheduledMode() === 'after_hours' ? 'after hours' : 'business hours'})</button></form>` : ''}</div>`;
    const list = rows.length
      ? rows
          .map(
            (r) => `<a class="card row" href="/oncall/call/${encodeURIComponent(r.call_id)}">
<span class="pill ${r.urgency === 'urgent' ? 'urgent' : ''}">${esc(r.urgency)}</span>
<strong>${r.verified ? esc(r.patient_name || 'Verified caller') : 'Unverified caller'}</strong>
<span class="muted" style="flex:1;min-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.reason_verbatim.slice(0, 120))}</span>
<span class="muted" style="font-size:13px">${esc(fmtTime(r.started_at))}</span></a>`
          )
          .join('')
      : '<div class="card empty muted">No calls yet.</div>';
    res.send(page('On-call notebook', `${modeBar}<h2>Calls</h2>${list}`, (req as any).oncallUser));
  });

  router.get('/call/:id', requireLogin, (req, res) => {
    const r = callRecords.get(req.params.id);
    if (!r) {
      res.status(404).send(page('Not found', '<div class="card">Call not found. <a href="/oncall">Back</a></div>', (req as any).oncallUser));
      return;
    }
    res.send(page(`Call · ${r.verified ? r.patient_name : 'Unverified'}`, detail(r), (req as any).oncallUser));
  });

  return router;
}
