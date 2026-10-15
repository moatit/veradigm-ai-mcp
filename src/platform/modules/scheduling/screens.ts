import { isToolFailure } from '../../../unity/utils/tool-result';
import { APP_BASE, esc } from '../../shell';
import { addDays, formatSpokenTime, parseMdy, spokenDay, timeToMinutes, toMdy } from './dates';
import type { ProviderOpenings } from './openings';
import type { Provider, ScheduleEntry } from './scheduling.tools';

/** Staff assistant screens. Every value goes through esc(). */

export const BASE = `${APP_BASE}/assistant`;

/** "2026-10-13" (date input) or "10/13/2026" → "10/13/2026"; anything else → ''. */
export function fromInput(v: unknown): string {
  const s = String(v ?? '').trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const mdy = iso ? `${iso[2]}/${iso[3]}/${iso[1]}` : s;
  return parseMdy(mdy) ? mdy : '';
}

/** "10/13/2026" → "2026-10-13" for <input type=date>. */
export function toInput(mdy: string): string {
  const d = parseMdy(mdy);
  return d ? d.toISOString().slice(0, 10) : '';
}

/** A failed Veradigm call is shown as a failure, never as "no openings" / "no appointments". */
export function failureBanner(result: any, what: string): string {
  const code = result?.error_code || 'UNKNOWN';
  return `<div class="card" role="alert" style="background:var(--urgent-bg);color:var(--urgent);border-color:var(--urgent)">
<strong>Couldn't reach Veradigm® PM.</strong> ${esc(what)} could not be loaded, so this is <strong>not</strong> an empty result.
${result?.retryable ? 'Try again in a moment.' : 'Check Veradigm® PM directly or ask your Drawbridge administrator.'}
<span style="font-size:13px;opacity:.8">(${esc(code)})</span></div>`;
}

function noticeCard(text: string): string {
  return `<div class="card" style="background:var(--warn-bg);color:var(--warn)">${esc(text)}</div>`;
}

const tabs = (active: 'openings' | 'day', dayHref: string) =>
  `<div class="row" style="margin-bottom:10px"><a href="${BASE}" class="pill ${active === 'openings' ? 'ok' : ''}" style="text-decoration:none">Find openings</a>
<a href="${esc(dayHref)}" class="pill ${active === 'day' ? 'ok' : ''}" style="text-decoration:none">Day schedule</a></div>`;

export function openingsPage(opts: {
  q: string;
  start: string;
  end: string;
  part: string;
  provider: string;
  providers: Provider[] | null;
  result: any | null;
  today: string;
}): string {
  const { q, start, end, part, provider, providers, result } = opts;
  const providerField = providers
    ? `<select name="provider"><option value="">Any provider</option>${providers
        .map((p) => `<option value="${esc(p.id)}"${p.id === provider ? ' selected' : ''}>${esc(p.name)}</option>`)
        .join('')}</select>`
    : `<input name="provider" value="${esc(provider)}" placeholder="Provider ID (list unavailable)">`;
  const partOpt = (v: string, label: string) => `<option value="${v}"${part === v ? ' selected' : ''}>${label}</option>`;

  const forms = `${tabs('openings', `${BASE}/day?date=${encodeURIComponent(opts.today)}`)}
<div class="card"><form method="get" action="${BASE}" class="row" style="flex-wrap:nowrap">
<input name="q" value="${esc(q)}" placeholder="Who has an opening Tuesday afternoon?" aria-label="Question" autofocus>
<button>Ask</button></form>
<p class="muted" style="font-size:13px;margin:8px 0 0">Understands days (today, tomorrow, Tuesday, next week, 10/13), morning or afternoon, and provider names (Dr. Lee).</p></div>
<details class="card"${!q && (start || provider) ? ' open' : ''}><summary><strong>Search by date and provider</strong></summary>
<form method="get" action="${BASE}"><input type="hidden" name="form" value="1"><div class="grid" style="margin-top:10px">
<label>From<input type="date" name="start" value="${esc(toInput(start))}" required></label>
<label>To<input type="date" name="end" value="${esc(toInput(end))}"></label>
<label>Time of day<select name="part">${partOpt('any', 'Any time')}${partOpt('morning', 'Morning (before 12)')}${partOpt('afternoon', 'Afternoon (12-5)')}</select></label>
<label>Provider${providerField}</label></div><p style="margin-bottom:0"><button>Find openings</button></p></form></details>`;

  return `<h2 style="margin-top:4px">Staff assistant</h2>${forms}${result ? openingsResult(result) : ''}`;
}

