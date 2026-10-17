import express, { Express, Request, Response, Router } from 'express';
import { auditPatient } from '../../app';
import { PlatformModule } from '../../registry';
import { APP_BASE, esc, fmtTime, page, requireAdmin } from '../../shell';
import { displayChannel, displayCode, displayText } from '../../display';
import { AuditEntry, auditDays, dayKey, isDayKey, pruneAudit, readAuditDay, readAuditRange, retentionDays, safeId, safeUser, toolMetrics } from '../../audit';
import { clientIp, recordExport, throttledSecurityEvent } from '../../security-events';
import { callRecords } from '../../../unity/oncall/call-records';
import { handleRetellEvent, recentCalls, verifyWebhook } from './retell-events';
import { startDailyRetention } from '../../retention';

/**
 * Drawbridge module: activity.
 *  - Staff screens: /app/activity (tool calls + per-tool metrics for a day, security events), /app/activity/calls
 *    (recent calls), /app/activity/disclosures (administrators: access and disclosure report per patient or per staff
 *    user for a date range, HTML or CSV; supports the accounting of disclosures, HIPAA 164.528, and breach scoping)
 *  - POST /webhooks/retell (Retell call events; verified, see README) via mountRetellWebhook(app)
 *  - POST /api/activity/retell-events (same events, behind the Drawbridge tool key, for relays/tests)
 */
const LIST_MAX = 500;

/** Client-facing names: tool IDs without the internal prefix; systems by product name. */
export const toolLabel = (t: string): string => t.replace(/^(unity|fhir|drawbridge)_/, '').replace(/_/g, ' ');
export function systemLabel(e: Pick<AuditEntry, 'server' | 'tool'>): string {
  if (e.tool.startsWith('drawbridge_')) return 'Drawbridge';
  return e.server === 'fhir' ? 'Veradigm® EHR' : 'Veradigm® PM/EHR';
}
const pct = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`;
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);
const qs = (o: Record<string, string>) =>
  Object.entries(o)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

async function activityPage(req: Request): Promise<string> {
  const today = dayKey();
  const day = isDayKey(req.query.date) ? req.query.date : today;
  const tool = typeof req.query.tool === 'string' ? req.query.tool.slice(0, 80) : '';
  const status = req.query.status === 'ok' || req.query.status === 'failed' ? req.query.status : '';
  const call = safeId(req.query.call);

  const all = await readAuditDay(day);
  // Tool calls and Veradigm actions (lines written before kinds existed count as tool calls).
  const entries = all.filter((e) => !e.kind || e.kind === 'tool' || e.kind === 'action');
  const security = all.filter((e) => e.kind === 'security');
  const views = all.filter((e) => e.kind === 'view' || e.kind === 'staff');
  const days = [...new Set([today, ...(await auditDays())])].sort().reverse();
  const tools = [...new Set(entries.map((e) => e.tool))].sort();
  const metrics = toolMetrics(entries);
  const serverOf = new Map(entries.map((e) => [e.tool, e]));
  const errors = entries.filter((e) => !e.success).length;
  const calls = new Set(entries.map((e) => e.call_id).filter(Boolean)).size;

  const rows = entries
    .filter((e) => (!tool || e.tool === tool) && (!status || (status === 'ok') === e.success) && (!call || e.call_id === call))
    .reverse();

  const filters = `<form class="card row" method="get" action="${APP_BASE}/activity" style="align-items:flex-end">
<label style="min-width:140px">Day<select name="date">${days.map((d) => `<option value="${esc(d)}"${d === day ? ' selected' : ''}>${esc(d)}${d === today ? ' (today)' : ''}</option>`).join('')}</select></label>
<label style="min-width:200px;flex:1">Tool<select name="tool"><option value="">All tools</option>${tools.map((t) => `<option value="${esc(t)}"${t === tool ? ' selected' : ''}>${esc(toolLabel(t))}</option>`).join('')}</select></label>
<label style="min-width:130px">Outcome<select name="status"><option value="">All</option><option value="ok"${status === 'ok' ? ' selected' : ''}>Succeeded</option><option value="failed"${status === 'failed' ? ' selected' : ''}>Failed</option></select></label>
<label style="min-width:200px;flex:1">Call ID<input name="call" value="${esc(call)}" placeholder="Any call"></label>
<button>Show</button>${tool || status || call ? `<a href="${APP_BASE}/activity?${qs({ date: day === today ? '' : day })}">Clear</a>` : ''}</form>`;

  const summary = `<div class="grid">
