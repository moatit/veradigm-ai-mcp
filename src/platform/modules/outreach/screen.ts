import { randomUUID } from 'crypto';
import { Request, Router } from 'express';
import type { PlatformDeps } from '../../registry';
import { APP_BASE, esc, fmtTime, page } from '../../shell';
import { displayText } from '../../display';
import { approveList, buildDailyList, planSummary, PlanDay, PlanSummary, TypeCounts } from './daily';
import { dialMode, outboundConfig, runDue, stopLabel } from './dialer';
import { remaining, withinCallingHours } from './scheduler';
import { CallConfirmSettings, loadSettings } from './settings';
import { runTestCalls, simulateWeek, TestCall, TranscriptLine, WeekSimResult } from './simulate';
import { outreachJobs } from './store';
import { OutreachJob, OutreachType, PlannedAttempt, RESULT_BUCKETS } from './types';
import { clinicTz, isoDate, maskPhone, parseDate, spokenDate, spokenTime, todayInClinic } from './util';

/**
 * Staff screen /app/outreach ("Call & Confirm"): today's plan by window, the one-click list approval, the
 * projected week, the Unconfirmed list, each patient's attempt timeline, opt-outs and bad-number tasks, and the
 * simulation (week and test calls, synthetic data only). Every value goes through esc(); phone numbers show the
 * last 4 digits only.
 */
const BASE = `${APP_BASE}/outreach`;
const TYPE_LABEL: Record<OutreachType, string> = { confirm: 'Confirm', no_show: 'No-show', recall: 'Recall' };
const RESULT_LABEL: Record<string, string> = {
  confirmed: 'Confirmed',
  moved: 'Moved',
  booked: 'Booked',
  cancelled: 'Cancelled',
  voicemail: 'Voicemail',
  no_answer: 'No answer',
  wrong_number: 'Wrong number',
  bad_number: 'Bad number',
  opted_out: 'Opted out',
  callback_requested: 'Callback requested',
  other: 'Answered, no change',
  would_call: 'Dry run: would call',
  error: 'Call error',
};
const TOOL_LABEL: Record<string, string> = {
  drawbridge_outreach_context: 'Call details (Drawbridge)',
  drawbridge_outreach_result: 'Record outcome (Drawbridge)',
  unity_search_patients: 'Verify name + date of birth (Veradigm® PM)',
  unity_confirm_appointment: 'Confirm visit (Veradigm® PM)',
  unity_get_open_slots: 'Open times (Veradigm® PM)',
  unity_save_appointment: 'Book visit (Veradigm® PM)',
  unity_get_cancellation_reasons: 'Cancellation reasons (Veradigm® PM)',
  unity_cancel_appointment: 'Cancel visit (Veradigm® PM)',
};

const STYLE = `<style>
.cc-head{display:flex;gap:10px 14px;align-items:center;flex-wrap:wrap}.cc-head h2{margin:4px 0}
.cc-tiles{grid-template-columns:repeat(auto-fit,minmax(118px,1fr));margin-bottom:12px}.cc-tiles .card{margin:0;padding:12px 14px}
.cc-tiles .lbl{font-size:13px;color:var(--slate)}.cc-tiles .stat{font-size:26px}
.cc-num{text-align:right;font-variant-numeric:tabular-nums}th.cc-num{text-align:right}
.cc-week td,.cc-week th{text-align:center;padding:8px 6px}.cc-week td:first-child,.cc-week th:first-child{text-align:left;padding-left:12px}
.cc-week .off{color:#9AA0B4;background:#F7F8FA}.cc-week .n{font:500 17px/1.2 var(--display)}.cc-week .mix{font-size:11px;color:var(--slate);white-space:nowrap}
.cc-week .proj{color:var(--gold-700)}.cc-today{box-shadow:inset 0 3px 0 var(--blue)}
.cc-tl{display:flex;flex-wrap:wrap;gap:4px}
.cc-at{display:inline-flex;gap:6px;align-items:center;font:500 12px/1.3 var(--text);padding:3px 8px;border:1px solid var(--line);border-left:3px solid #9AA0B4;border-radius:0 2px 2px 0;white-space:nowrap}
.cc-at.ok{border-left-color:var(--blue);background:var(--blue-50)}.cc-at.warn{border-left-color:var(--gold);background:var(--gold-50)}
.cc-at.bad{border-left-color:var(--red);background:var(--red-50)}.cc-at.next{border-style:dashed;border-left-style:solid;border-left-color:var(--ink)}
.cc-at.off{color:#9AA0B4;text-decoration:line-through}.cc-at b{font-weight:600}
.cc-tx{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.cc-line{max-width:80%;padding:8px 12px;border:1px solid var(--line);border-radius:2px;font-size:15px}
.cc-line .who{display:block;font:600 11px/1.2 var(--display);letter-spacing:.04em;text-transform:uppercase;color:var(--slate);margin-bottom:2px}
.cc-line.agent{background:var(--blue-50);border-left:3px solid var(--blue)}
.cc-line.patient,.cc-line.person{align-self:flex-end;border-right:3px solid var(--ink)}
.cc-line.tool{max-width:100%;background:#F7F8FA;border-style:dashed;font-size:13px;color:var(--slate)}
.cc-line.tool b{color:var(--ink);font-weight:600}
.cc-line.system{max-width:100%;border:0;padding:2px 0;font-style:italic;color:var(--slate);font-size:14px}
details.card>summary{cursor:pointer;list-style:none;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
details.card>summary::-webkit-details-marker{display:none}details.card>summary::before{content:"▸";color:var(--slate)}details.card[open]>summary::before{content:"▾"}
.cc-kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;font-size:14px;margin-top:10px}.cc-kv dt{color:var(--slate)}
.cc-bar{display:flex;height:12px;margin:8px 0 4px;border:1px solid var(--line)}.cc-bar span{display:block;height:100%}
.cc-legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:13px}.cc-legend i{display:inline-block;width:10px;height:10px;margin-right:5px;vertical-align:-1px}
.cc-note{font-size:13px;color:var(--slate)}
</style>`;

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

