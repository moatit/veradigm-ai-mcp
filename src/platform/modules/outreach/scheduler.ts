import { CallConfirmSettings, parseWindow } from './settings';
import { OutreachJob, OutreachType, PlannedAttempt } from './types';
import { addDays, CalDate, clinicParts, cmpDate, isoDate, parseDate, todayInClinic, weekday } from './util';

/**
 * Call & Confirm attempt scheduler. Pure functions: no I/O, no clock reads (callers pass `now`).
 *
 * Each attempt of a job lands in a different part of the day (settings windows):
 *
 *   Confirm      attempt k = `days_before` calling days before the visit, in its window.
 *                Booked under 3 days out (the first attempt has already passed when the job is created):
 *                the next morning window, then the day before in the last attempt's (late-afternoon) window.
 *   No-show      attempt k = `day_offset` calling days after the day the no-show was found (0 = same day).
 *   Recall       attempt k = `day_offset` calendar days after the recall job was created, rolled forward to
 *                the next calling day.
 *
 * Hard limits per patient across every call type (resolvePlan): at most `max_per_day` attempts on one day
 * and `max_per_7_days` in any 7 consecutive days; weekdays only and no holidays (when set); inside the
 * window, which settings keep inside calling hours. An attempt that breaks a limit moves to the next
 * calling day (confirm: only while it is still before the visit); if it can't move it is dropped.
 * Only the last kept attempt may leave a voicemail.
 */

/** Weekday (when weekdays_only) and not a configured holiday. */
export function isCallingDay(c: CalDate, s: CallConfirmSettings): boolean {
  const wd = weekday(c);
  if (s.limits.weekdays_only && (wd === 0 || wd === 6)) return false;
  return !s.limits.holidays.includes(isoDate(c));
}

/** The first calling day on or after `c`. */
export function callingDayOnOrAfter(c: CalDate, s: CallConfirmSettings): CalDate {
  let d = c;
  for (let i = 0; i < 60 && !isCallingDay(d, s); i++) d = addDays(d, 1);
  return d;
}

/** `n` calling days after (n > 0) or before (n < 0) `c`. n = 0 → `c` rolled forward to a calling day. */
export function shiftCallingDays(c: CalDate, n: number, s: CallConfirmSettings): CalDate {
  if (n === 0) return callingDayOnOrAfter(c, s);
  const step = n > 0 ? 1 : -1;
  let d = c;
  let left = Math.abs(n);
  for (let guard = 0; left > 0 && guard < 400; guard++) {
    d = addDays(d, step);
    if (isCallingDay(d, s)) left--;
  }
  return d;
}

/** Minutes since clinic-local midnight. */
export const clinicMinutes = (now: Date) => {
  const p = clinicParts(now);
  return p.hour * 60 + p.minute;
};

/** True when an attempt on `date` in `window` can still be made at or after `now` (its window hasn't ended). */
export function windowStillOpen(date: CalDate, window: string, now: Date): boolean {
  const today = todayInClinic(now);
  const c = cmpDate(date, today);
  if (c !== 0) return c > 0;
  const w = parseWindow(window);
  return !!w && clinicMinutes(now) < w.end;
}

/** True when `now` is inside `window` on `date` (clinic time). */
export function inWindow(date: string, window: string, now: Date): boolean {
  const w = parseWindow(window);
  if (!w || isoDate(todayInClinic(now)) !== date) return false;
  const m = clinicMinutes(now);
  return m >= w.start && m < w.end;
}

/** Inside the practice's calling hours on a calling day. */
export function withinCallingHours(now: Date, s: CallConfirmSettings): boolean {
  const h = parseWindow(s.limits.calling_hours);
  if (!h || !isCallingDay(todayInClinic(now), s)) return false;
  const m = clinicMinutes(now);
  return m >= h.start && m < h.end;
}

export interface IdealAttempt {
  date: CalDate;
  window: string;
}

export interface PlanInput {
  type: OutreachType;
  now: Date;
  /** Confirm: the visit date. No-show: the missed visit's date. */
  appointmentDate?: CalDate;
}

/** The plan before per-patient limits. */
export function idealPlan(p: PlanInput, s: CallConfirmSettings): { kind: 'standard' | 'short'; attempts: IdealAttempt[] } {
  const today = todayInClinic(p.now);
  const usable = (a: IdealAttempt) => isCallingDay(a.date, s) && windowStillOpen(a.date, a.window, p.now);

  if (p.type === 'confirm') {
    const D = p.appointmentDate || today;
    const cfg = s.confirm.attempts;
    const std = cfg.map((a) => ({ date: shiftCallingDays(D, -a.days_before, s), window: a.window }));
    if (std.length && usable(std[0])) return { kind: 'standard', attempts: std };
    // Booked under 3 days out: next business morning, then the day before (late afternoon). One a day.
    const out: IdealAttempt[] = [];
    const morning = cfg[0].window;
    let m = callingDayOnOrAfter(today, s);
    if (!usable({ date: m, window: morning })) m = shiftCallingDays(m, 1, s);
    if (cmpDate(m, D) < 0) out.push({ date: m, window: morning });
    if (cfg.length > 1) {
      const lastCfg = cfg[cfg.length - 1];
      const dayBefore = { date: shiftCallingDays(D, -lastCfg.days_before, s), window: lastCfg.window };
      if (cmpDate(dayBefore.date, D) < 0 && usable(dayBefore) && !out.some((o) => cmpDate(o.date, dayBefore.date) === 0)) out.push(dayBefore);
    }
    out.sort((a, b) => cmpDate(a.date, b.date));
    return { kind: 'short', attempts: out };
  }

  if (p.type === 'no_show') {
    // Day 0 = the day the no-show is found (the missed day itself when found the same day).
    const missed = p.appointmentDate;
    const anchor = callingDayOnOrAfter(missed && cmpDate(missed, today) > 0 ? missed : today, s);
    return { kind: 'standard', attempts: s.no_show.attempts.map((a) => ({ date: shiftCallingDays(anchor, a.day_offset, s), window: a.window })) };
  }

  // Recall: calendar-day offsets from today, rolled forward to a calling day.
  return { kind: 'standard', attempts: s.recall.attempts.map((a) => ({ date: callingDayOnOrAfter(addDays(today, a.day_offset), s), window: a.window })) };
}

