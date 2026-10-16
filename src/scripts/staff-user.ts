/**
 * One line for DRAWBRIDGE_USERS_FILE (named staff logins), from a username and a password read on stdin.
 *
 *   npm run staff:user -- <username> --totp          new login, or re-enrol a lost authenticator: new TOTP secret
 *   npm run staff:user -- <username>                 password change (every 90 days): keeps the TOTP secret on file
 *   npm run staff:user -- <username> --totp --admin  administrator (privacy/security officer: disclosure reports)
 *   npm run staff:user -- <username> --totp --emergency   sealed break-glass login (see HIPAA_TECHNICAL_SAFEGUARDS.md)
 *   node dist/scripts/staff-user.js <username> --totp >> users      (data-center container)
 *
 * Options: --file <path> is the current users file (default DRAWBRIDGE_USERS_FILE). When it holds a line for
 * this username, the new password must differ from that person's last 5 passwords, the TOTP secret and role are
 * kept unless --totp / --admin / --emergency / --staff say otherwise, and the old hash goes into the history.
 *
 * Prints "username:scrypt$N$r$p$salt$hash:totp=<secret>:pwset=<today>[:hist=...][:role=...]" on stdout. Replace
 * the person's old line with it (a later line for the same name also wins). The password is never printed or
 * stored in clear. With --totp the otpauth:// link for the authenticator app is printed ONCE on stderr (so
 * `>> users` does not capture it): add it to the app, then discard it.
 *
 * TOTP is mandatory (DRAWBRIDGE_REQUIRE_TOTP): a line without a secret cannot sign in, so without --totp and
 * without a secret on file the script refuses. Passwords expire after DRAWBRIDGE_PASSWORD_MAX_AGE_DAYS (90).
 * Password policy (staff-auth.ts passwordProblem): at least 12 characters, not a common password or a common word
 * with digits/symbols added, not a keyboard/number sequence, not containing the username. Remove a person by
 * deleting their line; they are signed out at once.
 */
import * as fs from 'fs';
import { hashStaffPassword, verifyStaffPassword } from '../platform/shell';
import {
  formatStaffLine,
  newTotpSecret,
  otpauthUrl,
  parseStaffLine,
  PASSWORD_HISTORY,
  passwordMaxAgeDays,
  requireTotp,
  StaffEntry,
  StaffRole,
} from '../platform/staff-auth';

/** The last line for `user` in a users file, or null (no file, unreadable, or no such line). */
function currentEntry(file: string, user: string): StaffEntry | null {
  if (!file) return null;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let found: StaffEntry | null = null;
  for (const line of text.split(/\r?\n/)) {
    const p = parseStaffLine(line);
    if (p && p.user === user.toLowerCase()) found = p.entry;
  }
  return found;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (f: string) => args.includes(f);
  const fileIdx = args.indexOf('--file');
  const file = fileIdx >= 0 ? args[fileIdx + 1] || '' : String(process.env.DRAWBRIDGE_USERS_FILE || '').trim();
  const user = args.find((a, i) => !a.startsWith('--') && !(fileIdx >= 0 && i === fileIdx + 1)) || '';
  if (process.stdin.isTTY) process.stderr.write(`Password for ${user} (12+ characters, not a common password): `);
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) {
    chunks.push(c as Buffer);
    if (Buffer.concat(chunks).includes(10)) break;
  }
  const password = Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
  try {
    const fresh = parseStaffLine(hashStaffPassword(user, password))!.entry; // policy check + hash + pwset
    const old = currentEntry(file, user);
    if (old && [old.hash, ...old.hist].some((h) => verifyStaffPassword(h, password))) {
      throw new Error(`password: must differ from the last ${PASSWORD_HISTORY} passwords of ${user}`);
    }
    const role: StaffRole = flag('--admin') ? 'admin' : flag('--emergency') ? 'emergency' : flag('--staff') ? 'staff' : old?.role || 'staff';
    const totp = flag('--totp') ? newTotpSecret() : old?.totp;
    if (!totp && requireTotp()) {
      throw new Error(`no authenticator on file for ${user}: add --totp (every login needs a TOTP code)`);
    }
    const entry: StaffEntry = {
      ...fresh,
      ...(totp ? { totp } : {}),
      hist: old ? [old.hash, ...old.hist].slice(0, PASSWORD_HISTORY - 1) : [],
      role,
    };
    if (flag('--totp')) {
      process.stderr.write(`\nAdd this to ${user}'s authenticator app now (shown once, not stored anywhere else):\n${otpauthUrl(user, totp!)}\n\n`);
    }
    if (old) process.stderr.write(`Replace ${user}'s line in the users file with the line below (their sessions end at once).\n`);
    process.stderr.write(`The password expires in ${passwordMaxAgeDays()} days.\n`);
    process.stdout.write(formatStaffLine(user.toLowerCase(), entry) + '\n');
  } catch (e: any) {
    console.error(`FAIL ${e?.message || 'error'}`);
    process.exitCode = 2;
  }
}

main();
