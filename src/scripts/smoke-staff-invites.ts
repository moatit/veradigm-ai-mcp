/**
 * Offline checks for staff invitations (Staff logins screen; 127.0.0.1 only, simulated clock, synthetic people):
 * the store (hashed token, single use, 24 h, 15-minute setup window, five wrong codes, re-invite turns the old
 * sign-in off, password history, server users win), the public pages (link → password → QR → code → signed in), the
 * Staff logins screen (administrators only, no email in any URL), and the invitation email (TLS required, link in
 * the fragment, no secrets in the message).
 *
 *   npm run smoke:staff-invites
 */
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'drawbridge-invite-'));
process.env.CALL_RECORDS_DIR = TMP;
process.env.AUDIT_DIR = TMP;
process.env.DRAWBRIDGE_USERS_FILE = path.join(TMP, 'users');
process.env.DRAWBRIDGE_STAFF_ACCOUNTS_FILE = path.join(TMP, 'staff-accounts.json');
process.env.DRAWBRIDGE_SESSION_SECRET = 'smoke-session-secret-0123456789abcdef';
process.env.DRAWBRIDGE_LOGIN_IP_MAX_FAILS = '1000';
delete process.env.DRAWBRIDGE_USERNAME;
delete process.env.DRAWBRIDGE_PASSWORD;
delete process.env.DRAWBRIDGE_REQUIRE_TOTP;
delete process.env.NODE_ENV;
delete process.env.HELPDESK_SMTP_URL;
delete process.env.DRAWBRIDGE_PUBLIC_URL;

import assert from 'assert';
import type { AddressInfo } from 'net';

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;

const ADMIN_PW = 'copper lantern meadow 41';
const NEW_PW = 'violet harbor tundra 77';

