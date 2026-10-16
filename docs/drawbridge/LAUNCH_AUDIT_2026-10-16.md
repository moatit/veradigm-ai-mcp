# Drawbridge launch audit: security and HIPAA technical safeguards

| | |
|---|---|
| Date | October 15-16, 2026 (run overnight before the October 16 launch and Veradigm certification submission) |
| Branch | `drawbridge/cert-hardening` |
| Commit audited | `cf663fe28d586c2e1f51fdfc03ca348d6cd95566` ("Docs: v7 prompt + tools size after the rebase"), the version the owner locked |
| Commit after fixes | see "Fixes made in this audit"; the last code commit is `0805123` and the last commit is the one that adds this report |
| Auditor | Independent AI agent (Claude Opus 5.5 in Claude Code). It did not write the audited code. Three read-only sub-auditors worked in parallel: staff app, fax/document intake, and logging/secrets/containers. Their findings were checked and merged here. |
| Scope | Phone and voice path (Retell custom functions on `/api/retell` of the Unity and FHIR servers, MCP endpoints, Retell webhooks), staff app (`/app`), fax and document intake, logging and the audit log, dependencies, containers, and secrets in git. It covers HIPAA 164.312(a)-(e), minimum necessary (164.502(b) and 164.514(d)) and OWASP basics. |
| Not done (by instruction) | No calls to Veradigm or Retell. No change to the Retell agents, the local Docker stack or any `.env` file with real values. Nothing pushed to `main`. |

## Verdict

**LAUNCH: PASS**

What this verdict covers:

- **The code:** the branch at the commit that adds this report. It is cleared for the Veradigm certification submission and for the sandbox and synthetic-data use that CLAUDE.md allows today.
- **Fixed in this audit:** all 4 HIGH findings, and the voice-key separation the owner asked for. Every fix has an offline test.
- **Open in the code:** no CRITICAL or HIGH finding.
- **Before production PHI flows:** the deployment gates D1-D7 below must be closed. D1 and D2 are HIGH at the hosting layer: they are AWS `infra/` and the workstation tunnel, not this code.
- **Re-audit:** the fixes were written by this auditor. Under MOATiT's rule that fixes trigger a re-audit, a second independent reviewer should check commits `9232a3f`..`0805123` before production.

## Method

1. Read `CLAUDE.md` and these documents: `SECURITY_CONTROLS.md`, `HIPAA_TECHNICAL_SAFEGUARDS.md`, `UNITY_ACTIONS_FOR_CERTIFICATION.md`, `VOICE_V7_EXPERIMENT.md`, `FAX_INTAKE_ADDON.md` and `RETELL_SETUP.md`. Listed every claim that can be tested.
2. Read the code paths those claims cite.
3. For the voice path, wrote attack tests against the real code: the real `UnityPatientTools.searchPatients` with a fake Veradigm that prefix-matches the way the sandbox does (`unity.service.ts:414`, "Veradigm PM prefix-matches the last name").
4. Ran the type-check, the build, `npm audit --omit=dev` and every `npm run smoke*` script on the audited commit, and again after the fixes.
5. Ran `audit:verify` against a scratch audit directory: once untouched, once with a tampered line.
6. Scanned the tracked files, and the branch's own commits (`git log origin/main..HEAD -p`), for secrets.
7. Fixed each CRITICAL and HIGH finding in a small commit with a test. MEDIUM and LOW findings are listed with a recommendation; the trivial, safe ones are fixed.

## Results by area