// Latest simulation runs (synthetic data only, in memory).
let lastWeek: { at: string; by: string; result: WeekSimResult } | null = null;
let lastCalls: { at: string; by: string; calls: TestCall[] } | null = null;

const shortDay = (iso: string) => {
  const c = parseDate(iso);
  return c ? new Date(Date.UTC(c.y, c.m - 1, c.d, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'numeric', day: 'numeric' }) : iso;
};
const win = (w: string) => w.replace('-', '–');

function modeBanner(s: CallConfirmSettings, now: Date): string {
  const cfg = outboundConfig(s);
  const mode = dialMode(s);
  const open = withinCallingHours(now, s);
  const pills =
    (mode === 'live' ? '<span class="pill urgent">LIVE</span>' : '<span class="pill warn">DRY RUN</span>') +
    (s.enabled ? '<span class="pill ok">Scheduler on</span>' : '<span class="pill">Scheduler off</span>');
  const what =
    mode === 'live'
      ? cfg.enabled && cfg.allowlist.length
        ? `Approved calls are placed to the ${cfg.allowlist.length} test number(s) on the allowlist only.`
        : 'Live mode is set but refused: OUTBOUND_ENABLED and a test allowlist are both required.'
      : 'No calls are placed. Approved attempts are recorded as “would call”.';
  return `<div class="card row">${pills}<span>${esc(what)}</span><span class="muted" style="font-size:13px">Calling hours ${esc(win(s.limits.calling_hours))} ${esc(clinicTz())}, weekdays${
    s.limits.holidays.length ? `, ${esc(s.limits.holidays.length)} holiday(s) off` : ''
  } · ${open ? 'open now' : 'closed now'}</span></div>`;
}

const typeMix = (c: TypeCounts) =>
  (['confirm', 'no_show', 'recall'] as OutreachType[])
    .filter((t) => c[t])
    .map((t) => `${TYPE_LABEL[t]} ${c[t]}`)
    .join(' · ');

