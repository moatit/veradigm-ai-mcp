# Claims register

Every factual claim on the site, its source, and what must be true before the site goes public. Numbers live in one place (`src/content/site.mjs` → `CLAIMS`) so the site never disagrees with itself. Source documents are on branch `drawbridge/cert-hardening` of `veradigm-ai-mcp` (`docs/drawbridge/…`) unless noted.

Status: **OK** = verified against a source; **CONFIRM** = Ali/Musab to confirm before public launch; **GATE** = true only once a deployment gate is closed.

## Proof numbers

| Claim on site | Where | Source | Status |
|---|---|---|---|
| **0** wrong-patient filings in synthetic testing (held-out sets of 3,000 documents; 4,402 result pages in the latest) | Home, Fax, LP | `INTAKE_ACCURACY.md`: seed 9009 (Oct 13) and seed 6006 (Oct 11) tables, "Wrong-patient pages 0" with the third-identifier check / default rule | OK |
| **20 of 20** auto-filed documents to the right chart on a vendor test system, 55 synthetic faxes | Home, Fax, LP | `INTAKE_ACCURACY.md` "Live sandbox run" (11 of 11 from 40 faxes) + "Live sandbox run: batch lab" (9 of 9 from 15 files), Oct 11 | OK |
| **~50%** of documents filed with no staff touch (synthetic) | Home, Fax, ROI default 45% | `INTAKE_ACCURACY.md` seed 9009: 50.0% (name_dob), 45.2% (two_identifiers); seed 6006: 43.0% / 52.7% | OK (labeled synthetic) |
| **1.4 s** median time to first response on lookup turns, labeled "Unreleased agent version, web calls" | Home, Phone, LP | `VOICE_V7_EXPERIMENT.md` §1 and §5.2: tool turn first audio p50 1,361 ms (n=13), the v7 draft (not published), web calls, Oct 15. The live line (v6) measured p50 3,332 ms | OK as labeled (audit release-1 (Oct 18), M2). The "one moment" sentence was removed until v7 is live. **Re-measure on the phone network** before quoting it further |

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
| Phone: 911 line wording; no medical advice; transfer on request; read-back before change; reschedule books new before cancelling old | the production voice prompt in `veradigm-ai-mcp` (cert-hardening) | OK |
| After hours: urgent calls are flagged for the on-call provider in the on-call notebook, with a short brief, and callers are told how to reach them; emergencies to 911; routine → staff task. Live transfer to the on-call provider with the brief is listed as "In progress" | Prompt "AFTER HOURS"; `oncall.tools.ts` (live paging not wired); build plan 3.4 | OK (audit release-1 (Oct 18), H4) |
| Call recordings: PII redaction post-call, 30-day retention | `VOICE_V7_EXPERIMENT.md` §3 ("PII redaction (post-call, 14 categories) … 30-day retention") | OK |
| Records down → callers told, message taken; status alerts by email to **MOATiT's help desk** | `VOICE_V7_EXPERIMENT.md` §2.5 | **GATE** (help-desk SMTP not set yet). The site labels it "Every deployment" and says alert delivery is configured for every production deployment (audit release-1 (Oct 18), H2) |
| "Answers the calls you route to it, day and night" (replaces "24/7" and "every call" in headings, titles and JSON-LD) | Business-hours and after-hours modes in the prompt; routing is per practice | OK (audit release-1 (Oct 18), M3). Say "available 24/7" only once production hosting (D2) and the platform's uptime terms support it |
| Outreach only with a staff click or a schedule; opt-out list | `PLATFORM_PLAN.md` rule 6; `SECURITY_CONTROLS.md` §4 | OK |
| Writes limited to appointments, appointment status, patient registration, tasks, scanned documents | `PLATFORM_PLAN.md` rule 3 + intake `SaveScanDocument` | OK |
| What we need from the practice: before the shadow week, a five-minute setup sheet and the BAA with Veradigm® access authorized; at go-live, MOATiT sets up the fax routing and the lab file drop with the practice, and the line forwards the calls it chooses to Drawbridge first (moving the number over comes later) | Ali's decision (Oct 18, audit release-1 H1); `CLINIC_ONBOARDING.md` (fax routing, lab drop folder, phone routing); intake sources `moatit_fax` / `folder` (`store.ts`); shadow mode reads the Veradigm® indexing queue only to compare (`observe.ts`); `ENABLED_MODULES` module switch ships in release-1 | OK (audit release-1 H1, resolved Oct 18) |
| Shadow week: one week read-only alongside the team; staff keep indexing in Veradigm® EHR as today; Drawbridge reads each incoming document, decides where it would file it and compares that with where staff filed it; nothing is written to the chart. "If you decide not to go ahead, we switch Drawbridge off. Nothing in your system changed during the shadow week." The site makes no "workflow stays exactly as it is" claim beyond the shadow week | Ali's decision (Oct 18, audit release-1 H1); `CLINIC_ONBOARDING.md` (fax routing, lab drop folder, phone routing); intake sources `moatit_fax` / `folder` (`store.ts`); shadow mode reads the Veradigm® indexing queue only to compare (`observe.ts`); `ENABLED_MODULES` module switch ships in release-1 | OK (audit release-1 H1, resolved Oct 18) |
| "Built so the same team can serve many times more patients" / "imagine ten times the volume" | Ali's direction (Oct 16) | Aspirational copy only, framed as vision with an on-page note; never in proof blocks or stated as measured |
| Single-tenant per clinic | System diagram ("MOATiT-hosted, single tenant per clinic") | OK |
| No model training: "Drawbridge's own software does not train AI models on your data"; written confirmation for the voice platform "in progress" | No training code in the repo; OCR local; matching rule-based. Calls are processed by a third-party voice platform | Status "In progress" on the trust page (audit release-1 (Oct 18), H2). **CONFIRM** with Ali: the voice platform's terms in writing, then the FAQ can cover calls |

