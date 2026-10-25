/**
 * Offline test for Call & Confirm (the outreach module): no network, no credentials, synthetic data only.
 * A fake Veradigm® PM client (and SimUnity) plus mocked axios. Checks:
 *  - settings: the exact per-practice shape, validation, live refused without OUTBOUND_ENABLED + allowlist;
 *  - scheduler: confirm (standard and booked under 3 days out), no-show and recall plans; weekends, holidays,
 *    windows that have passed; per-patient limits (1 a day, 3 in any 7 days) across call types;
 *  - list builders: GetSchedule status + confirmation result codes, GetAppointmentsByChangeDTTM, GetRecalls
 *    (nothing booked, daily cap), GetPatient phones; every failure is an error, nothing saved;
 *  - daily list: nothing dialed before approval; one-click approval;
 *  - dispatcher: window, calling hours, limits, live gates, exact Retell request; stop rules after a re-read
 *    (confirmed, moved, cancelled, opted out, bad number → staff task, rebooked); a failed re-read never stops;
 *  - agent tools: identity gating, outcomes, voicemail only on the final attempt, Unconfirmed after the last one;
 *  - plan endpoint GET /api/outreach/plan (shape, counts, no PHI) and settings GET/PUT;
 *  - huddle flag; staff screen (escaping, masked phones, approve, test calls); simulate week; 7 test calls.
 *
 *   npm run smoke:outreach
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

for (const k of ['UNITY_APP_NAME', 'UNITY_SVC_USERNAME', 'UNITY_SVC_PASSWORD', 'UNITY_EHR_USERNAME', 'UNITY_EHR_PASSWORD']) {
  process.env[k] = process.env[k] || 'offline-smoke';
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drawbridge-outreach-'));
process.env.CALL_RECORDS_DIR = tmp;
process.env.CLINIC_TIMEZONE = 'America/Boise';
process.env.CLINIC_NAME = 'Idaho Kidney Institute'; // per-client setting (no clinic name in code)
process.env.CLINIC_CALLBACK_NUMBER = '(208) 555-0100';

import assert from 'assert';
import type { AddressInfo } from 'net';

type Fake = (action: string, params: any, patientId: string) => any;
const OUTBOUND_ENV = ['RETELL_API_KEY', 'RETELL_OUTBOUND_AGENT_ID', 'RETELL_FROM_NUMBER', 'OUTBOUND_ALLOWLIST', 'OUTBOUND_ENABLED', 'OUTREACH_RECALL_DAILY_CAP'];

/** The settings object from the Call & Confirm brief (Oct 24, 2026); the admin console builds against it. */
const BRIEF_SETTINGS = {
  enabled: false,
  mode: 'dry_run',
  call_types: { confirm: true, no_show: true, recall: true },
  confirm: {
    attempts: [
      { days_before: 3, window: '10:00-11:30' },
      { days_before: 2, window: '15:00-16:30' },
      { days_before: 1, window: '17:00-18:30' },
    ],
  },
  no_show: {
    attempts: [
      { day_offset: 0, window: '14:00-16:00' },
      { day_offset: 1, window: '10:00-11:30' },
    ],
  },
  recall: {
    attempts: [
      { day_offset: 0, window: '10:00-11:30' },
      { day_offset: 3, window: '15:00-16:30' },
      { day_offset: 7, window: '17:00-18:30' },
    ],
  },
  limits: { max_per_day: 1, max_per_7_days: 3, calling_hours: '09:00-19:00', weekdays_only: true, holidays: [] },
  voicemail: 'last_attempt',
  approval: 'daily_list',
  test_allowlist: [],
};