function todayCard(day: PlanDay, s: CallConfirmSettings): string {
  const list = day.list;
  const pending = list?.pending_approval || 0;
  const status = !day.calling_day
    ? '<span class="pill">Not a calling day</span>'
    : !list
      ? `<span class="pill warn">List not built yet</span><span class="muted">It builds at 07:00${s.enabled ? '' : ' when the scheduler is on'}; you can build it now.</span>`
      : pending
        ? `<span class="pill warn">Waiting for approval</span><span>${esc(pending)} call attempt(s) on today's list.</span>`
        : `<span class="pill ok">Approved</span><span>${esc(list.entries)} attempt(s)${list.approved_by ? ` · approved by ${esc(list.approved_by)} at ${esc(fmtTime(list.approved_at!, 'time'))}` : ''}</span>`;
  const approve = pending
    ? `<form method="post" action="${BASE}/approve" data-confirm="${esc(`Approve today's list (${pending} call attempt(s))?`)}"><button>Approve today's list (${esc(pending)})</button></form>`
    : '';
  return `<div class="card"><div class="row">${status}<span style="flex:1"></span>${approve}
<form method="post" action="${BASE}/build"><button class="secondary">${list ? 'Rebuild list from Veradigm® PM' : "Build today's list now"}</button></form>
<form method="post" action="${BASE}/run" data-confirm="${esc(dialMode(s) === 'live' ? 'Place the approved calls that are due now?' : 'Record the approved calls that are due now (dry run)?')}"><button class="secondary">Run due calls now</button></form></div>
${list?.built_at ? `<p class="cc-note" style="margin:8px 0 0">Built ${esc(fmtTime(list.built_at, 'time'))}. Staff approve the whole list once; nothing is called before that.</p>` : ''}</div>`;
}

function resultTiles(day: PlanDay): string {
  const tile = (n: number, label: string, tone = '') =>
    `<div class="card"><div class="stat"${tone && n ? ` style="color:var(--${tone})"` : ''}>${esc(n)}</div><div class="lbl">${esc(label)}</div></div>`;
  const r = day.results;
  return `<div class="grid cc-tiles">${tile(day.planned.total, 'Planned today')}${tile(r.confirmed, 'Confirmed', 'ok')}${tile(r.moved, 'Moved', 'ok')}${tile(
    r.cancelled,
    'Cancelled'
  )}${tile(r.voicemail, 'Voicemail')}${tile(r.no_answer, 'No answer')}${tile(r.opted_out, 'Opted out', 'warn')}${tile(r.bad_number, 'Bad number', 'urgent')}${
    day.would_call ? tile(day.would_call, 'Dry run: would call') : ''
  }</div>`;
}

function todayByWindow(day: PlanDay): string {
  if (!day.calling_day) return '<div class="card empty muted">No calls today (weekend or holiday).</div>';
  const rows = day.windows
    .map(
      (w) => `<tr><td><strong>${esc(win(w.window))}</strong></td><td class="cc-num">${esc(w.planned.confirm)}</td><td class="cc-num">${esc(w.planned.no_show)}</td><td class="cc-num">${esc(
        w.planned.recall
      )}</td><td class="cc-num"><strong>${esc(w.planned.total)}</strong></td><td class="cc-num muted">${w.projected.total ? esc(w.projected.total) : '—'}</td></tr>`
    )
    .join('');
  return `<div class="card scroll"><table><thead><tr><th>Window</th><th class="cc-num">Confirm</th><th class="cc-num">No-show</th><th class="cc-num">Recall</th><th class="cc-num">Total</th><th class="cc-num">Projected</th></tr></thead>
<tbody>${rows}<tr><td><strong>Day</strong></td><td class="cc-num">${esc(day.planned.confirm)}</td><td class="cc-num">${esc(day.planned.no_show)}</td><td class="cc-num">${esc(
    day.planned.recall
  )}</td><td class="cc-num"><strong>${esc(day.planned.total)}</strong></td><td class="cc-num muted">${day.projected.total ? esc(day.projected.total) : '—'}</td></tr></tbody></table></div>`;
}

/** Days across, windows down: planned (and projected, in gold) per cell with the type mix. */
export function weekGrid(p: PlanSummary, note = ''): string {
  const windows = [...new Set(p.days.flatMap((d) => d.windows.map((w) => w.window)))].sort();
  const head = p.days.map((d, i) => `<th class="${i === 0 ? 'cc-today' : ''}${d.calling_day ? '' : ' off'}">${esc(shortDay(d.date))}</th>`).join('');
  const cell = (d: PlanDay, w: string) => {
    if (!d.calling_day) return '<td class="off">—</td>';
    const x = d.windows.find((y) => y.window === w);
    const n = (x?.planned.total || 0) + (x?.projected.total || 0);
    if (!x || !n) return '<td class="muted">0</td>';
    const mix = typeMix({
      confirm: x.planned.confirm + x.projected.confirm,
      no_show: x.planned.no_show + x.projected.no_show,
      recall: x.planned.recall + x.projected.recall,
      total: n,
    });
    return `<td><div class="n">${esc(n)}</div><div class="mix">${esc(mix)}</div>${x.projected.total ? `<div class="mix proj">${esc(x.projected.total)} projected</div>` : ''}</td>`;
  };
  const rows = windows.map((w) => `<tr><td><strong>${esc(win(w))}</strong></td>${p.days.map((d) => cell(d, w)).join('')}</tr>`).join('');
  const totals = p.days
    .map((d) => (d.calling_day ? `<td><strong>${esc(d.planned.total + d.projected.total)}</strong></td>` : '<td class="off">—</td>'))
    .join('');
  return `<div class="card scroll"><table class="cc-week"><thead><tr><th>Window</th>${head}</tr></thead><tbody>${rows}<tr><td><strong>Day total</strong></td>${totals}</tr></tbody></table>
<p class="cc-note" style="margin:8px 0 0">${esc(
    note ||
      'Planned = attempts already scheduled for known patients. Projected (gold) = confirmation calls expected for visits further out that are not on a list yet. No-show calls appear the morning after a missed visit.'
  )}</p></div>`;
}

function attemptChip(a: PlannedAttempt, job: OutreachJob): string {
  const label = `${shortDay(a.date)} ${win(a.window)}`;
  let cls = '';
  let what = '';
  if (a.state === 'done') {
    what = RESULT_LABEL[a.result || ''] || a.result || 'done';
    cls = ['confirmed', 'moved', 'booked', 'cancelled'].includes(a.result || '') ? 'ok' : a.result === 'wrong_number' || a.result === 'error' ? 'bad' : a.result === 'opted_out' ? 'warn' : '';
  } else if (a.state === 'stopped') {
    what = a.result?.startsWith('stop:') ? `not needed: ${stopLabel(a.result.slice(5) as any).toLowerCase()}` : 'not needed';
    cls = 'off';
  } else if (a.state === 'missed' || a.state === 'dropped') {
    what = a.note || a.state;
    cls = 'off';
  } else {
    what = a.state === 'approved' ? 'approved' : a.state === 'listed' ? 'on today’s list' : 'planned';
    cls = remaining(job)[0]?.n === a.n ? 'next' : '';
  }
  return `<span class="cc-at ${cls}" title="${esc(a.note || '')}"><b>#${esc(a.n)}</b>${esc(label)}${a.last && a.state !== 'dropped' ? ' · voicemail ok' : ''} · ${esc(what)}</span>`;
}

