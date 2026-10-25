import { UnityAppointmentTools } from '../../../unity/tools/appointment.tools';
import { UnityPatientTools } from '../../../unity/tools/patient.tools';
import { toToolFailure } from '../../../unity/utils/tool-result';
import { clinicName } from '../../clinic';
import { approveList, buildDailyList, planSummary, PlanSummary } from './daily';
import { attemptCall, callbackNumber, createPendingTasks, DispatchCtx, dynamicVariables, runDue, sweep } from './dialer';
import { buildConfirmList } from './generators';
import { callingDayOnOrAfter, isCallingDay, shiftCallingDays } from './scheduler';
import { CallConfirmSettings, defaultSettings, parseWindow } from './settings';
import { SimUnity, rng, syntheticClinic, SIM_PROVIDERS } from './sim';
import { createJobStore } from './store';
import { OutreachTools } from './tools';
import { bucketOf, OUTREACH_TYPES, OutreachJob, OutreachOutcome, OutreachType, PlannedAttempt } from './types';
import { addDays, CalDate, clinicDateTime, isoDate, mdy, parseDate, spokenDate, todayInClinic } from './util';

/**
 * "Simulate week" and the simulated test calls. Both run the real Call & Confirm code (list builders, scheduler,
 * daily list, dispatcher, agent tools and, for test calls, the phone agent's real Veradigm® PM tool code) against
 * SimUnity and an in-memory job store. No phone call is placed, nothing is sent to Retell or Veradigm, and the
 * real job store is never touched.
 */
const SIM_CALLBACK = '(208) 555-0100';
const ALLOWED_WRITES = ['SetAppointmentStatus', 'SaveAppointment', 'SaveTask'];
const clinic = () => clinicName() || 'the clinic';
const callback = () => callbackNumber() || SIM_CALLBACK;

function simSettings(base?: CallConfirmSettings): CallConfirmSettings {
  return { ...(base || defaultSettings()), enabled: true, mode: 'dry_run' };
}

// ---------------------------------------------------------------- Simulate week

