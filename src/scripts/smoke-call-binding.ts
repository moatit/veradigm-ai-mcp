/**
 * Offline checks for the per-call verification binding (src/platform/call-binding.ts): identity before information,
 * enforced by the server on the phone-agent tool endpoints. Fakes only; no Veradigm, no Retell. Part 2 starts the
 * Unity and FHIR HTTP servers on 127.0.0.1 with every upstream at 127.0.0.1:1 (refused), as smoke:endpoints does.
 *
 *  1. No call ID: patient tools and searches refused (CALL_ID_MISSING); lookups without patient data still run.
 *  2. An unverified patientId is refused (NOT_VERIFIED, audit line + security event with call ID and tool, no names).
 *  3. Full name + DOB with one match verifies; that patient's PM and chart IDs work (PM ID on a chart tool is mapped
 *     to the same patient's chart ID); partial searches and several matches never return identifiers.
 *  4. A second patient needs its own verification; a third is refused (VERIFIED_LIMIT, default 2, setting).
 *  5. Search cap per call (SEARCH_LIMIT, POSSIBLE_ENUMERATION; default 5, setting).
 *  6. Appointment IDs: only with a verified patient, and the real tool refuses a visit that is not on that patient's
 *     schedule (GetScheduleByPatientID); patientId filled in when one patient is verified, required with two.
 *  7. New-patient registration binds; an existing patientId must be verified. Outreach verifiedPatientId, MRN lookup,
 *     after-hours call record (saved as unverified), unknown tools fail closed, FHIR verify/search/deny, TTL.
 *  8. Staff side unaffected: modules and staff screens run tools without the gate.
 *  9. HTTP: Unity /api/retell and MCP, FHIR /api/retell and MCP refuse without a call ID / verification.
 *
 *   npm run smoke:call-binding
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'drawbridge-callbind-'));
process.env.CALL_RECORDS_DIR = TMP;
process.env.AUDIT_DIR = TMP;
for (const k of ['UNITY_APP_NAME', 'UNITY_SVC_USERNAME', 'UNITY_SVC_PASSWORD', 'UNITY_EHR_USERNAME', 'UNITY_EHR_PASSWORD']) {
  process.env[k] = process.env[k] || 'offline-smoke';
}
for (const k of ['DRAWBRIDGE_CALL_MAX_VERIFIED_PATIENTS', 'DRAWBRIDGE_CALL_MAX_SEARCHES', 'DRAWBRIDGE_CALL_BINDING_TTL_MIN', 'DRAWBRIDGE_AGENT_STAFF_TOOLS']) delete process.env[k];

import assert from 'assert';
import { ChildProcess, spawn } from 'child_process';
import * as net from 'net';

/** Fake practice (no real people). */
const ROSTER = [
  { firstName: 'Ada', lastName: 'Quillfeather', dateOfBirth: '12/10/1985', patientId: '101', chartPatientId: '9001' },
  { firstName: 'Bea', lastName: 'Quillfeather', dateOfBirth: '03/04/2012', patientId: '102', chartPatientId: '9002' },
  { firstName: 'Cy', lastName: 'Quillfeather', dateOfBirth: '07/08/1950', patientId: '103', chartPatientId: '9003' },
  { firstName: 'Dee', lastName: 'Twinmoor', dateOfBirth: '01/01/1990', patientId: '104', chartPatientId: '9004' },
  { firstName: 'Dee', lastName: 'Twinmoor', dateOfBirth: '01/01/1990', patientId: '105', chartPatientId: '9005' },
];
const NAMES = ['Ada', 'Quillfeather', 'Twinmoor', '12/10/1985'];