| # | Area | Result | Evidence |
|---|---|---|---|
| 1a | Voice tool key: constant-time compare, fails closed, never logged | PASS | `app.ts:59-63` (SHA-256 then `timingSafeEqual`), `app.ts:71-90` (503 when unset, 401 plus a throttled `tool_key_rejected` event, key never printed); request logs carry method, path and tool only (`unity-test-server.ts:81-86`, `test-server.ts:38-48`); `smoke:endpoints` |
| 1a | Voice key dedicated to the voice agent | FIXED (`67ad7be`) | Before: the one `DRAWBRIDGE_TOOL_KEY` kept in the Retell dashboard also opened MCP, `/tools`, `/test/auth`, `/test/serverinfo`, `/diagnostics/veradigm`, `/api/activity/retell-events` and, outside production, the FHIR REST routes. Now `requireAgentKey` (`app.ts:102`): `DRAWBRIDGE_AGENT_KEY` opens `POST /api/retell` and nothing else, and the tool key stops working there. `smoke:endpoints` "DRAWBRIDGE_AGENT_KEY" checks every route and five staff pages. Neither key opens a staff page. Deployment step D3 is still open. |
| 1b | Per-call verification binding cannot be bypassed | FIXED (`9232a3f`); was FAIL | Before: H-1 and H-2 below. Now: exact-name binding (`call-binding.ts:548-556`), `limit` dropped (`:373`), same name + DOB never merged (`patient.tools.ts:469`), visits only for a bound patient (`unity-test-server.ts:128`). Still PASS: unverified `patientId` (`call-binding.ts:401-411`), another patient's appointment (gate `:388-399` plus the ownership check `appointment.tools.ts:1093-1100`), missing call ID (`:340`, `:367`), MRN lookups (`:530-537`), FHIR tools (rules `:241-262`; `verify_patient_identity` is exact, `src/tools/patient.tools.ts:154-159`), unknown tools fail closed (`:336-349`), search cap 5 and verified cap 2. `smoke:call-binding` passes 10/10, including the new section 3b. |
| 1c | Minimum necessary to the agent | PASS | `minimum-necessary.ts:40-114`: patients cut to name, DOB and IDs; SSN keys and FHIR SSN identifiers stripped; a name-only search gets a count only; no `suggestions`. Staff-only tools are refused (`STAFF_ONLY`). Appointment lists are filtered to the patient (`appointment.tools.ts:957`). After H-2, two people with one name and DOB come back as "more than one", never as one merged record. |
| 1d | Retell webhooks: signature over the raw body, stale timestamp rejected | PASS | `retell-signature.ts:49-62`: HMAC-SHA256 over the raw bytes plus the timestamp, a 5-minute window, constant-time compare, key `RETELL_WEBHOOK_API_KEY` falling back to `RETELL_API_KEY`. Mounted before `express.json` (`unity-test-server.ts:69-73`) with `express.raw`. `smoke:activity` and `smoke:voice` cover 503, 401, stale and digest mismatch. LOW L-5: no replay cache inside the window. |
| 2 | Staff app: mandatory TOTP, 90-day expiry, lockout, idle timeout, server-side logout, CSP, cookie flags | PASS, with MEDIUM findings open | Sub-auditor probes and `smoke:staff-login`. Evidence: TOTP is forced in production (`staff-auth.ts:34-37`) and each code works once; expiry (`staff-auth.ts:106-109`); lockout keys are lower-cased; 15-minute sliding idle and 12-hour limits (`shell.ts:128-131`); logout POST, persisted with mode 0600; the CSP matches the document; `__Host-`, HttpOnly, Secure and SameSite=Strict; no inline script. |
| 2 | CSRF posture | FIXED (`0805123`); was MEDIUM | SameSite=Strict still sends the cookie from sibling subdomains of `moatit.dev`. Every non-GET under `/app`, sign-in included, must now be same-origin (`shell.ts` `sameOriginRequest`), or it gets 403 and a `cross_site_request` event. Tested in `smoke:staff-login` 2b. |
| 2 | Lockout per IP behind `DRAWBRIDGE_TRUST_PROXY` | MEDIUM open (deployment) | `security-events.ts:86-88` uses `req.ip`; raw `X-Forwarded-For` is never read. With the documented value `1` behind Cloudflare tunnel plus nginx, every client looks like the tunnel, so 30 failures from anyone lock out all staff. The correct value is `2` (see M-1). |
| 2 | PHI not in URLs; staff access audit; disclosure report | PASS, with MEDIUM M-3 | The access report and free-text questions are POSTed (`activity/index.ts:264`); `smoke:hipaa` checks staff URLs. Every module router is audited (`app.ts:27-56`). The report is admin-only, POST, and its CSV is formula-safe. M-3: multi-patient screens record no patient IDs. |
| 2 | HIPAA & Compliance page accuracy | PASS after corrections | All 43 evidence anchors resolve (`smoke:hipaa`, checked again after `npm run docs:hipaa`). Inaccurate claims corrected in `SECURITY_CONTROLS.md`: password message and timing (L-1), revocation across a restart (M-2), and the audit chain being recomputable (M-4). |
| 3 | Fax webhook HMAC; upload checks; integrity hash; matching rules; audit; retention | PASS for the webhook, uploads, integrity, audit and retention. Matching: FIXED H-2; MEDIUM M-7 and M-8 open | HMAC over the raw body with constant-time compare (`moatit-fax.ts:58-65`). A re-serialized body gets 401. Uploads are sniffed by magic bytes and capped before buffering, and names are sanitized. SHA-256 is checked again before download (409) and before `SaveScanDocument` (`file.ts:300-310`; a tampered file made 0 Veradigm calls). Shadow mode refuses filing in code. Every `SaveScanDocument` and `SaveTask` is an audit line of kind `action`. Retention prunes were checked. H-2 also hit intake: the sub-auditor reproduced an auto-file to the other patient's chart under `INTAKE_MATCH_RULE=name_dob`. |
| 4 | No secrets or PHI in stdout | FIXED H-3; MEDIUM M-6 open | The sub-auditor checked all 294 `console.*` and stdout/stderr calls. No axios objects, bodies, OCR text, phone numbers, tokens or passwords are logged. Opaque patient IDs appear only in allowed places. H-3 (FHIR reply bodies in error messages) is fixed. M-6: Veradigm's free-text error string is still logged, trimmed to 160 characters. |
| 4 | Audit hash chain and `npm run audit:verify` | PASS (tamper-evident against edits), MEDIUM M-4 | `npm run audit:verify -- 2026-10-15` on 4 written lines: `OK ... 4 line(s), 4 chained`, exit 0. After editing `latency_ms` on line 2: `FAIL ... line 2: hash does not match the line (line edited)`, exit 1. `smoke:activity` covers the chain and tamper detection. Arguments, names and DOB are never written. |
| 5 | `npm audit --omit=dev` = 0 | PASS | `found 0 vulnerabilities` on both commits |
| 5 | Containers run as non-root | PASS (LOW hardening open) | `Dockerfile:44`, `Dockerfile.unity:44` `USER mcp` (uid 1001); the OCR image runs as `USER ocr`; the datacenter compose sets `user`, `read_only`, `cap_drop` and `no-new-privileges`. LOW L-12: the app services in `deploy/local` and `infra` compose do not set `read_only` or `cap_drop`. |
| 6 | No secrets committed on this branch; Postman sanitized | FIXED H-4; history rotation open | Three literal `X-Auth-Key` values were left in `postman/FBINS.postman_collection.json` (lines 139, 343, 409 at `cf663fe`) and are now replaced with `{{api_key}}`. `smoke:endpoints` now scans every `postman/*.json` file. No other secrets were found at HEAD or in the branch's own 23 commits. The `.env.example` files hold placeholders only. |
| 7 | Type-check, build, smoke suites | PASS (see below) | `npx tsc --noEmit -p .` exit 0, `npm run build` exit 0, every smoke suite green except the known `smoke:scheduling` date fixture |