<div class="card"><div class="muted">Tool calls</div><div class="stat">${esc(entries.length)}</div></div>
<div class="card"><div class="muted">Failed</div><div class="stat"${errors ? ' style="color:var(--urgent)"' : ''}>${esc(errors)}</div></div>
<div class="card"><div class="muted">Phone calls with tool use</div><div class="stat">${esc(calls)}</div></div></div>`;

  const metricTable = metrics.length
    ? `<div class="card scroll"><table><thead><tr><th>Tool</th><th>System</th><th>Calls</th><th>Error rate</th><th>p50</th><th>p95</th></tr></thead><tbody>${metrics
        .map((m) => {
          const e = serverOf.get(m.tool)!;
          return `<tr><td><a href="${APP_BASE}/activity?${qs({ date: day, tool: m.tool })}">${esc(toolLabel(m.tool))}</a></td><td>${esc(systemLabel(e))}</td><td>${esc(m.count)}</td>
<td>${m.errors ? `<span class="pill ${m.error_rate >= 0.2 ? 'urgent' : 'warn'}">${esc(pct(m.error_rate))}</span>` : '<span class="pill ok">0%</span>'}</td><td>${esc(ms(m.p50_ms))}</td><td>${esc(ms(m.p95_ms))}</td></tr>`;
        })
        .join('')}</tbody></table></div>`
    : '<div class="card empty muted">No tool calls recorded for this day.</div>';

  const list = rows.length
    ? `<div class="card scroll"><table><thead><tr><th>Time</th><th>Tool</th><th>Outcome</th><th>Latency</th><th>Call</th><th>Patient ID</th><th>Channel</th></tr></thead><tbody>${rows
        .slice(0, LIST_MAX)
        .map(
          (e) => `<tr><td>${esc(fmtTime(e.ts, 'time'))}</td><td>${esc(toolLabel(e.tool))}<div class="muted" style="font-size:12px">${esc(systemLabel(e))}</div></td>
<td>${e.success ? '<span class="pill ok">ok</span>' : `<span class="pill urgent">failed</span> <span class="muted" style="font-size:12px">${esc(displayCode(e.error_code))}</span>`}</td>
<td>${esc(ms(e.latency_ms))}</td><td>${e.call_id ? `<a href="${APP_BASE}/activity?${qs({ date: day, call: e.call_id })}" style="font-size:12px">${esc(e.call_id)}</a>` : '<span class="muted">—</span>'}</td>
<td>${esc(e.patient_id) || '<span class="muted">—</span>'}</td><td>${esc(displayChannel(e.channel)) || '—'}</td></tr>`
        )
        .join('')}</tbody></table>${rows.length > LIST_MAX ? `<p class="muted" style="font-size:13px">Showing the latest ${LIST_MAX} of ${esc(rows.length)}. Narrow the filters to see more.</p>` : ''}</div>`
    : '<div class="card empty muted">No tool calls match these filters.</div>';

  const alerts = security.filter((e) => !e.success);
  const securityTable = security.length
    ? `<div class="card scroll"><table><thead><tr><th>Time</th><th>Event</th><th>Staff user</th><th>Client</th><th>Detail</th></tr></thead><tbody>${security
        .slice()
        .reverse()
        .slice(0, 200)
        .map(
          (e) => `<tr><td>${esc(fmtTime(e.ts, 'time'))}</td><td>${e.success ? esc(displayText(e.tool).replace(/_/g, ' ')) : `<span class="pill urgent">${esc(displayText(e.tool).replace(/_/g, ' '))}</span>`}</td>
<td>${esc(e.user || '') || '<span class="muted">—</span>'}</td><td>${esc(e.ip || '') || '—'}</td><td class="muted" style="font-size:12px">${esc([displayCode(e.error_code), displayText(e.object)].filter(Boolean).join(' · '))}</td></tr>`
        )
        .join('')}</tbody></table></div>`
    : '<div class="card empty muted">No security events for this day.</div>';
  const viewers = new Set(views.map((e) => e.user).filter(Boolean)).size;

  return `<div class="row" style="margin:4px 0 8px"><h2 style="margin:0">Activity</h2><span style="flex:1"></span><a href="${APP_BASE}/activity/calls">Recent calls →</a><a href="${APP_BASE}/activity/disclosures">Access report →</a></div>
