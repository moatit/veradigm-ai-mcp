/**
 * Offline checks for the staff login (127.0.0.1 only, simulated clock):
 * lockout per username and per IP with an unchanged generic message, sliding idle timeout and
 * the 12-hour limit, server-side logout and revocation on removal / password change, TOTP,
 * password policy, the staff:user script and the Content-Security-Policy (no inline script).
 *
 *   npm run smoke:staff-login
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'drawbridge-login-'));
process.env.CALL_RECORDS_DIR = TMP;
process.env.DRAWBRIDGE_USERS_FILE = path.join(TMP, 'users');
process.env.DRAWBRIDGE_SESSION_SECRET = 'smoke-session-secret-0123456789abcdef';
process.env.DRAWBRIDGE_IDLE_MINUTES = '15';
process.env.DRAWBRIDGE_LOGIN_IP_MAX_FAILS = '1000';
delete process.env.DRAWBRIDGE_USERNAME;
delete process.env.DRAWBRIDGE_PASSWORD;

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
  const express = (await import('express')).default;

  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`PASS ${label}`);
  };
  const quiet = console.warn;
  console.warn = () => undefined;

  const PAT_PW = 'river lamp orbit nine';
  const LEE_PW = 'copper fern atlas kite';
  const totpSecret = auth.newTotpSecret();
  const usersFile = process.env.DRAWBRIDGE_USERS_FILE!;
  const writeUsers = (lines: string[]) => {
    fs.writeFileSync(usersFile, lines.join('\n') + '\n');
    const t = new Date(realNow() + offset + Math.random() * 1000);
    fs.utimesSync(usersFile, t, t); // a new mtime so the shell re-reads the file
  };
  const patLine = shell.hashStaffPassword('pat.reviewer', PAT_PW);
  const leeLine = shell.hashStaffPassword('lee.staff', LEE_PW);
  const otpLine = `${shell.hashStaffPassword('sam.mfa', PAT_PW)}:totp=${totpSecret}`;
  writeUsers([patLine, leeLine, otpLine]);

  const app = express();
  app.use('/app', shell.shellRouter());
  app.get('/app/x', shell.requireLogin, (req: any, res) => res.send(`hello ${req.drawbridgeUser}`));
  app.get('/app/page', shell.requireLogin, (req: any, res) => res.send(shell.page('t', '<p>body</p>', { user: req.drawbridgeUser })));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
  const login = (u: string, p: string, otp = '') =>
    fetch(`${url}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ u, p, otp, next: '/app/x' }) });
  const cookieOf = (r: Response) => (r.headers.get('set-cookie') || '').split(';')[0];
  const refused = (r: Response) => r.status === 302 && /\/app\/login\?e=1$/.test(r.headers.get('location') || '');
  const get = (cookie: string, p = '/app/x') => fetch(`${url}${p}`, { redirect: 'manual', headers: { cookie } });
  const signedIn = async (cookie: string) => (await get(cookie)).status === 200;

  try {
    // 1. Sign-in, sliding idle timeout, 12-hour limit
    let r = await login('Pat.Reviewer', PAT_PW);
    assert.ok(r.status === 302 && r.headers.get('location') === '/app/x');
    let cookie = cookieOf(r);
    assert.ok(/HttpOnly; Secure; SameSite=Strict/.test(r.headers.get('set-cookie') || ''));
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
    ok('session: 15-min sliding idle timeout (DRAWBRIDGE_IDLE_MINUTES), 12-hour absolute limit, HttpOnly/Secure/SameSite');

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

    // 3. Removal and password change end existing sessions; re-adding does not revive them
    const lee = cookieOf(await login('lee.staff', LEE_PW));
    assert.ok(await signedIn(lee));
    writeUsers([patLine, otpLine]);
    assert.ok(!(await signedIn(lee)), 'removed → signed out');
    writeUsers([patLine, leeLine, otpLine]);
    assert.ok(!(await signedIn(lee)), 're-added → old cookie still refused');
    const pat = cookieOf(await login('pat.reviewer', PAT_PW));
    writeUsers([shell.hashStaffPassword('pat.reviewer', 'new garden piano seven'), leeLine, otpLine]);
    assert.ok(!(await signedIn(pat)), 'password changed → old sessions end');
    assert.ok(refused(await login('pat.reviewer', PAT_PW)), 'old password refused');
    assert.ok(!refused(await login('pat.reviewer', 'new garden piano seven')));
    ok('removal from the users file or a password change ends existing sessions (also after re-adding)');

    // 4. Lockout per username: 5 failures in 15 min → locked 15 min, same message, also for unknown names
    advance(30);
    for (let i = 0; i < 5; i++) assert.ok(refused(await login('lee.staff', 'wrong password ' + i)));
    const locked = await login('lee.staff', LEE_PW);
    assert.ok(refused(locked), 'right password refused while locked');
    const page = (await (await fetch(`${url}${locked.headers.get('location')}`)).text()).split('<main>')[1] || '';
    assert.ok(page.includes('Wrong username or password.') && !/lock|attempt|exist|remaining/i.test(page), 'generic message only');
    for (let i = 0; i < 6; i++) assert.ok(refused(await login('nobody.here', 'wrong password ' + i)), 'unknown user answered the same way');
    assert.ok(!refused(await login('pat.reviewer', 'new garden piano seven')), 'other users unaffected');
    advance(16);
    assert.ok(!refused(await login('lee.staff', LEE_PW)), 'unlocked after 15 minutes');
    for (let i = 0; i < 4; i++) assert.ok(refused(await login('lee.staff', 'wrong again ' + i)));
    advance(16);
    for (let i = 0; i < 4; i++) assert.ok(refused(await login('lee.staff', 'wrong again ' + i)));
    assert.ok(!refused(await login('lee.staff', LEE_PW)), 'failures older than the window do not count');
    ok('lockout: 5 failures in 15 min lock the username for 15 min (right password refused, same message, unknown names too)');

    // 5. TOTP for a user who enrolled: password alone is not enough, a code works once
    const step = Math.floor(Date.now() / 30_000);
    assert.ok(refused(await login('sam.mfa', PAT_PW)), 'no code');
    const code = auth.totpCode(totpSecret, step);
    assert.ok(refused(await login('sam.mfa', PAT_PW, code === '000000' ? '111111' : '000000')), 'wrong code');
    assert.ok(!refused(await login('sam.mfa', PAT_PW, code)), 'right code');
    assert.ok(refused(await login('sam.mfa', PAT_PW, code)), 'same code twice');
    assert.ok((await (await fetch(`${url}/app/login`)).text()).includes('Authenticator code'));
    assert.strictEqual(auth.totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1), '287082', 'RFC 6238 test vector (T=59 s)');
    ok('TOTP (optional per user): password alone refused, valid code accepted once, RFC 6238 vector');

    // 6. Per-IP limit
    advance(30);
    process.env.DRAWBRIDGE_LOGIN_IP_MAX_FAILS = '4';
    for (let i = 0; i < 4; i++) assert.ok(refused(await login(`spray${i}`, 'wrong password!')));
    assert.ok(refused(await login('lee.staff', LEE_PW)), 'IP locked: even a valid login from it is refused');
    advance(16);
    assert.ok(!refused(await login('lee.staff', LEE_PW)), 'IP unlocked after the window');
    process.env.DRAWBRIDGE_LOGIN_IP_MAX_FAILS = '1000';
    ok('per-IP limit: too many failures from one client lock that client for the window');

    // 7. Content-Security-Policy, no inline script
    const lp = await fetch(`${url}/app/login`);
    const csp = lp.headers.get('content-security-policy') || '';
    assert.ok(/script-src 'self'(;|$)/.test(csp) && /frame-ancestors 'none'/.test(csp) && /object-src 'none'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp), csp);
    assert.strictEqual(lp.headers.get('x-content-type-options'), 'nosniff');
    const html = await (await get(cookieOf(await login('lee.staff', LEE_PW)), '/app/page')).text();
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html) && !/\son[a-z]+="/i.test(html), 'inline script in page()');
    const js = await fetch(`${url}/app/assets/drawbridge.js`);
    assert.ok(js.status === 200 && /javascript/.test(js.headers.get('content-type') || ''));
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
    ok('CSP on every staff page: script-src self (no inline script or handlers anywhere in src), nosniff, no framing');

    // 8. Password policy and the staff:user script
    for (const bad of ['short', 'Password2026!', 'P@ssw0rd!2026', '123456789012', 'aaaaaaaaaaaaaa', 'qwertyuiop12', 'Welcome123456', 'summer2026summer2026', 'pat.reviewer2026!!']) {
      assert.ok(auth.passwordProblem('pat.reviewer', bad), `accepted ${bad}`);
    }
    for (const good of ['correct horse battery', 'river lamp orbit nine', 'Tq8#vLm2!pZr', 'another long password']) {
      assert.strictEqual(auth.passwordProblem('pat.reviewer', good), null, `refused ${good}`);
    }
    assert.throws(() => shell.hashStaffPassword('pat', 'Password2026!'), /too common/);
    const tsNode = path.join(process.cwd(), 'node_modules', 'ts-node', 'dist', 'bin.js');
    const run = (args: string[], input: string) => spawnSync(process.execPath, [tsNode, '--transpile-only', 'src/scripts/staff-user.ts', ...args], { input, encoding: 'utf8' });
    const weak = run(['kim.new'], 'Password2026!\n');
    assert.strictEqual(weak.status, 2);
    assert.ok(/too common/.test(weak.stderr) && !weak.stdout.trim());
    const enrolled = run(['kim.new', '--totp'], 'violet canyon drum orbit\n');
    assert.strictEqual(enrolled.status, 0, enrolled.stderr);
    assert.ok(/^kim\.new:scrypt\$[^:]+:totp=[A-Z2-7]{32}$/.test(enrolled.stdout.trim()), enrolled.stdout);
    assert.ok(/otpauth:\/\/totp\/Drawbridge:kim\.new\?secret=[A-Z2-7]{32}/.test(enrolled.stderr) && !enrolled.stdout.includes('otpauth'));
    assert.ok(!enrolled.stdout.includes('violet') && !enrolled.stderr.includes('violet'), 'password echoed');
    ok('password policy (12+, common words/sequences/username refused); staff:user --totp prints the line on stdout, the otpauth link once on stderr');
  } finally {
    server.close();
    console.warn = quiet;
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
