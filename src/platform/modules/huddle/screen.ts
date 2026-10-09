import { APP_BASE, esc, fmtTime, page } from '../../shell';
import { COULDNT_CHECK, Check, HuddleBrief, HuddleService, HuddleVisit } from './brief';
import { dateLabel, money } from './dates';

/**
 * Staff screen /app/huddle: date picker, summary tiles, visits grouped by provider and time,
 * flag pills, print-friendly. Every value goes through esc().
 */
const STYLE = `<style>
.hd-tools{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}.hd-tools label{display:flex;flex-direction:column;font-size:13px;color:var(--muted)}
.hd-tools input{width:auto}.hd-tiles{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}.hd-tiles .card{margin:0}
.hd-tiles .lbl{font-size:13px;color:var(--muted)}.pill.info{background:var(--line);color:var(--ink)}
.pill.unknown{background:transparent;color:var(--muted);border:1px dashed var(--muted)}
.hd-cant{color:var(--muted);font-style:italic}.hd-flags .pill{display:inline-block;margin:0 4px 4px 0}
.banner{border-left:4px solid var(--urgent);background:var(--urgent-bg)}.banner.warn{border-left-color:var(--warn);background:var(--warn-bg)}
.hd-prov h3{margin-top:0}.hd-time{white-space:nowrap;font-weight:600}
@media print{
 header,nav.tabs,.no-print,button,form{display:none!important}
 body{background:#fff;color:#000;font-size:12px}main{max-width:none;padding:0}
 .card{border:1px solid #999;break-inside:avoid;page-break-inside:avoid;box-shadow:none}
 .pill{border:1px solid #777;background:#fff!important;color:#000!important}
 a{color:#000;text-decoration:none}.scroll{overflow:visible}
}
</style>`;

const cell = (c: Check<any>, ok: (v: any) => string): string =>
  c.ok ? ok(c.value) : `<span class="hd-cant" title="${esc(c.code)}">${esc(COULDNT_CHECK)}</span>`;

function visitRow(v: HuddleVisit): string {
  const flags = v.flags.length
    ? v.flags.map((f) => `<span class="pill ${esc(f.tone)}">${esc(f.label)}</span>`).join('')
    : '<span class="muted">—</span>';
  return `<tr>
<td class="hd-time">${esc(v.time) || '<span class="muted">—</span>'}</td>
<td><strong>${esc(v.patientName)}</strong>${v.status ? `<div class="muted" style="font-size:12px">${esc(v.status)}</div>` : ''}</td>
<td>${esc(v.visitType) || '<span class="muted">—</span>'}</td>
<td>${cell(v.balance, (n: number) => (n > 0 ? `<strong>${esc(money(n))}</strong>` : n < 0 ? `Credit ${esc(money(-n))}` : 'None due'))}</td>
<td>${cell(v.insurance, (i: { carrier: string; policies: number }) => (i.policies === 0 ? '<strong>None on file</strong>' : esc(i.carrier || 'On file')))}</td>
<td>${cell(v.allergies, (n: number) => (n > 0 ? `${esc(n)} on file` : 'None on file'))}</td>
<td>${cell(v.problems, (n: number) => (n > 0 ? `${esc(n)} on file` : 'None on file'))}</td>
<td class="hd-flags">${flags}</td></tr>`;
}

function tiles(b: HuddleBrief): string {
  const s = b.summary;
  const tile = (n: number, label: string, tone = '') =>
    `<div class="card"><div class="stat"${tone ? ` style="color:var(--${tone})"` : ''}>${esc(n)}</div><div class="lbl">${esc(label)}</div></div>`;
  return `<div class="grid hd-tiles">
${tile(s.visits, 'Visits')}${tile(s.providers, 'Providers')}
${tile(s.balancesDue, 'Balances due', s.balancesDue ? 'warn' : '')}
${tile(s.missingInsurance, 'Missing insurance', s.missingInsurance ? 'urgent' : '')}
${tile(s.failedChecks, "Checks that couldn't run", s.failedChecks ? 'urgent' : '')}
${s.newPatients ? tile(s.newPatients, 'New patients') : ''}</div>`;
}

