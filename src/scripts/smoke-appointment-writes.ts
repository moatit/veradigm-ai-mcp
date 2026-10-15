/**
 * Offline smoke test for the Veradigm® PM appointment writes (no network, no credentials).
 * A fake Unity service stands in for Veradigm. Checks:
 *  - SaveAppointment Parameter1 is the official <appt> layout (developer.veradigm.com, 10/13/2026),
 *    location/department resolved from the GetAvailableSchedule row + the 1-hour lookups;
 *  - saveappointmentinfo → Appointment_ID / Encounter_Number, and every failure is explicit;
 *  - SetAppointmentStatus parameters (P1 ID, P2 letter, P4 HHMM, P5/P6 IDs) and the
 *    Scheduled → Confirmed → Canceled fallback.
 *
 *   npm run smoke:appointment-writes
 */
for (const k of ['UNITY_APP_NAME', 'UNITY_SVC_USERNAME', 'UNITY_SVC_PASSWORD', 'UNITY_EHR_USERNAME', 'UNITY_EHR_PASSWORD']) {
  process.env[k] = process.env[k] || 'offline-smoke';
}
process.env.CLINIC_TIMEZONE = 'America/Boise';
for (const k of [
  'UNITY_DEFAULT_APPOINTMENT_TYPE', 'UNITY_DEFAULT_SCHEDULING_DEPARTMENT', 'UNITY_DEFAULT_CANCEL_REASON', 'UNITY_SCHEDULING_RESOURCES',
  'UNITY_APPT_REFER_DR', 'UNITY_APPT_COVERAGE_TYPE', 'UNITY_APPT_VISIT_TYPE', 'UNITY_APPT_REFERRAL_REQUIRED', 'UNITY_APPT_AILMENT_ID',
]) delete process.env[k];

import assert from 'assert';

type Call = { action: string; params: any; patientId: string; target: string };
type Handler = (params: any, patientId: string, call: Call) => any;