### Test runs

| Suite | `cf663fe` (audited) | After fixes |
|---|---|---|
| `npx tsc --noEmit -p .` / `npm run build` | 0 / 0 | 0 / 0 |
| `npm audit --omit=dev` | 0 vulnerabilities | 0 vulnerabilities |
| `smoke` | 13 passed | 14 passed (FHIR error bodies) |
| `smoke:call-binding` | 9 passed | 10 passed (3b exact names, `limit`, same name + DOB) |
| `smoke:endpoints` | 6 passed | 8 passed (Postman scan, agent key) |
| `smoke:staff-login` | 12 passed | 13 passed (cross-site requests) |
| `smoke:hipaa` | 8 passed | 8 passed (regenerated checklist) |
| `smoke:voice` | 9 passed | 9 passed |
| `smoke:activity` / `smoke:unity-auth` / `smoke:config` | 10 / 12 / 5 passed | 10 / 12 / 5 passed |
| `smoke:outreach` / `smoke:huddle` / `smoke:appointment-writes` | 31 / 17 / 19 passed | 31 / 17 / 19 passed |
| `smoke:intake` (3 suites) / `smoke:intake-rules` / `smoke:intake-shadow` | 23+15+7 / 7 / 15 passed | 23+15+7 / 7 / 15 passed |
| `smoke:scheduling` | 1 failure: `FAIL [] 0 !== 3` | same single failure |

`smoke:scheduling` is the known date-fixture failure only. The fixture uses `today: '10/08/2026'` for slots on 10/13/2026. `appointment.tools.ts:383` never offers a time that has passed, so on October 15 the slots are in the past. With the clock pinned to October 8, 2026 (`node -r fakeclock.js -r ts-node/register src/scripts/smoke-scheduling.ts`), all **37 checks pass**.

## Findings

### HIGH (all fixed)

**H-1. Phone verification accepted 2-letter name prefixes.** FIXED in `9232a3f`.