export interface WeekSimResult {
  seed: number;
  start: string;
  end: string;
  settings_mode: string;
  scale: { patients: number; visits: number; visits_per_calling_day: number; providers: number };
  /** The plan view as staff would see it on day 1 after the 07:00 list (planned + projected). */
  projected: PlanSummary;
  days: Array<{
    date: string;
    weekday: string;
    calling_day: boolean;
    listed: number;
    calls: number;
    by_window: Array<{ window: string; confirm: number; no_show: number; recall: number; total: number }>;
  }>;
  calls: number;
  calls_by_type: Record<OutreachType, number>;
  outcomes: Record<string, number>;
  stopped_before_call: Record<string, number>;
  unconfirmed: number;
  voicemails_left: number;
  voicemails_without_message: number;
  staff_tasks: number;
  opted_out: number;
  writes: Record<string, number>;
  limit_violations: number;
  only_allowed_writes: boolean;
  /** Estimated phone minutes (answered 2.0 min, voicemail 0.6, no answer 0.5, bad number 0.3). */
  call_minutes: number;
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** How a simulated call goes (rates from IKI's recorded outbound calls, Jul–Sep 2026: about 29% reach voicemail). */
function drawOutcome(r: () => number, job: OutreachJob, inService: boolean): OutreachOutcome {
  if (!inService) return 'wrong_number';
  const pick = r();
  if (pick < 0.29) return 'voicemail';
  if (pick < 0.52) return 'no_answer';
  const a = r();
  if (job.type === 'confirm') return a < 0.8 ? 'confirmed' : a < 0.9 ? 'moved' : a < 0.96 ? 'cancelled' : a < 0.98 ? 'callback_requested' : 'opted_out';
  if (job.type === 'no_show') return a < 0.55 ? 'booked' : a < 0.8 ? 'callback_requested' : a < 0.96 ? 'other' : 'opted_out';
  return a < 0.5 ? 'booked' : a < 0.7 ? 'callback_requested' : a < 0.97 ? 'other' : 'opted_out';
}

/** Apply a simulated call's Veradigm® PM writes (what the agent's tools would do) to SimUnity. */
function writeOutcome(sim: SimUnity, job: OutreachJob, outcome: OutreachOutcome, r: () => number, today: CalDate): void {
  const pid = job.patient_ref.id;
  const bookFrom = (from: CalDate) => {
    const d = callingDayOnOrAfter(from, simSettings());
    const resource = SIM_PROVIDERS[Math.floor(r() * SIM_PROVIDERS.length)].id;
    const a = sim.addAppt({ patientId: pid, date: isoDate(d), time: r() < 0.5 ? '09:40' : '14:20', resourceId: resource, typeId: '4', duration: 20, status: 'S' });
    sim.writes.push({ action: 'SaveAppointment', patientId: pid, detail: `new visit ${a.date}` });
  };
  const status = (letter: 'C' | 'X', reason = '') => {
    if (job.appointment && sim.setStatus(job.appointment.id, letter)) sim.writes.push({ action: 'SetAppointmentStatus', patientId: pid, detail: `${letter}${reason}` });
  };
  if (outcome === 'confirmed') status('C');
  else if (outcome === 'moved') {
    bookFrom(addDays(today, 8 + Math.floor(r() * 10)));
    status('X', ' reason 1');
  } else if (outcome === 'cancelled') status('X', ' reason 3');
  else if (outcome === 'booked') bookFrom(addDays(today, 5 + Math.floor(r() * 20)));
  else if (outcome === 'callback_requested') sim.writes.push({ action: 'SaveTask', patientId: pid, detail: 'Drawbridge: callback' });
}

/**
 * Run the scheduler over one simulated week at clinic scale. Each calling day: the 07:00 list is built from
 * SimUnity, a staff member approves it, the dispatcher runs every window (simulated calls with realistic outcome
 * rates), and the day closes (some visits turn into no-shows, a few patients confirm by text or call in).
 */
export async function simulateWeek(opts: { seed?: number; start?: CalDate; settings?: CallConfirmSettings; now?: Date } = {}): Promise<WeekSimResult> {
  const seed = opts.seed ?? 20261026;
  const settings = simSettings(opts.settings);
  const start = opts.start || shiftCallingDays(todayInClinic(opts.now || new Date()), 1, settings);
  const r = rng(seed + 1);
  const sim = syntheticClinic({ seed, start, settings });
  const store = createJobStore({ memory: true });
  const tools = new OutreachTools(store);
  let now = clinicDateTime(start, 7 * 60);
  const ctx = (): DispatchCtx => ({
    unity: sim as any,
    store,
    settings,
    now,
    by: 'simulation',
    mode: 'simulate',
    writes: true,
    simulate: async (job, _attempt, callId) => {
      const outcome = drawOutcome(r, job, sim.patients.get(job.patient_ref.id)?.inService !== false);
      writeOutcome(sim, job, outcome, r, todayInClinic(now));
      tools.result({ outcome }, { callId });
    },
  });
  const windows = [...new Set(OUTREACH_TYPES.flatMap((t) => settings[t].attempts.map((a) => a.window)))].sort(
    (a, b) => parseWindow(a)!.start - parseWindow(b)!.start
  );

  const days: WeekSimResult['days'] = [];
  let projected: PlanSummary | null = null;
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    const iso = isoDate(d);
    now = clinicDateTime(d, 7 * 60);
    sim.clock = `${iso} 07:00`;
    let listed = 0;
    if (isCallingDay(d, settings)) {
      const list = await buildDailyList(ctx());
      listed = list.entries.length;
      approveList(store, iso, 'simulated staff', now);
      if (!projected) projected = planSummary(store, settings, now, 7);
      for (const w of windows) {
        const win = parseWindow(w)!;
        // Calls spread across the window; each dispatcher run takes up to 25.
        for (let m = win.start; m < win.end; m += 5) {
          now = clinicDateTime(d, m);
          sim.clock = `${iso} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
          const run = await runDue(ctx());
          if (!run.results.length && m > win.start + 30) break;
        }
      }
    }
    // Close the day: today's visits happen (6% no-show); some future visits get confirmed by text or by a call-in.
    now = clinicDateTime(d, 17 * 60 + 30);
    sim.clock = `${iso} 17:30`;
    for (const a of sim.appts.values()) {
      if (a.date === iso && (a.status === 'S' || a.status === 'C')) sim.setStatus(a.id, r() < 0.06 ? 'N' : 'O');
      else if (a.date > iso && a.status === 'S' && r() < 0.04) sim.setStatus(a.id, 'C');
    }
    now = clinicDateTime(d, 23 * 60);
    sweep(store, now, 'simulation');
    const doneToday = store.list().flatMap((j) => j.plan.filter((a) => a.state === 'done' && a.date === iso).map((a) => ({ a, t: j.type })));
    days.push({
      date: iso,
      weekday: WD[new Date(Date.UTC(d.y, d.m - 1, d.d, 12)).getUTCDay()],
      calling_day: isCallingDay(d, settings),
      listed,
      calls: doneToday.length,
      by_window: windows.map((w) => {
        const x = doneToday.filter(({ a }) => a.window === w);
        const c = (t: OutreachType) => x.filter((y) => y.t === t).length;
        return { window: w, confirm: c('confirm'), no_show: c('no_show'), recall: c('recall'), total: x.length };
      }),
    });
  }

  const jobs = store.list();
  const done = jobs.flatMap((j) => j.plan.filter((a) => a.state === 'done').map((a) => ({ a, j })));
  const outcomes: Record<string, number> = {};
  for (const { a } of done) {
    const k = bucketOf(a.result) || (a.result === 'callback_requested' ? 'callback_requested' : 'other');
    outcomes[k] = (outcomes[k] || 0) + 1;
  }
  const stopped: Record<string, number> = {};
  for (const j of jobs) if (j.stop) stopped[j.stop.reason] = (stopped[j.stop.reason] || 0) + 1;
  const writes: Record<string, number> = {};
  for (const w of sim.writes) writes[w.action] = (writes[w.action] || 0) + 1;

  // Hard limits, checked over every patient's real attempts (all call types).
  let violations = 0;
  const byPatient = new Map<string, string[]>();
  for (const { a, j } of done) byPatient.set(j.patient_ref.id, [...(byPatient.get(j.patient_ref.id) || []), a.date]);
  for (const dates of byPatient.values()) {
    for (const d of dates) {
      if (dates.filter((x) => x === d).length > settings.limits.max_per_day) violations++;
      const c = parseDate(d)!;
      const lo = isoDate(addDays(c, -6));
      if (dates.filter((x) => x >= lo && x <= d).length > settings.limits.max_per_7_days) violations++;
    }
  }
  const minutes = done.reduce((m, { a }) => {
    const b = bucketOf(a.result);
    return m + (b === 'voicemail' ? 0.6 : b === 'no_answer' ? 0.5 : b === 'bad_number' ? 0.3 : 2.0);
  }, 0);
  const visits = [...sim.appts.values()].filter((a) => a.date >= isoDate(start) && a.date <= isoDate(addDays(start, 6))).length;
  const callingDays = days.filter((d) => d.calling_day).length || 1;
  const callsByType = { confirm: 0, no_show: 0, recall: 0 } as Record<OutreachType, number>;
  for (const { j } of done) callsByType[j.type]++;

  return {
    seed,
    start: isoDate(start),
    end: isoDate(addDays(start, 6)),
    settings_mode: 'simulate (no calls placed)',
    scale: { patients: sim.patients.size, visits, visits_per_calling_day: Math.round(visits / callingDays), providers: SIM_PROVIDERS.length },
    projected: projected || planSummary(store, settings, clinicDateTime(start, 7 * 60), 7),
    days,
    calls: done.length,
    calls_by_type: callsByType,
    outcomes,
    stopped_before_call: stopped,
    unconfirmed: jobs.filter((j) => j.status === 'unconfirmed').length,
    voicemails_left: done.filter(({ a }) => a.result === 'voicemail' && a.last).length,
    voicemails_without_message: done.filter(({ a }) => a.result === 'voicemail' && !a.last).length,
    staff_tasks: jobs.filter((j) => j.staff_task?.state === 'created').length,
    opted_out: store.optedOutCount(),
    writes,
    limit_violations: violations,
    only_allowed_writes: sim.writes.every((w) => ALLOWED_WRITES.includes(w.action)),
    call_minutes: Math.round(minutes),
  };
}

// ---------------------------------------------------------------- Simulated test calls

export type TestOutcome = 'confirmed' | 'moved' | 'cancelled' | 'voicemail' | 'no_answer' | 'wrong_number' | 'opted_out';
export const TEST_OUTCOMES: TestOutcome[] = ['confirmed', 'moved', 'cancelled', 'voicemail', 'no_answer', 'wrong_number', 'opted_out'];

export interface TranscriptLine {
  who: 'agent' | 'patient' | 'person' | 'tool' | 'system';
  text: string;
  tool?: string;
}

export interface TestCall {
  outcome: TestOutcome;
  title: string;
  attempt: string;
  transcript: TranscriptLine[];
  /** Seconds from pickup until the reason for the call has been said (estimated at 2.6 words a second). */
  core_message_seconds: number | null;
  result: { job_status: string; recorded_outcome: string; next: string };
  /** Veradigm® PM writes the call made (fake client). */
  writes: string[];
  passed: boolean;
}

const TITLES: Record<TestOutcome, string> = {
  confirmed: 'Patient confirms',
  moved: 'Patient moves the visit',
  cancelled: 'Patient cancels',
  voicemail: 'Voicemail on the final attempt',
  no_answer: 'No answer',
  wrong_number: 'Wrong number',
  opted_out: 'Patient opts out',
};

/** One synthetic patient per scenario, with a follow-up visit three business days out (the full 3-attempt plan). */
const PEOPLE: Record<TestOutcome, { first: string; last: string; dob: string; time: string }> = {
  confirmed: { first: 'Maya', last: 'Ashgrove', dob: '04/12/1961', time: '09:20' },
  moved: { first: 'Owen', last: 'Birchfield', dob: '11/02/1954', time: '10:40' },
  cancelled: { first: 'Lucia', last: 'Coldwater', dob: '07/30/1972', time: '13:20' },
  voicemail: { first: 'Theo', last: 'Dunmore', dob: '02/17/1948', time: '14:00' },
  no_answer: { first: 'Nora', last: 'Elmsworth', dob: '09/09/1966', time: '15:40' },
  wrong_number: { first: 'Eli', last: 'Fairbrook', dob: '12/03/1959', time: '08:40' },
  opted_out: { first: 'Ruth', last: 'Glenhollow', dob: '05/25/1970', time: '11:00' },
};

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * Seven scripted calls, one per outcome. Each goes through the real path: confirm list builder (GetSchedule,
 * GetAppointmentConfirmationResults, GetPatient), the scheduler, list approval, the dispatcher's checks and
 * re-read, the outbound agent tools (drawbridge_outreach_context / _result) and the phone agent's Veradigm® PM tool
 * code (unity_search_patients, unity_confirm_appointment, unity_get_open_slots, unity_save_appointment,
 * unity_cancel_appointment) against SimUnity. Only the patient's words and the agent's lines are scripted.
 */
export async function runTestCalls(opts: { now?: Date; settings?: CallConfirmSettings } = {}): Promise<TestCall[]> {
  const out: TestCall[] = [];
  for (const o of TEST_OUTCOMES) out.push(await runTestCall(o, opts));
  return out;
}

export async function runTestCall(outcome: TestOutcome, opts: { now?: Date; settings?: CallConfirmSettings } = {}): Promise<TestCall> {
  const settings = simSettings(opts.settings);
  // The call happens on the next business morning; the visit is 3 business days later (the standard 3-attempt plan).
  const now = opts.now || clinicDateTime(shiftCallingDays(todayInClinic(new Date()), 1, settings), 7 * 60);
  const today = todayInClinic(now);
  const visit = shiftCallingDays(today, 3, settings);
  const person = PEOPLE[outcome];

  const sim = new SimUnity();
  const pid = String(40100 + TEST_OUTCOMES.indexOf(outcome));
  sim.patients.set(pid, {
    id: pid,
    first: person.first,
    last: person.last,
    dob: person.dob,
    phone: `(208) 555-01${String(40 + TEST_OUTCOMES.indexOf(outcome)).padStart(2, '0')}`,
    inService: outcome !== 'wrong_number',
  });
  const appt = sim.addAppt({ patientId: pid, date: isoDate(visit), time: person.time, resourceId: '61', typeId: '4', duration: 20, status: 'S' });
  const store = createJobStore({ memory: true });
  const built = await buildConfirmList({ unity: sim as any, store, settings, now, by: 'test call' });
  const job0 = built.jobs[0];
  if (!job0 || job0.status !== 'scheduled') throw new Error(`test call ${outcome}: no job was planned`);

  // The voicemail scenario plays the final attempt (earlier ones went unanswered); the others play attempt 1.
  const target = outcome === 'voicemail' ? job0.plan.filter((a) => a.state === 'planned').slice(-1)[0] : job0.plan.find((a) => a.state === 'planned')!;
  store.update(job0.id, 'test call', 'approved', (j) => {
    for (const a of j.plan) {
      if (a.n < target.n && a.state === 'planned') {
        a.state = 'done';
        a.result = 'no_answer';
        a.date = isoDate(addDays(today, -1 - (target.n - a.n)));
      }
    }
    j.plan.find((a) => a.n === target.n)!.state = 'approved';
    j.status = 'approved';
  });

  const lines: TranscriptLine[] = [];
  const agent = (text: string) => lines.push({ who: 'agent', text });
  const patient = (text: string) => lines.push({ who: 'patient', text });
  const system = (text: string) => lines.push({ who: 'system', text });
  const tools = new OutreachTools(store, () => now);
  const apptTools = new UnityAppointmentTools(sim as any);
  const patientTools = new UnityPatientTools(sim as any);
  let spokenWords = 0;
  let coreAt: number | null = null;
  const say = (text: string, core = false) => {
    agent(text);
    spokenWords += words(text);
    if (core && coreAt === null) coreAt = spokenWords;
  };
  const hear = (text: string) => {
    patient(text);
    spokenWords += words(text);
  };
  const tool = async (name: string, fn: () => Promise<any> | any, show: (r: any) => string): Promise<any> => {
    let r: any;
    try {
      r = await fn();
    } catch (e) {
      r = toToolFailure(e, name);
    }
    lines.push({ who: 'tool', tool: name, text: r?.success === false && r?.error_code ? `failed: ${r.error_code}` : show(r) });
    return r;
  };

  let attemptInfo = '';
  const script = async (job: OutreachJob, attempt: PlannedAttempt, callId: string) => {
    const v = dynamicVariables(job, attempt, settings);
    attemptInfo = `Attempt ${attempt.n} of ${job.plan.filter((a) => a.state !== 'dropped').length}, ${spokenDate(attempt.date)} ${attempt.window}${attempt.last ? ' (final attempt: voicemail allowed)' : ''}`;
    const c0 = await tool('drawbridge_outreach_context', () => tools.context({}, { callId }), (r) => (r.success ? `ask for ${r.patientFirstName}; no details until verified` : 'not found'));
    if (!c0.success) return;
    const name = person.first;
    const opening = `Hi, this is the automated assistant calling for ${clinic()}. Our number is ${callback()}. If you'd rather not get these calls, just say "stop calling" at any time. May I speak with ${name}?`;

    if (outcome === 'no_answer') {
      system('Rang 30 seconds, nobody picked up, no voicemail greeting. The agent hangs up.');
      await tool('drawbridge_outreach_result', () => tools.result({ outcome: 'no_answer' }, { callId }), (r) => r.message);
      return;
    }
    if (outcome === 'voicemail') {
      system('Voicemail greeting detected.');
      const vm =
        v.leave_voicemail === 'yes'
          ? `Hello, this is ${clinic()} calling about an upcoming appointment. Please call us back at ${callback()}. Thank you.`
          : '';
      if (vm) say(vm, true);
      else system('Not the final attempt: the agent hangs up without leaving a message.');
      await tool('drawbridge_outreach_result', () => tools.result({ outcome: 'voicemail', notes: vm ? 'Left the no-details voicemail' : 'Reached voicemail, no message' }, { callId }), (r) => r.message);
      return;
    }
    say(opening);
    if (outcome === 'wrong_number') {
      lines.push({ who: 'person', text: `There's no ${name} here. I think you have the wrong number.` });
      say("I'm sorry to have bothered you. We'll update our records. Have a good day.");
      await tool('drawbridge_outreach_result', () => tools.result({ outcome: 'wrong_number', notes: 'Person said wrong number' }, { callId }), (r) => r.message);
      return;
    }
    if (outcome === 'opted_out') {
      hear(`This is ${name}. Please stop calling me with these.`);
      say("Understood. We won't call you with these reminders again. You can always reach us at " + callback() + '. Goodbye.');
      await tool('drawbridge_outreach_result', () => tools.result({ outcome: 'opted_out', notes: 'Asked not to be called' }, { callId }), (r) => r.message);
      return;
    }

    hear(`Yes, this is ${name}.`);
    say("Thanks. I'm calling with a quick message about your care. To protect your privacy, can you tell me your full name and date of birth?");
    hear(`${person.first} ${person.last}, ${spokenDob(person.dob)}.`);
    const found = await tool(
      'unity_search_patients',
      () => patientTools.searchPatients({ firstName: person.first, lastName: person.last, dateOfBirth: person.dob }),
      (r) => `${r.total} match${r.total === 1 ? '' : 'es'}${r.total === 1 ? ': identity verified' : ''}`
    );
    const verifiedId = found?.patients?.[0]?.patientId || found?.patients?.[0]?.id;
    const c1 = await tool('drawbridge_outreach_context', () => tools.context({ verifiedPatientId: verifiedId }, { callId }), (r) => r.message);
    if (!c1.verified) return;
    const when = `${v.appointment_date} at ${v.appointment_time} with ${v.provider_name}`;
    say(`Thank you, ${name}. You have an appointment on ${when}. Will you be able to make it?`, true);

    if (outcome === 'confirmed') {
      hear('Yes, I will be there.');
      say(`Great. I'll mark your ${v.appointment_date} visit at ${v.appointment_time} as confirmed. Shall I go ahead?`);
      hear('Yes, please.');
      await tool('unity_confirm_appointment', () => apptTools.confirmAppointment({ appointmentId: c1.appointmentId, patientId: verifiedId }), (r) => `${r.message} (SetAppointmentStatus C)`);
      say("You're all set. Please bring your medication list. Thank you, and have a good day.");
      await tool('drawbridge_outreach_result', () => tools.result({ outcome: 'confirmed', notes: 'Confirmed' }, { callId }), (r) => r.message);
      return;
    }

    if (outcome === 'cancelled') {
      hear("I can't make it. I need to cancel.");
      const reasons = await tool('unity_get_cancellation_reasons', () => apptTools.getCancellationReasons(), (r) => `${r.reasons?.length ?? 0} reasons`);
      void reasons;
      say(`I'll cancel your appointment on ${when}. Shall I go ahead?`);
      hear('Yes.');
      await tool(
        'unity_cancel_appointment',
        () => apptTools.cancelAppointment({ appointmentId: c1.appointmentId, patientId: verifiedId, cancellationReason: 'Patient Cancelled' }),
        (r) => `${r.message} (SetAppointmentStatus X, reason ${r.cancellationReason})`
      );
      say('It is cancelled. Would you like to find a new time now?');
      hear("Not now, I'll call back.");
      say(`No problem. You can reach us at ${callback()}. Have a good day.`);
      await tool('drawbridge_outreach_result', () => tools.result({ outcome: 'cancelled', notes: 'Cancelled, will call back to rebook' }, { callId }), (r) => r.message);
      return;
    }

    // moved
    hear("I can't do that day. Is there something the week after?");
    const from = addDays(visit, 3);
    const slots = await tool(
      'unity_get_open_slots',
      () => apptTools.getOpenSlots({ patientId: verifiedId, startDate: mdy(from), endDate: mdy(addDays(from, 6)), maxPerDay: 2 }),
      (r) => `${r.total} open times (GetAvailableSchedule)`
    );
    const [s1, s2] = slots?.slots || [];
    if (!s1) {
      say("I'm having trouble finding open times right now. I'll have our staff call you back.");
      return;
    }
    say(`I have ${spokenDate(s1.date)} at ${s1.time}${s2 ? `, or ${spokenDate(s2.date)} at ${s2.time}` : ''}. Which works better?`);
    hear('The first one.');
    say(`I'll move your visit to ${spokenDate(s1.date)} at ${s1.time} with ${v.provider_name}, and cancel the ${v.appointment_date} visit. Shall I go ahead?`);
    hear('Yes.');
    const saved = await tool(
      'unity_save_appointment',
      () =>
        apptTools.saveAppointment({
          patientId: verifiedId,
          appointmentDate: s1.date,
          appointmentTime: s1.time,
          duration: 20,
          providerId: s1.providerId,
          locationId: s1.locationId,
          departmentId: s1.departmentId,
        } as any),
      (r) => `${r.message} (SaveAppointment)`
    );
    if (saved?.success) {
      await tool(
        'unity_cancel_appointment',
        () => apptTools.cancelAppointment({ appointmentId: c1.appointmentId, patientId: verifiedId, cancellationReason: 'Moved Appointment' }),
        (r) => `${r.message} (SetAppointmentStatus X, reason ${r.cancellationReason})`
      );
    }
    say(`Done. You're booked for ${spokenDate(s1.date)} at ${s1.time}. Have a good day.`);
    await tool('drawbridge_outreach_result', () => tools.result({ outcome: 'moved', notes: `Moved to ${s1.date} ${s1.time}` }, { callId }), (r) => r.message);
  };

  const ctx: DispatchCtx = { unity: sim as any, store, settings, now, by: 'test call', mode: 'simulate', writes: true, simulate: script };
  const dial = await attemptCall(ctx, store.get(job0.id)!, { ignoreWindow: true });
  if (dial.result !== 'simulated') system(`Not called: ${dial.reason}`);
  if (store.get(job0.id)!.staff_task?.state === 'pending') {
    await createPendingTasks(ctx);
    const t = store.get(job0.id)!.staff_task;
    system(t?.state === 'created' ? 'Drawbridge created a staff task (SaveTask): "check and update the phone number".' : `Staff task: ${t?.state}`);
  }
  const job = store.get(job0.id)!;
  const writes = sim.writes.map((w) => `${w.action} ${w.detail}`.trim());
  const expected: Record<TestOutcome, string> = {
    confirmed: 'completed',
    moved: 'completed',
    cancelled: 'completed',
    voicemail: 'unconfirmed',
    no_answer: 'scheduled',
    wrong_number: 'stopped',
    opted_out: 'completed',
  };
  const next =
    job.status === 'unconfirmed'
      ? 'All attempts used: on the Unconfirmed list and flagged on the huddle brief'
      : job.status === 'scheduled'
        ? `Next attempt ${spokenDate(job.plan.find((a) => a.state === 'planned')?.date || '')} ${job.plan.find((a) => a.state === 'planned')?.window || ''}`.trim()
        : job.status === 'stopped'
          ? 'Stopped: staff task to fix the number'
          : outcome === 'opted_out'
            ? 'Patient added to the opt-out list'
            : 'Done: Veradigm® PM updated';
  const recorded = job.plan.find((a) => a.n === target.n)?.result || job.outcome || '';
  const passed =
    job.status === expected[outcome] &&
    sim.writes.every((w) => ALLOWED_WRITES.includes(w.action)) &&
    (outcome !== 'confirmed' || sim.appts.get(appt.id)!.status === 'C') &&
    (outcome !== 'cancelled' || sim.appts.get(appt.id)!.status === 'X') &&
    (outcome !== 'moved' || (sim.appts.get(appt.id)!.status === 'X' && sim.writes.some((w) => w.action === 'SaveAppointment')));
  return {
    outcome,
    title: TITLES[outcome],
    attempt: attemptInfo,
    transcript: lines,
    core_message_seconds: coreAt === null ? null : Math.round(coreAt / 2.6),
    result: { job_status: job.status, recorded_outcome: recorded, next },
    writes,
    passed,
  };
}

function spokenDob(dob: string): string {
  const c = parseDate(dob);
  if (!c) return dob;
  return new Date(Date.UTC(c.y, c.m - 1, c.d, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
}
