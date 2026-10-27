/**
 * Offline smoke test for the scheduling / staff assistant module (no network, no credentials).
 * A fake Unity service stands in for Veradigm. Checks: the question parser, failures → structured
 * errors (never "no openings"), grouping by provider, screens, and the speakable messages.
 *
 *   npm run smoke:scheduling
 */
for (const k of ['UNITY_APP_NAME', 'UNITY_SVC_USERNAME', 'UNITY_SVC_PASSWORD', 'UNITY_EHR_USERNAME', 'UNITY_EHR_PASSWORD']) {
  process.env[k] = process.env[k] || 'offline-smoke';
}
process.env.CLINIC_TIMEZONE = 'America/Boise';

import assert from 'assert';

type Fake = (action: string, params: any, patientId: string, target: string) => any;

async function main(): Promise<void> {
  const { UnityActions } = await import('../unity/config/unity-endpoints');
  const { UnityAppointmentTools } = await import('../unity/tools/appointment.tools');
  const { toToolFailure } = await import('../unity/utils/tool-result');
  const { toVoiceSummary } = await import('../utils/response-formatter');
  const { createSchedulingModule } = await import('../platform/modules/scheduling');
  const { parseOpeningsQuestion, groupOpenings } = await import('../platform/modules/scheduling/openings');
  const { addDays, clinicToday, timeToMinutes, toMdy } = await import('../platform/modules/scheduling/dates');
  const { openingsPage, dayPage } = await import('../platform/modules/scheduling/screens');

  // Dates are relative to T, the first Thursday after the clinic's today, so the fake open slots are always in the
  // future (the open-slot lookup drops slots earlier than the clinic's current time). D(n) = T + n days as MM/DD/YYYY:
  // D(0) Thursday, D(1) Friday, D(4) next Monday, D(5) next Tuesday, D(6) next Wednesday, D(7) next Thursday.
  const T = addDays(clinicToday(), ((4 - clinicToday().getUTCDay() + 7) % 7) || 7);
  const D = (n: number): string => toMdy(addDays(T, n));
  const MD = (n: number): string => D(n).slice(0, 5);
  const ISO = (n: number): string => addDays(T, n).toISOString().slice(0, 10);
  const JAN5 = toMdy(new Date(Date.UTC(T.getUTCFullYear() + 1, 0, 5))); // "1/5" without a year: the next January 5

  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`PASS ${label}`);
  };

  // Fake platform: same contract as unity-test-server's executeTool (never throws; failures are structured).
  const calls: Array<{ action: string; params: any; patientId: string; target: string }> = [];
  const platform = (fake: Fake) => {
    calls.length = 0;
    const unity: any = {
      executeAction: async (action: string, params: any = {}, patientId = '', target = 'EHR') => {
        calls.push({ action, params, patientId, target });
        return fake(action, params, patientId, target);
      },
    };
    const mod = createSchedulingModule();
    const appt = new UnityAppointmentTools(unity);
    const own = new Set(mod.getTools!().map((t) => t.name));
    const deps: any = {
      unity,
      runTool: async (name: string, args: any, ctx: any = {}) => {
        try {
          if (own.has(name)) return await mod.run!(name, args, ctx);
          if (name === 'unity_get_open_slots') return await appt.getOpenSlots(args);
          throw new Error(`Unknown tool ${name}`);
        } catch (e) {
          return toToolFailure(e, name);
        }
      },
    };
    mod.start!(deps);
    return { mod, run: (name: string, args: any = {}) => deps.runTool(name, args) };
  };

  const PROVIDERS = [{ getresourcesinfo: [
    { Resource_ID: '101', Abbreviation: 'LEE', Description: 'Lee, Andrew MD', Practitioner_ID: '11', Resource_Type: 'Provider' },
    { Resource_ID: '102', Abbreviation: 'PATEL', Description: 'Dr. Priya Patel', Practitioner_ID: '12', Resource_Type: 'Provider' },
    { Resource_ID: '103', Abbreviation: 'LEEWON', Description: 'Lee-Wong, Grace NP', Practitioner_ID: '13', Resource_Type: 'Provider' },
  ] }];
  // GetAvailableSchedule: one row per day; Blocked_Slots1+2 = bookable template, Booked_Slots1+2 = booked,
  // 288 five-minute cells from midnight. Each opening below is one 15-minute window.
  const OPENINGS: Record<string, Array<[string, string]>> = {
    LEE: [[D(5), '09:00'], [D(5), '13:30'], [D(5), '15:45'], [D(7), '10:00']],
    PATEL: [[D(5), '13:00'], [D(5), '17:15'], [D(6), '14:00']],
    LEEWON: [],
  };
  const dayRows = (abbr: string) => {
    const byDay = new Map<string, string[]>();
    for (const [date, hhmm] of OPENINGS[abbr] || []) {
      const cells = byDay.get(date) || Array(288).fill('0');
      const start = (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))) / 5;
      for (let i = start; i < start + 3; i++) cells[i] = '1';
      byDay.set(date, cells);
    }
    return [...byDay].map(([date, cells]) => ({
      Available_Date: date, Resource_Abbreviation: abbr, Scheduling_Location_ID: '1',
      Blocked_Slots1: cells.slice(0, 144).join(''), Blocked_Slots2: cells.slice(144).join(''),
      Booked_Slots1: '0'.repeat(144), Booked_Slots2: '0'.repeat(144),
    }));
  };
  const healthy: Fake = (action, params) => {
    if (action === 'GetResources') return { success: true, data: PROVIDERS };
    if (action === UnityActions.Scheduling.GET_OPEN_SLOTS) return { success: true, data: [{ getavailablescheduleinfo: dayRows(params.Parameter1) }] };
    return { success: false, error: 'unexpected action' };
  };
  const failing: Fake = () => ({ success: false, error: 'Magic Error: service unavailable' });

  // ── 1. Question parser (today = Thursday T) ───────────────────────────────
  const today = T;
  const cases: Array<[string, Partial<{ startDate: string; endDate: string; partOfDay: string; providerTerms: string[]; dates: string[] }>]> = [
    ['Who has an opening Tuesday afternoon?', { startDate: D(5), endDate: D(5), partOfDay: 'afternoon', providerTerms: [] }],
    ['any openings for Dr. Lee next week morning', { startDate: D(4), endDate: D(8), partOfDay: 'morning', providerTerms: ['lee'] }],
    ['Anything open today?', { startDate: D(0), endDate: D(0), partOfDay: 'any' }],
    ['openings tomorrow a.m.', { startDate: D(1), endDate: D(1), partOfDay: 'morning' }],
    ['Does Dr Patel have anything next Wednesday p.m.?', { startDate: D(6), endDate: D(6), partOfDay: 'afternoon', providerTerms: ['patel'] }],
    ["Who's free this week?", { startDate: D(0), endDate: D(1), partOfDay: 'any', providerTerms: [] }],
    [`open slots on ${MD(12)}`, { startDate: D(12), endDate: D(12) }],
    ['Monday or Wednesday morning', { startDate: D(4), endDate: D(6), partOfDay: 'morning', dates: [D(4), D(6)] }],
    ['who has openings', { startDate: D(0), endDate: D(6), partOfDay: 'any', providerTerms: [] }],
    ['Friday after lunch for a follow up visit', { startDate: D(1), endDate: D(1), partOfDay: 'afternoon', providerTerms: [] }],
    ['Thursday', { startDate: D(0), endDate: D(0) }],
    ['Tuesday next week before noon', { startDate: D(5), endDate: D(5), partOfDay: 'morning' }],
    ['open slots 1/5', { startDate: JAN5, endDate: JAN5 }],
  ];
  for (const [question, want] of cases) {
    const got = parseOpeningsQuestion(question, today) as any;
    for (const [k, v] of Object.entries(want)) assert.deepStrictEqual(got[k], v, `"${question}" ${k}: got ${JSON.stringify(got[k])}`);
    ok(`parse "${question}" → ${got.startDate}-${got.endDate} ${got.partOfDay}${got.providerTerms.length ? ` [${got.providerTerms}]` : ''}`);
  }
  assert.strictEqual(timeToMinutes('1:30 PM'), 810);
  assert.strictEqual(timeToMinutes('12:15 AM'), 15);
  assert.strictEqual(timeToMinutes('2026-10-13T15:45:00'), 945);
  assert.strictEqual(timeToMinutes('0930'), 570);
  assert.strictEqual(timeToMinutes('9 am'), 540);
  assert.strictEqual(timeToMinutes('soon'), null);
  ok('time parsing (12h, 24h, ISO, military, "9 am")');

  // ── 2. Every Veradigm failure is a structured error, never an empty answer ──
  {
    const { run } = platform(failing);
    for (const [name, args] of [
      ['unity_get_day_schedule', { date: D(5) }],
      ['unity_get_providers', {}],
      ['unity_get_location_hours', {}],
      ['unity_get_changed_appointments', { since: D(-7) }],
      ['unity_get_patient_recalls', { patientId: '56500' }],
      ['drawbridge_find_openings', { question: 'Who has an opening Tuesday afternoon?', today: D(0) }],
      ['drawbridge_find_openings', { startDate: D(5), partOfDay: 'afternoon' }],
    ] as Array<[string, any]>) {
      const r = await run(name, args);
      assert.strictEqual(r.success, false, `${name} should fail`);
      assert.ok(r.error_code, `${name} needs error_code`);
      const text = toVoiceSummary(name, r);
      assert.ok(text.startsWith('TOOL_ERROR'), `${name} voice: ${text}`);
      assert.ok(!/no (openings|appointments|recalls|providers)/i.test(text), `${name} sounds empty: ${text}`);
      ok(`${name} failure → ${r.error_code}`);
    }
  }

  // Providers fine, open-slot lookup fails → failure (not "no openings")
  {
    const { run } = platform((a, p, pid, t) => (a === UnityActions.Scheduling.GET_OPEN_SLOTS ? failing(a, p, pid, t) : healthy(a, p, pid, t)));
    const r = await run('drawbridge_find_openings', { question: 'Who has an opening Tuesday afternoon?', today: D(0) });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.error_code, 'API_ERROR');
    assert.ok(!/no openings/i.test(toVoiceSummary('drawbridge_find_openings', r)));
    const html = openingsPage({ q: 'x', start: '', end: '', part: 'any', provider: '', providers: null, result: r, today: D(0) });
    assert.match(html, /Couldn't reach Veradigm® PM/);
    assert.ok(!/No openings/i.test(html), 'failure page must not say "No openings"');
    ok('open-slot failure → TOOL_ERROR and "Couldn\'t reach Veradigm® PM" banner, never "no openings"');
  }

  // Provider list fails and the question names "Dr. Lee" → failure (can't answer for everyone instead)
  {
    const { run } = platform((a, p, pid, t) => (a === 'GetResources' ? failing(a, p, pid, t) : healthy(a, p, pid, t)));
    const r = await run('drawbridge_find_openings', { question: 'any openings for Dr. Lee next week', today: D(0) });
    assert.strictEqual(r.success, false);
    assert.ok(r.error_code);
    const r2 = await run('drawbridge_find_openings', { question: 'Who has an opening Tuesday afternoon?', today: D(0) });
    assert.strictEqual(r2.success, false);
    assert.ok(r2.error_code);
    assert.ok(!/no openings/i.test(toVoiceSummary('drawbridge_find_openings', r2)));
    ok('provider list failure: both questions fail (open slots need the resource abbreviation), never "no openings"');
  }

  // ── 3. Grouping by provider ────────────────────────────────────────────────
  {
    const { run } = platform(healthy);
    const r = await run('drawbridge_find_openings', { question: 'Who has an opening Tuesday afternoon?', today: D(0) });
    assert.strictEqual(r.success, true, JSON.stringify(r));
    assert.strictEqual(r.total, 3, JSON.stringify(r.openings));
    assert.deepStrictEqual(
      r.openings.map((g: any) => [g.providerName, g.count, g.slots.map((s: any) => s.time)]),
      [
        ['Dr. Priya Patel', 1, ['1:00 PM']],
        ['Lee, Andrew MD', 2, ['1:30 PM', '3:45 PM']],
      ]
    );
    const voice = toVoiceSummary('drawbridge_find_openings', r);
    assert.strictEqual(voice, `3 openings Tuesday ${MD(5)} afternoon: Dr. Priya Patel has one at 1:00 PM; Lee, Andrew MD has 2, first at 1:30 PM.`);
    ok(`grouped by provider, morning/5:15 PM/other days excluded → "${voice}"`);

    const g = groupOpenings(
      [
        { date: '', time: `${D(5)} 9:00 AM`, providerId: '1' },
        { date: D(5), time: '', providerId: '1' },
      ],
      { partOfDay: 'morning' }
    );
    assert.strictEqual(g.groups[0].slots[0].date, D(5));
    assert.strictEqual(g.skippedNoTime, 1);
    ok('date taken from datetime field; slot without a time is counted, not silently dropped');

    const lee = await run('drawbridge_find_openings', { question: 'any openings for Dr. Lee next week morning', today: D(0) });
    assert.strictEqual(lee.success, true);
    assert.deepStrictEqual(lee.query.providerIds, ['101', '103']); // "Lee" and "Lee-Wong"
    assert.ok(lee.openings.every((x: any) => ['101', '103'].includes(x.providerId)));
    assert.deepStrictEqual(lee.openings.map((x: any) => x.slots.map((s: any) => s.date + ' ' + s.time)), [[`${D(5)} 9:00 AM`, `${D(7)} 10:00 AM`]]);
    ok(`provider match "Dr. Lee" → ${lee.message}`);

    const patel = await run('drawbridge_find_openings', { question: 'does dr patel have anything Wednesday', today: D(0) });
    const slotCall = calls.filter((c) => c.action === UnityActions.Scheduling.GET_OPEN_SLOTS).pop()!;
    assert.strictEqual(slotCall.params.Parameter1, 'PATEL', 'single provider passed to the slot lookup by abbreviation');
    assert.strictEqual(slotCall.params.Parameter3, D(7), 'end date + 1 (Veradigm end date is exclusive)');
    assert.strictEqual(patel.total, 1);
    ok('single matched provider is passed to the open-slot lookup');

    const nobody = await run('drawbridge_find_openings', { question: 'openings for Dr. Nobody Tuesday', today: D(0) });
    assert.strictEqual(nobody.success, false);
    assert.ok(!nobody.error_code, 'provider not found is not a Veradigm failure');
    assert.match(toVoiceSummary('drawbridge_find_openings', nobody), /couldn't find a provider named nobody/);
    ok('unknown provider → clarifying message (not an error, not "no openings")');

    const structured = await run('drawbridge_find_openings', { startDate: D(5), endDate: D(7), partOfDay: 'morning', providerId: '101' });
    assert.strictEqual(structured.total, 2);
    assert.strictEqual(structured.message, `2 openings ${D(5)} to ${D(7)} morning: Lee, Andrew MD has 2, first at Tuesday ${MD(5)} 9:00 AM.`);
    ok(`structured search → "${structured.message}"`);

    const bad = await run('drawbridge_find_openings', { startDate: '2026-10-13' });
    assert.strictEqual(bad.error_code, 'VALIDATION_ERROR');
    ok('bad structured date → VALIDATION_ERROR');

    const none = platform((a) =>
      a === UnityActions.Scheduling.GET_OPEN_SLOTS ? { success: true, data: [{ getavailablescheduleinfo: [] }] } : healthy(a, {}, '', 'PM')
    );
    const empty = await none.run('drawbridge_find_openings', { question: 'tomorrow morning', today: D(0) });
    assert.strictEqual(empty.success, true);
    assert.strictEqual(toVoiceSummary('drawbridge_find_openings', empty), 'No openings tomorrow morning.');
    ok('successful empty lookup → "No openings tomorrow morning."');

    const page = openingsPage({
      q: 'Who has an opening Tuesday afternoon?', start: '', end: '', part: 'any', provider: '',
      providers: [{ id: '9', name: '<script>alert(1)</script>', type: '' }], result: r, today: D(0),
    });
    assert.ok(!page.includes('<script>alert(1)'), 'provider names escaped');
    assert.match(page, /Lee, Andrew MD/);
    assert.ok(!/Unity|FHIR|MCP/.test(page), 'no internal names on the screen');
    ok('openings screen renders groups and escapes values');
  }

  // ── 4. Other reads ────────────────────────────────────────────────────────
  {
    const { run } = platform((a) =>
      a === 'GetSchedule'
        ? { success: true, data: [{ getscheduleinfo: [
            { apptid: '1', appttime: '1:00 PM', patientlastname: 'Test', patientfirstname: 'Alpha', resourcename: 'Dr. Lee', resourceid: '101', appttype: 'Follow-up', status: 'Scheduled' },
            { apptid: '2', appttime: '08:30', patientname: 'Test, Beta', resourcename: 'Dr. Patel', resourceid: '102', status: 'Arrived' },
            { apptid: '3', appttime: '9:00 AM', patientname: 'Test, Gamma', resourcename: 'Dr. Lee', resourceid: '101', status: 'Scheduled' },
          ] }] }
        : { success: false, error: 'x' }
    );
    const s = await run('unity_get_day_schedule', { date: D(5) });
    assert.deepStrictEqual(s.schedule.map((x: any) => x.appointmentId), ['2', '3', '1']);
    assert.strictEqual(s.schedule[2].patientName, 'Test, Alpha');
    const voice = toVoiceSummary('unity_get_day_schedule', s);
    assert.strictEqual(voice, `There are 3 appointments on ${D(5)}: Dr. Lee 2, Dr. Patel 1.`);
    assert.ok(!/Alpha|Beta|Gamma/.test(voice), 'no patient names in speech');
    assert.strictEqual(calls[0].params.Parameter1, D(5));
    const html = dayPage({ date: D(5), provider: '', providers: null, result: s });
    assert.match(html, /Test, Beta/);
    assert.match(html, /8:30 AM/);
    const failedHtml = dayPage({ date: D(5), provider: '', providers: null, result: toToolFailure(new Error('x'), 'unity_get_day_schedule') });
    assert.match(failedHtml, /Couldn't reach Veradigm® PM/);
    assert.ok(!/No appointments/.test(failedHtml));
    const bad = await run('unity_get_day_schedule', { date: 'Tuesday' });
    assert.strictEqual(bad.error_code, 'VALIDATION_ERROR');
    ok(`day schedule sorted by time, speech has counts only → "${voice}"`);
  }

  {
    process.env.CLINIC_HOURS = 'Mon-Fri 08:00-17:00';
    const { run } = platform((a, _p, _pid, target) => {
      assert.strictEqual(target, 'EHR');
      return { success: true, data: [{ getlocationinfo: [{ locationid: '1', locationname: 'Idaho Kidney Institute', address1: '100 Main St', city: 'Boise', state: 'ID', zip: '83702', phone: '208-555-0100' }] }] };
    });
    const r = await run('unity_get_location_hours');
    assert.strictEqual(r.hours, 'Mon-Fri 08:00-17:00');
    assert.strictEqual(r.hoursSource, 'clinic_config');
    assert.match(toVoiceSummary('unity_get_location_hours', r), /Idaho Kidney Institute, 100 Main St, Boise, ID 83702\. Phone 208-555-0100\. Hours are not listed.*08:00-17:00/);
    const withHours = platform(() => ({ success: true, data: [{ locationname: 'IKI', businesshours: 'Mon-Thu 7-5' }] }));
    const r2 = await withHours.run('unity_get_location_hours');
    assert.strictEqual(r2.hoursSource, 'veradigm');
    assert.match(r2.message, /Hours: Mon-Thu 7-5\./);
    ok('location hours: Veradigm hours used when present, CLINIC_HOURS fallback says so');
  }

  {
    const { run } = platform(() => ({ success: true, data: [{ getappointmentsbychangedttminfo: [
      { apptid: '1', apptdate: D(-1), status: 'No Show', changedttm: `${D(-1)} 5:00 PM` },
      { apptid: '2', apptdate: D(-1), status: 'No Show' },
      { apptid: '3', apptdate: D(0), status: 'Cancelled' },
    ] }] }));
    const r = await run('unity_get_changed_appointments', { since: D(-1) });
    assert.strictEqual(r.message, `3 appointments changed since ${D(-1)}: 2 no show, 1 cancelled.`);
    assert.strictEqual(calls[0].params.Parameter1, D(-1));
    ok(`changed appointments → "${r.message}"`);
  }

  {
    const { run } = platform((_a, _p, pid) => ({ success: true, data: [{ getrecallsinfo: [
      { recallid: '7', patientid: pid, recalltype: 'Annual labs', duedate: `${ISO(24)}T00:00:00` },
      { recallid: '8', patientid: '99999', recalltype: 'Someone else', duedate: D(25) },
    ] }] }));
    const r = await run('unity_get_patient_recalls', { patientId: '56500' });
    assert.strictEqual(r.total, 1);
    assert.strictEqual(r.recalls[0].dueDate, D(24));
    assert.ok(toVoiceSummary('unity_get_patient_recalls', r).startsWith(`1 recall on file: Annual labs due ${D(24)}.`));
    ok("recalls: other patients' rows dropped, due date normalized");
  }

  {
    const { run, mod } = platform(healthy);
    const r = await run('unity_get_providers');
    assert.strictEqual(r.total, 3);
    assert.strictEqual(r.providers[1].name, 'Dr. Priya Patel');
    assert.strictEqual(calls.length, 1, 'GetResources only, no fallback action');
    assert.deepStrictEqual(mod.writeTools, undefined, 'module is read only');
    ok('providers from GetResources only; module declares no write tools');
  }

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error('FAIL', e?.message || e);
  process.exit(1);
});