## Site copy added Oct 17-18, 2026

| Claim on site | Where | Source | Status |
|---|---|---|---|
| "Lab results filed. Calls answered. **Every one checked.**" | Home hero, OG image | Every document passes the two-identifier rule before filing or goes to a person; every caller is verified before any record is read (rows above) | OK: "checked" means the rules ran on every document and call, not that every document is filed |
| Close calls go to a person, already read and explained, with the reason | Home, fax, FAQ | `FAX_INTAKE_ADDON.md` fallback §7, matching rules | OK |
| Four steps: setup sheet; BAA + Veradigm® authorization; read-only shadow week; go live when the practice approves (faxes and lab files come to Drawbridge first; certain matches filed with a review task; anything that needs a person goes to the Veradigm® EHR document queue for staff, as today) | Home, FAQ, integrations, pricing, fax page, campaign docs | Ali's decision (Oct 18, audit release-1 H1); `CLINIC_ONBOARDING.md` (fax routing, lab drop folder, phone routing); intake sources `moatit_fax` / `folder` (`store.ts`); shadow mode reads the Veradigm® indexing queue only to compare (`observe.ts`); `ENABLED_MODULES` module switch ships in release-1 | OK (audit release-1 H1, resolved Oct 18) |
| Synthetic intake ledger: five invented faxes, two filed and three to a person (address differs; referrals always to staff; two patients on one page; critical flag gives a high-priority task with a call required) | Home hero, `/lp/*`, OG image | Invented patients; each outcome matches a rule above | OK: labeled "Synthetic sample" in a full-width bar and in the footnote |
| "Test a live call now": the test line (208) 904-3641 answers with the phone assistant on a Veradigm® sandbox; sample patients Ed Smith (12/06/1952) and Nichole Albanese (04/24/1928) are Veradigm sandbox test records | Home hero, phone page, `/lp/phone/` | `veradigm-ai-mcp/docs/handover/05_TEST_DATA.md`; `RETELL_SETUP.md` | **GATE 1B.2**: point the transfer at the help desk (today it reaches Ali's cell), cap the call length and set the cost limit before the site is public. The line depends on the host and tunnel being up |
| "A read-only shadow week first. Nothing is written to your chart until you approve." (home trust strip, going-live section, pricing, integrations) | Home, integrations, pricing, FAQ | Ali's decision (Oct 18, audit release-1 H1); `CLINIC_ONBOARDING.md` (fax routing, lab drop folder, phone routing); intake sources `moatit_fax` / `folder` (`store.ts`); shadow mode reads the Veradigm® indexing queue only to compare (`observe.ts`); `ENABLED_MODULES` module switch ships in release-1 | OK (audit release-1 H1, resolved Oct 18) |
| Drawbridge's working copies deleted 30 days after filing; the chart copy is the record | Fax page | `SECURITY_CONTROLS.md` §4 (originals deleted 30 days after filing) | OK |
| The assistant "never interprets results or medications and never advises; clinical questions go to your clinicians"; emergencies directed to 911 | Home, phone page, FAQ, integrations | Prompt line 9 (no interpretation or advice); 911 line | OK (audit release-1 (Oct 18), M1) |
| Verified callers can hear **recent results, as recorded** (read only; never interpreted), alongside medication and allergy lists, balance and insurance on file | Phone page, home, FAQ, integrations ("What Drawbridge reads") | Prompt scope and "Read results as recorded" (line 42); `unity_get_recent_results` in the agent tools (`agent-tools.ts:120`) | OK (audit release-1 (Oct 18), M1). **CONFIRM** with engineering whether a practice can turn result read-back off; the site makes no claim either way |
| Audit release-1 item waiting on Ali: H3 ("Test a live call now"). H1 was decided on Oct 18 and the copy now describes the real process (rows above) | `audits/release-1-2026-10-18/marketing-site.md` | H3 copy unchanged on purpose; **GATE 1B.2** |
| The home-page note is signed "Ali Khan, CEO, MOATiT" | Home | Ali's direction (Oct 17) | OK |

## Security and compliance

| Claim | Source | Status |
|---|---|---|
| MFA (TOTP) mandatory, 90-day expiry, history 5, lockout 5/15 min, idle 15 min, 12 h max | `SECURITY_CONTROLS.md` §1.1; `HIPAA_TECHNICAL_SAFEGUARDS.md` owner decisions | OK in code; **GATE D7** (re-issue users file with TOTP) |
| Tamper-evident hash-chained audit log, 6 years | `SECURITY_CONTROLS.md` §3.2 | OK in code (open MEDIUM M-4: chain keyed with HMAC / off-host anchor recommended) |
| Access & disclosure reports | `HIPAA_TECHNICAL_SAFEGUARDS.md` #33 | OK |
| TLS 1.2+ in transit: "required for every production deployment before patient data flows" (home, FAQ, trust meta description) | `HIPAA_TECHNICAL_SAFEGUARDS.md` #28-29 | **GATE D6**; worded as a requirement (audit release-1 (Oct 18), H2) |
| Encryption at rest: "required for every production deployment before patient data flows" | `HIPAA_TECHNICAL_SAFEGUARDS.md` #24 | **GATE D1/D6**; worded as a requirement (audit release-1 (Oct 18), H2) |
| US hosting (site: "a US cloud region and MOATiT's data center", "required for every production deployment"; vendor not named publicly) | `HIPAA_TECHNICAL_SAFEGUARDS.md` organizational row; `VOICE_V7_EXPERIMENT.md` §10 | **GATE D2** (move PHI off the workstation tunnel to the BAA-covered host); worded as a requirement (audit release-1 (Oct 18), H2) |
| Backups every 2 h, 6 months, encrypted, immutable: "required for every production deployment" (status "Every deployment") | `HIPAA_TECHNICAL_SAFEGUARDS.md` backup section; the shadow pilot runs daily backups kept 14 days | **GATE** (deployment); worded as a requirement (audit release-1 (Oct 18), H2) |
| BAA with every practice before patient data flows; BAAs with every provider that handles patient information "required before patient data flows, and in progress" (status "In progress"; site names no vendor) | `HIPAA_TECHNICAL_SAFEGUARDS.md` remaining items | **CONFIRM** BAAs signed (cloud host, voice platform); then the status can become "MOATiT policy" (audit release-1 (Oct 18), H2) |
| Managed endpoint detection and response; patching within 7 days (site names no vendor) | same | OK (MOATiT policy) |
| Annual HIPAA training; incident response; DR/BCP | same | OK (MOATiT policy) |
| Annual scans and pen tests by an independent outside firm (site names no firm) | same + Ali's brief | OK (the firm is no longer named, so no permission is needed) |
| "Code audit passed (Oct 2026), production re-review pending" (status "In progress") | `LAUNCH_AUDIT_2026-10-16.md` (PASS covers the code, subject to D1-D7) | OK as worded (audit release-1 (Oct 18), H2). Say "passed" without the qualifier only after the independent re-review of fix commits `9232a3f..0805123` |
| SOC 2 in process, completed before end of 2027 | `HIPAA_TECHNICAL_SAFEGUARDS.md`; Ali's brief | OK (worded "in process") |
| Veradigm Connect certification in progress; "Drawbridge connects through Veradigm's secure API" (was "secure partner interface") | Ali's brief; certification package Oct 15 | **CONFIRM** with Musab that naming the program is allowed under the Veradigm Connect agreement (audit release-1 (Oct 18), M4). The home h2 no longer uses Veradigm® as a hook ("Is your practice ready for more capacity?") |

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