async function main(): Promise<void> {
  const A = (await import('../unity/config/unity-endpoints')).UnityActions.Scheduling;
  const mod = await import('../unity/tools/appointment.tools');
  const { UnityAppointmentTools, buildAppointmentXml, parseClockTime, clinicHHMM, placesForSlot, isTransitionRejection, parseSaveAppointmentResult, parseStatusResult } = mod;
  const { toToolFailure } = await import('../unity/utils/tool-result');

  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`PASS ${label}`);
  };

  // A date a week ahead in the clinic's time zone (MM/DD/YYYY), so "not in the past" always holds.
  const ahead = (days: number) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Boise', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(Date.now() + days * 86_400_000));
    const g = (t: string) => p.find((x) => x.type === t)!.value;
    return `${g('month')}/${g('day')}/${g('year')}`;
  };
  const DAY = ahead(7);

  // 288 five-minute cells; open = [start, end) in minutes.
  const bitmap = (ranges: Array<[number, number]>) => {
    const cells = Array(288).fill('0');
    for (const [s, e] of ranges) for (let i = s / 5; i < e / 5; i++) cells[i] = '1';
    const str = cells.join('');
    return [str.slice(0, 144), str.slice(144)];
  };
  const availRow = (deptId: string, deptAbbr: string, open: Array<[number, number]>, booked: Array<[number, number]> = [], extra: any = {}) => {
    const [k1, k2] = bitmap(open);
    const [b1, b2] = bitmap(booked);
    return {
      Resource_Abbreviation: 'MARFEE  ', Resource_ID: '50', Available_Date: DAY,
      Scheduling_Location_ID: '1', Scheduling_Location_Abbreviation: 'OFFICE  ',
      Scheduling_Department_ID: deptId, Scheduling_Department_Abbreviation: `${deptAbbr}   `,
      Blocked_Slots1: k1, Blocked_Slots2: k2, Booked_Slots1: b1, Booked_Slots2: b2,
      Elig_Appointment_Category_ID: '', Inelig_Appointment_Category_ID: '', ...extra,
    };
  };

  const RESOURCES = [{ getresourcesinfo: [
    { Resource_ID: '50', Abbreviation: 'MARFEE', Description: 'FEELGOOD, MARK M', Practitioner_ID: '2', Default_Appointment_Type_ID: '1' },
    { Resource_ID: '51', Abbreviation: 'LEE', Description: 'Lee, Andrew MD', Practitioner_ID: '11', Default_Appointment_Type_ID: '4' },
  ] }];
  const TYPES = [{ getappointmenttypesinfo: [
    { Appointment_Type_ID: '1', Abbreviation: 'ACUTE', Description: 'Acute Visit', Duration: '15', Appointment_Category_ID: '4', Appt_Category_Abbreviation: 'ACUTE' },
    { Appointment_Type_ID: '4', Abbreviation: 'OV', Description: 'Office Visit', Duration: '15', Appointment_Category_ID: '2', Appt_Category_Abbreviation: 'OV' },
    { Appointment_Type_ID: '27', Abbreviation: 'OV30', Description: 'Office Visit 30 minutes', Duration: '30', Appointment_Category_ID: '2', Appt_Category_Abbreviation: 'OV' },
  ] }];
  const LOCATIONS = [{ getschedulinglocationsinfo: [
    { Scheduling_Location_ID: '1', Abbreviation: 'OFFICE', Description: 'NASHUA QA MEDICAL PRACTICE', Location_ID: '1' },
    { Scheduling_Location_ID: '12', Abbreviation: 'OFFICE1', Description: 'NASHUA QA MEDICAL PRACTICE 1' },
  ] }];
  const DEPARTMENTS = [{ getschedulingdepartmentsinfo: [
    { Scheduling_Department_ID: '4', Abbreviation: 'HOSINP', Description: 'HOSPITAL INPATIENT', Department_ID: '4' },
    { Scheduling_Department_ID: '2', Abbreviation: 'SURGI', Description: 'AMBULATORY SURGI CENTER', Department_ID: '2' },
  ] }];
  const REASONS = [{ getappointmentcancellationreasonsinfo: [
    { Cancellation_Reason_ID: '1', Description: 'Moved Appointment', Abbreviation: 'MOVED' },
    { Cancellation_Reason_ID: '3', Description: 'Patient Cancelled', Abbreviation: 'PAT CX' },
    { Cancellation_Reason_ID: '4', Description: 'Office Cancelled', Abbreviation: 'OFF CX' },
  ] }];
  const CONFIRM_RESULTS = [{ getappointmentconfirmationresultsinfo: [
    { Appt_Confirmation_Result_ID: '1', Short_Description: 'Answered - Yes' },
    { Appt_Confirmation_Result_ID: '20', Short_Description: 'Patient notified' },
  ] }];
  const ok200 = (data: any) => ({ success: true, data });
  const sched = (rows: any[]) => ok200([{ getschedulebypatientidinfo: rows }]);
  const statusOk = () => ok200([{ setappointmentstatusinfo: [{ Status: 'success' }] }]);

  // 10:00-12:00 open in HOSINP (dept 4) and 13:00-15:00 in SURGI (dept 2); 10:30-10:45 booked.
  const DAY_ROWS = [availRow('4', 'HOSINP', [[600, 720]], [[630, 645]]), availRow('2', 'SURGI', [[780, 900]])];

  const calls: Call[] = [];
  const fakeUnity = (overrides: Record<string, Handler> = {}) => {
    calls.length = 0;
    const base: Record<string, Handler> = {
      [A.GET_RESOURCES]: () => ok200(RESOURCES),
      [A.GET_APPOINTMENT_TYPES]: () => ok200(TYPES),
      [A.GET_SCHEDULING_LOCATIONS]: () => ok200(LOCATIONS),
      [A.GET_SCHEDULING_DEPARTMENTS]: () => ok200(DEPARTMENTS),
      [A.GET_CANCELLATION_REASONS]: () => ok200(REASONS),
      [A.GET_CONFIRMATION_RESULTS]: () => ok200(CONFIRM_RESULTS),
      [A.GET_OPEN_SLOTS]: () => ok200([{ getavailablescheduleinfo: DAY_ROWS }]),
      [A.GET_APPOINTMENTS]: () => sched([]),
      [A.SAVE_APPOINTMENT]: () => ok200([{ saveappointmentinfo: [{ Appointment_ID: '90001', Encounter_Number: '7001' }] }]),
      [A.SET_APPOINTMENT_STATUS]: () => statusOk(),
    };
    const h = { ...base, ...overrides };
    return {
      executeAction: async (action: string, params: any = {}, patientId = '', target = 'EHR') => {
        const call = { action, params, patientId, target };
        calls.push(call);
        const fn = h[action];
        if (!fn) throw new Error(`unexpected action ${action}`);
        return fn(params, patientId, call);
      },
    } as any;
  };
  const run = async (name: string, fn: () => Promise<any>) => {
    try {
      return await fn();
    } catch (e) {
      return toToolFailure(e, name);
    }
  };
  const callsOf = (action: string) => calls.filter((c) => c.action === action);

  // ---------------------------------------------------------------- pure helpers
  assert.strictEqual(
    buildAppointmentXml({
      appointmentDateTime: '06/15/2026 13:30', appointmentDuration: 30, appointmentType: 'OV', schedulingLocation: 'OFFICE',
      schedulingDepartment: 'OFFICE', resource: 'ANNANE', comments: 'Knee pain & swelling <2 wks>',
      schedulingLocationId: '123', schedulingDepartmentId: '456',
    }),
    '<appt><appointmentDateTime>06/15/2026 13:30</appointmentDateTime><appointmentDuration>30</appointmentDuration>' +
      '<appointmentType>OV</appointmentType><schedulingLocation>OFFICE</schedulingLocation><schedulingDepartment>OFFICE</schedulingDepartment>' +
      '<resource>ANNANE</resource><comments>Knee pain &amp; swelling &lt;2 wks&gt;</comments>' +
      '<schedulingLocationID>123</schedulingLocationID><schedulingDepartmentID>456</schedulingDepartmentID></appt>'
  );
  assert.strictEqual(
    buildAppointmentXml({
      appointmentDateTime: '06/15/2018 13:30', appointmentDuration: 30, appointmentType: 'OV', schedulingLocation: 'OFFICE',
      schedulingDepartment: 'OFFICE', resource: 'ANNANE', comments: 'Appointment saved from Unity', referDr: 'Bones',
      coverageType: 'M', visitType: 'OFFVT', referralRequired: '1', schedulingLocationId: '123', schedulingDepartmentId: '456', ailmentId: '1212',
    }),
    '<appt><appointmentDateTime>06/15/2018 13:30</appointmentDateTime><appointmentDuration>30</appointmentDuration>' +
      '<appointmentType>OV</appointmentType><schedulingLocation>OFFICE</schedulingLocation><schedulingDepartment>OFFICE</schedulingDepartment>' +
      '<resource>ANNANE</resource><comments>Appointment saved from Unity</comments><referDr>Bones</referDr><coverageType>M</coverageType>' +
      '<visitType>OFFVT</visitType><referralRequired>1</referralRequired><schedulingLocationID>123</schedulingLocationID>' +
      '<schedulingDepartmentID>456</schedulingDepartmentID><ailmentID>1212</ailmentID></appt>',
    'all elements in the spec order (Veradigm example)'
  );
  ok('buildAppointmentXml: official <appt> layout, element order, escaping, optional elements only when set');

  for (const [input, want] of [['13:30', 810], ['1:30 PM', 810], ['9:05am', 545], ['0930', 570], ['12:00 AM', 0], ['12:15 PM', 735], ['9:15 AM', 555]] as Array<[string, number]>) {
    assert.strictEqual(parseClockTime(input), want, input);
  }
  for (const bad of ['25:00', '13:30 PM', 'noon', '9:75']) assert.ok(isNaN(parseClockTime(bad)), bad);
  assert.strictEqual(clinicHHMM(new Date(Date.UTC(2026, 9, 15, 11, 30))), '1130');
  assert.strictEqual(clinicHHMM(new Date(Date.UTC(2026, 9, 15, 9, 5))), '905');
  assert.strictEqual(clinicHHMM(new Date(Date.UTC(2026, 9, 15, 0, 7))), '7');
  ok('time parsing (24-hour and AM/PM) and SetAppointmentStatus Parameter4 HHMM integer');

  assert.deepStrictEqual(placesForSlot(DAY_ROWS, DAY, 600, 30, '2'), [
    { locationId: '1', locationAbbreviation: 'OFFICE', departmentId: '4', departmentAbbreviation: 'HOSINP' },
  ]);
  assert.deepStrictEqual(placesForSlot(DAY_ROWS, DAY, 780, 15).map((p) => p.departmentId), ['2']);
  assert.deepStrictEqual(placesForSlot(DAY_ROWS, DAY, 615, 30), [], '10:15-10:45 overlaps the 10:30 booking');
  assert.deepStrictEqual(placesForSlot(DAY_ROWS, DAY, 705, 30), [], '11:45-12:15 runs past the template');
  assert.deepStrictEqual(placesForSlot(DAY_ROWS, ahead(8), 600, 15), [], 'other day');
  const eligRows = [availRow('4', 'HOSINP', [[600, 720]], [], { Elig_Appointment_Category_ID: '4' }), availRow('2', 'SURGI', [[600, 720]], [], { Inelig_Appointment_Category_ID: '2' })];
  assert.deepStrictEqual(placesForSlot(eligRows, DAY, 600, 15, '2'), [], 'category 2 not eligible in either row');
  assert.deepStrictEqual(placesForSlot(eligRows, DAY, 600, 15, '4').map((p) => p.departmentId), ['4', '2']);
  ok('placesForSlot: template, bookings across rows, day, eligible/ineligible appointment categories');

  assert.deepStrictEqual(parseSaveAppointmentResult([{ saveappointmentinfo: [{ Appointment_ID: '123', Encounter_Number: '456' }] }]), { appointmentId: '123', encounterNumber: '456' });
  assert.deepStrictEqual(parseSaveAppointmentResult([{ saveappointmentinfo: [] }]), { appointmentId: '', encounterNumber: '' });
  assert.deepStrictEqual(parseStatusResult([{ setappointmentstatusinfo: [{ Status: 'success' }] }]), { ok: true, status: 'success' });
  assert.strictEqual(parseStatusResult([{ setappointmentstatusinfo: [{ Status: 'Appointment status cannot be changed' }] }]).ok, false);
  assert.strictEqual(parseStatusResult([{ setappointmentstatusinfo: [] }]).ok, false, 'no status is not success');
  assert.ok(isTransitionRejection('Magic Error - Action: SetAppointmentStatus - Cannot change status from Scheduled to Canceled'));
  assert.ok(!isTransitionRejection('Magic Error - Action: SetAppointmentStatus - Error: User does not have appropriate security setting (Sched.ApptSch)'));
  assert.ok(!isTransitionRejection('Magic Error - Action: SetAppointmentStatus - Invalid appointment id'), 'the action name alone is not a status hint');
  ok('result parsing (saveappointmentinfo, setappointmentstatusinfo) and transition-error detection');

  // ---------------------------------------------------------------- SaveAppointment
  {
    const unity = fakeUnity({
      [A.GET_APPOINTMENTS]: () => sched([{ Appointment_ID: '90001', Patient_ID: '51389', Appointment_DateTime: `${DAY} 10:00:00 AM`, Status: 'S', Resource_ID: '50', Appointment_Type_ID: '4', Duration: '30' }]),
    });
    const tools = new UnityAppointmentTools(unity);
    const r = await tools.saveAppointment({
      patientId: '51389', appointmentDate: DAY, appointmentTime: '10:00 AM', duration: 30, providerId: 'MARFEE',
      appointmentType: 'Office Visit', reasonForVisit: 'Follow-up', notes: 'Synthetic test',
    });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.appointmentId, '90001');
    assert.strictEqual(r.encounterNumber, '7001');
    assert.strictEqual(r.verified, true);
    assert.strictEqual(r.appointment?.status, 'Scheduled');
    const save = callsOf(A.SAVE_APPOINTMENT);
    assert.strictEqual(save.length, 1);
    assert.strictEqual(save[0].patientId, '51389');
    assert.strictEqual(save[0].target, 'PM');
    assert.deepStrictEqual(Object.keys(save[0].params), ['Parameter1']);
    assert.strictEqual(
      save[0].params.Parameter1,
      `<appt><appointmentDateTime>${DAY} 10:00</appointmentDateTime><appointmentDuration>30</appointmentDuration>` +
        '<appointmentType>OV</appointmentType><schedulingLocation>OFFICE</schedulingLocation><schedulingDepartment>HOSINP</schedulingDepartment>' +
        '<resource>MARFEE</resource><comments>Follow-up - Synthetic test</comments>' +
        '<schedulingLocationID>1</schedulingLocationID><schedulingDepartmentID>4</schedulingDepartmentID></appt>'
    );
    const avail = callsOf(A.GET_OPEN_SLOTS)[0];
    assert.deepStrictEqual([avail.params.Parameter1, avail.params.Parameter2], ['MARFEE', DAY], 'GetAvailableSchedule checked before saving');
    ok('save: <appt> XML from slot row + lookups (type name → OV, location OFFICE/1, department HOSINP/4), IDs parsed, read back');

    // Lookups are cached: a second booking does not re-read locations/departments/types/resources.
    calls.length = 0;
    await tools.saveAppointment({ patientId: '51389', appointmentDate: DAY, appointmentTime: '13:15', duration: 15, providerId: '50', appointmentType: 'OV30' });
    assert.strictEqual(callsOf(A.GET_SCHEDULING_LOCATIONS).length, 0);
    assert.strictEqual(callsOf(A.GET_SCHEDULING_DEPARTMENTS).length, 0);
    assert.strictEqual(callsOf(A.GET_APPOINTMENT_TYPES).length, 0);
    assert.match(callsOf(A.SAVE_APPOINTMENT)[0].params.Parameter1, /<schedulingDepartment>SURGI<\/schedulingDepartment>.*<schedulingDepartmentID>2<\/schedulingDepartmentID>/);
    assert.match(callsOf(A.SAVE_APPOINTMENT)[0].params.Parameter1, /<appointmentDateTime>\d\d\/\d\d\/\d{4} 13:15<\/appointmentDateTime><appointmentDuration>15<\/appointmentDuration><appointmentType>OV30<\/appointmentType>/);
    assert.match(callsOf(A.SAVE_APPOINTMENT)[0].params.Parameter1, /<comments>Scheduled by phone \(Drawbridge\)<\/comments>/);
    ok('save: 1-hour lookup cache; afternoon slot books the SURGI department; default comment');
  }

  {
    // Defaults: no type → the resource's Default_Appointment_Type_ID; no provider → usual provider.
    const unity = fakeUnity({
      [A.GET_APPOINTMENTS]: () => sched([{ Appointment_ID: '1', Patient_ID: '51389', Appointment_DateTime: '01/05/2026 9:00:00 AM', Status: 'C', Resource_ID: '50' }]),
    });
    const r = await new UnityAppointmentTools(unity).saveAppointment({ patientId: '51389', appointmentDate: DAY, appointmentTime: '11:00', duration: 15 });
    assert.strictEqual(r.success, true);
    assert.match(callsOf(A.SAVE_APPOINTMENT)[0].params.Parameter1, /<appointmentType>ACUTE<\/appointmentType>.*<resource>MARFEE<\/resource>/);
    assert.strictEqual(r.verified, false, 'new ID not on the read-back schedule');
    ok("save: defaults to the patient's usual provider and that provider's default appointment type");
  }

  {
    // The row abbreviation is used when the department lookup fails; the save still goes through.
    const unity = fakeUnity({ [A.GET_SCHEDULING_DEPARTMENTS]: () => ({ success: false, error: 'Magic Error - timeout' }) });
    const r = await new UnityAppointmentTools(unity).saveAppointment({ patientId: '51389', appointmentDate: DAY, appointmentTime: '10:00', duration: 15, providerId: 'MARFEE', appointmentType: 'OV' });
    assert.strictEqual(r.success, true);
    assert.match(callsOf(A.SAVE_APPOINTMENT)[0].params.Parameter1, /<schedulingDepartment>HOSINP<\/schedulingDepartment>/);
    ok('save: department abbreviation falls back to the GetAvailableSchedule row when the lookup fails');
  }

  {
    const cases: Array<[string, Record<string, Handler>, any, string, boolean]> = [
      ['Veradigm error', { [A.SAVE_APPOINTMENT]: () => ({ success: false, error: 'Magic Error - Action: SaveAppointment - Invalid scheduling location=blank' }) }, {}, 'API_ERROR', true],
      ['no Appointment_ID', { [A.SAVE_APPOINTMENT]: () => ok200([{ saveappointmentinfo: [{ Encounter_Number: '' }] }]) }, {}, 'API_ERROR', true],
      ['empty reply', { [A.SAVE_APPOINTMENT]: () => ok200([]) }, {}, 'API_ERROR', true],
      ['permission', { [A.SAVE_APPOINTMENT]: () => ({ success: false, error: 'Error: User does not have appropriate security setting (Sched.ApptSch)' }) }, {}, 'API_ERROR', true],
      ['booked time', {}, { appointmentTime: '10:30' }, 'VALIDATION_ERROR', false],
      ['outside template', {}, { appointmentTime: '16:00' }, 'VALIDATION_ERROR', false],
      ['unknown type', {}, { appointmentType: 'Brain surgery' }, 'VALIDATION_ERROR', false],
      ['wrong location', {}, { locationId: '12' }, 'VALIDATION_ERROR', false],
      ['wrong department', {}, { departmentId: 'SURGI' }, 'VALIDATION_ERROR', false],
      ['past time', {}, { appointmentDate: '01/05/2026' }, 'VALIDATION_ERROR', false],
      ['bad time', {}, { appointmentTime: 'noonish' }, 'VALIDATION_ERROR', false],
      ['availability read fails', { [A.GET_OPEN_SLOTS]: () => ({ success: false, error: 'Magic Error - boom' }) }, {}, 'API_ERROR', false],
    ];
    for (const [label, overrides, extra, code, saveCalled] of cases) {
      const unity = fakeUnity(overrides);
      const r = await run('unity_save_appointment', () =>
        new UnityAppointmentTools(unity).saveAppointment({ patientId: '51389', appointmentDate: DAY, appointmentTime: '10:00', duration: 15, providerId: 'MARFEE', appointmentType: 'OV', ...extra })
      );
      assert.strictEqual(r.success, false, `${label}: must fail`);
      assert.strictEqual(r.error_code, code, `${label}: ${r.error_code} ${r.message}`);
      assert.strictEqual(callsOf(A.SAVE_APPOINTMENT).length, saveCalled ? 1 : 0, `${label}: SaveAppointment calls`);
    }
    ok('save failures are explicit (Veradigm error, no ID, empty reply, permission, booked/closed time, bad input) and never retried');
  }

  // ---------------------------------------------------------------- SetAppointmentStatus
  const apptRow = (status: string, pid = '51389') => ({ Appointment_ID: '90001', Patient_ID: pid, Appointment_DateTime: `${DAY} 10:00:00 AM`, Status: status, Resource_ID: '50' });

  {
    // Scheduled → X refused as a transition → C → X.
    const statuses: string[] = [];
    const unity = fakeUnity({
      [A.GET_APPOINTMENTS]: () => sched([apptRow('S')]),
      [A.SET_APPOINTMENT_STATUS]: (p) => {
        statuses.push(p.Parameter2);
        if (statuses.length === 1) return ok200([{ setappointmentstatusinfo: [{ Status: 'Error: Appointment status cannot be changed from Scheduled to Canceled' }] }]);
        return statusOk();
      },
    });
    const r = await new UnityAppointmentTools(unity).cancelAppointment({ appointmentId: '90001', patientId: '51389', cancellationReason: 'patient cancelled' });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.confirmedFirst, true);
    assert.strictEqual(r.cancellationReasonId, '3');
    assert.deepStrictEqual(statuses, ['X', 'C', 'X']);
    const set = callsOf(A.SET_APPOINTMENT_STATUS);
    for (const c of set) {
      assert.strictEqual(c.params.Parameter1, '90001');
      assert.strictEqual(c.params.Parameter3, '');
      assert.match(c.params.Parameter4, /^\d{1,4}$/, 'P4 = HHMM integer');
      assert.ok(Number(c.params.Parameter4) % 100 < 60 && Number(c.params.Parameter4) < 2400);
      assert.strictEqual(c.params.Parameter5, '');
      assert.strictEqual(c.target, 'PM');
    }
    assert.deepStrictEqual(set.map((c) => c.params.Parameter6), ['3', '', '3'], 'P6 = cancellation reason ID on X only');
    ok('cancel: Scheduled → X refused as transition → C then X; P1 ID, P2 letter, P4 HHMM, P6 reason ID');
  }

  {
    // Confirmed → one X call; reason by abbreviation.
    const unity = fakeUnity({ [A.GET_APPOINTMENTS]: () => sched([apptRow('C')]) });
    const r = await new UnityAppointmentTools(unity).cancelAppointment({ appointmentId: '90001', patientId: '51389', cancellationReason: 'OFF CX' });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.confirmedFirst, undefined);
    assert.deepStrictEqual(callsOf(A.SET_APPOINTMENT_STATUS).map((c) => [c.params.Parameter2, c.params.Parameter6]), [['X', '4']]);
    ok('cancel: Confirmed → single X with the reason ID (matched by abbreviation)');
  }

  {
    // Unmatched reason → "Patient Cancelled"; already cancelled → no write; not this patient's → NOT_FOUND.
    let unity = fakeUnity({ [A.GET_APPOINTMENTS]: () => sched([apptRow('W')]) });
    let r: any = await new UnityAppointmentTools(unity).cancelAppointment({ appointmentId: '90001', patientId: '51389', cancellationReason: 'feeling better' });
    assert.strictEqual(r.cancellationReasonId, '3');
    unity = fakeUnity({ [A.GET_APPOINTMENTS]: () => sched([apptRow('X')]) });
    r = await new UnityAppointmentTools(unity).cancelAppointment({ appointmentId: '90001', patientId: '51389' });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.alreadyCancelled, true);
    assert.strictEqual(callsOf(A.SET_APPOINTMENT_STATUS).length, 0);
    unity = fakeUnity({ [A.GET_APPOINTMENTS]: () => sched([apptRow('S', '99999')]) });
    r = await run('unity_cancel_appointment', () => new UnityAppointmentTools(unity).cancelAppointment({ appointmentId: '90001', patientId: '51389' }));
    assert.strictEqual(r.error_code, 'NOT_FOUND');
    assert.strictEqual(callsOf(A.SET_APPOINTMENT_STATUS).length, 0);
    unity = fakeUnity({ [A.GET_APPOINTMENTS]: () => ({ success: false, error: 'Magic Error - down' }) });
    r = await run('unity_cancel_appointment', () => new UnityAppointmentTools(unity).cancelAppointment({ appointmentId: '90001', patientId: '51389' }));
    assert.strictEqual(r.success, false);
    assert.strictEqual(callsOf(A.SET_APPOINTMENT_STATUS).length, 0);
    ok("cancel: default reason, already cancelled (no write), another patient's visit or a failed read (no write)");
  }

  {
    const cases: Array<[string, Handler, string[]]> = [
      ['permission (no fallback)', () => ({ success: false, error: 'Magic Error - Action: SetAppointmentStatus - Error: User does not have appropriate security setting (Sched.ApptSch)' }), ['X']],
      ['status text error, not a transition', () => ok200([{ setappointmentstatusinfo: [{ Status: 'Invalid appointment id' }] }]), ['X']],
      ['empty reply', () => ok200([]), ['X']],
    ];
    for (const [label, handler, want] of cases) {
      const unity = fakeUnity({ [A.GET_APPOINTMENTS]: () => sched([apptRow('S')]), [A.SET_APPOINTMENT_STATUS]: handler });
      const r = await run('unity_cancel_appointment', () => new UnityAppointmentTools(unity).cancelAppointment({ appointmentId: '90001', patientId: '51389' }));
      assert.strictEqual(r.success, false, label);
      assert.deepStrictEqual(callsOf(A.SET_APPOINTMENT_STATUS).map((c) => c.params.Parameter2), want, label);
    }
    // Confirm-first works but the second cancel fails: failure that says the visit is now Confirmed.
    let n = 0;
    const unity = fakeUnity({
      [A.GET_APPOINTMENTS]: () => sched([apptRow('S')]),
      [A.SET_APPOINTMENT_STATUS]: (p) => (++n === 2 ? statusOk() : ok200([{ setappointmentstatusinfo: [{ Status: 'Status transition not allowed' }] }])),
    });
    const r = await run('unity_cancel_appointment', () => new UnityAppointmentTools(unity).cancelAppointment({ appointmentId: '90001', patientId: '51389' }));
    assert.strictEqual(r.success, false);
    assert.match(r.message, /now Confirmed but the cancel failed/);
    ok('cancel failures are explicit: permission, status text, empty reply, confirm-then-cancel half done');
  }

  {
    const unity = fakeUnity({ [A.GET_APPOINTMENTS]: () => sched([apptRow('S')]) });
    const r = await new UnityAppointmentTools(unity).confirmAppointment({ appointmentId: '90001', patientId: '51389', confirmationResult: 'patient notified' });
    assert.strictEqual(r.success, true);
    const set = callsOf(A.SET_APPOINTMENT_STATUS);
    assert.deepStrictEqual(set.map((c) => [c.params.Parameter1, c.params.Parameter2, c.params.Parameter5, c.params.Parameter6]), [['90001', 'C', '20', '']]);
    assert.match(set[0].params.Parameter4, /^\d{1,4}$/);

    const already = fakeUnity({ [A.GET_APPOINTMENTS]: () => sched([apptRow('C')]) });
    const r2 = await new UnityAppointmentTools(already).confirmAppointment({ appointmentId: '90001', patientId: '51389' });
    assert.strictEqual(r2.alreadyConfirmed, true);
    assert.strictEqual(callsOf(A.SET_APPOINTMENT_STATUS).length, 0);

    const refused = fakeUnity({
      [A.GET_APPOINTMENTS]: () => sched([apptRow('A')]),
      [A.SET_APPOINTMENT_STATUS]: () => ok200([{ setappointmentstatusinfo: [{ Status: 'Cannot change status from Acknowledged to Confirmed' }] }]),
    });
    const r3 = await run('unity_confirm_appointment', () => new UnityAppointmentTools(refused).confirmAppointment({ appointmentId: '90001', patientId: '51389' }));
    assert.strictEqual(r3.success, false);
    assert.strictEqual(r3.error_code, 'API_ERROR');
    ok('confirm: C with P5 confirmation result ID; already confirmed (no write); refusal is an explicit failure');
  }

  // ---------------------------------------------------------------- reads that feed the writes
  {
    const unity = fakeUnity();
    const reasons = await new UnityAppointmentTools(unity).getCancellationReasons();
    assert.deepStrictEqual(reasons.reasons[1], { id: '3', description: 'Patient Cancelled', abbreviation: 'PAT CX' });
    const slots = await new UnityAppointmentTools(unity).getOpenSlots({ startDate: DAY, endDate: DAY, providerId: 'MARFEE', maxPerDay: 0 });
    const at = (t: string) => slots.slots.find((s) => s.time === t);
    assert.deepStrictEqual([at('10:00 AM')?.locationId, at('10:00 AM')?.departmentId], ['1', '4']);
    assert.deepStrictEqual([at('1:00 PM')?.locationId, at('1:00 PM')?.departmentId], ['1', '2']);
    assert.ok(!at('10:30 AM'), 'booked');
    ok('cancellation reason IDs (Cancellation_Reason_ID); open slots carry location and department IDs');
  }

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
