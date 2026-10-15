/**
 * Drawbridge sandbox verification
 *
 * Calls every Veradigm action and FHIR read that Drawbridge depends on and prints PASS/FAIL.
 * READ ONLY: it never calls a write action.
 *
 *   npm run verify:sandbox                 # uses .env, writes verify-sandbox-report.json
 *   npm run verify:sandbox -- --json out.json
 *
 * Must run on a machine that can reach the Veradigm sandboxes (not the Claude cloud workspace).
 *
 * How to read the "Action name check" rows: each pair compares the action name the repo sends
 * today with the name in Veradigm's PM/EHR API reference. A FAIL whose message is about missing
 * or bad parameters usually means the action EXISTS; a FAIL saying the action is unknown/invalid
 * means it does not. GetServerInfo shows which Veradigm product and version the sandbox is.
 *
 * Optional env (defaults are the Veradigm sandbox test patients):
 *   VERIFY_UNITY_PATIENT_ID=56500  VERIFY_UNITY_LAST=Smith  VERIFY_UNITY_FIRST=Ed  VERIFY_UNITY_DOB=12/06/1952
 *   VERIFY_UNITY_MRN=56500         VERIFY_APPOINTMENT_ID=
 *   VERIFY_FHIR_FAMILY=Smith  VERIFY_FHIR_GIVEN=John  VERIFY_FHIR_BIRTHDATE=1980-01-15
 */
import * as fs from 'fs';
import type { UnityService } from '../unity/services/unity.service';
import type { UnityTargetSystem } from '../unity/config/unity-endpoints';
import type { FHIRService } from '../services/fhir.service';

type Status = 'PASS' | 'FAIL' | 'SKIP' | 'INFO';
interface Result {
  group: string;
  check: string;
  target: string;
  priority: string;
  status: Status;
  ms: number;
  detail: string;
}

const args = process.argv.slice(2);
const jsonIdx = args.indexOf('--json');
const JSON_OUT = jsonIdx >= 0 && args[jsonIdx + 1] ? args[jsonIdx + 1] : 'verify-sandbox-report.json';

const env = (k: string, d = ''): string => process.env[k] || d;
const U_PID = env('VERIFY_UNITY_PATIENT_ID', '56500');
const U_LAST = env('VERIFY_UNITY_LAST', 'Smith');
const U_FIRST = env('VERIFY_UNITY_FIRST', 'Ed');
const U_DOB = env('VERIFY_UNITY_DOB', '12/06/1952');
const U_MRN = env('VERIFY_UNITY_MRN', '56500');
const APPT_ID = env('VERIFY_APPOINTMENT_ID');
const F_FAMILY = env('VERIFY_FHIR_FAMILY', 'Smith');
const F_GIVEN = env('VERIFY_FHIR_GIVEN', 'John');
const F_BIRTH = env('VERIFY_FHIR_BIRTHDATE', '1980-01-15');

const results: Result[] = [];

