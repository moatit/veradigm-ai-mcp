import express, { Express, Request, Response, Router } from 'express';
import { PlatformModule } from '../../registry';
import { APP_BASE, esc, fmtTime, page } from '../../shell';
import { AuditEntry, auditDays, dayKey, isDayKey, pruneAudit, readAuditDay, safeId, toolMetrics } from '../../audit';
import { callRecords } from '../../../unity/oncall/call-records';
import { handleRetellEvent, recentCalls, verifyWebhook } from './retell-events';

/**
 * Drawbridge module: activity.
 *  - Staff screens: /app/activity (tool calls + per-tool metrics for a day), /app/activity/calls (recent calls)
 *  - POST /webhooks/retell (Retell call events; verified, see README) via mountRetellWebhook(app)
 *  - POST /api/activity/retell-events (same events, behind the Drawbridge tool key, for relays/tests)
 */
const LIST_MAX = 500;

/** Client-facing names: tool IDs without the internal prefix; systems by product name. */
export const toolLabel = (t: string): string => t.replace(/^(unity|drawbridge)_/, '').replace(/_/g, ' ');
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

  const entries = await readAuditDay(day);
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
<td>${e.success ? '<span class="pill ok">ok</span>' : `<span class="pill urgent">failed</span> <span class="muted" style="font-size:12px">${esc(e.error_code)}</span>`}</td>
<td>${esc(ms(e.latency_ms))}</td><td>${e.call_id ? `<a href="${APP_BASE}/activity?${qs({ date: day, call: e.call_id })}" style="font-size:12px">${esc(e.call_id)}</a>` : '<span class="muted">—</span>'}</td>
<td>${esc(e.patient_id) || '<span class="muted">—</span>'}</td><td>${esc(e.channel) || '—'}</td></tr>`
        )
        .join('')}</tbody></table>${rows.length > LIST_MAX ? `<p class="muted" style="font-size:13px">Showing the latest ${LIST_MAX} of ${esc(rows.length)}. Narrow the filters to see more.</p>` : ''}</div>`
    : '<div class="card empty muted">No tool calls match these filters.</div>';

  return `<div class="row" style="margin:4px 0 8px"><h2 style="margin:0">Activity</h2><span style="flex:1"></span><a href="${APP_BASE}/activity/calls">Recent calls →</a></div>
${filters}${summary}<h2>By tool · ${esc(day)}</h2>${metricTable}<h2>Tool calls${tool || status || call ? ' (filtered)' : ''}</h2>${list}
<p class="muted" style="font-size:13px">Every tool call the VeradigmAI agent makes through Drawbridge: time, call, tool, patient ID, outcome and latency. Tool inputs, results and chart contents are never recorded here.</p>`;
}

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
      const raw = Buffer.isBuffer(req.body)
        ? req.body.toString('utf8')
        : req.body && typeof req.body === 'object'
          ? JSON.stringify(req.body)
          : '';
      const v = await verifyWebhook(raw, req.headers);
      if (!v.ok) {
        console.warn(`[Drawbridge] call event rejected: ${v.reason}`);
        res.status(v.status).json({ error: v.reason });
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
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
    pruneAudit().then((n) => n && console.log(`[Drawbridge] audit retention: removed ${n} old day file(s)`));
  },
};