function what(j: OutreachJob): string {
  if (j.appointment) {
    const a = j.appointment;
    return `${esc(spokenDate(a.date))}${a.time ? ` ${esc(spokenTime(a.time))}` : ''}${a.provider ? `<br><span class="muted">${esc(a.provider)}</span>` : ''}`;
  }
  if (j.recall) return `Due ${esc(j.recall.due)}${j.recall.type ? `<br><span class="muted">${esc(j.recall.type)}</span>` : ''}`;
  return '—';
}

function statusPill(j: OutreachJob): string {
  const cls = j.status === 'completed' ? 'ok' : j.status === 'unconfirmed' || j.status === 'stopped' ? 'warn' : j.status === 'approved' || j.status === 'calling' ? 'ok' : '';
  const label = j.status === 'stopped' && j.stop ? `stopped: ${stopLabel(j.stop.reason).toLowerCase()}` : j.status;
  return `<span class="pill ${cls}">${esc(label)}</span>`;
}

function jobTable(jobs: OutreachJob[], empty: string, selectable = true): string {
  if (!jobs.length) return `<div class="card empty muted">${esc(empty)}</div>`;
  const rows = jobs
    .map(
      (j) => `<tr>
<td>${selectable && ['scheduled', 'approved'].includes(j.status) ? `<input type="checkbox" name="ids" value="${esc(j.id)}" style="width:auto" aria-label="Select">` : ''}</td>
<td>${esc(TYPE_LABEL[j.type])}${j.plan_kind === 'short' ? '<div class="muted" style="font-size:12px">booked &lt;3 days out</div>' : ''}</td>
<td>${esc(j.patient_first_name) || '<span class="muted">—</span>'}<br><span class="muted" style="font-size:12px">${esc(maskPhone(j.phone)) || 'no phone'}</span></td>
<td>${what(j)}</td><td>${statusPill(j)}${j.notes ? `<div class="muted" style="font-size:12px">${esc(displayText(j.notes))}</div>` : ''}</td>
<td><div class="cc-tl">${j.plan.map((a) => attemptChip(a, j)).join('') || '<span class="muted">—</span>'}</div></td></tr>`
    )
    .join('');
  const table = `<div class="scroll"><table><thead><tr><th></th><th>Type</th><th>Patient</th><th>Visit / recall</th><th>Status</th><th>Attempts</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  return selectable
    ? `<form method="post" action="${BASE}/jobs" class="card"><div class="row" style="margin-bottom:8px"><button class="secondary" name="action" value="skip">Stop calling selected</button>
<span class="cc-note">Stops the remaining attempts for the selected patients (for example, staff already reached them).</span></div>${table}</form>`
    : `<div class="card">${table}</div>`;
}

function badNumbers(jobs: OutreachJob[], optedOut: number): string {
  const bad = jobs.filter((j) => j.staff_task);
  const rows = bad
    .slice(0, 50)
    .map(
      (j) =>
        `<tr><td>${esc(j.patient_first_name)}</td><td class="muted">${esc(maskPhone(j.phone)) || 'none on file'}</td><td>${esc(TYPE_LABEL[j.type])}</td><td>${
          j.staff_task!.state === 'created'
            ? '<span class="pill ok">Staff task created</span>'
            : j.staff_task!.state === 'dry_run'
              ? '<span class="pill">Dry run: would create task</span>'
              : j.staff_task!.state === 'failed'
                ? '<span class="pill urgent">Task failed: create it by hand</span>'
                : '<span class="pill warn">Task queued</span>'
        }</td><td class="muted" style="font-size:12px">${esc(fmtTime(j.staff_task!.at))}</td></tr>`
    )
    .join('');
  return `<div class="grid" style="grid-template-columns:minmax(200px,1fr) 3fr"><div class="card"><div class="stat">${esc(optedOut)}</div><div class="muted">patient(s) opted out. They are never called again by Call &amp; Confirm.</div></div>
<div class="card">${
    bad.length
      ? `<div class="scroll"><table><thead><tr><th>Patient</th><th>Number</th><th>Call type</th><th>Fix-the-number task</th><th>When</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="muted">No bad numbers so far. A number that does not work stops the calls and creates a staff task to fix it.</div>'
  }</div></div>`;
}

const BUCKET_COLOR: Record<string, string> = {
  confirmed: 'var(--blue-700)',
  moved: 'var(--blue)',
  cancelled: 'var(--navy)',
  voicemail: '#9AA0B4',
  no_answer: '#C9CED9',
  opted_out: 'var(--gold)',
  bad_number: 'var(--red)',
  callback_requested: 'var(--gold-700)',
  other: '#E3E6EC',
};

function weekSimCard(): string {
  if (!lastWeek) return '<div class="card muted">Not run yet. “Simulate a week” builds a synthetic clinic (5 providers, about 65 visits a day) and runs the real scheduler over 7 days.</div>';
  const w = lastWeek.result;
  const total = Object.values(w.outcomes).reduce((a, b) => a + b, 0) || 1;
  const order = [...RESULT_BUCKETS, 'callback_requested', 'other'];
  const bar = order
    .filter((k) => w.outcomes[k])
    .map((k) => `<span style="width:${((w.outcomes[k] / total) * 100).toFixed(2)}%;background:${BUCKET_COLOR[k]}" title="${esc(RESULT_LABEL[k] || k)}"></span>`)
    .join('');
  const legend = order
    .filter((k) => w.outcomes[k])
    .map((k) => `<span><i style="background:${BUCKET_COLOR[k]}"></i>${esc(RESULT_LABEL[k] || k)} ${esc(w.outcomes[k])} (${esc(Math.round((w.outcomes[k] / total) * 100))}%)</span>`)
    .join('');
  const windows = w.days[0]?.by_window.map((x) => x.window) || [];
  const rows = windows
    .map(
      (wn) =>
        `<tr><td><strong>${esc(win(wn))}</strong></td>${w.days
          .map((d) => {
            const x = d.by_window.find((y) => y.window === wn)!;
            return d.calling_day ? `<td><div class="n">${esc(x.total)}</div><div class="mix">${esc(typeMix({ ...x }))}</div></td>` : '<td class="off">—</td>';
          })
          .join('')}</tr>`
    )
    .join('');
  const stops = Object.entries(w.stopped_before_call)
    .map(([k, n]) => `${stopLabel(k as any)}: ${n}`)
    .join(' · ');
  const writes = Object.entries(w.writes)
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ');
  return `<div class="card"><div class="row"><strong>Week of ${esc(spokenDate(w.start))}</strong><span class="muted">${esc(w.scale.visits)} visits (${esc(
    w.scale.visits_per_calling_day
  )} a day, ${esc(w.scale.providers)} providers) · ${esc(w.calls)} simulated calls · about ${esc(w.call_minutes)} phone minutes</span><span style="flex:1"></span>
${w.limit_violations === 0 && w.only_allowed_writes ? '<span class="pill ok">Call limits and write rules held</span>' : '<span class="pill urgent">Rule check failed</span>'}</div>
<div class="cc-bar">${bar}</div><div class="cc-legend">${legend}</div>
<dl class="cc-kv"><dt>Calls by type</dt><dd>Confirm ${esc(w.calls_by_type.confirm)} · No-show ${esc(w.calls_by_type.no_show)} · Recall ${esc(w.calls_by_type.recall)}</dd>
<dt>Stopped before a call</dt><dd>${esc(stops || 'none')}</dd>
<dt>Voicemails</dt><dd>${esc(w.voicemails_left)} message(s) left on final attempts; ${esc(w.voicemails_without_message)} earlier voicemail(s) hung up without a message</dd>
<dt>Unconfirmed after the week</dt><dd>${esc(w.unconfirmed)} (shown on the huddle brief)</dd>
<dt>Bad numbers</dt><dd>${esc(w.staff_tasks)} staff task(s) to fix the number · ${esc(w.opted_out)} opted out</dd>
<dt>Veradigm® PM writes</dt><dd>${esc(writes || 'none')}</dd></dl>
<h3>Calls made per day and window</h3><div class="scroll"><table class="cc-week"><thead><tr><th>Window</th>${w.days
    .map((d) => `<th class="${d.calling_day ? '' : 'off'}">${esc(shortDay(d.date))}</th>`)
    .join('')}</tr></thead><tbody>${rows}</tbody></table></div>
<p class="cc-note">Synthetic patients and phone numbers only; no call was placed. Run ${esc(fmtTime(lastWeek.at))} by ${esc(lastWeek.by)}.</p></div>
<h3>Projected week (as staff saw it on the first morning)</h3>${weekGrid(w.projected, 'From the simulated first morning: planned attempts plus projected confirmation calls.')}`;
}

function transcriptLine(l: TranscriptLine): string {
  if (l.who === 'tool') return `<div class="cc-line tool"><b>${esc(TOOL_LABEL[l.tool || ''] || l.tool)}</b> → ${esc(l.text)}</div>`;
  if (l.who === 'system') return `<div class="cc-line system">${esc(l.text)}</div>`;
  const who = l.who === 'agent' ? 'Drawbridge agent' : l.who === 'patient' ? 'Patient' : 'Person who answered';
  return `<div class="cc-line ${l.who}"><span class="who">${esc(who)}</span>${esc(l.text)}</div>`;
}

function testCallsCard(): string {
  if (!lastCalls) return '<div class="card muted">Not run yet. “Run the 7 test calls” plays one call for each outcome through the real call path against a test copy of Veradigm® PM.</div>';
  return lastCalls.calls
    .map(
      (c, i) => `<details class="card"${i < 2 ? ' open' : ''}><summary><strong>${esc(c.title)}</strong><span class="pill ${c.passed ? 'ok' : 'urgent'}">${esc(
        RESULT_LABEL[c.result.recorded_outcome] || c.result.recorded_outcome
      )}</span><span class="muted" style="font-size:13px">${esc(c.attempt)}</span></summary>
<div class="cc-tx">${c.transcript.map(transcriptLine).join('')}</div>
<dl class="cc-kv"><dt>Result</dt><dd>${esc(c.result.next)}</dd>
<dt>Veradigm® PM writes</dt><dd>${esc(c.writes.length ? c.writes.join(' · ') : 'none')}</dd>
${c.core_message_seconds !== null ? `<dt>Reason for the call said</dt><dd>about ${esc(c.core_message_seconds)} s after pickup</dd>` : ''}</dl></details>`
    )
    .join('');
}

function settingsCard(s: CallConfirmSettings): string {
  const row = (t: OutreachType, list: Array<{ window: string; days_before?: number; day_offset?: number }>) =>
    `<tr><td>${esc(TYPE_LABEL[t])}${s.call_types[t] ? '' : ' <span class="pill">off</span>'}</td>${[0, 1, 2]
      .map((i) => {
        const a = list[i];
        if (!a) return '<td class="muted">—</td>';
        const day = a.days_before !== undefined ? `${a.days_before} business day(s) before` : a.day_offset === 0 ? 'Day 0' : `Day ${a.day_offset}`;
        return `<td>${esc(day)}<br><span class="muted">${esc(win(a.window))}</span></td>`;
      })
      .join('')}</tr>`;
  return `<details class="card"><summary><strong>Settings for this practice</strong><span class="muted" style="font-size:13px">Changed in the Drawbridge admin console</span></summary>
<div class="scroll" style="margin-top:10px"><table><thead><tr><th>Call type</th><th>Attempt 1</th><th>Attempt 2</th><th>Attempt 3</th></tr></thead><tbody>
${row('confirm', s.confirm.attempts)}${row('no_show', s.no_show.attempts)}${row('recall', s.recall.attempts)}</tbody></table></div>
<p class="cc-note">Confirm visits booked under 3 business days out: next morning, then the day before in the late-afternoon window. Limits per patient across all call types: ${esc(
    s.limits.max_per_day
  )} a day, ${esc(s.limits.max_per_7_days)} in any 7 days, weekdays${s.limits.holidays.length ? `, not on ${esc(s.limits.holidays.join(', '))}` : ''}, inside ${esc(
    win(s.limits.calling_hours)
  )}. Voicemail: ${s.voicemail === 'last_attempt' ? 'final attempt only, with no details' : 'never'}. Every call offers an opt-out.</p></details>`;
}

/** `clock` is for tests (a fixed weekday); the screen otherwise uses the real time. */
export function outreachRouter(deps: PlatformDeps, clock: () => Date = () => new Date()): Router {
  const router = Router();
  const ctx = (req: Request) => {
    const settings = loadSettings();
    return { unity: deps.unity, store: outreachJobs, settings, now: clock(), by: user(req) };
  };

  router.get('/', (req, res) => {
    const f = takeFlash(req.query.f);
    const settings = loadSettings();
    const now = clock();
    const plan = planSummary(outreachJobs, settings, now, 8);
    const today = plan.days[0];
    const all = outreachJobs.list();
    const show = req.query.show === 'all' ? 'all' : req.query.show === 'done' ? 'done' : 'open';
    const active = all.filter((j) => ['scheduled', 'approved', 'calling'].includes(j.status));
    const finished = all.filter((j) => !['scheduled', 'approved', 'calling'].includes(j.status) && j.status !== 'unconfirmed');
    const shown = (show === 'all' ? all : show === 'done' ? finished : active).slice(0, 200);
    const unconfirmed = all.filter((j) => j.status === 'unconfirmed');
    const flashHtml = f
      ? `<div class="card" style="border-color:var(--${f.kind === 'ok' ? 'ok' : f.kind})">${f.lines.map((l) => `<div>${esc(displayText(l))}</div>`).join('')}</div>`
      : '';
    const tab = (k: string, label: string) => `<a href="${BASE}${k === 'open' ? '' : `?show=${k}`}#patients"${show === k ? ' style="font-weight:600"' : ''}>${esc(label)}</a>`;
    const listSummary = outreachJobs.getList(today.date)?.summary || [];
    const body = `${STYLE}<div class="cc-head"><h2>Call &amp; Confirm</h2><span class="muted">${esc(spokenDate(today.date))}</span></div>
${modeBanner(settings, now)}${flashHtml}
${todayCard(today, settings)}
${listSummary.length ? `<details class="card"><summary><strong>What the 07:00 list found in Veradigm® PM</strong></summary><ul class="cc-note" style="margin-top:8px">${listSummary.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></details>` : ''}
<h2>Today's plan by window</h2>${resultTiles(today)}${todayByWindow(today)}
<h2>Projected week</h2>${weekGrid(plan)}
<h2 id="unconfirmed">Unconfirmed <span class="muted" style="font-weight:400;font-size:16px">· ${esc(unconfirmed.length)}</span></h2>
<p class="cc-note" style="margin-top:-6px">Every attempt went unanswered. These visits are flagged on the huddle brief for staff to call.</p>
${jobTable(unconfirmed, 'Nothing unconfirmed.', false)}
<h2 id="patients">Patients and attempts</h2><p style="font-size:14px">${tab('open', `Active (${active.length})`)} · ${tab('done', `Finished (${finished.length})`)} · ${tab('all', `All (${all.length})`)}</p>
${jobTable(shown, show === 'open' ? 'No active calls. Build today’s list to start.' : 'Nothing here yet.')}
<h2 id="optouts">Opt-outs and bad numbers</h2>${badNumbers(all, plan.opted_out)}
<h2 id="sim">Simulation and test calls</h2>
<div class="card row"><span>Synthetic patients only. Nothing is dialed and the real call list is not touched.</span><span style="flex:1"></span>
<form method="post" action="${BASE}/simulate/week"><button class="secondary">Simulate a week</button></form>
<form method="post" action="${BASE}/simulate/calls"><button>Run the 7 test calls</button></form></div>
<h3>Test calls</h3>${testCallsCard()}
<h3>Simulated week</h3>${weekSimCard()}
<h2>Settings</h2>${settingsCard(settings)}`;
    res.send(page('Call & Confirm · Drawbridge', body, { user: user(req), active: '/outreach' }));
  });

  router.post('/build', async (req, res) => {
    let f: Flash;
    try {
      const list = await buildDailyList(ctx(req));
      f = { kind: 'ok', lines: [`Today's list: ${list.entries.length} call attempt(s). Approve it to let them go out.`, ...list.summary] };
    } catch (e: any) {
      const code = e?.code || 'UNKNOWN_ERROR';
      console.error(`[Outreach] list build failed: ${code}`);
      f = { kind: 'urgent', lines: [`Could not read from Veradigm® PM (${code}). The list was not built; this does not mean there is nobody to call.`] };
    }
    res.redirect(`${BASE}?f=${flash(f)}`);
  });

  router.post('/approve', (req, res) => {
    const now = clock();
    const n = approveList(outreachJobs, isoDate(todayInClinic(now)), user(req), now);
    res.redirect(`${BASE}?f=${flash({ kind: n ? 'ok' : 'warn', lines: [n ? `Approved ${n} call attempt(s) for today.` : 'Nothing was waiting for approval.'] })}`);
  });

  router.post('/run', async (req, res) => {
    const c = ctx(req);
    if (!c.settings.enabled) {
      res.redirect(`${BASE}?f=${flash({ kind: 'warn', lines: ['Call & Confirm is turned off in settings, so no calls run.'] })}`);
      return;
    }
    const mode = dialMode(c.settings);
    let run;
    try {
      run = await runDue({ ...c, mode, writes: mode === 'live' });
    } catch (e: any) {
      console.error(`[Outreach] call run failed: ${e?.code || e?.name || 'error'}`);
      res.redirect(`${BASE}?f=${flash({ kind: 'urgent', lines: ['Something went wrong running calls. Check the attempts before trying again.'] })}`);
      return;
    }
    const reasons = new Map<string, number>();
    for (const r of run.results) if (r.reason) reasons.set(r.reason, (reasons.get(r.reason) || 0) + 1);
    const lines =
      run.mode === 'dry_run'
        ? [`DRY RUN: no calls placed. ${run.counts.would_call} would be called, ${run.counts.stopped} stopped, ${run.counts.refused} refused.`]
        : [`LIVE: ${run.counts.placed} call(s) placed, ${run.counts.stopped} stopped, ${run.counts.refused} refused, ${run.counts.error} failed.`];
    for (const [reason, n] of reasons) lines.push(`${n}: ${reason}`);
    if (!run.results.length) lines.push('No approved attempt is due right now.');
    res.redirect(`${BASE}?f=${flash({ kind: run.mode === 'live' && run.counts.placed ? 'warn' : 'ok', lines })}`);
  });

  router.post('/jobs', (req, res) => {
    const by = user(req);
    let changed = 0;
    if (String(req.body?.action || '') === 'skip') {
      for (const id of ids(req.body?.ids)) {
        const j = outreachJobs.get(id);
        if (!j || !['scheduled', 'approved'].includes(j.status)) continue;
        outreachJobs.update(id, by, 'skipped', (x) => {
          for (const a of remaining(x)) {
            a.state = 'stopped';
            a.result = 'stop:staff';
          }
          x.status = 'skipped';
          x.notes = x.notes || `Stopped by ${by}`;
        });
        changed++;
      }
    }
    res.redirect(`${BASE}?f=${flash({ kind: changed ? 'ok' : 'warn', lines: [`Stopped calls for ${changed} patient(s).`] })}#patients`);
  });

  router.post('/simulate/week', async (req, res) => {
    try {
      lastWeek = { at: new Date().toISOString(), by: user(req), result: await simulateWeek({ settings: loadSettings() }) };
      res.redirect(`${BASE}?f=${flash({ kind: 'ok', lines: [`Simulated week: ${lastWeek.result.calls} simulated calls. Synthetic data only.`] })}#sim`);
    } catch (e: any) {
      console.error(`[Outreach] simulate week failed: ${e?.code || e?.name || 'error'}`);
      res.redirect(`${BASE}?f=${flash({ kind: 'urgent', lines: ['The simulation failed. Nothing was changed.'] })}#sim`);
    }
  });

  router.post('/simulate/calls', async (req, res) => {
    try {
      lastCalls = { at: new Date().toISOString(), by: user(req), calls: await runTestCalls({ settings: loadSettings() }) };
      const failed = lastCalls.calls.filter((c) => !c.passed).length;
      res.redirect(`${BASE}?f=${flash({ kind: failed ? 'urgent' : 'ok', lines: [`7 test calls played${failed ? `; ${failed} did not end as expected` : ', all ended as expected'}. No call was placed.`] })}#sim`);
    } catch (e: any) {
      console.error(`[Outreach] test calls failed: ${e?.code || e?.name || 'error'}`);
      res.redirect(`${BASE}?f=${flash({ kind: 'urgent', lines: ['The test calls failed. Nothing was changed.'] })}#sim`);
    }
  });

  return router;
}
