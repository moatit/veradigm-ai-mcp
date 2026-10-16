/**
 * Offline checks for Unity auth and Veradigm diagnostics (no network: axios.post is replaced by a fake).
 * Single-flight login, retry once after a rejected token, timeouts, no secrets in logs,
 * GetServerInfo summary/caching and LastLogs after server-side errors (rate-limited, no loop),
 * auth latch (Veradigm refused a sign-in: nothing more is sent until an operator retries; one alert),
 * which refusals latch (ValidUser, denial faults, 401/403, a fresh token refused again; never HTML 5xx pages),
 * one login per system at a time (no second refused login in a race), a late success while latched,
 * the latch file (survives a restart, shared between processes, scrypt fingerprint, cleared by a credential
 * change or a retry), security events, the declared-action allow-list, scrubbed refusal text and the
 * "Retry sign-in" route (administrators only, same origin, audited).
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
process.env.AUDIT_DIR = TMP;
process.env.CALL_RECORDS_DIR = TMP;
process.env.DRAWBRIDGE_USERS_FILE = path.join(TMP, 'users');
process.env.DRAWBRIDGE_SESSION_SECRET = 'smoke-unity-auth-secret-0123456789abcdef';
for (const k of [
  'HELPDESK_SMTP_URL', 'HELPDESK_WEBHOOK_URL', 'UNITY_KEEP_WARM_MINUTES', 'UNITY_HEALTH_ACTION', 'NODE_ENV',
  'DRAWBRIDGE_USERNAME', 'DRAWBRIDGE_PASSWORD', 'DRAWBRIDGE_REQUIRE_TOTP', 'DRAWBRIDGE_PASSWORD_MAX_AGE_DAYS',
]) delete process.env[k];

import assert from 'assert';
import axios from 'axios';

interface Call {
  url: string;
  action: string;
  target: string;
  timeout: number | undefined;
}

async function main(): Promise<void> {
  const { UnityAuthService, tokenLifetimeSeconds, isTokenRejection, isCredentialRejection, scrubAuthText } = await import('../unity/services/unity-auth.service');
  const { UnityActions, CERTIFIED_ACTIONS } = await import('../unity/config/unity-endpoints');
  const { BackgroundContact } = await import('../unity/services/background-contact');
  const audit = await import('../platform/audit');
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
  const origWarn = console.warn;
  console.warn = (...a: any[]) => void logged.push(a.map(String).join(' '));
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
    if (step) return { data: await step() };
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
  let auth = new UnityAuthService({ latchDir: '' });
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
  await new UnityService(new UnityAuthService({ latchDir: '' })).cleanup();
  assert.strictEqual(calls.length, 0);
  ok('shutdown with no token held makes no Veradigm call');

  // 5. Token rejected on an action: drop it, log in again, retry once
  reset();
  auth = new UnityAuthService({ latchDir: '' });
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
  auth = new UnityAuthService({ latchDir: '' });
  unity = new UnityService(auth);
  script.GetUserAuthentication = [() => [{ getuserauthenticationinfo: [{ ValidUser: 'NO', ErrorMessage: 'Invalid password' }] }]];
  await assert.rejects(unity.executeAction('GetSchedule', {}, '', 'PM'), (e: any) => e.code === 'AUTH_ERROR');
  assert.strictEqual(count('GetUserAuthentication'), 1);
  assert.strictEqual(count('GetSchedule'), 0);
  ok('wrong EHR/PM password: one login attempt, AUTH_ERROR, no retry');

  // 8. Auth failures never log the axios error (request body with passwords)
  reset();
  auth = new UnityAuthService({ latchDir: '' });
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
  auth = new UnityAuthService({ latchDir: '' });
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

  // 13. Auth latch: Veradigm refused the sign-in -> nothing more is sent for that system until an operator retries
  const health = await import('../unity/services/unity-health');
  const { SystemStatus } = await import('../platform/system-status');
  const { HelpdeskNotifier } = await import('../platform/helpdesk');
  const alerts: string[] = [];
  const mkLatched = () => {
    const a = new UnityAuthService({ latchDir: '' });
    const st = new SystemStatus({
      targets: () => ['PM', 'EHR'],
      notifier: new HelpdeskNotifier(() => [{ name: 'fake', send: async (m: any) => void alerts.push(m.subject) }]),
      dir: '',
      log: () => undefined,
      event: () => undefined,
    });
    a.onLatch((l) => st.markDown(l.target, 'AUTH_ERROR', `${l.stage}: sign-in stopped (${l.reason})`));
    return { a, st, u: new UnityService(a) };
  };
  const httpErr = (status: number, data: any = {}) => () => {
    throw Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status, data } });
  };
  const timeoutErr = () => {
    throw Object.assign(new Error('timeout of 30000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' });
  };
  const refusedErr = () => {
    throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { isAxiosError: true, code: 'ECONNREFUSED' });
  };

  // 13a. ValidUser != YES (wrong EHR/PM password): latched, one alert, every later caller refused locally
  reset();
  let L = mkLatched();
  script.GetUserAuthentication = [() => [{ getuserauthenticationinfo: [{ ValidUser: 'NO', ErrorMessage: 'Invalid password for VHCP001PM:PMGA02^8^pmuser on 10/15/2026' }] }]];
  await assert.rejects(L.u.executeAction('GetSchedule', {}, '', 'PM'), (e: any) => e.code === 'AUTH_ERROR');
  const latch = L.a.latched('PM')!;
  assert.ok(latch && latch.stage === 'GetUserAuthentication', 'PM latched at GetUserAuthentication');
  assert.ok(!latch.reason.includes('pmuser') && !latch.reason.includes('10/15/2026'), `reason scrubbed: ${latch.reason}`);
  assert.strictEqual(L.a.latched('EHR'), undefined, 'EHR not affected');
  await L.st.flush();
  assert.strictEqual(L.st.snapshot().components.find((c) => c.target === 'PM')!.state, 'down', 'PM DOWN at once');
  assert.strictEqual(alerts.length, 1, 'one help-desk alert when the latch engages');
  const sentBefore = calls.length;
  await assert.rejects(L.u.executeAction('GetSchedule', {}, '', 'PM'), (e: any) => e.code === 'AUTH_ERROR' && /sign-in stopped/.test(e.message));
  await assert.rejects(L.u.executeAction('SaveTask', {}, '1', 'PM'), (e: any) => e.code === 'AUTH_ERROR');
  await assert.rejects(L.a.getAuthenticatedSession('PM'), /sign-in stopped/);
  await assert.rejects(L.a.refreshSession('PM'), /sign-in stopped/);
  const probe = await new health.UnityHealthChecker({ auth: L.a, unity: L.u, status: L.st, targets: () => ['PM'], log: () => undefined }).probe('PM');
  assert.deepStrictEqual([probe.ok, probe.error_class], [false, 'AUTH_ERROR'], 'health probe: local AUTH_ERROR');
  process.env.UNITY_KEEP_WARM_MINUTES = '30';
  let kwCalls = 0;
  const kwAuth = {
    tokenSecondsLeft: () => undefined, // token missing: keep-warm would renew it
    refreshSession: async (t: any) => (kwCalls++, L.a.refreshSession(t)),
    getAuthenticatedSession: async (t: any) => (kwCalls++, L.a.getAuthenticatedSession(t)),
    latched: (t: any) => L.a.latched(t),
  };
  const kw = new health.TokenKeepWarm(kwAuth, () => ['PM'], { log: () => undefined });
  kw.noteActivity();
  assert.strictEqual(await kw.tick(), 0, 'keep-warm skips a latched system');
  await kw.warmNow();
  assert.strictEqual(kwCalls, 0, 'keep-warm and call-start warm-up leave a latched system alone');
  delete process.env.UNITY_KEEP_WARM_MINUTES;
  assert.strictEqual(calls.length, sentBefore, 'nothing sent to Veradigm while latched (tools, writes, probe, keep-warm)');
  await L.st.flush();
  assert.strictEqual(alerts.length, 1, 'still one alert');
  // Operator retry: the next call signs in again (fresh GetToken + GetUserAuthentication) and works
  assert.deepStrictEqual(L.a.retrySignIn('PM', 'staff:admin'), ['PM']);
  assert.strictEqual(L.a.latched('PM'), undefined);
  const after = await L.u.executeAction('GetSchedule', {}, '', 'PM');
  assert.ok(after.success);
  assert.deepStrictEqual([count('GetToken'), count('GetUserAuthentication'), count('GetSchedule')], [2, 2, 1], 'one new sign-in after the retry');
  assert.ok(logged.some((l) => /PM sign-in STOPPED/.test(l)) && logged.some((l) => /PM sign-in retry requested by staff:admin/.test(l)), 'latch and retry are logged');
  ok('auth latch: ValidUser != YES latches the system (DOWN, one help-desk alert); tools, writes, probe and keep-warm get a local AUTH_ERROR with nothing sent; operator retry signs in again');

  // 13b. GetToken refused for a non-transient reason: latched
  assert.ok(isCredentialRejection({ response: { status: 403, data: {} } }));
  assert.ok(isCredentialRejection({ response: { status: 401, data: '' } }));
  assert.ok(isCredentialRejection({ response: { status: 500, data: { error: 'Access is denied.' } } }), 'WCF fault: access denied on HTTP 500');
  assert.ok(isCredentialRejection({ response: { status: 400, data: 'Invalid username or password' } }));
  assert.ok(!isCredentialRejection({ code: 'ECONNABORTED', message: 'timeout of 30000ms exceeded' }), 'timeout');
  assert.ok(!isCredentialRejection({ code: 'ECONNREFUSED' }), 'network');
  assert.ok(!isCredentialRejection({ response: { status: 503, data: { Error: 'Service Unavailable' } } }), '5xx');
  assert.ok(!isCredentialRejection({ response: { status: 500, data: { Error: 'Unity said no' } } }), '5xx without a denial');
  assert.ok(!isCredentialRejection({ response: { status: 429, data: {} } }), '429');
  reset();
  alerts.length = 0;
  L = mkLatched();
  script.GetToken = [httpErr(500, { error: 'Access is denied' })];
  await assert.rejects(L.u.executeAction('GetSchedule', {}, '', 'EHR'), (e: any) => e.code === 'AUTH_ERROR');
  assert.strictEqual(L.a.latched('EHR')?.stage, 'GetToken');
  await assert.rejects(L.u.executeAction('GetSchedule', {}, '', 'EHR'), (e: any) => e.code === 'AUTH_ERROR');
  assert.strictEqual(count('GetToken'), 1, 'no second GetToken while latched');
  await L.st.flush();
  assert.strictEqual(alerts.length, 1);
  reset();
  L = mkLatched();
  script.GetToken = [httpErr(403)];
  await assert.rejects(L.u.executeAction('GetSchedule', {}, '', 'PM'));
  assert.strictEqual(L.a.latched('PM')?.stage, 'GetToken', '403 latches');
  ok('auth latch: GetToken 401/403 or "Access is denied" latches; one GetToken, no retries');

  // 13c. Transient failures never latch: the next call tries again
  for (const [label, fail] of [['timeout', timeoutErr], ['network', refusedErr], ['HTTP 503', httpErr(503, { Error: 'Service Unavailable' })], ['HTTP 500', httpErr(500, {})]] as const) {
    reset();
    L = mkLatched();
    script.GetToken = [fail];
    await assert.rejects(L.u.executeAction('GetSchedule', {}, '', 'EHR'));
    assert.strictEqual(L.a.latched('EHR'), undefined, `${label} does not latch`);
    const r = await L.u.executeAction('GetSchedule', {}, '', 'EHR');
    assert.ok(r.success && count('GetToken') === 2, `${label}: the next call signs in`);
  }
  reset();
  L = mkLatched();
  script.GetUserAuthentication = [timeoutErr];
  await assert.rejects(L.u.executeAction('GetSchedule', {}, '', 'EHR'));
  assert.strictEqual(L.a.latched('EHR'), undefined, 'GetUserAuthentication timeout does not latch');
  const text13 = logged.join('\n');
  for (const s of [SECRET_SVC, SECRET_EHR, SECRET_PM]) assert.ok(!text13.includes(s), 'a password reached the log');
  ok('auth latch: timeouts, network errors and 5xx (GetToken or GetUserAuthentication) never latch');

  // 14. Which refusals latch: denial faults and 401/403 at GetUserAuthentication, a fresh token refused again;
  //     an HTML error page or a plain 5xx never does.
  const fault = (text: string) => `<s:Envelope><s:Body><s:Fault><faultcode>a:DeserializationFailed</faultcode><faultstring xml:lang="en-US">${text}</faultstring></s:Fault></s:Body></s:Envelope>`;
  assert.ok(isCredentialRejection({ response: { status: 500, data: fault('Access is denied.') } }), 'WCF fault on HTTP 500');
  assert.ok(isCredentialRejection({ response: { status: 500, data: '{"Message":"Access is denied."}' } }), 'JSON fault text on HTTP 500');
  assert.ok(!isCredentialRejection({ response: { status: 500, data: '<html><body><h1>Server Error</h1><p>Access is denied.</p></body></html>' } }), 'HTML error page: never');
  assert.ok(!isCredentialRejection({ response: { status: 502, data: 'Bad gateway: upstream access is denied' } }), 'plain text on a 5xx: never');
  assert.ok(!isCredentialRejection({ response: { status: 408, data: 'Access is denied' } }), '408');
  const latchCase = async (label: string, steps: Record<string, Array<() => any>>, expectLatch: boolean, target: 'PM' | 'EHR' = 'EHR') => {
    reset();
    const a = new UnityAuthService({ latchDir: '' });
    const u = new UnityService(a);
    script = steps;
    await u.executeAction('GetSchedule', {}, '', target).catch(() => undefined);
    assert.strictEqual(!!a.latched(target), expectLatch, `${label}: ${expectLatch ? 'latched' : 'not latched'}`);
    return a;
  };
  await latchCase('GetUserAuthentication Error reply "Access is denied"', { GetUserAuthentication: [() => [{ Error: 'Magic Error - Access is denied for user ehruser' }]] }, true);
  await latchCase('GetUserAuthentication HTTP 401', { GetUserAuthentication: [httpErr(401)] }, true);
  await latchCase('GetUserAuthentication HTTP 403', { GetUserAuthentication: [httpErr(403, { Error: 'Forbidden' })] }, true);
  await latchCase('GetUserAuthentication HTTP 401 that says the token expired', { GetUserAuthentication: [httpErr(401, { Error: 'Security token is invalid or expired' })] }, false);
  await latchCase('GetUserAuthentication HTML 500 page', { GetUserAuthentication: [httpErr(500, '<html><body>Access is denied</body></html>')] }, false);
  await latchCase('GetToken WCF fault on HTTP 500', { GetToken: [httpErr(500, fault('Access is denied.'))] }, true);
  await latchCase('GetToken HTML 500 page', { GetToken: [httpErr(500, '<html><title>500</title><body>Access is denied</body></html>')] }, false);
  const tokenBad = () => [{ Error: 'Magic Error - Security token is invalid or expired' }];
  await latchCase('one token rejection, then the fresh token works', { GetUserAuthentication: [tokenBad] }, false);
  assert.deepStrictEqual([count('GetToken'), count('GetUserAuthentication')], [2, 2]);
  await latchCase('the fresh token refused as well', { GetUserAuthentication: [tokenBad, tokenBad] }, true);
  assert.deepStrictEqual([count('GetToken'), count('GetUserAuthentication')], [2, 2], 'no third login');
  ok('latch: denial replies and 401/403 at GetUserAuthentication, WCF/JSON denial faults, a fresh token refused again; never a token-expiry 401, an HTML error page or plain 5xx text');

  // 15. One login per system at a time: keep-warm and a tool call racing never send two refused logins
  reset();
  let a15 = new UnityAuthService({ latchDir: '' });
  let u15 = new UnityService(a15);
  const slowNo = () => delay(30).then(() => [{ getuserauthenticationinfo: [{ ValidUser: 'NO', ErrorMessage: 'Invalid password' }] }]);
  script.GetUserAuthentication = [slowNo, slowNo, slowNo];
  await Promise.all([
    a15.refreshSession('PM').catch(() => undefined),
    u15.executeAction('GetSchedule', {}, '', 'PM').catch(() => undefined),
    a15.refreshSession('PM').catch(() => undefined),
    u15.executeAction('GetPatient', {}, '1', 'PM').catch(() => undefined),
  ]);
  assert.ok(a15.latched('PM'));
  assert.strictEqual(count('GetUserAuthentication'), 1, 'one refused GetUserAuthentication, not one per caller');
  assert.strictEqual(count('GetSchedule') + count('GetPatient'), 0);
  reset();
  a15 = new UnityAuthService({ latchDir: '' });
  u15 = new UnityService(a15);
  const slowDeny = () => delay(30).then(httpErr(403));
  script.GetToken = [slowDeny, slowDeny, slowDeny];
  await Promise.all([a15.refreshSession('EHR').catch(() => undefined), u15.executeAction('GetSchedule', {}, '', 'EHR').catch(() => undefined), a15.refreshSession('EHR').catch(() => undefined)]);
  assert.ok(a15.latched('EHR'));
  assert.strictEqual(count('GetToken'), 1, 'one refused GetToken, not one per caller');
  ok('one login per system at a time: keep-warm + tool calls racing send one refused GetUserAuthentication / GetToken, the rest are refused locally');

  // 16. A call that started before the latch and succeeds after it does not mark the system UP
  reset();
  const a16 = new UnityAuthService({ latchDir: '' });
  const u16 = new UnityService(a16);
  const st16 = new SystemStatus({ targets: () => ['PM'], notifier: new HelpdeskNotifier(() => []), dir: '', log: () => undefined, event: () => undefined });
  const checker16 = new health.UnityHealthChecker({ auth: a16, unity: u16, status: st16, targets: () => ['PM'], log: () => undefined, contact: new BackgroundContact() });
  a16.onLatch((l) => st16.markDown(l.target, 'AUTH_ERROR', `${l.stage}: sign-in stopped`));
  u16.onOutcome((ac, t, okk, c) => checker16.onActionOutcome(ac, t, okk, c));
  await u16.executeAction('GetSchedule', {}, '', 'PM'); // session + PM UP
  assert.strictEqual(st16.overall(), 'up');
  let release!: () => void;
  script.GetSchedule = [() => new Promise((r) => (release = () => r([{ getscheduleinfo: [{ ok: 'yes' }] }])))];
  const inFlight = u16.executeAction('GetSchedule', {}, '', 'PM');
  await delay(20);
  script.GetUserAuthentication = [() => [{ getuserauthenticationinfo: [{ ValidUser: 'NO', ErrorMessage: 'Password expired' }] }]];
  await a16.refreshSession('PM').catch(() => undefined); // keep-warm: refused -> latch -> DOWN
  assert.strictEqual(st16.overall(), 'down');
  release();
  assert.ok((await inFlight).success, 'the old session still answered');
  assert.strictEqual(st16.overall(), 'down', 'a late success does not mark a latched system UP');
  ok('a call that started before the latch and succeeds after it leaves the latched system DOWN');

  // 17. Latch file: survives a restart, shared by processes, scrypt fingerprint (no secret), credential change, retry
  const { unityConfig } = await import('../unity/config/environment');
  const LDIR = path.join(TMP, 'latch');
  reset();
  const proc1 = new UnityAuthService({ latchDir: LDIR });
  script.GetUserAuthentication = [() => [{ getuserauthenticationinfo: [{ ValidUser: 'NO', ErrorMessage: 'Invalid password for pmuser', Lockout: 'NO' }] }]];
  await assert.rejects(new UnityService(proc1).executeAction('GetSchedule', {}, '', 'PM'));
  assert.ok(proc1.latched('PM'));
  assert.strictEqual(proc1.cachedToken('PM'), undefined, 'latched: no cached token is used or retired');
  const file = path.join(LDIR, 'unity-auth-latch.json');
  const raw = fs.readFileSync(file, 'utf8');
  const { createHash } = await import('crypto');
  for (const bad of [SECRET_SVC, SECRET_PM, SECRET_EHR, 'pmuser', createHash('sha256').update(SECRET_PM).digest('hex'), Buffer.from(SECRET_PM).toString('base64')]) {
    assert.ok(!raw.includes(bad), `latch file holds ${bad}`);
  }
  assert.ok(/"fp": "[0-9a-f]{64}"/.test(raw) && /"salt": "[0-9a-f]{32}"/.test(raw), 'scrypt fingerprint with a random salt');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  // restart: a new process with the same credentials sends nothing for PM
  reset();
  const proc2 = new UnityAuthService({ latchDir: LDIR });
  assert.strictEqual(proc2.latched('PM')?.stage, 'GetUserAuthentication', 'latch survives a restart');
  await assert.rejects(new UnityService(proc2).executeAction('GetSchedule', {}, '', 'PM'), (e: any) => e.code === 'AUTH_ERROR');
  assert.strictEqual(calls.length, 0, 'restarted process: no login sent');
  // shared: the other process latches EHR, this one honours it at its next call (no restart)
  script.GetToken = [httpErr(403)];
  await assert.rejects(new UnityService(proc1).executeAction('GetSchedule', {}, '', 'EHR'));
  reset();
  await assert.rejects(new UnityService(proc2).executeAction('GetSchedule', {}, '', 'EHR'), /sign-in stopped/);
  assert.strictEqual(calls.length, 0, 'the second process honours the latch of the first');
  // changed credentials: the latch no longer applies (and applies again with the refused ones)
  const oldPw = unityConfig.pmPassword;
  (unityConfig as any).pmPassword = 'pm-New-Pw-000';
  assert.strictEqual(new UnityAuthService({ latchDir: LDIR }).latched('PM'), undefined, 'new PM password: not latched');
  (unityConfig as any).pmPassword = oldPw;
  assert.ok(new UnityAuthService({ latchDir: LDIR }).latched('PM'), 'back to the refused password: latched again');
  // operator retry in one process clears it for all
  assert.deepStrictEqual(proc2.retrySignIn('PM', 'ada.admin'), ['PM']);
  assert.strictEqual(proc1.latched('PM'), undefined, 'the other process sees the retry');
  assert.strictEqual(new UnityAuthService({ latchDir: LDIR }).latched('PM'), undefined, 'and so does a restart');
  assert.ok(new UnityAuthService({ latchDir: LDIR }).latched('EHR'), 'EHR still latched');
  const auditLines = async () => {
    await audit.flushAudit();
    return fs
      .readdirSync(path.join(TMP, 'audit'))
      .flatMap((f) => fs.readFileSync(path.join(TMP, 'audit', f), 'utf8').split('\n'))
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  };
  const sec = (await auditLines()).filter((x) => x.kind === 'security');
  assert.ok(sec.some((x) => x.tool === 'unity_signin_latched' && x.error_code === 'PM' && x.success === false), 'security event unity_signin_latched');
  assert.ok(sec.some((x) => x.tool === 'unity_signin_retry' && x.user === 'ada.admin' && x.object === 'veradigm_pm'), 'security event unity_signin_retry with the user');
  ok('latch file: survives a restart (nothing sent), shared between processes, scrypt fingerprint and no secret on disk, a credential change lifts it, a retry clears it everywhere; security events latched / retry');

  // 18. Only declared actions are sent; scrubbed refusal text
  reset();
  const a18 = new UnityAuthService({ latchDir: '' });
  const u18 = new UnityService(a18);
  for (const bad of ['Echo', 'GetTokenValidation', 'GetChangedPatients', '']) {
    await assert.rejects(u18.executeAction(bad, {}, '', 'EHR'), (e: any) => e.code === 'ACTION_NOT_ALLOWED', bad);
  }
  assert.strictEqual(calls.length, 0, 'refused before any login or request');
  const flat = (o: any): string[] => Object.values(o).flatMap((v: any) => (typeof v === 'string' ? [v] : flat(v)));
  const configured = flat(UnityActions);
  const undeclared = configured.filter((x) => !CERTIFIED_ACTIONS.has(x));
  assert.deepStrictEqual(undeclared, [], `configured but not declared: ${undeclared.join(', ')}`);
  assert.ok(!configured.includes('GetTokenValidation') && !configured.includes('Echo'));
  process.env.UNITY_HEALTH_ACTION = 'GetPatient';
  assert.strictEqual(health.healthAction(), 'GetServerInfo', 'the probe reads GetServerInfo whatever UNITY_HEALTH_ACTION says');
  delete process.env.UNITY_HEALTH_ACTION;
  assert.strictEqual(scrubAuthText('Invalid password for EHRUSER (VHCP001EHR:EHRGA01^8^svc) on 10/15/2026, id 123456'), 'Invalid password for [account] (VHCP001EHR:[account]) on [date], id [n]');
  reset();
  logged.length = 0;
  script.GetUserAuthentication = [() => [{ getuserauthenticationinfo: [{ ValidUser: 'NO', ErrorMessage: 'User ehruser password expired on 10/01/2026' }] }]];
  const thrown = await u18.executeAction('GetSchedule', {}, '', 'EHR').catch((e) => e);
  assert.ok(thrown.code === 'AUTH_ERROR' && !/ehruser|10\/01\/2026/i.test(thrown.message), thrown.message);
  const again = await u18.executeAction('GetSchedule', {}, '', 'EHR').catch((e) => e);
  assert.ok(!/ehruser|10\/01\/2026/i.test(again.message), again.message);
  assert.ok(!/ehruser|10\/01\/2026/i.test(logged.join('\n')), 'refusal text scrubbed in the logs');
  ok('only declared actions are sent (Echo, GetTokenValidation refused before any request; every configured name is declared); the probe always reads GetServerInfo; refusal text scrubbed in errors and logs');

  // 19. "Retry sign-in" route: administrators only, same origin only, audited
  const express = (await import('express')).default;
  const shell = await import('../platform/shell');
  const staff = await import('../platform/staff-auth');
  const { staffAudit } = await import('../platform/app');
  const { veradigmModule } = await import('../platform/modules/veradigm');
  const { setUnityAuth } = await import('../unity/services/unity-auth.service');
  const secrets: Record<string, string> = { 'pat.staff': staff.newTotpSecret(), 'ada.admin': staff.newTotpSecret() };
  fs.writeFileSync(
    process.env.DRAWBRIDGE_USERS_FILE!,
    `${shell.hashStaffPassword('pat.staff', 'river lamp orbit nine')}:totp=${secrets['pat.staff']}\n` +
      `${shell.hashStaffPassword('ada.admin', 'copper fern atlas kite')}:totp=${secrets['ada.admin']}:role=admin\n`
  );
  reset();
  const a19 = new UnityAuthService({ latchDir: '' });
  script.GetUserAuthentication = [() => [{ getuserauthenticationinfo: [{ ValidUser: 'NO', ErrorMessage: 'Invalid password' }] }]];
  await a19.getAuthenticatedSession('EHR').catch(() => undefined);
  assert.ok(a19.latched('EHR'));
  setUnityAuth(a19);
  diag.setUnityDiagnostics(new diag.UnityDiagnostics({ unity: { executeAction: async () => ({ success: true }) }, targets: () => ['EHR'], dir: '', log: () => undefined }));
  shell.registerNav(veradigmModule.nav!);
  const app = express();
  app.use('/app', shell.shellRouter());
  app.use('/app/veradigm', shell.requireLogin, staffAudit(veradigmModule.name), express.urlencoded({ extended: false }), veradigmModule.appRouter!({} as any));
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const login = async (u: string, p: string) => {
    const r = await fetch(`${base}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ u, p, otp: staff.totpCode(secrets[u], Math.floor(Date.now() / 30_000)), next: '/app' }).toString() });
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie, `sign-in of ${u}`);
    return cookie;
  };
  const retry = (cookie: string, extra: Record<string, string> = {}) =>
    fetch(`${base}/app/veradigm/retry-sign-in`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', ...extra }, body: 'target=EHR' });
  try {
    const pat = await login('pat.staff', 'river lamp orbit nine');
    const ada = await login('ada.admin', 'copper fern atlas kite');
    const screen = await (await fetch(`${base}/app/veradigm`, { headers: { cookie: pat } })).text();
    assert.ok(/sign-in stopped/.test(screen) && /Retry sign-in/.test(screen), 'the screen shows the stopped sign-in');
    assert.strictEqual((await retry(pat)).status, 403, 'staff (not admin): 403');
    assert.ok(a19.latched('EHR'), 'still latched');
    assert.strictEqual((await retry(ada, { 'sec-fetch-site': 'cross-site' })).status, 403, 'cross-site: 403');
    assert.strictEqual((await retry(ada, { origin: 'https://evil.example' })).status, 403, 'foreign Origin: 403');
    assert.ok(a19.latched('EHR'), 'still latched');
    const okr = await retry(ada, { 'sec-fetch-site': 'same-origin' });
    assert.ok(okr.status === 303 && okr.headers.get('location') === '/app/veradigm', String(okr.status));
    assert.strictEqual(a19.latched('EHR'), undefined, 'administrator retry cleared it');
    const lines = await auditLines();
    assert.ok(lines.some((x) => x.kind === 'staff' && x.tool === 'veradigm_action' && x.user === 'pat.staff' && x.error_code === 'HTTP_403'), 'refused staff attempt audited');
    assert.ok(lines.some((x) => x.kind === 'staff' && x.tool === 'veradigm_action' && x.user === 'ada.admin' && x.success && x.object === '/app/veradigm/retry-sign-in'), 'administrator retry audited');
    assert.ok(lines.some((x) => x.kind === 'security' && x.tool === 'cross_site_request'), 'cross-site attempt is a security event');
    assert.ok(lines.some((x) => x.kind === 'security' && x.tool === 'unity_signin_retry' && x.user === 'ada.admin' && x.object === 'veradigm_ehr'), 'retry security event with the administrator');
  } finally {
    srv.close();
    setUnityAuth(null);
  }
  ok('"Retry sign-in": shown on the Veradigm connection screen, staff 403, cross-site / foreign Origin 403 (security event), administrator clears it (303), staff audit and unity_signin_retry with the user');

  console.error = origError;
  console.warn = origWarn;
  console.log = origLog;
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  process.stdout.write(`FAIL ${e?.message || e}\n`);
  process.exit(1);
});
