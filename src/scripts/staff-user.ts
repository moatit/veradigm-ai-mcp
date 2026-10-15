/**
 * One line for DRAWBRIDGE_USERS_FILE (named staff logins), from a username and a password read on stdin.
 *
 *   npm run staff:user -- <username>                 then type the password and press Enter
 *   npm run staff:user -- <username> --totp          same, plus a second factor (authenticator app)
 *   node dist/scripts/staff-user.js <username> >> users      (data-center container)
 *
 * Prints "username:scrypt$N$r$p$salt$hash" (with ":totp=<secret>" when --totp) on stdout. The password
 * is never printed or stored in clear. With --totp the otpauth:// link for the authenticator app is
 * printed ONCE on stderr (so `>> users` does not capture it): add it to the app, then discard it.
 *
 * Password policy (staff-auth.ts passwordProblem): at least 12 characters, not a common password or
 * a common word with digits/symbols added, not a keyboard/number sequence, not containing the username.
 * Rotation: change a password when someone may have seen it, when a person leaves a shared role, and
 * at least yearly; replace the person's line (old sessions end at once). Remove a person by deleting
 * their line; they are signed out at once.
 */
import { hashStaffPassword } from '../platform/shell';
import { newTotpSecret, otpauthUrl } from '../platform/staff-auth';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const totp = args.includes('--totp');
  const user = args.find((a) => !a.startsWith('--')) || '';
  if (process.stdin.isTTY) process.stderr.write(`Password for ${user} (12+ characters, not a common password): `);
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) {
    chunks.push(c as Buffer);
    if (Buffer.concat(chunks).includes(10)) break;
  }
  const password = Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
  try {
    let line = hashStaffPassword(user, password);
    if (totp) {
      const secret = newTotpSecret();
      line += `:totp=${secret}`;
      process.stderr.write(`\nAdd this to ${user}'s authenticator app now (shown once, not stored anywhere else):\n${otpauthUrl(user, secret)}\n\n`);
    }
    process.stdout.write(line + '\n');
  } catch (e: any) {
    console.error(`FAIL ${e?.message || 'error'}`);
    process.exitCode = 2;
  }
}

main();
