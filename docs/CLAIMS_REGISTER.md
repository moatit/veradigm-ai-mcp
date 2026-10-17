# Claims register

Every factual claim on the site, its source, and what must be true before the site goes public. Numbers live in one place (`src/content/site.mjs` → `CLAIMS`) so the site never disagrees with itself. Source documents are on branch `drawbridge/cert-hardening` of `veradigm-ai-mcp` (`docs/drawbridge/…`) unless noted.

Status: **OK** = verified against a source; **CONFIRM** = Ali/Musab to confirm before public launch; **GATE** = true only once a deployment gate is closed.

## Proof numbers

| Claim on site | Where | Source | Status |
|---|---|---|---|
| **0** wrong-patient filings in synthetic testing (held-out sets of 3,000 documents; 4,402 result pages in the latest) | Home, Fax, LP | `INTAKE_ACCURACY.md`: seed 9009 (Oct 13) and seed 6006 (Oct 11) tables, "Wrong-patient pages 0" with the third-identifier check / default rule | OK |
| **20 of 20** auto-filed documents to the right chart on a vendor test system, 55 synthetic faxes | Home, Fax, LP | `INTAKE_ACCURACY.md` "Live sandbox run" (11 of 11 from 40 faxes) + "Live sandbox run: batch lab" (9 of 9 from 15 files), Oct 11 | OK |
| **~50%** of documents filed with no staff touch (synthetic) | Home, Fax, ROI default 45% | `INTAKE_ACCURACY.md` seed 9009: 50.0% (name_dob), 45.2% (two_identifiers); seed 6006: 43.0% / 52.7% | OK (labeled synthetic) |
| **1.4 s** median time to first response on lookup turns (pre-release) | Home, Phone | `VOICE_V7_EXPERIMENT.md` §1 and §5.2: tool turn first audio p50 1,361 ms (n=13), v7 cascade, web calls, Oct 15. Brief said "~1.3 s"; the measured median rounds to 1.4 s | OK; **re-measure on PSTN** before quoting further |

## Product behavior

| Claim | Source | Status |
|---|---|---|
| Local OCR; documents read on MOATiT's servers | `FAX_INTAKE_ADDON.md` Flow §2 (Tesseract container on the internal network; MOATiT Fax OCR) | OK |
| Name + DOB, exactly one patient; SSN-4/address checked when present; conflicts → staff; twins/look-alikes guarded | `FAX_INTAKE_ADDON.md` Matching, Twin guard | OK |
| Category mapping (e.g. Lab Results) | `FAX_INTAKE_ADDON.md` Clinic rules `INTAKE_CATEGORY_MAP` | OK |
| Multi-patient batch split, any doubt → whole file to staff | `FAX_INTAKE_ADDON.md` Batch faxes | OK |
| Review task to ordering provider (fallback reviewer) | `FAX_INTAKE_ADDON.md` `INTAKE_TASK_TARGET` | OK |
| Critical results: High priority, "CRITICAL", phone call required; Drawbridge never calls | `FAX_INTAKE_ADDON.md` Critical results | OK |
| Always-to-a-person documents (records requests, prior auths, refills, referrals) | `INTAKE_ALWAYS_PERSON` | OK |
| Same-day appointment rule; critical always notifies | `INTAKE_SAME_DAY_NO_NOTIFY` | OK |
| Staff review queue, one-click file/correct | `FAX_INTAKE_ADDON.md` Fallback §7 | OK |
| Shadow week before go-live | `FAX_INTAKE_ADDON.md` Shadow mode; `CLINIC_ONBOARDING.md` | OK |
| Originals deleted 30 days after filing; intake patient details 90 days; call records 30 days; audit 6 years | `SECURITY_CONTROLS.md` §4 | OK |
| 15-question, ~5-minute setup sheet | `CLINIC_ONBOARDING.md` §2 | OK |
| Phone: server-enforced verification; max 2 verified people, 5 searches per call | `SECURITY_CONTROLS.md` §1.2a; `VOICE_V7_EXPERIMENT.md` §2.6a | OK |
| Phone: 911 line wording; no medical advice; transfer on request; read-back before change; reschedule books new before cancelling old | `retell-prompts/unity-healthcare-agent.md` (cert-hardening) | OK |
| After hours: urgent → on-call provider with brief; routine → staff task | same prompt, "AFTER HOURS" | OK |
| Call recordings: PII redaction post-call, 30-day retention | `VOICE_V7_EXPERIMENT.md` §3 ("PII redaction (post-call, 14 categories) … 30-day retention") | OK |
| Records down → callers told, message taken, help desk alerted | `VOICE_V7_EXPERIMENT.md` §2.5 | OK (help-desk SMTP must be configured: **GATE**) |
| 24/7 answering | Business-hours and after-hours modes in the prompt | **CONFIRM** the clinic line routing is live 24/7 for each client |
| Outreach only with a staff click or a schedule; opt-out list | `PLATFORM_PLAN.md` rule 6; `SECURITY_CONTROLS.md` §4 | OK |
| Writes limited to appointments, appointment status, patient registration, tasks, scanned documents | `PLATFORM_PLAN.md` rule 3 + intake `SaveScanDocument` | OK |
| What we need from the practice: a five-minute setup sheet, and the BAA with Veradigm® access authorized. Nothing from the practice's IT side; no fax forwarding, lab access or software on staff PCs. Phone assistant: MOATiT sets up the calls the practice chooses with its phone provider (number unchanged) | Ali's direction (Oct 17): onboarding is setup sheet, BAA + Veradigm authorization, shadow week, switch on step by step | **CONFIRM** with engineering that intake reads from the practice's Veradigm® EHR document queue (earlier docs: `FAX_INTAKE_ADDON.md` described MOATiT Fax and a drop folder) |
| "Your workflow stays exactly as it is" / "done for you" / "switch it off at any time": Drawbridge works from the documents already in the Veradigm® EHR document queue; results and review tasks appear in Veradigm® EHR | Ali's direction (Oct 17); `SaveTask` review tasks land in the EHR task list | **CONFIRM** with engineering: queue-based intake, and that switching Drawbridge off leaves the queue and workflow untouched. Staff who handle close calls use the Drawbridge review screen, so the site never says "no new software to learn" |
| "Built so the same team can serve many times more patients" / "imagine ten times the volume" | Ali's direction (Oct 16) | Aspirational copy only, framed as vision with an on-page note; never in proof blocks or stated as measured |
| Single-tenant per clinic | System diagram ("MOATiT-hosted, single tenant per clinic") | OK |
| No model training on practice data | No training code in the repo; OCR local; matching rule-based | **CONFIRM** with Ali (vendor terms for the voice platform) |

