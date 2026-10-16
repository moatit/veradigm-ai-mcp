/**
 * Offline checks for endpoint auth on both HTTP servers (no Veradigm call: every upstream URL points
 * at 127.0.0.1:1, which refuses connections). Starts src/test-server.ts and
 * src/unity/unity-test-server.ts as child processes on free local ports.
 *
 *  - tool, test, patient-data and diagnostics routes fail closed (503) without DRAWBRIDGE_TOOL_KEY,
 *    401 with a wrong key, pass with the right key
 *  - /health is open and reveals no endpoint, app name or environment
 *  - CORS: no Access-Control-Allow-Origin unless the origin is in DRAWBRIDGE_CORS_ORIGINS
 *  - a rejected key is a security event in the audit log; the FHIR REST/test routes are audited and are off in
 *    production; staff-only tools are not offered to (and refused for) the phone agent
 *
 *   npm run smoke:endpoints
 */
import assert from 'assert';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const KEY = 'smoke-tool-key-0123456789';
const DEAD = 'http://127.0.0.1:1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'drawbridge-endpoints-'));

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

const baseEnv = (extra: Record<string, string | undefined>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(env, {
    NODE_ENV: 'sandbox',
    CALL_RECORDS_DIR: TMP,
    AUDIT_DIR: TMP,
    // FHIR
    CLIENT_ID: 'smoke',
    CLIENT_SECRET: 'smoke-secret',
    FHIR_BASE_URL_SANDBOX: `${DEAD}/fhir`,
    AUTH_URL_SANDBOX: `${DEAD}/auth`,
    TOKEN_URL_SANDBOX: `${DEAD}/token`,
    // Unity
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
  });
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
};

