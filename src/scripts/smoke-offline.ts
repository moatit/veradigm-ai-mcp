/**
 * Offline smoke test for tool logic (no network, no credentials).
 * Uses a fake Unity service to check: failures are never empty results, balance sums vouchers,
 * Unity row flattening, idempotent writes, and the voice summaries the agent hears.
 *
 *   npm run smoke
 */
for (const k of ['UNITY_APP_NAME', 'UNITY_SVC_USERNAME', 'UNITY_SVC_PASSWORD', 'UNITY_EHR_USERNAME', 'UNITY_EHR_PASSWORD']) {
  process.env[k] = process.env[k] || 'offline-smoke';
}

import assert from 'assert';

type Fake = (action: string, params: any, patientId: string) => any;

async function main(): Promise<void> {
  const { UnityAppointmentTools } = await import('../unity/tools/appointment.tools');
  const { UnityBillingTools } = await import('../unity/tools/billing.tools');
  const { UnityPatientTools } = await import('../unity/tools/patient.tools');
  const { UnityClinicalTools } = await import('../unity/tools/clinical.tools');
  const { toToolFailure } = await import('../unity/utils/tool-result');
  const { withIdempotency } = await import('../unity/utils/idempotency');
  const { toVoiceSummary } = await import('../utils/response-formatter');
  const { markRedacted } = await import('../utils/redaction');
  const { DISABLED_FHIR_TOOLS } = await import('../config/disabled-tools');

  const svc = (fake: Fake): any => ({
    executeAction: async (a: string, p: any, pid: string) => fake(a, p, pid),
    searchPatients: async () => fake('SearchPatients', {}, ''),
    getPatient: async (pid: string) => fake('GetPatient', {}, pid),
  });
  const failing = svc(() => ({ success: false, error: 'Magic Error: unknown action' }));
  const run = async (name: string, fn: () => Promise<any>) => {
    try {
      return await fn();
    } catch (e) {
      return toToolFailure(e, name);
    }
  };
  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`PASS ${label}`);
  };

  // 1. Failures are structured errors, never empty lists
  const appt = new UnityAppointmentTools(failing);
  for (const [name, fn] of [
    ['unity_get_open_slots', () => appt.getOpenSlots({ startDate: '10/12/2026', endDate: '10/16/2026' })],
    ['unity_get_patient_appointments', () => appt.getPatientAppointments({ patientId: '56500' })],
    ['unity_search_patients', () => new UnityPatientTools(failing).searchPatients({ lastName: 'Smith' })],
    ['unity_get_patient_allergies', () => new UnityClinicalTools(failing).getPatientAllergies({ patientId: '56500' })],
    ['unity_get_cancellation_reasons', () => appt.getCancellationReasons()],
    ['unity_get_account_balance', () => new UnityBillingTools(failing).getAccountBalance({ patientId: '56500' })],
  ] as Array<[string, () => Promise<any>]>) {
    const r = await run(name, fn);
    assert.strictEqual(r.success, false, `${name} should fail`);
    assert.ok(r.error_code, `${name} needs error_code`);
    const text = toVoiceSummary(name, r);
    assert.ok(text.startsWith('TOOL_ERROR'), `${name} voice text: ${text}`);
    assert.ok(!/no (open|appointments|patients|allergies)/i.test(text), `${name} sounds empty: ${text}`);
    ok(`${name} failure → ${r.error_code}`);
  }

  // 2. Balance sums vouchers from Unity's wrapped, lower-case shape
  const billing = new UnityBillingTools(
    svc(() => ({
      success: true,
      data: [{ getpatientaccountbalanceinfo: [{ patientbalance: '$40.00' }, { patientbalance: '15.50' }, { patientbalance: '(5.50)' }] }],
    }))
  );
  const bal = await billing.getAccountBalance({ patientId: '56500' });
  assert.strictEqual(bal.balance, 50);
  assert.strictEqual(bal.voucherCount, 3);
  assert.match(toVoiceSummary('unity_get_account_balance', bal), /\$50\.00/);
  ok('balance sums 3 vouchers to $50.00');

  // 3. Empty success is a real "none" answer
  const empty = new UnityAppointmentTools(svc(() => ({ success: true, data: [{ getschedulebypatientidinfo: [] }] })));
  const none = await empty.getPatientAppointments({ patientId: '56500' });
  assert.strictEqual(none.total, 0);
  assert.strictEqual(toVoiceSummary('unity_get_patient_appointments', none), 'No appointments found.');
  ok('empty success → "No appointments found."');

  // 4. Appointment rows parse from wrapped shape and include the ID for the next tool call
  const some = new UnityAppointmentTools(
    svc((a: string) =>
      a === 'GetResources'
        ? { success: true, data: [{ getresourcesinfo: [{ Resource_ID: '7', Abbreviation: 'LEE', Description: 'Lee, Andrew', Practitioner_ID: '3' }] }] }
        : a === 'GetAppointmentTypes'
          ? { success: true, data: [{ getappointmenttypesinfo: [{ Appointment_Type_ID: '2', Description: 'Follow Up Visit' }] }] }
          : {
              success: true,
              data: [{ getschedulebypatientidinfo: [
                { Appointment_ID: '9001', Patient_ID: '56500', Appointment_DateTime: '10/13/2099 9:00:00 AM', Resource_ID: '7', Appointment_Type_ID: '2', Status: 'S', Duration: '15' },
                { Appointment_ID: '9002', Patient_ID: '56500', Appointment_DateTime: '10/14/2099 9:00:00 AM', Resource_ID: '7', Status: 'X' },
                { Appointment_ID: '8000', Patient_ID: '56500', Appointment_DateTime: '1/2/2020 9:00:00 AM', Resource_ID: '7', Status: 'S' },
              ] }],
            }
    )
  );
  const list = await some.getPatientAppointments({ patientId: '56500' });
  assert.deepStrictEqual(list.appointments.map((x) => x.id), ['9001'], 'future, not cancelled');
  assert.strictEqual(list.appointments[0].providerName, 'Andrew Lee');
  assert.strictEqual(list.appointments[0].appointmentType, 'Follow Up Visit');
  assert.match(toVoiceSummary('unity_get_patient_appointments', list), /10\/13\/2099 9:00 AM with Andrew Lee.*appointmentId 9001/);
  ok('appointment row parsed with provider and ID');

  // 5. Cancellation reasons
  const reasons = await new UnityAppointmentTools(
    svc(() => ({ success: true, data: [{ getappointmentcancellationreasonsinfo: [{ id: '3', description: 'Patient request' }] }] }))
  ).getCancellationReasons();
  assert.match(toVoiceSummary('unity_get_cancellation_reasons', reasons), /Patient request \[id 3\]/);
  ok('cancellation reasons listed with IDs');

  // 6. Idempotent writes: same call + args runs once
  let writes = 0;
  const write = () => withIdempotency('call-1', 'unity_save_appointment', { patientId: '56500', appointmentDate: '10/13/2026' }, async () => ++writes);
  await Promise.all([write(), write()]);
  await write();
  assert.strictEqual(writes, 1);
  await withIdempotency('call-2', 'unity_save_appointment', { patientId: '56500', appointmentDate: '10/13/2026' }, async () => ++writes);
  assert.strictEqual(writes, 2);
  ok('duplicate write in the same call runs once');

  // 7. Redacted FHIR data is never "none on file"
  const red = markRedacted({ success: true, allergies: [], meta: { security: [{ code: 'REDACTED' }] } });
  assert.match(toVoiceSummary('get_allergies', red), /^RESTRICTED/);
  ok('redacted result → RESTRICTED');

  // 8. FHIR appointment tools disabled
  assert.ok(DISABLED_FHIR_TOOLS.has('create_appointment') && DISABLED_FHIR_TOOLS.has('get_medication_statements'));
  ok('FHIR appointment tools and get_medication_statements disabled');

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error('FAIL', e?.message || e);
  process.exit(1);
});
