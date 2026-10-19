/**
 * Offline checks for the ENABLED_MODULES switch (src/platform/modules.ts):
 *  - unset or blank: every module registers, in the same order as before the setting existed
 *  - set: only the listed modules register (case and spaces ignored); their nav items and agent tools only
 *  - an unknown name throws a clear startup error and registers nothing
 *  - leaving out activity while the phone agent's webhook settings are present is refused
 *  - webhooks follow the switch: a module that is off answers its webhook with 503 + Retry-After (audit M2)
 *
 *   npm run smoke:modules
 */
for (const k of ['UNITY_APP_NAME', 'UNITY_SVC_USERNAME', 'UNITY_SVC_PASSWORD', 'UNITY_EHR_USERNAME', 'UNITY_EHR_PASSWORD']) {
  process.env[k] = process.env[k] || 'offline-smoke';
}
delete process.env.ENABLED_MODULES;
for (const k of ['RETELL_WEBHOOK_SECRET', 'RETELL_WEBHOOK_API_KEY', 'RETELL_API_KEY', 'MOATIT_FAX_WEBHOOK_SECRET']) delete process.env[k];

import assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';

// Webhook probes may write security events: keep every data file in a temp dir.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'drawbridge-modules-'));
process.env.AUDIT_DIR = TMP;
process.env.CALL_RECORDS_DIR = TMP;
process.env.INTAKE_DROP_DIR = path.join(TMP, 'inbox');

/** The registration order before ENABLED_MODULES existed (loadPlatformModules registered these, in this order). */
// 'staff' (Staff logins) is a core module: always on, whatever ENABLED_MODULES says.
const BEFORE = ['oncall', 'scheduling', 'outreach', 'huddle', 'activity', 'intake', 'veradigm', 'compliance', 'voice', 'staff'];

