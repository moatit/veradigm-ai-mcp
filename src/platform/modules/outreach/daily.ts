import { sweep, dialMode } from './dialer';
import { BuildCtx, buildConfirmList, buildNoShowList, buildRecallList, confirmCandidates, GenerateResult } from './generators';
import { countedDates, isCallingDay, planJob, shiftCallingDays } from './scheduler';
import { CallConfirmSettings, parseWindow, practiceId } from './settings';
import type { JobStore } from './store';
import { bucketOf, DailyList, OUTREACH_TYPES, OutreachType, Projection, RESULT_BUCKETS, ResultBucket, StopReason } from './types';
import { addDays, clinicTz, isoDate, parseDate, todayInClinic, weekday } from './util';

/**
 * The daily plan. At 07:00 (clinic time, calling days) the list builders run and every attempt due today goes on
 * the day's list; a staff member approves the whole list with one click. Nothing on an unapproved list is dialed.
 * The same run stores a projection: confirm attempts expected from visits further out that are not jobs yet.
 */
export const LIST_HOUR = 7;

const TYPE_LABEL: Record<OutreachType, string> = { confirm: 'Confirm', no_show: 'No-show', recall: 'Recall' };

function summaryLines(r: GenerateResult): string[] {
  const lines = [
    `${TYPE_LABEL[r.type]} (${r.window}): Veradigm® PM returned ${r.rows} row(s), ${r.matched} matched; ${r.proposed} new job(s)${
      r.short ? ` (${r.short} booked under 3 days out)` : ''
    }${r.duplicates ? `, ${r.duplicates} already had a job` : ''}${r.unusable ? `, ${r.unusable} had no patient ID` : ''}.`,
  ];
  for (const [reason, n] of Object.entries(r.skipped)) lines.push(`${TYPE_LABEL[r.type]}: ${n} not called: ${reason}.`);
  return lines;
}

/** Confirm attempts for visits 4+ business days out (not jobs yet) whose attempts fall within `days` days. */
export async function buildProjection(ctx: BuildCtx, days = 8): Promise<Projection> {
  const today = todayInClinic(ctx.now);
  const counts: Projection['counts'] = {};
  if (ctx.settings.call_types.confirm) {
    const maxBefore = Math.max(...ctx.settings.confirm.attempts.map((a) => a.days_before));
    const from = shiftCallingDays(today, 4, ctx.settings);
    const to = shiftCallingDays(addDays(today, days - 1), maxBefore, ctx.settings);
    const c = await confirmCandidates(ctx.unity, from, to);
    const lastDay = isoDate(addDays(today, days - 1));
    const taken = new Map<string, string[]>();
    for (const cand of c.candidates) {
      const key = `confirm|${cand.patientId}|${cand.appointment!.id || `${cand.appointment!.date} ${cand.appointment!.time}`}`;
      if (ctx.store.findByDedupeKey(key) || ctx.store.isOptedOut(cand.patientId)) continue;
      const extra = taken.get(cand.patientId) || [];
      const { plan } = planJob({ type: 'confirm', now: ctx.now, appointmentDate: parseDate(cand.appointment!.date) || undefined }, ctx.store.byPatient(cand.patientId), ctx.settings, extra);
      const kept = plan.filter((a) => a.state === 'planned');
      taken.set(cand.patientId, [...extra, ...kept.map((a) => a.date)]);
      for (const a of kept) {
        if (a.date > lastDay) continue;
        const w = ((counts[a.date] ||= {})[a.window] ||= {});
        w.confirm = (w.confirm || 0) + 1;
      }
    }
  }
  return { built_at: ctx.now.toISOString(), counts };
}

/**
 * Build (or rebuild) today's list: sweep, run the enabled list builders, list today's attempts, store the
 * projection. A builder that fails throws (CLAUDE.md rule 5); jobs from builders that already finished stay.
 * A failed projection does not fail the list (the summary says so).
 */