export interface HuddleView {
  dateKey: string;
  brief?: HuddleBrief;
  error?: { code: string; retryable: boolean };
  user?: string | null;
}

export function renderHuddle(view: HuddleView): string {
  const { dateKey, brief, error } = view;
  const tools = `<form method="get" action="${APP_BASE}/huddle" class="card hd-tools no-print">
<label>Date<input type="date" name="date" value="${esc(dateKey)}" required></label>
<button>Show</button>
<button name="refresh" value="1" class="secondary">Refresh from Veradigm® PM</button>
<button type="button" class="secondary" onclick="window.print()">Print</button></form>`;

  let body = `${STYLE}${tools}<h2 style="margin-top:14px">Huddle brief · ${esc(dateLabel(dateKey))}</h2>`;

  if (error) {
    body += `<div class="card banner" role="alert"><strong>Couldn't reach Veradigm® PM.</strong>
The schedule for ${esc(dateLabel(dateKey))} couldn't be loaded, so no brief is shown. This does not mean the day is empty.
${error.retryable ? 'Try again in a few minutes.' : 'If this keeps happening, contact MOATiT support.'}
<div class="muted" style="font-size:12px;margin-top:4px">Error: ${esc(error.code)}</div></div>`;
    return page('Huddle brief · Drawbridge', body, { user: view.user, active: '/huddle' });
  }
  if (!brief) return page('Huddle brief · Drawbridge', body, { user: view.user, active: '/huddle' });

  body += `<p class="muted" style="margin-top:-4px;font-size:13px">From Veradigm® PM and Veradigm® EHR · prepared ${esc(fmtTime(brief.generatedAt, 'time'))}${brief.fromCache ? ' (saved copy; use Refresh for the latest)' : ''}</p>`;
  if (brief.timedOut) {
    body += `<div class="card banner warn" role="status">Some checks didn't finish in time and are marked “${esc(COULDNT_CHECK)}”. Use Refresh to try again.</div>`;
  }
  body += tiles(brief);

  if (brief.summary.visits === 0) {
    body += `<div class="card empty muted">No visits on the schedule for this date.</div>`;
  } else {
    for (const p of brief.providers) {
      body += `<section class="card hd-prov"><h3>${esc(p.name)} <span class="muted" style="font-weight:400">· ${esc(p.visits.length)} visit${p.visits.length === 1 ? '' : 's'}</span></h3>
<div class="scroll"><table><thead><tr><th>Time</th><th>Patient</th><th>Visit type</th><th>Balance</th><th>Insurance</th><th>Allergies</th><th>Problems</th><th>Flags</th></tr></thead>
<tbody>${p.visits.map(visitRow).join('')}</tbody></table></div></section>`;
    }
  }
  body += `<p class="muted" style="font-size:12px">“${esc(COULDNT_CHECK)}” means Drawbridge couldn't get that item from Veradigm. It does not mean none on file; check the chart before the visit.</p>`;
  return page(`Huddle brief · ${dateLabel(dateKey)} · Drawbridge`, body, { user: view.user, active: '/huddle' });
}

/** Build the page for a request's query (date, refresh). Never throws. */
export async function huddlePage(service: HuddleService, query: { date?: unknown; refresh?: unknown }, user?: string | null): Promise<string> {
  let dateKey: string;
  try {
    dateKey = service.dateKey(typeof query.date === 'string' ? query.date : '');
  } catch {
    dateKey = service.dateKey('');
  }
  try {
    const brief = await service.getBrief(dateKey, { refresh: query.refresh === '1' });
    return renderHuddle({ dateKey, brief, user });
  } catch (e: any) {
    const code = typeof e?.code === 'string' ? e.code : 'UNKNOWN_ERROR';
    return renderHuddle({ dateKey, error: { code, retryable: ['NETWORK_ERROR', 'TIMEOUT_ERROR', 'SERVER_ERROR', 'API_ERROR'].includes(code) }, user });
  }
}
