/**
 * Call & Confirm demo server: the real staff screens (Call & Confirm, Huddle brief) on a synthetic clinic.
 * No Veradigm, no Retell, no phone calls, no real patients. Data lives in a fresh temp folder (CALL_RECORDS_DIR)
 * unless you set one. Listens on 127.0.0.1 only, on DEMO_PORT or a free port the OS picks.
 *
 *   npm run demo:outreach                       # prints the URL; Ctrl+C to stop
 *   npm run demo:outreach -- --warm             # also plays the 7 test calls and a simulated week
 *   npm run demo:outreach -- --dump out.json    # write the sample week + test calls as JSON, then exit
 *
 * The screen's clock is the next business day at 10:20 (DEMO_AT=YYYY-MM-DDTHH:MM to change it); the five
 * business days before it are simulated so attempts, results and the Unconfirmed list have history.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

for (const k of ['UNITY_APP_NAME', 'UNITY_SVC_USERNAME', 'UNITY_SVC_PASSWORD', 'UNITY_EHR_USERNAME', 'UNITY_EHR_PASSWORD']) {
  process.env[k] = process.env[k] || 'offline-demo';
}
process.env.CALL_RECORDS_DIR = process.env.CALL_RECORDS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'drawbridge-cc-demo-'));
process.env.CLINIC_TIMEZONE = process.env.CLINIC_TIMEZONE || 'America/Boise';
process.env.CLINIC_NAME = process.env.CLINIC_NAME || 'Demo Kidney Clinic';
process.env.CLINIC_CALLBACK_NUMBER = process.env.CLINIC_CALLBACK_NUMBER || '(208) 555-0100';

async function main(): Promise<void> {
  const express = (await import('express')).default;
  const { registerNav, shellRouter } = await import('../platform/shell');
  const { outreachRouter } = await import('../platform/modules/outreach/screen');
  const { huddleModule } = await import('../platform/modules/huddle');
  const { defaultSettings, saveSettings } = await import('../platform/modules/outreach/settings');
  const { syntheticClinic } = await import('../platform/modules/outreach/sim');
  const { simulateWeek, runTestCalls } = await import('../platform/modules/outreach/simulate');
  const { outreachJobs } = await import('../platform/modules/outreach/store');
  const { shiftCallingDays } = await import('../platform/modules/outreach/scheduler');
  const util = await import('../platform/modules/outreach/util');
  for (const k of ['RETELL_API_KEY', 'RETELL_OUTBOUND_AGENT_ID', 'RETELL_FROM_NUMBER', 'OUTBOUND_ENABLED', 'OUTBOUND_ALLOWLIST']) delete process.env[k];

  const settings = { ...defaultSettings(), enabled: true };
  saveSettings(settings);
  const m = String(process.env.DEMO_AT || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/);
  const day = m ? util.parseDate(m[1])! : shiftCallingDays(util.todayInClinic(), 1, settings);
  const demoNow = util.clinicDateTime(day, m ? +m[2] * 60 + +m[3] : 10 * 60 + 20);
  const start = shiftCallingDays(day, -3, settings);
  const sim = syntheticClinic({ seed: 20261026, start, settings });

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

  const dumpAt = process.argv.indexOf('--dump');
  if (dumpAt > 0) {
    const week = await quiet(() => simulateWeek({ start: day, settings }));
    const calls = await quiet(() => runTestCalls({ settings }));
    fs.writeFileSync(process.argv[dumpAt + 1], JSON.stringify({ week, calls }, null, 2));
    console.log(`wrote ${process.argv[dumpAt + 1]}`);
    return;
  }

  // History: the business days before the demo morning, into the screen's own (temp) store.
  await quiet(() => simulateWeek({ start, settings, store: outreachJobs, sim, days: 7, stopAt: demoNow }));

  // Huddle checks answered from fixed synthetic values (the brief's Veradigm® EHR lookups).
  const runTool = async (name: string) => {
    if (name === 'unity_get_account_balance') return { balance: 0 };
    if (name === 'unity_get_insurance_policy') return { policies: [{ carrier: 'Sample Health Plan' }] };
    if (name === 'unity_get_patient_allergies') return { allergies: [] };
    if (name === 'unity_get_patient_problems') return { problems: [] };
    return {};
  };
  const deps: any = { unity: sim, runTool };
  registerNav({ path: '', label: 'Overview', order: 0 });
  registerNav({ path: '/huddle', label: 'Huddle brief', order: 25 });
  registerNav({ path: '/outreach', label: 'Call & Confirm', order: 30 });
  const app = express();
  app.use((req: any, _res, next) => {
    req.drawbridgeUser = 'demo.staff';
    next();
  });
  app.use('/app', shellRouter());
  app.use('/app/outreach', express.urlencoded({ extended: false }), outreachRouter(deps, () => demoNow));
  app.use('/app/huddle', huddleModule.appRouter!(deps));
  const server = app.listen(Number(process.env.DEMO_PORT) || 0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  if (process.argv.includes('--warm')) {
    await quiet(async () => {
      await fetch(`${url}/app/outreach/simulate/calls`, { method: 'POST', redirect: 'manual' });
      await fetch(`${url}/app/outreach/simulate/week`, { method: 'POST', redirect: 'manual' });
    });
  }
  console.log(`DEMO_READY ${url}/app/outreach  (huddle: ${url}/app/huddle?date=${util.isoDate(day)})  data: ${process.env.CALL_RECORDS_DIR}`);
}

main().catch((e) => {
  console.error('demo failed', e?.stack || e);
  process.exitCode = 1;
});