export async function buildDailyList(ctx: BuildCtx): Promise<DailyList> {
  sweep(ctx.store, ctx.now, ctx.by);
  const date = isoDate(todayInClinic(ctx.now));
  const summary: string[] = [];
  if (!isCallingDay(todayInClinic(ctx.now), ctx.settings)) summary.push('Today is not a calling day (weekend or holiday): nothing is called today.');
  const t = ctx.settings.call_types;
  if (t.confirm) summary.push(...summaryLines(await buildConfirmList(ctx)));
  if (t.no_show) summary.push(...summaryLines(await buildNoShowList(ctx)));
  if (t.recall) summary.push(...summaryLines(await buildRecallList(ctx)));
  try {
    ctx.store.saveProjection(await buildProjection(ctx));
  } catch (e: any) {
    summary.push(`Projection for the coming week unavailable (${e?.code || 'UNKNOWN_ERROR'}); planned calls are still listed.`);
  }

  const entries: DailyList['entries'] = [];
  for (const job of ctx.store.list()) {
    if (!['scheduled', 'approved'].includes(job.status) || !t[job.type]) continue;
    const a = job.plan.find((x) => x.date === date && ['planned', 'listed', 'approved'].includes(x.state));
    if (!a) continue;
    if (a.state === 'planned') ctx.store.update(job.id, ctx.by, 'listed', (j) => (j.plan.find((x) => x.n === a.n)!.state = 'listed'), `attempt ${a.n} on ${date} list`, ctx.now);
    entries.push({ job_id: job.id, n: a.n, type: job.type, window: a.window });
  }
  const prev = ctx.store.getList(date);
  const list: DailyList = {
    date,
    built_at: ctx.now.toISOString(),
    built_by: ctx.by,
    ...(prev?.approved_at ? { approved_at: prev.approved_at, approved_by: prev.approved_by } : {}),
    entries,
    summary,
  };
  ctx.store.saveList(list);
  console.log(`[Outreach] daily list ${date}: ${entries.length} attempt(s)`);
  return list;
}

/** Approve every attempt on the day's list that is waiting (one click). Returns how many were approved. */
export function approveList(store: JobStore, date: string, by: string, now: Date = new Date()): number {
  const list = store.getList(date);
  if (!list) return 0;
  let n = 0;
  for (const e of list.entries) {
    const job = store.get(e.job_id);
    const a = job?.plan.find((x) => x.n === e.n);
    if (!job || !a || a.state !== 'listed' || job.status !== 'scheduled') continue;
    store.update(
      job.id,
      by,
      'approved',
      (j) => {
        j.plan.find((x) => x.n === e.n)!.state = 'approved';
        j.status = 'approved';
        j.approved_by = by;
      },
      `attempt ${e.n} (${e.window})`,
      now
    );
    n++;
  }
  store.saveList({ ...list, approved_at: now.toISOString(), approved_by: by });
  return n;
}

/** Attempts on the list still waiting for approval. */
export function pendingApproval(store: JobStore, date: string): number {
  const list = store.getList(date);
  if (!list) return 0;
  return list.entries.filter((e) => store.get(e.job_id)?.plan.find((a) => a.n === e.n)?.state === 'listed').length;
}

// ---- Plan summary (staff screen and GET /api/outreach/plan) ----

export type TypeCounts = Record<OutreachType | 'total', number>;
const zeroTypes = (): TypeCounts => ({ confirm: 0, no_show: 0, recall: 0, total: 0 });
const zeroResults = (): Record<ResultBucket, number> => Object.fromEntries(RESULT_BUCKETS.map((b) => [b, 0])) as Record<ResultBucket, number>;
const addType = (c: TypeCounts, t: OutreachType, n = 1) => {
  c[t] += n;
  c.total += n;
};

export interface PlanWindow {
  window: string;
  planned: TypeCounts;
  projected: TypeCounts;
}

export interface PlanDay {
  date: string;
  weekday: string;
  calling_day: boolean;
  list: { built_at: string; approved_at: string | null; approved_by: string | null; entries: number; pending_approval: number } | null;
  planned: TypeCounts;
  projected: TypeCounts;
  windows: PlanWindow[];
  results: Record<ResultBucket, number>;
  would_call: number;
  stopped: Partial<Record<StopReason, number>>;
}

