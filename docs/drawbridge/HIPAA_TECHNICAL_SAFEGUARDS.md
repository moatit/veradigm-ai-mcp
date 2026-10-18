# Drawbridge: HIPAA safeguards checklist

How Drawbridge, as software run by a business associate (MOATiT), meets the HIPAA Security Rule safeguards that apply to it (45 CFR 164.308 where it touches software, 164.310(d), 164.312, 164.314), the Privacy Rule requirements that apply to a business associate's software (164.502(b) / 164.514(d) minimum necessary, 164.528 accounting of disclosures, 164.530(c) safeguards, 164.316(b)(2) documentation) and breach notification support (164.404-410). Branch `drawbridge/cert-hardening`, October 15, 2026. It complements `SECURITY_CONTROLS.md` (the Veradigm Vendor Security Questionnaire evidence).

Status:

- **PASS**: in place before this branch.
- **FIXED-in-this-branch**: a software gap closed on this branch, with an offline test.
- **DEPLOYMENT (needs infra)**: depends on hosting (AWS infrastructure is Kanhaiya's; this branch does not change `infra/`).
- **ORGANIZATIONAL**: covered by MOATiT policy (training, workforce, plans, agreements). Administrative policies are out of scope for the code.

The table below is generated from the same list that drives the staff screen **HIPAA & Compliance** (`/app/compliance`, `src/platform/modules/compliance/safeguards.ts`). After changing that list or moving code under an evidence reference, run `npm run docs:hipaa`. `npm run smoke:hipaa` fails while this document and the list disagree.

## Checklist

<!-- BEGIN GENERATED CHECKLIST (npm run docs:hipaa; source: the SAFEGUARDS list) -->
36 requirements: 2 PASS, 20 FIXED-in-this-branch, 5 DEPLOYMENT, 9 ORGANIZATIONAL.

| # | Citation | Requirement | How Drawbridge meets it | Evidence | Status |
|---|---|---|---|---|---|
| 1 | 164.308(a)(1)(ii)(A)-(B) | Risk analysis and risk management. | Organizational, covered by MOATiT policy (annual scanning and penetration testing). | — | ORGANIZATIONAL |
| 2 | 164.308(a)(1)(ii)(D) | Regularly review records of information system activity. | Audit lines for kinds tool / action / view / staff / security; staff access middleware on every module screen; Activity screen with a Security events panel ("to review" count). | `src/platform/audit.ts:140`<br>`src/platform/app.ts:27`<br>`src/platform/modules/activity/index.ts:98` | FIXED-in-this-branch |
| 3 | 164.308(a)(3)(ii)(C) | End access when a workforce member leaves. | Users file re-read on change; a removed user or changed password revokes all sessions (persisted revocation list). | `src/platform/shell.ts:101`<br>`src/platform/staff-auth.ts:313` | PASS |
| 4 | 164.308(a)(4)(ii)(B)-(C) | Authorize, establish and change access based on role. | Users file roles staff / admin / emergency; requireAdmin on the access report; fixed Unity action list (UNITY_ACTIONS_FOR_CERTIFICATION.md). | `src/platform/staff-auth.ts:77`<br>`src/platform/shell.ts:272` | FIXED-in-this-branch |
| 5 | 164.308(a)(5)(i) | Security awareness and training for the workforce. | Organizational, covered by MOATiT policy. | — | ORGANIZATIONAL |
| 6 | 164.308(a)(5)(ii)(B) | Protection from malicious software. | Organizational, covered by MOATiT policy (SentinelOne EDR; ConnectWise ScreenConnect RMM patching). | — | ORGANIZATIONAL |
| 7 | 164.308(a)(5)(ii)(C) | Monitor log-in attempts and report discrepancies. | Security events login_ok / login_failed (reason) / login_locked / login_ip_locked; lockout per username (5 in 15 min) and per IP (30). | `src/platform/shell.ts:543`<br>`src/platform/staff-auth.ts:123` | FIXED-in-this-branch |
| 8 | 164.308(a)(5)(ii)(D) | Procedures for creating, changing and safeguarding passwords. | passwordProblem policy; DRAWBRIDGE_PASSWORD_MAX_AGE_DAYS (90) with :pwset=; :hist= keeps 4 previous hashes, staff:user refuses reuse of the last 5; scrypt. | `src/platform/staff-auth.ts:201`<br>`src/platform/staff-auth.ts:106`<br>`src/scripts/staff-user.ts:73` | FIXED-in-this-branch |
| 9 | 164.308(a)(6)(ii) | Identify security incidents (detection and documentation). | security-events.ts: [SECURITY] server-log lines plus audit lines; throttled tool_key_rejected / webhook_rejected; integrity_failed; export_volume_alert and view_volume_alert (DRAWBRIDGE_EXPORT_ALERT_PER_HOUR 20, DRAWBRIDGE_VIEW_ALERT_PER_HOUR 200). | `src/platform/security-events.ts:98`<br>`src/platform/security-events.ts:153` | FIXED-in-this-branch |
| 10 | 164.308(a)(6)(ii) | Respond to and report security incidents. | Organizational, covered by MOATiT policy. Alerting on [SECURITY] log lines is a deployment item. | — | ORGANIZATIONAL |
| 11 | 164.308(a)(7)(ii)(A) | Data backup plan. | Back up the data volume (call records, intake store, audit day files, revocation list); encrypted, immutable; npm run audit:verify -- --all after a restore. | `src/scripts/audit-verify.ts:16` | DEPLOYMENT (needs infra) |
| 12 | 164.308(a)(7)(ii)(B)-(C) | Disaster recovery and emergency mode operation. | Failures are { success:false, error_code, retryable } (CLAUDE.md rule 5); DR/BCP organizational. | `src/utils/response-formatter.ts:104` | ORGANIZATIONAL |
| 13 | 164.308(a)(8) | Periodic technical and non-technical evaluation. | Organizational (annual scan and pen test); offline smoke suites in the repo. | — | ORGANIZATIONAL |
| 14 | 164.310(a)-(c) | Facility access and workstation security. | Organizational / hosting provider. | — | ORGANIZATIONAL |
| 15 | 164.310(d)(2)(i) | Dispose of ePHI securely. | Daily retention jobs (CALL_RECORDS_, OUTREACH_, INTAKE_ RETENTION_DAYS 30; INTAKE_RECORD_RETENTION_DAYS 90); crypto-erase of the encrypted volume at end of life. | `src/platform/modules/intake/store.ts:440`<br>`src/platform/retention.ts:24` | FIXED-in-this-branch |
| 16 | 164.310(d)(2)(ii) | Remove ePHI before media is re-used. | AWS: delete the EBS volume and snapshots (KMS key schedule); data center: cryptsetup luksErase / BitLocker key destruction (NIST SP 800-88 crypto-erase). | — | DEPLOYMENT (needs infra) |
| 17 | 164.310(d)(2)(iii)-(iv) | Track hardware and media; back up data before moving equipment. | Organizational / deployment. | — | ORGANIZATIONAL |
| 18 | 164.312(a)(1) | Access control: only authorized people and programs can reach ePHI. | requireLogin on every module router; requireToolKey fails closed (503) and rejects wrong keys (401, security event); requireAgentKey: DRAWBRIDGE_AGENT_KEY opens POST /api/retell only (falls back to the tool key when unset). | `src/platform/shell.ts:296`<br>`src/platform/app.ts:71`<br>`src/platform/app.ts:102` | PASS |
| 19 | 164.312(a)(1), 164.502(b) | Access control on patient calls: the phone agent can open only the records of callers it has verified. | Per-call verification binding keyed by the Retell call ID (call-binding.ts, both agent endpoints): unity_search_patients / verify_patient_identity with first + last name + DOB and one match whose names and DOB equal what was given binds that patient’s IDs to the call (variants are read back, never bound; same name + DOB patients never merged) (memory only, DRAWBRIDGE_CALL_BINDING_TTL_MIN 120); every patient-scoped tool and appointment ID needs a bound patient, else NOT_VERIFIED; no call ID = CALL_ID_MISSING; DRAWBRIDGE_CALL_MAX_VERIFIED_PATIENTS 2, DRAWBRIDGE_CALL_MAX_SEARCHES 5; refusals are security events. | `src/platform/call-binding.ts:330`<br>`src/platform/call-binding.ts:493` | FIXED-in-this-branch |
| 20 | 164.312(a)(2)(i) | Unique user identification. | Named users file; the shared DRAWBRIDGE_USERNAME login works only in development with TOTP off and is refused in production. | `src/platform/shell.ts:125` | FIXED-in-this-branch |
| 21 | 164.312(a)(2)(ii) | Emergency access procedure. | role=emergency: emergency_access_login security event, banner, 4-hour absolute limit; procedure in this document. | `src/platform/shell.ts:557`<br>`src/platform/shell.ts:79` | FIXED-in-this-branch |
| 22 | 164.312(a)(2)(iii) | Automatic logoff. | Server idle timeout (DRAWBRIDGE_IDLE_MINUTES 15, sliding) and 12-hour limit; pages carry data-idle-ms and blank themselves. | `src/platform/shell.ts:405`<br>`src/platform/shell.ts:348` | FIXED-in-this-branch |
| 23 | 164.312(a)(2)(iii) | Automatic logoff in the separate admin console. | The admin portal is a separate application (not in this repository); it must implement idle logoff, MFA and the same session rules. | — | DEPLOYMENT (needs infra) |
| 24 | 164.312(a)(2)(iv) | Encryption of stored ePHI. | Deployment: EBS encryption with KMS (infra owned by the infrastructure team; compute.tf root_block_device needs encrypted = true); data center: BitLocker or LUKS2. Files are written mode 0600 in 0700 directories. | `src/platform/modules/intake/store.ts:221` | DEPLOYMENT (needs infra) |
| 25 | 164.312(b) | Audit controls that record and examine activity. | Hash-chained JSONL day files (audit:verify); staff views and actions with user and patient ID; AUDIT_RETENTION_DAYS default 2190 (6 years); off-host archive is a deployment item. | `src/platform/audit.ts:272`<br>`src/platform/audit.ts:102` | FIXED-in-this-branch |
| 26 | 164.312(c)(1)-(2) | Integrity: protect ePHI from improper change and detect it. | SHA-256 at receipt; verified before download (409) and before SaveScanDocument (INTEGRITY_FAILED); audit hash chain; atomic file writes; idempotent writes. | `src/platform/modules/intake/file.ts:312`<br>`src/platform/modules/intake/index.ts:478` | FIXED-in-this-branch |
| 27 | 164.312(d) | Person or entity authentication. | TOTP mandatory (DRAWBRIDGE_REQUIRE_TOTP default on, forced in production); tool key and the phone agent’s own key (DRAWBRIDGE_AGENT_KEY); HMAC-signed MOATiT Fax and Retell webhooks. | `src/platform/staff-auth.ts:34`<br>`src/platform/shell.ts:533` | FIXED-in-this-branch |
| 28 | 164.312(e)(1), (e)(2)(i) | Transmission security and integrity in transit. | Production refuses non-https Unity/FHIR/MOATiT Fax URLs; HSTS; __Host- Secure cookie; signed webhooks. | `src/unity/config/environment.ts:72`<br>`src/platform/shell.ts:430` | FIXED-in-this-branch |
| 29 | 164.312(e)(2)(ii) | Encryption in transit at the network edge. | Deployment: TLS 1.2+ termination in nginx / the tunnel; ports 3000/3001 never exposed directly. | — | DEPLOYMENT (needs infra) |
| 30 | 164.314(a) | Business associate agreements, including with subcontractors. | Organizational. Any other service that sees PHI in clear (for example a TLS-terminating tunnel or CDN) also needs a BAA. | — | ORGANIZATIONAL |
| 31 | 164.314(a)(2)(i)(C) | Report security incidents to the covered entity. | Security events + access report per patient / per staff user support the report; the reporting duty is organizational. | `src/platform/modules/activity/index.ts:129` | FIXED-in-this-branch |
| 32 | 164.502(b), 164.514(d) | Minimum necessary. | forAgent() at the agent edges (Retell, MCP, stdio); STAFF_ONLY tools refused; audit and server logs hold IDs and codes only. | `src/utils/minimum-necessary.ts:85`<br>`src/utils/minimum-necessary.ts:23` | FIXED-in-this-branch |
| 33 | 164.528 | Accounting of disclosures. | Access and disclosure report (admin, POST, HTML/CSV), backed by the 6-year audit log. | `src/platform/modules/activity/index.ts:273` | FIXED-in-this-branch |
| 34 | 164.530(c) | Reasonable safeguards against improper use or disclosure. | POST for patient IDs and free-text questions; neutral titles; Cache-Control no-store, CSP, X-Frame-Options DENY, Referrer-Policy no-referrer; state-changing staff requests must be same-origin (Sec-Fetch-Site / Origin, 403 + cross_site_request); FHIR REST test routes off in production. | `src/platform/shell.ts:424`<br>`src/platform/shell.ts:203`<br>`src/test-server.ts:65` | FIXED-in-this-branch |
| 35 | 164.316(b)(2) | Keep required documentation for 6 years. | AUDIT_RETENTION_DAYS default 2190; copy day files to append-only archive storage (deployment). | `src/platform/audit.ts:102` | FIXED-in-this-branch |
| 36 | 164.404-410 | Support breach detection, investigation and notification. | Detection (security events, alerts), scoping (access report per patient / per user), tamper evidence (hash chain); notification is organizational. | `src/platform/security-events.ts:184` | FIXED-in-this-branch |
<!-- END GENERATED CHECKLIST -->

## Owner decisions implemented (Oct 15, 2026)

1. **TOTP two-factor sign-in is mandatory for every staff user.** `DRAWBRIDGE_REQUIRE_TOTP` is on by default and always on when `NODE_ENV=production`. A users-file line without `:totp=` cannot sign in: after the right password the person sees "Two-factor sign-in is not set up for your login. Ask the Drawbridge administrator to enrol you." (security event `login_no_totp`, not counted toward the lockout). Enrolment: the administrator runs `npm run staff:user -- <name> --totp`, which prints the `otpauth://` link once on stderr. The single shared login (`DRAWBRIDGE_USERNAME`) works only for local development with `DRAWBRIDGE_REQUIRE_TOTP=off` and never in production. Removing the secret from a line ends that person's sessions.
2. **Passwords expire every 90 days.** Each line carries `:pwset=YYYY-MM-DD` (UTC). `DRAWBRIDGE_PASSWORD_MAX_AGE_DAYS` (default 90, 1-3650). After the right password and code, an expired password is refused with "Your password has expired. Ask the Drawbridge administrator to issue a new one." (security event `login_password_expired`), and open sessions end. A line without `:pwset=` counts as expired. The administrator re-issues the password with `npm run staff:user -- <name>` (reads the current users file, keeps the TOTP secret and role, refuses any of the person's last 5 passwords, moves the old hash into `:hist=`). A self-service change-password page was not added: the users file is mounted read-only in every deployment, and making it writable by the web server would weaken that control.
3. **Encryption at rest.** Production on AWS uses EBS encryption (infrastructure owned by Kanhaiya; not edited here; see "Encryption at rest"). A local or data-center server uses BitLocker or LUKS2 full-disk encryption.

Users-file line format (backward compatible: old lines still load; unknown attributes are ignored):

```
username:scrypt$N$r$p$salt$hash:totp=<base32>:pwset=YYYY-MM-DD[:hist=<hash>,...][:role=admin|emergency]
```

**Migration when this branch is deployed:** every existing line must be re-issued with `npm run staff:user -- <name> --totp` (old lines have neither a TOTP secret nor a set date, so they cannot sign in). Mark the privacy or security officer `--admin`.

## Settings added on this branch

| Setting | Default | Purpose |
|---|---|---|
| `DRAWBRIDGE_REQUIRE_TOTP` | on (forced on in production) | Every staff sign-in needs a TOTP code; `off` only for local development |
| `DRAWBRIDGE_PASSWORD_MAX_AGE_DAYS` | 90 | Password expiry |
| `DRAWBRIDGE_EXPORT_ALERT_PER_HOUR` | 20 | Document downloads and access reports by one user in 60 minutes before an `export_volume_alert` |
| `DRAWBRIDGE_VIEW_ALERT_PER_HOUR` | 200 | Patient-record screens opened by one user in 60 minutes before a `view_volume_alert` |
| `DRAWBRIDGE_AGENT_KEY` | none (falls back to `DRAWBRIDGE_TOOL_KEY`) | The phone agent's own key, accepted on `POST /api/retell` only (launch audit 2026-10-16) |
| `DRAWBRIDGE_AGENT_STAFF_TOOLS` | off | `on` offers staff-only tools (day schedule, changed appointments, huddle brief) on the agent endpoints; only for a staff-facing voice assistant, never the patient line |
| `DRAWBRIDGE_CALL_MAX_VERIFIED_PATIENTS` / `DRAWBRIDGE_CALL_MAX_SEARCHES` / `DRAWBRIDGE_CALL_BINDING_TTL_MIN` | 2 / 5 / 120 | Per-call verification binding on the phone-agent endpoints: patients verified per call, identity searches per call, minutes a call's binding is kept |
| `DRAWBRIDGE_FHIR_REST_ROUTES` | off in production, on elsewhere | The FHIR server's REST convenience and test routes (patient IDs in URLs) |
| `INTAKE_RECORD_RETENTION_DAYS` | 90 | Patient details on records of filed intake documents |
| `AUDIT_RETENTION_DAYS` | **2190** (was 30) | Audit day files: 6 years (164.316(b)(2), 164.528) |

Other changes: the session cookie is now `__Host-drawbridge_session` (everyone signs in again once after deployment); staff pages send `Strict-Transport-Security`; production refuses non-HTTPS Veradigm® (Unity, FHIR, authorize, token) URLs and a non-HTTPS `MOATIT_FAX_BASE_URL`.

## Audit controls (164.312(b)) and activity review

Each audit line has a `kind`:

| Kind | Written when | Extra fields |
|---|---|---|
| `tool` | a phone-agent or staff tool call | |
| `action` | a Veradigm® action a module sends directly | |
| `view` | a staff screen is shown (GET) | `user`, `object` (opaque path or `call_record:<id>` / `intake_item:<id>`), `patient_id` when the screen is about one patient |
| `staff` | a staff action (POST) | same as `view` |
| `security` | a security event | `user` (only names that exist), `ip`, `object` |

Lines never hold names, dates of birth, messages, chart contents, passwords or query strings, and stay in the per-server hash chain (`npm run audit:verify`, or `-- --all` for every day file). The FHIR server's REST and test routes, when enabled, are audited too (`fhir_rest`). The **Activity** screen shows a Security events panel for the day with a "to review" count.

## Security incident detection (164.308(a)(6), 164.308(a)(5)(ii)(C), 164.404-410)

Security events (audit kind `security`, and a server-log line starting with `[SECURITY]`):

| Event | Meaning |
|---|---|
| `login_ok`, `logout` | Sign-in and sign-out |
| `login_failed` | Wrong password (`BAD_PASSWORD`), wrong or missing code (`BAD_TOTP`), unknown name (`UNKNOWN_USER`, the name is not logged), or while locked (`LOCKED`) |
| `login_locked`, `login_ip_locked` | A username or client IP locked after repeated failures |
| `login_no_totp`, `login_password_expired` | Right password, but no TOTP enrolled / password expired or without a date |
| `emergency_access_login` | The sealed emergency login was used (also a loud `[SECURITY] EMERGENCY ACCESS` error line) |
| `tool_key_rejected`, `webhook_rejected` | A request without the right tool key, or a Retell / MOATiT Fax webhook with a bad signature (at most one line a minute per client and path, then `repeats:<n>`) |
| `cross_site_request` | A state-changing staff request (sign-in included) from another origin, for example a sibling subdomain, refused with 403 |
| `integrity_failed` | A stored document no longer matches its SHA-256 from receipt (download refused, filing refused) |
| `export` | A document download or an access report |
| `export_volume_alert`, `view_volume_alert` | One user over `DRAWBRIDGE_EXPORT_ALERT_PER_HOUR` exports or `DRAWBRIDGE_VIEW_ALERT_PER_HOUR` patient-record screens in 60 minutes (one alert per user per hour) |
| `agent_not_verified`, `agent_verified_limit`, `agent_search_limit`, `agent_no_call_id` | The phone agent asked for a patient not verified on that call, a third patient, more than `DRAWBRIDGE_CALL_MAX_SEARCHES` identity searches (`POSSIBLE_ENUMERATION`), or a patient record without a call ID. Call ID, tool and requested patient ID; never a name (`SECURITY_CONTROLS.md` §1.2a) |

**Deployment:** alert on the `[SECURITY]` prefix in the log store. In AWS, a CloudWatch Logs metric filter on `"[SECURITY]"` with the alert events (`login_locked`, `login_ip_locked`, `emergency_access_login`, `integrity_failed`, `export_volume_alert`, `view_volume_alert`, `tool_key_rejected`, `agent_search_limit`, `agent_verified_limit`, and repeated `agent_not_verified` on one call) and an alarm to the on-call address. In the data center, the same rule in the log shipper. Responding and notifying clients is MOATiT's incident response plan (organizational).

## Emergency access procedure (164.312(a)(2)(ii))

Drawbridge holds working copies only; Veradigm® EHR is the system of record and keeps its own emergency access. For Drawbridge itself:

1. Create one sealed login: `npm run staff:user -- <name> --totp --emergency`. Keep the password in the MOATiT password vault (or a sealed envelope) and the TOTP secret on a separate device held by the privacy officer. Two people are needed to use it.
2. Use it only when no named login can be used during a patient-care emergency (for example the administrator is unreachable and the on-call notebook must be read).
3. Every use raises `emergency_access_login`, shows a red "Emergency access session" banner on every page, and ends after 4 hours.
4. Afterwards the privacy officer reviews the session with the access report (Staff user = the emergency login), records why it was used, and issues a new password and TOTP secret.

Other emergencies: a locked-out user is unlocked after 15 minutes or by restarting the service (lockout counters are in memory); a lost authenticator is re-enrolled with `--totp`.

## Accounting of disclosures (164.528) and breach scoping

**Activity → Access report** (administrators only, `:role=admin`): every audit line for one patient ID, or everything one staff user did, for a date range, on screen or as a CSV (formula-safe). The patient ID is sent in the POST body, never in a URL. Each report is itself logged (`staff` line with the patient ID, and an `export` event). Disclosures for treatment, payment and operations and to the patient are not accountable; the privacy officer prepares the accounting from this list. The local log covers `AUDIT_RETENTION_DAYS` (6 years by default); the off-host archive covers anything older.

## Minimum necessary (164.502(b), 164.514(d))

At the agent edges only (Retell `POST /api/retell`, the MCP endpoints of both servers, the stdio server), never inside Drawbridge (intake and the staff screens keep full results):

- patient records are cut to first and last name, date of birth and the Veradigm® PM / EHR IDs; the MRN only when the caller gave it. Never address, phone, e-mail, SSN or its last 4, gender, race, ethnicity, language, marital status;
- a search without a date of birth or MRN returns a count and "ask for the date of birth", never names; a search without all three of first name, last name and date of birth, or one matching more than one patient, returns no identifiers; a hit whose name is not exactly the one given (spelling variant, nickname, part of a double last name) is read back without identifiers and verifies nobody until a search with the exact spelling; two patients with the same name and date of birth are never merged into one;
- **per-call verification binding** (`src/platform/call-binding.ts`, `SECURITY_CONTROLS.md` §1.2a): a patient's record can be used on a call only after that call verified the patient (first name + last name + date of birth, exactly one match); at most `DRAWBRIDGE_CALL_MAX_VERIFIED_PATIENTS` (2) patients and `DRAWBRIDGE_CALL_MAX_SEARCHES` (5) identity searches per call; every other patient ID or appointment ID is refused (`NOT_VERIFIED`, security event); IDs only, in memory, `DRAWBRIDGE_CALL_BINDING_TTL_MIN` (120);
- SSN keys and FHIR SSN identifiers are removed anywhere in a result;
- staff-only tools that list other patients (`unity_get_day_schedule`, `unity_get_changed_appointments`, `drawbridge_get_huddle_brief`) are not listed and are refused with `STAFF_ONLY` (audited);
- failures pass through unchanged (never an empty result).

## PHI in URLs, cookies and pages (164.530(c), 164.312(e))

- Patient identifiers never go in a URL: the access report and the staff assistant's free-text question are POSTed; GET parameters hold dates, statuses and opaque IDs only (checked by `smoke:hipaa`). The on-call record's page title no longer carries the patient name (browser history).
- The FHIR server's REST and test routes (`/api/patient/:id`, `?patientId=`) answer 404 in production unless `DRAWBRIDGE_FHIR_REST_ROUTES=on`.
- Session cookie: `__Host-` prefix, `HttpOnly; Secure; SameSite=Strict; Path=/`, no Domain. HSTS, CSP without inline script, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `nosniff`.

## Data retention and secure deletion (164.310(d)(2)(i)-(ii), 164.530(c))

| Data | Retention |
|---|---|
| On-call call records | 30 days after the last update (`CALL_RECORDS_RETENTION_DAYS`) |
| Outreach jobs | 30 days (`OUTREACH_RETENTION_DAYS`); opt-outs (IDs only) kept |
| Intake originals and text of filed documents | 30 days after filing (`INTAKE_RETENTION_DAYS`) |
| **Patient details on filed intake records** (new) | 90 days after filing (`INTAKE_RECORD_RETENTION_DAYS`): extracted fields, names, dates of birth, notes, sender number and file name removed; IDs, filed document ID, SHA-256 and history stay. Documents still waiting for staff are never touched. |
| Audit day files | 6 years (`AUDIT_RETENTION_DAYS` 2190) |

Deletion is a file unlink on an encrypted volume. Overwriting files is not reliable on SSDs and EBS, so media is disposed of by **crypto-erase** (NIST SP 800-88 Purge): AWS, delete the EBS volume and its snapshots (and schedule deletion of a dedicated KMS key); data center, `cryptsetup luksErase` (LUKS2) or BitLocker key destruction, then physical destruction per policy. The intake shadow pilot follows `deploy/datacenter/README.md` "At the end: delete everything".

## Encryption at rest (164.312(a)(2)(iv)): deployment requirements

**AWS (production, Kanhaiya):**

- `infra/terraform/compute.tf` `root_block_device` (and any data volume holding `/app/data`): `encrypted = true` with a customer-managed KMS key. This replaces the volume: migrate the data.
- Turn on EBS encryption by default for the account and region; snapshots and AWS Backup vaults encrypted with KMS.
- AWS is covered by the AWS BAA (HIPAA-eligible services only).

**Local / data-center server:**

- **Windows: BitLocker** on every volume with Drawbridge data, XTS-AES 256, TPM + PIN, recovery key escrowed in the MOATiT vault (not on the server).
- **Linux: LUKS2** full-disk encryption: `cryptsetup luksFormat --type luks2 --cipher aes-xts-plain64 --key-size 512 --pbkdf argon2id`, unlocked at boot with TPM2 (`systemd-cryptenroll --tpm2-device=auto`) or a network key server; header backup and recovery passphrase in the MOATiT vault.
- Backups encrypted (restic repositories are encrypted; protect the repository key).

## Backup and restore of `/app/data` (164.308(a)(7)(ii)(A))

What to back up (the `CALL_RECORDS_DIR` / `AUDIT_DIR` volume, normally `/app/data`): `call-records.json`, `outreach-jobs.json`, `intake/` (items and originals), `audit/` (day files), `calls.json`, `staff-sessions.json`, `unity-diagnostics.json`. Also the users file and the environment (secrets) from the secret store, not from the volume.

- MOATiT policy: every 2 hours, kept 6 months, encrypted and immutable (AWS Backup with vault lock / S3 Object Lock, or restic to an append-only repository).
- Audit day files additionally go daily to append-only storage (S3 Object Lock) for 6 years; this also covers the chain's blind spot (truncation of the last lines, a deleted day file).
- **Restore:** stop the service, restore the volume, then run `npm run audit:verify -- --all` (or `node dist/scripts/audit-verify.js --all` in the container) and record the result. Any `FAIL` is a security incident until explained. Restored data keeps its retention clocks: the daily jobs prune at the next start.
- Test a restore at least once a year (DR plan).

## Remaining items

**DEPLOYMENT (needs infra):** EBS encryption and default encryption (above); TLS 1.2+ termination with HSTS at nginx / the tunnel and closing ports 3000/3001/5001/22 (`SECURITY_CONTROLS.md` §10); encrypted, immutable backups every 2 hours for 6 months; audit day files to append-only archive for 6 years; `[SECURITY]` log alarms; secure media disposal by crypto-erase; the separate admin portal (not in this repository) must apply the same idle logoff, MFA and session rules; SSM must provide the users file with re-issued lines, `DRAWBRIDGE_TRUST_PROXY=1` and the other keys in `SECURITY_CONTROLS.md` §10.

**ORGANIZATIONAL (covered by MOATiT policy):** risk analysis and management; annual HIPAA security and privacy training; malware protection (SentinelOne EDR) and patching (ConnectWise ScreenConnect RMM, critical patches within 7 days after testing); incident response plan with breach notification to clients under the BAA; disaster recovery and business continuity plans; annual vulnerability scanning and penetration testing (Garrison); facility and workstation security (AWS, US); hardware inventory; BAAs with each client and with AWS and Retell (and with any other service that sees PHI in clear, for example a TLS-terminating tunnel); SOC 2 in process (audit before the end of 2027).

## Verification (offline, no Veradigm® or Retell calls)

| Suite | What it checks |
|---|---|
| `npm run smoke:staff-login` | Mandatory TOTP (and shared login off, forced in production), password expiry and history, `staff:user` enrolment and rotation, roles (admin, emergency banner and 4-hour limit), security events, lockouts, `__Host-` cookie, HSTS, automatic logoff markup, CSP |
| `npm run smoke:hipaa` | Staff access audit (views and actions with user and patient ID, no names), document integrity before download and filing, access report (admin only, POST, HTML/CSV), volume alerts, minimum necessary, no patient identifiers in staff URLs, intake record retention, 6-year audit default, this document matches the safeguards list, the HIPAA & Compliance page (signed-in only, plain language) |
| `npm run smoke:call-binding` | The phone agent can open only records verified on the same call: no call ID, unverified patient, family member, caps of 2 patients and 5 searches, another patient's appointment, registration, FHIR tools, staff side unaffected, both HTTP servers |
| `npm run smoke:endpoints` | Rejected keys are security events on both servers, FHIR REST routes audited and off in production, staff-only tools not offered to and refused for the agent |
| `npm run smoke:config` | Production refuses non-HTTPS Veradigm® URLs |
