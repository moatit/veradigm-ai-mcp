import axios from 'axios';
import { UnityTaskTools } from '../../../unity/tools/task.tools';
import { clinicLabel } from '../../clinic';
import { BuildCtx, bookedFrom, isCancelled, isConfirmedStatus, lookupPhone, patientSchedule } from './generators';
import { inWindow, isCallingDay, remaining, windowStillOpen, withinCallingHours } from './scheduler';
import { CallConfirmSettings, defaultSettings, envAllowlist } from './settings';
import type { JobStore } from './store';
import { DialMode, OutreachJob, OutreachOutcome, PlannedAttempt, RETRY_OUTCOMES, StopReason } from './types';
import { addDays, clinicTz, cmpDate, isoDate, parseDate, spokenDate, spokenTime, todayInClinic } from './util';

/**
 * Call & Confirm dispatcher: the only place Drawbridge dials (Retell POST /v2/create-phone-call).
 *
 * Before every attempt, in this order:
 *  (a) the attempt is on an approved daily list (staff approved it), today, inside its window, inside the
 *      practice's calling hours, on a calling day (weekday, not a holiday);
 *  (b) the patient's limits across all call types: max_per_day today, max_per_7_days in the last 7 days;
 *  (c) live only: settings mode "live", OUTBOUND_ENABLED=true, an allowlist (settings test_allowlist or
 *      OUTBOUND_ALLOWLIST) that contains the number, Retell configured;
 *  (d) re-read Veradigm® PM (GetScheduleByPatientID, GetPatient) and stop when the visit was confirmed,
 *      moved or cancelled, the patient already rebooked (called in and handled it), opted out, or has no
 *      usable number (a staff task is queued to fix it). A failed re-read means "not called", never "stop".
 * Modes: dry_run (default) records "would call"; simulate runs the call through a supplied script against a
 * fake Veradigm client (sim.ts / testcalls.ts); live places a Retell call.
 * Retell receives only the dynamic variables below: never diagnoses, medications or other chart data.
 */
export const RETELL_CREATE_CALL_URL = 'https://api.retellai.com/v2/create-phone-call';
const MAX_PER_RUN = 25;

export interface DispatchCtx extends BuildCtx {
  mode: DialMode;
  /** simulate mode: plays the call (the script records the outcome through drawbridge_outreach_result or applyOutcome). */
  simulate?: (job: OutreachJob, attempt: PlannedAttempt, callId: string) => Promise<void>;
  /** Create SaveTask staff tasks for bad numbers (live and simulate; dry run only records "would create"). */
  writes?: boolean;
}

export interface OutboundConfig {
  retellConfigured: boolean;
  enabled: boolean;
  allowlist: string[];
  hasFromNumber: boolean;
  timezone: string;
}

export function outboundConfig(settings: CallConfirmSettings): OutboundConfig {
  return {
    retellConfigured: !!(process.env.RETELL_API_KEY && process.env.RETELL_OUTBOUND_AGENT_ID),
    enabled: process.env.OUTBOUND_ENABLED === 'true',
    allowlist: [...new Set([...settings.test_allowlist, ...envAllowlist()])],
    hasFromNumber: !!process.env.RETELL_FROM_NUMBER,
    timezone: clinicTz(),
  };
}

/** The mode the dispatcher runs in for these settings: live only when settings say so (and then every gate applies). */
export const dialMode = (settings: CallConfirmSettings): DialMode => (settings.mode === 'live' ? 'live' : 'dry_run');

/** CLINIC_CALLBACK_NUMBER as the agent should say it. */
export const callbackNumber = () => String(process.env.CLINIC_CALLBACK_NUMBER || '').trim();

/** Dynamic variables for the outbound agent. Nothing else about the patient goes to Retell. */
export function dynamicVariables(job: OutreachJob, attempt?: PlannedAttempt, settings: CallConfirmSettings = defaultSettings()): Record<string, string> {
  return {
    patient_first_name: job.patient_first_name || '',
    appointment_date: job.appointment ? spokenDate(job.appointment.date) : '',
    appointment_time: job.appointment ? spokenTime(job.appointment.time) : '',
    provider_name: job.appointment?.provider || '',
    outreach_type: job.type,
    clinic_name: clinicLabel(), // CLINIC_NAME (no client name in code)
    callback_number: callbackNumber(),
    leave_voicemail: settings.voicemail === 'last_attempt' && attempt?.last ? 'yes' : 'no',
  };
}