export interface PlanSummary {
  practice: string;
  timezone: string;
  generated_at: string;
  enabled: boolean;
  mode: 'dry_run' | 'live';
  days: PlanDay[];
  totals: { planned: TypeCounts; projected: TypeCounts; results: Record<ResultBucket, number> };
  unconfirmed: number;
  opted_out: number;
  bad_number_tasks: number;
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Per day (today + days-1), per window and per call type: planned attempts (jobs that exist: planned, on a list,
 * approved or already made), projected confirm attempts (visits not picked up yet), and results so far
 * (attempts made that day, by outcome bucket). Counts only: no names, phones or IDs.
 */
export function planSummary(store: JobStore, settings: CallConfirmSettings, now: Date, days = 7): PlanSummary {
  const n = Math.min(Math.max(Math.floor(days) || 7, 1), 14);
  const today = todayInClinic(now);
  const dates = Array.from({ length: n }, (_, i) => addDays(today, i));
  const byDate = new Map<string, PlanDay>();
  const winOf = (d: PlanDay, w: string) => {
    let x = d.windows.find((y) => y.window === w);
    if (!x) d.windows.push((x = { window: w, planned: zeroTypes(), projected: zeroTypes() }));
    return x;
  };
  for (const c of dates) {
    const iso = isoDate(c);
    const list = store.getList(iso);
    const day: PlanDay = {
      date: iso,
      weekday: WD[weekday(c)],
      calling_day: isCallingDay(c, settings),
      list: list
        ? {
            built_at: list.built_at,
            approved_at: list.approved_at || null,
            approved_by: list.approved_by || null,
            entries: list.entries.length,
            pending_approval: pendingApproval(store, iso),
          }
        : null,
      planned: zeroTypes(),
      projected: zeroTypes(),
      windows: [],
      results: zeroResults(),
      would_call: 0,
      stopped: {},
    };
    // Every configured window shows on a calling day, even at zero, so the grid is stable.
    if (day.calling_day) {
      const ws = new Set<string>();
      for (const t of OUTREACH_TYPES) if (settings.call_types[t]) for (const a of settings[t].attempts) ws.add(a.window);
      for (const w of ws) winOf(day, w);
    }
    byDate.set(iso, day);
  }

  for (const job of store.list()) {
    for (const a of job.plan) {
      const day = byDate.get(a.date);
      if (!day) continue;
      if (['planned', 'listed', 'approved', 'done'].includes(a.state)) {
        addType(day.planned, job.type);
        addType(winOf(day, a.window).planned, job.type);
      }
      if (a.state === 'done') {
        if (a.result === 'would_call') day.would_call++;
        const b = bucketOf(a.result);
        if (b) day.results[b]++;
      }
      if (a.state === 'stopped' && a.result?.startsWith('stop:') && a.n === Math.min(...job.plan.filter((x) => x.state === 'stopped').map((x) => x.n))) {
        // Count a stop once, on the day of the first attempt it cancelled.
        const r = a.result.slice(5) as StopReason;
        day.stopped[r] = (day.stopped[r] || 0) + 1;
      }
    }
  }

  const proj = store.getProjection();
  if (proj) {
    for (const [date, wins] of Object.entries(proj.counts)) {
      const day = byDate.get(date);
      if (!day) continue;
      for (const [w, types] of Object.entries(wins)) {
        for (const t of OUTREACH_TYPES) {
          const k = types[t] || 0;
          if (!k) continue;
          addType(day.projected, t, k);
          addType(winOf(day, w).projected, t, k);
        }
      }
    }
  }

  const all = [...byDate.values()];
  for (const d of all) d.windows.sort((a, b) => (parseWindow(a.window)?.start ?? 0) - (parseWindow(b.window)?.start ?? 0));
  const totals = { planned: zeroTypes(), projected: zeroTypes(), results: zeroResults() };
  for (const d of all) {
    for (const t of OUTREACH_TYPES) {
      addType(totals.planned, t, d.planned[t]);
      addType(totals.projected, t, d.projected[t]);
    }
    for (const b of RESULT_BUCKETS) totals.results[b] += d.results[b];
  }
  const jobs = store.list();
  return {
    practice: practiceId(),
    timezone: clinicTz(),
    generated_at: now.toISOString(),
    enabled: settings.enabled,
    mode: dialMode(settings) === 'live' ? 'live' : 'dry_run',
    days: all,
    totals,
    // Upcoming visits only (a visit that has passed is no longer something to confirm).
    unconfirmed: jobs.filter((j) => j.status === 'unconfirmed' && (!j.appointment || (parseDate(j.appointment.date) && isoDate(parseDate(j.appointment.date)!) >= isoDate(today)))).length,
    opted_out: store.optedOutCount(),
    bad_number_tasks: jobs.filter((j) => j.staff_task).length,
  };
}
