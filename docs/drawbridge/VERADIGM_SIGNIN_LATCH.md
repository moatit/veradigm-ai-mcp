# Runbook: Veradigm® sign-in stopped (auth latch)

## What it is

When Veradigm refuses Drawbridge's sign-in for a reason that retrying won't fix, Drawbridge stops signing in to that system (Veradigm® PM or Veradigm® EHR). This prevents repeated failed logins from locking the clinic's account. Code: `src/unity/services/unity-auth.service.ts` and `unity-auth-latch.ts`.

These refusals latch:

- `GetUserAuthentication` answers ValidUser other than YES (wrong or expired EHR/PM password, locked account).
- `GetUserAuthentication` returns HTTP 401/403 or an error that says access is denied, and it is not a token problem.
- The fresh token is refused again after the one fresh-token retry.
- `GetToken` returns HTTP 401/403, or a JSON or WCF fault that says access is denied or the credentials are invalid (bad Unity service credentials).

These never latch: network errors, timeouts, HTTP 408/429, HTML error pages and 5xx replies without such a fault.

## What happens while it is latched

- Every caller gets an immediate local `AUTH_ERROR`: health probe, keep-warm, phone-agent tools, intake and staff screens. **Nothing is sent to Veradigm for that system.** The phone agent takes messages as during any outage.
- The system shows DOWN with "sign-in stopped" on the status banner and the **Veradigm connection** screen. The MOATiT help desk gets one alert. The intake shadow server alerts the help desk directly.
- Two events go to the audit log: the security event `unity_signin_latched` (code PM/EHR) and a `[SECURITY]` log line.
- The latch is saved in `<CALL_RECORDS_DIR>/unity-auth-latch.json` (mode 0600; default `./data`).
  - It survives restarts and crash loops.
  - Every Drawbridge process that uses the same directory honours it. The HTTP server re-reads the file every 30 s, so a latch set by another process turns its status DOWN at once.
  - The file holds no password: only an scrypt fingerprint of the refused credentials, made with a random salt.
  - Writes are rare (a refusal or a retry) and re-read the file before writing; there is no lock file.
- **Fails closed:** if the file can't be read or parsed, it is moved aside (`unity-auth-latch.json.bad-<time>`) and **every** system is latched with stage `unknown`, plus the security event `unity_signin_latched` with code `LATCH_FILE_UNREADABLE`. Clear it with a retry once the file problem is understood.

## One latch for every server that signs in with the same account

The main Drawbridge server and the intake shadow server (`deploy/datacenter`) both sign in to Veradigm. A latch only protects the account if every process that uses it sees the same latch. So either:

- give both servers the **same `CALL_RECORDS_DIR`** (the same volume on one host), or
- give each host **its own Veradigm EHR/PM user**, so a refusal on one can't lock the other's account.

Two hosts with separate directories but the same EHR user are not protected: each would send its own refused login.

## How to clear it

1. Find out why Veradigm refused the sign-in. The reason is on the Veradigm connection screen and in the `sign-in STOPPED` log line. Usually the EHR/PM password expired or changed, or the account is locked.
2. Fix the cause:
   - **New credentials:** update `.env` / SSM and restart. The latch applies only to the refused credentials, so it lifts by itself.
   - **Same credentials, Veradigm unlocked or reset the account:** an administrator presses **Retry sign-in** on **Veradigm connection**. On a host without that screen (intake shadow server, developer machine), run `npm run unity:retry-signin -- PM|EHR|all`, or `node dist/scripts/unity-retry-signin.js PM|EHR|all` in the container. Both log the operator and write the security event `unity_signin_retry`.
3. The next Veradigm call signs in once. If Veradigm refuses again, the latch engages again and nothing else is sent.

Don't delete the latch file to "see if it works now". That sends a refused login and moves the account closer to lockout.