${filters}${summary}<h2>By tool · ${esc(day)}</h2>${metricTable}<h2>Tool calls${tool || status || call ? ' (filtered)' : ''}</h2>${list}
<p class="muted" style="font-size:13px">Every tool call the Drawbridge phone assistant makes: time, call, tool, patient ID, outcome and latency. Tool inputs, results and chart contents are never recorded here.</p>
<h2>Security events · ${esc(day)}${alerts.length ? ` <span class="pill urgent">${esc(alerts.length)} to review</span>` : ''}</h2>${securityTable}
<p class="muted" style="font-size:13px">Sign-ins, failed sign-ins, lockouts, expired passwords, emergency access, rejected tool keys and webhooks, document integrity failures and unusual export or record-view volume. Staff screens opened this day: ${esc(views.length)} by ${esc(viewers)} staff user(s); the access report lists them per patient or per user.</p>`;
}

// ── Access and disclosure report (administrators) ─────────────────────────────

const KIND_LABEL: Record<string, string> = {
  tool: 'Phone agent / tool',
  action: 'Drawbridge to Veradigm®',
  view: 'Staff viewed',
  staff: 'Staff action',
  security: 'Security event',
};

/** Rows of the report: every audit line about this patient and/or by this staff user in the range. */
export async function accessReport(q: { patient?: string; user?: string; from: string; to: string }): Promise<AuditEntry[]> {
  const patient = safeId(q.patient);
  const user = safeUser(q.user || '');
  if (!patient && !user) return [];
  return (await readAuditRange(q.from, q.to)).filter((e) => (!patient || e.patient_id === patient) && (!user || e.user === user));
}

const csvCell = (v: unknown) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // no spreadsheet formulas
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function accessReportCsv(rows: AuditEntry[]): string {
  const head = ['time_utc', 'type', 'staff_user', 'channel', 'what', 'object', 'outcome', 'error_code', 'call_id', 'patient_id'];
  const lines = rows.map((e) =>
    [e.ts, KIND_LABEL[e.kind || 'tool'] || e.kind, e.user || '', e.channel, e.tool, e.object || '', e.success ? 'ok' : 'failed', e.error_code, e.call_id, e.patient_id]
      .map(csvCell)
      .join(',')
  );
  return [head.join(','), ...lines].join('\r\n') + '\r\n';
}

function reportForm(v: { patient: string; user: string; from: string; to: string }, note = ''): string {
  return `<p><a href="${APP_BASE}/activity">← Activity</a></p><h2 style="margin-top:4px">Access and disclosure report</h2>
