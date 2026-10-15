import { Router } from 'express';
import { PlatformModule } from '../../platform/registry';
import { APP_BASE, esc, fmtTime, page } from '../../platform/shell';
import { callRecords, CallRecord } from './call-records';
import { currentMode, getOverride, scheduledMode, setOverride } from './call-mode';
import { OnCallTools } from './oncall.tools';

/**
 * Drawbridge module: after-hours mode and the on-call notebook (spec §6).
 * Screens: /app/oncall (calls, urgent first, newest first) and /app/oncall/call/:id.
 * Agent tools: drawbridge_get_call_mode, drawbridge_save_call_record.
 */
const listOrDash = (items: string[]) =>
  items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '<span class="muted">Not captured</span>';

function detail(r: CallRecord): string {
  return `<p><a href="${APP_BASE}/oncall">← All calls</a></p>
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

const tools = new OnCallTools();

export const onCallModule: PlatformModule = {
  name: 'oncall',
  nav: { path: '/oncall', label: 'On-call', order: 10 },

  getTools: () => tools.getTools(),
  async run(name, args, ctx) {
    if (name === 'drawbridge_get_call_mode') return tools.getCallMode();
    if (name === 'drawbridge_save_call_record') return tools.saveCallRecord(args, ctx.callId, ctx.callerPhone);
    throw new Error(`Unknown tool ${name}`);
  },

  appRouter() {
    const router = Router();
    const user = (req: any) => req.drawbridgeUser as string;

    router.post('/mode', (req, res) => {
      const m = String(req.body?.mode || '');
      setOverride(m === 'after_hours' || m === 'business_hours' ? m : null);
      res.redirect(`${APP_BASE}/oncall`);
    });

    router.get('/', (req, res) => {
      const mode = currentMode();
      const override = getOverride();
      const rows = callRecords.list();
      const modeBar = `<div class="card row"><strong>Line mode:</strong>
<span class="pill ${mode === 'after_hours' ? 'urgent' : 'ok'}">${mode === 'after_hours' ? 'After hours' : 'Business hours'}</span>
<span class="muted" style="font-size:13px">${override ? 'manual override' : `by schedule (${esc(process.env.CLINIC_HOURS || 'Mon-Fri 08:00-17:00')})`}</span><span style="flex:1"></span>
<form method="post" action="${APP_BASE}/oncall/mode" style="margin:0"><input type="hidden" name="mode" value="${mode === 'after_hours' ? 'business_hours' : 'after_hours'}">
<button>Switch to ${mode === 'after_hours' ? 'business hours' : 'after hours'}</button></form>
${override ? `<form method="post" action="${APP_BASE}/oncall/mode" style="margin:0"><input type="hidden" name="mode" value=""><button class="link">Back to schedule (${scheduledMode() === 'after_hours' ? 'after hours' : 'business hours'})</button></form>` : ''}</div>`;
      const list = rows.length
        ? rows
            .map(
              (r) => `<a class="card row" href="${APP_BASE}/oncall/call/${encodeURIComponent(r.call_id)}">
<span class="pill ${r.urgency === 'urgent' ? 'urgent' : ''}">${esc(r.urgency)}</span>
<strong>${r.verified ? esc(r.patient_name || 'Verified caller') : 'Unverified caller'}</strong>
<span class="muted" style="flex:1;min-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.reason_verbatim.slice(0, 120))}</span>
<span class="muted" style="font-size:13px">${esc(fmtTime(r.started_at))}</span></a>`
            )
            .join('')
        : '<div class="card empty muted">No calls yet.</div>';
      res.send(page('On-call · Drawbridge', `${modeBar}<h2>Calls</h2>${list}`, { user: user(req), active: '/oncall' }));
    });

    router.get('/call/:id', (req, res) => {
      const r = callRecords.get(req.params.id);
      if (!r) {
        res
          .status(404)
          .send(page('Not found', `<div class="card">Call not found. <a href="${APP_BASE}/oncall">Back</a></div>`, { user: user(req), active: '/oncall' }));
        return;
      }
      res.send(page(`Call · ${r.verified ? r.patient_name : 'Unverified'}`, detail(r), { user: user(req), active: '/oncall' }));
    });

    return router;
  },
};
