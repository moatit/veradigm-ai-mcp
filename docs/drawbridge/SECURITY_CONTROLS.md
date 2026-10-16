# Drawbridge security controls

This document describes the security controls Drawbridge has in code as of branch `drawbridge/cert-hardening`, as evidence for the Veradigm Vendor Security Questionnaire. The HIPAA safeguard-by-safeguard checklist (with file and line evidence) is `HIPAA_TECHNICAL_SAFEGUARDS.md`; staff and clinics see the same list on the **HIPAA & Compliance** screen. It states what the code does. Controls that depend on how Drawbridge is hosted are marked **Deployment requirement**, and the current AWS gaps are listed at the end.

Drawbridge has three server processes:

- **Unity server** (`src/unity/unity-test-server.ts`, port 3001): the phone-agent tools for Veradigm® PM and Veradigm® EHR, plus the staff app (`/app`).
- **FHIR server** (`src/test-server.ts`, port 3000): read-only Veradigm® EHR FHIR tools.
- **Intake shadow server** (`src/platform/shadow-server.ts`): document intake only, with Veradigm read-only.

## 1. Authentication and access control

### 1.1 Staff app (`/app`, `src/platform/shell.ts`, `src/platform/staff-auth.ts`)

| Control | As implemented |
|---|---|
| Accounts | Named staff logins in `DRAWBRIDGE_USERS_FILE`, one line per person, with a role (`staff`, `admin` for the privacy/security officer, `emergency` for the sealed break-glass login). A single shared login (`DRAWBRIDGE_USERNAME` / `DRAWBRIDGE_PASSWORD`) exists only for local development: it is refused whenever the users file is set, whenever TOTP is required (the default) and always in production. |
| Password storage | scrypt (N=16384, r=8, p=1, 16-byte random salt, 32-byte hash). Clear-text passwords are never stored or logged. Verification is constant-time. |
| Password policy | Enforced when a login is created (`npm run staff:user -- <name>`). At least 12 and at most 256 characters. Common passwords are refused, including common words with digits or symbols added and leetspeak (`P@ssw0rd2026!`). So are keyboard and number sequences, passwords with fewer than 4 distinct characters, and passwords that contain the username. |
| Password expiry and history | Passwords expire `DRAWBRIDGE_PASSWORD_MAX_AGE_DAYS` (90) days after `:pwset=`; a line without a date counts as expired. After the right password and code an expired login is refused with a message to contact the administrator, and open sessions end. `npm run staff:user -- <name>` re-issues it: it reads the current line, refuses any of the last 5 passwords (`:hist=` keeps the 4 previous hashes) and keeps the TOTP secret and role. Replacing the line ends the person's sessions at once. |
| Multi-factor (**mandatory**) | TOTP (RFC 6238: SHA-1, 6 digits, 30 s, ±1 step) for every staff login: `DRAWBRIDGE_REQUIRE_TOTP` defaults on and is forced on in production. A line without `:totp=` cannot sign in ("Two-factor sign-in is not set up", security event). Enrol with `npm run staff:user -- <name> --totp`, which adds `:totp=<secret>` and prints the `otpauth://` link once, on stderr. Each code works only once. |
| Brute-force lockout | 5 failed sign-ins for a username within 15 minutes lock that username for 15 minutes. This applies to any name typed, so a lock does not reveal whether the account exists. A client IP is locked after 30 failures in the window. Settings: `DRAWBRIDGE_LOGIN_MAX_FAILS`, `DRAWBRIDGE_LOGIN_WINDOW_MIN` and `DRAWBRIDGE_LOGIN_IP_MAX_FAILS`. While locked, even the right password is refused. Every failure gets the same message ("Wrong username or password.") after the same 800 ms delay. Lockouts are logged without the password. The counters are in memory, so a restart clears them. **Exception (launch audit 2026-10-16, open LOW):** the right password for a login without TOTP enrolled answers with the enrolment message instead, and an unknown name skips the scrypt check (about 20 ms faster). |
| Sessions | An HMAC-SHA256-signed cookie `__Host-drawbridge_session` (`DRAWBRIDGE_SESSION_SECRET`) set with `HttpOnly; Secure; SameSite=Strict; Path=/`, no Domain. It holds the user, the issue time and the last-activity time. A session ends after 15 minutes without a request (`DRAWBRIDGE_IDLE_MINUTES`, sliding) and 12 hours after sign-in no matter what (4 hours for the emergency login). Each signed-in page blanks itself and goes to the sign-in page when the idle time is up. Staff pages send `Strict-Transport-Security`. |
| Logout and revocation | Logout is server-side: it records a per-user "sessions valid after" time, so the cookie (and that user's sessions in other browsers) stops working even if it was copied. Removing a person from the users file, or changing their password, does the same. The revocation list is kept in memory and in `staff-sessions.json` (mode 0600, `DRAWBRIDGE_SESSIONS_FILE`), so it survives restarts. A name that is re-added does not bring old cookies back. **Limitation (launch audit 2026-10-16, open MEDIUM):** the comparison is with the users file the running process last read, so a password change or removal made while the server is stopped does not end cookies issued before; restart after such a change counts on the 12-hour limit. |
| Page security headers | Every staff page sends a Content-Security-Policy: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`. There is no inline script or inline event handler. Page behaviour is in `/app/assets/drawbridge.js`. Inline *styles* are allowed because the pages use style attributes. Every staff page also sends `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. Everything rendered is HTML-escaped. |
| Cross-site requests | State changes are POSTs carrying a `SameSite=Strict` cookie. Because SameSite still sends the cookie from sibling subdomains of the same site, every non-GET request under `/app` (sign-in included) must also be same-origin: `Sec-Fetch-Site` `same-origin`/`none`, or without it an `Origin` naming this host (`Host`, `X-Forwarded-Host` or `DRAWBRIDGE_PUBLIC_URL`); otherwise 403 and a `cross_site_request` security event (`shell.ts` `sameOriginRequest`). CORS sends no headers unless an origin is on the allow-list (see 1.3). |

### 1.2 Machine endpoints (phone agent, webhooks, test and diagnostics routes)

| Control | As implemented |
|---|---|
| Shared tool key | Every tool route needs the `x-drawbridge-key` header to match `DRAWBRIDGE_TOOL_KEY` (SHA-256 then constant-time compare). This covers MCP JSON-RPC `POST /`, Retell `POST /api/retell`, module APIs `/api/<module>`, `GET /tools`, `/test/*` and `/diagnostics/veradigm`. **Fails closed**: if the key is unset, these routes return `503 {"error":"not configured"}`. **Phone agent key:** `POST /api/retell` (both servers) uses `requireAgentKey`: with `DRAWBRIDGE_AGENT_KEY` set it accepts only that key, and that key opens no other route (MCP, `/tools`, test, diagnostics, module APIs, FHIR REST, staff pages all answer 401 or the sign-in page; `smoke:endpoints`). Unset, `/api/retell` falls back to `DRAWBRIDGE_TOOL_KEY` with a warning. Set it, and switch the Retell custom-function header to it, so the key stored in Retell is dedicated. |
| FHIR server routes | `/mcp/*`, `/tools*`, `/test/*` and `/api/*` all need the key. That covers every route that lists tools or returns or acts on patient data (patient, medication, clinical, appointment, provider, location). |
| Health checks | `GET /health` is open and returns only `{status, timestamp}`. It shows no Veradigm endpoint, app name or environment. |
| Webhooks | Retell call events need Retell's `x-retell-signature` (same check as the inbound-call webhook below) or a shared secret header. MOATiT Fax deliveries need an HMAC-SHA256 over the raw body. Both return 503 until their secret is configured, and 401 for a bad signature. |
| Inbound-call webhook | `POST /webhooks/retell-inbound` (set per phone number in Retell) answers with the call's dynamic variables only (`call_mode`, `records_status`, `fhir_tools`), no patient data. It needs Retell's `x-retell-signature` (HMAC-SHA256 of the raw body bytes plus timestamp with `RETELL_WEBHOOK_API_KEY`, the Retell key with the "webhook" badge, falling back to `RETELL_API_KEY`; timestamp within 5 minutes, constant-time compare; the rejection reason is logged without the key or body) or the shared secret header. 503 when neither is configured, 401 and a `webhook_rejected` event for a bad signature. |
| Admin portal client keys | When `ADMIN_PORTAL_URL` is set and a caller sends `x-api-key`, the FHIR server's MCP endpoint checks that key and the client's FHIR/Unity permissions with the admin portal. |

### 1.2a Phone agent: identity before information, enforced per call (`src/platform/call-binding.ts`)

The voice prompt tells the agent to verify the caller first, but the server no longer relies on that. On the agent tool endpoints of both servers (Retell `POST /api/retell`, MCP `tools/call` on the Unity server, MCP `POST /`, `/mcp/tools/call` and `/tools/call` on the FHIR server), every tool call is checked against a per-call verification binding. Staff screens, module APIs and internal calls (document intake, the huddle, pre-visit and upcoming-visit lookups) call the tools directly and are not affected.

| Control | As implemented |
|---|---|
| Call key | The Retell call ID from the request body (`call.call_id`); on MCP the `x-call-id` header (or a `call_id` argument). A tool that touches a patient record is refused with `CALL_ID_MISSING` when there is none. Lookups without patient data (visit types, cancellation reasons, providers, clinic hours, open times without a patient, line mode, messages) still run. |
| Verification | A patient becomes verified for that call only when `unity_search_patients` (FHIR server: `verify_patient_identity`) was given first name, last name **and** date of birth and found exactly one patient whose first name, last name and date of birth are exactly what was given (letters compared, case, spaces, hyphens and apostrophes ignored; the first word of a two-word first name counts). A spelling variant, a nickname or one part of a double last name is read back (name and spelling, no identifiers, no visits) and binds nothing until a search with exactly the record's spelling. Two different patients with the same name and DOB are never merged into one search row, so they are "more than one". The call then holds that patient's IDs (Veradigm® PM patient ID, Veradigm® EHR chart ID, or the FHIR ID) and the time, in memory only, for `DRAWBRIDGE_CALL_BINDING_TTL_MIN` (120) minutes. No names or birth dates are stored; nothing is written to disk. |
| Patient-scoped tools | Visits, open times for a patient, booking, cancel, confirm, visit details, balance, insurance, demographics updates, recalls, the pre-visit check, the outreach context (`verifiedPatientId`), medications, allergies, problems, diagnoses, results, staff tasks, `unity_get_patient` and the FHIR chart tools run only for an ID verified on this call, in the right system (PM IDs for scheduling and billing, chart IDs for the chart and staff tasks). A verified patient's PM ID given to a chart tool (or the reverse) is mapped to the same patient's ID in that system, never to anyone else's. Anything else: `NOT_VERIFIED`, nothing is sent to Veradigm®. |
| Appointment IDs | Cancel, confirm and visit details run only with a verified patient ID (filled in when the call has exactly one verified patient; with two the agent must say whose visit it is), and the tool itself reads that patient's schedule (`GetScheduleByPatientID`) and refuses a visit that is not on it. `GetAppointmentById` (no owner check) is never used by the agent. FHIR appointment-by-ID tools are refused on patient calls. |
| Family member | Up to `DRAWBRIDGE_CALL_MAX_VERIFIED_PATIENTS` (2) patients per call, each verified with their own name and date of birth: a parent can handle a child's visit. A third is refused (`VERIFIED_LIMIT`), and the search result carries no identifiers. |
| Enumeration | At most `DRAWBRIDGE_CALL_MAX_SEARCHES` (5) identity searches per call (`unity_search_patients`, `unity_get_patient_by_mrn`, `verify_patient_identity`, `search_patient`); the next is refused without running (`SEARCH_LIMIT`, security event code `POSSIBLE_ENUMERATION`). A search without all three of first name, last name and date of birth, or one that matches more than one patient, returns no identifiers and verifies no one. FHIR `search_patient` never returns identifiers to the agent. An MRN lookup returns a record only when it is a patient already verified on the call. |
| Registration | `unity_save_patient` without a patient ID (new patient) is allowed and binds the new patient to the call (within the cap). With an existing patient ID it needs that patient verified. |
| After-hours record | `drawbridge_save_call_record` that claims a patient not verified on this call is saved as an unverified message (no patient, no chart items). `drawbridge_take_message` stores the caller's statement, marked unverified, and needs no verification. |
| Unknown tools | A tool without a rule that names a patient (`patientId`, `chartPatientId`, `verifiedPatientId`, an appointment ID or MRN) is refused unless that patient is verified on the call (fail closed). |
| Logging | Each refusal is one tool audit line (error code) and one security event (`agent_not_verified`, `agent_verified_limit`, `agent_search_limit`, `agent_no_call_id`) with the call ID, the tool and the requested patient ID, never a name. |

The agent hears `TOOL_ERROR (NOT_VERIFIED, retryable=no) ... Verify the caller first ...` (or the matching text for the other codes), never "I'm having trouble". Residual reliance on the prompt: see section 12.

### 1.3 CORS

`DRAWBRIDGE_CORS_ORIGINS` is an exact-match allow-list of browser origins. When it is unset (the default), no CORS headers are sent, so browsers allow same-origin calls only. Wildcard `*` is not accepted. Retell calls server to server and is not affected.

## 2. Veradigm integration

- **Credentials**: the Unity service account and the EHR/PM user logins come only from the environment (`.env` locally, AWS SSM in AWS). They are never logged. Production (`NODE_ENV=production`) refuses to start unless `UNITY_UBIQUITY_ENDPOINT`, `UNITY_UBIQUITY_ID_PM` and `UNITY_UBIQUITY_ID_EHR` are set, so it never falls back to the sandbox.
- **Tokens**: one `GetToken` + `GetUserAuthentication` per system, shared by concurrent callers. A token is reused for at most `UNITY_TOKEN_CACHE_TTL` − `UNITY_TOKEN_REFRESH_BUFFER` seconds. A token Veradigm rejects is dropped and replaced once. A wrong password is never retried, so the account can't be locked out. Tokens are retired (`RetireToken`) on graceful shutdown. GetToken, GetUserAuthentication, RetireToken and every action time out after 30 s.
- **Least privilege by design**: Drawbridge calls a fixed list of actions, which is `docs/drawbridge/UNITY_ACTIONS_FOR_CERTIFICATION.md`. The phone agent's only writes are `SaveAppointment`, `SetAppointmentStatus`, `SavePatient` and `SaveTask`. Document filing (`SaveScanDocument`) is staff-side only and off by default (`INTAKE_FILING`). In shadow mode the Veradigm connection is locked to read actions in code.
- **Required diagnostics**: `GetServerInfo` runs at start and every 6 h. `LastLogs` runs after Veradigm-side errors, rate-limited and without loops. Results go to the server log and the staff screen "Veradigm connection", with only product, version and time zone kept, and log messages scrubbed.
- **Auth latch** (`unity-auth.service.ts`, runbook `VERADIGM_SIGNIN_LATCH.md`): when Veradigm refuses a sign-in for a reason a retry can't fix (`GetUserAuthentication` answers ValidUser other than YES, a 401/403 or an access-denied reply; a fresh token refused again; `GetToken` 401/403 or a JSON/WCF access-denied fault), that system is latched. Every caller (health probe, keep-warm, phone-agent tools, intake, staff screens) then gets an immediate local `AUTH_ERROR` and nothing is sent to Veradigm. Logins of one system run one at a time and re-check the latch, so a race can't send a second refused login. The system is marked DOWN at once (one help-desk alert; the intake shadow server alerts the help desk itself), a late success of an older call doesn't mark it UP, and the security event `unity_signin_latched` is written. The latch is saved in `<CALL_RECORDS_DIR>/unity-auth-latch.json` (0600, an scrypt fingerprint of the refused credentials with a random salt, never a password), so restarts and crash loops don't retry and every process using that directory honours it. It lifts when the credentials change, or when an administrator presses **Retry sign-in** ("Veradigm connection") or runs `npm run unity:retry-signin` (security event `unity_signin_retry` with the user). A plain HTTP 401 at `GetUserAuthentication` (often a stale token) gets one retry with a fresh token; a second 401 latches. If the latch file can't be read it fails closed: every system is latched (stage `unknown`, security event code `LATCH_FILE_UNREADABLE`) and the file is moved aside. Every GetToken / GetUserAuthentication / RetireToken request has a hard deadline (`UNITY_AUTH_TIMEOUT_MS`), so a never-ending reply can't hold the one-login-at-a-time queue. Network errors, timeouts, HTML error pages and 5xx without a denial fault never latch. Refusal text is scrubbed (account names, dates, long numbers) before it is logged, thrown or shown.
- **Declared actions only**: `UnityService.executeAction` refuses any action that is not in `CERTIFIED_ACTIONS` (`unity-endpoints.ts`, the list in `UNITY_ACTIONS_FOR_CERTIFICATION.md`) with `ACTION_NOT_ALLOWED`, before any login or request, so a `UNITY_ACTION_*` override can't send an undeclared action. Each `UNITY_ACTION_<KEY>` may only repeat that key's declared name: any other value stops the server at start-up. The health probe always reads `GetServerInfo`.
- **Polling**: Veradigm is never polled more often than every 2 minutes (`INTAKE_OBSERVE_EVERY_MIN` and `UNITY_HEALTH_CHECK_MIN` are clamped).
- **Health check and system status** (`src/unity/services/unity-health.ts`, `src/platform/system-status.ts`): every 15 minutes by default (`UNITY_HEALTH_CHECK_MIN`, never below 2 minutes; a system probed, or answering a real call, in the last 2 minutes is skipped) each configured system is probed with the tools' own session (GetToken and GetUserAuthentication only when the cached token is due) plus `GetServerInfo`, which carries no patient data. Two failed probes in a row mark a system DOWN; one good probe or one successful real call marks it UP. While both systems are DOWN the phone agent's Veradigm tools answer `RECORDS_UNAVAILABLE` at once and the agent takes a message in Drawbridge's call record or transfers. Staff see a SYSTEM STATUS banner on every screen. The MOATiT help desk gets one alert when the connection goes down, a reminder every 4 hours while it stays down and one when it recovers (e-mail over TLS and/or an HTTPS webhook with an HMAC signature). Alerts carry system, times, error class, a scrubbed probe detail and the number of messages taken, never patient data. Every transition and alert is a security/ops event in the audit log.
- **Session keep-warm**: while calls ran in the last 30 minutes, a system's session is renewed 2 minutes before the cached token is due; the new session replaces the old one only after both GetToken and GetUserAuthentication succeed. A failed renewal is retried after 2 minutes, doubling up to 30 minutes. A wrong password is still never retried.
- **Errors are never empty results**: a failed call returns `{success:false, error_code, retryable}` to the agent, so it says "I'm having trouble" rather than "no appointments".
- **FHIR is read only** (system app, `client_secret` or `private_key_jwt`).

## 3. Logging and audit

### 3.1 Server logs (stdout/stderr)

- Request logs record the method, path and tool name only. Request and response bodies are never logged.
- No secrets: error logs carry the HTTP status, error code and a short message (`src/utils/safe-log.ts`). An axios error object is never logged, because its request body holds passwords, tokens and client secrets.
- Minimal PHI: no patient names, MRNs, dates of birth or appointment times. The per-call Unity log line has the action and the system, and a few tool lines keep an opaque patient ID for troubleshooting. Raw Veradigm and FHIR replies, and FHIR search parameters, are not logged.
- **Deployment requirement**: ship container logs to a log store with restricted access and a retention period.

### 3.2 Audit log (`src/platform/audit.ts`)

- One JSON line per agent or staff tool call, and per Veradigm action a module sends directly: intake `SaveScanDocument`/`SaveTask`, filing-observer reads, provider and schedule reads, huddle and outreach reads, and `GetServerInfo`/`LastLogs`.
- Each line holds: time, server, kind (`tool`/`action`), call ID, tool or action name, patient ID (only if it is a plain ID), success, error code, latency and channel. Never arguments, results, names, dates of birth or chart contents.
- Staff access: every staff screen request is a `view` (GET) or `staff` (POST) line with the staff `user`, the opaque path or object (`call_record:<id>`, `intake_item:<id>`) and the patient ID when the screen is about one patient. Security events (sign-ins, failures, lockouts, expired passwords, emergency access, rejected keys and webhooks, integrity failures, export and record-view volume alerts, and the ops events `system_down`, `system_recovered`, `helpdesk_alert`, `helpdesk_alert_failed`) are `security` lines and `[SECURITY]` server-log lines. Administrators can export every line for one patient or one staff user for a date range (Activity → Access report).
- Retention: `AUDIT_RETENTION_DAYS`, default 2190 (6 years).
- Files: `<AUDIT_DIR>/audit/YYYY-MM-DD.jsonl` (clinic-local day), mode 0600 in a 0700 directory, append only.
- **Tamper evidence**: each line carries `prev` (the hash of the previous line from the same server in that file, starting from `sha256("drawbridge-audit|<day>|<server>")`) and `hash` (SHA-256 of the line without `hash`). `npm run audit:verify -- <YYYY-MM-DD>` (or `node dist/scripts/audit-verify.js` in the container) reports edited, deleted, reordered and inserted lines by line number. **Limitations**: the hash is a plain SHA-256 from a public starting value, so someone who can write the file can recompute the whole chain after an edit, and lines without a hash at the top of a file are counted as written before the chain existed (launch audit 2026-10-16, open MEDIUM: key the chain with an HMAC from the secret store, or anchor each day's last hash in append-only storage). Also, the chain cannot show lines cut from the end of a file, or a whole day file deleted. **Deployment requirement**: copy the day files daily to append-only or versioned storage (for example S3 with Object Lock) for that.
- A summary also goes to the admin portal (`ADMIN_PORTAL_URL`): tool name, timing, status and error code only.

## 4. Data retention

Every prune runs at startup and then daily, and none of them stop the server if they fail.

| Data | Where | Retention |
|---|---|---|
| On-call call records (patient identity, message, chart snapshot) | `<CALL_RECORDS_DIR>/call-records.json`, 0600 | `CALL_RECORDS_RETENTION_DAYS`, default 30 days after the last update |
| Outreach jobs (first name, phone, appointment) | `<CALL_RECORDS_DIR>/outreach-jobs.json`, 0600 | `OUTREACH_RETENTION_DAYS`, default 30. The opt-out list (patient IDs only) is kept. |
| Intake originals of filed or sent-to-indexing documents | intake store | `INTAKE_RETENTION_DAYS`, default 30 |
| Patient details on records of filed documents (names, DOBs, extracted fields, notes, file names) | intake store | `INTAKE_RECORD_RETENTION_DAYS`, default 90 (IDs, hash and history stay) |
| Audit day files | `<AUDIT_DIR>/audit/` | `AUDIT_RETENTION_DAYS`, default 2190 (6 years) |
| Veradigm diagnostics (LastLogs, scrubbed) | `<CALL_RECORDS_DIR>/unity-diagnostics.json`, 0600 | last 50 records |
| Calls index (call ID, times, last 4 phone digits) | `<AUDIT_DIR>/calls.json` | last 5000 calls |
| Staff session revocations (usernames, times) | `staff-sessions.json`, 0600 | kept (tiny) |

## 5. Encryption

- **In transit**: Veradigm Unity and FHIR are called over HTTPS (endpoints from config). The staff cookie is `Secure`, so the staff app has to be served over HTTPS. **Deployment requirement**: terminate TLS (1.2 or later) in front of every Drawbridge port, and never expose 3000/3001 directly.
- **At rest**: Drawbridge writes its data files with mode 0600 but does not encrypt them itself. **Deployment requirement**: the data volume (`CALL_RECORDS_DIR`, `AUDIT_DIR`, the intake store) has to be on an encrypted disk (EBS encryption with KMS in AWS; BitLocker or LUKS in a data center), and backups must be encrypted too.

## 6. Secrets handling

- Secrets live only in `.env` (local, git-ignored) or AWS SSM Parameter Store (SecureString). They never go in code, logs, fixtures or Postman files. The secrets are the Unity, FHIR, Retell and MOATiT Fax credentials, `DRAWBRIDGE_TOOL_KEY`, `DRAWBRIDGE_SESSION_SECRET` and the users file.
- The users file holds scrypt hashes and, for enrolled users, TOTP secrets. Mount it read-only and treat it as a secret.
- Without `DRAWBRIDGE_SESSION_SECRET`, a random key is used per process, so every restart signs everyone out. Set it in production.

## 7. Per-client configuration

There are no client-specific values in code. `CLINIC_NAME` (no default) sets the staff header, the outreach agent's clinic name and intake's receiving practice. `CLINIC_TIMEZONE`, `CLINIC_HOURS`, the Unity endpoint, the Ubiquity IDs, the Unity action names (`UNITY_ACTION_*`, which may only repeat the declared names), the intake intervals (`INTAKE_SCAN_INTERVAL_SEC`, `INTAKE_OCR_WAIT_SEC`) and all retention periods are environment settings.

## 8. Verification (offline, no Veradigm calls)

| Suite | What it checks |
|---|---|
| `npm run smoke:unity-auth` | Single-flight login, retry after a rejected token, timeouts, no passwords in the logs, GetServerInfo, LastLogs, the sign-in latch (which refusals latch, races, late successes, the latch file across restarts and processes, security events, Retry sign-in route), the declared-action allow-list, scrubbed refusal text |
| `npm run smoke:endpoints` | Both HTTP servers: 503 without a key, 401 with a wrong key, minimal `/health`, CORS, the phone agent key opens `/api/retell` only, no literal credentials or JWTs in `postman/` |
| `npm run smoke:staff-login` | Lockout, idle and absolute timeout, logout and revocation, mandatory TOTP, password expiry and history, roles, security events, CSP, HSTS, automatic logoff; cross-site POSTs refused (sibling subdomain, foreign `Origin`, login CSRF) |
| `npm run smoke:hipaa` | Staff access audit, document integrity, access and disclosure report, volume alerts, minimum necessary for the agent, no patient IDs in URLs, intake record retention, HIPAA & Compliance page and checklist consistency |
| `npm run smoke:activity` | Audit content, hash chain and tamper detection, audited module actions |
| `npm run smoke:config` | `CLINIC_NAME`, intervals, the polling floor, the production sandbox refusal, retention |
| `npm run smoke:call-binding` | Per-call verification binding: no call ID refused, unverified patient refused (audit + security event), verification by full name + DOB with one match only, family member needs own verification, cap of 2, search cap of 5, another patient's appointment refused, registration binds, outreach, MRN lookup, call record, unknown tools, FHIR tools, 2-hour TTL, staff side unaffected, both HTTP servers end to end ; exact-name verification with a prefix-matching search (2-letter prefixes find nobody, nicknames and spelling variants read back without binding), `limit` ignored, same name + DOB patients never merged |
| `npm run smoke:voice` | System status and de-duplicated help-desk alerts (no PHI), SMTP only over TLS, webhook signature, health-check error classes, the 15-minute default, the 2-minute floor and the per-system floor guard, keep-warm and its backoff, `RECORDS_UNAVAILABLE`, upcoming visits only for one verified match, inbound-call webhook signature, `drawbridge_take_message`, the compact agent tool list and prompt safety lines |

The suites `smoke`, `smoke:intake`, `smoke:outreach`, `smoke:huddle` and `smoke:scheduling` cover tool behaviour. Run `npx tsc --noEmit -p .` for the type-check.

## 9. Settings added on this branch

| Setting | Default | Purpose |
|---|---|---|
| `DRAWBRIDGE_TOOL_KEY` | none (endpoints answer 503) | Shared key for machine endpoints. **Required.** |
| `DRAWBRIDGE_AGENT_KEY` | none (`/api/retell` falls back to `DRAWBRIDGE_TOOL_KEY`) | The phone agent's own key: `/api/retell` only. Must differ from the tool key. |
| `DRAWBRIDGE_CORS_ORIGINS` | none | Browser origin allow-list |
| `DRAWBRIDGE_IDLE_MINUTES` | 15 | Staff idle timeout |
| `DRAWBRIDGE_REQUIRE_TOTP` | on (forced on in production) | Mandatory TOTP |
| `DRAWBRIDGE_PASSWORD_MAX_AGE_DAYS` | 90 | Password expiry |
| `DRAWBRIDGE_EXPORT_ALERT_PER_HOUR` / `DRAWBRIDGE_VIEW_ALERT_PER_HOUR` | 20 / 200 | Volume alerts |
| `DRAWBRIDGE_AGENT_STAFF_TOOLS` | off | Staff-only tools on the agent endpoints |
| `DRAWBRIDGE_CALL_MAX_VERIFIED_PATIENTS` | 2 | Patients that can be verified on one phone call (caller plus one family member) |
| `DRAWBRIDGE_CALL_MAX_SEARCHES` | 5 | Identity searches per phone call before `SEARCH_LIMIT` (possible enumeration) |
| `DRAWBRIDGE_CALL_BINDING_TTL_MIN` | 120 | How long a call's verified patients are kept in memory |
| `DRAWBRIDGE_FHIR_REST_ROUTES` | off in production | FHIR REST and test routes |
| `INTAKE_RECORD_RETENTION_DAYS` / `AUDIT_RETENTION_DAYS` | 90 / 2190 | Retention |
| `DRAWBRIDGE_LOGIN_MAX_FAILS` / `_WINDOW_MIN` / `_IP_MAX_FAILS` | 5 / 15 / 30 | Lockout |
| `DRAWBRIDGE_TRUST_PROXY` | unset | Hop count of proxies in front (for example `1` behind nginx), so the per-IP lockout sees client IPs. Count every proxy that appends to `X-Forwarded-For`: behind the Cloudflare tunnel (Cloudflare adds the client IP) plus the local nginx gateway that is `2`; after setting it, check that a failed test sign-in shows your own public IP in the audit line (with `1`, every request looks like it comes from the tunnel, so 30 failures from anyone lock the per-IP limit for all staff). The Node ports must not be reachable except through those proxies, or `X-Forwarded-For` can be forged. |
| `DRAWBRIDGE_SESSIONS_FILE` | `<CALL_RECORDS_DIR>/staff-sessions.json` | Revocation list |
| `UNITY_AUTH_TIMEOUT_MS` | 30000 | GetToken / GetUserAuthentication / RetireToken timeout |
| `UNITY_SERVER_INFO_REFRESH_HOURS` | 6 | GetServerInfo re-check |
| `UNITY_LASTLOGS_MIN_INTERVAL_SEC` | 60 | LastLogs rate limit per system |
| `CALL_RECORDS_RETENTION_DAYS` / `OUTREACH_RETENTION_DAYS` | 30 / 30 | Retention |
| `CLINIC_NAME` | none ("Drawbridge" shown) | Practice name |
| `INTAKE_SCAN_INTERVAL_SEC` / `INTAKE_OCR_WAIT_SEC` | 30 / 60 | Intake timing |
| `UNITY_HEALTH_CHECK_MIN` / `UNITY_HEALTH_TIMEOUT_SEC` / `UNITY_HEALTH_FAILS_TO_DOWN` | 15 (floor 2, `off`) / 15 / 2 | Veradigm health check |
| `UNITY_FAIL_FAST_WHEN_DOWN` | on | Agent tools answer `RECORDS_UNAVAILABLE` while Veradigm is DOWN |
| `UNITY_KEEP_WARM_MINUTES` / `UNITY_KEEP_WARM_LEAD_SEC` | 30 / 120 | Session keep-warm |
| `UNITY_SEARCH_VISITS_BUDGET_MS` | 2500 (0 = off) | Upcoming visits with a verified search match |
| `HELPDESK_SMTP_URL` (secret) / `HELPDESK_ALERT_TO` / `HELPDESK_ALERT_FROM` | none / help@moatit.com / drawbridge-alerts@moatit.com | Help-desk e-mail |
| `HELPDESK_WEBHOOK_URL` / `HELPDESK_WEBHOOK_SECRET` (secret) | none | Help-desk ticketing webhook (https only) |
| `HELPDESK_REMINDER_HOURS` / `DRAWBRIDGE_PUBLIC_URL` | 4 / none | Reminder interval, status link |
| `DRAWBRIDGE_FHIR_TOOLS` | off | `fhir_tools` call variable: backup chart tools not in service |

`UNITY_TOKEN_REFRESH_BUFFER` (60) is now used.

## 10. Deployment requirements (AWS)

These findings are in `infra/` and the deploy workflow, which belong to Kanhaiya. This branch does not change them. Each one must be fixed before production.

1. **EBS encryption is not set**: `infra/terraform/compute.tf` `root_block_device` has no `encrypted = true` (or KMS key). Turn it on (this replaces the volume, so migrate the data) and enable EBS encryption by default for the account.
2. **The security group exposes 3000, 3001, 5001 and 22 to 0.0.0.0/0** (`compute.tf`). Only 443 (and 80 for redirect / ACME) should be public. 3000, 3001 and 5001 should be reachable only from nginx on the host. SSH should be closed (use SSM Session Manager) or limited to known IPs.
3. **Postgres publishes 5432** on the host (`infra/docker-compose.prod.yml`, also `docker-compose.yml`). Remove the port mapping and keep the database on the Docker network. Both compose files also fall back to a default database password when `DB_PASSWORD` is unset. Remove that fallback.
4. **The admin portal mounts `/var/run/docker.sock`** (`infra/docker-compose.prod.yml`), which gives it root on the host. Remove it, or put a read-only socket proxy in front with a minimal API allow-list.
5. **SSM is missing keys** that the code now needs or reads. `infra/terraform/user-data.sh` `fetch-secrets.sh` fetches none of `UNITY_PM_*`, `DRAWBRIDGE_*`, `RETELL_*` or `INTAKE_*`. Add at least `UNITY_PM_USERNAME`, `UNITY_PM_PASSWORD`, **`DRAWBRIDGE_TOOL_KEY` (without it every tool endpoint answers 503 after this branch is deployed)**, `DRAWBRIDGE_AGENT_KEY` (a different value, then the Retell header), `DRAWBRIDGE_SESSION_SECRET`, `DRAWBRIDGE_USERS_FILE` (and the file), `DRAWBRIDGE_TRUST_PROXY=1`, `DRAWBRIDGE_CORS_ORIGINS` if needed, `CLINIC_NAME`, `RETELL_API_KEY`, `RETELL_WEBHOOK_API_KEY`, `RETELL_WEBHOOK_SECRET`, the `INTAKE_*` settings in use, and `MOATIT_FAX_*`.
6. **GitHub deploys with long-lived IAM user keys** (`.github/workflows/deploy.yml`: `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`). Switch to GitHub OIDC (`role-to-assume`, `id-token: write`) with a least-privilege role, then delete the IAM user keys.
7. TLS termination, disk encryption, log shipping and backups (sections 3 and 5) are deployment duties.
8. `NODE_ENV=production` now requires `UNITY_UBIQUITY_ENDPOINT` and both Ubiquity IDs to be set explicitly. The compose files must not supply sandbox defaults for production.
9. The root `.env.example` used to hold sample admin portal values (`DB_PASSWORD`, `NEXTAUTH_SECRET`, `ADMIN_PASSWORD`, `ADMIN_API_KEY`). They are `change-me` placeholders on this branch. Check that none of the old sample values is in use in any deployment.

## 11. Secrets in git (action required)

- **The Postman files on `origin/main`, and in the history of every branch, contain real credentials.** They include the FHIR client ID and secret in `postman/environments/Sandbox-Working.json`, and bearer tokens, client ID and secret headers, Basic credentials and usernames/passwords in `postman/FBINS.postman_collection.json`.
- On this branch those values are now placeholders or `{{fbins_*}}` Postman variables. Three literal `X-Auth-Key` values that were missed are placeholders since the launch audit of 2026-10-16 (`smoke:endpoints` now fails on any literal key, secret, password or token value, or a JWT, in `postman/`); they are in history and must be rotated too. Real values belong in a local Postman environment that is never committed. The history was **not** rewritten.
- **Rotation is required** for every credential that was committed: the Veradigm FHIR client secret and client ID registration, and the FBINS client credentials, tokens and basic-auth accounts. Rotation is what actually closes the exposure.
- History cleanup (for example `git filter-repo` on the Postman paths, then a force-push and every clone re-cloned) needs the owner's decision and coordination, because it rewrites `main`. Do it after rotation, not instead of it.
- `postman/FBINS.postman_collection.json` appears to belong to a payments API (biller and funding accounts). If it does, it falls under MOATiT's PCI process. This branch only removed credentials from it and changed no payment code.

## 12. Known limitations

- Lockout counters are in memory and reset on restart. There is no self-service password change: the users file stays read-only to the server, and the administrator re-issues passwords.
- One `DRAWBRIDGE_TOOL_KEY` per deployment for the machine endpoints, plus the phone agent's own `DRAWBRIDGE_AGENT_KEY` for `/api/retell` (once set). Per-caller keys exist only through the admin portal's optional `x-api-key` check. The tool routes check a static header; they do not also verify Retell's `x-retell-signature` on custom-function calls, so anyone who has the agent key can choose any call ID.
- The CSP allows inline styles.
- The audit chain does not show truncation at the end of a file or a deleted day file (see 3.2).
- `GetTokenValidation` is not configured and is refused at run time, because Drawbridge is not launched from Veradigm EHR (see `UNITY_ACTIONS_FOR_CERTIFICATION.md`).
- Per-call verification binding (1.2a), what still depends on the voice prompt: the server proves that the caller *said* a matching name and date of birth on this call, not that the caller *is* that person (anyone who knows a patient's name and birth date can verify, as with a human receptionist). Whether a second verified person is really the caller's family member, reading back before every change, never reading another patient's details aloud, and not giving medical advice remain prompt rules. The binding is in memory: a server restart during a call means the caller verifies again. On the MCP endpoints the call ID comes from the client (`x-call-id`, or a `call_id` argument the model could set), so the per-call caps hold only per call ID there; production uses Retell custom functions, where Retell sets `call.call_id`. The stdio MCP servers (`src/index.ts`, `src/unity/index.ts`, local tools only) have no call ID and are not gated.
