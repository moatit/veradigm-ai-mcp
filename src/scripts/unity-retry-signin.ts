/**
 * Operator: clear the Veradigm sign-in latch (docs/drawbridge/VERADIGM_SIGNIN_LATCH.md) on a host without the
 * "Veradigm connection" screen (intake shadow server, developer machine). Uses the same .env and data
 * directory (CALL_RECORDS_DIR) as the servers, which pick the change up at their next Veradigm call.
 * Sends nothing to Veradigm. Only after the credentials are fixed or Veradigm unlocked the account.
 *
 *   npm run unity:retry-signin -- PM|EHR|all
 */
import * as os from 'os';

async function main(): Promise<void> {
  const arg = String(process.argv[2] || '').toUpperCase();
  if (!['PM', 'EHR', 'ALL'].includes(arg)) {
    console.log('Usage: npm run unity:retry-signin -- PM|EHR|all');
    process.exit(2);
  }
  const { UnityAuthService } = await import('../unity/services/unity-auth.service');
  const auth = new UnityAuthService();
  const before = auth.latchedTargets();
  if (!before.length) {
    console.log('No Veradigm sign-in is stopped for the configured credentials.');
    return;
  }
  for (const l of before) console.log(`${l.target}: stopped since ${l.at} (Veradigm refused ${l.stage}: ${l.reason})`);
  const cleared = auth.retrySignIn(arg === 'ALL' ? undefined : (arg as 'PM' | 'EHR'), `cli:${os.userInfo().username}`);
  console.log(cleared.length ? `Cleared: ${cleared.join(', ')}. The next Veradigm call signs in once.` : `${arg} was not stopped.`);
}

main().catch((e) => {
  console.error(`unity:retry-signin failed: ${e?.message || e}`);
  process.exit(1);
});