## Security and compliance

| Claim | Source | Status |
|---|---|---|
| MFA (TOTP) mandatory, 90-day expiry, history 5, lockout 5/15 min, idle 15 min, 12 h max | `SECURITY_CONTROLS.md` §1.1; `HIPAA_TECHNICAL_SAFEGUARDS.md` owner decisions | OK in code; **GATE D7** (re-issue users file with TOTP) |
| Tamper-evident hash-chained audit log, 6 years | `SECURITY_CONTROLS.md` §3.2 | OK in code (open MEDIUM M-4: chain keyed with HMAC / off-host anchor recommended) |
| Access & disclosure reports | `HIPAA_TECHNICAL_SAFEGUARDS.md` #33 | OK |
| TLS 1.2+ in transit | `HIPAA_TECHNICAL_SAFEGUARDS.md` #28-29 | **GATE D6** (edge TLS) |
| Encryption at rest | `HIPAA_TECHNICAL_SAFEGUARDS.md` #24 | **GATE D1/D6** (EBS/KMS encryption) |
| US hosting on AWS | `HIPAA_TECHNICAL_SAFEGUARDS.md` organizational row; `VOICE_V7_EXPERIMENT.md` §10 | **GATE D2** (move PHI off the workstation tunnel to the BAA-covered AWS host) |
| Backups every 2 h, 6 months, encrypted, immutable | `HIPAA_TECHNICAL_SAFEGUARDS.md` backup section ("MOATiT policy") | **GATE** (deployment) |
| BAA with every practice and with AWS (and the voice platform) | `HIPAA_TECHNICAL_SAFEGUARDS.md` remaining items | **CONFIRM** BAAs signed (AWS, Retell) |
| SentinelOne EDR; patching within 7 days | same | OK (MOATiT policy) |
| Annual HIPAA training; incident response; DR/BCP | same | OK (MOATiT policy) |
| Annual scans and pen tests by Garrison | same + Ali's brief | **CONFIRM** Garrison may be named publicly |
| Independent launch audit, PASS, all HIGH fixed | `LAUNCH_AUDIT_2026-10-16.md` | OK. Note: the audit asks for an independent re-review of fix commits `9232a3f..0805123` before production |
| SOC 2 in process, completed before end of 2027 | `HIPAA_TECHNICAL_SAFEGUARDS.md`; Ali's brief | OK (worded "in process") |
| Veradigm Connect certification in progress | Ali's brief; certification package Oct 15 | **CONFIRM** with Musab that naming the program is allowed under the Veradigm Connect agreement |

## Company facts

| Claim | Source | Status |
|---|---|---|
| MOATiT founded in Pocatello in 2013; Idaho, Utah, Wyoming; managed IT, cybersecurity, phones, online fax, backup/DR, EHR hosting | moatit.com homepage (read Oct 16, 2026) | OK |
| Contact: (208) 900-6628, (855) 550-6628, questions@moatit.com, 2306 Pocatello Creek Rd, Pocatello, ID 83201 | Ali's brief | OK |
| "Drawbridge and MOATiT are trademarks of MOATiT, LLC" | — | **CONFIRM** (unregistered marks are fine to claim with "trademarks"; drop if counsel prefers) |
| Trademark owner "Veradigm Inc. or its affiliates" | Public company name | **CONFIRM** exact wording with Veradigm's trademark guidelines |

## Before the site goes public

1. Close the **GATE** rows (or soften those lines to "required for every production deployment", which the trust center already does with its status pills).
2. Resolve the **CONFIRM** rows.
3. Legal review of `/legal/*` (marked "Draft for legal review").
4. Replace the demo-form placeholder endpoint.
