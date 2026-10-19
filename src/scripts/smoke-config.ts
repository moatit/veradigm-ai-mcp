/**
 * Offline checks for per-client configuration and retention:
 * CLINIC_NAME (no clinic name in code), intake scan/OCR intervals, the 2-minute Veradigm polling
 * floor, no sandbox fallback in production, and retention of call records / outreach jobs.
 *
 *   npm run smoke:config
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'drawbridge-config-'));
process.env.CALL_RECORDS_DIR = TMP;
for (const k of ['UNITY_APP_NAME', 'UNITY_SVC_USERNAME', 'UNITY_SVC_PASSWORD', 'UNITY_EHR_USERNAME', 'UNITY_EHR_PASSWORD']) {
  process.env[k] = process.env[k] || 'offline-smoke';
}
delete process.env.CLINIC_NAME;
delete process.env.INTAKE_PRACTICE_NAME;

import assert from 'assert';
import { spawnSync } from 'child_process';

async function main(): Promise<void> {
  const clinic = await import('../platform/clinic');
  const shell = await import('../platform/shell');
  const dialer = await import('../platform/modules/outreach/dialer');
  const folder = await import('../platform/modules/intake/folder');
  const pipeline = await import('../platform/modules/intake/pipeline');
  const observe = await import('../platform/modules/intake/observe');
  const { extractFields } = await import('../platform/modules/intake/extract');
  const { callRecords } = await import('../unity/oncall/call-records');
  const { outreachJobs } = await import('../platform/modules/outreach/store');
  const retention = await import('../platform/retention');

  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`PASS ${label}`);
  };

  // 1. CLINIC_NAME: one setting, no default clinic
  assert.strictEqual(clinic.clinicLabel(), 'Drawbridge');
  let html = shell.page('t', '<p>x</p>');
  assert.ok(html.includes('A MOATiT Service · Drawbridge') && !/Idaho|Kidney/.test(html));
  const job: any = { type: 'reminder', patient_first_name: 'Ann', appointment: null };
  assert.strictEqual(dialer.dynamicVariables(job).clinic_name, 'Drawbridge');
  const cover = 'FAX\nTo:     Sagebrush Kidney Care\nFrom:   Sawtooth Rapid Lab\nRE: results';
  process.env.CLINIC_NAME = 'Sagebrush Kidney Care';
  html = shell.page('t', '<p>x</p>');
  assert.ok(html.includes('A MOATiT Service · Sagebrush Kidney Care'));
  assert.strictEqual(dialer.dynamicVariables(job).clinic_name, 'Sagebrush Kidney Care');
  assert.notStrictEqual(extractFields('To: Sagebrush Kidney Care\nPractice: Sagebrush Kidney Care').sender?.value, 'Sagebrush Kidney Care', 'own practice never the sender');
  assert.strictEqual(extractFields(cover).sender?.value, 'Sawtooth Rapid Lab');
  process.env.CLINIC_NAME = '<b>x</b>';
  assert.ok(shell.page('t', '').includes('&lt;b&gt;x&lt;/b&gt;'), 'escaped');
  delete process.env.CLINIC_NAME;
  const literal: string[] = [];
  const walk = (d: string) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) {
        if (f !== 'scripts') walk(p);
      } else if (p.endsWith('.ts') && /['"`][^'"`\n]*(Idaho Kidney|\bIKI\b)/.test(fs.readFileSync(p, 'utf8'))) literal.push(p);
    }
  };
  walk(path.join(process.cwd(), 'src'));
  assert.deepStrictEqual(literal, [], 'client name in a string literal');
  ok('CLINIC_NAME drives the staff header, outreach clinic_name and intake\'s own-practice name; "Drawbridge" when unset; no client name in code strings');

  // 2. Intake intervals from env
  assert.strictEqual(folder.scanIntervalMs(), 30_000);
  assert.strictEqual(pipeline.ocrWaitMs(), 60_000);
  process.env.INTAKE_SCAN_INTERVAL_SEC = '90';
  process.env.INTAKE_OCR_WAIT_SEC = '120';
  assert.strictEqual(folder.scanIntervalMs(), 90_000);
  assert.strictEqual(pipeline.ocrWaitMs(), 120_000);
  process.env.INTAKE_SCAN_INTERVAL_SEC = '1';
  process.env.INTAKE_OCR_WAIT_SEC = 'x';
  assert.strictEqual(folder.scanIntervalMs(), 30_000, 'below the 5 s minimum → default');
  assert.strictEqual(pipeline.ocrWaitMs(), 60_000);
  delete process.env.INTAKE_SCAN_INTERVAL_SEC;
  delete process.env.INTAKE_OCR_WAIT_SEC;
  ok('INTAKE_SCAN_INTERVAL_SEC and INTAKE_OCR_WAIT_SEC configure the folder scan and OCR wait');

  // 3. Veradigm polling floor (2 minutes) for the filing observer
  const warns: string[] = [];
  const w = console.warn;
  console.warn = (m: string) => void warns.push(String(m));
  assert.strictEqual(observe.observeEveryMinutes(), 30);
  process.env.INTAKE_OBSERVE_EVERY_MIN = '1';
  assert.strictEqual(observe.observeEveryMinutes(), 2);
  process.env.INTAKE_OBSERVE_EVERY_MIN = '0.5';
  assert.strictEqual(observe.observeEveryMinutes(), 2);
  process.env.INTAKE_OBSERVE_EVERY_MIN = '5';
  assert.strictEqual(observe.observeEveryMinutes(), 5);
  console.warn = w;
  delete process.env.INTAKE_OBSERVE_EVERY_MIN;
  assert.strictEqual(warns.length, 1);
  assert.ok(/2-minute polling floor/.test(warns[0]));
  ok('Unity polling (INTAKE_OBSERVE_EVERY_MIN) clamped to Veradigm\'s 2-minute floor with one warning');

  // 4. Production refuses to start on sandbox defaults
  const tsNode = path.join(process.cwd(), 'node_modules', 'ts-node', 'dist', 'bin.js');
  const load = (env: Record<string, string>) =>
    spawnSync(process.execPath, [tsNode, '--transpile-only', '-e', "require('./src/unity/config/environment'); console.log('LOADED')"], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, UNITY_APP_NAME: 'a', UNITY_SVC_USERNAME: 'b', UNITY_SVC_PASSWORD: 'c', UNITY_EHR_USERNAME: 'd', UNITY_EHR_PASSWORD: 'e', ...env },
    });
  const prodMissing = load({ NODE_ENV: 'production', UNITY_UBIQUITY_ENDPOINT: 'https://unity.example.invalid/UnityService.svc' });
  assert.notStrictEqual(prodMissing.status, 0);
  assert.ok(/UNITY_UBIQUITY_ID_PM, UNITY_UBIQUITY_ID_EHR/.test(prodMissing.stderr), prodMissing.stderr.slice(-400));
  const prodSet = load({ NODE_ENV: 'production', UNITY_UBIQUITY_ENDPOINT: 'https://unity.example.invalid/UnityService.svc', UNITY_UBIQUITY_ID_PM: 'P:X^1^', UNITY_UBIQUITY_ID_EHR: 'E:X^1^' });
  assert.ok(prodSet.status === 0 && prodSet.stdout.includes('LOADED'), prodSet.stderr.slice(-400));
  const sandbox = load({ NODE_ENV: 'sandbox' });
  assert.ok(sandbox.status === 0 && sandbox.stdout.includes('LOADED'), 'sandbox keeps its defaults');
  const prodHttp = load({ NODE_ENV: 'production', UNITY_UBIQUITY_ENDPOINT: 'http://unity.example.invalid/UnityService.svc', UNITY_UBIQUITY_ID_PM: 'P:X^1^', UNITY_UBIQUITY_ID_EHR: 'E:X^1^' });
  assert.ok(prodHttp.status !== 0 && /must be an https:\/\/ URL/.test(prodHttp.stderr), 'production refuses a plain-HTTP Unity endpoint');
  const loadFhir = (env: Record<string, string>) =>
    spawnSync(process.execPath, [tsNode, '--transpile-only', '-e', "require('./src/config/environment'); console.log('LOADED')"], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CLIENT_ID: 'a', CLIENT_SECRET: 'b', ...env },
    });
  const fhirUrls = { FHIR_BASE_URL_PRODUCTION: 'https://f.example.invalid/FHIR', AUTH_URL_PRODUCTION: 'https://f.example.invalid/auth', TOKEN_URL_PRODUCTION: 'https://f.example.invalid/token' };
  assert.ok(loadFhir({ NODE_ENV: 'production', ...fhirUrls }).stdout.includes('LOADED'));
  const fhirHttp = loadFhir({ NODE_ENV: 'production', ...fhirUrls, TOKEN_URL_PRODUCTION: 'http://f.example.invalid/token' });
  assert.ok(fhirHttp.status !== 0 && /TOKEN_URL_PRODUCTION must be set to https/.test(fhirHttp.stderr), 'production refuses a plain-HTTP FHIR URL');
  assert.ok(loadFhir({ NODE_ENV: 'sandbox' }).stdout.includes('LOADED'));
  ok('NODE_ENV=production refuses to start without UNITY_UBIQUITY_ENDPOINT / _ID_PM / _ID_EHR (no sandbox fallback), or with a non-HTTPS Veradigm® URL');

  // 5. Retention: call records and outreach jobs
  const day = 86_400_000;
  callRecords.upsert('call_old', 'after_hours', { reason_verbatim: 'old' });
  callRecords.upsert('call_new', 'after_hours', { reason_verbatim: 'new' });
  const recFile = path.join(TMP, 'call-records.json');
  const rows = JSON.parse(fs.readFileSync(recFile, 'utf8'));
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(callRecords.prune(30, Date.now() + 31 * day), 2);
  callRecords.upsert('call_keep', 'after_hours', {});
  assert.strictEqual(callRecords.prune(30), 0);
  assert.ok(callRecords.get('call_keep') && !callRecords.get('call_old'));
  assert.ok(!fs.readFileSync(recFile, 'utf8').includes('call_old'), 'pruned from the file');
  const [j1] = outreachJobs.addMany([{ type: 'reminder', patient_id: '1', patient_first_name: 'A', phone: '+12085550100', dedupe_key: 'k1' } as any], 'smoke');
  outreachJobs.optOut('77');
  assert.strictEqual(outreachJobs.prune(30, Date.now() + 29 * day), 0);
  assert.strictEqual(outreachJobs.prune(30, Date.now() + 31 * day), 1);
  assert.ok(!outreachJobs.get(j1.id) && outreachJobs.isOptedOut('77'), 'jobs pruned, opt-out list kept');
  let runs = 0;
  const stop = retention.startDailyRetention('smoke', () => ++runs);
  await new Promise((r) => setTimeout(r, 20));
  stop();
  assert.strictEqual(runs, 1, 'runs at startup');
  process.env.CALL_RECORDS_RETENTION_DAYS = '7';
  assert.strictEqual(retention.retentionDaysFrom('CALL_RECORDS_RETENTION_DAYS'), 7);
  process.env.CALL_RECORDS_RETENTION_DAYS = '0';
  assert.strictEqual(retention.retentionDaysFrom('CALL_RECORDS_RETENTION_DAYS'), 30);
  delete process.env.CALL_RECORDS_RETENTION_DAYS;
  ok('retention: call records and outreach jobs older than CALL_RECORDS_/OUTREACH_RETENTION_DAYS (30) pruned at start and daily; opt-outs kept');

  console.log(`\n${passed} checks passed`);
}

main()
  .catch((e) => {
    console.log('FAIL', e?.message || e);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(TMP, { recursive: true, force: true }));