async function start(script: string, portVar: string, extra: Record<string, string | undefined>): Promise<{ url: string; proc: ChildProcess; out: () => string }> {
  const port = await freePort();
  const tsNode = path.join(process.cwd(), 'node_modules', 'ts-node', 'dist', 'bin.js');
  const proc = spawn(process.execPath, [tsNode, '--transpile-only', script], {
    cwd: process.cwd(),
    env: baseEnv({ ...extra, [portVar]: String(port), MCP_SERVER_HOST: '127.0.0.1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return { url, proc, out: () => out };
    } catch {
      // not up yet
    }
    if (proc.exitCode !== null) throw new Error(`${script} exited: ${out.slice(-800)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  throw new Error(`${script} did not start: ${out.slice(-800)}`);
}

/** Every audit line written so far under TMP/audit. */
function auditLines(): any[] {
  const dir = path.join(TMP, 'audit');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n'))
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}
const settle = () => new Promise((r) => setTimeout(r, 400));

async function main(): Promise<void> {
  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`PASS ${label}`);
  };
  const procs: ChildProcess[] = [];
  // ---- No credentials in committed Postman files (launch audit 2026-10-16) ----
  {
    const dir = path.join(process.cwd(), 'postman');
    const files: string[] = [];
    const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.json') && files.push(path.join(d, e.name))));
    if (fs.existsSync(dir)) walk(dir);
    const placeholder = (v: string) => v === '' || /^\{\{[\w.-]+\}\}$/.test(v) || /^<[^>]*>$/.test(v) || /^set-|^your[_-]|change-?me/i.test(v);
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      const rel = path.relative(process.cwd(), f);
      for (const m of text.matchAll(/"key":\s*"(x-auth-key|x-api-key|authorization|client_secret|clientsecret|password|api_key|apikey|access_token|token)",\s*"value":\s*"([^"]*)"/gi)) {
        const v = m[2].replace(/^(Bearer|Basic)\s+/i, '');
        assert.ok(placeholder(v), `${rel}: ${m[1]} has a literal value (${v.slice(0, 4)}***)`);
      }
      assert.ok(!/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(text), `${rel}: contains a JWT`);
    }
    ok(`postman: ${files.length} file(s), every key/secret/password/token header or variable is a placeholder, no JWTs`);
  }
  try {
    // ---- FHIR server, key unset: fails closed ----
    let fhir = await start('src/test-server.ts', 'MCP_SERVER_PORT', { DRAWBRIDGE_TOOL_KEY: undefined, DRAWBRIDGE_CORS_ORIGINS: undefined });
    procs.push(fhir.proc);
    const fhirRoutes: Array<[string, string]> = [
      ['POST', '/'],
      ['POST', '/mcp/tools/call'],
      ['POST', '/mcp/tools/list'],
      ['POST', '/tools/call'],
      ['POST', '/tools/list'],
      ['GET', '/tools'],
      ['POST', '/test/search-patient'],
      ['GET', '/test/auth'],
      ['GET', '/api/patient/123'],
      ['POST', '/api/patient/search'],
      ['GET', '/api/medication?patientId=123'],
      ['GET', '/api/clinical/allergies?patientId=123'],
      ['GET', '/api/appointment?patientId=123'],
      ['POST', '/api/retell'],
    ];
    const call = (base: string, method: string, p: string, headers: Record<string, string> = {}) =>
      fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'POST' ? '{}' : undefined });
    for (const [m, p] of fhirRoutes) {
      const r = await call(fhir.url, m, p);
      assert.strictEqual(r.status, 503, `FHIR ${m} ${p} without key configured → ${r.status}`);
      assert.deepStrictEqual(await r.json(), { error: 'not configured' });
    }
    const h: any = await (await fetch(`${fhir.url}/health`)).json();
    assert.deepStrictEqual(Object.keys(h).sort(), ['status', 'timestamp']);
    assert.ok(!JSON.stringify(h).includes('127.0.0.1'), 'health reveals the FHIR URL');
    const pre = await fetch(`${fhir.url}/tools/list`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    assert.strictEqual(pre.headers.get('access-control-allow-origin'), null, 'no CORS for unlisted origin');
    fhir.proc.kill();
    ok('FHIR server: tool, test and patient-data routes fail closed (503) without DRAWBRIDGE_TOOL_KEY; /health minimal; no CORS by default');

    // ---- FHIR server, key set ----
    fhir = await start('src/test-server.ts', 'MCP_SERVER_PORT', { DRAWBRIDGE_TOOL_KEY: KEY, DRAWBRIDGE_CORS_ORIGINS: 'https://admin.example.com' });
    procs.push(fhir.proc);
    for (const [m, p] of fhirRoutes) {
      const r = await call(fhir.url, m, p, { 'x-drawbridge-key': 'wrong-key' });
      assert.strictEqual(r.status, 401, `FHIR ${m} ${p} with wrong key → ${r.status}`);
    }
    const listed = await call(fhir.url, 'POST', '/tools/list', { 'x-drawbridge-key': KEY });
    assert.strictEqual(listed.status, 200);
    assert.ok(Array.isArray(((await listed.json()) as any).result?.tools), 'tools listed with the key');
    const allowed = await fetch(`${fhir.url}/health`, { headers: { Origin: 'https://admin.example.com' } });
    assert.strictEqual(allowed.headers.get('access-control-allow-origin'), 'https://admin.example.com');
    const denied = await fetch(`${fhir.url}/health`, { headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(denied.headers.get('access-control-allow-origin'), null);
    await call(fhir.url, 'GET', '/api/patient/4711', { 'x-drawbridge-key': KEY });
    await settle();
    const fl = auditLines();
    assert.ok(fl.some((l) => l.server === 'fhir' && l.kind === 'security' && l.tool === 'tool_key_rejected' && l.error_code === 'WRONG_KEY' && l.ip), 'wrong key → security event');
    assert.ok(fl.some((l) => l.server === 'fhir' && l.tool === 'fhir_rest' && l.patient_id === '4711' && l.object === '/api/patient/4711'), 'REST route audited with the patient ID');
    fhir.proc.kill();
    ok('FHIR server: wrong key 401 (security event, server "fhir"), right key 200; REST routes audited; CORS only for DRAWBRIDGE_CORS_ORIGINS');

    // ---- FHIR server in production: REST/test routes off, agent routes on ----
    fhir = await start('src/test-server.ts', 'MCP_SERVER_PORT', {
      DRAWBRIDGE_TOOL_KEY: KEY,
      NODE_ENV: 'production',
      FHIR_BASE_URL_PRODUCTION: 'https://127.0.0.1:1/fhir',
      AUTH_URL_PRODUCTION: 'https://127.0.0.1:1/auth',
      TOKEN_URL_PRODUCTION: 'https://127.0.0.1:1/token',
    });
    procs.push(fhir.proc);
    for (const p of ['/api/patient/123', '/api/medication?patientId=123', '/test/auth']) {
      assert.strictEqual((await call(fhir.url, 'GET', p, { 'x-drawbridge-key': KEY })).status, 404, `production ${p}`);
    }
    assert.strictEqual((await call(fhir.url, 'POST', '/api/retell', { 'x-drawbridge-key': KEY })).status, 400, 'agent route still served (400: no tool name)');
    fhir.proc.kill();
    ok('FHIR server in production: REST and test routes (patient IDs in URLs) answer 404; the agent routes stay');

    // ---- Unity server ----
    let unity = await start('src/unity/unity-test-server.ts', 'UNITY_PORT', { DRAWBRIDGE_TOOL_KEY: undefined });
    procs.push(unity.proc);
    const unityRoutes: Array<[string, string]> = [
      ['POST', '/'],
      ['POST', '/api/retell'],
      ['GET', '/tools'],
      ['GET', '/test/auth'],
      ['GET', '/test/serverinfo'],
      ['GET', '/diagnostics/veradigm'],
      ['POST', '/api/activity/retell-events'],
    ];
    for (const [m, p] of unityRoutes) {
      const r = await call(unity.url, m, p);
      assert.strictEqual(r.status, 503, `Unity ${m} ${p} without key configured → ${r.status}`);
    }
    const uh: any = await (await fetch(`${unity.url}/health`)).json();
    assert.deepStrictEqual(Object.keys(uh).sort(), ['status', 'timestamp']);
    assert.ok(!JSON.stringify(uh).includes('Smoke.App.Name') && !JSON.stringify(uh).includes('UnityService'), 'health reveals app name or endpoint');
    unity.proc.kill();
    ok('Unity server: tool, test, diagnostics and module API routes fail closed (503) without the key; /health minimal');

    unity = await start('src/unity/unity-test-server.ts', 'UNITY_PORT', { DRAWBRIDGE_TOOL_KEY: KEY });
    procs.push(unity.proc);
    for (const [m, p] of unityRoutes) {
      const r = await call(unity.url, m, p, { 'x-drawbridge-key': 'nope' });
      assert.strictEqual(r.status, 401, `Unity ${m} ${p} with wrong key → ${r.status}`);
    }
    // Wait for the start-up GetServerInfo attempt (refused locally) to settle, then read the summary.
    let diag: any = null;
    for (let i = 0; i < 40; i++) {
      diag = await (await call(unity.url, 'GET', '/diagnostics/veradigm', { 'x-drawbridge-key': KEY })).json();
      if (diag.server_info?.every((s: any) => s.status !== 'not_checked')) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.deepStrictEqual(diag.server_info.map((s: any) => [s.target, s.status]), [['EHR', 'unavailable']], 'EHR only (PM not configured), unavailable, server still up');
    assert.strictEqual((await fetch(`${unity.url}/health`)).status, 200, 'GetServerInfo failure never stops the server');
    assert.ok(!unity.out().includes('ehr-pw') && !unity.out().includes('svc-pw'), 'a password reached the server log');
    ok('Unity server: wrong key 401; GetServerInfo failure at start shown as "unavailable", server stays up, no passwords logged');

    // Minimum necessary on the agent endpoints: staff-only tools are neither offered nor run.
    const post = (p: string, body: unknown) =>
      fetch(`${unity.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-drawbridge-key': KEY }, body: JSON.stringify(body) });
    const toolList: any = await (await post('/', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json();
    const names: string[] = toolList.result.tools.map((t: any) => t.name);
    assert.ok(names.includes('unity_search_patients') && !names.includes('unity_get_day_schedule') && !names.includes('unity_get_changed_appointments') && !names.includes('drawbridge_get_huddle_brief'), 'staff-only tools listed to the agent');
    const refusedTool = await (await post('/api/retell', { name: 'unity_get_day_schedule', args: { date: '10/15/2026' }, call: { call_id: 'call_smoke1' } })).json();
    assert.ok(/TOOL_ERROR \(STAFF_ONLY/.test(String(refusedTool)), String(refusedTool));
    const nameOnly = await (await post('/api/retell', { name: 'unity_search_patients', args: { lastName: 'Smith' }, call: { call_id: 'call_smoke2' } })).json();
    assert.ok(/TOOL_ERROR/.test(String(nameOnly)), 'search fails (no Veradigm): never an empty result');
    await settle();
    const ul = auditLines();
    assert.ok(ul.some((l) => l.server === 'unity' && l.tool === 'unity_get_day_schedule' && l.error_code === 'STAFF_ONLY' && l.channel === 'retell'), 'refusal audited');
    assert.ok(ul.some((l) => l.server === 'unity' && l.kind === 'security' && l.tool === 'tool_key_rejected'), 'Unity wrong key → security event');
    unity.proc.kill();
    ok('Unity server: staff-only tools (day schedule, changed appointments, huddle brief) not offered to the agent and refused (STAFF_ONLY, audited); wrong key → security event');

    // ---- The phone agent's own key (DRAWBRIDGE_AGENT_KEY, launch audit 2026-10-16) ----
    const AKEY = 'smoke-agent-key-9876543210';
    unity = await start('src/unity/unity-test-server.ts', 'UNITY_PORT', { DRAWBRIDGE_TOOL_KEY: KEY, DRAWBRIDGE_AGENT_KEY: AKEY });
    procs.push(unity.proc);
    fhir = await start('src/test-server.ts', 'MCP_SERVER_PORT', { DRAWBRIDGE_TOOL_KEY: KEY, DRAWBRIDGE_AGENT_KEY: AKEY });
    procs.push(fhir.proc);
    const retell = (base: string, key: string) =>
      fetch(`${base}/api/retell`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-drawbridge-key': key }, body: JSON.stringify({ name: 'unity_get_appointment_types', args: {}, call: { call_id: 'call_key1' } }) });
    assert.strictEqual((await retell(unity.url, AKEY)).status, 200, 'Unity /api/retell with the agent key');
    assert.strictEqual((await retell(unity.url, KEY)).status, 401, 'Unity /api/retell refuses the tool key once the agent key is set');
    assert.strictEqual((await retell(fhir.url, AKEY)).status, 200, 'FHIR /api/retell with the agent key');
    assert.strictEqual((await retell(fhir.url, KEY)).status, 401, 'FHIR /api/retell refuses the tool key once the agent key is set');
    for (const [m, p] of unityRoutes.filter(([, p]) => p !== '/api/retell')) {
      assert.strictEqual((await call(unity.url, m, p, { 'x-drawbridge-key': AKEY })).status, 401, `agent key must not open Unity ${m} ${p}`);
      assert.notStrictEqual((await call(unity.url, m, p, { 'x-drawbridge-key': KEY })).status, 401, `tool key still opens Unity ${m} ${p}`);
    }
    for (const [m, p] of fhirRoutes.filter(([, p]) => p !== '/api/retell')) {
      assert.strictEqual((await call(fhir.url, m, p, { 'x-drawbridge-key': AKEY })).status, 401, `agent key must not open FHIR ${m} ${p}`);
    }
    for (const p of ['/app', '/app/activity', '/app/oncall', '/app/intake', '/app/compliance']) {
      const r = await fetch(`${unity.url}${p}`, { headers: { 'x-drawbridge-key': AKEY }, redirect: 'manual' });
      assert.ok(r.status !== 200 && !/Sign out|Overview<\/h2>/.test(await r.text()), `agent key must not open staff page ${p} (${r.status})`);
      const t = await fetch(`${unity.url}${p}`, { headers: { 'x-drawbridge-key': KEY }, redirect: 'manual' });
      assert.ok(t.status !== 200, `tool key must not open staff page ${p} (${t.status})`);
    }
    unity.proc.kill();
    fhir.proc.kill();
    ok('DRAWBRIDGE_AGENT_KEY: the phone agent key opens /api/retell on both servers and nothing else (MCP, /tools, test, diagnostics, module APIs, FHIR REST, staff pages: 401 / sign-in); the tool key no longer opens /api/retell; neither key opens a staff page');
  } finally {
    for (const p of procs) if (p.exitCode === null) p.kill();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.log('FAIL', e?.message || e);
  process.exitCode = 1;
});