/** Attempt dates the patient was actually called on (all call types). */
function calledDates(store: JobStore, patientId: string): string[] {
  return store.byPatient(patientId).flatMap((j) => j.plan.filter((a) => a.state === 'done').map((a) => a.date));
}

/** Why this attempt can't be dialed right now, or '' if it can. */
export function refusalReason(job: OutreachJob, attempt: PlannedAttempt, ctx: DispatchCtx, opts: { ignoreWindow?: boolean } = {}): string {
  const s = ctx.settings;
  const today = todayInClinic(ctx.now);
  if (job.status !== 'approved' || attempt.state !== 'approved') return 'Not on an approved daily list';
  if (!job.phone) return 'No phone number';
  if (!opts.ignoreWindow) {
    if (attempt.date !== isoDate(today)) return 'Attempt is not for today';
    if (!isCallingDay(today, s)) return 'Not a calling day (weekend or holiday)';
    if (!withinCallingHours(ctx.now, s)) return `Outside calling hours (${s.limits.calling_hours} ${clinicTz()})`;
    if (!inWindow(attempt.date, attempt.window, ctx.now)) return `Outside this attempt's window (${attempt.window})`;
  }
  const called = calledDates(ctx.store, job.patient_ref.id);
  if (called.filter((d) => d === isoDate(today)).length >= s.limits.max_per_day) return 'Patient already called today';
  const weekAgo = isoDate(addDays(today, -6));
  if (called.filter((d) => d >= weekAgo && d <= isoDate(today)).length >= s.limits.max_per_7_days) return `Patient already called ${s.limits.max_per_7_days} times in 7 days`;
  if (ctx.mode === 'live') {
    const cfg = outboundConfig(s);
    if (!cfg.enabled) return 'Outbound calling is turned off (OUTBOUND_ENABLED is not true)';
    if (!cfg.allowlist.length) return 'Live calling needs a test allowlist';
    if (!cfg.allowlist.includes(job.phone)) return 'Number is not on the outbound allowlist';
    if (!cfg.retellConfigured) return 'The outbound agent is not configured (RETELL_API_KEY / RETELL_OUTBOUND_AGENT_ID)';
    if (!cfg.hasFromNumber) return 'RETELL_FROM_NUMBER is not set';
  }
  return '';
}

/**
 * Re-read Veradigm® PM before an attempt. Returns a stop reason, or the current phone number. Throws when a read
 * fails (the caller then does not call, and does not stop the job).
 */
export async function preAttemptCheck(ctx: BuildCtx, job: OutreachJob): Promise<{ stop?: StopReason; phone?: string }> {
  if (ctx.store.isOptedOut(job.patient_ref.id)) return { stop: 'opted_out' };
  const today = todayInClinic(ctx.now);
  const rows = await patientSchedule(ctx.unity, job.patient_ref.id);
  if (job.type === 'confirm' && job.appointment) {
    const visit = parseDate(job.appointment.date);
    if (visit && cmpDate(visit, today) < 0) return { stop: 'past' };
    const row = rows.find((r) => r.id && r.id === job.appointment!.id);
    if (!row) return { stop: 'moved' };
    if (isCancelled(row.status)) return { stop: 'cancelled' };
    if (isConfirmedStatus(row.status)) return { stop: 'confirmed' };
    const d = parseDate(row.date);
    if (d && visit && cmpDate(d, visit) !== 0) return { stop: 'moved' };
    if (row.time && job.appointment.time && spokenTime(row.time) !== spokenTime(job.appointment.time)) return { stop: 'moved' };
  } else if (job.type === 'no_show') {
    // Rebooked since the missed visit (the patient called in, or staff booked it).
    const missed = (job.appointment && parseDate(job.appointment.date)) || today;
    const after = rows.filter((r) => r.id !== job.appointment?.id);
    if (bookedFrom(after, cmpDate(missed, today) < 0 ? today : missed)) return { stop: 'handled' };
  } else if (job.type === 'recall') {
    if (bookedFrom(rows, today)) return { stop: 'booked' };
  }
  const p = await lookupPhone(ctx.unity, job.patient_ref.id);
  if (!p.phone) return { stop: 'bad_number' };
  return { phone: p.phone };
}

const STOP_LABEL: Record<StopReason, string> = {
  confirmed: 'Visit already confirmed',
  moved: 'Visit was moved',
  cancelled: 'Visit was cancelled',
  opted_out: 'Patient asked not to be called',
  bad_number: 'No working phone number',
  handled: 'Patient already rebooked',
  booked: 'Visit already booked',
  past: 'Visit date has passed',
};
export const stopLabel = (r: StopReason) => STOP_LABEL[r] || r;