<form class="card row" method="post" action="${APP_BASE}/activity/disclosures" style="align-items:flex-end">
<label style="min-width:160px;flex:1">Patient ID<input name="patient" value="${esc(v.patient)}" autocomplete="off" placeholder="Veradigm® patient or chart ID"></label>
<label style="min-width:160px;flex:1">Staff user<input name="user" value="${esc(v.user)}" autocomplete="off" placeholder="Any"></label>
<label style="min-width:140px">From<input type="date" name="from" value="${esc(v.from)}" required></label>
<label style="min-width:140px">To<input type="date" name="to" value="${esc(v.to)}" required></label>
<button name="format" value="html">Show</button><button name="format" value="csv" class="secondary">Download CSV</button></form>
${note}<p class="muted" style="font-size:13px">Every Drawbridge record that touched this patient (phone-agent tool calls, Drawbridge requests to Veradigm®, staff screens and actions), or everything one staff user did, from the audit log. It supports the accounting of disclosures (HIPAA 164.528) and breach investigations. Disclosures for treatment, payment and operations and to the patient are not themselves accountable; the privacy officer prepares the accounting from this list. The audit log on this server goes back ${esc(retentionDays())} days at most (AUDIT_RETENTION_DAYS); older days are in the audit archive. Patient IDs are sent in the form, never in the address bar. Each report is itself logged.</p>`;
}

function reportTable(rows: AuditEntry[]): string {
  if (!rows.length) return '<div class="card empty muted">No audit records match.</div>';
  return `<div class="card scroll"><table><thead><tr><th>Time</th><th>Type</th><th>By</th><th>What</th><th>Object</th><th>Outcome</th><th>Call</th><th>Patient ID</th></tr></thead><tbody>${rows
    .slice()
    .reverse()
    .slice(0, 2000)
    .map(
      (e) => `<tr><td>${esc(fmtTime(e.ts))}</td><td>${esc(KIND_LABEL[e.kind || 'tool'] || e.kind)}</td><td>${esc(e.user || displayChannel(e.channel || ''))}</td><td>${esc(!e.kind || e.kind === 'tool' ? toolLabel(e.tool) : displayText(e.tool).replace(/_/g, ' '))}</td>
<td class="muted" style="font-size:12px">${esc(displayText(e.object || ''))}</td><td>${e.success ? '<span class="pill ok">ok</span>' : `<span class="pill urgent">failed</span> <span class="muted" style="font-size:12px">${esc(displayCode(e.error_code))}</span>`}</td><td style="font-size:12px">${esc(e.call_id) || '—'}</td><td>${esc(e.patient_id) || '—'}</td></tr>`
    )
    .join('')}</tbody></table>${rows.length > 2000 ? `<p class="muted" style="font-size:13px">Showing the latest 2000 of ${esc(rows.length)}. Download the CSV for all of them.</p>` : ''}</div>`;
}

const isoDay = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');

function callsPage(): string {
  const rows = recentCalls(200);
  const dur = (a: string, b: string) => {
    const s = (Date.parse(b) - Date.parse(a)) / 1000;
    return Number.isFinite(s) && s >= 0 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '—';
  };
  const list = rows.length
    ? `<div class="card scroll"><table><thead><tr><th>Started</th><th>Length</th><th>Direction</th><th>From</th><th>To</th><th>Ended because</th><th>Summary</th><th></th></tr></thead><tbody>${rows
        .map((r) => {
          const rec = callRecords.get(r.call_id);
          const day = r.start ? dayKey(new Date(r.start)) : '';
          return `<tr><td>${r.start ? esc(fmtTime(r.start)) : '<span class="muted">—</span>'}<div class="muted" style="font-size:12px">${esc(r.call_id)}</div></td>
<td>${r.start && r.end ? esc(dur(r.start, r.end)) : r.end ? '—' : '<span class="pill warn">in progress</span>'}</td><td>${esc(r.direction) || '—'}</td>
<td>${r.from_last4 ? `•••${esc(r.from_last4)}` : '—'}</td><td>${r.to_last4 ? `•••${esc(r.to_last4)}` : '—'}</td>
<td>${esc(r.disconnection_reason.replace(/_/g, ' ')) || '—'}</td><td>${r.summary_present ? '<span class="pill ok">yes</span>' : '<span class="muted">no</span>'}</td>
<td style="white-space:nowrap">${rec ? `<a href="${APP_BASE}/oncall/call/${encodeURIComponent(r.call_id)}">Call record</a> · ` : ''}<a href="${APP_BASE}/activity?${qs({ date: day, call: r.call_id })}">Tool calls</a></td></tr>`;
        })
        .join('')}</tbody></table></div>`
    : '<div class="card empty muted">No calls yet. Calls appear here once the voice agent sends call events to Drawbridge.</div>';
  return `<p><a href="${APP_BASE}/activity">← Activity</a></p><h2 style="margin-top:4px">Recent calls</h2>${list}