At `cf663fe`, `afterAgentTool` bound any `unity_search_patients` result with exactly one hit (`call-binding.ts:471-480`). The hit can come from two loose matches: Veradigm PM's prefix search on the last name, and the tool's own filter, which keeps a hit on the first 2 letters of each name (`patient.tools.ts:603-610`). Exact-path hits carry no read-back note.

- Reproduced: `{firstName:"Jo", lastName:"Sm", dateOfBirth:"01/02/1970"}` returns to the agent `{"patients":[{"patientId":"201","chartPatientId":"201","firstName":"John","lastName":"Smithers",...}],"total":1}` with no note. The old gate bound it. The agent learned the full name and got the upcoming visits.
- Also, `limit: 1` could cut several matches down to one.
- Fix:
  - A patient is bound only when the record's first name, last name and DOB equal what was given. Letters are compared, ignoring case, spaces, hyphens and apostrophes; the first word of a two-word first name counts.
  - A spelling variant, nickname or one part of a double last name is read back, with no IDs, and binds nobody until a search with the exact spelling.
  - Anything else is NO MATCH.
  - `limit` is dropped on agent searches.
  - Visits ride along only for the patient that search just bound.
  - Prompt line 30 now says to search again after the yes.
- Test: `smoke:call-binding` 3b.

**H-2. Two patients with the same name and DOB were merged into one record.** FIXED in `9232a3f`.

At `cf663fe`, `searchBoth` (`patient.tools.ts:464-479`) keyed PM and EHR rows on name + DOB. The second patient overwrote the first, and the EHR chart ID could be paired with the other patient's PM ID.

- On the phone, the agent bound one of the two people. Reproduced: the result came back as 1 patient, `patientId 205` / `chartPatientId 9205`, and was bound.
- In intake, the sub-auditor reproduced `auto` filing to the other patient's chart.
- This broke "never guess between two patients".
- Fix: same name + DOB within one system stays separate rows and is never paired across systems, so the result is "more than one". The safer pairing rule for the future is a real PM-EHR link (recommendation R-1).
- Tests: `smoke:call-binding` 3b; `smoke:intake` passes unchanged.

**H-3. FHIR error replies reached logs and the admin portal.** FIXED in `d097907`.

`fhir.service.ts:204,209-228` put `JSON.stringify(response.data)` into `Error.message`. An OperationOutcome can echo search parameters such as a name or birth date. That message was:

- printed (`error-handler.ts:106-108`, `test-server.ts:613`);
- sent to the admin portal as `errorMessage`;
- returned with the stack in JSON-RPC `error.data.details`.

Fix: messages now carry the HTTP status only, and no details are returned. Test: `smoke` check 9.

**H-4. Credentials were still committed in Postman.** FIXED in `96cb8cc`; key rotation is still open (D5).

Three literal `X-Auth-Key` values were in `postman/FBINS.postman_collection.json`; commit `26d52aa` had missed them. They are now `{{api_key}}`, and `smoke:endpoints` fails on any literal key, secret, password or token value, or a JWT, in `postman/`.

The values are in git history and must be rotated. The collection appears to belong to a payments API, so MOATiT's PCI process applies to the rotation. No payment code was changed.

### MEDIUM