async function main(): Promise<void> {
  const { enabledModules, loadPlatformModules, moduleEnabled, mountModuleWebhooks, MODULE_NAMES } = await import('../platform/modules');
  const { platformModules, platformTools } = await import('../platform/registry');

  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`PASS ${label}`);
  };

  // 1. Unset or blank: everything, same order as before.
  // ENABLED_MODULES names: every module except the core ones, which can't be switched off.
  assert.deepStrictEqual(MODULE_NAMES, BEFORE.filter((n) => n !== 'staff'));
  for (const env of [{}, { ENABLED_MODULES: '' }, { ENABLED_MODULES: '   ' }] as NodeJS.ProcessEnv[]) {
    assert.deepStrictEqual(enabledModules(env).map((m) => m.name), BEFORE, JSON.stringify(env));
  }
  ok(`unset or blank → all ${BEFORE.length} modules in the original order`);

  // 2. Set: only the listed ones, in registration order, case and spaces ignored.
  assert.deepStrictEqual(enabledModules({ ENABLED_MODULES: ' Intake , activity,VERADIGM ' }).map((m) => m.name), ['activity', 'intake', 'veradigm', 'staff']);
  assert.deepStrictEqual(enabledModules({ ENABLED_MODULES: 'compliance,compliance' }).map((m) => m.name), ['compliance', 'staff']);
  ok('set → only the listed modules (case and spaces ignored, duplicates once)');

  // 3. Unknown name: clear error, nothing registered.
  assert.throws(
    () => loadPlatformModules({ ENABLED_MODULES: 'intake,fax-intake' }),
    (e: any) => /ENABLED_MODULES: unknown module name\(s\) "fax-intake"\. Known modules: oncall, scheduling, outreach, huddle, activity, intake, veradigm, compliance, voice./.test(e.message)
  );
  assert.strictEqual(platformModules().length, 0, 'nothing registered after the error');
  ok('unknown name → startup error naming it and listing the known modules; nothing registered');

  // 4. A real load with the switch set: registry, agent tools and nav follow it.
  const allTools = enabledModules({}).flatMap((m) => m.getTools?.() || []).map((t) => t.name);
  loadPlatformModules({ ENABLED_MODULES: 'intake,veradigm' });
  assert.deepStrictEqual(platformModules().map((m) => m.name), ['intake', 'veradigm', 'staff']);
  const tools = platformTools().map((t) => t.name);
  assert.ok(!tools.includes('drawbridge_find_openings') && !tools.includes('drawbridge_get_huddle_brief'), 'disabled modules add no agent tools');
  assert.ok(allTools.includes('drawbridge_find_openings'), 'the scheduling tool exists when every module is on');
  ok(`ENABLED_MODULES=intake,veradigm → only those register; scheduling and huddle tools gone (${tools.length} of ${allTools.length} module tools)`);

  // 5. A fresh process with the setting unset registers everything, as every running deployment does today.
  const root = path.join(__dirname, '..', '..');
  const env = { ...process.env };
  delete env.ENABLED_MODULES;
  const out = execFileSync(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', '-e', "require('./src/platform/modules').loadPlatformModules(); console.log(JSON.stringify(require('./src/platform/registry').platformModules().map((m) => m.name)))"],
    { cwd: root, env, encoding: 'utf8' }
  );
  assert.deepStrictEqual(JSON.parse(out.trim().split('\n').pop()!), BEFORE);
  ok('fresh process, ENABLED_MODULES unset → all modules register exactly as before');

  // 6. Leaving out activity while the phone agent's webhooks are configured is refused; without them it is allowed.
  assert.throws(() => enabledModules({ ENABLED_MODULES: 'intake,veradigm', RETELL_API_KEY: 'smoke-not-real' }), /leaves out "activity".*RETELL_API_KEY/);
  assert.throws(() => enabledModules({ ENABLED_MODULES: 'intake', RETELL_WEBHOOK_SECRET: 'smoke-not-real' }), /RETELL_WEBHOOK_SECRET/);
  assert.deepStrictEqual(enabledModules({ ENABLED_MODULES: 'activity,intake', RETELL_API_KEY: 'smoke-not-real' }).map((m) => m.name), ['activity', 'intake', 'staff']);
  assert.deepStrictEqual(enabledModules({ ENABLED_MODULES: 'intake,veradigm' }).map((m) => m.name), ['intake', 'veradigm', 'staff']);
  assert.ok(moduleEnabled('intake', {}) && moduleEnabled('activity', { ENABLED_MODULES: 'activity' }) && !moduleEnabled('intake', { ENABLED_MODULES: 'activity' }));
  ok('dropping activity while RETELL_* webhook settings are present → startup error; allowed on a server without the phone agent');

  // 7. Webhooks follow the switch: off → 503 + Retry-After (the sender retries); on or unset → the real handler.
  const express = (await import('express')).default;
  const OFF_BODY = 'Not available on this server.';
  const PATHS = ['/webhooks/retell', '/webhooks/retell-inbound', '/webhooks/moatit-fax'];
  const probe = async (env: NodeJS.ProcessEnv) => {
    const app = express();
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      mountModuleWebhooks(app, {}, env);
    } finally {
      console.warn = warn;
    }
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const out: Record<string, { status: number; retry: string | null; off: boolean }> = {};
    try {
      for (const p of PATHS) {
        const r = await fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        const body = await r.text();
        out[p] = { status: r.status, retry: r.headers.get('retry-after'), off: r.status === 503 && body === OFF_BODY };
      }
    } finally {
      server.close();
    }
    return out;
  };
  const unset = await probe({});
  assert.ok(PATHS.every((p) => !unset[p].off), `unset: every real webhook handler mounted ${JSON.stringify(unset)}`);
  const intakeOnly = await probe({ ENABLED_MODULES: 'intake' });
  for (const p of ['/webhooks/retell', '/webhooks/retell-inbound']) assert.ok(intakeOnly[p].off && intakeOnly[p].retry === '300', `${p} off: ${JSON.stringify(intakeOnly[p])}`);
  assert.ok(!intakeOnly['/webhooks/moatit-fax'].off, 'fax webhook stays mounted with intake on');
  const noIntake = await probe({ ENABLED_MODULES: 'activity,veradigm' });
  assert.ok(noIntake['/webhooks/moatit-fax'].off && noIntake['/webhooks/moatit-fax'].retry === '300', `fax off: ${JSON.stringify(noIntake['/webhooks/moatit-fax'])}`);
  assert.ok(!noIntake['/webhooks/retell'].off && !noIntake['/webhooks/retell-inbound'].off, 'phone webhooks stay mounted with activity on');
  ok('webhooks follow ENABLED_MODULES: off → 503 + Retry-After 300 (fax with intake off, both phone webhooks with activity off); unset → all real handlers');

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error('FAIL', e?.message || e);
  process.exit(1);
});
