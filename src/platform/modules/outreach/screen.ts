import { randomUUID } from 'crypto';
import { Request, Router } from 'express';
import type { PlatformDeps } from '../../registry';
import { APP_BASE, esc, fmtTime, page } from '../../shell';
import { callApproved, outboundConfig, withinCallingHours } from './dialer';
import { generateNoShows, generateRecalls, generateReminders, GenerateResult } from './generators';
import { outreachJobs } from './store';
import { MAX_ATTEMPTS, OutreachJob } from './types';
import { addDays, isoDate, maskPhone, nextBusinessDay, todayInClinic } from './util';

/**
 * Staff screen /app/outreach: generate proposed jobs from Veradigm® PM, approve or skip them,
 * and place the approved calls. Every value is rendered through esc(); phone numbers show the
 * last 4 digits only.
 */
const BASE = `${APP_BASE}/outreach`;
const TYPE_LABEL: Record<OutreachJob['type'], string> = { reminder: 'Reminder', no_show: 'No-show', recall: 'Recall' };

// One-shot flash messages (kept server side so nothing is reflected from the URL).
type Flash = { kind: 'ok' | 'warn' | 'urgent'; lines: string[] };
const flashes = new Map<string, { f: Flash; exp: number }>();
function flash(f: Flash): string {
  const id = randomUUID();
  const t = Date.now();
  for (const [k, v] of flashes) if (v.exp < t) flashes.delete(k);
  flashes.set(id, { f, exp: t + 5 * 60_000 });
  return id;
}
function takeFlash(id: unknown): Flash | null {
  if (typeof id !== 'string') return null;
  const v = flashes.get(id);
  flashes.delete(id);
  return v && v.exp > Date.now() ? v.f : null;
}

const ids = (v: unknown): string[] => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter(Boolean);
const user = (req: Request) => ((req as any).drawbridgeUser as string) || 'staff';

function statusPill(j: OutreachJob): string {
  const cls =
    j.status === 'completed' ? 'ok' : j.status === 'failed' ? 'urgent' : j.status === 'approved' || j.status === 'calling' ? 'warn' : '';
  return `<span class="pill ${cls}">${esc(j.status)}</span>`;
}

function what(j: OutreachJob): string {
  if (j.appointment) {
    const a = j.appointment;
    return `${esc(a.date)} ${esc(a.time)}${a.provider ? `<br><span class="muted">${esc(a.provider)}</span>` : ''}`;
  }
  if (j.recall) return `Due ${esc(j.recall.due)}${j.recall.type ? `<br><span class="muted">${esc(j.recall.type)}</span>` : ''}`;
  return '—';
}

function lastResult(j: OutreachJob): string {
  const r = j.last_result;
  if (!r) return '';
  const label =
    r.result === 'would_call' ? 'Dry run: would call' : r.result === 'placed' ? 'Call placed' : r.result === 'refused' ? 'Refused' : 'Call error';
  return `<div class="muted" style="font-size:12px">${esc(label)}${r.reason && r.result !== 'would_call' ? `: ${esc(r.reason)}` : ''} · ${esc(fmtTime(r.at))}</div>`;
}

function modeBanner(): string {
  const cfg = outboundConfig();
  const open = withinCallingHours();
  const allow = cfg.allowlist.length ? `${cfg.allowlist.length} number(s) allowed` : 'no allowlist (any number)';
  if (cfg.dryRun) {
    return `<div class="card row"><span class="pill warn">DRY RUN</span><span>No calls will be placed. "Call approved now" only records who <em>would</em> be called.</span>
<span class="muted" style="font-size:13px">Calling hours ${open ? 'open' : 'closed'} now · ${esc(allow)}</span></div>`;
  }
  return `<div class="card row"><span class="pill urgent">LIVE</span><span>${
    cfg.enabled ? '"Call approved now" places real phone calls.' : 'Live calling is configured but turned off (OUTBOUND_ENABLED). Calls will be refused.'
  }</span><span class="muted" style="font-size:13px">Calling hours 9 AM–7 PM ${esc(cfg.timezone)}: ${open ? 'open' : 'closed'} now · ${esc(allow)}</span></div>`;
}