/** End a job with a stop reason; its remaining attempts are not made. Bad numbers queue a staff task. */
export function stopJob(store: JobStore, job: OutreachJob, reason: StopReason, by: string, now: Date): OutreachJob {
  return store.update(
    job.id,
    by,
    'stopped',
    (j) => {
      for (const a of remaining(j)) {
        a.state = 'stopped';
        a.result = `stop:${reason}`;
        a.at = now.toISOString();
      }
      j.status = 'stopped';
      j.stop = { reason, at: now.toISOString() };
      if (reason === 'bad_number' && !j.staff_task) j.staff_task = { state: 'pending', at: now.toISOString() };
    },
    STOP_LABEL[reason],
    now
  );
}

/** After an attempt that did not resolve the job: next attempt, or the end of the plan. */
function advance(j: OutreachJob): void {
  if (remaining(j).length) {
    j.status = 'scheduled';
    return;
  }
  const done = j.plan.filter((a) => a.state === 'done');
  const dryOnly = done.length > 0 && done.every((a) => a.result === 'would_call');
  if (dryOnly) {
    j.status = 'completed';
    j.notes = 'Dry run: no calls placed';
  } else if (j.type === 'confirm') {
    j.status = 'unconfirmed';
  } else {
    j.status = 'completed';
    j.notes = j.notes || (done.length ? 'All attempts used' : 'No attempt was made');
  }
}

/** The attempt being called (approved, lowest number). */
const currentAttempt = (j: OutreachJob) => j.plan.filter((a) => a.state === 'approved').sort((a, b) => a.n - b.n)[0];

/**
 * Record how a call ended (agent tool, simulation). Retry outcomes leave the job for its next attempt; after
 * the final attempt a confirm job goes on the Unconfirmed list. wrong_number stops the job and queues a
 * staff task to fix the number; opted_out adds the patient to the opt-out list.
 */
export function applyOutcome(store: JobStore, job: OutreachJob, outcome: OutreachOutcome, by: string, now: Date, notes = ''): OutreachJob {
  const updated = store.update(
    job.id,
    by,
    'outcome',
    (j) => {
      const a = currentAttempt(j);
      if (a) {
        a.state = 'done';
        a.result = outcome;
        a.at = now.toISOString();
      }
      j.outcome = outcome;
      if (notes) j.notes = notes;
      if (RETRY_OUTCOMES.includes(outcome)) {
        advance(j);
        return;
      }
      // Not needed after this call (`after:`); `stop:` is kept for stop rules found before a call.
      for (const r of remaining(j)) {
        r.state = 'stopped';
        r.result = `after:${outcome}`;
      }
      if (outcome === 'wrong_number') {
        j.status = 'stopped';
        j.stop = { reason: 'bad_number', at: now.toISOString() };
        if (!j.staff_task) j.staff_task = { state: 'pending', at: now.toISOString() };
      } else j.status = 'completed';
    },
    outcome,
    now
  );
  if (outcome === 'opted_out') store.optOut(job.patient_ref.id);
  return updated;
}

/**
 * Housekeeping before each run: attempts on past days (or today's approved attempts whose window has ended)
 * become "missed"; jobs whose visit has passed stop; jobs with nothing left reach their end state.
 */
export function sweep(store: JobStore, now: Date, by = 'scheduler'): number {
  const today = isoDate(todayInClinic(now));
  let changed = 0;
  for (const job of store.list()) {
    if (!['scheduled', 'approved'].includes(job.status)) continue;
    const late = remaining(job).filter((a) => a.date < today || (a.date === today && a.state === 'approved' && windowEnded(a, now)));
    const visit = job.type === 'confirm' && job.appointment ? parseDate(job.appointment.date) : null;
    const past = !!visit && isoDate(visit) <= today && remaining(job).every((a) => a.date >= isoDate(visit));
    if (!late.length && !past) continue;
    changed++;
    store.update(
      job.id,
      by,
      'missed',
      (j) => {
        for (const a of remaining(j)) {
          if (a.date < today || (a.date === today && a.state === 'approved' && windowEnded(a, now))) {
            a.note = a.state === 'approved' ? 'window ended before the call' : 'list not approved';
            a.state = 'missed';
          }
          if (past && a.date >= isoDate(visit!)) {
            a.state = 'missed';
            a.note = 'visit date reached';
          }
        }
        if (!remaining(j).length) advance(j);
        else if (j.status === 'approved' && !currentAttempt(j)) j.status = 'scheduled';
      },
      `${late.length} attempt(s) missed`,
      now
    );
  }
  return changed;
}

