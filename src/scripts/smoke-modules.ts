/**
 * Offline checks for the ENABLED_MODULES switch (src/platform/modules.ts):
 *  - unset or blank: every module registers, in the same order as before the setting existed
 *  - set: only the listed modules register (case and spaces ignored); their nav items and agent tools only
 *  - an unknown name throws a clear startup error and registers nothing
 *
 *   npm run smoke:modules
 */
for (const k of ['UNITY_APP_NAME', 'UNITY_SVC_USERNAME', 'UNITY_SVC_PASSWORD', 'UNITY_EHR_USERNAME', 'UNITY_EHR_PASSWORD']) {
  process.env[k] = process.env[k] || 'offline-smoke';
}
delete process.env.ENABLED_MODULES;

import assert from 'assert';
import { execFileSync } from 'child_process';
import * as path from 'path';

/** The registration order before ENABLED_MODULES existed (loadPlatformModules registered these, in this order). */
const BEFORE = ['oncall', 'scheduling', 'outreach', 'huddle', 'activity', 'intake', 'veradigm', 'compliance'];

async function main(): Promise<void> {
  const { enabledModules, loadPlatformModules, MODULE_NAMES } = await import('../platform/modules');
  const { platformModules, platformTools } = await import('../platform/registry');

  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`PASS ${label}`);
  };

  // 1. Unset or blank: everything, same order as before.
  assert.deepStrictEqual(MODULE_NAMES, BEFORE);
  for (const env of [{}, { ENABLED_MODULES: '' }, { ENABLED_MODULES: '   ' }] as NodeJS.ProcessEnv[]) {
    assert.deepStrictEqual(enabledModules(env).map((m) => m.name), BEFORE, JSON.stringify(env));
  }
  ok(`unset or blank → all ${BEFORE.length} modules in the original order`);

  // 2. Set: only the listed ones, in registration order, case and spaces ignored.
  assert.deepStrictEqual(enabledModules({ ENABLED_MODULES: ' Intake , activity,VERADIGM ' }).map((m) => m.name), ['activity', 'intake', 'veradigm']);
  assert.deepStrictEqual(enabledModules({ ENABLED_MODULES: 'compliance,compliance' }).map((m) => m.name), ['compliance']);
  ok('set → only the listed modules (case and spaces ignored, duplicates once)');

  // 3. Unknown name: clear error, nothing registered.
  assert.throws(
    () => loadPlatformModules({ ENABLED_MODULES: 'intake,fax-intake' }),
    (e: any) => /ENABLED_MODULES: unknown module name\(s\) "fax-intake"\. Known modules: oncall, scheduling, outreach, huddle, activity, intake, veradigm, compliance\./.test(e.message)
  );
  assert.strictEqual(platformModules().length, 0, 'nothing registered after the error');
  ok('unknown name → startup error naming it and listing the known modules; nothing registered');

  // 4. A real load with the switch set: registry, agent tools and nav follow it.
  const allTools = enabledModules({}).flatMap((m) => m.getTools?.() || []).map((t) => t.name);
  loadPlatformModules({ ENABLED_MODULES: 'intake,veradigm' });
  assert.deepStrictEqual(platformModules().map((m) => m.name), ['intake', 'veradigm']);
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

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error('FAIL', e?.message || e);
  process.exit(1);
});