function mmddyyyy(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()}`;
}

function brief(data: unknown, max = 180): string {
  if (data === undefined || data === null) return '(no data)';
  let s: string;
  try {
    s = typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    s = String(data);
  }
  if (s === '[]' || s === '{}' || s === '[{}]') return '(empty)';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function errMsg(e: unknown): string {
  const anyE = e as any;
  return brief(anyE?.message || anyE?.details || anyE, 220);
}

let unity: UnityService | null = null;
let fhir: FHIRService | null = null;

async function unityCheck(
  group: string,
  check: string,
  action: string,
  params: Record<string, string>,
  patientId: string,
  target: UnityTargetSystem,
  priority: string,
): Promise<void> {
  if (!unity) {
    results.push({ group, check, target, priority, status: 'SKIP', ms: 0, detail: 'Unity not configured' });
    return;
  }
  const t0 = Date.now();
  try {
    const r = await unity.executeAction(action, params, patientId, target);
    results.push({
      group, check, target, priority,
      status: r.success ? 'PASS' : 'FAIL',
      ms: Date.now() - t0,
      detail: r.success ? brief(r.data) : brief(r.error, 220),
    });
  } catch (e) {
    results.push({ group, check, target, priority, status: 'FAIL', ms: Date.now() - t0, detail: errMsg(e) });
  }
}

async function fhirSearch(
  check: string,
  resourceType: string,
  params: Record<string, string>,
  priority: string,
  expectSupported = true,
): Promise<any[]> {
  const group = 'FHIR reads';
  if (!fhir) {
    results.push({ group, check, target: 'FHIR', priority, status: 'SKIP', ms: 0, detail: 'FHIR not configured' });
    return [];
  }
  const t0 = Date.now();
  try {
    const r = await fhir.search(resourceType, params, 5);
    const redacted = JSON.stringify(r.resources).toLowerCase().includes('redact');
    results.push({
      group, check, target: 'FHIR', priority,
      status: expectSupported ? 'PASS' : 'INFO',
      ms: Date.now() - t0,
      detail: `${r.total} result(s)${redacted ? ' · CONTAINS REDACTED DATA' : ''} · ${brief(r.resources[0], 120)}`,
    });
    return r.resources;
  } catch (e) {
    results.push({
      group, check, target: 'FHIR', priority,
      status: expectSupported ? 'FAIL' : 'INFO',
      ms: Date.now() - t0,
      detail: (expectSupported ? '' : 'Expected: not in Veradigm production FHIR. ') + errMsg(e),
    });
    return [];
  }
}

async function main(): Promise<void> {
  console.log('Drawbridge sandbox verification (read only)\n');

  // Loaded lazily: each config module throws at import time if its env vars are missing,
  // and a missing FHIR config should not stop the Unity checks (or the other way round).
  try {
    const { UnityAuthService } = await import('../unity/services/unity-auth.service');
    const { UnityService: Unity } = await import('../unity/services/unity.service');
    unity = new Unity(new UnityAuthService());
  } catch (e) {
    console.log(`Unity checks skipped (config): ${errMsg(e)}`);
  }
  try {
    const { AuthService } = await import('../services/auth.service');
    const { FHIRService: Fhir } = await import('../services/fhir.service');
    fhir = new Fhir(new AuthService());
  } catch (e) {
    console.log(`FHIR checks skipped (config): ${errMsg(e)}`);
  }

  // ---- Unity: connection and product info ----
  for (const t of ['PM', 'EHR'] as UnityTargetSystem[]) {
    await unityCheck('Unity connection', `Echo (${t})`, 'Echo', { Parameter1: 'drawbridge' }, '', t, 'P0');
    await unityCheck('Unity connection', `GetServerInfo (${t}) · shows product/version`, 'GetServerInfo', {}, '', t, 'P0');
  }

  // ---- Unity: patient search (gate for every Unity flow) ----
  if (unity) {
    const t0 = Date.now();
    try {
      const r = await unity.searchPatients({ lastName: U_LAST, firstName: U_FIRST, dob: U_DOB }, 'PM');
      results.push({
        group: 'Unity patients', check: `SearchPatients ${U_FIRST} ${U_LAST} ${U_DOB} (PM)`, target: 'PM', priority: 'P0',
        status: r.success ? 'PASS' : 'FAIL', ms: Date.now() - t0, detail: r.success ? brief(r.data) : brief(r.error),
      });
    } catch (e) {
      results.push({ group: 'Unity patients', check: 'SearchPatients (PM)', target: 'PM', priority: 'P0', status: 'FAIL', ms: Date.now() - t0, detail: errMsg(e) });
    }
  }
  await unityCheck('Unity patients', `GetPatient ${U_PID} (EHR)`, 'GetPatient', {}, U_PID, 'EHR', 'P1');
  await unityCheck('Unity patients', `GetPatientByMRN ${U_MRN} (EHR)`, 'GetPatientByMRN', { Parameter1: U_MRN }, '', 'EHR', 'P1');

  // ---- Action name check: repo name vs Veradigm reference name ----
  const pairs: Array<[string, string, string, Record<string, string>, string, UnityTargetSystem, string]> = [
    // [label, repoAction, referenceAction, params, patientId, target, priority]
    ['Patient appointments', 'GetAppointments', 'GetScheduleByPatientID', {}, U_PID, 'PM', 'P0'],
    ['Open slots', 'GetOpenSlots', 'GetAllAvailableAppointments', { Parameter1: mmddyyyy(1), Parameter2: mmddyyyy(14) }, '', 'PM', 'P0'],
    ['Problem list', 'GetPatientProblems', 'GetProblems', {}, U_PID, 'EHR', 'P1'],
    ['Allergies', 'GetPatientAllergies', 'GetAllergies', {}, U_PID, 'EHR', 'P1'],
    ['Current medications', 'GetPatientMedications', 'GetClinicalSummary', {}, U_PID, 'EHR', 'P1'],
    ['Troubleshooting log', 'LastLog', 'LastLogs', {}, '', 'PM', 'P2'],
  ];
  for (const [label, repoAct, refAct, params, pid, target, pr] of pairs) {
    await unityCheck('Action name check', `${label}: repo sends ${repoAct}`, repoAct, params, pid, target, pr);
    await unityCheck('Action name check', `${label}: reference ${refAct}`, refAct, params, pid, target, pr);
  }
  results.push({
    group: 'Action name check', check: 'CancelAppointment vs SetAppointmentStatus; UpdateDemographics vs SavePatient',
    target: 'PM', priority: 'P0', status: 'SKIP', ms: 0,
    detail: 'Write actions: verify by hand on a sandbox test appointment (this script never writes).',
  });

  // ---- Planned Unity reads ----
  await unityCheck('Planned PM reads', 'GetAppointmentCancellationReasons', 'GetAppointmentCancellationReasons', {}, '', 'PM', 'P0');
  await unityCheck('Planned PM reads', 'GetAppointmentTypes', 'GetAppointmentTypes', {}, '', 'PM', 'P1');
  await unityCheck('Planned PM reads', 'GetAppointmentConfirmationResults', 'GetAppointmentConfirmationResults', {}, '', 'PM', 'P2');
  if (APPT_ID) {
    await unityCheck('Planned PM reads', `GetAppointmentById ${APPT_ID}`, 'GetAppointmentById', { Parameter1: APPT_ID }, U_PID, 'PM', 'P1');
  } else {
    results.push({ group: 'Planned PM reads', check: 'GetAppointmentById', target: 'PM', priority: 'P1', status: 'SKIP', ms: 0, detail: 'Set VERIFY_APPOINTMENT_ID' });
  }
  await unityCheck('Planned PM reads', `GetPatientAccountBalance ${U_PID}`, 'GetPatientAccountBalance', {}, U_PID, 'PM', 'P1');
  await unityCheck('Planned PM reads', `GetPatientPolicy ${U_PID}`, 'GetPatientPolicy', {}, U_PID, 'PM', 'P1');
  await unityCheck('Planned PM reads', `GetSchedule ${mmddyyyy(0)}`, 'GetSchedule', { Parameter1: mmddyyyy(0) }, '', 'PM', 'P2');
  await unityCheck('Planned PM reads', `GetAppointmentsByChangeDTTM since ${mmddyyyy(-7)}`, 'GetAppointmentsByChangeDTTM', { Parameter1: mmddyyyy(-7), Parameter2: mmddyyyy(0) }, '', 'PM', 'later');
  await unityCheck('Planned PM reads', `GetRecalls ${U_PID}`, 'GetRecalls', { Parameter1: U_PID }, U_PID, 'PM', 'later');
  await unityCheck('Planned EHR reads', `GetPatientDiagnosis ${U_PID}`, 'GetPatientDiagnosis', {}, U_PID, 'EHR', 'P2');
  await unityCheck('Planned EHR reads', 'GetLocation', 'GetLocation', {}, '', 'EHR', 'P2');
  await unityCheck('Planned EHR reads', 'GetProviders', 'GetProviders', {}, '', 'EHR', 'P2');

  // ---- FHIR ----
  if (fhir) {
    const t0 = Date.now();
    try {
      const cap = await fhir.getCapabilities();
      const types: string[] = (cap?.rest?.[0]?.resource || []).map((r: any) => r.type);
      const has = (t: string) => (types.includes(t) ? 'YES' : 'no');
      results.push({
        group: 'FHIR reads', check: 'CapabilityStatement (GET /metadata)', target: 'FHIR', priority: 'P0', status: 'INFO', ms: Date.now() - t0,
        detail: `fhirVersion=${cap?.fhirVersion} · software=${brief(cap?.software?.name, 60)} · ${types.length} resource types · Appointment=${has('Appointment')} · MedicationStatement=${has('MedicationStatement')}`,
      });
    } catch (e) {
      results.push({ group: 'FHIR reads', check: 'CapabilityStatement (GET /metadata)', target: 'FHIR', priority: 'P0', status: 'FAIL', ms: Date.now() - t0, detail: errMsg(e) });
    }
  }
  const patients = await fhirSearch(`Patient ${F_GIVEN} ${F_FAMILY} ${F_BIRTH}`, 'Patient', { family: F_FAMILY, given: F_GIVEN, birthdate: F_BIRTH }, 'P0');
  const pid: string | undefined = patients[0]?.id;
  if (pid) {
    await fhirSearch('MedicationRequest', 'MedicationRequest', { patient: pid }, 'P0');
    await fhirSearch('AllergyIntolerance', 'AllergyIntolerance', { patient: pid }, 'P0');
    await fhirSearch('Condition', 'Condition', { patient: pid }, 'P1');
    await fhirSearch('Observation', 'Observation', { patient: pid }, 'P1');
    await fhirSearch('Procedure', 'Procedure', { patient: pid }, 'P2');
    await fhirSearch('Coverage', 'Coverage', { patient: pid }, 'P2');
    await fhirSearch('Appointment (should be disabled)', 'Appointment', { patient: pid }, 'info', false);
    await fhirSearch('MedicationStatement (should be disabled)', 'MedicationStatement', { patient: pid }, 'info', false);
  } else {
    results.push({ group: 'FHIR reads', check: 'Patient-scoped reads', target: 'FHIR', priority: 'P0', status: 'SKIP', ms: 0, detail: 'No FHIR patient found; check VERIFY_FHIR_* values' });
  }
  await fhirSearch('Practitioner', 'Practitioner', { _count: '1' }, 'P2');
  await fhirSearch('Location', 'Location', { _count: '1' }, 'P2');

  // ---- Report ----
  let group = '';
  for (const r of results) {
    if (r.group !== group) {
      group = r.group;
      console.log(`\n== ${group}`);
    }
    console.log(`${r.status.padEnd(4)} ${r.priority.padEnd(5)} ${r.check.padEnd(62)} ${String(r.ms).padStart(5)}ms  ${r.detail}`);
  }
  const count = (s: Status) => results.filter((r) => r.status === s).length;
  const p0Fails = results.filter((r) => r.status === 'FAIL' && r.priority === 'P0');
  console.log(`\nPASS ${count('PASS')} · FAIL ${count('FAIL')} · SKIP ${count('SKIP')} · INFO ${count('INFO')} · P0 failures ${p0Fails.length}`);

  fs.writeFileSync(JSON_OUT, JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
  console.log(`Report written to ${JSON_OUT}. It contains sandbox test data only; do not run this against production.`);
  if (count('PASS') === 0) {
    console.log('Nothing verified: no check passed. Check the .env values and that this machine can reach the sandbox.');
    process.exit(1);
  }
  process.exit(p0Fails.length ? 1 : 0);
}

main().catch((e) => {
  console.error('Verification crashed:', errMsg(e));
  process.exit(2);
});