function openingsResult(result: any): string {
  if (isToolFailure(result)) return failureBanner(result, 'Open appointment times');
  if (result?.success === false) return noticeCard(result.message || 'That question could not be answered.');
  const groups: ProviderOpenings[] = result.openings || [];
  const multiDay = result.query?.startDate !== result.query?.endDate;
  const head = `<div class="card row"><strong>${esc(result.message)}</strong>
<span class="muted" style="font-size:13px">${esc(result.query?.startDate)}${multiDay ? ` – ${esc(result.query?.endDate)}` : ''} · ${esc(
    result.query?.partOfDay === 'any' ? 'any time' : result.query?.partOfDay
  )}</span></div>${
    result.providerNamesUnavailable ? noticeCard('Provider names could not be loaded from Veradigm® PM; showing provider IDs.') : ''
  }${result.skippedNoTime ? noticeCard(`${result.skippedNoTime} opening(s) had no readable time and were left out of the morning/afternoon filter.`) : ''}`;
  if (!groups.length) return `${head}<div class="card empty muted">No openings match. Try a wider date range or any time of day.</div>`;
  const cards = groups
    .map(
      (g) => `<div class="card"><div class="row"><strong>${esc(g.providerName)}</strong><span class="pill ok">${esc(g.count)} open</span>
${g.providerId ? `<span class="muted" style="font-size:13px">ID ${esc(g.providerId)}</span>` : ''}</div>
<div class="scroll"><table><thead><tr><th>Day</th><th>Time</th><th>Length</th></tr></thead><tbody>${g.slots
        .map(
          (s) =>
            `<tr><td>${esc(spokenDay(s.date))}</td><td>${esc(s.time)}</td><td>${s.duration ? `${esc(s.duration)} min` : '<span class="muted">—</span>'}</td></tr>`
        )
        .join('')}</tbody></table></div></div>`
    )
    .join('');
  return head + cards;
}

export function dayPage(opts: { date: string; provider: string; providers: Provider[] | null; result: any }): string {
  const { date, provider, providers, result } = opts;
  const d = parseMdy(date)!;
  const link = (x: Date) => `${BASE}/day?date=${encodeURIComponent(toMdy(x))}${provider ? `&provider=${encodeURIComponent(provider)}` : ''}`;
  const providerField = providers
    ? `<select name="provider"><option value="">All providers</option>${providers
        .map((p) => `<option value="${esc(p.id)}"${p.id === provider ? ' selected' : ''}>${esc(p.name)}</option>`)
        .join('')}</select>`
    : `<input name="provider" value="${esc(provider)}" placeholder="Provider ID (optional)">`;
  const controls = `${tabs('day', `${BASE}/day?date=${encodeURIComponent(date)}`)}
<div class="card"><form method="get" action="${BASE}/day" class="row">
<a href="${esc(link(addDays(d, -1)))}" aria-label="Previous day">←</a>
<input type="date" name="date" value="${esc(toInput(date))}" style="width:auto">
<span style="min-width:180px;flex:1">${providerField}</span><button>Show</button>
<a href="${esc(link(addDays(d, 1)))}" aria-label="Next day">→</a></form></div>`;

  let body: string;
  if (isToolFailure(result)) body = failureBanner(result, 'The day schedule');
  else if (result?.success === false) body = noticeCard(result.message || 'The schedule could not be loaded.');
  else {
    const rows: ScheduleEntry[] = result.schedule || [];
    const names = new Map((providers || []).map((p) => [p.id, p.name]));
    body = `<div class="card row"><strong>${esc(spokenDay(date))}</strong><span class="muted">${esc(result.message)}</span></div>${
      rows.length
        ? `<div class="card scroll"><table><thead><tr><th>Time</th><th>Patient</th><th>Provider</th><th>Type</th><th>Status</th></tr></thead><tbody>${rows
            .map(
              (r) => `<tr><td>${esc(formatSpokenTime(timeToMinutes(r.time), r.time) || '—')}</td><td>${esc(r.patientName || '—')}${
                r.patientId ? ` <span class="muted" style="font-size:12px">#${esc(r.patientId)}</span>` : ''
              }</td><td>${esc(r.providerName || names.get(r.providerId) || r.providerId || '—')}</td><td>${esc(r.type || '—')}</td><td>${
                r.status ? `<span class="pill">${esc(r.status)}</span>` : '—'
              }</td></tr>`
            )
            .join('')}</tbody></table></div>`
        : '<div class="card empty muted">No appointments on the schedule for this day.</div>'
    }`;
  }
  return `<h2 style="margin-top:4px">Day schedule</h2>${controls}${body}`;
}