async function main(): Promise<void> {
  const cb = await import('../platform/call-binding');
  const { forAgent } = await import('../utils/minimum-necessary');
  const { toVoiceSummary } = await import('../utils/response-formatter');
  const audit = await import('../platform/audit');
  const { UnityAppointmentTools } = await import('../unity/tools/appointment.tools');
  const { UnityActions, CERTIFIED_ACTIONS } = await import('../unity/config/unity-endpoints');
  const { UnityPatientTools } = await import('../unity/tools/patient.tools');
  const { previsitCheck } = await import('../platform/modules/huddle/previsit');

  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`PASS ${label}`);
  };
  const log = console.log;
  const warn = console.warn;
  const err = console.error;
  const mute = () => {
    console.warn = () => undefined;
    console.error = () => undefined;
    console.log = (...a: unknown[]) => {
      if (!/^\[SECURITY\]/.test(String(a[0]))) log(...a);
    };
  };
  const unmute = () => {
    console.log = log;
    console.warn = warn;
    console.error = err;
  };
  mute();
  const lines = async () => {
    await audit.flushAudit();
    const dir = path.join(TMP, 'audit');
    if (!fs.existsSync(dir)) return [] as any[];
    return fs
      .readdirSync(dir)
      .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n'))
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  };

  // Fake tool executor: what ran, with which arguments.
  const ran: Array<{ name: string; args: any }> = [];
  async function fakeRun(name: string, args: any): Promise<any> {
    ran.push({ name, args });
    if (name === 'unity_search_patients') {
      const eq = (a: unknown, b: string) => !a || String(a).trim().toLowerCase() === b.toLowerCase();
      const hits = ROSTER.filter((p) => (args.lastName || args.firstName) && eq(args.lastName, p.lastName) && eq(args.firstName, p.firstName) && eq(args.dateOfBirth, p.dateOfBirth));
      return {
        patients: hits.map((p) => ({ ...p, id: p.patientId, address: { line1: '1 Elm St' }, ssnLast4: '1234', homePhone: '555-0100' })),
        total: hits.length,
        message: `Found ${hits.length} patient(s)`,
      };
    }
    if (name === 'unity_get_patient_by_mrn') return { success: true, patient: { id: args.mrn === 'M-1' ? '9001' : '9099', firstName: 'X', lastName: 'Y' }, message: 'ok' };
    if (name === 'verify_patient_identity') {
      const hit = ROSTER.find((p) => p.firstName === args.firstName && p.lastName === args.lastName && args.birthDate === '1985-12-10');
      return hit ? { verified: true, patient: { id: 'fhir-ada', firstName: hit.firstName, lastName: hit.lastName } } : { verified: false, message: 'No patient matches.' };
    }
    if (name === 'search_patient') return { patients: [{ id: 'fhir-ada' }, { id: 'fhir-other' }], total: 2, hasMore: false };
    return { success: true, message: `ran ${name}`, appointments: [] };
  }
  const store = new cb.CallBindings();
  const agent = (name: string, args: any, callId?: string, server: 'unity' | 'fhir' = 'unity') =>
    cb.withCallBinding(name, args, { server, callId, channel: 'retell' }, async (a) => forAgent(name, a, await fakeRun(name, a)), store);
  const lastRun = () => ran[ran.length - 1];
  const code = (r: any) => (r && r.success === false ? r.error_code : 'OK');
  const search = (callId: string | undefined, p: { firstName?: string; lastName?: string; dateOfBirth?: string }) => agent('unity_search_patients', p, callId);
  const ADA = { firstName: 'Ada', lastName: 'Quillfeather', dateOfBirth: '12/10/1985' };
  const BEA = { firstName: 'Bea', lastName: 'Quillfeather', dateOfBirth: '03/04/2012' };
  const CY = { firstName: 'Cy', lastName: 'Quillfeather', dateOfBirth: '07/08/1950' };

  // ── 1. No call ID ───────────────────────────────────────────────────────────
  let n = ran.length;
  assert.strictEqual(code(await agent('unity_get_patient_appointments', { patientId: '101' }, undefined)), 'CALL_ID_MISSING');
  assert.strictEqual(code(await search(undefined, ADA)), 'CALL_ID_MISSING');
  assert.strictEqual(code(await agent('unity_get_patient_medications', { patientId: '9001' }, '  ')), 'CALL_ID_MISSING', 'blank call ID');
  assert.strictEqual(code(await agent('unity_get_patient_medications', { patientId: '9001' }, 'bad call id with spaces')), 'CALL_ID_MISSING', 'malformed call ID');
  assert.strictEqual(ran.length, n, 'nothing ran without a call ID');
  assert.strictEqual(code(await agent('unity_get_appointment_types', {}, undefined)), 'OK');
  assert.strictEqual(code(await agent('unity_get_open_slots', { startDate: '10/20/2026', endDate: '10/21/2026' }, undefined)), 'OK', 'open times without a patient');
  assert.strictEqual(code(await agent('unity_get_open_slots', { startDate: '10/20/2026', endDate: '10/21/2026', patientId: '101' }, undefined)), 'CALL_ID_MISSING');
  assert.ok(/TOOL_ERROR \(CALL_ID_MISSING, retryable=no\)/.test(toVoiceSummary('x', await agent('unity_get_account_balance', { patientId: '101' }, undefined))));
  let l = await lines();
  assert.ok(l.some((x) => x.kind === 'security' && x.tool === 'agent_no_call_id' && x.object === 'unity_get_patient_appointments' && x.patient_id === '101'), 'no-call-ID security event');
  ok('no call ID: patient tools and identity searches refused (CALL_ID_MISSING, security event), lookups and open times without a patient still run');

  // ── 2. Unverified patientId ─────────────────────────────────────────────────
  n = ran.length;
  const refused = await agent('unity_get_patient_appointments', { patientId: '101' }, 'call_A');
  assert.strictEqual(code(refused), 'NOT_VERIFIED');
  assert.ok(/NOT_VERIFIED: verify the caller \(full name \+ date of birth\)/.test(refused.message));
  const voice = toVoiceSummary('unity_get_patient_appointments', refused);
  assert.ok(/^TOOL_ERROR \(NOT_VERIFIED, retryable=no\)\. Nothing was looked up/.test(voice) && /Verify the caller first/.test(voice) && !/having trouble/.test(voice), voice);
  for (const [tool, args] of [
    ['unity_get_patient_medications', { patientId: '9001' }],
    ['unity_get_account_balance', { patientId: '101' }],
    ['unity_get_insurance_policy', { patientId: '101' }],
    ['unity_get_recent_results', { patientId: '9001' }],
    ['unity_get_patient', { patientId: '9001' }],
    ['unity_save_appointment', { patientId: '101', appointmentDate: '10/20/2026', appointmentTime: '09:00', duration: 15 }],
    ['unity_create_staff_task', { patientId: '9001', reason: 'callback', message: 'call me' }],
    ['unity_get_patient_recalls', { patientId: '101' }],
    ['drawbridge_previsit_check', { patientId: '101' }],
    ['unity_get_patient_appointments', {}],
  ] as Array<[string, any]>) {
    assert.strictEqual(code(await agent(tool, args, 'call_A')), 'NOT_VERIFIED', tool);
  }
  assert.strictEqual(ran.length, n, 'no patient tool ran before verification');
  l = await lines();
  const ev = l.find((x) => x.kind === 'security' && x.tool === 'agent_not_verified' && x.call_id === 'call_A' && x.object === 'unity_get_patient_appointments');
  assert.ok(ev && ev.patient_id === '101' && ev.success === false && ev.error_code === 'NOT_VERIFIED', JSON.stringify(ev));
  assert.ok(l.some((x) => x.kind === 'tool' && x.tool === 'unity_get_patient_appointments' && x.call_id === 'call_A' && x.error_code === 'NOT_VERIFIED' && x.channel === 'retell'), 'tool audit line');
  ok('unverified patientId refused on every patient-scoped tool (NOT_VERIFIED with a "verify first" text, never "having trouble"); audit line + security event with call ID, tool and the requested ID');

  // ── 3. Verification ─────────────────────────────────────────────────────────
  const partial = await search('call_A', { lastName: 'Quillfeather', dateOfBirth: '12/10/1985' });
  assert.ok(partial.withheld && !/101|9001|Ada/.test(JSON.stringify(partial)), 'last name + DOB: no identifiers');
  const nameOnly = await search('call_A', { firstName: 'Ada', lastName: 'Quillfeather' });
  assert.ok(nameOnly.withheld && !/101|9001/.test(JSON.stringify(nameOnly)), 'name only: no identifiers');
  const twins = await search('call_A', { firstName: 'Dee', lastName: 'Twinmoor', dateOfBirth: '01/01/1990' });
  assert.ok(twins.withheld && !/104|105|9004/.test(JSON.stringify(twins)) && /more than one record/.test(twins.message), 'several matches: no identifiers');
  assert.strictEqual(code(await agent('unity_get_patient_appointments', { patientId: '104' }, 'call_A')), 'NOT_VERIFIED', 'several matches bind nobody');
  assert.strictEqual(store.verified('call_A').length, 0, 'partial searches bind nobody');
  const found = await search('call_A', ADA);
  assert.strictEqual(found.patients.length, 1);
  assert.deepStrictEqual(Object.keys(found.patients[0]).sort(), ['chartPatientId', 'dateOfBirth', 'firstName', 'id', 'lastName', 'patientId'], 'minimum necessary kept');
  assert.deepStrictEqual(store.verified('call_A').map((p) => [p.pm, p.chart]), [['101', '9001']]);
  assert.strictEqual(code(await agent('unity_get_patient_appointments', { patientId: '101' }, 'call_A')), 'OK');
  assert.strictEqual(code(await agent('unity_get_patient_allergies', { patientId: '9001' }, 'call_A')), 'OK');
  assert.strictEqual(code(await agent('unity_get_patient_medications', { patientId: '101' }, 'call_A')), 'OK');
  assert.strictEqual(lastRun().args.patientId, '9001', 'PM ID on a chart tool mapped to the same patient\'s chart ID');
  assert.strictEqual(code(await agent('unity_get_account_balance', { patientId: '9001' }, 'call_A')), 'OK');
  assert.strictEqual(lastRun().args.patientId, '101', 'chart ID on a PM tool mapped to the same patient\'s PM ID');
  assert.strictEqual(code(await agent('unity_get_patient', { patientId: '101', target: 'PM' }, 'call_A')), 'OK');
  assert.strictEqual(code(await agent('unity_get_patient_appointments', { patientId: '102' }, 'call_A')), 'NOT_VERIFIED', 'other call members still refused');
  assert.strictEqual(code(await agent('unity_get_patient_appointments', { patientId: '101' }, 'call_OTHER')), 'NOT_VERIFIED', 'binding is per call');
  ok('full name + DOB with exactly one match verifies the caller for this call only; partial and multi-match searches return no identifiers and bind nobody; PM/chart IDs of the verified patient mapped, never another patient\'s');

  // ── 3b. Exact names with the real search (launch audit 2026-10-16) ─────────
  // Veradigm® PM prefix-matches the last name and the tool keeps hits on the first 2 letters of each name, so the
  // gate itself must require the record's exact first name, last name and DOB before it binds anybody.
  {
    const { UnityPatientTools } = await import('../unity/tools/patient.tools');
    const PREFIX_ROSTER = [
      { ID: '201', lastname: 'Smithers', firstname: 'John', dateofbirth: '01/02/1970' },
      { ID: '202', lastname: 'Beesly', firstname: 'Pamela', dateofbirth: '03/03/1980' },
      { ID: '203', lastname: 'Okonkwo-Vance', firstname: 'Ngozi', dateofbirth: '04/04/1975' },
      { ID: '204', lastname: 'Twinmoor', firstname: 'Dee', dateofbirth: '01/01/1990' },
      { ID: '205', lastname: 'Twinmoor', firstname: 'Dee', dateofbirth: '01/01/1990' },
    ];
    // Like Veradigm: "Last, First" text, prefix match on both parts; PM and EHR return the same people.
    const veradigmLike: any = {
      async searchPatients(c: any, target: string) {
        const last = String(c.lastName || '').trim().split(/[\s-]+/)[0].toLowerCase();
        const first = String(c.firstName || '').trim().toLowerCase();
        const rows = PREFIX_ROSTER.filter((p) => p.lastname.toLowerCase().startsWith(last) && p.firstname.toLowerCase().startsWith(first)).map((p) => ({
          ...p,
          ID: target === 'PM' ? p.ID : `9${p.ID}`,
        }));
        return { success: true, data: [{ searchpatientsinfo: rows }] };
      },
    };
    const realSearch = new UnityPatientTools(veradigmLike);
    const live = (args: any, callId: string) =>
      cb.withCallBinding('unity_search_patients', args, { server: 'unity', callId, channel: 'retell' }, async (a) => forAgent('unity_search_patients', a, await realSearch.searchPatients(a)), store);
    const ids = /\b(201|202|203|204|205|9201|9202|9203|9204|9205)\b/;

    const jo = await live({ firstName: 'Jo', lastName: 'Smithers', dateOfBirth: '01/02/1970' }, 'call_X1');
    assert.ok(!ids.test(JSON.stringify(jo)) && jo.total === 0 && !/John/.test(JSON.stringify(jo)), `2-letter first name: ${JSON.stringify(jo)}`);
    const sm = await live({ firstName: 'John', lastName: 'Sm', dateOfBirth: '01/02/1970' }, 'call_X1');
    assert.ok(!ids.test(JSON.stringify(sm)) && sm.total === 0 && !/Smithers/.test(JSON.stringify(sm)), `2-letter last name: ${JSON.stringify(sm)}`);
    assert.strictEqual(store.verified('call_X1').length, 0, 'prefixes bind nobody');
    assert.ok(/^NO MATCH/.test(toVoiceSummary('unity_search_patients', sm)));

    const pam = await live({ firstName: 'Pam', lastName: 'Beesly', dateOfBirth: '03/03/1980' }, 'call_X2');
    assert.ok(pam.confirm && !ids.test(JSON.stringify(pam)) && /Pamela Beesly \(P-A-M-E-L-A, B-E-E-S-L-Y\)/.test(pam.message), JSON.stringify(pam));
    assert.ok(/Matched on a spelling variant, NOT verified yet/.test(toVoiceSummary('unity_search_patients', pam)));
    assert.strictEqual(store.verified('call_X2').length, 0, 'nickname read back, not bound');
    assert.strictEqual(code(await agent('unity_get_patient_appointments', { patientId: '202' }, 'call_X2')), 'NOT_VERIFIED');
    const pamela = await live({ firstName: 'Pamela', lastName: 'Beesly', dateOfBirth: '3/3/1980' }, 'call_X2');
    assert.ok(pamela.patients?.[0]?.patientId === '202', JSON.stringify(pamela));
    assert.deepStrictEqual(store.verified('call_X2').map((p) => [p.pm, p.chart]), [['202', '9202']], 'the exact spelling binds');

    const beasley = await live({ firstName: 'Pamela', lastName: 'Beasley', dateOfBirth: '03/03/1980' }, 'call_X3');
    assert.ok(beasley.confirm && !ids.test(JSON.stringify(beasley)), `Soundex variant: ${JSON.stringify(beasley)}`);
    assert.strictEqual(store.verified('call_X3').length, 0, 'spelling variant not bound before the yes');

    const ok1 = await live({ firstName: 'Ngozi', lastName: 'Okonkwo', dateOfBirth: '04/04/1975' }, 'call_X4');
    assert.ok(ok1.confirm && /OKONKWO-VANCE|O-K-O-N-K-W-O-V-A-N-C-E/.test(ok1.message), JSON.stringify(ok1));
    assert.strictEqual(store.verified('call_X4').length, 0);
    await live({ firstName: 'ngozi', lastName: 'Okonkwo Vance', dateOfBirth: '04/04/1975' }, 'call_X4');
    assert.deepStrictEqual(store.verified('call_X4').map((p) => p.pm), ['203'], 'double last name said in full binds');

    const twinsCut = await live({ firstName: 'Dee', lastName: 'Twinmoor', dateOfBirth: '01/01/1990', limit: 1 }, 'call_X5');
    assert.ok(twinsCut.withheld && !ids.test(JSON.stringify(twinsCut)), `limit:1 must not turn two matches into one: ${JSON.stringify(twinsCut)}`);
    assert.strictEqual(store.verified('call_X5').length, 0);
    const twinRows = await realSearch.searchPatients({ firstName: 'Dee', lastName: 'Twinmoor', dateOfBirth: '01/01/1990' });
    assert.ok(twinRows.total >= 2 && !twinRows.patients.some((p: any) => p.patientId && p.chartPatientId), `two patients with one name + DOB are never merged or cross-paired: ${JSON.stringify(twinRows.patients)}`);

    const exact = await live({ firstName: 'JOHN', lastName: ' smithers ', dateOfBirth: '1/2/1970' }, 'call_X6');
    assert.ok(exact.patients?.[0]?.patientId === '201', JSON.stringify(exact));
    assert.deepStrictEqual(store.verified('call_X6').map((p) => p.pm), ['201']);
    assert.strictEqual(cb.nameRelation('Mary', 'Mary Ann', 'first'), 'exact');
    assert.strictEqual(cb.nameRelation("O'Brien", 'OBrien', 'last'), 'exact');
    assert.strictEqual(cb.nameRelation('Ob', 'OBrien', 'last'), 'none');
    ok('exact names with the real search: 2-letter prefixes find nobody (no name, no IDs); a nickname, a spelling variant or one part of a double last name is read back but binds nothing until a search with the exact spelling; limit cannot cut two matches to one; two patients with the same name + DOB are never merged into one; case, spaces and hyphens ignored');
  }

  // ── 4. Second patient, cap of 2 ────────────────────────────────────────────
  assert.strictEqual(code(await agent('unity_get_patient_appointments', { patientId: '102' }, 'call_A')), 'NOT_VERIFIED');
  await search('call_A', BEA);
  assert.strictEqual(code(await agent('unity_get_patient_appointments', { patientId: '102' }, 'call_A')), 'OK', 'family member after their own verification');
  assert.strictEqual(code(await agent('unity_get_patient_appointments', { patientId: '101' }, 'call_A')), 'OK', 'first patient still verified');
  await search('call_A2', ADA);
  await search('call_A2', BEA);
  await search('call_A2', ADA); // re-verifying the same person takes no new slot
  assert.strictEqual(store.verified('call_A2').length, 2);
  const third = await search('call_A2', CY);
  assert.strictEqual(code(third), 'VERIFIED_LIMIT');
  assert.ok(!/103|9003|Cy\b/.test(JSON.stringify(third)), 'no identifiers past the cap');
  assert.ok(/VERIFIED_LIMIT/.test(toVoiceSummary('unity_search_patients', third)));
  assert.strictEqual(code(await agent('unity_get_patient_appointments', { patientId: '103' }, 'call_A2')), 'NOT_VERIFIED');
  process.env.DRAWBRIDGE_CALL_MAX_VERIFIED_PATIENTS = '1';
  await search('call_ONE', ADA);
  assert.strictEqual(code(await search('call_ONE', ADA)), 'OK', 'same person again');
  assert.strictEqual(code(await search('call_ONE', BEA)), 'VERIFIED_LIMIT', 'setting honoured');
  delete process.env.DRAWBRIDGE_CALL_MAX_VERIFIED_PATIENTS;
  l = await lines();
  assert.ok(l.some((x) => x.kind === 'security' && x.tool === 'agent_verified_limit' && x.call_id === 'call_A2' && x.patient_id === '103'), 'verified-limit security event');
  ok('a second patient (family member) needs their own verification; a third is refused (VERIFIED_LIMIT, no identifiers, security event); DRAWBRIDGE_CALL_MAX_VERIFIED_PATIENTS honoured');

  // ── 5. Search cap ───────────────────────────────────────────────────────────
  n = ran.length;
  for (let i = 0; i < 5; i++) await search('call_B', { firstName: `Nobody${i}`, lastName: 'Quillfeather', dateOfBirth: '01/02/1960' });
  assert.strictEqual(ran.length, n + 5);
  const capped = await search('call_B', ADA);
  assert.strictEqual(code(capped), 'SEARCH_LIMIT');
  assert.strictEqual(ran.length, n + 5, 'the sixth search never ran');
  assert.ok(/I'm not able to look up any more records on this call/.test(toVoiceSummary('unity_search_patients', capped)));
  assert.strictEqual(code(await agent('verify_patient_identity', { firstName: 'Ada', lastName: 'Quillfeather', birthDate: '1985-12-10' }, 'call_B', 'fhir')), 'SEARCH_LIMIT', 'all identity searches count');
  process.env.DRAWBRIDGE_CALL_MAX_SEARCHES = '2';
  await search('call_B2', ADA);
  await search('call_B2', ADA);
  assert.strictEqual(code(await search('call_B2', ADA)), 'SEARCH_LIMIT', 'setting honoured');
  delete process.env.DRAWBRIDGE_CALL_MAX_SEARCHES;
  l = await lines();
  const se = l.find((x) => x.kind === 'security' && x.tool === 'agent_search_limit' && x.call_id === 'call_B');
  assert.ok(se && se.error_code === 'POSSIBLE_ENUMERATION' && se.object === 'unity_search_patients', JSON.stringify(se));
  ok('identity searches capped per call (5 by default, DRAWBRIDGE_CALL_MAX_SEARCHES): the next one never runs, polite refusal text, security event POSSIBLE_ENUMERATION');

  // ── 6. Appointment IDs (real appointment tool, fake Veradigm) ──────────────
  const veradigm: Array<{ action: string; patientId: string }> = [];
  const schedules: Record<string, any[]> = {
    '101': [{ Appointment_ID: 'A-101', Patient_ID: '101', Status: 'S', Appointment_Date: '10/20/2026', Appointment_Time: '0900' }],
    '777': [{ Appointment_ID: 'A-777', Patient_ID: '777', Status: 'S', Appointment_Date: '10/21/2026', Appointment_Time: '1000' }],
  };
  const fakeUnity: any = {
    async executeAction(action: string, _params: any, patientId: string) {
      veradigm.push({ action, patientId });
      if (action === UnityActions.Scheduling.GET_APPOINTMENTS) return { success: true, data: schedules[patientId] || [] };
      return { success: true, data: [] };
    },
  };
  const appts = new UnityAppointmentTools(fakeUnity);
  const realRun = async (name: string, args: any) => {
    try {
      if (name === 'unity_cancel_appointment') return await appts.cancelAppointment(args);
      if (name === 'unity_confirm_appointment') return await appts.confirmAppointment(args);
      if (name === 'unity_get_appointment_details') return await appts.getAppointmentDetails(args);
    } catch (e: any) {
      return { success: false, error_code: e?.code || 'ERROR', retryable: false, tool: name, message: e?.message };
    }
    throw new Error(name);
  };
  const apptAgent = (name: string, args: any, callId: string) => cb.withCallBinding(name, args, { server: 'unity', callId, channel: 'retell' }, (a) => realRun(name, a), store);
  await search('call_C', ADA);
  // Another patient's appointment with that patient's (unverified) ID: refused before Veradigm is asked.
  assert.strictEqual(code(await apptAgent('unity_cancel_appointment', { appointmentId: 'A-777', patientId: '777' }, 'call_C')), 'NOT_VERIFIED');
  assert.strictEqual(code(await apptAgent('unity_confirm_appointment', { appointmentId: 'A-777', patientId: '777' }, 'call_C')), 'NOT_VERIFIED');
  assert.strictEqual(code(await apptAgent('unity_get_appointment_details', { appointmentId: 'A-777', patientId: '777' }, 'call_C')), 'NOT_VERIFIED');
  assert.strictEqual(veradigm.length, 0, 'no Veradigm call for an unverified patient');
  // Another patient's appointment with the verified caller's ID: the tool's own ownership check refuses it.
  const notOwned = await apptAgent('unity_cancel_appointment', { appointmentId: 'A-777', patientId: '101' }, 'call_C');
  assert.strictEqual(code(notOwned), 'NOT_FOUND', JSON.stringify(notOwned));
  assert.ok(!veradigm.some((c) => c.action === UnityActions.Scheduling.CANCEL_APPOINTMENT || c.action === UnityActions.Scheduling.SET_APPOINTMENT_STATUS), 'no status change sent');
  assert.ok(veradigm.every((c) => c.patientId === '101'), 'only the verified patient\'s schedule was read');
  // appointmentId alone: the one verified patient is filled in, so GetAppointmentById (no owner check) is never used.
  const details = await apptAgent('unity_get_appointment_details', { appointmentId: 'A-777' }, 'call_C');
  assert.strictEqual(details.success, false);
  assert.ok(/not on this patient's schedule/.test(details.message));
  const own = await apptAgent('unity_get_appointment_details', { appointmentId: 'A-101' }, 'call_C');
  assert.ok(own.success && own.appointment?.id === 'A-101', JSON.stringify(own));
  assert.ok(!veradigm.some((c) => c.action === UnityActions.Scheduling.GET_APPOINTMENT_BY_ID), 'GetAppointmentById never used for the agent');
  // Two verified patients: the agent must say whose visit it is.
  await search('call_C', BEA);
  assert.strictEqual(code(await apptAgent('unity_get_appointment_details', { appointmentId: 'A-101' }, 'call_C')), 'PATIENT_ID_REQUIRED');
  assert.strictEqual(code(await apptAgent('unity_cancel_appointment', { appointmentId: 'A-101' }, 'call_D0')), 'NOT_VERIFIED', 'no verified patient');
  ok('appointment IDs: another patient\'s visit refused (unverified ID: before Veradigm; verified ID: GetScheduleByPatientID ownership check, no status change); appointmentId alone uses the one verified patient, two need patientId');

  // ── 7. SavePatient removed, outreach, MRN, call record, unknown tools, FHIR, TTL ──
  // SavePatient is not used in this release: the tools are not offered and the gate denies them even for a
  // verified patient, so nothing runs and nobody is bound.
  n = ran.length;
  assert.strictEqual(code(await agent('unity_save_patient', { firstName: 'New', lastName: 'Person', dateOfBirth: '05/05/1995' }, 'call_D')), 'NOT_VERIFIED', 'registration refused');
  assert.strictEqual(store.verified('call_D').length, 0, 'nobody bound');
  await search('call_D', ADA);
  assert.strictEqual(code(await agent('unity_save_patient', { patientId: '101', firstName: 'Ada', lastName: 'Q' }, 'call_D')), 'NOT_VERIFIED', 'update refused, even verified');
  assert.strictEqual(code(await agent('unity_update_demographics', { patientId: '101', cellPhone: '555-0101' }, 'call_D')), 'NOT_VERIFIED', 'demographics update refused, even verified');
  assert.ok(!ran.slice(n).some((r) => /save_patient|update_demographics/.test(r.name)), 'never ran');
  const patientToolNames = new UnityPatientTools({} as any).getTools().map((t) => t.name);
  assert.ok(!patientToolNames.includes('unity_save_patient') && !patientToolNames.includes('unity_update_demographics'), 'not in the tool list');
  assert.ok(!('savePatient' in UnityPatientTools.prototype) && !('updateDemographics' in UnityPatientTools.prototype), 'no code path left');
  assert.ok(!CERTIFIED_ACTIONS.has('SavePatient'), 'SavePatient is not a declared action');

  n = ran.length;
  assert.strictEqual(code(await agent('drawbridge_outreach_context', {}, 'call_E')), 'OK', 'outreach context before verification');
  assert.strictEqual(code(await agent('drawbridge_outreach_context', { verifiedPatientId: '101' }, 'call_E')), 'NOT_VERIFIED');
  await search('call_E', ADA);
  assert.strictEqual(code(await agent('drawbridge_outreach_context', { verifiedPatientId: '101' }, 'call_E')), 'OK', 'job patient verified by search');

  await search('call_F', ADA);
  assert.strictEqual(code(await agent('unity_get_patient_by_mrn', { mrn: 'M-1' }, 'call_F')), 'OK', 'MRN of the verified patient');
  const mrnOther = await agent('unity_get_patient_by_mrn', { mrn: 'M-2' }, 'call_F');
  assert.strictEqual(code(mrnOther), 'NOT_VERIFIED');
  assert.ok(!/9099/.test(JSON.stringify(mrnOther)), 'MRN lookup of someone else returns nothing');

  await agent('drawbridge_save_call_record', { verified: true, patientId: '9003', patientSystem: 'veradigm_ehr', patientName: 'Cy', dob: '07/08/1950', reason: 'call me back', urgency: 'routine', medications: ['x'] }, 'call_G');
  assert.deepStrictEqual(lastRun().args, { verified: false, reason: 'call me back', urgency: 'routine', callerPhone: undefined }, 'unverified patient saved as unverified, message kept');
  await search('call_G', ADA);
  await agent('drawbridge_save_call_record', { verified: true, patientId: '9001', patientSystem: 'veradigm_ehr', reason: 'refill', urgency: 'routine', medications: ['x'] }, 'call_G');
  assert.strictEqual(lastRun().args.patientId, '9001');
  assert.strictEqual(code(await agent('drawbridge_take_message', { callerName: 'Someone', callbackPhone: '555', message: 'hi' }, undefined)), 'OK', 'messages need no verification');

  assert.strictEqual(code(await agent('unity_future_patient_tool', { patientId: '102' }, 'call_G')), 'NOT_VERIFIED', 'unknown tool with a patient fails closed');
  assert.strictEqual(code(await agent('unity_future_patient_tool', { appointmentId: 'A-1' }, 'call_G')), 'NOT_VERIFIED');
  assert.strictEqual(code(await agent('unity_future_patient_tool', { patientId: '101' }, 'call_G')), 'OK');
  assert.strictEqual(code(await agent('unity_future_lookup', { q: 'x' }, undefined)), 'OK');

  assert.strictEqual(code(await agent('get_allergies', { patientId: 'fhir-ada' }, 'call_H', 'fhir')), 'NOT_VERIFIED');
  const fs1 = await agent('search_patient', { lastName: 'Quillfeather', birthDate: '1985-12-10' }, 'call_H', 'fhir');
  assert.ok(fs1.withheld && !/fhir-ada|fhir-other/.test(JSON.stringify(fs1)), 'FHIR search_patient never returns identifiers');
  const fv = await agent('verify_patient_identity', { firstName: 'Ada', lastName: 'Quillfeather', birthDate: '1985-12-10' }, 'call_H', 'fhir');
  assert.strictEqual(fv.verified, true);
  assert.strictEqual(code(await agent('get_allergies', { patientId: 'fhir-ada' }, 'call_H', 'fhir')), 'OK');
  assert.strictEqual(code(await agent('get_patient_medications', { patientId: 'fhir-other' }, 'call_H', 'fhir')), 'NOT_VERIFIED');
  assert.strictEqual(code(await agent('get_appointments_by_date_range', { startDate: '2026-10-01' }, 'call_H', 'fhir')), 'NOT_VERIFIED', 'date-range list needs a verified patient');
  assert.strictEqual(code(await agent('get_appointment_details', { appointmentId: 'x' }, 'call_H', 'fhir')), 'NOT_VERIFIED', 'FHIR appointment by ID never on patient calls');
  assert.strictEqual(code(await agent('search_providers', { name: 'Lee' }, undefined, 'fhir')), 'OK');

  let t = Date.parse('2026-10-15T15:00:00Z');
  const clocked = new cb.CallBindings(() => t);
  assert.strictEqual(clocked.bind('call_T', { pm: '101', chart: '9001' }, 'test'), 'bound');
  t += 119 * 60_000;
  assert.strictEqual(clocked.resolve('call_T', 'pm', '101'), '101');
  t += 2 * 60_000;
  assert.strictEqual(clocked.resolve('call_T', 'pm', '101'), undefined, 'binding gone after 2 hours');
  assert.strictEqual(clocked.size, 0);
  ok('SavePatient removed: unity_save_patient / unity_update_demographics not listed, no code path, denied by the gate even for a verified patient, nothing runs, nobody bound; outreach verifiedPatientId, MRN lookup, call record (saved unverified), unknown tools fail closed; FHIR verify binds, search_patient withheld, appointment-by-ID denied; 2-hour TTL');

  // ── 8. Staff side unaffected ────────────────────────────────────────────────
  const staffRan: string[] = [];
  const deps: any = { unity: fakeUnity, runTool: async (name: string, args: any) => (staffRan.push(`${name}:${args.patientId}`), { success: true, appointments: [] }) };
  const pv = await previsitCheck(deps, '555');
  assert.ok(pv.success && staffRan.includes('unity_get_patient_appointments:555'), 'staff/module path runs tools for any patient, no call binding');
  assert.strictEqual(code(await agent('drawbridge_previsit_check', { patientId: '555' }, 'call_I')), 'NOT_VERIFIED', 'the same tool on the agent edge is gated');
  const src = fs.readFileSync(path.join(__dirname, '..', 'unity', 'unity-test-server.ts'), 'utf8');
  assert.ok(/mountPlatform\(app, \{\s*unity: unityService,\s*runTool: \(name, args, ctx\) => executeTool\(/.test(src), 'staff app and modules use executeTool (ungated)');
  assert.strictEqual((src.match(/withCallBinding\(/g) || []).length, 1, 'the gate is only on the agent edge');
  assert.ok(/async function executeAgentTool[\s\S]*withCallBinding\(/.test(src));
  ok('staff screens, module APIs and internal calls (previsit, upcoming visits, intake) run tools without the call binding; only the agent edge is gated');

  // ── 9. HTTP: both servers ───────────────────────────────────────────────────
  unmute();
  const KEY = 'smoke-callbind-key-0123456789';
  const procs: ChildProcess[] = [];
  try {
    const unity = await start('src/unity/unity-test-server.ts', 'UNITY_PORT', KEY);
    procs.push(unity.proc);
    const fhir = await start('src/test-server.ts', 'MCP_SERVER_PORT', KEY);
    procs.push(fhir.proc);
    const post = (base: string, p: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-drawbridge-key': KEY, ...headers }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);
    const r1 = await post(unity.url, '/api/retell', { name: 'unity_get_patient_appointments', args: { patientId: '101' }, call: { call_id: 'call_http1' } });
    assert.ok(/^TOOL_ERROR \(NOT_VERIFIED/.test(String(r1)), String(r1));
    const r2 = await post(unity.url, '/api/retell', { name: 'unity_get_patient_medications', args: { patientId: '9001' } });
    assert.ok(/^TOOL_ERROR \(CALL_ID_MISSING/.test(String(r2)), String(r2));
    const r3 = await post(unity.url, '/', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'unity_get_account_balance', arguments: { patientId: '101' } } });
    assert.ok(/CALL_ID_MISSING/.test(r3.result.content[0].text), JSON.stringify(r3));
    const r4 = await post(unity.url, '/', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'unity_get_account_balance', arguments: { patientId: '101' } } }, { 'x-call-id': 'call_http2' });
    assert.ok(/NOT_VERIFIED/.test(r4.result.content[0].text), JSON.stringify(r4));
    const r5 = await post(unity.url, '/api/retell', { name: 'unity_get_appointment_types', args: {} });
    assert.ok(!/NOT_VERIFIED|CALL_ID_MISSING/.test(String(r5)), 'lookup not gated');
    // SavePatient tools: not offered (MCP tools/list, GET /tools) and refused when called anyway
    const listed = await post(unity.url, '/', { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
    const listedNames: string[] = (listed.result?.tools || []).map((t: any) => t.name);
    assert.ok(listedNames.includes('unity_search_patients') && !listedNames.includes('unity_save_patient') && !listedNames.includes('unity_update_demographics'), 'MCP tools/list');
    const all13 = (await fetch(`${unity.url}/tools`, { headers: { 'x-drawbridge-key': KEY } }).then((r) => r.json() as Promise<any>)).tools.map((t: any) => t.name);
    assert.ok(all13.length > 5 && !all13.includes('unity_save_patient') && !all13.includes('unity_update_demographics'), 'GET /tools');
    for (const tool of ['unity_save_patient', 'unity_update_demographics']) {
      const viaMcp = await post(unity.url, '/', { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: tool, arguments: { firstName: 'New', lastName: 'Person', patientId: '101' } } }, { 'x-call-id': 'call_http4' });
      assert.ok(/NOT_VERIFIED/.test(JSON.stringify(viaMcp)) && !/created|success":true/i.test(JSON.stringify(viaMcp)), `${tool} refused over MCP: ${JSON.stringify(viaMcp)}`);
      const viaRetell = await post(unity.url, '/api/retell', { name: tool, args: { firstName: 'New', lastName: 'Person' }, call: { call_id: 'call_http4' } });
      assert.ok(/^TOOL_ERROR \(NOT_VERIFIED/.test(String(viaRetell)), `${tool} refused over /api/retell: ${String(viaRetell)}`);
    }
    const f1 = await post(fhir.url, '/api/retell', { name: 'get_allergies', args: { patientId: 'p-1' }, call: { call_id: 'call_http3' } });
    assert.ok(/^TOOL_ERROR \(NOT_VERIFIED/.test(String(f1)), String(f1));
    const f2 = await post(fhir.url, '/mcp/tools/call', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_patient_medications', arguments: { patientId: 'p-1' } } });
    assert.ok(/CALL_ID_MISSING/.test(f2.result.content[0].text), JSON.stringify(f2));
    await new Promise((r) => setTimeout(r, 500));
    const all = await lines();
    assert.ok(all.some((x) => x.server === 'unity' && x.kind === 'security' && x.tool === 'agent_not_verified' && x.call_id === 'call_http1'), 'Unity server security event');
    assert.ok(all.some((x) => x.server === 'fhir' && x.kind === 'security' && x.tool === 'agent_not_verified' && x.call_id === 'call_http3'), 'FHIR server security event');
    assert.ok(all.some((x) => x.server === 'fhir' && x.kind === 'security' && x.tool === 'agent_no_call_id' && x.object === 'get_patient_medications'), 'FHIR no-call-ID event');
    const text = JSON.stringify(all);
    for (const bad of NAMES) assert.ok(!text.includes(bad), `audit log leaks "${bad}"`);
    ok('HTTP: Unity /api/retell and MCP tools/call, FHIR /api/retell and /mcp/tools/call refuse an unverified patient (NOT_VERIFIED) and a missing call ID (CALL_ID_MISSING) before any Veradigm call; SavePatient tools neither listed nor callable; security events in each server\'s audit chain; no names in the audit log');
  } finally {
    for (const p of procs) if (p.exitCode === null) p.kill();
    await new Promise((r) => setTimeout(r, 300));
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} call-binding checks passed.`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

async function start(script: string, portVar: string, key: string): Promise<{ url: string; proc: ChildProcess }> {
  const DEAD = 'http://127.0.0.1:1';
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(env, {
    NODE_ENV: 'sandbox',
    CALL_RECORDS_DIR: TMP,
    AUDIT_DIR: TMP,
    DRAWBRIDGE_TOOL_KEY: key,
    CLIENT_ID: 'smoke',
    CLIENT_SECRET: 'smoke-secret',
    FHIR_BASE_URL_SANDBOX: `${DEAD}/fhir`,
    AUTH_URL_SANDBOX: `${DEAD}/auth`,
    TOKEN_URL_SANDBOX: `${DEAD}/token`,
    UNITY_APP_NAME: 'Smoke.App.Name',
    UNITY_SVC_USERNAME: 'svc',
    UNITY_SVC_PASSWORD: 'svc-pw',
    UNITY_EHR_USERNAME: 'ehr',
    UNITY_EHR_PASSWORD: 'ehr-pw',
    UNITY_UBIQUITY_ENDPOINT: `${DEAD}/UnityService.svc`,
    UNITY_UBIQUITY_ID_PM: 'SMOKEPM:X^1^',
    UNITY_UBIQUITY_ID_EHR: 'SMOKEEHR:X^1^',
    UNITY_AUTH_TIMEOUT_MS: '2000',
    INTAKE_OBSERVE: 'off',
    INTAKE_DROP_DIR: path.join(TMP, 'inbox'),
    [portVar]: String(port),
    MCP_SERVER_HOST: '127.0.0.1',
  });
  const tsNode = path.join(process.cwd(), 'node_modules', 'ts-node', 'dist', 'bin.js');
  const proc = spawn(process.execPath, [tsNode, '--transpile-only', script], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 160; i++) {
    try {
      if ((await fetch(`${url}/health`)).ok) return { url, proc };
    } catch {
      // not up yet
    }
    if (proc.exitCode !== null) throw new Error(`${script} exited: ${out.slice(-800)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  throw new Error(`${script} did not start: ${out.slice(-800)}`);
}

main().catch((e) => {
  console.log = console.log || (() => undefined);
  process.stdout.write(`FAIL ${e?.stack || e?.message || e}\n`);
  process.exitCode = 1;
});