| ID | Finding | Status | Recommendation |
|---|---|---|---|
| M-0 | One key (`DRAWBRIDGE_TOOL_KEY`) for the voice agent and for every other machine route (owner request: dedicate the voice key) | FIXED `67ad7be` | Set `DRAWBRIDGE_AGENT_KEY` to a different value and switch the Retell header (D3) |
| M-0b | Cross-site POSTs from sibling subdomains (SameSite=Strict is same-site); login CSRF | FIXED `0805123` | — |
| M-1 | `DRAWBRIDGE_TRUST_PROXY=1` behind Cloudflare tunnel plus nginx makes every client the tunnel, so 30 failures from anyone lock the per-IP limit for all staff and the audit IP is useless. With Node ports reachable directly, `X-Forwarded-For` can be forged. | Open (deployment). The `.env.example` files and the documentation now say `2`. | Set `2` in `deploy/local/.env`, then check that a failed test sign-in shows your own IP. Keep 3000/3001 unreachable except through the proxy. |
| M-2 | Sessions are not bound to the password hash. A password change or removal made while the server is stopped does not end older cookies (`shell.ts:94-98`, `readSession`). | Open (document corrected) | Put `HMAC(secret, entry.hash)` in the cookie and compare it in `readSession` |
| M-3 | The access audit records no patient IDs for multi-patient screens (huddle, day schedule, intake queue, outreach list) or for outreach approve, skip and call. The per-patient access report under-reports these. | Open | Record the job and patient IDs on those screens and actions |
| M-4 | The audit chain is a plain SHA-256 from a public seed: someone with write access can recompute it, and unhashed lines at the top of a file are accepted as pre-chain. | Open (document corrected) | HMAC key from the secret store, or anchor each day's last hash in S3 Object Lock; fail unhashed lines after the rollout date |
| M-5 | `access-control.ts:80-84` lets admin-portal client keys through when the portal is unreachable (a second layer behind the tool key), and the cache is keyed by the raw key | Open | Fail closed; key the cache by a hash |
| M-6 | Veradigm's free-text `Error` string is logged and forwarded (`safe-log.ts` `errorSummary`, Unity `error-handler.ts:146/174`, `unity-test-server.ts:185`, `intake/file.ts:320`) and could echo patient data | Open | Log the code and status only; keep the text in the 0600 diagnostics file, scrubbed |
| M-7 | Intake: staff "Send to indexing" (and "File to chart" after "Mark reviewed") does not check again for conflicts, a failed page check or a duplicate (`intake/file.ts:122-133`, `index.ts:239`) | Open (a staff action with a person in the loop) | Block both on a conflict, page-check failure, duplicate or a none/ambiguous decision unless staff confirm the patient explicitly |
| M-8 | Intake: no OCR-confidence gate when the text comes from MOATiT Fax's OCR (`pipeline.ts:193`) | Open (`INTAKE_FILING` is off by default) | Use MOATiT Fax's confidence, or require local OCR before any automatic decision |
| M-9 | The datacenter config sets `NODE_ENV=production` with an `http://` MOATiT Fax base, so every fax fails closed with `FAX_API_NOT_CONFIGURED` | Open | TLS on that link, or an explicit allow-list for the one internal host. Do not drop `NODE_ENV=production`. |
| M-10 | The agent routes trust the call ID in the request. Anyone holding the agent key can use a new call ID per request and get around the per-call search caps; there is no rate limit and no Retell signature check on custom-function calls. | Open (documented in `SECURITY_CONTROLS.md` §12) | Verify `x-retell-signature` on `/api/retell` once confirmed with Retell; add a per-key rate limit and an alert on searches per minute |

### LOW and INFO (open unless marked)

- **L-1.** On a login without TOTP enrolled, the right password gets the enrolment message, so it reveals that the password is correct. An unknown name skips scrypt (about 20 ms faster). Fix: answer with the generic message, and check a dummy hash for unknown names.
- **L-2.** The lockout map evicts the oldest entries at 10,000 keys, so a flood of names can clear a pending lock. Fix: evict only expired entries.
- **L-3.** The Activity screen (security events with IPs, patient IDs per tool call) is open to every staff role. Fix: `requireAdmin` on the security panel. On-call `POST /mode` is also open to every staff role.
- **L-4.** One-time codes and lockouts are in memory, so a code can be replayed for about 90 seconds after a restart.
- **L-5.** Retell webhooks have no replay cache inside the 5-minute window. Leave `RETELL_WEBHOOK_SECRET` (a static header alternative) unset in production.
- **L-6.** MOATiT Fax webhook: `X-Webhook-Id` is not covered by the HMAC, and there is no signed timestamp. SSRF is not possible: a fixed base URL, a job-ID allow-list and `redirect: 'error'`.
- **L-7.** Folder files and fax downloads are not sniffed by magic bytes. A fax download's size is checked after buffering. The folder watcher has an `lstat`-to-read race on symlinks.
- **L-8.** The shadow-report CSV has no formula-injection guard.
- **L-9.** Retention prunes filed and sent-to-indexing items only. Failed and needs-review items keep their originals until staff act.
- **L-10.** `/test/auth` (behind the tool key) returns the first 8 characters of the Veradigm tokens. Fix: remove them.
- **L-11.** By design, the variant read-back tells a caller who gave the exact DOB and a sound-alike name, or a nickname with the exact last name, the record's real name.
- **L-12.** The app containers in `deploy/local` and `infra` compose have no `read_only`, `cap_drop` or `no-new-privileges`. `.dockerignore` does not exclude `data/`, `secrets/` or `*.pem`. `infra/.env.prod.example` and the `infra` scripts keep a default database password.
- **FIXED:**
  - A malformed session cookie gave a 500 (`0805123`).
  - JSON-RPC error responses carried stack traces (`d097907`).
  - Upcoming visits are attached only for a patient bound on the call (`9232a3f`).