function generateForms(): string {
  const nbd = isoDate(nextBusinessDay());
  const today = todayInClinic();
  return `<div class="grid">
<form class="card" method="post" action="${BASE}/generate"><input type="hidden" name="type" value="reminder"><h3 style="margin-top:0">Reminder calls</h3>
<label>Appointments on<input type="date" name="date" value="${esc(nbd)}"></label><p><button>Propose reminders</button></p></form>
<form class="card" method="post" action="${BASE}/generate"><input type="hidden" name="type" value="no_show"><h3 style="margin-top:0">No-show follow-up</h3>
<label>Missed in the last (days)<input type="number" name="days" min="1" max="30" value="3"></label><p><button>Propose no-show calls</button></p></form>
<form class="card" method="post" action="${BASE}/generate"><input type="hidden" name="type" value="recall"><h3 style="margin-top:0">Recall outreach</h3>
<div class="row" style="flex-wrap:nowrap"><label>Due from<input type="date" name="from" value="${esc(isoDate(today))}"></label>
<label>to<input type="date" name="to" value="${esc(isoDate(addDays(today, 30)))}"></label></div><p><button>Propose recall calls</button></p></form></div>`;
}

function jobTable(jobs: OutreachJob[]): string {
  if (!jobs.length) return '<div class="card empty muted">No outreach jobs yet. Propose some above.</div>';
  const rows = jobs
    .map((j) => {
      const selectable = j.status === 'proposed' || j.status === 'approved' || (j.status === 'failed' && j.attempts < MAX_ATTEMPTS);
      return `<tr>
<td>${selectable ? `<input type="checkbox" name="ids" value="${esc(j.id)}" style="width:auto" aria-label="Select">` : ''}</td>
<td>${esc(TYPE_LABEL[j.type])}</td><td>${esc(j.patient_first_name) || '<span class="muted">—</span>'}<br><span class="muted" style="font-size:12px">${esc(maskPhone(j.phone)) || 'no phone'}</span></td>
<td>${what(j)}</td><td>${statusPill(j)}${lastResult(j)}</td><td>${esc(j.attempts)}/${MAX_ATTEMPTS}</td>
<td>${esc(j.outcome || '')}${j.notes ? `<div class="muted" style="font-size:12px">${esc(j.notes)}</div>` : ''}</td>
<td class="muted" style="font-size:12px">${esc(fmtTime(j.updated_at))}${j.approved_by ? `<br>approved by ${esc(j.approved_by)}` : ''}</td></tr>`;
    })
    .join('');
  return `<form method="post" action="${BASE}/jobs" class="card">
<div class="row" style="margin-bottom:8px"><button name="action" value="approve">Approve selected</button><button class="secondary" name="action" value="skip">Skip selected</button>
<span class="muted" style="font-size:13px">Approving lets the agent call; nothing is dialed until someone clicks "Call approved now". Failed calls can be re-approved (max ${MAX_ATTEMPTS} attempts).</span></div>
<div class="scroll"><table><thead><tr><th></th><th>Type</th><th>Patient</th><th>Appointment / recall</th><th>Status</th><th>Tries</th><th>Outcome</th><th>Updated</th></tr></thead>
<tbody>${rows}</tbody></table></div></form>`;
}

function summarize(r: GenerateResult): Flash {
  const lines = [
    `${TYPE_LABEL[r.type]} (${r.window}): Veradigm® PM returned ${r.rows} row(s), ${r.matched} matched.`,
    `${r.proposed} proposed for approval${r.duplicates ? `, ${r.duplicates} already had a job` : ''}${r.unusable ? `, ${r.unusable} had no patient ID` : ''}.`,
  ];
  for (const [reason, n] of Object.entries(r.skipped)) lines.push(`Skipped ${n}: ${reason}.`);
  return { kind: 'ok', lines };
}