async function main(): Promise<void> {
  const axiosMod = require('axios');
  const axios = axiosMod.default || axiosMod;
  const gen = await import('../platform/modules/outreach/generators');
  const { outreachJobs, createJobStore } = await import('../platform/modules/outreach/store');
  const dialer = await import('../platform/modules/outreach/dialer');
  const sched = await import('../platform/modules/outreach/scheduler');
  const settingsMod = await import('../platform/modules/outreach/settings');
  const daily = await import('../platform/modules/outreach/daily');
  const { SimUnity } = await import('../platform/modules/outreach/sim');
  const simulate = await import('../platform/modules/outreach/simulate');
  const { OutreachTools } = await import('../platform/modules/outreach/tools');
  const { outreachModule } = await import('../platform/modules/outreach');
  const { outreachRouter } = await import('../platform/modules/outreach/screen');
  const util = await import('../platform/modules/outreach/util');
  const { HuddleService } = await import('../platform/modules/huddle/brief');
  const { requireToolKey } = await import('../platform/app');
  const { toVoiceSummary } = await import('../utils/response-formatter');
  const express = (await import('express')).default;
  // dotenv may have loaded a local .env on import: start from a clean outbound config.
  for (const k of OUTBOUND_ENV) delete process.env[k];

  // ---- axios mock: record create-call requests, block everything else ----
  const posts: Array<{ url: string; body: any; config: any }> = [];
  let postImpl: (url: string, body: any, config: any) => Promise<any> = async () => ({ data: { call_id: `call_${posts.length}` } });
  axios.post = async (url: string, body: any, config: any) => {
    posts.push({ url, body, config });
    return postImpl(url, body, config);
  };
  for (const m of ['get', 'put', 'patch', 'delete', 'request']) {
    axios[m] = async () => {
      throw new Error(`network call blocked in offline test (axios.${m})`);
    };
  }

  const calls: Array<{ action: string; params: any; patientId: string }> = [];
  const svc = (fake: Fake): any => ({
    executeAction: async (a: string, p: any, pid: string) => {
      calls.push({ action: a, params: p, patientId: pid });
      return fake(a, p, pid);
    },
  });

  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`PASS ${label}`);
  };
  const rejects = async (fn: () => Promise<any>, code: string, label: string) => {
    try {
      await fn();
    } catch (e: any) {
      assert.strictEqual(e.code, code, `${label}: got ${e.code} ${e.message}`);
      ok(label);
      return;
    }
    assert.fail(`${label}: expected ${code}, got success`);
  };
  // Quiet the tool code's console lines inside a block (they carry synthetic IDs only).
  const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const [l, e] = [console.log, console.error];
    console.log = () => {};
    console.error = () => {};
    try {
      return await fn();
    } finally {
      console.log = l;
      console.error = e;
    }
  };

  const D = (iso: string) => util.parseDate(iso)!;
  /** Clinic-local time in America/Boise. October 2026: Mon 12, Tue 13, ..., Fri 16; Sat 17. */
  const at = (iso: string, hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return util.clinicDateTime(D(iso), h * 60 + m);
  };
  const S = settingsMod.defaultSettings();
  const dates = (plan: Array<{ date: string; window: string; state: string }>) => plan.filter((a) => a.state === 'planned').map((a) => `${a.date} ${a.window}`);

  // ---------------------------------------------------------------- 0. Helpers
  assert.strictEqual(util.toE164('(208) 555-0101'), '+12085550101');
  assert.strictEqual(util.toE164('555-0101'), '');
  assert.strictEqual(util.maskPhone('+12085550101'), '•••-•••-0101');
  assert.strictEqual(util.clinicDateTime(D('2026-10-12'), 10 * 60).toISOString(), '2026-10-12T16:00:00.000Z');
  assert.strictEqual(util.clinicDateTime(D('2026-11-02'), 10 * 60).toISOString(), '2026-11-02T17:00:00.000Z', 'after DST ends');
  assert.strictEqual(util.spokenDate('10/13/2026'), 'Tuesday, October 13');
  ok('helpers: phone normalize/mask, clinic-local time across DST, spoken dates');

  // ---------------------------------------------------------------- 1. Settings
  assert.deepStrictEqual(settingsMod.defaultSettings(), BRIEF_SETTINGS);
  assert.ok(settingsMod.validateSettings(BRIEF_SETTINGS).ok);
  const bad = (patch: (s: any) => void, re: RegExp, label: string) => {
    const s = JSON.parse(JSON.stringify(BRIEF_SETTINGS));
    patch(s);
    const r = settingsMod.validateSettings(s);
    assert.ok(!r.ok && r.errors.some((e) => re.test(e)), `${label}: ${r.errors.join('; ')}`);
  };
  bad((s) => (s.mode = 'live'), /OUTBOUND_ENABLED/, 'live without OUTBOUND_ENABLED');
  process.env.OUTBOUND_ENABLED = 'true';
  bad((s) => (s.mode = 'live'), /allowlist is empty/, 'live without allowlist');
  const live = settingsMod.validateSettings({ ...BRIEF_SETTINGS, mode: 'live', test_allowlist: ['(208) 555-0199'] });
  assert.ok(live.ok, live.errors.join('; '));
  assert.deepStrictEqual(live.settings!.test_allowlist, ['+12085550199']);
  delete process.env.OUTBOUND_ENABLED;
  bad((s) => (s.limits.max_per_day = 2), /max_per_day/, 'raise per-day limit');
  bad((s) => (s.limits.max_per_7_days = 4), /max_per_7_days/, 'raise 7-day limit');
  bad((s) => (s.confirm.attempts[2].window = '18:00-19:30'), /inside calling hours/, 'window after calling hours');
  bad((s) => (s.limits.calling_hours = '07:00-19:00'), /between 08:00 and 21:00/, 'calling hours too early');
  bad((s) => (s.recall.attempts[1].day_offset = 0), /different days, in order/, 'two attempts on one day');
  bad((s) => (s.limits.holidays = ['12/25/2026']), /holidays/, 'holiday format');
  bad((s) => (s.extra = 1), /Unknown field "extra"/, 'unknown field');
  bad((s) => delete s.voicemail, /Missing field "voicemail"/, 'missing field');
  bad((s) => (s.test_allowlist = ['555-0101']), /test_allowlist/, 'bad allowlist number');
  assert.deepStrictEqual(settingsMod.loadSettings('p1'), BRIEF_SETTINGS, 'no stored settings → defaults');
  process.env.OUTBOUND_ENABLED = 'true';
  assert.ok(settingsMod.saveSettings({ ...BRIEF_SETTINGS, mode: 'live', test_allowlist: ['+12085550199'] }, 'p1').ok);
  assert.strictEqual(settingsMod.loadSettings('p1').mode, 'live');
  delete process.env.OUTBOUND_ENABLED;
  assert.strictEqual(settingsMod.loadSettings('p1').mode, 'dry_run', 'stored live falls back to dry run once OUTBOUND_ENABLED is off');
  assert.deepStrictEqual(settingsMod.loadSettings('p2'), BRIEF_SETTINGS, 'settings are per practice');
  ok('settings: exact brief shape, limits can only go down, live refused without OUTBOUND_ENABLED + allowlist, per practice');

  // ---------------------------------------------------------------- 2. Scheduler
  const monday7 = at('2026-10-12', '07:00');
  let p = sched.planJob({ type: 'confirm', now: monday7, appointmentDate: D('2026-10-15') }, [], S);
  assert.strictEqual(p.kind, 'standard');
  assert.deepStrictEqual(dates(p.plan), ['2026-10-12 10:00-11:30', '2026-10-13 15:00-16:30', '2026-10-14 17:00-18:30']);
  assert.deepStrictEqual(p.plan.map((a) => a.last), [false, false, true]);
  p = sched.planJob({ type: 'confirm', now: at('2026-10-14', '07:00'), appointmentDate: D('2026-10-19') }, [], S);
  assert.deepStrictEqual(dates(p.plan), ['2026-10-14 10:00-11:30', '2026-10-15 15:00-16:30', '2026-10-16 17:00-18:30'], 'business days skip the weekend');
  ok('confirm: 3 / 2 / 1 business days before, morning / afternoon / late afternoon, voicemail only on #3');

  p = sched.planJob({ type: 'confirm', now: monday7, appointmentDate: D('2026-10-14') }, [], S);
  assert.strictEqual(p.kind, 'short');
  assert.deepStrictEqual(dates(p.plan), ['2026-10-12 10:00-11:30', '2026-10-13 17:00-18:30'], 'next morning, then day before late afternoon');
  p = sched.planJob({ type: 'confirm', now: monday7, appointmentDate: D('2026-10-13') }, [], S);
  assert.deepStrictEqual(dates(p.plan), ['2026-10-12 10:00-11:30'], 'booked 1 day out: one attempt (one call a day)');
  assert.strictEqual(p.plan.filter((a) => a.state === 'planned')[0].last, true);
  p = sched.planJob({ type: 'confirm', now: at('2026-10-12', '12:00'), appointmentDate: D('2026-10-14') }, [], S);
  assert.deepStrictEqual(dates(p.plan), ['2026-10-13 10:00-11:30'], 'morning window passed → next business morning');
  p = sched.planJob({ type: 'confirm', now: at('2026-10-12', '19:30'), appointmentDate: D('2026-10-13') }, [], S);
  assert.deepStrictEqual(dates(p.plan), [], 'nothing fits before a visit tomorrow once today is over');
  ok('confirm booked under 3 days out: next business morning + day before late afternoon, never two a day');

  const withHoliday = { ...S, limits: { ...S.limits, holidays: ['2026-10-13'] } };
  p = sched.planJob({ type: 'confirm', now: at('2026-10-09', '07:00'), appointmentDate: D('2026-10-15') }, [], withHoliday);
  assert.deepStrictEqual(dates(p.plan), ['2026-10-09 10:00-11:30', '2026-10-12 15:00-16:30', '2026-10-14 17:00-18:30'], 'holiday skipped');
  assert.ok(!sched.isCallingDay(D('2026-10-17'), S) && sched.isCallingDay(D('2026-10-17'), { ...S, limits: { ...S.limits, weekdays_only: false } }));
  assert.ok(sched.withinCallingHours(at('2026-10-12', '09:00'), S) && !sched.withinCallingHours(at('2026-10-12', '08:59'), S));
  assert.ok(!sched.withinCallingHours(at('2026-10-12', '19:00'), S) && !sched.withinCallingHours(at('2026-10-17', '10:00'), S));
  assert.ok(!sched.withinCallingHours(at('2026-10-13', '10:00'), withHoliday), 'holiday closed');
  ok('calling days: weekdays only, holidays from settings; calling hours 09:00–19:00 clinic time');

  p = sched.planJob({ type: 'no_show', now: monday7, appointmentDate: D('2026-10-09') }, [], S);
  assert.deepStrictEqual(dates(p.plan), ['2026-10-12 14:00-16:00', '2026-10-13 10:00-11:30']);
  p = sched.planJob({ type: 'no_show', now: at('2026-10-12', '17:00'), appointmentDate: D('2026-10-12') }, [], S);
  assert.deepStrictEqual(dates(p.plan), ['2026-10-13 14:00-16:00', '2026-10-14 10:00-11:30'], 'found after the window: both move a day, in order');
  p = sched.planJob({ type: 'recall', now: at('2026-10-09', '07:00') }, [], S);
  assert.deepStrictEqual(dates(p.plan), ['2026-10-09 10:00-11:30', '2026-10-12 15:00-16:30', '2026-10-16 17:00-18:30']);
  p = sched.planJob({ type: 'recall', now: at('2026-10-08', '07:00') }, [], S);
  assert.deepStrictEqual(dates(p.plan), ['2026-10-08 10:00-11:30', '2026-10-12 15:00-16:30', '2026-10-15 17:00-18:30'], 'day 3 on a Sunday → Monday');
  ok('no-show: same day 14:00–16:00 then next business morning; recall: day 0 / 3 / 7 rolled to calling days');

  assert.strictEqual(sched.breaksLimit(D('2026-10-12'), ['2026-10-12'], S), 'one call a day');
  assert.strictEqual(sched.breaksLimit(D('2026-10-15'), ['2026-10-12', '2026-10-13', '2026-10-14'], S), '3 calls in 7 days');
  assert.strictEqual(sched.breaksLimit(D('2026-10-18'), ['2026-10-12', '2026-10-13', '2026-10-14'], S), '3 calls in 7 days', 'Oct 12–18 already has 3');
  assert.strictEqual(sched.breaksLimit(D('2026-10-19'), ['2026-10-12', '2026-10-13', '2026-10-14'], S), '', 'Oct 13–19 has 2: free');
  // Same patient: a confirm job, then a recall and a no-show for them: the combined calls keep both limits.
  const fakeJob = (plan: any[]): any => ({ plan });
  const confirmPlan = sched.planJob({ type: 'confirm', now: monday7, appointmentDate: D('2026-10-15') }, [], S).plan;
  const recallPlan = sched.planJob({ type: 'recall', now: monday7 }, [fakeJob(confirmPlan)], S).plan;
  const noShowPlan = sched.planJob({ type: 'no_show', now: monday7, appointmentDate: D('2026-10-09') }, [fakeJob(confirmPlan), fakeJob(recallPlan)], S).plan;
  const all = [...confirmPlan, ...recallPlan, ...noShowPlan].filter((a) => a.state === 'planned').map((a) => a.date);
  for (const d of all) {
    assert.ok(all.filter((x) => x === d).length <= 1, `two calls on ${d}`);
    const lo = util.isoDate(util.addDays(D(d), -6));
    assert.ok(all.filter((x) => x >= lo && x <= d).length <= 3, `more than 3 in the 7 days to ${d}`);
  }
  assert.ok(recallPlan.some((a) => a.state === 'dropped' || a.note), 'recall attempts moved or dropped for the limits');
  assert.ok(noShowPlan.every((a) => a.state === 'dropped'), 'no-show attempts dropped: the week is full');
  assert.match(noShowPlan[0].note!, /dropped: (one call a day|3 calls in 7 days)/);
  ok('limits across call types: never 2 calls a day or 4 in any 7 days for one patient; extra attempts move or drop');

  // ---------------------------------------------------------------- 3. List builders
  const mem = () => createJobStore({ memory: true });
  const patients: Record<string, any> = {
    '101': { cellphone: '(208) 555-0101', firstname: 'Jane' },
    '105': { homephone: '208.555.0105', firstname: 'Ann' },
    '107': { homephone: '', workphone: 'n/a' },
    '201': { cellphone: '+1 208 555 0201', firstname: 'Rex' },
    '203': { cellphone: '2085550203' },
    '301': { cellphone: '2085550301' },
    '304': { cellphone: '2085550304' },
  };
  const getPatient = (pid: string) => ({ success: true, data: [{ getpatientinfo: [patients[pid] || {}] }] });
  const scheduleRows = [
    { apptid: 'A1', patientid: '101', patientname: 'Doe, Jane', apptdate: '10/13/2026', appttime: '09:00', resourcename: 'Dr. Lee', status: 'Scheduled' },
    { apptid: 'A2', patientid: '102', apptdate: '10/15/2026', appttime: '10:00', status: 'Confirmed' },
    { apptid: 'A3', patientid: '103', apptdate: '10/14/2026', appttime: '11:00', status: 'Cancelled' },
    { apptid: 'A4', patientid: '104', apptdate: '10/15/2026', appttime: '13:00', status: 'Scheduled', Appt_Confirmation_Result_ID: '1' },
    { apptid: 'A5', patientid: '105', patientname: 'Roe, Ann', apptdate: '10/15/2026', appttime: '14:00', resourcename: 'Dr. Kim', status: 'Scheduled', Appt_Confirmation_Result_ID: '2' },
    { apptid: 'A6', apptdate: '10/15/2026', appttime: '15:00', status: 'Scheduled' },
    { apptid: 'A7', patientid: '106', apptdate: '10/16/2026', appttime: '09:00', status: 'Scheduled' },
    { apptid: 'A8', patientid: '107', firstname: 'Max', apptdate: '10/15/2026', appttime: '15:20', status: 'Scheduled' },
  ];
  const confirmSvc = svc((a, _p, pid) => {
    if (a === 'GetSchedule') return { success: true, data: [{ getscheduleinfo: scheduleRows }] };
    if (a === 'GetAppointmentConfirmationResults')
      return { success: true, data: [{ getappointmentconfirmationresultsinfo: [{ Appt_Confirmation_Result_ID: '1', Short_Description: 'Answered - Yes' }, { Appt_Confirmation_Result_ID: '2', Short_Description: 'Left Message' }] }] };
    if (a === 'GetPatient') return getPatient(pid);
    throw new Error(`unexpected ${a}`);
  });
  const store1 = mem();
  calls.length = 0;
  const cr = await quiet(() => gen.buildConfirmList({ unity: confirmSvc, store: store1, settings: S, now: monday7, by: 'tester' }));
  assert.deepStrictEqual(calls[0], { action: 'GetSchedule', params: { Parameter1: '10/13/2026', Parameter2: '10/15/2026' }, patientId: '' });
  assert.strictEqual(calls.filter((c) => c.action === 'GetAppointmentConfirmationResults').length, 1);
  assert.deepStrictEqual(cr.skipped, { 'Already confirmed': 2, 'No usable phone number on file': 1 });
  assert.strictEqual(cr.unusable, 1);
  assert.strictEqual(cr.proposed, 2);
  assert.strictEqual(cr.short, 1);
  const jane = cr.jobs.find((j) => j.patient_ref.id === '101')!;
  assert.strictEqual(jane.phone, '+12085550101');
  assert.strictEqual(jane.plan_kind, 'short');
  assert.deepStrictEqual(dates(jane.plan), ['2026-10-12 10:00-11:30'], 'visit tomorrow: one attempt');
  const ann = cr.jobs.find((j) => j.patient_ref.id === '105')!;
  assert.deepStrictEqual(ann.appointment, { id: 'A5', date: '10/15/2026', time: '14:00', provider: 'Dr. Kim' });
  assert.strictEqual(ann.plan.filter((a) => a.state === 'planned').length, 3, '"Left Message" is not a confirmation');
  assert.ok(!cr.jobs.some((j) => ['103', '106'].includes(j.patient_ref.id)), 'cancelled and out-of-range visits skipped');
  const again = await quiet(() => gen.buildConfirmList({ unity: confirmSvc, store: store1, settings: S, now: monday7, by: 'tester' }));
  assert.strictEqual(again.proposed, 0);
  assert.strictEqual(again.duplicates, 3);
  ok('confirm list: 1–3 business days out, confirmed/cancelled skipped (status and confirmation result code), phones from GetPatient');

  calls.length = 0;
  const nsSvc = svc((a, _p, pid) => {
    if (a === 'GetAppointmentsByChangeDTTM')
      return {
        success: true,
        data: [
          {
            getappointmentsbychangedttminfo: [
              { apptid: 'N1', patientid: '201', apptdate: '10/09/2026', appttime: '08:00', status: 'No Show' },
              { apptid: 'N2', patientid: '203', apptdate: '10/08/2026', appttime: '15:00', status: 'Missed' },
              { apptid: 'N3', patientid: '203', apptdate: '10/09/2026', appttime: '15:00', status: 'Checked Out' },
              { apptid: 'N4', patientid: '203', apptdate: '10/09/2026', appttime: '16:00', status: 'N' },
            ],
          },
        ],
      };
    if (a === 'GetPatient') return getPatient(pid);
    throw new Error(`unexpected ${a}`);
  });
  const ns = await quiet(() => gen.buildNoShowList({ unity: nsSvc, store: mem(), settings: S, now: monday7, by: 'tester' }));
  assert.deepStrictEqual(calls[0].params, { Parameter1: '10/09/2026 00:00:00', Parameter2: '10/12/2026 23:59:59' }, 'since the previous business day');
  assert.deepStrictEqual(ns.jobs.map((j) => j.appointment!.id).sort(), ['N1', 'N4']);
  ok('no-show list: changes since the previous business day, "No Show"/"N" matched, older and other statuses ignored');

  calls.length = 0;
  const recallSvc = (cap?: string) => {
    if (cap) process.env.OUTREACH_RECALL_DAILY_CAP = cap;
    else delete process.env.OUTREACH_RECALL_DAILY_CAP;
    return svc((a, _p, pid) => {
      if (a === 'GetRecalls')
        return {
          success: true,
          data: [
            {
              getrecallsinfo: [
                { patientid: '301', recalltype: 'Annual follow-up', duedate: '09/01/2026', status: 'Open' },
                { patientid: '302', recalltype: 'Labs', duedate: '08/01/2026', status: 'Open' },
                { patientid: '303', recalltype: 'Labs', duedate: '08/15/2026', status: 'Completed' },
                { patientid: '304', recalltype: 'Labs', duedate: '09/15/2026 00:00:00', status: '' },
                { patientid: '305', recalltype: 'Labs', duedate: '10/20/2026', status: 'Open' },
              ],
            },
          ],
        };
      if (a === 'GetScheduleByPatientID')
        return { success: true, data: [{ getschedulebypatientidinfo: pid === '302' ? [{ Appointment_ID: 'F1', Appointment_DateTime: '11/02/2026 09:00:00 AM', Status: 'S' }] : [] }] };
      if (a === 'GetPatient') return getPatient(pid);
      throw new Error(`unexpected ${a}`);
    });
  };
  const rc = await quiet(() => gen.buildRecallList({ unity: recallSvc(), store: mem(), settings: S, now: monday7, by: 'tester' }));
  assert.deepStrictEqual(calls[0].params, { Parameter1: '10/12/2025', Parameter2: '10/11/2026' });
  assert.deepStrictEqual(rc.jobs.map((j) => j.patient_ref.id).sort(), ['301', '304']);
  assert.deepStrictEqual(rc.skipped, { 'Visit already booked': 1 });
  const capped = await quiet(() => gen.buildRecallList({ unity: recallSvc('1'), store: mem(), settings: S, now: monday7, by: 'tester' }));
  assert.deepStrictEqual(capped.jobs.map((j) => j.patient_ref.id), ['301'], 'oldest due first');
  assert.deepStrictEqual(capped.skipped, { 'Visit already booked': 1, 'Over the daily recall cap (next run)': 1 });
  delete process.env.OUTREACH_RECALL_DAILY_CAP;
  ok('recall list: past due, open, nothing booked (GetScheduleByPatientID), oldest first, daily cap');

  const failStore = mem();
  const fails = (failing: string) =>
    svc((a, p, pid) => {
      if (a === failing) return { success: false, error: 'Magic Error' };
      if (a === 'GetSchedule' || a === 'GetAppointmentConfirmationResults' || a === 'GetPatient') return confirmSvc.executeAction(a, p, pid);
      if (a === 'GetRecalls' || a === 'GetScheduleByPatientID') return recallSvc().executeAction(a, p, pid);
      return nsSvc.executeAction(a, p, pid);
    });
  const fctx = (u: any) => ({ unity: u, store: failStore, settings: S, now: monday7, by: 'tester' });
  await rejects(() => gen.buildConfirmList(fctx(fails('GetSchedule'))), 'API_ERROR', 'GetSchedule failure → API_ERROR');
  await rejects(() => gen.buildConfirmList(fctx(fails('GetAppointmentConfirmationResults'))), 'API_ERROR', 'confirmation results failure → API_ERROR (not "nobody to call")');
  await rejects(() => gen.buildConfirmList(fctx(fails('GetPatient'))), 'API_ERROR', 'GetPatient failure → whole run fails');
  await rejects(() => gen.buildNoShowList(fctx(fails('GetAppointmentsByChangeDTTM'))), 'API_ERROR', 'GetAppointmentsByChangeDTTM failure → API_ERROR');
  await rejects(() => gen.buildRecallList(fctx(fails('GetScheduleByPatientID'))), 'API_ERROR', 'recall "nothing booked" check failure → API_ERROR');
  await rejects(
    () =>
      gen.buildConfirmList(
        fctx(
          svc(() => {
            throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
          })
        )
      ),
    'NETWORK_ERROR',
    'network failure → NETWORK_ERROR'
  );
  assert.strictEqual(failStore.list().length, 0);
  ok('failed builds save nothing');

  // ---------------------------------------------------------------- 4. Daily list, approval, dispatcher, stop rules
  const sim = new SimUnity();
  const addPatient = (id: string, first: string, phone = `(208) 555-01${id.slice(-2)}`) =>
    sim.patients.set(id, { id, first, last: 'Testcase', dob: '01/02/1960', phone, inService: true });
  const names = ['Ava', 'Ben', 'Cy', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal'];
  const apptOf: Record<string, string> = {};
  names.forEach((n, i) => {
    const id = String(501 + i);
    addPatient(id, n);
    apptOf[id] = sim.addAppt({ patientId: id, date: '2026-10-15', time: '09:00', resourceId: '61', typeId: '4', duration: 20, status: 'S' }).id;
  });
  // A no-show (with a rebooked visit) and a recall patient (already booked).
  addPatient('520', 'Ida');
  const missed = sim.addAppt({ patientId: '520', date: '2026-10-09', time: '10:00', resourceId: '61', typeId: '4', duration: 20, status: 'N', changedAt: '2026-10-09 17:30' });
  sim.recalls.push({ patientId: '521', type: 'Labs', due: '2026-09-01', status: 'Open' });
  addPatient('521', 'Jon');
  sim.clock = '2026-10-12 07:00';
  const st = mem();
  const set = { ...S, enabled: true };
  const base = (now: Date) => ({ unity: sim as any, store: st, settings: set, now, by: 'tester' });
  const list = await quiet(() => daily.buildDailyList(base(monday7)));
  assert.strictEqual(list.entries.length, 10, '8 confirm + 1 no-show + 1 recall attempts today');
  assert.ok(list.entries.every((e) => e.n === 1));
  assert.ok(list.summary.some((l) => /Confirm \(10\/13\/2026 – 10\/15\/2026\): Veradigm® PM returned 8 row\(s\)/.test(l)), list.summary.join(' | '));
  assert.strictEqual(daily.pendingApproval(st, '2026-10-12'), 10);
  const dctx = (now: Date, mode: 'dry_run' | 'live' | 'simulate' = 'dry_run', extra: any = {}) => ({ ...base(now), mode, ...extra });
  let run = await quiet(() => dialer.runDue(dctx(at('2026-10-12', '10:05'))));
  assert.strictEqual(run.results.length, 0, 'nothing runs before the list is approved');
  const someJob = st.list().find((j) => j.type === 'confirm')!;
  run = await quiet(() => dialer.runDue(dctx(at('2026-10-12', '10:05')), { ids: [someJob.id] }));
  assert.strictEqual(run.results[0].reason, 'Not on an approved daily list');
  ok('daily list: 07:00 build lists today\'s attempts; nothing is dialed before staff approve it');

  assert.strictEqual(daily.approveList(st, '2026-10-12', 'staff1', monday7), 10);
  assert.strictEqual(daily.pendingApproval(st, '2026-10-12'), 0);
  assert.strictEqual(st.getList('2026-10-12')!.approved_by, 'staff1');
  run = await quiet(() => dialer.runDue(dctx(at('2026-10-12', '09:30'))));
  assert.strictEqual(run.results.length, 0, 'before the 10:00 window nothing is due');
  run = await quiet(() => dialer.runDue(dctx(at('2026-10-12', '09:30')), { ids: [someJob.id] }));
  assert.match(run.results[0].reason!, /Outside this attempt's window \(10:00-11:30\)/);
  ok('one-click approval; approved attempts wait for their window');

  // Stop rules: the visit changed or the patient changed since the list was built.
  const job = (pid: string) => st.list().find((j) => j.patient_ref.id === pid)!;
  sim.setStatus(apptOf['501'], 'C'); // confirmed by text
  sim.appts.get(apptOf['502'])!.date = '2026-10-16'; // moved by staff
  sim.setStatus(apptOf['503'], 'X'); // cancelled
  sim.patients.get('504')!.phone = ''; // no usable number now
  st.optOut('505'); // asked not to be called (inbound call)
  sim.appts.get(apptOf['506'])!.time = '13:40'; // moved to another time
  sim.addAppt({ patientId: '520', date: '2026-10-21', time: '09:00', resourceId: '61', typeId: '4', duration: 20, status: 'S' }); // no-show rebooked
  sim.addAppt({ patientId: '521', date: '2026-10-30', time: '09:00', resourceId: '61', typeId: '4', duration: 20, status: 'S' }); // recall booked
  sim.failing.add('GetScheduleByPatientID');
  run = await quiet(() => dialer.runDue(dctx(at('2026-10-12', '10:05')), { ids: [job('507').id] }));
  assert.match(run.results[0].reason!, /Could not re-check Veradigm® PM \(API_ERROR\); not called/);
  assert.strictEqual(job('507').status, 'approved', 'a failed re-read never stops the job');
  sim.failing.clear();
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: any[]) => {
    logs.push(a.join(' '));
  };
  try {
    run = await dialer.runDue(dctx(at('2026-10-12', '10:05')));
  } finally {
    console.log = origLog;
  }
  assert.strictEqual(run.mode, 'dry_run');
  assert.deepStrictEqual(run.counts, { would_call: 2, simulated: 0, placed: 0, refused: 0, stopped: 7, error: 0 });
  assert.strictEqual(job('520').status, 'approved', 'the no-show attempt waits for 14:00');
  run = await quiet(() => dialer.runDue(dctx(at('2026-10-12', '14:05'))));
  assert.deepStrictEqual(run.counts.stopped, 1);
  const stopOf = (pid: string) => job(pid).stop?.reason;
  assert.deepStrictEqual(
    ['501', '502', '503', '504', '505', '506', '520', '521'].map(stopOf),
    ['confirmed', 'moved', 'cancelled', 'bad_number', 'opted_out', 'moved', 'handled', 'booked']
  );
  assert.ok(job('501').plan.every((a) => a.state === 'stopped'), 'remaining attempts not made');
  assert.strictEqual(job('504').staff_task!.state, 'dry_run', 'dry run records the fix-the-number task without writing');
  assert.strictEqual(sim.writes.length, 0, 'dry run writes nothing to Veradigm');
  assert.strictEqual(posts.length, 0);
  const j507 = job('507');
  assert.strictEqual(j507.plan[0].result, 'would_call');
  assert.strictEqual(j507.status, 'scheduled', 'next attempt still planned');
  assert.ok(logs.some((l) => /would call/.test(l)));
  assert.ok(!logs.some((l) => /555|Testcase|Gus|Hal/.test(l)), `logs leak PHI: ${logs.join(' | ')}`);
  ok('stop rules before every attempt: confirmed, moved (date or time), cancelled, bad number (task), opted out, rebooked, booked');
  ok('dry run: "would call", no Retell request, no Veradigm write, no number or name in logs');

  // Per-patient limits at dial time (two jobs of one patient both approved today, by force).
  const lim = mem();
  const mk = (type: any, key: string) =>
    lim.addMany([{ type, patient_ref: { system: 'veradigm_pm', id: '501' }, patient_first_name: 'Ava', phone: '+12085550101', dedupe_key: key, plan: [{ n: 1, date: '2026-10-12', window: '10:00-11:30', last: false, state: 'approved' }] }], 't')[0];
  const ja = mk('recall', 'a');
  const jb = mk('recall', 'b');
  lim.update(ja.id, 't', 'x', (j) => (j.status = 'approved'));
  lim.update(jb.id, 't', 'x', (j) => (j.status = 'approved'));
  const limSim = new SimUnity();
  limSim.patients.set('501', sim.patients.get('501')!);
  const limCtx = { unity: limSim as any, store: lim, settings: S, now: at('2026-10-12', '10:05'), by: 't', mode: 'dry_run' as const };
  run = await quiet(() => dialer.runDue(limCtx));
  assert.deepStrictEqual(run.results.map((r) => r.result).sort(), ['refused', 'would_call']);
  assert.strictEqual(run.results.find((r) => r.result === 'refused')!.reason, 'Patient already called today');
  const jc = lim.addMany([{ type: 'recall', patient_ref: { system: 'veradigm_pm', id: '501' }, patient_first_name: 'Ava', phone: '+12085550101', dedupe_key: 'c', plan: [
    { n: 1, date: '2026-10-08', window: '10:00-11:30', last: false, state: 'done', result: 'no_answer' },
    { n: 2, date: '2026-10-09', window: '10:00-11:30', last: false, state: 'done', result: 'no_answer' },
    { n: 3, date: '2026-10-13', window: '10:00-11:30', last: true, state: 'approved' },
  ] }], 't')[0];
  lim.update(jc.id, 't', 'x', (j) => (j.status = 'approved'));
  run = await quiet(() => dialer.runDue({ ...limCtx, now: at('2026-10-13', '10:05') }, { ids: [jc.id] }));
  assert.strictEqual(run.results[0].reason, 'Patient already called 3 times in 7 days');
  ok('dial-time limits across jobs: 1 a day, 3 in any 7 days');

  // ---- Live gates and the exact Retell request ----
  const liveStore = mem();
  const liveSim = new SimUnity();
  liveSim.patients.set('601', { id: '601', first: 'Jane', last: 'Testcase', dob: '01/02/1960', phone: '(208) 555-0101', inService: true });
  const la = liveSim.addAppt({ patientId: '601', date: '2026-10-15', time: '09:00', resourceId: '61', typeId: '4', duration: 20, status: 'S' });
  const liveSet = { ...S, enabled: true, mode: 'live' as const, test_allowlist: [] as string[] };
  const lctx = (now: Date, settings = liveSet) => ({ unity: liveSim as any, store: liveStore, settings, now, by: 'tester', mode: 'live' as const });
  await quiet(() => daily.buildDailyList({ ...lctx(monday7), settings: { ...liveSet, call_types: { confirm: true, no_show: false, recall: false } } }));
  daily.approveList(liveStore, '2026-10-12', 'staff1', monday7);
  const lj = () => liveStore.list()[0];
  const tryLive = async (settings = liveSet) => (await quiet(() => dialer.runDue(lctx(at('2026-10-12', '10:05'), settings)))).results[0];
  assert.match((await tryLive()).reason!, /OUTBOUND_ENABLED is not true/);
  process.env.OUTBOUND_ENABLED = 'true';
  assert.match((await tryLive()).reason!, /needs a test allowlist/);
  assert.match((await tryLive({ ...liveSet, test_allowlist: ['+12085559999'] })).reason!, /not on the outbound allowlist/);
  const allowed = { ...liveSet, test_allowlist: ['+12085550101'] };
  assert.match((await tryLive(allowed)).reason!, /RETELL_API_KEY/);
  process.env.RETELL_API_KEY = 'test-key-not-real';
  process.env.RETELL_OUTBOUND_AGENT_ID = 'agent_test_outbound';
  assert.match((await tryLive(allowed)).reason!, /RETELL_FROM_NUMBER/);
  process.env.RETELL_FROM_NUMBER = '+12085550000';
  assert.strictEqual(posts.length, 0);
  const lr = await tryLive(allowed);
  assert.strictEqual(lr.result, 'placed');
  assert.strictEqual(posts.length, 1);
  const req = posts[0];
  assert.strictEqual(req.url, 'https://api.retellai.com/v2/create-phone-call');
  assert.strictEqual(req.config.headers.Authorization, 'Bearer test-key-not-real');
  assert.deepStrictEqual(Object.keys(req.body).sort(), ['from_number', 'metadata', 'override_agent_id', 'retell_llm_dynamic_variables', 'to_number']);
  assert.strictEqual(req.body.to_number, '+12085550101');
  assert.deepStrictEqual(req.body.metadata, { drawbridge_job_id: lj().id });
  assert.deepStrictEqual(req.body.retell_llm_dynamic_variables, {
    patient_first_name: 'Jane',
    appointment_date: 'Thursday, October 15',
    appointment_time: '9:00 AM',
    provider_name: 'Calder, Iris MD',
    outreach_type: 'confirm',
    clinic_name: 'Idaho Kidney Institute',
    callback_number: '(208) 555-0100',
    leave_voicemail: 'no',
  });
  assert.strictEqual(lj().status, 'calling');
  assert.strictEqual(lj().attempts, 1);
  assert.strictEqual(lj().retell_call_id, 'call_1');
  assert.strictEqual((await quiet(() => dialer.runDue(lctx(at('2026-10-12', '10:06'), allowed)))).results.length, 0, 'a job being called is not dialed twice');
  ok('live: OUTBOUND_ENABLED, test allowlist, Retell config all required; request carries only the allowed variables');

  // ---------------------------------------------------------------- 5. Agent tools
  const tools = new OutreachTools(liveStore, () => at('2026-10-12', '10:08'));
  const c0 = tools.context({}, { callId: 'call_1' });
  assert.strictEqual(c0.jobId, lj().id);
  assert.ok(!/October|9:00/.test(c0.message), 'no appointment details before verification');
  assert.strictEqual(c0.appointmentId, undefined);
  assert.strictEqual(tools.context({ verifiedPatientId: '999' }, { callId: 'call_1' }).success, false);
  const cOk = tools.context({ verifiedPatientId: '601' }, { callId: 'call_1' });
  assert.match(cOk.message, /Thursday, October 15 at 9:00 AM/);
  assert.strictEqual(cOk.appointmentId, la.id);
  assert.match(toVoiceSummary('drawbridge_outreach_context', cOk), new RegExp(`Appointment ID: ${la.id}`));
  assert.strictEqual(tools.context({ jobId: lj().id }, { callId: 'call_other' }).success, false, 'job is bound to its own call');
  assert.strictEqual(tools.result({ outcome: 'great' }, { callId: 'call_1' }).success, false);
  assert.strictEqual(tools.result({ outcome: 'no_answer' }, { callId: 'call_1' }).success, true);
  assert.strictEqual(lj().status, 'scheduled');
  assert.strictEqual(lj().plan[0].result, 'no_answer');
  assert.strictEqual(tools.result({ outcome: 'confirmed' }, { callId: 'call_1' }).message, 'Already recorded for this call. End the call politely.');
  ok('outreach_context: no details until name + DOB match; outreach_result: no_answer → next attempt stays planned');

  // Attempts 2 and 3 (approved by hand for the test): voicemail allowed only on the final one, then Unconfirmed.
  for (const [n, day, time, callId] of [
    [2, '2026-10-13', '15:05', 'call_2'],
    [3, '2026-10-14', '17:05', 'call_3'],
  ] as Array<[number, string, string, string]>) {
    liveStore.update(lj().id, 't', 'approved', (j) => {
      j.plan.find((a) => a.n === n)!.state = 'approved';
      j.status = 'approved';
    });
    postImpl = async () => ({ data: { call_id: callId } });
    const r2 = await quiet(() => dialer.runDue(lctx(at(day, time), allowed)));
    assert.strictEqual(r2.counts.placed, 1, `attempt ${n}`);
    assert.strictEqual(posts[posts.length - 1].body.retell_llm_dynamic_variables.leave_voicemail, n === 3 ? 'yes' : 'no');
    new OutreachTools(liveStore, () => at(day, time)).result({ outcome: n === 2 ? 'reschedule_requested' : 'voicemail' }, { callId });
    if (n === 2) {
      assert.strictEqual(lj().outcome, 'moved', 'legacy outcome name accepted');
      assert.strictEqual(lj().status, 'completed');
      // Re-open for attempt 3 (as if attempt 2 had gone to voicemail without a message).
      liveStore.update(lj().id, 't', 'x', (j) => {
        j.plan[1].result = 'voicemail';
        j.plan[2].state = 'planned';
        j.plan[2].result = undefined;
        j.status = 'scheduled';
        j.outcome = undefined;
      });
    }
  }
  assert.strictEqual(lj().status, 'unconfirmed');
  assert.ok(liveStore.unconfirmedAppointmentIds().has(la.id));
  ok('voicemail only on the final attempt (leave_voicemail yes/no); after it the visit goes on the Unconfirmed list');

  // wrong_number → stopped + staff task (SaveTask) when writes are on.
  const wStore = mem();
  const wSim = new SimUnity();
  wSim.patients.set('701', { id: '701', first: 'Kim', last: 'Testcase', dob: '01/02/1960', phone: '(208) 555-0177', inService: false });
  wSim.addAppt({ patientId: '701', date: '2026-10-15', time: '09:00', resourceId: '61', typeId: '4', duration: 20, status: 'S' });
  const wctx = { unity: wSim as any, store: wStore, settings: set, now: at('2026-10-12', '10:10'), by: 't', mode: 'simulate' as const, writes: true };
  await quiet(() => daily.buildDailyList({ ...wctx, now: monday7 }));
  daily.approveList(wStore, '2026-10-12', 'staff1', monday7);
  const wTools = new OutreachTools(wStore);
  await quiet(() => dialer.runDue({ ...wctx, simulate: async (_j, _a, callId) => void wTools.result({ outcome: 'wrong_number' }, { callId }) }));
  const wj = wStore.list()[0];
  assert.strictEqual(wj.status, 'stopped');
  assert.strictEqual(wj.stop!.reason, 'bad_number');
  assert.strictEqual(wj.staff_task!.state, 'created');
  assert.deepStrictEqual(wSim.writes.map((w) => w.action), ['SaveTask']);
  tools.result({ outcome: 'opted_out' }, {});
  ok('wrong number → calls stop, staff task created (SaveTask), nothing else written');

  // Sweep: an approved attempt whose window ended is missed; a confirm job with nothing left goes Unconfirmed.
  const sw = mem();
  const sj = sw.addMany([{ type: 'confirm', patient_ref: { system: 'veradigm_pm', id: '801' }, patient_first_name: 'Lu', phone: '+12085550180', appointment: { id: 'Z1', date: '10/13/2026', time: '09:00', provider: '' }, dedupe_key: 'z', plan: [{ n: 1, date: '2026-10-12', window: '10:00-11:30', last: true, state: 'approved' }] }], 't')[0];
  sw.update(sj.id, 't', 'x', (j) => (j.status = 'approved'));
  dialer.sweep(sw, at('2026-10-12', '11:31'));
  assert.strictEqual(sw.get(sj.id)!.plan[0].state, 'missed');
  assert.strictEqual(sw.get(sj.id)!.status, 'unconfirmed');
  ok('sweep: attempts whose window ended are missed, never called late');

  // ---------------------------------------------------------------- 6. Huddle flag
  const huddle = new HuddleService(
    {
      unity: { executeAction: async () => ({ success: true, data: [{ getscheduleinfo: [{ apptid: la.id, patientid: '601', patientname: 'Testcase, Jane', appttime: '09:00', resourcename: 'Dr. Lee', status: 'Scheduled' }, { apptid: 'OTHER', patientid: '602', patientname: 'Testcase, Bo', appttime: '10:00', resourcename: 'Dr. Lee', status: 'Scheduled' }] }] }) } as any,
      runTool: async () => ({}),
    },
    { unconfirmed: () => liveStore.unconfirmedAppointmentIds(), budgetMs: 2000 }
  );
  const brief = await quiet(() => huddle.getBrief('2026-10-15'));
  const visits = brief.providers.flatMap((pr) => pr.visits);
  assert.strictEqual(visits.find((v) => v.appointmentId === la.id)!.flags[0].key, 'unconfirmed');
  assert.ok(!visits.find((v) => v.appointmentId === 'OTHER')!.flags.some((f) => f.key === 'unconfirmed'));
  assert.strictEqual(brief.summary.unconfirmed, 1);
  ok('huddle brief: Unconfirmed flag on visits whose confirmation calls all went unanswered');

  // ---------------------------------------------------------------- 7. Plan summary + endpoint
  for (const k of OUTBOUND_ENV) delete process.env[k];
  const now = new Date();
  const today = util.todayInClinic(now);
  const todayIso = util.isoDate(today);
  const nextCalling = sched.callingDayOnOrAfter(util.addDays(today, 1), S);
  const plannedJob = (pid: string, type: any, plan: any[], extra: any = {}) =>
    outreachJobs.addMany([{ type, patient_ref: { system: 'veradigm_pm', id: pid }, patient_first_name: 'Zed', phone: '+12085550199', dedupe_key: `plan|${pid}`, plan, ...extra }], 'tester')[0];
  plannedJob('901', 'confirm', [
    { n: 1, date: todayIso, window: '10:00-11:30', last: false, state: 'done', result: 'confirmed' },
  ], { status: 'completed', appointment: { id: 'P1', date: '10/30/2026', time: '09:00', provider: 'Dr. Lee' } });
  plannedJob('902', 'recall', [
    { n: 1, date: todayIso, window: '10:00-11:30', last: false, state: 'done', result: 'voicemail' },
    { n: 2, date: util.isoDate(nextCalling), window: '15:00-16:30', last: true, state: 'planned' },
  ]);
  plannedJob('903', 'no_show', [{ n: 1, date: todayIso, window: '14:00-16:00', last: true, state: 'done', result: 'wrong_number' }], { status: 'stopped' });
  const sum = daily.planSummary(outreachJobs, S, now, 7);
  assert.strictEqual(sum.days.length, 7);
  assert.strictEqual(sum.days[0].date, todayIso);
  assert.deepStrictEqual(sum.days[0].results, { confirmed: 1, moved: 0, cancelled: 0, voicemail: 1, no_answer: 0, opted_out: 0, bad_number: 1 });
  assert.deepStrictEqual(sum.days[0].planned, { confirm: 1, no_show: 1, recall: 1, total: 3 });
  const nextDay = sum.days.find((d) => d.date === util.isoDate(nextCalling))!;
  assert.deepStrictEqual(nextDay.windows.find((w) => w.window === '15:00-16:30')!.planned, { confirm: 0, no_show: 0, recall: 1, total: 1 });
  assert.deepStrictEqual(nextDay.windows.map((w) => w.window), ['10:00-11:30', '14:00-16:00', '15:00-16:30', '17:00-18:30'], 'every window shows on a calling day');
  assert.strictEqual(sum.totals.results.confirmed, 1);
  ok('plan summary: per day, per window, per type planned counts and results so far');

  process.env.DRAWBRIDGE_TOOL_KEY = 'smoke-tool-key';
  const api = express();
  api.use('/api/outreach', requireToolKey, express.json(), outreachModule.apiRouter!({} as any));
  const apiServer = api.listen(0, '127.0.0.1');
  await new Promise((resolve) => apiServer.once('listening', resolve));
  const apiBase = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}/api/outreach`;
  const K = { 'x-drawbridge-key': 'smoke-tool-key' };
  try {
    assert.strictEqual((await fetch(`${apiBase}/plan?days=7`)).status, 401, 'tool key required');
    const res = await fetch(`${apiBase}/plan?days=7`, { headers: K });
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    const j = JSON.parse(text);
    assert.deepStrictEqual(Object.keys(j), ['practice', 'timezone', 'generated_at', 'enabled', 'mode', 'days', 'totals', 'unconfirmed', 'opted_out', 'bad_number_tasks']);
    assert.deepStrictEqual(Object.keys(j.days[0]), ['date', 'weekday', 'calling_day', 'list', 'planned', 'projected', 'windows', 'results', 'would_call', 'stopped']);
    assert.deepStrictEqual(Object.keys(j.days[0].results), ['confirmed', 'moved', 'cancelled', 'voicemail', 'no_answer', 'opted_out', 'bad_number']);
    assert.strictEqual(j.days.length, 7);
    assert.strictEqual(j.mode, 'dry_run');
    assert.ok(!/Zed|555|0199|P1|Dr\. Lee/.test(text), 'counts only: no names, numbers or IDs');
    assert.strictEqual(((await (await fetch(`${apiBase}/plan?days=3`, { headers: K })).json()) as any).days.length, 3);
    assert.strictEqual(((await (await fetch(`${apiBase}/plan?days=99`, { headers: K })).json()) as any).days.length, 14);
    assert.deepStrictEqual(await (await fetch(`${apiBase}/settings`, { headers: K })).json(), BRIEF_SETTINGS);
    const put = (body: any) => fetch(`${apiBase}/settings`, { method: 'PUT', headers: { ...K, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const r400 = await put({ ...BRIEF_SETTINGS, mode: 'live' });
    assert.strictEqual(r400.status, 400);
    assert.ok(((await r400.json()) as any).errors.some((e: string) => /OUTBOUND_ENABLED/.test(e)));
    const r200 = await put({ ...BRIEF_SETTINGS, enabled: true, limits: { ...BRIEF_SETTINGS.limits, holidays: ['2026-11-26'] } });
    assert.strictEqual(r200.status, 200);
    assert.strictEqual(settingsMod.loadSettings().enabled, true);
    assert.deepStrictEqual(settingsMod.loadSettings().limits.holidays, ['2026-11-26']);
  } finally {
    apiServer.close();
  }
  ok('GET /api/outreach/plan?days=N (tool key, exact shape, no PHI) and GET/PUT /api/outreach/settings (validated)');

  // ---------------------------------------------------------------- 8. Simulation and test calls
  const week = await quiet(() => simulate.simulateWeek({ now: at('2026-10-09', '18:00') }));
  assert.strictEqual(week.start, '2026-10-12');
  assert.ok(week.scale.visits_per_calling_day >= 55 && week.scale.visits_per_calling_day <= 75, `clinic scale ${week.scale.visits_per_calling_day}`);
  assert.ok(week.calls > 300, `calls ${week.calls}`);
  assert.strictEqual(week.limit_violations, 0);
  assert.strictEqual(week.only_allowed_writes, true);
  assert.ok(week.voicemails_left > 0 && week.voicemails_without_message > week.voicemails_left, 'messages only on final attempts');
  assert.ok(week.unconfirmed > 0 && week.staff_tasks > 0 && (week.stopped_before_call.confirmed || 0) > 0);
  assert.ok(week.days.filter((d) => !d.calling_day).every((d) => d.calls === 0), 'no calls on the weekend');
  const vm = (week.outcomes.voicemail || 0) / week.calls;
  assert.ok(vm > 0.2 && vm < 0.4, `voicemail share ${vm}`);
  assert.ok(week.projected.days[0].planned.total > 0 && week.projected.totals.projected.confirm > 0);
  ok(`simulate week: ${week.calls} simulated calls, 0 limit violations, only SetAppointmentStatus/SaveAppointment/SaveTask written`);

  // Real clock: the booking tool refuses times in the past, so the test visits sit in the coming days.
  const testCalls = await quiet(() => simulate.runTestCalls());
  assert.deepStrictEqual(testCalls.map((c) => c.outcome), ['confirmed', 'moved', 'cancelled', 'voicemail', 'no_answer', 'wrong_number', 'opted_out']);
  for (const c of testCalls) {
    assert.ok(c.passed, `${c.outcome}: ${JSON.stringify(c.result)} ${c.writes.join(', ')}`);
    const firstAgent = c.transcript.find((l) => l.who === 'agent');
    if (firstAgent && !['voicemail'].includes(c.outcome)) {
      assert.match(firstAgent.text, /Idaho Kidney Institute/);
      assert.match(firstAgent.text, /\(208\) 555-0100/);
      assert.match(firstAgent.text, /stop calling/);
    }
    const verifiedAt = c.transcript.findIndex((l) => l.tool === 'unity_search_patients');
    const before = (verifiedAt < 0 ? c.transcript : c.transcript.slice(0, verifiedAt)).filter((l) => l.who === 'agent').map((l) => l.text).join(' ');
    assert.ok(!/October|AM|PM|Calder/.test(before), `${c.outcome}: details before verification: ${before}`);
    if (c.core_message_seconds !== null) assert.ok(c.core_message_seconds <= 60, `${c.outcome}: core message at ${c.core_message_seconds}s`);
    const text = c.transcript.map((l) => l.text).join(' ');
    assert.ok(!/balance|payment|bill|insurance|offer/i.test(text), `${c.outcome}: no marketing or billing`);
  }
  const vmCall = testCalls.find((c) => c.outcome === 'voicemail')!;
  assert.match(vmCall.attempt, /Attempt 3 of 3.*final attempt/);
  const vmText = vmCall.transcript.filter((l) => l.who === 'agent').map((l) => l.text).join(' ');
  assert.strictEqual(vmText, 'Hello, this is Idaho Kidney Institute calling about an upcoming appointment. Please call us back at (208) 555-0100. Thank you.');
  assert.deepStrictEqual(testCalls.find((c) => c.outcome === 'confirmed')!.writes, ['SetAppointmentStatus C']);
  assert.deepStrictEqual(testCalls.find((c) => c.outcome === 'cancelled')!.writes, ['SetAppointmentStatus X reason 3']);
  assert.deepStrictEqual(testCalls.find((c) => c.outcome === 'moved')!.writes.map((w) => w.split(' ')[0]), ['SaveAppointment', 'SetAppointmentStatus']);
  assert.deepStrictEqual(testCalls.find((c) => c.outcome === 'wrong_number')!.writes.map((w) => w.split(' ')[0]), ['SaveTask']);
  assert.deepStrictEqual(testCalls.find((c) => c.outcome === 'opted_out')!.writes, []);
  assert.strictEqual(testCalls.find((c) => c.outcome === 'no_answer')!.result.job_status, 'scheduled');
  ok('7 test calls through the real tools: opening with clinic + callback + opt-out, no detail before name + DOB, core message < 1 min, no-details voicemail on the final attempt');

  // ---------------------------------------------------------------- 9. Staff screen
  settingsMod.saveSettings({ ...BRIEF_SETTINGS, enabled: true });
  const screenSim = new SimUnity();
  screenSim.patients.set('950', { id: '950', first: '<script>alert(1)</script>', last: 'Testcase', dob: '01/02/1960', phone: '(208) 555-0195', inService: true });
  screenSim.addAppt({ patientId: '950', date: '2026-10-15', time: '09:00', resourceId: '61', typeId: '4', duration: 20, status: 'S' });
  let clockNow = monday7;
  const app = express();
  app.use((rq: any, _rs, next) => {
    rq.drawbridgeUser = 'tester';
    next();
  });
  app.use('/app/outreach', express.urlencoded({ extended: false }), outreachRouter({ unity: screenSim as any, runTool: async () => ({}) }, () => clockNow));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/app/outreach`;
  const post = (pth: string, body = '') =>
    fetch(`${baseUrl}${pth}`, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  const follow = async (r: Response) => (await fetch(new URL(r.headers.get('location')!, baseUrl))).text();
  try {
    let html = await (await fetch(baseUrl)).text();
    assert.ok(html.includes('Call &amp; Confirm') && html.includes('DRY RUN') && html.includes('Scheduler on'));
    assert.ok(html.includes("Build today's list now"));
    html = await quiet(async () => follow(await post('/build')));
    assert.ok(/Today&#39;s list: 1 call attempt\(s\)|Today's list: 1 call attempt\(s\)/.test(html), 'list built from Veradigm® PM');
    assert.ok(html.includes('Approve today&#39;s list (1)') || html.includes("Approve today's list (1)"));
    assert.ok(!html.includes('<script>alert(1)</script>'), 'first name is escaped');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!/2085550195|555-0195/.test(html), 'full phone numbers never rendered');
    assert.ok(html.includes('•••-•••-0195'));
    html = await follow(await post('/approve'));
    assert.ok(html.includes('Approved 1 call attempt(s) for today.'));
    clockNow = at('2026-10-12', '10:05');
    html = await quiet(async () => follow(await post('/run')));
    assert.ok(html.includes('DRY RUN: no calls placed. 1 would be called, 0 stopped, 0 refused.'), 'dry-run run shown');
    html = await quiet(async () => follow(await post('/simulate/calls')));
    assert.ok(html.includes('7 test calls played, all ended as expected. No call was placed.'));
    assert.ok(html.includes('Verify name + date of birth (Veradigm® PM)') && html.includes('Drawbridge agent'));
    assert.strictEqual((html.match(/<details class="card"/g) || []).length, 7 + 2, '7 transcripts + list summary + settings');
    html = await quiet(async () => follow(await post('/simulate/week')));
    assert.ok(html.includes('Call limits and write rules held'));
    assert.ok(html.includes('Projected week'));
    assert.ok(!/\b(MCP|FHIR|Unity)\b/.test(html.replace(/<style>[\s\S]*?<\/style>/g, '')), 'screen text never says MCP/FHIR/Unity');
    const jobId = outreachJobs.list().find((x) => x.patient_ref.id === '950')!.id;
    html = await follow(await post('/jobs', `action=skip&ids=${jobId}`));
    assert.ok(html.includes('Stopped calls for 1 patient(s).'));
    assert.strictEqual(outreachJobs.get(jobId)!.status, 'skipped');
    // A failing Veradigm read shows an error, never an empty list.
    screenSim.failing.add('GetSchedule');
    html = await quiet(async () => follow(await post('/build')));
    assert.ok(html.includes('Could not read from Veradigm® PM (API_ERROR). The list was not built; this does not mean there is nobody to call.'));
  } finally {
    server.close();
  }
  ok('screen: build → one-click approve → dry run; escaped values, masked phones, test calls and week simulation readable; errors shown');

  // ---------------------------------------------------------------- 10. Module wiring
  assert.deepStrictEqual(outreachModule.getTools!().map((t) => t.name), ['drawbridge_outreach_context', 'drawbridge_outreach_result']);
  assert.deepStrictEqual(outreachModule.nav, { path: '/outreach', label: 'Call & Confirm', order: 30 });
  assert.ok(outreachModule.apiRouter);
  await assert.rejects(() => outreachModule.run!('drawbridge_nope', {}, {}));
  ok('module: 2 agent tools, "Call & Confirm" nav item, plan/settings API');

  console.log(`\n${passed} checks passed`);
}

main()
  .catch((e) => {
    console.error('FAIL', e?.stack || e?.message || e);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
