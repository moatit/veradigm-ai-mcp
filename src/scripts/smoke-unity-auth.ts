/**
 * Offline checks for Unity auth and Veradigm diagnostics (no network: axios.post is replaced by a fake).
 * Single-flight login, retry once after a rejected token, timeouts, no secrets in logs,
 * GetServerInfo summary/caching and LastLogs after server-side errors (rate-limited, no loop).
 *
 *   npm run smoke:unity-auth
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SECRET_SVC = 'svc-Secret-Pw-123';
const SECRET_EHR = 'ehr-Secret-Pw-456';
const SECRET_PM = 'pm-Secret-Pw-789';
Object.assign(process.env, {
  UNITY_APP_NAME: 'Drawbridge.Smoke',
  UNITY_SVC_USERNAME: 'svc',
  UNITY_SVC_PASSWORD: SECRET_SVC,
  UNITY_EHR_USERNAME: 'ehruser',
  UNITY_EHR_PASSWORD: SECRET_EHR,
  UNITY_PM_USERNAME: 'pmuser',
  UNITY_PM_PASSWORD: SECRET_PM,
  UNITY_UBIQUITY_ENDPOINT: 'https://unity.invalid/UnityService.svc',
  UNITY_TOKEN_CACHE_TTL: '1140',
  UNITY_TOKEN_REFRESH_BUFFER: '120',
});
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'drawbridge-unity-auth-'));

import assert from 'assert';
import axios from 'axios';

interface Call {
  url: string;
  action: string;
  target: string;
  timeout: number | undefined;
}

async function main(): Promise<void> {
  const { UnityAuthService, tokenLifetimeSeconds, isTokenRejection } = await import('../unity/services/unity-auth.service');
  const { UnityService } = await import('../unity/services/unity.service');
  const diag = await import('../unity/services/unity-diagnostics');

  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`PASS ${label}`);
  };

  // Capture everything the code logs, to check that no secret or patient value reaches stdout/stderr.
  const logged: string[] = [];
  const origError = console.error;
  const origLog = console.log;
  console.error = (...a: any[]) => void logged.push(a.map(String).join(' '));
  console.log = (...a: any[]) => {
    const s = a.map(String).join(' ');
    if (s.startsWith('PASS ')) origLog(s);
    else logged.push(s);
  };

  // ---- fake Unity ----
  const calls: Call[] = [];
  let tokenN = 0;
  let script: Record<string, Array<() => any>> = {};
  const next = (action: string) => script[action]?.shift();
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  (axios as any).post = async (url: string, body: any, cfg: any) => {
    const action = url.endsWith('/GetToken') ? 'GetToken' : url.endsWith('/RetireToken') ? 'RetireToken' : String(body?.Action);
    const target = url.endsWith('/GetToken') ? (String(body?.Username).startsWith('VHCP') ? 'PM' : 'EHR') : '';
    calls.push({ url, action, target, timeout: cfg?.timeout });
    await delay(5);
    const step = next(action);
    if (step) return { data: step() };
    if (action === 'GetToken') return { data: `tok-${++tokenN}` };
    if (action === 'RetireToken') return { data: 'ok' };
    if (action === 'GetUserAuthentication') return { data: [{ getuserauthenticationinfo: [{ ValidUser: 'YES', UserID: '1' }] }] };
    return { data: [{ getscheduleinfo: [{ ok: 'yes' }] }] };
  };
  const count = (action: string) => calls.filter((c) => c.action === action).length;
  const reset = () => {
    calls.length = 0;
    script = {};
  };

  // 1. Token lifetime uses the refresh buffer
  assert.strictEqual(tokenLifetimeSeconds(), 1140 - 120);
  assert.strictEqual(tokenLifetimeSeconds(1140, 5000), 60, 'never below 60 s');
  assert.ok(isTokenRejection('Magic Error - Security token is invalid or expired'));
  assert.ok(isTokenRejection('Invalid token'));
  assert.ok(!isTokenRejection('Invalid password for user'));
  ok('token reused for UNITY_TOKEN_CACHE_TTL minus UNITY_TOKEN_REFRESH_BUFFER (min 60 s); token errors recognised');

  // 2. Single flight: concurrent callers share one GetToken and one GetUserAuthentication
  let auth = new UnityAuthService();
  let unity = new UnityService(auth);
  const results = await Promise.all(Array.from({ length: 6 }, () => unity.executeAction('GetSchedule', { Parameter1: '10/15/2026' }, '', 'PM')));
  assert.ok(results.every((r) => r.success));
  assert.strictEqual(count('GetToken'), 1, 'one GetToken for 6 concurrent calls');
  assert.strictEqual(count('GetUserAuthentication'), 1, 'one GetUserAuthentication for 6 concurrent calls');
  assert.strictEqual(count('GetSchedule'), 6);
  ok('6 concurrent calls share one GetToken and one GetUserAuthentication');

  // 3. Timeouts on GetToken, GetUserAuthentication, RetireToken (and MagicJson)
  await unity.cleanup();
  for (const a of ['GetToken', 'GetUserAuthentication', 'RetireToken', 'GetSchedule']) {
    const c = calls.filter((x) => x.action === a);
    assert.ok(c.length > 0, `${a} called`);
    assert.ok(c.every((x) => x.timeout === 30000), `${a} has a 30 s timeout`);
  }
  assert.ok(!auth.isTokenCached('PM'), 'retired token forgotten');
  ok('GetToken, GetUserAuthentication and RetireToken time out after 30 s; shutdown retires held tokens');

  // 4. Cleanup never requests a token just to retire it
  reset();
  await new UnityService(new UnityAuthService()).cleanup();
  assert.strictEqual(calls.length, 0);
  ok('shutdown with no token held makes no Veradigm call');

  // 5. Token rejected on an action: drop it, log in again, retry once
  reset();
  auth = new UnityAuthService();
  unity = new UnityService(auth);
  await unity.executeAction('GetSchedule', {}, '', 'PM'); // warm: token 1
  reset();
  script.GetSchedule = [() => [{ Error: 'Magic Error - Security token is invalid or expired' }]];
  const r5 = await unity.executeAction('GetSchedule', {}, '', 'PM');
  assert.ok(r5.success, 'retry succeeded');
  assert.strictEqual(count('GetToken'), 1, 'new token after rejection');
  assert.strictEqual(count('GetUserAuthentication'), 1, 'new login after rejection');
  assert.strictEqual(count('GetSchedule'), 2, 'action retried once');
  ok('token rejected by Unity → cached token and login dropped, call retried once with a fresh login');

  // 6. HTTP 401 on a write: retried once (Unity did not run it); a second 401 is not retried again
  reset();
  const http401 = () => {
    throw Object.assign(new Error('Request failed with status code 401'), { isAxiosError: true, response: { status: 401, data: {} } });
  };
  script.SaveTask = [http401, http401];
  await assert.rejects(unity.executeAction('SaveTask', {}, '1', 'EHR'), (e: any) => e.code === 'AUTH_ERROR');
  assert.strictEqual(count('SaveTask'), 2, 'one retry only');
  ok('HTTP 401 → one retry with a fresh login, then AUTH_ERROR (no loop)');

  // 7. Wrong EHR/PM password is never retried (account lockout)
  reset();
  auth = new UnityAuthService();
  unity = new UnityService(auth);
  script.GetUserAuthentication = [() => [{ getuserauthenticationinfo: [{ ValidUser: 'NO', ErrorMessage: 'Invalid password' }] }]];
  await assert.rejects(unity.executeAction('GetSchedule', {}, '', 'PM'), (e: any) => e.code === 'AUTH_ERROR');
  assert.strictEqual(count('GetUserAuthentication'), 1);
  assert.strictEqual(count('GetSchedule'), 0);
  ok('wrong EHR/PM password: one login attempt, AUTH_ERROR, no retry');

  // 8. Auth failures never log the axios error (request body with passwords)
  reset();
  auth = new UnityAuthService();
  unity = new UnityService(auth);
  const axiosLike = (status: number) => () => {
    throw Object.assign(new Error(`Request failed with status code ${status}`), {
      isAxiosError: true,
      code: 'ERR_BAD_RESPONSE',
      config: { data: JSON.stringify({ Username: 'svc', Password: SECRET_SVC, Parameter1: SECRET_EHR }) },
      request: { body: SECRET_PM },
      response: { status, data: { Error: 'Unity said no' } },
    });
  };
  script.GetToken = [axiosLike(500)];
  await assert.rejects(unity.executeAction('GetSchedule', {}, '', 'EHR'));
  script.GetUserAuthentication = [axiosLike(500)];
  await assert.rejects(unity.executeAction('GetSchedule', {}, '', 'EHR'));
  script.RetireToken = [axiosLike(503)];
  await auth.retireToken('tok-x', 'EHR');
  const text = logged.join('\n');
  for (const s of [SECRET_SVC, SECRET_EHR, SECRET_PM]) assert.ok(!text.includes(s), 'a password reached the log');
  assert.ok(/Token request failed for EHR: HTTP 500/.test(text), 'status logged');
  ok('GetToken / GetUserAuthentication / RetireToken failures log status, code and message only (no passwords)');

  // 9. No PatientID in the per-call log line
  reset();
  logged.length = 0;
  await unity.executeAction('GetPatient', {}, '987654', 'EHR');
  assert.ok(!logged.join('\n').includes('987654'), 'PatientID logged');
  ok('per-call log line has the action and target, not the PatientID');

  // 10. GetServerInfo: summary fields only, cached, failure shown as unavailable
  reset();
  auth = new UnityAuthService();
  unity = new UnityService(auth);
  let now = Date.parse('2026-10-15T15:00:00Z');
  const d = new diag.UnityDiagnostics({ unity, targets: () => ['PM', 'EHR'], now: () => now, dir: TMP, log: (l) => logged.push(l) });
  unity.onServerError((a, t, c) => d.onServerError(a, t, c));
  script.GetServerInfo = [
    () => [{ getserverinfoinfo: [{ System: 'Veradigm PM', ProductVersion: '24.1', ServerTimeZone: 'Mountain Standard Time', ServerTime: '10/15/2026 9:00:00 AM', ConnectionString: 'Server=sql;Password=x', UAIBornOnDate: '2020' }] }],
    () => {
      throw Object.assign(new Error('Request failed with status code 503'), { isAxiosError: true, response: { status: 503, data: {} } });
    },
    () => {
      throw Object.assign(new Error('Request failed with status code 503'), { isAxiosError: true, response: { status: 503, data: {} } });
    },
  ];
  const info = await d.refreshServerInfo(true);
  assert.deepStrictEqual(Object.keys(info[0]).sort(), ['checked_at', 'error_code', 'product', 'server_time', 'status', 'target', 'time_zone', 'version']);
  assert.strictEqual(info[0].status, 'ok');
  assert.strictEqual(info[0].product, 'Veradigm PM');
  assert.strictEqual(info[0].version, '24.1');
  assert.strictEqual(info[0].time_zone, 'Mountain Standard Time');
  assert.ok(!JSON.stringify(info).includes('Password'), 'only allow-listed fields kept');
  assert.strictEqual(info[1].status, 'unavailable', 'EHR failure → unavailable, no throw');
  assert.strictEqual(count('GetToken'), 2, 'first token per target before GetServerInfo');
  const before = count('GetServerInfo');
  await d.refreshServerInfo();
  assert.strictEqual(count('GetServerInfo'), before, 'cached within the refresh window');
  now += 7 * 3_600_000;
  await d.refreshServerInfo();
  assert.ok(count('GetServerInfo') > before, 're-checked after the window');
  ok('GetServerInfo: product/version/time zone only, per target, cached for hours, failure = "unavailable"');

  // 11. LastLogs after a server-side error: once, rate-limited per target, scrubbed, never for LastLogs itself
  reset();
  const http500 = () => {
    throw Object.assign(new Error('Request failed with status code 500'), { isAxiosError: true, response: { status: 500, data: { Error: 'boom' } } });
  };
  script.GetSchedule = [http500, http500, http500];
  script.LastLogs = [
    () => [{ lastlogsinfo: [{ LogDate: '2026-10-15 09:00:01', Action: 'GetSchedule', Message: 'NullReference for patient 56500 DOB 12/06/1952 jane@example.com', Password: 'x' }] }],
    http500,
  ];
  await assert.rejects(unity.executeAction('GetSchedule', {}, '', 'PM'), (e: any) => e.code === 'SERVER_ERROR');
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(count('LastLogs'), 1);
  await assert.rejects(unity.executeAction('GetSchedule', {}, '', 'PM'));
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(count('LastLogs'), 1, 'rate-limited: at most once a minute per target');
  now += 61_000;
  await assert.rejects(unity.executeAction('GetSchedule', {}, '', 'PM'));
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(count('LastLogs'), 2, 'again after the interval');
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(count('LastLogs'), 2, 'a failing LastLogs does not trigger LastLogs');
  const recs = d.lastLogs().filter((r) => r.target === 'PM');
  assert.strictEqual(recs.length, 2);
  assert.strictEqual(recs[0].status, 'failed');
  const e0 = recs[1].entries[0];
  assert.deepStrictEqual(Object.keys(e0).sort(), ['action', 'message', 'timestamp']);
  assert.strictEqual(e0.action, 'GetSchedule');
  for (const bad of ['56500', '12/06/1952', 'jane@example.com']) assert.ok(!e0.message.includes(bad), `message keeps ${bad}`);
  const saved = fs.readFileSync(path.join(TMP, 'unity-diagnostics.json'), 'utf8');
  assert.ok(!saved.includes('56500') && !saved.includes('Password'));
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(TMP, 'unity-diagnostics.json')).mode & 0o777, 0o600);
  ok('LastLogs after SERVER_ERROR: once, ≤1/min/target, no loop, timestamp/action/scrubbed message only, saved 0600');

  // 12. Validation-type Unity errors do not call LastLogs; unexpected exceptions in the reply do
  reset();
  now += 120_000;
  script.GetSchedule = [() => [{ Error: 'Parameter1 is required' }], () => [{ Error: 'Magic Error - Object reference not set to an instance of an object' }]];
  await unity.executeAction('GetSchedule', {}, '', 'EHR');
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(count('LastLogs'), 0);
  await unity.executeAction('GetSchedule', {}, '', 'EHR');
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(count('LastLogs'), 1);
  ok('LastLogs only for unexpected Veradigm errors, not for validation messages');

  console.error = origError;
  console.log = origLog;
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  process.stdout.write(`FAIL ${e?.message || e}\n`);
  process.exit(1);
});