<p class="muted" style="font-size:13px">Phone numbers show the last four digits only. Transcripts stay with the voice platform.</p>`;
}

function eventResponse(res: Response, body: unknown): void {
  const out = handleRetellEvent(body);
  if (out.event && out.call_id) {
    console.log(`[Drawbridge] call event ${out.event} ${out.call_id}${out.record_updated ? ' (call record updated)' : ''}`);
  }
  res.status(out.status).end();
}

/**
 * POST /webhooks/retell: Retell's webhook URL. Mount BEFORE the app-wide express.json() so the raw
 * body is available for signature checks. Responds 204 on success, 401/503 when not verified.
 */
export function mountRetellWebhook(app: Express): void {
  app.post('/webhooks/retell', express.raw({ type: () => true, limit: '5mb' }), async (req: Request, res: Response) => {
    try {
      // Verify the exact bytes received (express.raw), never re-serialized JSON. If another parser ran
      // first there are no raw bytes to verify: that is a mounting error, not a bad signature.
      if (!Buffer.isBuffer(req.body)) {
        console.error('[Drawbridge] call event: raw body unavailable (a body parser ran before this route)');
        res.status(500).json({ error: 'failed' });
        return;
      }
      const v = await verifyWebhook(req.body, req.headers);
      if (!v.ok) {
        console.warn(`[Drawbridge] call event rejected (${v.status}): ${v.reason}`);
        if (v.status === 401) throttledSecurityEvent('webhook_rejected', { ip: clientIp(req), code: 'RETELL_SIGNATURE', object: '/webhooks/retell' });
        res.status(v.status).json({ error: v.status === 401 ? 'bad signature' : 'webhook not configured' });
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(req.body.toString('utf8'));
      } catch {
        res.status(400).json({ error: 'invalid json' });
        return;
      }
      eventResponse(res, body);
    } catch (e: any) {
      console.error(`[Drawbridge] call event failed: ${e?.code || e?.name || 'error'}`);
      res.status(500).json({ error: 'failed' });
    }
  });
}

export const activityModule: PlatformModule = {
  name: 'activity',
  nav: { path: '/activity', label: 'Activity', order: 40 },

  appRouter() {
    const router = Router();
    const user = (req: any) => req.drawbridgeUser as string;
    router.get('/', async (req, res) => {
      try {
        res.send(page('Activity · Drawbridge', await activityPage(req), { user: user(req), active: '/activity' }));
      } catch {
        res.status(500).send(page('Activity · Drawbridge', '<div class="card">Activity is unavailable right now.</div>', { user: user(req), active: '/activity' }));
      }
    });
    router.get('/calls', (req, res) => {
      res.send(page('Recent calls · Drawbridge', callsPage(), { user: user(req), active: '/activity' }));
    });

    // Access and disclosure report: administrators only; the patient ID travels in the POST body, never the URL.
    router.get('/disclosures', requireAdmin, (req, res) => {
      const to = dayKey();
      const from = dayKey(new Date(Date.now() - 30 * 86_400_000));
      res.send(page('Access report · Drawbridge', reportForm({ patient: '', user: '', from, to }), { user: user(req), active: '/activity' }));
    });
    router.post('/disclosures', requireAdmin, async (req, res) => {
      const v = {
        patient: safeId(req.body?.patient),
        user: safeUser(String(req.body?.user || '')),
        from: isoDay(req.body?.from),
        to: isoDay(req.body?.to),
      };
      const show = (body: string, code = 200) => res.status(code).send(page('Access report · Drawbridge', body, { user: user(req), active: '/activity' }));
      if (!v.from || !v.to || v.from > v.to || (!v.patient && !v.user)) {
        show(reportForm(v, '<div class="card" style="border-color:var(--urgent)">Enter a patient ID or a staff user, and a date range.</div>'), 400);
        return;
      }
      try {
        const rows = await accessReport(v);
        auditPatient(res, v.patient, `access_report:${v.from}:${v.to}${v.user ? `:${v.user}` : ''}`);
        recordExport(req, `access_report:${v.from}:${v.to}`, v.patient);
        if (req.body?.format === 'csv') {
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="drawbridge-access-report-${v.from}-to-${v.to}.csv"`);
          res.send(accessReportCsv(rows));
          return;
        }
        show(reportForm(v, `<h2>${esc(rows.length)} record(s)</h2>${reportTable(rows)}`));
      } catch {
        show(reportForm(v, '<div class="card">The report is unavailable right now.</div>'), 500);
      }
    });
    return router;
  },

  apiRouter() {
    const router = Router();
    router.post('/retell-events', (req, res) => {
      try {
        eventResponse(res, req.body);
      } catch (e: any) {
        console.error(`[Drawbridge] call event failed: ${e?.code || e?.name || 'error'}`);
        res.status(500).json({ error: 'failed' });
      }
    });
    return router;
  },

  start() {
    // Also pruned at the first write of each day (audit.ts); this covers days without traffic.
    startDailyRetention('audit day files', () => pruneAudit());
  },
};
