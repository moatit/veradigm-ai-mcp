/**
 * Offline smoke test for the huddle module (no network, no credentials, fake Veradigm data only).
 * Checks: schedule parsing and flags, failed enrichment → "couldn't check" (never "none"),
 * GetSchedule failure → error, concurrency limit, time budget, cache, pre-visit checklist,
 * staff screen escaping, module registration.
 *
 *   npm run smoke:huddle
 */
for (const k of ['UNITY_APP_NAME', 'UNITY_SVC_USERNAME', 'UNITY_SVC_PASSWORD', 'UNITY_EHR_USERNAME', 'UNITY_EHR_PASSWORD']) {
  process.env[k] = process.env[k] || 'offline-smoke';
}
process.env.CLINIC_TIMEZONE = 'America/Boise';
delete process.env.PREVISIT_INSTRUCTIONS;

import assert from 'assert';

const DATE = '2026-10-08';
// 9:00 AM in Boise (MDT, UTC-6) on Oct 8, 2026
const T0 = Date.parse('2026-10-08T15:00:00Z');

const failure = (code: string) => ({ success: false, error_code: code, retryable: true, tool: 'x', message: 'fake failure' });

async function main(): Promise<void> {
  const { HuddleService, agentBrief, COULDNT_CHECK } = await import('../platform/modules/huddle/brief');
  const { previsitCheck, DEFAULT_ARRIVE } = await import('../platform/modules/huddle/previsit');
  const { renderHuddle, huddlePage } = await import('../platform/modules/huddle/screen');
  const { huddleModule, initHuddle } = await import('../platform/modules/huddle');
  const { toToolFailure } = await import('../unity/utils/tool-result');
  const { toVoiceSummary } = await import('../utils/response-formatter');
  const { esc } = await import('../platform/shell');

  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`PASS ${label}`);
  };

  // ---- Fakes -------------------------------------------------------------------------------
  const scheduleRows = [
    { patientid: '1001', patientname: 'Ana Test', appttime: '9:00 AM', apptdate: '10/08/2026', resourcename: 'Dr. Lee', appttype: 'New Patient', status: 'Scheduled', apptid: 'A1' },
    { patientid: '1002', patientname: 'Ben Test', appttime: '08:30', resourcename: 'Dr. Lee', appttype: 'Follow Up', apptid: 'A2' },
    { patientid: '1003', patientfirstname: '<script>x</script>', patientlastname: 'Cy', appttime: '10:15', resourcename: 'Dr. Patel', appttype: 'Labs', apptid: 'A3' },
    { patientid: '1002', patientname: 'Ben Test', appttime: '2:00 PM', resourcename: 'Dr. Patel', appttype: 'Follow Up', apptid: 'A4' },
    { patientid: '1004', patientname: 'Cancelled Person', appttime: '11:00', resourcename: 'Dr. Lee', status: 'Cancelled', apptid: 'A5' },
    { resourcename: 'Dr. Lee', appttime: '12:00', appttype: 'Lunch block' },
    { patientid: '1005', patientname: 'Other Day', apptdate: '10/09/2026', appttime: '09:00', resourcename: 'Dr. Lee', apptid: 'A6' },
  ];

  const unityCalls: Array<{ action: string; params: any; target: string }> = [];
  let scheduleMode: 'ok' | 'fail' | 'throw' = 'ok';
  const unity: any = {
    executeAction: async (action: string, params: any, _pid: string, target: string) => {
      unityCalls.push({ action, params, target });
      if (scheduleMode === 'fail') return { success: false, error: 'Magic Error: unknown action' };
      if (scheduleMode === 'throw') {
        const e: any = new Error('connect ECONNREFUSED');
        e.name = 'UnityAPIError';
        e.code = 'NETWORK_ERROR';
        throw e;
      }
      return { success: true, data: [{ getscheduleinfo: scheduleRows }] };
    },
  };

  let inFlight = 0;
  let maxInFlight = 0;
  const toolCalls: string[] = [];
  const answers: Record<string, Record<string, () => any>> = {
    unity_get_account_balance: {
      '1001': () => ({ success: true, balance: 40, voucherCount: 1, message: 'x' }),
      '1002': () => ({ success: true, balance: 0, voucherCount: 0, message: 'x' }),
      '1003': () => failure('NETWORK_ERROR'),
    },
    unity_get_insurance_policy: {
      '1001': () => ({ success: true, policies: [], total: 0, message: 'x' }),
      '1002': () => ({ success: true, policies: [{ order: '1', carrier: 'Blue Cross', plan: 'PPO', memberIdLast4: '1234' }], total: 1, message: 'x' }),
      '1003': () => {
        throw new Error('boom');
      },
    },
    unity_get_patient_allergies: {
      '1001': () => ({ success: true, allergies: [{ allergen: 'Penicillin' }, { allergen: 'Latex' }], total: 2, message: 'x' }),
      '1002': () => ({ success: true, allergies: [], total: 0, message: 'x' }),
      '1003': () => ({ success: true, allergies: [], total: 0, message: 'x' }),
    },
    unity_get_patient_problems: {
      '1001': () => ({ success: true, problems: [], total: 0, message: 'x' }),
      '1002': () => ({ success: true, problems: [{ description: 'CKD stage 3' }], total: 1, message: 'x' }),
      '1003': () => failure('TIMEOUT_ERROR'),
    },
  };
  const runTool = async (name: string, args: any) => {
    toolCalls.push(name);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 5));
      const fn = answers[name]?.[args.patientId];
      if (!fn) return failure('NOT_FOUND');
      return fn();
    } finally {
      inFlight--;
    }
  };

  let clock = T0;
  const now = () => clock;
  const deps: any = { unity, runTool };

  // ---- 1. Brief: parsing, flags, summary, concurrency ---------------------------------------
  const service = new HuddleService(deps, { now });
  const brief = await service.getBrief(DATE);
  assert.strictEqual(unityCalls.length, 1);
  assert.strictEqual(unityCalls[0].action, 'GetSchedule');
  assert.strictEqual(unityCalls[0].params.Parameter1, '10/08/2026');
  assert.strictEqual(unityCalls[0].target, 'PM');
  ok('GetSchedule called on Veradigm PM with Parameter1 = 10/08/2026');

  const s = brief.summary;
  assert.deepStrictEqual(
    [s.visits, s.providers, s.patients, s.balancesDue, s.missingInsurance, s.allergiesOnFile, s.newPatients, s.failedChecks, s.patientsWithFailedChecks],
    [4, 2, 3, 1, 1, 1, 1, 3, 1]
  );
  ok('summary: 4 visits, 2 providers, 1 balance due, 1 missing insurance, 3 failed checks (cancelled/blocks/other-day rows dropped)');

  assert.strictEqual(toolCalls.length, 12, 'one enrichment per patient (patient with two visits checked once)');
  assert.ok(maxInFlight <= 4 && maxInFlight >= 2, `max in flight ${maxInFlight}`);
  ok(`12 enrichment calls, at most ${maxInFlight} in flight (limit 4)`);

  assert.deepStrictEqual(brief.providers.map((p) => p.name), ['Dr. Lee', 'Dr. Patel']);
  assert.deepStrictEqual(brief.providers[0].visits.map((v) => v.time), ['8:30 AM', '9:00 AM']);
  assert.deepStrictEqual(brief.providers[1].visits.map((v) => v.time), ['10:15 AM', '2:00 PM']);
  ok('grouped by provider, sorted by time');

  const visit = (pid: string) => brief.providers.flatMap((p) => p.visits).find((v) => v.patientId === pid)!;
  const keys = (pid: string) => visit(pid).flags.map((f) => f.key);
  assert.deepStrictEqual(keys('1001'), ['new_patient', 'balance_due', 'no_insurance', 'allergies']);
  assert.ok(visit('1001').flags.find((f) => f.key === 'balance_due')!.label.includes('$40.00'));
  assert.deepStrictEqual(keys('1002'), []);
  ok('flags: new patient, balance due $40.00, no insurance, allergies on file');

  // ---- 2. Failed enrichment is "couldn't check", never "none" -------------------------------
  const p3 = visit('1003');
  assert.deepStrictEqual(keys('1003'), ['balance_failed', 'insurance_failed', 'problems_failed']);
  assert.ok(!p3.balance.ok && !p3.insurance.ok && !p3.problems.ok && p3.allergies.ok);
  assert.ok(!keys('1003').includes('no_insurance'));
  assert.ok(p3.flags.every((f) => !/none|no insurance/i.test(f.label)));
  ok('failed balance/insurance/problems flagged "couldn\'t check", not "no insurance"');

  const html = renderHuddle({ dateKey: DATE, brief, user: 'staff' });
  const row = html.split('<tr>').find((r) => r.includes(esc('<script>x</script>')))!;
  assert.ok(row, 'escaped patient row present');
  assert.ok(!html.includes('<script>x</script>'), 'patient name is escaped');
  const cells = row.split('<td').slice(1);
  assert.match(cells[3], /couldn&#39;t check/); // balance
  assert.match(cells[4], /couldn&#39;t check/); // insurance
  assert.match(cells[5], /None on file/); // allergies succeeded and empty
  assert.match(cells[6], /couldn&#39;t check/); // problems
  assert.ok(!/None/.test(cells[4]) && !/None/.test(cells[3]));
  assert.ok(html.includes('@media print') && html.includes('Huddle brief'));
  ok('staff screen: failed cells say "couldn\'t check", values escaped, print CSS present');

  // ---- 3. Agent brief (staff only): counts, no patient names --------------------------------
  initHuddle(deps, { now });
  const ab = await huddleModule.run!('drawbridge_get_huddle_brief', { date: DATE }, {});
  assert.strictEqual(ab.success, true);
  assert.match(ab.message, /4 visits with 2 providers/);
  assert.match(ab.message, /couldn't be completed/);
  assert.ok(!/Ana|Ben|Cy|1001/.test(JSON.stringify(ab.providerLines) + ab.message), 'no patient names/IDs');
  assert.match(ab.providerLines[0], /^Dr\. Lee: 2 visits, first at 8:30 AM, 1 with a balance due, 1 with no insurance on file$/);
  assert.ok(ab.message.length <= 520);
  assert.strictEqual(toVoiceSummary('drawbridge_get_huddle_brief', ab), ab.message);
  ok(`agent brief: "${ab.message}"`);

  // ---- 4. GetSchedule failure → error, never an empty day -----------------------------------
  scheduleMode = 'fail';
  const failSvc = new HuddleService(deps, { now });
  await assert.rejects(failSvc.getBrief(DATE), (e: any) => e.code === 'API_ERROR');
  const before = unityCalls.length;
  await assert.rejects(failSvc.getBrief(DATE));
  assert.strictEqual(unityCalls.length, before + 1, 'failures are not cached');
  scheduleMode = 'throw';
  await assert.rejects(failSvc.getBrief(DATE), (e: any) => e.code === 'NETWORK_ERROR');
  const toolFail = await huddleModule.run!('drawbridge_get_huddle_brief', { date: '2026-10-09' }, {}).catch((e) =>
    toToolFailure(e, 'drawbridge_get_huddle_brief')
  );
  assert.strictEqual(toolFail.success, false);
  assert.strictEqual(toolFail.error_code, 'NETWORK_ERROR');
  assert.ok(toVoiceSummary('drawbridge_get_huddle_brief', toolFail).startsWith('TOOL_ERROR'));
  const errHtml = await huddlePage(failSvc, { date: DATE }, 'staff');
  assert.ok(errHtml.includes("Couldn't reach Veradigm® PM"));
  assert.ok(!errHtml.includes('No visits on the schedule'));
  scheduleMode = 'ok';
  ok('GetSchedule failure → error (API_ERROR / NETWORK_ERROR), banner on screen, not cached');

  // ---- 5. Cache ----------------------------------------------------------------------------
  const goodTool = async (name: string) => {
    toolCalls.push(name);
    if (name === 'unity_get_account_balance') return { success: true, balance: 0, message: 'x' };
    if (name === 'unity_get_insurance_policy') return { success: true, policies: [{ carrier: 'Aetna' }], message: 'x' };
    if (name === 'unity_get_patient_allergies') return { success: true, allergies: [], message: 'x' };
    return { success: true, problems: [], message: 'x' };
  };
  const cacheSvc = new HuddleService({ unity, runTool: goodTool } as any, { now });
  const n0 = unityCalls.length;
  const c1 = await cacheSvc.getBrief(DATE);
  assert.strictEqual(c1.fromCache, false);
  clock += 9 * 60_000;
  const c2 = await cacheSvc.getBrief(DATE);
  assert.strictEqual(c2.fromCache, true);
  assert.strictEqual(unityCalls.length, n0 + 1);
  await cacheSvc.getBrief('2026-10-09');
  assert.strictEqual(unityCalls.length, n0 + 2, 'cache is per date');
  await cacheSvc.getBrief(DATE, { refresh: true });
  assert.strictEqual(unityCalls.length, n0 + 3, 'refresh bypasses cache');
  clock += 10 * 60_000 + 1;
  const c3 = await cacheSvc.getBrief(DATE);
  assert.strictEqual(c3.fromCache, false);
  assert.strictEqual(unityCalls.length, n0 + 4, 'expires after 10 minutes');
  const [d1, d2] = await Promise.all([cacheSvc.getBrief('2026-10-12'), cacheSvc.getBrief('2026-10-12')]);
  assert.strictEqual(unityCalls.length, n0 + 5, 'concurrent requests share one build');
  assert.strictEqual(d1, d2);
  ok('cache: 10 minutes per date, refresh bypasses, concurrent requests share one build');

  // Briefs with failed checks are kept only briefly
  clock = T0;
  const shortSvc = new HuddleService(deps, { now });
  await shortSvc.getBrief(DATE);
  clock += 61_000;
  const n1 = unityCalls.length;
  await shortSvc.getBrief(DATE);
  assert.strictEqual(unityCalls.length, n1 + 1);
  ok('brief with failed checks cached 1 minute only');

  // ---- 6. Time budget ----------------------------------------------------------------------
  const slowTool = () => new Promise((r) => setTimeout(() => r({ success: true, balance: 1 }), 400));
  const slowSvc = new HuddleService({ unity, runTool: slowTool } as any, { budgetMs: 40 });
  const t = Date.now();
  const slow = await slowSvc.getBrief(DATE);
  assert.ok(Date.now() - t < 350, 'budget stops waiting');
  assert.strictEqual(slow.timedOut, true);
  assert.strictEqual(slow.summary.failedChecks, 12);
  assert.ok(slow.providers.flatMap((p) => p.visits).every((v) => !v.balance.ok && v.flags.some((f) => f.label.includes(COULDNT_CHECK))));
  assert.strictEqual(slow.summary.missingInsurance, 0, 'timed-out insurance is not "missing"');
  ok('time budget: unfinished checks → "couldn\'t check", timedOut flag set');

  // ---- 7. Bad date --------------------------------------------------------------------------
  await assert.rejects(service.getBrief('13/45/2026'), (e: any) => e.code === 'VALIDATION_ERROR');
  assert.strictEqual(service.dateKey('tomorrow'), '2026-10-09');
  assert.strictEqual(service.dateKey(''), '2026-10-08');
  ok('dates: default today in clinic timezone, tomorrow, invalid → VALIDATION_ERROR');

  // ---- 8. Pre-visit checklist ---------------------------------------------------------------
  clock = T0;
  let insMode: 'ok' | 'fail' | 'none' = 'ok';
  let apptMode: 'ok' | 'fail' | 'none' = 'ok';
  const pvTool = async (name: string, args: any) => {
    assert.strictEqual(args.patientId, '1002');
    if (name === 'unity_get_patient_appointments') {
      if (apptMode === 'fail') return failure('SERVER_ERROR');
      if (apptMode === 'none') return { success: true, appointments: [{ id: 'old', date: '10/01/2026', time: '09:00' }], total: 1 };
      return {
        appointments: [
          { id: '8000', date: '10/01/2026', time: '09:00', providerName: 'Dr. Old', status: 'Completed' },
          { id: '9100', date: '10/20/2026', time: '10:00', providerName: 'Dr. Patel', status: 'Scheduled' },
          { id: '9001', date: '10/13/2026', time: '09:00', providerName: 'Dr. Lee', status: 'Scheduled', locationName: 'Meridian' },
          { id: '9002', date: '10/10/2026', time: '09:00', providerName: 'Dr. Lee', status: 'Cancelled' },
          { id: '9003', date: '10/08/2026', time: '08:00', providerName: 'Dr. Lee', status: 'Scheduled' }, // earlier today, already past
        ],
        total: 5,
      };
    }
    if (name === 'unity_get_insurance_policy') {
      if (insMode === 'fail') return failure('NETWORK_ERROR');
      if (insMode === 'none') return { success: true, policies: [], total: 0, message: 'x' };
      return { success: true, policies: [{ order: '1', carrier: 'Blue Cross', plan: 'PPO', memberIdLast4: '1234' }], total: 1, message: 'x' };
    }
    if (name === 'unity_get_account_balance') return { success: true, balance: 40, message: 'x' };
    throw new Error(`unexpected tool ${name}`);
  };
  const pvDeps: any = { unity, runTool: pvTool };

  const pv = await previsitCheck(pvDeps, '1002', { now });
  assert.strictEqual(pv.success, true);
  assert.strictEqual(pv.nextVisit?.appointmentId, '9001');
  assert.deepStrictEqual(pv.checklist.map((c) => c.item), ['appointment', 'insurance', 'balance', 'bring', 'arrive']);
  assert.match(pv.message, /Tuesday, October 13 at 9:00 AM with Dr\. Lee at Meridian/);
  assert.match(pv.message, /Blue Cross on file, member ID ending in 1 2 3 4/);
  assert.match(pv.message, /\$40\.00/);
  assert.match(pv.message, /medications and a photo ID/);
  assert.ok(pv.message.includes(DEFAULT_ARRIVE));
  assert.ok(pv.message.length <= 520, `message length ${pv.message.length}`);
  assert.strictEqual(toVoiceSummary('drawbridge_previsit_check', pv), pv.message);
  ok(`previsit checklist: "${pv.message}"`);

  insMode = 'fail';
  process.env.PREVISIT_INSTRUCTIONS = 'Please arrive 20 minutes early and park in the north lot.';
  const pvFail = await previsitCheck(pvDeps, '1002', { now });
  const insItem = pvFail.checklist.find((c) => c.item === 'insurance')!;
  assert.strictEqual(insItem.status, 'unknown');
  assert.match(insItem.text, /couldn't check/);
  assert.ok(!/don't have insurance/i.test(pvFail.message));
  assert.match(pvFail.message, /20 minutes early/);
  delete process.env.PREVISIT_INSTRUCTIONS;
  insMode = 'none';
  const pvNone = await previsitCheck(pvDeps, '1002', { now });
  assert.strictEqual(pvNone.checklist.find((c) => c.item === 'insurance')!.status, 'action');
  ok('previsit: failed insurance → "couldn\'t check" (not "no insurance"); PREVISIT_INSTRUCTIONS used');

  apptMode = 'none';
  const pvNo = await previsitCheck(pvDeps, '1002', { now });
  assert.strictEqual(pvNo.hasUpcomingVisit, false);
  assert.strictEqual(pvNo.checklist.length, 0);
  apptMode = 'fail';
  await assert.rejects(previsitCheck(pvDeps, '1002', { now }), (e: any) => e.code === 'SERVER_ERROR');
  await assert.rejects(previsitCheck(pvDeps, '', { now }), (e: any) => e.code === 'VALIDATION_ERROR');
  ok('previsit: no upcoming visit is a real answer; appointment lookup failure throws SERVER_ERROR');

  // ---- 9. Registration -----------------------------------------------------------------------
  const { loadPlatformModules } = await import('../platform/modules');
  const { platformModules, platformTools, moduleForTool, platformWriteTools } = await import('../platform/registry');
  loadPlatformModules();
  const mod = platformModules().find((m) => m.name === 'huddle')!;
  assert.deepStrictEqual(mod.nav, { path: '/huddle', label: 'Huddle brief', order: 25 });
  const names = platformTools().map((t) => t.name);
  assert.ok(names.includes('drawbridge_previsit_check') && names.includes('drawbridge_get_huddle_brief'));
  assert.strictEqual(moduleForTool('drawbridge_previsit_check')?.name, 'huddle');
  assert.ok(!platformWriteTools().some((n) => n.startsWith('drawbridge_previsit') || n.includes('huddle')));
  const desc = platformTools().find((t) => t.name === 'drawbridge_get_huddle_brief')!.description || '';
  assert.match(desc, /STAFF ONLY/);
  assert.match(platformTools().find((t) => t.name === 'drawbridge_previsit_check')!.description || '', /verified/);
  ok('module registered: nav "Huddle brief" (25), two read-only drawbridge_ tools');

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error('FAIL', e?.message || e);
  process.exit(1);
});
