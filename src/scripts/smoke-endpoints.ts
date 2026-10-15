/**
 * Offline checks for endpoint auth on both HTTP servers (no Veradigm call: every upstream URL points
 * at 127.0.0.1:1, which refuses connections). Starts src/test-server.ts and
 * src/unity/unity-test-server.ts as child processes on free local ports.
 *
 *  - tool, test, patient-data and diagnostics routes fail closed (503) without DRAWBRIDGE_TOOL_KEY,
 *    401 with a wrong key, pass with the right key
 *  - /health is open and reveals no endpoint, app name or environment
 *  - CORS: no Access-Control-Allow-Origin unless the origin is in DRAWBRIDGE_CORS_ORIGINS
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

async function main(): Promise<void> {
  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`PASS ${label}`);
  };
  const procs: ChildProcess[] = [];
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
    fhir.proc.kill();
    ok('FHIR server: wrong key 401, right key 200; CORS only for DRAWBRIDGE_CORS_ORIGINS');

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
    unity.proc.kill();
    ok('Unity server: wrong key 401; GetServerInfo failure at start shown as "unavailable", server stays up, no passwords logged');
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