/** Attempts of a job that count toward the patient's limits (made or still to be made). */
export function countedDates(job: OutreachJob): string[] {
  return job.plan.filter((a) => a.state === 'planned' || a.state === 'listed' || a.state === 'approved' || a.state === 'done').map((a) => a.date);
}

/** Would one more attempt on `date` break the per-day or any-7-days limit, given the patient's other attempt dates? */
export function breaksLimit(date: CalDate, taken: string[], s: CallConfirmSettings): string {
  const iso = isoDate(date);
  if (taken.filter((t) => t === iso).length >= s.limits.max_per_day) return 'one call a day';
  for (let start = -6; start <= 0; start++) {
    const from = isoDate(addDays(date, start));
    const to = isoDate(addDays(date, start + 6));
    if (taken.filter((t) => t >= from && t <= to).length >= s.limits.max_per_7_days) return `${s.limits.max_per_7_days} calls in 7 days`;
  }
  return '';
}

/**
 * Apply the per-patient limits to an ideal plan. `taken` = dates of the patient's other attempts (all call
 * types). Confirm attempts must stay before the visit (`before`). Returns numbered attempts; the last kept
 * one is marked `last` (the only voicemail).
 */
export function resolvePlan(
  ideal: IdealAttempt[],
  taken: string[],
  s: CallConfirmSettings,
  now: Date,
  opts: { before?: CalDate; maxShift?: number } = {}
): PlannedAttempt[] {
  const used = [...taken];
  const out: PlannedAttempt[] = [];
  let prev: CalDate | null = null;
  const maxShift = opts.maxShift ?? 3;
  ideal.forEach((a, i) => {
    let d = a.date;
    let why = '';
    let firstWhy = '';
    let ok = false;
    for (let shift = 0; shift <= maxShift; shift++) {
      why = '';
      if (!isCallingDay(d, s)) why = 'not a calling day';
      else if (!windowStillOpen(d, a.window, now)) why = 'window already passed';
      else if (prev && cmpDate(d, prev) <= 0) why = 'one call a day';
      else if (opts.before && cmpDate(d, opts.before) >= 0) {
        why = 'too close to the visit';
        break;
      } else why = breaksLimit(d, used, s);
      if (!why) {
        ok = true;
        break;
      }
      if (!firstWhy) firstWhy = why;
      d = shiftCallingDays(d, 1, s);
    }
    if (!ok) {
      out.push({ n: i + 1, date: isoDate(a.date), window: a.window, last: false, state: 'dropped', note: `dropped: ${firstWhy || why}` });
      return;
    }
    used.push(isoDate(d));
    prev = d;
    const moved = cmpDate(d, a.date) !== 0;
    out.push({ n: i + 1, date: isoDate(d), window: a.window, last: false, state: 'planned', ...(moved ? { note: `moved from ${isoDate(a.date)}: ${firstWhy}` } : {}) });
  });
  const kept = out.filter((a) => a.state === 'planned');
  if (kept.length) kept[kept.length - 1].last = true;
  return out;
}

/** Plan a new job against the patient's existing attempts (`others` = the patient's other jobs). */
export function planJob(
  input: PlanInput,
  others: OutreachJob[],
  s: CallConfirmSettings,
  extraTaken: string[] = []
): { kind: 'standard' | 'short'; plan: PlannedAttempt[] } {
  const ideal = idealPlan(input, s);
  const taken = [...others.flatMap(countedDates), ...extraTaken];
  const before = input.type === 'confirm' ? input.appointmentDate : undefined;
  const maxShift = input.type === 'confirm' ? 10 : input.type === 'no_show' ? 3 : 5;
  return { kind: ideal.kind, plan: resolvePlan(ideal.attempts, taken, s, input.now, { before, maxShift }) };
}

/** The job's attempt for `date` that is still to be made (planned, listed or approved). */
export function attemptOn(job: OutreachJob, date: string): PlannedAttempt | undefined {
  return job.plan.find((a) => a.date === date && (a.state === 'planned' || a.state === 'listed' || a.state === 'approved'));
}

/** Attempts still to be made. */
export const remaining = (job: OutreachJob) => job.plan.filter((a) => a.state === 'planned' || a.state === 'listed' || a.state === 'approved');

/** The visit date of a confirm/no-show job, if parseable. */
export const visitDate = (job: OutreachJob): CalDate | null => (job.appointment ? parseDate(job.appointment.date) : null);