const windowEnded = (a: PlannedAttempt, now: Date) => !windowStillOpen(parseDate(a.date)!, a.window, now);

export interface DialResult {
  jobId: string;
  result: 'would_call' | 'simulated' | 'placed' | 'refused' | 'stopped' | 'error';
  reason?: string;
}

export interface DialRun {
  mode: DialMode;
  results: DialResult[];
  counts: Record<DialResult['result'], number>;
}

async function createCall(job: OutreachJob, attempt: PlannedAttempt, settings: CallConfirmSettings): Promise<string> {
  const res = await axios.post(
    RETELL_CREATE_CALL_URL,
    {
      from_number: process.env.RETELL_FROM_NUMBER,
      to_number: job.phone,
      override_agent_id: process.env.RETELL_OUTBOUND_AGENT_ID,
      metadata: { drawbridge_job_id: job.id },
      retell_llm_dynamic_variables: dynamicVariables(job, attempt, settings),
    },
    {
      headers: { Authorization: `Bearer ${process.env.RETELL_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    }
  );
  const callId = res?.data?.call_id;
  if (!callId) throw new Error('Retell did not return a call_id');
  return String(callId);
}

/** One attempt of one job: every check above, then dry run / simulate / live. */
export async function attemptCall(ctx: DispatchCtx, jobIn: OutreachJob, opts: { ignoreWindow?: boolean } = {}): Promise<DialResult> {
  const { store, now } = ctx;
  const at = now.toISOString();
  let job = jobIn;
  const attempt = currentAttempt(job);
  if (!attempt) return { jobId: job.id, result: 'refused', reason: 'Not on an approved daily list' };
  const reason = refusalReason(job, attempt, ctx, opts);
  if (reason) {
    if (job.status === 'approved') {
      store.update(job.id, ctx.by, 'refused', (j) => (j.last_result = { at, mode: ctx.mode, result: 'refused', reason }), reason, now);
    }
    console.log(`[Outreach] job ${job.id} (${job.type}): refused (${reason})`);
    return { jobId: job.id, result: 'refused', reason };
  }

  let check: { stop?: StopReason; phone?: string };
  try {
    check = await preAttemptCheck(ctx, job);
  } catch (e: any) {
    const why = `Could not re-check Veradigm® PM (${e?.code || 'UNKNOWN_ERROR'}); not called`;
    store.update(job.id, ctx.by, 'refused', (j) => (j.last_result = { at, mode: ctx.mode, result: 'refused', reason: why }), why, now);
    console.log(`[Outreach] job ${job.id} (${job.type}): ${why}`);
    return { jobId: job.id, result: 'refused', reason: why };
  }
  if (check.stop) {
    stopJob(store, job, check.stop, ctx.by, now);
    console.log(`[Outreach] job ${job.id} (${job.type}): stopped before attempt ${attempt.n} (${check.stop})`);
    return { jobId: job.id, result: 'stopped', reason: STOP_LABEL[check.stop] };
  }
  if (check.phone && check.phone !== job.phone) {
    job = store.update(job.id, ctx.by, 'phone_updated', (j) => (j.phone = check.phone!), 'number changed in Veradigm® PM', now);
    if (ctx.mode === 'live') {
      const again = refusalReason(job, attempt, ctx, opts);
      if (again) return { jobId: job.id, result: 'refused', reason: again };
    }
  }

  if (ctx.mode === 'dry_run') {
    store.update(
      job.id,
      ctx.by,
      'dry_run',
      (j) => {
        const a = currentAttempt(j)!;
        a.state = 'done';
        a.result = 'would_call';
        a.at = at;
        j.last_result = { at, mode: 'dry_run', result: 'would_call', reason: 'Dry run: no call placed' };
        advance(j);
      },
      `would call (attempt ${attempt.n}${attempt.last ? ', voicemail allowed' : ''})`,
      now
    );
    console.log(`[Outreach] DRY RUN job ${job.id} (${job.type}) attempt ${attempt.n}: would call`);
    return { jobId: job.id, result: 'would_call' };
  }

  if (ctx.mode === 'simulate') {
    const callId = `sim_${job.id.slice(0, 8)}_${attempt.n}`;
    store.update(
      job.id,
      ctx.by,
      'dialing',
      (j) => {
        j.status = 'calling';
        j.attempts += 1;
        j.retell_call_id = callId;
        j.outcome = undefined;
        j.last_result = { at, mode: 'simulate', result: 'simulated' };
      },
      `simulated attempt ${attempt.n}`,
      now
    );
    if (ctx.simulate) await ctx.simulate(store.get(job.id)!, attempt, callId);
    const after = store.get(job.id)!;
    if (after.status === 'calling') applyOutcome(store, after, 'other', 'system', now, 'Call ended without an outcome');
    return { jobId: job.id, result: 'simulated' };
  }

  store.update(
    job.id,
    ctx.by,
    'dialing',
    (j) => {
      j.status = 'calling';
      j.attempts += 1;
      j.outcome = undefined;
    },
    `attempt ${attempt.n}`,
    now
  );
  try {
    const callId = await createCall(job, attempt, ctx.settings);
    store.update(
      job.id,
      ctx.by,
      'call_placed',
      (j) => {
        j.retell_call_id = callId;
        j.last_result = { at, mode: 'live', result: 'placed' };
      },
      `attempt ${attempt.n}`,
      now
    );
    console.log(`[Outreach] job ${job.id} (${job.type}): call placed, attempt ${attempt.n}`);
    return { jobId: job.id, result: 'placed' };
  } catch (e: any) {
    // Never log the response body: it can echo the number and variables.
    const status = e?.response?.status;
    const why = status ? `Call service returned HTTP ${status}` : e?.code || 'Call could not be placed';
    store.update(
      job.id,
      ctx.by,
      'call_error',
      (j) => {
        const a = currentAttempt(j);
        if (a) {
          a.state = 'done';
          a.result = 'error';
          a.at = at;
        }
        j.last_result = { at, mode: 'live', result: 'error', reason: why };
        advance(j);
      },
      why,
      now
    );
    console.error(`[Outreach] job ${job.id} (${job.type}): call failed (${why})`);
    return { jobId: job.id, result: 'error', reason: why };
  }
}

/** Create queued bad-number staff tasks (SaveTask). In dry run they are recorded as "would create". */
export async function createPendingTasks(ctx: DispatchCtx): Promise<number> {
  let n = 0;
  for (const job of ctx.store.list().filter((j) => j.staff_task?.state === 'pending')) {
    const at = ctx.now.toISOString();
    if (!ctx.writes) {
      ctx.store.update(job.id, ctx.by, 'staff_task', (j) => (j.staff_task = { state: 'dry_run', at }), 'dry run: would create a staff task', ctx.now);
      n++;
      continue;
    }
    try {
      const r = await new UnityTaskTools(ctx.unity as any).createStaffTask({
        patientId: job.patient_ref.id,
        reason: 'other',
        message: 'Call & Confirm could not reach this patient: the phone number on file did not work. Please check and update the phone number in Veradigm PM.',
        urgency: 'routine',
      });
      ctx.store.update(job.id, ctx.by, 'staff_task', (j) => (j.staff_task = { state: 'created', at, task_id: r.taskId }), 'staff task created', ctx.now);
    } catch (e: any) {
      ctx.store.update(job.id, ctx.by, 'staff_task', (j) => (j.staff_task = { state: 'failed', at, error: e?.code || 'error' }), `staff task failed (${e?.code || 'error'})`, ctx.now);
    }
    n++;
  }
  return n;
}

/**
 * One dispatcher run: sweep, then every approved attempt whose window is open now (or the given job IDs),
 * then queued staff tasks. One staff click or one scheduler tick = one run.
 */
export async function runDue(ctx: DispatchCtx, opts: { ids?: string[]; ignoreWindow?: boolean } = {}): Promise<DialRun> {
  sweep(ctx.store, ctx.now, ctx.by);
  const today = isoDate(todayInClinic(ctx.now));
  const wanted = opts.ids ? new Set(opts.ids) : null;
  const jobs = ctx.store
    .list()
    .filter((j) => (wanted ? wanted.has(j.id) : j.status === 'approved' && j.plan.some((a) => a.state === 'approved' && a.date === today && (opts.ignoreWindow || inWindow(a.date, a.window, ctx.now)))))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, MAX_PER_RUN);
  const results: DialResult[] = [];
  for (const job of jobs) results.push(await attemptCall(ctx, ctx.store.get(job.id)!, opts));
  await createPendingTasks(ctx);
  const counts = { would_call: 0, simulated: 0, placed: 0, refused: 0, stopped: 0, error: 0 };
  for (const r of results) counts[r.result]++;
  return { mode: ctx.mode, results, counts };
}
