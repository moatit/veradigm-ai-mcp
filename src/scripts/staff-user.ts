/**
 * One line for DRAWBRIDGE_USERS_FILE (named staff logins), from a username and a password read on stdin.
 *
 *   npm run staff:user -- <username>                 then type the password and press Enter
 *   node dist/scripts/staff-user.js <username> >> users      (data-center container)
 *
 * Prints "username:scrypt$N$r$p$salt$hash". The password is never printed or stored in clear.
 * Remove a person by deleting their line; they are signed out at once.
 */
import { hashStaffPassword } from '../platform/shell';

async function main(): Promise<void> {
  const user = process.argv[2] || '';
  if (process.stdin.isTTY) process.stderr.write(`Password for ${user} (12+ characters): `);
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) {
    chunks.push(c as Buffer);
    if (Buffer.concat(chunks).includes(10)) break;
  }
  const password = Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
  try {
    process.stdout.write(hashStaffPassword(user, password) + '\n');
  } catch (e: any) {
    console.error(`FAIL ${e?.message || 'error'}`);
    process.exitCode = 2;
  }
}

main();