export function outreachRouter(deps: PlatformDeps): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const f = takeFlash(req.query.f);
    const filter = req.query.show === 'all' ? 'all' : 'open';
    const all = outreachJobs.list();
    const jobs = (filter === 'all' ? all : all.filter((j) => !['completed', 'skipped'].includes(j.status))).slice(0, 300);
    const approved = all.filter((j) => j.status === 'approved').length;
    const cfg = outboundConfig();
    const flashHtml = f
      ? `<div class="card" style="border-color:var(--${f.kind === 'ok' ? 'ok' : f.kind})">${f.lines.map((l) => `<div>${esc(l)}</div>`).join('')}</div>`
      : '';
    const callBar = `<form method="post" action="${BASE}/call" class="card row" onsubmit="return confirm(${esc(
      JSON.stringify(cfg.dryRun ? 'Dry run: record who would be called?' : `Place ${approved} real phone call(s) now?`)
    )})"><strong>${approved}</strong><span>approved job(s) waiting.</span><span style="flex:1"></span>
<button ${approved ? '' : 'disabled'}>${cfg.dryRun ? 'Call approved now (dry run)' : 'Call approved now (LIVE)'}</button></form>`;
    const tabs = `<p style="font-size:14px"><a href="${BASE}"${filter === 'open' ? ' style="font-weight:600"' : ''}>Open</a> · <a href="${BASE}?show=all"${
      filter === 'all' ? ' style="font-weight:600"' : ''
    }>All (${all.length})</a></p>`;
    res.send(
      page(
        'Outreach · Drawbridge',
        `${modeBanner()}${flashHtml}<h2>Propose calls from Veradigm® PM</h2>${generateForms()}<h2>Calls</h2>${callBar}${tabs}${jobTable(jobs)}`,
        { user: user(req), active: '/outreach' }
      )
    );
  });

  router.post('/generate', async (req, res) => {
    const type = String(req.body?.type || '');
    const by = user(req);
    let f: Flash;
    try {
      const r =
        type === 'reminder'
          ? await generateReminders(deps.unity, { date: String(req.body?.date || '') || undefined, by })
          : type === 'no_show'
            ? await generateNoShows(deps.unity, { days: Number(req.body?.days) || 3, by })
            : type === 'recall'
              ? await generateRecalls(deps.unity, { from: String(req.body?.from || '') || undefined, to: String(req.body?.to || '') || undefined, by })
              : null;
      f = r ? summarize(r) : { kind: 'warn', lines: ['Unknown outreach type.'] };
    } catch (e: any) {
      const code = e?.code || 'UNKNOWN_ERROR';
      console.error(`[Outreach] generate ${type} failed: ${code}`);
      f = {
        kind: 'urgent',
        lines: [
          code === 'VALIDATION_ERROR' ? String(e.message) : `Could not read from Veradigm® PM (${code}). Nothing was added; this does not mean there is nobody to call.`,
        ],
      };
    }
    res.redirect(`${BASE}?f=${flash(f)}`);
  });

  router.post('/jobs', (req, res) => {
    const action = String(req.body?.action || '');
    const by = user(req);
    let changed = 0;
    let ignored = 0;
    for (const id of ids(req.body?.ids)) {
      const j = outreachJobs.get(id);
      if (!j) continue;
      if (action === 'approve' && (j.status === 'proposed' || (j.status === 'failed' && j.attempts < MAX_ATTEMPTS)) && j.phone) {
        outreachJobs.update(id, by, 'approved', (x) => {
          x.status = 'approved';
          x.approved_by = by;
        });
        changed++;
      } else if (action === 'skip' && ['proposed', 'approved', 'failed'].includes(j.status)) {
        outreachJobs.update(id, by, 'skipped', (x) => {
          x.status = 'skipped';
          x.notes = x.notes || `Skipped by ${by}`;
        });
        changed++;
      } else ignored++;
    }
    const verb = action === 'approve' ? 'Approved' : action === 'skip' ? 'Skipped' : 'Changed';
    res.redirect(`${BASE}?f=${flash({ kind: changed ? 'ok' : 'warn', lines: [`${verb} ${changed} job(s).${ignored ? ` ${ignored} could not be changed in their current state.` : ''}`] })}`);
  });

  router.post('/call', async (req, res) => {
    let run;
    try {
      run = await callApproved({ by: user(req) });
    } catch (e: any) {
      console.error(`[Outreach] call run failed: ${e?.code || e?.name || 'error'}`);
      res.redirect(`${BASE}?f=${flash({ kind: 'urgent', lines: ['Something went wrong placing calls. Check job statuses before trying again.'] })}`);
      return;
    }
    const reasons = new Map<string, number>();
    for (const r of run.results) if (r.reason && r.result !== 'would_call') reasons.set(r.reason, (reasons.get(r.reason) || 0) + 1);
    const lines =
      run.mode === 'dry_run'
        ? [`DRY RUN: no calls placed. ${run.counts.would_call} would be called, ${run.counts.refused} refused.`]
        : [`LIVE: ${run.counts.placed} call(s) placed, ${run.counts.refused} refused, ${run.counts.error} failed.`];
    for (const [reason, n] of reasons) lines.push(`${n}: ${reason}`);
    if (!run.results.length) lines.push('There were no approved jobs.');
    res.redirect(`${BASE}?f=${flash({ kind: run.mode === 'live' && run.counts.placed ? 'warn' : 'ok', lines })}`);
  });

  return router;
}
