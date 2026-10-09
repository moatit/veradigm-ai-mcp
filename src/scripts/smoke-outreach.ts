/**
 * Offline test for the Drawbridge outreach module (no network, no credentials).
 * Fake Veradigm® PM service + mocked axios. Checks generator parsing, failures as errors,
 * approval, dry run, allowlist, quiet hours, attempt limit, outcome recording and the staff
 * screen (masked phones, escaping).
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

import assert from 'assert';
import type { AddressInfo } from 'net';

type Fake = (action: string, params: any, patientId: string) => any;
const OUTBOUND_ENV = ['RETELL_API_KEY', 'RETELL_OUTBOUND_AGENT_ID', 'RETELL_FROM_NUMBER', 'OUTBOUND_ALLOWLIST', 'OUTBOUND_ENABLED'];

async function main(): Promise<void> {
  const axiosMod = require('axios');
  const axios = axiosMod.default || axiosMod;
  const gen = await import('../platform/modules/outreach/generators');
  const { outreachJobs } = await import('../platform/modules/outreach/store');
  const dialer = await import('../platform/modules/outreach/dialer');
  const { OutreachTools } = await import('../platform/modules/outreach/tools');
  const { outreachModule } = await import('../platform/modules/outreach');
  const util = await import('../platform/modules/outreach/util');
  const { toVoiceSummary } = await import('../utils/response-formatter');
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

  // Times in America/Boise (MDT, UTC-6 in October 2026). Thursday Oct 8.
  const AT_10AM = new Date('2026-10-08T16:00:00Z');
  const AT_0859 = new Date('2026-10-08T14:59:00Z');
  const AT_8PM = new Date('2026-10-09T02:00:00Z');

  // Patient lookups (GetPatient): wrapped, lower-case Unity shape.
  const patients: Record<string, any> = {
    '101': { cellphone: '(208) 555-0101', firstname: 'Jane' },
    '102': { homephone: '', workphone: 'n/a' },
    '103': { homephone: '208.555.0103', firstname: 'Bob' },
    '104': { phone: '1-208-555-0104' },
    '105': { mobilephone: '+1 208 555 0105', firstname: 'Ann' },
    '106': { homephone: '2085550106' },
  };
  const getPatient = (pid: string) => ({ success: true, data: [{ getpatientinfo: [patients[pid] || {}] }] });

  // ---- 0. Helpers ----
  assert.strictEqual(util.toE164('(208) 555-0101'), '+12085550101');
  assert.strictEqual(util.toE164('1-208-555-0104 x12'), '+12085550104');
  assert.strictEqual(util.toE164('555-0101'), '');
  assert.strictEqual(util.maskPhone('+12085550101'), '•••-•••-0101');
  assert.strictEqual(util.mdy(util.nextBusinessDay(AT_10AM)), '10/09/2026');
  assert.strictEqual(util.mdy(util.nextBusinessDay(new Date('2026-10-09T16:00:00Z'))), '10/12/2026');
  assert.strictEqual(util.spokenTime('14:30'), '2:30 PM');
  assert.strictEqual(util.spokenDate('10/13/2026'), 'Tuesday, October 13');
  ok('phone normalize/mask, next business day (Fri → Mon), spoken date/time');

  // ---- 1. Reminders: parse GetSchedule, skip cancelled, look up phones ----
  const schedule = svc((a, _p, pid) => {
    if (a === 'GetSchedule')
      return {
        success: true,
        data: [
          {
            getscheduleinfo: [
              { apptid: 'A1', patientid: '101', patientname: 'Doe, Jane', apptdate: '10/09/2026', appttime: '09:00', resourcename: 'Dr. Lee', status: 'Scheduled' },
              { apptid: 'A2', patientid: '103', patientname: 'Roe, Bob', apptdate: '10/09/2026', appttime: '10:00', resourcename: 'Dr. Lee', status: 'Cancelled' },
              { appointmentid: 'A3', patid: '102', firstname: 'Max', startdatetime: '10/09/2026 13:30', provider: 'Dr. Kim', apptstatus: 'Confirmed' },
              { apptid: 'A4', apptdate: '10/09/2026', appttime: '11:00', status: 'Scheduled' },
              { apptid: 'A5', patientid: '104', apptdate: '10/10/2026', appttime: '11:00', status: 'Scheduled' },
            ],
          },
        ],
      };
    if (a === 'GetPatient') return getPatient(pid);
    throw new Error(`unexpected ${a}`);
  });
  const rem = await gen.generateReminders(schedule, { now: AT_10AM, by: 'tester' });
  assert.deepStrictEqual(calls[0], { action: 'GetSchedule', params: { Parameter1: '10/09/2026', Parameter2: '10/09/2026' }, patientId: '' });
  assert.strictEqual(rem.rows, 5);
  assert.strictEqual(rem.unusable, 1, 'row without patient ID');
  assert.strictEqual(rem.proposed, 1);
  assert.deepStrictEqual(rem.skipped, { 'No usable phone number on file': 1 });
  const jane = rem.jobs.find((j) => j.patient_ref.id === '101')!;
  assert.strictEqual(jane.patient_first_name, 'Jane');
  assert.strictEqual(jane.phone, '+12085550101');
  assert.deepStrictEqual(jane.appointment, { id: 'A1', date: '10/09/2026', time: '09:00', provider: 'Dr. Lee' });
  assert.strictEqual(jane.status, 'proposed');
  const max = rem.jobs.find((j) => j.patient_ref.id === '102')!;
  assert.strictEqual(max.status, 'skipped');
  assert.strictEqual(max.patient_first_name, 'Max');
  assert.deepStrictEqual(max.appointment, { id: 'A3', date: '10/09/2026', time: '13:30', provider: 'Dr. Kim' });
  assert.ok(!rem.jobs.some((j) => j.patient_ref.id === '103'), 'cancelled appointment skipped');
  assert.ok(!rem.jobs.some((j) => j.patient_ref.id === '104'), 'other-date appointment skipped');
  ok('reminders: next business day, cancelled skipped, name/phone parsed, no-phone job skipped with reason');

  const again = await gen.generateReminders(schedule, { date: '2026-10-09', by: 'tester' });
  assert.strictEqual(again.proposed, 0);
  assert.strictEqual(again.duplicates, 2);
  ok('reminders: re-running the same date creates no duplicates');

  // File store: mode 0600 (POSIX only), valid JSON
  const st = fs.statSync(outreachJobs.filePath());
  if (process.platform !== 'win32') assert.strictEqual(st.mode & 0o777, 0o600);
  assert.strictEqual(JSON.parse(fs.readFileSync(outreachJobs.filePath(), 'utf8')).jobs.length, 2);
  ok('job store written to CALL_RECORDS_DIR as JSON');

  // ---- 2. No-shows ----
  calls.length = 0;
  const noShowSvc = svc((a, _p, pid) => {
    if (a === 'GetAppointmentsByChangeDTTM')
      return {
        success: true,
        data: [
          {
            getappointmentsbychangedttminfo: [
              { apptid: 'N1', patientid: '103', patientname: 'Bob Roe', apptdate: '10/07/2026', appttime: '08:00', status: 'No Show' },
              { apptid: 'N2', patientid: '105', apptdate: '10/06/2026', appttime: '15:00', status: 'Missed' },
              { apptid: 'N3', patientid: '106', apptdate: '10/06/2026', appttime: '15:00', status: 'Checked Out' },
              { apptid: 'N4', patientid: '106', apptdate: '10/05/2026', appttime: '15:00', status: 'NOSHOW' },
              { apptid: 'N5', patientid: '106', apptdate: '10/20/2026', appttime: '15:00', status: 'No-Show' },
            ],
          },
        ],
      };
    if (a === 'GetPatient') return getPatient(pid);
    throw new Error(`unexpected ${a}`);
  });
  const ns = await gen.generateNoShows(noShowSvc, { days: 5, now: AT_10AM });
  assert.deepStrictEqual(calls[0].params, { Parameter1: '10/03/2026 00:00:00', Parameter2: '10/08/2026 23:59:59' });
  assert.strictEqual(ns.proposed, 3);
  assert.deepStrictEqual(ns.jobs.map((j) => j.appointment!.id).sort(), ['N1', 'N2', 'N4']);
  assert.strictEqual(ns.jobs.find((j) => j.appointment!.id === 'N1')!.patient_first_name, 'Bob');
  ok('no-shows: "No Show"/"Missed"/"NOSHOW" matched, other statuses and future dates ignored');

  // ---- 3. Recalls ----
  calls.length = 0;
  const recallSvc = svc((a, _p, pid) => {
    if (a === 'GetRecalls')
      return {
        success: true,
        data: [
          {
            getrecallsinfo: [
              { patientid: '105', recalltype: 'Annual follow-up', duedate: '10/20/2026', status: 'Open' },
              { patientid: '106', recalltype: 'Labs', duedate: '10/25/2026 00:00:00', status: '' },
              { patientid: '101', recalltype: 'Labs', duedate: '12/25/2026', status: 'Open' },
              { patientid: '103', recalltype: 'Labs', duedate: '10/21/2026', status: 'Completed' },
            ],
          },
        ],
      };
    if (a === 'GetPatient') return getPatient(pid);
    throw new Error(`unexpected ${a}`);
  });
  const rc = await gen.generateRecalls(recallSvc, { from: '2026-10-08', to: '2026-11-07' });
  assert.deepStrictEqual(calls[0].params, { Parameter1: '10/08/2026', Parameter2: '11/07/2026' });
  assert.strictEqual(rc.proposed, 2);
  assert.deepStrictEqual(rc.jobs.find((j) => j.patient_ref.id === '105')!.recall, { type: 'Annual follow-up', due: '10/20/2026' });
  assert.strictEqual(rc.jobs.find((j) => j.patient_ref.id === '106')!.recall!.due, '10/25/2026');
  ok('recalls: due window applied, completed recalls skipped');

  // ---- 4. Failures are errors, never "nothing to do" ----
  const before = outreachJobs.list().length;
  await rejects(() => gen.generateReminders(svc(() => ({ success: false, error: 'Magic Error' })), { date: '10/14/2026' }), 'API_ERROR', 'GetSchedule failure → API_ERROR');
  await rejects(() => gen.generateNoShows(svc(() => ({ success: false, error: 'x' }))), 'API_ERROR', 'GetAppointmentsByChangeDTTM failure → API_ERROR');
  await rejects(() => gen.generateRecalls(svc(() => ({ success: false, error: 'x' }))), 'API_ERROR', 'GetRecalls failure → API_ERROR');
  await rejects(
    () =>
      gen.generateReminders(
        svc(() => {
          throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        }),
        { date: '10/14/2026' }
      ),
    'NETWORK_ERROR',
    'network failure → NETWORK_ERROR'
  );
  const phoneFails = svc((a) =>
    a === 'GetSchedule'
      ? { success: true, data: [{ getscheduleinfo: [{ apptid: 'Z1', patientid: '201', apptdate: '10/15/2026', appttime: '09:00', status: 'Scheduled' }] }] }
      : { success: false, error: 'token expired' }
  );
  await rejects(() => gen.generateReminders(phoneFails, { date: '10/15/2026' }), 'API_ERROR', 'GetPatient failure → whole run fails');
  await rejects(() => gen.generateReminders(schedule, { date: 'tomorrow' }), 'VALIDATION_ERROR', 'bad date → VALIDATION_ERROR');
  assert.strictEqual(outreachJobs.list().length, before, 'nothing saved on failure');
  ok('failed runs save nothing');

  // ---- 5. Approval required; dry run by default ----
  const run0 = await dialer.callApproved({ ids: [jane.id], by: 'tester', now: AT_10AM });
  assert.strictEqual(run0.results[0].result, 'refused');
  assert.strictEqual(run0.results[0].reason, 'Not approved by staff');
  assert.strictEqual((await dialer.callApproved({ by: 'tester', now: AT_10AM })).results.length, 0);
  assert.strictEqual(posts.length, 0);
  ok('proposed (unapproved) jobs are never dialed');

  const approve = (id: string) =>
    outreachJobs.update(id, 'tester', 'approved', (j) => {
      j.status = 'approved';
      j.approved_by = 'tester';
    });
  approve(jane.id);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: any[]) => {
    logs.push(a.join(' '));
  };
  let dry;
  try {
    dry = await dialer.callApproved({ by: 'tester', now: AT_10AM });
  } finally {
    console.log = origLog;
  }
  assert.strictEqual(dry.mode, 'dry_run');
  assert.strictEqual(dry.counts.would_call, 1);
  assert.strictEqual(posts.length, 0, 'dry run never calls Retell');
  assert.ok(logs.some((l) => /would call/.test(l)));
  assert.ok(!logs.some((l) => /555|0101|Jane/.test(l)), `dry-run log leaks PHI: ${logs.join(' | ')}`);
  let j = outreachJobs.get(jane.id)!;
  assert.strictEqual(j.status, 'approved');
  assert.strictEqual(j.attempts, 0);
  assert.strictEqual(j.last_result!.result, 'would_call');
  ok('dry run (no RETELL_API_KEY/agent): records "would call", no request, no number in logs');

  process.env.RETELL_API_KEY = 'test-key-not-real';
  process.env.RETELL_OUTBOUND_AGENT_ID = 'agent_test_outbound';
  ok(`dry run is off only with both RETELL_API_KEY and RETELL_OUTBOUND_AGENT_ID (${dialer.outboundConfig().dryRun === false})`);

  // ---- 6. Live mode gates ----
  let r = await dialer.callApproved({ by: 'tester', now: AT_10AM });
  assert.strictEqual(r.mode, 'live');
  assert.match(r.results[0].reason!, /turned off/);
  assert.strictEqual(posts.length, 0);
  ok('OUTBOUND_ENABLED unset → real calls refused');

  process.env.OUTBOUND_ENABLED = 'true';
  r = await dialer.callApproved({ by: 'tester', now: AT_10AM });
  assert.match(r.results[0].reason!, /RETELL_FROM_NUMBER/);
  process.env.RETELL_FROM_NUMBER = '+12085550000';
  ok('missing RETELL_FROM_NUMBER → refused');

  process.env.OUTBOUND_ALLOWLIST = '+12085559999, +12085558888';
  r = await dialer.callApproved({ by: 'tester', now: AT_10AM });
  assert.match(r.results[0].reason!, /allowlist/);
  assert.strictEqual(posts.length, 0);
  ok('number not on OUTBOUND_ALLOWLIST → refused');

  process.env.OUTBOUND_ALLOWLIST = '+12085559999,(208) 555-0101';
  for (const [at, label] of [
    [AT_8PM, '8 PM'],
    [AT_0859, '8:59 AM'],
  ] as Array<[Date, string]>) {
    r = await dialer.callApproved({ by: 'tester', now: at });
    assert.match(r.results[0].reason!, /Outside calling hours/, label);
  }
  assert.strictEqual(posts.length, 0);
  assert.strictEqual(outreachJobs.get(jane.id)!.status, 'approved');
  ok('quiet hours: 8:59 AM and 8 PM Boise refused');

  // ---- 7. Live call: exact request, only allowed variables ----
  r = await dialer.callApproved({ by: 'tester', now: AT_10AM });
  assert.strictEqual(r.counts.placed, 1);
  assert.strictEqual(posts.length, 1);
  const req = posts[0];
  assert.strictEqual(req.url, 'https://api.retellai.com/v2/create-phone-call');
  assert.strictEqual(req.config.headers.Authorization, 'Bearer test-key-not-real');
  assert.deepStrictEqual(Object.keys(req.body).sort(), ['from_number', 'metadata', 'override_agent_id', 'retell_llm_dynamic_variables', 'to_number']);
  assert.strictEqual(req.body.from_number, '+12085550000');
  assert.strictEqual(req.body.to_number, '+12085550101');
  assert.strictEqual(req.body.override_agent_id, 'agent_test_outbound');
  assert.deepStrictEqual(req.body.metadata, { drawbridge_job_id: jane.id });
  assert.deepStrictEqual(req.body.retell_llm_dynamic_variables, {
    patient_first_name: 'Jane',
    appointment_date: 'Friday, October 9',
    appointment_time: '9:00 AM',
    provider_name: 'Dr. Lee',
    outreach_type: 'reminder',
    clinic_name: 'Idaho Kidney Institute',
  });
  j = outreachJobs.get(jane.id)!;
  assert.strictEqual(j.status, 'calling');
  assert.strictEqual(j.attempts, 1);
  assert.strictEqual(j.retell_call_id, 'call_1');
  ok('live call: create-phone-call body has only the allowed fields and dynamic variables');

  r = await dialer.callApproved({ by: 'tester', now: AT_10AM });
  assert.strictEqual(r.results.length, 0, 'job in "calling" is not dialed again');
  ok('a job being called is not dialed twice');

  // ---- 8. Agent tools: context gating and outcome recording ----
  const tools = new OutreachTools();
  const ctx = { callId: 'call_1' };
  const c0 = tools.context({}, ctx);
  assert.strictEqual(c0.success, true);
  assert.strictEqual(c0.jobId, jane.id);
  assert.ok(!/October|Dr\. Lee|9:00/.test(c0.message), 'no appointment details before verification');
  assert.strictEqual(c0.appointmentId, undefined);
  assert.match(c0.message, /Ask for Jane by first name only/);
  const cBad = tools.context({ verifiedPatientId: '999' }, ctx);
  assert.strictEqual(cBad.success, false);
  assert.ok(!/October|Dr\. Lee/.test(cBad.message));
  const cOk = tools.context({ verifiedPatientId: '101' }, ctx);
  assert.match(cOk.message, /Friday, October 9 at 9:00 AM with Dr\. Lee/);
  assert.strictEqual(cOk.appointmentId, 'A1');
  assert.match(toVoiceSummary('drawbridge_outreach_context', cOk), /Appointment ID: A1/);
  const other = tools.context({ jobId: jane.id }, { callId: 'call_other' });
  assert.strictEqual(other.success, false, 'job is bound to its own call');
  assert.strictEqual(tools.context({}, { callId: 'unknown' }).success, false);
  ok('outreach_context: resolves by call ID, no details until name + DOB match the job\'s patient');

  const bad = tools.result({ outcome: 'great' }, ctx);
  assert.strictEqual(bad.success, false);
  const res1 = tools.result({ outcome: 'no_answer' }, ctx);
  assert.strictEqual(res1.success, true);
  assert.strictEqual(typeof res1.message, 'string');
  j = outreachJobs.get(jane.id)!;
  assert.strictEqual(j.status, 'failed');
  assert.strictEqual(j.outcome, 'no_answer');
  ok('outreach_result: no_answer → failed (retryable)');

  // ---- 9. Retry and the 2-attempt limit ----
  approve(jane.id);
  postImpl = async () => {
    throw Object.assign(new Error('Request failed'), { response: { status: 500, data: { to_number: '+12085550101' } } });
  };
  r = await dialer.callApproved({ by: 'tester', now: AT_10AM });
  assert.strictEqual(r.counts.error, 1);
  assert.match(r.results[0].reason!, /HTTP 500/);
  j = outreachJobs.get(jane.id)!;
  assert.strictEqual(j.status, 'failed');
  assert.strictEqual(j.attempts, 2);
  approve(jane.id); // even if forced back to approved...
  r = await dialer.callApproved({ by: 'tester', now: AT_10AM });
  assert.match(r.results[0].reason!, /Already tried 2 times/);
  assert.strictEqual(posts.length, 2);
  ok('Retell error → failed; max 2 attempts enforced');

  // ---- 10. Outcome on a job that is not calling; opt-out ----
  const notCalling = tools.result({ jobId: ns.jobs[0].id, outcome: 'confirmed' }, {});
  assert.strictEqual(notCalling.success, false);
  ok('outreach_result refuses jobs that are not being called');

  postImpl = async () => ({ data: { call_id: 'call_bob' } });
  const bob = ns.jobs.find((x) => x.patient_ref.id === '103')!;
  approve(bob.id);
  process.env.OUTBOUND_ALLOWLIST = '';
  r = await dialer.callApproved({ ids: [bob.id], by: 'tester', now: AT_10AM });
  assert.strictEqual(r.counts.placed, 1);
  const oo = tools.result({ outcome: 'opted_out', notes: 'Asked   not to be called' }, { callId: 'call_bob' });
  assert.match(oo.message, /will not get these calls again/);
  j = outreachJobs.get(bob.id)!;
  assert.strictEqual(j.status, 'completed');
  assert.strictEqual(j.notes, 'Asked not to be called');
  assert.ok(outreachJobs.isOptedOut('103'));
  const later = await gen.generateRecalls(
    svc((a, _p, pid) =>
      a === 'GetRecalls'
        ? { success: true, data: [{ getrecallsinfo: [{ patientid: '103', recalltype: 'Labs', duedate: '10/22/2026' }] }] }
        : getPatient(pid)
    ),
    { from: '10/08/2026', to: '11/07/2026' }
  );
  assert.deepStrictEqual(later.skipped, { 'Patient asked not to be called': 1 });
  ok('opted_out → completed, patient excluded from future outreach');

  // ---- 11. Module wiring ----
  assert.deepStrictEqual(outreachModule.getTools!().map((t) => t.name), ['drawbridge_outreach_context', 'drawbridge_outreach_result']);
  assert.strictEqual(outreachModule.nav!.path, '/outreach');
  assert.strictEqual(outreachModule.nav!.order, 30);
  await assert.rejects(() => outreachModule.run!('drawbridge_nope', {}, {}));
  ok('module registers 2 tools and the Outreach nav item');

  // ---- 12. Staff screen: masked phones, escaping, approve/skip, dry-run label ----
  for (const k of OUTBOUND_ENV) delete process.env[k];
  const express = (await import('express')).default;
  const xss = outreachJobs.addMany(
    [
      {
        type: 'reminder',
        patient_ref: { system: 'veradigm_pm', id: '301' },
        patient_first_name: '<script>alert(1)</script>',
        phone: '+12085550301',
        appointment: { id: 'X1', date: '10/16/2026', time: '09:00', provider: 'Dr. "Q" & Co' },
        dedupe_key: 'test|301',
      },
    ],
    'tester'
  )[0];
  const app = express();
  app.use((rq: any, _rs, next) => {
    rq.drawbridgeUser = 'tester';
    next();
  });
  app.use('/app/outreach', express.urlencoded({ extended: false }), outreachModule.appRouter!({ unity: schedule, runTool: async () => ({}) } as any));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/app/outreach`;
  try {
    let html = await (await fetch(`${base}?show=all`)).text();
    assert.ok(html.includes('DRY RUN'));
    assert.ok(!html.includes('<script>alert(1)</script>'), 'first name is escaped');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('Dr. &quot;Q&quot; &amp; Co'));
    assert.ok(!/2085550301|555-0301|555-0101/.test(html), 'full phone numbers never rendered');
    assert.ok(html.includes('•••-•••-0301'));
    ok('screen: dry-run banner, values escaped, phones masked to last 4');

    const post = (p: string, body: string) =>
      fetch(`${base}${p}`, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    let resp = await post('/jobs', `action=approve&ids=${xss.id}&ids=${jane.id}`);
    assert.strictEqual(resp.status, 302);
    html = await (await fetch(new URL(resp.headers.get('location')!, base))).text();
    assert.ok(html.includes('Approved 1 job(s). 1 could not be changed'), 'job at max attempts cannot be re-approved');
    assert.strictEqual(outreachJobs.get(xss.id)!.status, 'approved');
    assert.strictEqual(outreachJobs.get(xss.id)!.approved_by, 'tester');

    resp = await post('/call', '');
    html = await (await fetch(new URL(resp.headers.get('location')!, base))).text();
    // Uses the real clock: "would be called" inside 9–7 Boise, "Outside calling hours" otherwise.
    assert.ok(/DRY RUN: no calls placed\. \d+ would be called, \d+ refused/.test(html), 'dry-run result shown');
    assert.ok(dialer.withinCallingHours() ? /1 would be called/.test(html) : /Outside calling hours/.test(html), 'dry-run counts match the clock');
    assert.strictEqual(posts.length, 3, 'no new Retell request in dry run');

    resp = await post('/jobs', `action=skip&ids=${xss.id}`);
    assert.strictEqual(outreachJobs.get(xss.id)!.status, 'skipped');

    resp = await post('/generate', 'type=reminder&date=2026-10-14');
    html = await (await fetch(new URL(resp.headers.get('location')!, base))).text();
    assert.ok(/Veradigm® PM returned 0 row\(s\)/.test(html) || /returned \d+ row/.test(html));
    const failingApp = express();
    failingApp.use('/o', express.urlencoded({ extended: false }), outreachModule.appRouter!({ unity: svc(() => ({ success: false, error: 'x' })), runTool: async () => ({}) } as any));
    const s2 = failingApp.listen(0, '127.0.0.1');
    await new Promise((resolve) => s2.once('listening', resolve));
    try {
      const b2 = `http://127.0.0.1:${(s2.address() as AddressInfo).port}/o`;
      const r2 = await fetch(`${b2}/generate`, { method: 'POST', body: 'type=recall', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
      const h2 = await (await fetch(new URL(r2.headers.get('location')!.replace('/app/outreach', '/o'), b2))).text();
      assert.ok(h2.includes('Could not read from Veradigm® PM (API_ERROR). Nothing was added'), 'generate failure shown as error');
    } finally {
      s2.close();
    }
    ok('screen: approve/skip, "Call approved now" dry run, generate error shown (not empty)');
  } finally {
    server.close();
  }

  // Client-facing text never says MCP/FHIR/Unity
  const html = await (async () => {
    const a2 = express();
    a2.use((rq: any, _rs, next) => ((rq.drawbridgeUser = 'tester'), next()));
    a2.use('/app/outreach', outreachModule.appRouter!({ unity: schedule, runTool: async () => ({}) } as any));
    const s3 = a2.listen(0, '127.0.0.1');
    await new Promise((resolve) => s3.once('listening', resolve));
    try {
      return await (await fetch(`http://127.0.0.1:${(s3.address() as AddressInfo).port}/app/outreach?show=all`)).text();
    } finally {
      s3.close();
    }
  })();
  assert.ok(!/\b(MCP|FHIR|Unity)\b/.test(html.replace(/<style>[\s\S]*?<\/style>/, '')));
  ok('screen text never says MCP/FHIR/Unity');

  console.log(`\n${passed} checks passed`);
}

main()
  .catch((e) => {
    console.error('FAIL', e?.message || e);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