- **INFO:**
  - The session secret falls back to a random value per process, with no warning in production.
  - A `pwset` date in the future never expires.
  - HSTS has no `includeSubDomains`.
  - `@types/cors` is a runtime dependency.

## Deployment and organizational gates (before production PHI)

| ID | Gate | Owner |
|---|---|---|
| D1 | Every AWS item in `SECURITY_CONTROLS.md` §10 (HIGH at the hosting layer): EBS encryption, a security group that opens only 443, no published 5432, no `docker.sock`, no default database password, OIDC instead of IAM user keys, SSM keys including `DRAWBRIDGE_AGENT_KEY` | Kanhaiya |
| D2 | PHI must not go through the workstation Cloudflare tunnel without a BAA with Cloudflare (it terminates TLS). Move to the BAA-covered AWS host (`VOICE_V7_EXPERIMENT.md` §10) before live patients. | Ali |
| D3 | Set `DRAWBRIDGE_AGENT_KEY` (different from `DRAWBRIDGE_TOOL_KEY`) and switch the `x-drawbridge-key` header of every Retell custom function (inbound and outbound agents) at the same time. `build_v7.py` / `build_agent.py` use it when set. Not done here: Retell was not touched. | Ali |
| D4 | `DRAWBRIDGE_TRUST_PROXY=2` for Cloudflare tunnel plus nginx (M-1), then verify the IP in the audit log | Ali |
| D5 | Rotate the FBINS `X-Auth-Key`s and every credential in `SECURITY_CONTROLS.md` §11, then decide on the history purge. PCI process for the payments keys. | Ali |
| D6 | TLS 1.2+ at the edge; an encrypted data volume and backups; daily copy of the audit day files to append-only storage; alarms on `[SECURITY]` lines (including `cross_site_request`, `agent_search_limit`) | Kanhaiya / MOATiT |
| D7 | Re-issue every users-file line with `npm run staff:user -- <name> --totp` (pwset and TOTP), and mark the privacy officer `--admin` | Ali |

## Recommendations (not blocking)

- **R-1.** Pair PM and EHR search rows on a real link (the EHR row's PM ID, or chart MRN = PM PatientNumber) instead of name + DOB, and treat anything unlinked as ambiguous.
- **R-2.** Close the MEDIUM items in this order: M-1 (with D4), M-6, M-2, M-3, M-7, M-4.

## Fixes made in this audit

| Commit | Severity | Change | Test |
|---|---|---|---|
| `9232a3f` | HIGH H-1, H-2 | Exact-name verification binding, `limit` dropped, same name + DOB never merged, visits only for a bound patient, prompt line 30 | `smoke:call-binding` 3b |
| `d097907` | HIGH H-3 | FHIR error messages carry the status only; no details or stacks in JSON-RPC errors | `smoke` 9 |
| `96cb8cc` | HIGH H-4 | Postman `X-Auth-Key` values replaced with placeholders | `smoke:endpoints` Postman scan |
| `67ad7be` | MEDIUM M-0 | `DRAWBRIDGE_AGENT_KEY` (`requireAgentKey`) on `/api/retell` only | `smoke:endpoints` agent key |
| `0805123` | MEDIUM M-0b, LOW | Same-origin check on staff POSTs (`cross_site_request`); a malformed cookie signs out | `smoke:staff-login` 2b |
| `b1b0cf1` | docs | `SECURITY_CONTROLS.md` corrections and new settings; HIPAA checklist regenerated (`npm run docs:hipaa`); `RETELL_SETUP.md`; trust-proxy guidance in the `.env` examples | `smoke:hipaa` |

## Auditor statement

This audit was performed by an independent AI agent (Claude Opus 5.5, Claude Code), working in its own git worktree, on October 15-16, 2026. It did not write the audited code. The three sub-auditors (staff app, intake, logging/secrets/containers) were also independent agents. They worked read-only, and their findings were checked against the code before they went into this report.

The evidence above comes from code reading at the cited lines and from offline test runs. No Veradigm or Retell system was called, no Retell agent or local Docker container was changed, and no `.env` file with real values was opened. The fixes listed above were written by this auditor and should get an independent re-review before production.

Signed off: independent audit agent, 2026-10-16. **LAUNCH: PASS** for the code (certification submission, sandbox), subject to D1-D7 before production PHI.