async function main(): Promise<void> {
  const shell = await import('../platform/shell');
  const auth = await import('../platform/staff-auth');
  const accountsMod = await import('../platform/staff-accounts');
  const mail = await import('../platform/staff-invite-mail');
  const { staffModule } = await import('../platform/modules/staff');
  const express = (await import('express')).default;
  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`PASS ${label}`);
  };
  const quiet = { warn: console.warn, log: console.log, error: console.error };
  console.warn = () => undefined;
  console.error = () => undefined;
  console.log = (...a: unknown[]) => {
    if (!/^\[SECURITY\]/.test(String(a[0]))) quiet.log(...a);
  };

  const adminSecret = auth.newTotpSecret();
  fs.writeFileSync(process.env.DRAWBRIDGE_USERS_FILE!, `${shell.hashStaffPassword('lee.admin', ADMIN_PW)}:totp=${adminSecret}:role=admin\n`);
  const store = shell.staffAccounts;
  const accountsFile = process.env.DRAWBRIDGE_STAFF_ACCOUNTS_FILE!;
  const codeAt = (secret: string) => auth.totpCode(secret, Math.floor(Date.now() / 30_000));
  const secretOf = (otpauth: string) => decodeURIComponent((otpauth.match(/secret=([A-Z2-7]+)/) || [])[1] || '');

  const app = express();
  app.use('/app', shell.shellRouter());
  app.get('/app', shell.requireLogin, (req: any, res) => res.send(`home ${req.drawbridgeUser}`));
  app.use('/app/staff', shell.requireLogin, express.urlencoded({ extended: false }), staffModule.appRouter!({} as any));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
  const post = (p: string, body: Record<string, string>, cookie = '') =>
    fetch(`${url}${p}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: form(body) });
  const cookieOf = (r: Response) => (r.headers.get('set-cookie') || '').split(';')[0];

  try {
    // 1. Store: an invitation is a hashed, single-use, 24-hour link; nothing can sign in until setup is finished.
    const inv = store.invite({ email: 'Pat.Nurse@Example.test', name: 'Pat Nurse', role: 'staff', by: 'lee.admin' }, shell.serverStaffNames());
    assert.ok(inv.ok);
    const token = inv.ok ? inv.token : '';
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const raw = fs.readFileSync(accountsFile, 'utf8');
    assert.ok(!raw.includes(token) && raw.includes(accountsMod.hashInviteToken(token)), 'only the token hash is stored');
    assert.strictEqual((fs.statSync(accountsFile).mode & 0o777).toString(8), process.platform === 'win32' ? (fs.statSync(accountsFile).mode & 0o777).toString(8) : '600');
    assert.strictEqual(store.activeEntries().size, 0, 'an invited person cannot sign in');
    assert.deepStrictEqual(store.list().map((a) => [a.user, a.status]), [['pat.nurse@example.test', 'invited']], 'email is the lower-cased username');
    assert.deepStrictEqual(
      store.invite({ email: 'lee.admin', name: 'x', role: 'staff', by: 'lee.admin' }, shell.serverStaffNames()),
      { ok: false, error: 'Enter a valid email address.' }
    );
    fs.appendFileSync(process.env.DRAWBRIDGE_USERS_FILE!, `${shell.hashStaffPassword('ops@example.test', ADMIN_PW)}:totp=${auth.newTotpSecret()}\n`);
    const clash = store.invite({ email: 'ops@example.test', name: 'Ops', role: 'admin', by: 'lee.admin' }, shell.serverStaffNames());
    assert.ok(!clash.ok && /managed on the server/.test(clash.error), 'a server-managed name cannot be invited');
    ok('store: hashed single-use token, invited people cannot sign in, email usernames, server logins protected');

    // 2. Public pages: password (policy, match), then QR, then the first code signs them in.
    let r = await post('/app/invite', { t: token, p: 'short', p2: 'short' });
    assert.strictEqual(r.status, 422);
    assert.match(await r.text(), /at least 12 characters/);
    r = await post('/app/invite', { t: token, p: NEW_PW, p2: NEW_PW + 'x' });
    assert.match(await r.text(), /do not match/);
    r = await post('/app/invite', { t: 'A'.repeat(43), p: NEW_PW, p2: NEW_PW });
    assert.strictEqual(r.status, 400, 'unknown link: generic refusal');
    r = await post('/app/invite', { t: token, p: NEW_PW, p2: NEW_PW });
    assert.strictEqual(r.status, 200);
    const qrPage = await r.text();
    assert.match(qrPage, /<img src="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+"/, 'the QR code is an image');
    assert.ok(!/otpauth:|secret=/.test(qrPage), 'no setup key or link as text');
    assert.strictEqual(store.activeEntries().size, 0, 'still not active after the password step');
    const otpauth = store.pendingOtpauth(token)!;
    const secret = secretOf(otpauth);
    assert.ok(secret.length >= 16);
    r = await post('/app/invite/confirm', { t: token, otp: '000000' });
    assert.strictEqual(r.status, 422, 'a wrong first code shows the QR again');
    assert.match(await r.text(), /did not work/);
    offset += 31_000;
    r = await post('/app/invite/confirm', { t: token, otp: codeAt(secret) });
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.get('location'), '/app');
    const cookie = cookieOf(r);
    assert.match(cookie, /^__Host-drawbridge_session=/);
    assert.strictEqual(await (await fetch(`${url}/app`, { headers: { cookie } })).text(), 'home pat.nurse@example.test', 'signed in right away');
    r = await post('/app/invite', { t: token, p: NEW_PW, p2: NEW_PW });
    assert.strictEqual(r.status, 400, 'the link works once');
    const sign = await post('/app/login', { u: 'pat.nurse@example.test', p: NEW_PW, otp: (offset += 31_000, codeAt(secret)), next: '/app' });
    assert.strictEqual(sign.headers.get('location'), '/app', 'normal sign-in afterwards: email, password, code');
    ok('pages: password policy and match, QR image only (no key as text), first code activates and signs in, link single use, normal sign-in after');

    // 3. Expiry, setup window and the five-wrong-codes limit.
    const inv2 = store.invite({ email: 'sam.front@example.test', name: 'Sam Front', role: 'staff', by: 'lee.admin' }, new Set());
    const t2 = inv2.ok ? inv2.token : '';
    offset += 24 * 3600_000 + 1000;
    assert.ok(!store.setPassword(t2, NEW_PW, NEW_PW).ok, 'expired after 24 hours');
    assert.strictEqual(store.list().find((a) => a.user === 'sam.front@example.test')!.status, 'invitation expired');
    const inv3 = store.invite({ email: 'sam.front@example.test', name: 'Sam Front', role: 'staff', by: 'lee.admin' }, new Set());
    const t3 = inv3.ok ? inv3.token : '';
    assert.ok(!store.setPassword(t2, NEW_PW, NEW_PW).ok, 'a new invitation replaces the old link');
    assert.ok(store.setPassword(t3, NEW_PW, NEW_PW).ok);
    offset += accountsMod.SETUP_WINDOW_MS + 1000;
    const late = store.confirm(t3, '123456');
    assert.ok(!late.ok && /timed out/.test(late.error));
    assert.ok(store.setPassword(t3, NEW_PW, NEW_PW).ok, 'start over with the same link');
    for (let i = 1; i < accountsMod.MAX_INVITE_ATTEMPTS; i++) assert.ok(!store.confirm(t3, '000000').ok);
    const fifth = store.confirm(t3, '000000');
    assert.ok(!fifth.ok && fifth.ended, 'the fifth wrong code ends the invitation');
    assert.ok(!store.setPassword(t3, NEW_PW, NEW_PW).ok);
    ok('limits: 24-hour link, newest invitation wins, 15-minute setup window, five wrong codes end it');

    // 4. Re-invite (reset) turns the old sign-in off now and keeps the password history; remove ends the login.
    assert.ok(store.activeEntries().has('pat.nurse@example.test'));
    const reset = store.invite({ email: 'pat.nurse@example.test', name: 'Pat Nurse', role: 'staff', by: 'lee.admin' }, new Set());
    assert.ok(reset.ok && reset.reinvite);
    assert.ok(!store.activeEntries().has('pat.nurse@example.test'), 'old password and authenticator off at once');
    const again = store.setPassword(reset.ok ? reset.token : '', NEW_PW, NEW_PW);
    assert.ok(!again.ok && /not used for this login before/.test(again.error), 'no reuse of an earlier password');
    assert.ok(store.remove('pat.nurse@example.test') && !store.list().some((a) => a.user === 'pat.nurse@example.test'));
    ok('reset: old sign-in off at once, password history kept; remove deletes the login');

    // 5. Staff logins screen: administrators only; mail not configured → the login is kept and the screen says so.
    offset += 31_000;
    const adminLogin = await post('/app/login', { u: 'lee.admin', p: ADMIN_PW, otp: codeAt(adminSecret), next: '/app' });
    const adminCookie = cookieOf(adminLogin);
    const staffInv = store.invite({ email: 'kim.staff@example.test', name: 'Kim Staff', role: 'staff', by: 'lee.admin' }, new Set());
    assert.ok(store.setPassword(staffInv.ok ? staffInv.token : '', NEW_PW, NEW_PW).ok);
    const kimSecret = secretOf(store.pendingOtpauth(staffInv.ok ? staffInv.token : '')!);
    offset += 31_000;
    const kim = await post('/app/invite/confirm', { t: staffInv.ok ? staffInv.token : '', otp: codeAt(kimSecret) });
    const kimCookie = cookieOf(kim);
    assert.strictEqual((await fetch(`${url}/app/staff`, { headers: { cookie: kimCookie } })).status, 403, 'staff role: refused');
    const screen = await fetch(`${url}/app/staff`, { headers: { cookie: adminCookie } });
    assert.strictEqual(screen.status, 200);
    const html = await screen.text();
    assert.ok(/Kim Staff/.test(html) && /Managed on the server/.test(html) && /Invitation email isn&#39;t set up|Invitation email isn't set up/.test(html));
    const sent = await post('/app/staff/invite', { name: 'Ray New', email: 'ray.new@example.test', role: 'staff' }, adminCookie);
    assert.strictEqual(sent.status, 502, 'mail not configured: reported, nothing silently lost');
    assert.ok(store.list().some((a) => a.user === 'ray.new@example.test' && a.status === 'invited'));
    assert.strictEqual(sent.headers.get('location'), null, 'no redirect: the email never goes into a URL');
    const self = await post('/app/staff/remove', { user: 'lee.admin' }, adminCookie);
    assert.strictEqual(self.status, 400);
    const rm = await post('/app/staff/remove', { user: 'kim.staff@example.test' }, adminCookie);
    assert.strictEqual(rm.status, 200);
    assert.strictEqual((await fetch(`${url}/app`, { redirect: 'manual', headers: { cookie: kimCookie } })).status, 302, 'removed: signed out at once');
    ok('screen: administrators only, failed email reported (login kept), no address in URLs, no self-removal, removal signs out');

    // 6. Email: settings required (https link), link in the fragment, no secrets in the message, TLS really required.
    const env = { HELPDESK_SMTP_URL: 'smtps://u:p@mail.example.test', HELPDESK_ALERT_FROM: 'monitor@example.test', DRAWBRIDGE_PUBLIC_URL: 'https://portal.example.test/' } as unknown as NodeJS.ProcessEnv;
    assert.strictEqual(mail.inviteMailProblem(env), null);
    assert.ok(mail.inviteMailProblem({ ...env, DRAWBRIDGE_PUBLIC_URL: 'http://portal.example.test' }));
    assert.ok(mail.inviteMailProblem({ ...env, HELPDESK_SMTP_URL: 'smtps://u:p@mail.example.test/?tls.rejectUnauthorized=false' }));
    const msg = mail.inviteMessage({ to: 'a@example.test', name: 'A', invitedBy: 'lee.admin', token: 'T'.repeat(43), expiresAt: Date.now(), reset: false }, env);
    assert.ok(msg.text.includes(`https://portal.example.test/app/invite#${'T'.repeat(43)}`) && !msg.subject.includes('T'.repeat(10)));
    const o = mail.transportOptions({ ...env, HELPDESK_SMTP_URL: 'smtp://u:p@mail.example.test:587' } as unknown as NodeJS.ProcessEnv);
    assert.deepStrictEqual([o.secure, o.requireTLS, o.ignoreTLS, o.tls.rejectUnauthorized, o.tls.minVersion], [false, true, false, true, 'TLSv1.2']);
    const seen: string[] = [];
    const plain = net.createServer((sock) => {
      sock.write('220 plain.example.test ESMTP\r\n');
      sock.on('data', (buf) => {
        for (const line of buf.toString().split('\r\n').filter(Boolean)) {
          seen.push(line.split(' ')[0].toUpperCase());
          if (/^EHLO/i.test(line)) sock.write('250-plain.example.test\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n');
          else sock.write('250 ok\r\n');
        }
      });
    });
    await new Promise<void>((res) => plain.listen(0, '127.0.0.1', () => res()));
    const sentPlain = await mail.sendStaffInvite(
      { to: 'a@example.test', name: 'A', invitedBy: 'lee.admin', token: 'T'.repeat(43), expiresAt: Date.now(), reset: false },
      { ...env, HELPDESK_SMTP_URL: `smtp://user:secret@127.0.0.1:${(plain.address() as AddressInfo).port}` } as unknown as NodeJS.ProcessEnv
    );
    plain.close();
    assert.strictEqual(sentPlain, false);
    assert.ok(!seen.includes('AUTH') && !seen.includes('MAIL') && !seen.includes('DATA'), `plaintext server saw ${seen.join(',')}`);
    ok('email: https link in the fragment, no secrets in the message, TLS required and verified (plaintext server gets nothing)');
  } finally {
    server.close();
    await (await import('../platform/audit')).flushAudit();
    Object.assign(console, quiet);
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log(`${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
