/**
 * Offline checks for the staff login (127.0.0.1 only, simulated clock):
 * lockout per username and per IP with an unchanged generic message, sliding idle timeout and
 * the 12-hour limit, server-side logout and revocation on removal / password change, mandatory TOTP,
 * 90-day password expiry, password history (no reuse of the last 5), roles (admin, emergency),
 * security events in the audit log, automatic logoff markup, the __Host- cookie, HSTS, password policy,
 * the staff:user script and the Content-Security-Policy (no inline script).
 *
 *   npm run smoke:staff-login
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'drawbridge-login-'));
process.env.CALL_RECORDS_DIR = TMP;
process.env.AUDIT_DIR = TMP;
process.env.DRAWBRIDGE_USERS_FILE = path.join(TMP, 'users');
process.env.DRAWBRIDGE_SESSION_SECRET = 'smoke-session-secret-0123456789abcdef';
process.env.DRAWBRIDGE_IDLE_MINUTES = '15';
process.env.DRAWBRIDGE_LOGIN_IP_MAX_FAILS = '1000';
delete process.env.DRAWBRIDGE_USERNAME;
delete process.env.DRAWBRIDGE_PASSWORD;
delete process.env.ONCALL_USERNAME;
delete process.env.ONCALL_PASSWORD;
delete process.env.DRAWBRIDGE_REQUIRE_TOTP;
delete process.env.DRAWBRIDGE_PASSWORD_MAX_AGE_DAYS;
delete process.env.NODE_ENV;

import assert from 'assert';
import { spawnSync } from 'child_process';
import type { AddressInfo } from 'net';

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const advance = (min: number) => (offset += min * 60_000);

async function main(): Promise<void> {
  const shell = await import('../platform/shell');
  const auth = await import('../platform/staff-auth');
  const audit = await import('../platform/audit');
  const express = (await import('express')).default;

  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`PASS ${label}`);
  };
  // Security events also go to the server log ([SECURITY] lines): kept quiet here, checked in the audit log.
  const quiet = { warn: console.warn, log: console.log, error: console.error };
  console.warn = () => undefined;
  console.error = () => undefined;
  console.log = (...a: unknown[]) => {
    if (!/^\[SECURITY\]/.test(String(a[0]))) quiet.log(...a);
  };

  const PAT_PW = 'river lamp orbit nine';
  const LEE_PW = 'copper fern atlas kite';
  const secrets: Record<string, string> = {};
  const usersFile = process.env.DRAWBRIDGE_USERS_FILE!;
  const writeUsers = (lines: string[]) => {
    fs.writeFileSync(usersFile, lines.join('\n') + '\n');
    const t = new Date(realNow() + offset + Math.random() * 1000);
    fs.utimesSync(usersFile, t, t); // a new mtime so the shell re-reads the file
  };
  /** A users-file line with an enrolled TOTP secret (and optional extra attributes). */
  const enrolled = (user: string, pw: string, extra = '') => {
    secrets[user] = auth.newTotpSecret();
    return `${shell.hashStaffPassword(user, pw)}:totp=${secrets[user]}${extra}`;
  };
  const daysAgo = (n: number) => auth.utcDay(Date.now() - n * 86_400_000);
  const patLine = enrolled('pat.reviewer', PAT_PW);
  const leeLine = enrolled('lee.staff', LEE_PW);
  const otpLine = enrolled('sam.mfa', PAT_PW);
  writeUsers([patLine, leeLine, otpLine]);

  const app = express();
  app.use('/app', shell.shellRouter());
  app.get('/app/x', shell.requireLogin, (req: any, res) => res.send(`hello ${req.drawbridgeUser}`));
  app.get('/app/page', shell.requireLogin, (req: any, res) => res.send(shell.page('t', '<p>body</p>', { user: req.drawbridgeUser })));
  app.get('/app/admin', shell.requireLogin, shell.requireAdmin, (_req, res) => res.send('admin ok'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
  /** Sign in; without an explicit code, the current code of the user's secret 31 s later (each code works once). */
  const login = (u: string, p: string, otp?: string) => {
    if (otp === undefined) {
      offset += 31_000;
      const s = secrets[u.toLowerCase()];
      otp = s ? auth.totpCode(s, Math.floor(Date.now() / 30_000)) : '';
    }
    return fetch(`${url}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ u, p, otp, next: '/app/x' }) });
  };
  const cookieOf = (r: Response) => (r.headers.get('set-cookie') || '').split(';')[0];
  const refusedWith = (r: Response, e: string) => r.status === 302 && new RegExp(`/app/login\\?e=${e}$`).test(r.headers.get('location') || '');
  const refused = (r: Response) => refusedWith(r, '1');
  const get = (cookie: string, p = '/app/x') => fetch(`${url}${p}`, { redirect: 'manual', headers: { cookie } });
  const signedIn = async (cookie: string) => (await get(cookie)).status === 200;
  const auditLines = async () => {
    await audit.flushAudit();
    const dir = path.join(TMP, 'audit');
    return fs
      .readdirSync(dir)
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
      .join('')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  };

  try {
    // 1. Sign-in, sliding idle timeout, 12-hour limit
    let r = await login('Pat.Reviewer', PAT_PW);
    assert.ok(r.status === 302 && r.headers.get('location') === '/app/x', r.headers.get('location') || '');
    let cookie = cookieOf(r);
    assert.ok(/^__Host-drawbridge_session=/.test(cookie), 'cookie has the __Host- prefix');
    assert.ok(/HttpOnly; Secure; SameSite=Strict/.test(r.headers.get('set-cookie') || '') && /Path=\//.test(r.headers.get('set-cookie') || ''));
    assert.ok(!/Domain=/i.test(r.headers.get('set-cookie') || ''));
    assert.ok(await signedIn(cookie));
    advance(10);
    const touched = await get(cookie);
    assert.strictEqual(touched.status, 200);
    const slid = cookieOf(touched);
    assert.ok(slid && slid !== cookie, 'activity refreshes the idle clock');
    advance(10);
    assert.ok(!(await signedIn(cookie)), 'old cookie: 20 min idle');
    assert.ok(await signedIn(slid), 'refreshed cookie: 10 min idle');
    advance(16);
    assert.ok(!(await signedIn(slid)), 'idle 16 min → signed out');
    r = await login('pat.reviewer', PAT_PW);
    cookie = cookieOf(r);
    for (let h = 0; h < 12 * 6 - 1; h++) {
      advance(10);
      const g = await get(cookie);
      assert.strictEqual(g.status, 200, `active at ${h}`);
      cookie = cookieOf(g) || cookie;
    }
    advance(10);
    assert.ok(!(await signedIn(cookie)), '12-hour absolute limit even when active');
    ok('session: 15-min sliding idle timeout (DRAWBRIDGE_IDLE_MINUTES), 12-hour absolute limit, __Host- cookie, HttpOnly/Secure/SameSite');

    // 2. Server-side logout ends the session everywhere; a new sign-in works
    const a = cookieOf(await login('pat.reviewer', PAT_PW));
    const b = cookieOf(await login('pat.reviewer', PAT_PW));
    assert.ok((await signedIn(a)) && (await signedIn(b)));
    const out = await fetch(`${url}/app/logout`, { method: 'POST', redirect: 'manual', headers: { cookie: a } });
    assert.strictEqual(out.status, 302);
    assert.ok(!(await signedIn(a)), 'logged-out cookie replayed');
    assert.ok(!(await signedIn(b)), 'other browser of the same user');
    const c = cookieOf(await login('pat.reviewer', PAT_PW));
    assert.ok(await signedIn(c), 'sign in again right after logout');
    const saved = JSON.parse(fs.readFileSync(auth.sessionsFile(), 'utf8'));
    assert.ok(saved.valid_after['pat.reviewer'] > 0);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(auth.sessionsFile()).mode & 0o777, 0o600);
    ok('logout is server-side: the cookie (and the user\'s other sessions) stop working; revocation saved to a 0600 file');

    // 2b. Cross-site requests (launch audit 2026-10-16): SameSite=Strict still sends the cookie from a sibling
    // subdomain of the same site, so state-changing requests must come from this origin.
    {
      const d = cookieOf(await login('pat.reviewer', PAT_PW));
      const postOut = (headers: Record<string, string>) => fetch(`${url}/app/logout`, { method: 'POST', redirect: 'manual', headers: { cookie: d, ...headers } });
      assert.strictEqual((await postOut({ 'sec-fetch-site': 'same-site', origin: 'https://evil.moatit.dev' })).status, 403, 'sibling subdomain refused');
      assert.strictEqual((await postOut({ 'sec-fetch-site': 'cross-site' })).status, 403, 'cross-site refused');
      assert.strictEqual((await postOut({ origin: 'https://evil.moatit.dev' })).status, 403, 'foreign Origin refused (no Sec-Fetch-Site)');
      assert.strictEqual((await postOut({ origin: 'null' })).status, 403, 'opaque origin refused');
      assert.ok(await signedIn(d), 'refused requests changed nothing');
      const csrfLogin = await fetch(`${url}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' }, body: form({ u: 'pat.reviewer', p: PAT_PW, otp: '', next: '/app/x' }) });
      assert.strictEqual(csrfLogin.status, 403, 'login CSRF refused');
      assert.strictEqual((await postOut({ 'sec-fetch-site': 'same-origin', origin: url })).status, 302, 'same origin works');
      assert.ok(!(await signedIn(d)));
      const bad = await fetch(`${url}/app/x`, { redirect: 'manual', headers: { cookie: '__Host-drawbridge_session=%E0%A4%A' } });
      assert.ok(bad.status === 302 || bad.status === 401, `malformed cookie → sign-in, not ${bad.status}`);
      const l2 = await auditLines();
      assert.ok(l2.some((x: any) => x.kind === 'security' && x.tool === 'cross_site_request'), 'cross-site request is a security event');
      ok('cross-site requests: POSTs with Sec-Fetch-Site same-site/cross-site or a foreign Origin are refused (403, security event, session untouched), login CSRF too; same-origin works; a malformed cookie signs out instead of a 500');
    }

    // 3. Removal and password change end existing sessions; re-adding does not revive them
    const lee = cookieOf(await login('lee.staff', LEE_PW));
    assert.ok(await signedIn(lee));
    writeUsers([patLine, otpLine]);
    assert.ok(!(await signedIn(lee)), 'removed → signed out');
    writeUsers([patLine, leeLine, otpLine]);
    assert.ok(!(await signedIn(lee)), 're-added → old cookie still refused');
    const pat = cookieOf(await login('pat.reviewer', PAT_PW));
    const patNew = `${shell.hashStaffPassword('pat.reviewer', 'new garden piano seven')}:totp=${secrets['pat.reviewer']}`;
    writeUsers([patNew, leeLine, otpLine]);
    assert.ok(!(await signedIn(pat)), 'password changed → old sessions end');
    assert.ok(refused(await login('pat.reviewer', PAT_PW)), 'old password refused');
    assert.ok(!refused(await login('pat.reviewer', 'new garden piano seven')));
    ok('removal from the users file or a password change ends existing sessions (also after re-adding)');

    // 4. Lockout per username: 5 failures in 15 min → locked 15 min, same message, also for unknown names
    advance(30);
    for (let i = 0; i < 5; i++) assert.ok(refused(await login('lee.staff', 'wrong password ' + i)));
    const locked = await login('lee.staff', LEE_PW);
    assert.ok(refused(locked), 'right password refused while locked');
    const lockedPage = (await (await fetch(`${url}${locked.headers.get('location')}`)).text()).split('<main>')[1] || '';
    assert.ok(lockedPage.includes('Wrong username or password.') && !/lock|attempt|exist|remaining/i.test(lockedPage.split('</form>')[0]), 'generic message only');
    for (let i = 0; i < 6; i++) assert.ok(refused(await login('nobody.here', 'wrong password ' + i)), 'unknown user answered the same way');
    assert.ok(!refused(await login('pat.reviewer', 'new garden piano seven')), 'other users unaffected');
    advance(16);
    assert.ok(!refused(await login('lee.staff', LEE_PW)), 'unlocked after 15 minutes');
    for (let i = 0; i < 4; i++) assert.ok(refused(await login('lee.staff', 'wrong again ' + i)));
    advance(16);
    for (let i = 0; i < 4; i++) assert.ok(refused(await login('lee.staff', 'wrong again ' + i)));
    assert.ok(!refused(await login('lee.staff', LEE_PW)), 'failures older than the window do not count');
    ok('lockout: 5 failures in 15 min lock the username for 15 min (right password refused, same message, unknown names too)');

    // 5. TOTP: password alone is not enough, a wrong code is refused, a code works once
    const step = Math.floor(Date.now() / 30_000);
    assert.ok(refused(await login('sam.mfa', PAT_PW, '')), 'no code');
    const code = auth.totpCode(secrets['sam.mfa'], step);
    assert.ok(refused(await login('sam.mfa', PAT_PW, code === '000000' ? '111111' : '000000')), 'wrong code');
    assert.ok(!refused(await login('sam.mfa', PAT_PW, code)), 'right code');
    assert.ok(refused(await login('sam.mfa', PAT_PW, code)), 'same code twice');
    assert.ok(/Authenticator code<input[^>]*required/.test(await (await fetch(`${url}/app/login`)).text()), 'code field on the sign-in page, required');
    assert.strictEqual(auth.totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1), '287082', 'RFC 6238 test vector (T=59 s)');
    ok('TOTP: password alone refused, wrong code refused, valid code accepted once, RFC 6238 vector');

    // 6. TOTP is mandatory: a login without an enrolled secret cannot sign in; the shared login is off
    advance(20);
    writeUsers([patNew, leeLine, otpLine, shell.hashStaffPassword('kai.plain', LEE_PW)]);
    const noTotp = await login('kai.plain', LEE_PW, '');
    assert.ok(refusedWith(noTotp, 'mfa'), 'right password, no TOTP enrolled → refused');
    assert.ok((await (await fetch(`${url}${noTotp.headers.get('location')}`)).text()).includes('Two-factor sign-in is not set up'));
    assert.ok(refused(await login('kai.plain', 'wrong password!!', '')), 'a wrong password still gets the generic answer');
    for (let i = 0; i < 6; i++) assert.ok(refusedWith(await login('kai.plain', LEE_PW, ''), 'mfa'), 'not counted toward the lockout');
    // Someone signed in loses the session when their secret is taken off their line.
    const sam = cookieOf(await login('sam.mfa', PAT_PW));
    assert.ok(await signedIn(sam));
    writeUsers([patNew, leeLine, otpLine.replace(/:totp=[A-Z2-7]+/, ''), shell.hashStaffPassword('kai.plain', LEE_PW)]);
    assert.ok(!(await signedIn(sam)), 'TOTP removed from the line → signed out');
    // Shared development login: refused while TOTP is required, allowed with DRAWBRIDGE_REQUIRE_TOTP=off, never in production.
    delete process.env.DRAWBRIDGE_USERS_FILE;
    process.env.DRAWBRIDGE_USERNAME = 'shared';
    process.env.DRAWBRIDGE_PASSWORD = 'shared-password-123';
    assert.strictEqual((await fetch(`${url}/app/login`)).status, 503, 'TOTP required: the shared login is not a configured login');
    assert.ok(refused(await login('shared', 'shared-password-123', '')));
    process.env.DRAWBRIDGE_REQUIRE_TOTP = 'off';
    const shared = await login('shared', 'shared-password-123', '');
    assert.strictEqual(shared.headers.get('location'), '/app/x', 'development: shared login with TOTP off');
    process.env.NODE_ENV = 'production';
    assert.ok(auth.requireTotp(), 'production forces TOTP on');
    assert.ok(!(await signedIn(cookieOf(shared))), 'production: shared session refused');
    assert.ok(refused(await login('shared', 'shared-password-123', '')), 'production: shared login refused');
    delete process.env.NODE_ENV;
    delete process.env.DRAWBRIDGE_REQUIRE_TOTP;
    delete process.env.DRAWBRIDGE_USERNAME;
    delete process.env.DRAWBRIDGE_PASSWORD;
    process.env.DRAWBRIDGE_USERS_FILE = usersFile;
    ok('TOTP mandatory (DRAWBRIDGE_REQUIRE_TOTP, default on, forced in production): no secret → refused with an enrolment message, removal of the secret ends sessions, shared login off');

    // 7. Password expiry (DRAWBRIDGE_PASSWORD_MAX_AGE_DAYS, default 90): refused only after password + code were right
    const oldLine = enrolled('old.pw', PAT_PW).replace(/:pwset=\d{4}-\d{2}-\d{2}/, `:pwset=${daysAgo(100)}`);
    const legacyLine = enrolled('legacy.user', PAT_PW).replace(/:pwset=\d{4}-\d{2}-\d{2}/, '');
    const freshLine = enrolled('fresh.pw', PAT_PW).replace(/:pwset=\d{4}-\d{2}-\d{2}/, `:pwset=${daysAgo(89)}`);
    writeUsers([patNew, leeLine, oldLine, legacyLine, freshLine]);
    const exp = await login('old.pw', PAT_PW);
    assert.ok(refusedWith(exp, 'expired'), '100-day-old password refused');
    assert.ok((await (await fetch(`${url}${exp.headers.get('location')}`)).text()).includes('Your password has expired'));
    assert.ok(refused(await login('old.pw', 'wrong password!!')), 'wrong password: generic answer, expiry not revealed');
    assert.ok(refusedWith(await login('legacy.user', PAT_PW), 'expired'), 'a line without pwset counts as expired');
    assert.ok(!refused(await login('fresh.pw', PAT_PW)), '89 days old: still valid');
    process.env.DRAWBRIDGE_PASSWORD_MAX_AGE_DAYS = '120';
    const oldOk = cookieOf(await login('old.pw', PAT_PW));
    assert.ok(await signedIn(oldOk), 'DRAWBRIDGE_PASSWORD_MAX_AGE_DAYS=120: 100 days is fine');
    process.env.DRAWBRIDGE_PASSWORD_MAX_AGE_DAYS = '90';
    assert.ok(!(await signedIn(oldOk)), 'a session ends when the password expires');
    delete process.env.DRAWBRIDGE_PASSWORD_MAX_AGE_DAYS;
    assert.deepStrictEqual([auth.passwordAgeDays({ pwset: daysAgo(10) }), auth.passwordAgeDays({})], [10, null]);
    ok('password expiry: older than 90 days or no set date → refused with "contact the administrator" (after password + code), sessions end too');

    // 8. Roles: admin-only screens; the emergency (break-glass) login is flagged, bannered and limited to 4 hours
    writeUsers([patNew, leeLine, enrolled('boss.admin', LEE_PW, ':role=admin'), enrolled('glass.emergency', LEE_PW, ':role=emergency')]);
    const boss = cookieOf(await login('boss.admin', LEE_PW));
    assert.strictEqual(await (await get(boss, '/app/admin')).text(), 'admin ok');
    const patC = cookieOf(await login('pat.reviewer', 'new garden piano seven'));
    assert.strictEqual((await get(patC, '/app/admin')).status, 403, 'staff role → 403');
    let glass = cookieOf(await login('glass.emergency', LEE_PW));
    assert.ok((await (await get(glass, '/app/page')).text()).includes('Emergency access session'), 'banner on every page');
    for (let i = 0; i < 4 * 6 - 1; i++) {
      advance(10);
      const g = await get(glass);
      assert.strictEqual(g.status, 200);
      glass = cookieOf(g) || glass;
    }
    advance(10);
    assert.ok(!(await signedIn(glass)), 'emergency session ends after 4 hours');
    ok('roles: role=admin for administrator screens (others 403); role=emergency signs in with a banner, a security event and a 4-hour limit');

    // 9. Security events in the audit log: no passwords, no typed unknown usernames
    const lines = await auditLines();
    const sec = lines.filter((l) => l.kind === 'security');
    const has = (tool: string, pred: (l: any) => boolean = () => true) => sec.some((l) => l.tool === tool && pred(l));
    assert.ok(has('login_ok', (l) => l.user === 'pat.reviewer' && l.success && l.ip));
    assert.ok(has('login_failed', (l) => l.user === 'lee.staff' && l.error_code === 'BAD_PASSWORD' && !l.success));
    assert.ok(has('login_failed', (l) => l.user === 'sam.mfa' && l.error_code === 'BAD_TOTP'));
    assert.ok(has('login_failed', (l) => !l.user && l.error_code === 'UNKNOWN_USER'), 'unknown name not logged');
    assert.ok(has('login_failed', (l) => l.error_code === 'LOCKED'));
    assert.ok(has('login_locked', (l) => l.user === 'lee.staff'));
    assert.ok(has('logout', (l) => l.user === 'pat.reviewer'));
    assert.ok(has('login_no_totp', (l) => l.user === 'kai.plain'));
    assert.ok(has('login_password_expired', (l) => l.user === 'old.pw' && l.error_code === 'PASSWORD_EXPIRED'));
    assert.ok(has('login_password_expired', (l) => l.user === 'legacy.user' && l.error_code === 'PASSWORD_DATE_MISSING'));
    assert.ok(has('emergency_access_login', (l) => l.user === 'glass.emergency' && !l.success));
    const text = JSON.stringify(lines);
    for (const bad of [PAT_PW, LEE_PW, 'wrong password', 'nobody.here', 'shared-password']) assert.ok(!text.includes(bad), `audit leaks "${bad}"`);
    for (const d of await audit.auditDays()) assert.ok((await audit.verifyAuditDay(d)).ok, `audit chain ${d}`);
    ok('security events: login ok / failed (reason) / locked / logout / no TOTP / expired / emergency, in the hash-chained audit log, no passwords or unknown names');

    // 10. Per-IP limit
    advance(30);
    writeUsers([patNew, leeLine, otpLine]);
    process.env.DRAWBRIDGE_LOGIN_IP_MAX_FAILS = '4';
    for (let i = 0; i < 4; i++) assert.ok(refused(await login(`spray${i}`, 'wrong password!')));
    assert.ok(refused(await login('lee.staff', LEE_PW)), 'IP locked: even a valid login from it is refused');
    advance(16);
    assert.ok(!refused(await login('lee.staff', LEE_PW)), 'IP unlocked after the window');
    process.env.DRAWBRIDGE_LOGIN_IP_MAX_FAILS = '1000';
    assert.ok((await auditLines()).some((l) => l.tool === 'login_ip_locked' && l.ip));
    ok('per-IP limit: too many failures from one client lock that client for the window (security event)');

    // 11. Content-Security-Policy, no inline script, HSTS, automatic logoff
    const lp = await fetch(`${url}/app/login`);
    const csp = lp.headers.get('content-security-policy') || '';
    assert.ok(/script-src 'self'(;|$)/.test(csp) && /frame-ancestors 'none'/.test(csp) && /object-src 'none'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp), csp);
    assert.strictEqual(lp.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(/max-age=\d{7,}/.test(lp.headers.get('strict-transport-security') || ''), 'HSTS');
    const html = await (await get(cookieOf(await login('lee.staff', LEE_PW)), '/app/page')).text();
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html) && !/\son[a-z]+="/i.test(html), 'inline script in page()');
    assert.ok(html.includes('data-idle-ms="900000"') && html.includes('data-logoff-url="/app/login?timeout=1"'), 'signed-in page logs itself off after the idle time');
    assert.ok(!(await (await fetch(`${url}/app/login`)).text()).includes('data-idle-ms'), 'not on the sign-in page');
    assert.ok((await (await fetch(`${url}/app/login?timeout=1`)).text()).includes('signed out after 15 minutes'));
    const js = await fetch(`${url}/app/assets/drawbridge.js`);
    const jsText = await js.text();
    assert.ok(js.status === 200 && /javascript/.test(js.headers.get('content-type') || '') && jsText.includes('data-idle-ms') && jsText.includes("innerHTML = ''"));
    const srcDir = path.join(process.cwd(), 'src');
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) {
          if (f !== 'scripts') walk(p);
        } else if (p.endsWith('.ts')) {
          const t = fs.readFileSync(p, 'utf8');
          if (/<script>|<script\s+(?!src)|\son(click|submit|change|load|input)="/i.test(t)) offenders.push(path.relative(srcDir, p));
        }
      }
    };
    walk(srcDir);
    assert.deepStrictEqual(offenders, [], 'inline script or event handler in a page');
    ok('CSP on every staff page (no inline script anywhere in src), nosniff, HSTS, automatic logoff after the idle time (page blanks itself)');

    // 12. Password policy, users-file lines and the staff:user script (enrolment, rotation, no reuse of the last 5)
    for (const bad of ['short', 'Password2026!', 'P@ssw0rd!2026', '123456789012', 'aaaaaaaaaaaaaa', 'qwertyuiop12', 'Welcome123456', 'summer2026summer2026', 'pat.reviewer2026!!']) {
      assert.ok(auth.passwordProblem('pat.reviewer', bad), `accepted ${bad}`);
    }
    for (const good of ['correct horse battery', 'river lamp orbit nine', 'Tq8#vLm2!pZr', 'another long password']) {
      assert.strictEqual(auth.passwordProblem('pat.reviewer', good), null, `refused ${good}`);
    }
    assert.throws(() => shell.hashStaffPassword('pat', 'Password2026!'), /too common/);
    const parsed = auth.parseStaffLine(`Kim:${'scrypt$16384$8$1$c2FsdA==$aGFzaGhhc2hoYXNoaGFzaA=='}:role=admin:future=1:totp=${'A'.repeat(32)}`);
    assert.ok(parsed && parsed.user === 'kim' && parsed.entry.role === 'admin' && parsed.entry.totp && !parsed.entry.pwset, 'attributes in any order; unknown ones ignored');
    assert.strictEqual(auth.parseStaffLine(`kim:scrypt$16384$8$1$c2FsdA==$aGFzaA==`)!.entry.hist.length, 0, 'old lines (hash only) still load');
    const many = auth.formatStaffLine('kim', { hash: 'scrypt$16384$8$1$a$b', hist: Array(9).fill('scrypt$16384$8$1$a$b'), role: 'staff' });
    assert.strictEqual(auth.parseStaffLine(many)!.entry.hist.length, auth.PASSWORD_HISTORY - 1, 'history keeps 4 previous hashes (5 with the current)');
    const tsNode = path.join(process.cwd(), 'node_modules', 'ts-node', 'dist', 'bin.js');
    const kimFile = path.join(TMP, 'kim-users');
    const run = (args: string[], input: string) =>
      spawnSync(process.execPath, [tsNode, '--transpile-only', 'src/scripts/staff-user.ts', ...args], {
        input,
        encoding: 'utf8',
        env: { ...process.env, DRAWBRIDGE_USERS_FILE: kimFile },
      });
    const weak = run(['kim.new', '--totp'], 'Password2026!\n');
    assert.strictEqual(weak.status, 2);
    assert.ok(/too common/.test(weak.stderr) && !weak.stdout.trim());
    const noSecret = run(['kim.new'], 'violet canyon drum orbit\n');
    assert.ok(noSecret.status === 2 && /add --totp/.test(noSecret.stderr), 'no TOTP on file and no --totp → refused');
    const first = run(['kim.new', '--totp', '--admin'], 'violet canyon drum orbit\n');
    assert.strictEqual(first.status, 0, first.stderr);
    const l1 = first.stdout.trim();
    assert.ok(/^kim\.new:scrypt\$[^:]+:totp=[A-Z2-7]{32}:pwset=\d{4}-\d{2}-\d{2}:role=admin$/.test(l1), l1);
    assert.ok(/otpauth:\/\/totp\/Drawbridge:kim\.new\?secret=[A-Z2-7]{32}/.test(first.stderr) && !first.stdout.includes('otpauth'));
    assert.ok(!first.stdout.includes('violet') && !first.stderr.includes('violet'), 'password echoed');
    fs.writeFileSync(kimFile, l1 + '\n');
    const reuse = run(['kim.new'], 'violet canyon drum orbit\n');
    assert.ok(reuse.status === 2 && /last 5 passwords/.test(reuse.stderr), 'current password reused → refused');
    const second = run(['kim.new'], 'amber lantern quiet fox\n');
    assert.strictEqual(second.status, 0, second.stderr);
    const e1 = auth.parseStaffLine(l1)!.entry;
    const e2 = auth.parseStaffLine(second.stdout.trim())!.entry;
    assert.ok(e2.totp === e1.totp && e2.role === 'admin' && e2.hist[0] === e1.hash && e2.pwset === auth.utcDay(realNow()), 'rotation keeps TOTP and role, old hash into history');
    assert.ok(!second.stderr.includes('otpauth'), 'no new authenticator link on a plain password change');
    fs.writeFileSync(kimFile, second.stdout);
    const reuseOld = run(['kim.new'], 'violet canyon drum orbit\n');
    assert.ok(reuseOld.status === 2 && /last 5 passwords/.test(reuseOld.stderr), 'a password from the history → refused');
    ok('password policy; users-file lines (pwset, hist, role; old lines load); staff:user: --totp enrols (otpauth link once on stderr), rotation keeps TOTP/role, no reuse of the last 5');
  } finally {
    server.close();
    console.warn = quiet.warn;
    console.error = quiet.error;
    console.log = quiet.log;
    Date.now = realNow;
  }
  console.log(`\n${passed} checks passed`);
}

main()
  .catch((e) => {
    console.log('FAIL', e?.message || e);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(TMP, { recursive: true, force: true }));
