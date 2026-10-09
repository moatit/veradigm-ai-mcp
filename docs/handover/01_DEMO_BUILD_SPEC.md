# VeradigmAI on Drawbridge: Sandbox Demo Build Spec

**Goal:** a fully working, live demo on Veradigm sandbox data for the Idaho Kidney Institute presentation.
**Deadline:** Friday, October 9, 2026, 5:00 PM MT. Code freeze 2:00 PM MT.
**Test line:** (208) 904-3641.
**Owner:** Ali Khan (MOATiT). Drawbridge tools: Kanaya.
**Repo:** `github.com/moatit/veradigm-ai-mcp` (TypeScript; FHIR server on :3000, Unity server on :3001). Read `02_REPO_AUDIT.md` before changing code.

The client deck (VeradigmAI, Idaho Kidney Institute) is the source of truth for what we promise. This spec makes every claim in it demonstrable on sandbox data.

---

## 0. Definition of done (demo scenarios, in priority order)

| # | Priority | Scenario | Test patient | Systems |
|---|---|---|---|---|
| 1 | P0 | **Reschedule.** Caller verifies, hears their upcoming visits, gets open times, books a new time, old visit is cancelled with a valid reason. | Ed Smith, DOB 12/06/1952, MRN 56500 (backup: Nichole Albanese, DOB 04/24/1928, MRN 29700) | Veradigm PM (Unity) |
| 2 | P0 | **Chart lookup.** Caller verifies, asks about current medications and allergies; agent reads them back, gives no advice. | John Smith, DOB 01/15/1980 | Veradigm EHR (FHIR) |
| 3 | P0 | **Guardrails.** Wrong DOB gets no information; "should I double my dose?" gets a transfer, not advice; "chest pain" gets 911 first. | any | none |
| 4 | P1 | **After-hours on-call.** Call in after-hours mode; agent verifies, takes the message, pulls chart context, marks urgency; record appears in the Drawbridge app on-call notebook; routine calls also create a staff task. | Ed Smith (task), John Smith (chart) | Drawbridge app, Unity EHR SaveTask, FHIR |
| 5 | P1 | **Billing.** "What do I owe?" and "What insurance do you have on file?" | Ed Smith | Veradigm PM (Unity) |
| 6 | P2 | Confirm an appointment; staff assistant answers "who has an opening Tuesday afternoon?" | Ed Smith | Veradigm PM (Unity) |

**Sandbox caveat:** the Unity and FHIR sandboxes hold different patients. Each demo flow must verify the patient against the system that holds them: Unity flows via `search_patients`, FHIR flows via `verify_patient_identity`. Do not mix a Unity patient into a FHIR lookup on stage.

---

## 1. Architecture

```
Caller ──> Voice agent (Retell, test line) ──> Drawbridge (MCP servers; today on AWS EC2 behind
           fhir.veradigmai.com / unity.veradigmai.com — see hosting question in 08)
                                           ├── Veradigm EHR · FHIR R4 (read only)      15 tools
                                           ├── Veradigm EHR · Unity                    8 tools
                                           ├── Veradigm PM  · Unity                   16 tools
                                           └── Call records store ──> Drawbridge app (on-call notebook)
```

- The voice agent can only act through Drawbridge tools. No direct database access.
- All traffic over HTTPS (a Veradigm requirement before QA testing).
- Per-client settings live in one config row or file per client, never in code. Veradigm's API assessment requires these to be reconfigurable: Unity endpoint, Unity service credentials, EHR/PM user and password, polling interval. Add the FHIR base URL, client ID and key reference.

## 2. Environments and credentials

| Item | Sandbox value / source | Notes |
|---|---|---|
| Unity JSON endpoint | `https://ubiquityunity.azurewebsites.net/UnityService.svc/json/MagicJson` | From Kanaya's Oct 8 email. Repo env: `UNITY_UBIQUITY_ENDPOINT`, `UNITY_UBIQUITY_ID_PM`, `UNITY_UBIQUITY_ID_EHR`, `UNITY_APP_NAME`, `UNITY_SVC_USERNAME/PASSWORD`, `UNITY_EHR_USERNAME/PASSWORD`. |
| Unity auth | GetToken with the Unity app credentials, then `GetUserAuthentication` with the EHR/PM user | Already implemented in `src/unity/services/unity-auth.service.ts` (token cached under Unity's 20-minute expiry). |
| FHIR base (current) | `https://scmlatestdev.open.allscripts.com/FHIR` (repo env: `FHIR_BASE_URL_SANDBOX`, `AUTH_URL_SANDBOX`, `TOKEN_URL_SANDBOX`, `CLIENT_ID`, `CLIENT_SECRET`) | Looks like a Sunrise (Altera) dev server. Fine for tomorrow if the test patients work. After the demo, move to a Veradigm EHR R4 endpoint from the Veradigm Endpoint Directory. |
| FHIR auth (production) | System app, backend JWT client assertion to the token endpoint | Single-use assertion, 2–20 minute expiry. The user-login and SMART flows need a person at a login screen and will not work for a phone agent. |
| FHIR headers | `Accept: application/fhir+json` plus `fhirVersion=4.0` | DSTU2 support ended 6/1/2025. |

**Secrets:** environment variables or the vault only. Never commit them, never paste them in chat or tickets.

## 3. Tool catalog (39 tools)

Status: **Built** = available to the agent today. **Planned** = Kanaya adds. Priority = the demo scenario that needs it.

Tool names here are the client-facing names. In the repo, Unity tools carry a `unity_` prefix (`unity_search_patients`, `unity_cancel_appointment`, ...). Keep the existing repo names so the Retell agent config doesn't break, and give new Unity tools the same prefix. `03_TOOL_CATALOG.csv` maps both.

### Veradigm EHR · FHIR R4 (read only) — 15

| Tool | FHIR call | Status | Priority |
|---|---|---|---|
| search_patient | GET /Patient | Built | P0 |
| get_patient_details | GET /Patient/{id} | Built | P0 |
| verify_patient_identity | GET /Patient (name + birthdate) | Built | P0 |
| get_patient_medications | GET /MedicationRequest?patient= | Built | P0 |
| get_medication_requests | GET /MedicationRequest | Built | P1 |
| check_refill_status | GET /MedicationRequest | Built | P1 |
| search_providers | GET /Practitioner | Built | P2 |
| get_provider_details | GET /Practitioner/{id} | Built | P2 |
| search_locations | GET /Location | Built | P2 |
| get_location_details | GET /Location/{id} | Built | P2 |
| get_patient_conditions | GET /Condition?patient= | Built | P1 |
| get_allergies | GET /AllergyIntolerance?patient= | Built | P0 |
| get_recent_observations | GET /Observation?patient= | Built | P1 |
| get_patient_procedures | GET /Procedure?patient= | Built | P2 |
| get_patient_coverage | GET /Coverage?patient= | Built | P2 |

Not in the production set: the six FHIR appointment tools and `get_medication_statements`. Veradigm's published R4 resource list has no Appointment or MedicationStatement resource. Leave them disabled in the agent's tool list so the demo matches the deck; appointments go through Veradigm PM.

### Veradigm PM · Unity — 16

| Tool | Unity action | R/W | Status | Priority |
|---|---|---|---|---|
| search_patients | SearchPatients | R | Built | P0 |
| save_patient | SavePatient | W | Built | P2 |
| update_demographics | SavePatient | W | Built | P2 |
| get_patient_appointments | GetScheduleByPatientID | R | Built | P0 |
| get_appointment_details | GetAppointmentById | R | Planned | P1 |
| get_open_slots | GetAllAvailableAppointments | R | Built | P0 |
| save_appointment | SaveAppointment | W | Built | P0 |
| cancel_appointment | SetAppointmentStatus | W | Built | P0 |
| confirm_appointment | SetAppointmentStatus | W | Planned | P2 |
| get_cancellation_reasons | GetAppointmentCancellationReasons | R | Planned | P0 |
| get_appointment_types | GetAppointmentTypes | R | Planned | P1 |
| get_day_schedule | GetSchedule | R | Planned | P2 |
| get_changed_appointments | GetAppointmentsByChangeDTTM | R | Planned | later |
| get_patient_recalls | GetRecalls | R | Planned | later |
| get_account_balance | GetPatientAccountBalance | R | Planned | P1 |
| get_insurance_policy | GetPatientPolicy | R | Planned | P1 |

### Veradigm EHR · Unity — 8

| Tool | Unity action | R/W | Status | Priority |
|---|---|---|---|---|
| get_patient | GetPatient | R | Built | P1 |
| get_patient_by_mrn | GetPatientByMRN | R | Built | P1 |
| get_patient_problems | GetProblems | R | Built | P1 |
| get_patient_allergies | GetAllergies | R | Built | P1 |
| get_patient_diagnosis | GetPatientDiagnosis | R | Built | P2 |
| get_patient_medications_ehr | GetClinicalSummary (or GetPatientSections) | R | Built | P1 |
| create_staff_task | SaveTask | W (task only, never the chart) | Planned | P1 |
| get_location_hours | GetLocation | R | Planned | P2 |

**Action check:** for each Built tool, confirm which Veradigm action it calls today matches the table. Action names come from Veradigm's PM and EHR API references. This list is also what goes into the Unity API assessment, so lock it before certification.

`GetPatientAccountBalance` returns one record per voucher; the tool must sum them into one balance.

## 4. Tool behavior rules

1. **Identity before anything.** `verify_patient_identity` / `search_patients` must match full name and date of birth. Two attempts max, then transfer. No patient data is returned or spoken before a match.
2. **Read back before every write.** The agent states the exact change ("Tuesday, October 13 at 9:00 AM with [provider]. Shall I book it?") and waits for a yes before calling any W tool.
3. **Idempotency.** Each write carries a call ID + tool + patient key so a retried request cannot double-book.
4. **Cancel with a real reason.** `cancel_appointment` uses a value from `get_cancellation_reasons`.
5. **No chart writes.** The only EHR write is `create_staff_task`. No orders, refills, notes or problem-list changes.
6. **Redacted FHIR data.** If a result is marked redacted, never say "none on file". Say it can't be shared by phone and offer a transfer.
7. **Errors.** FHIR 401/403/404/413 and any Unity error: one retry for transient errors, then a plain apology and transfer. Never read raw errors to a caller.
8. **Audit log.** Every tool call: timestamp, call ID, tool, patient ID, success/failure, latency. No transcripts or chart contents in application logs.

## 5. Agent guardrails (system prompt)

- Emergency words (chest pain, trouble breathing, stroke symptoms, severe bleeding, suicidal thoughts) → tell the caller to hang up and call 911 first. Exact wording to be approved by Idaho Kidney's clinical lead before production.
- Never interpret labs, conditions or medications, and never give medical advice. Clinical questions → transfer or staff task.
- Any caller can ask for a person at any time.
- After-hours mode: switched on by schedule, takes messages, marks urgency, never promises a callback time it can't keep.

## 6. Drawbridge app: on-call notebook (minimum for the demo)

**Call record:**
```
call_id, started_at, mode (business_hours | after_hours), caller_phone,
verified (bool), patient_ref {system, id}, patient_name, dob,
reason_verbatim, urgency (urgent | routine),
chart_snapshot {medications[], allergies[], problems[], latest_observations[], next_appointment},
actions_taken[] {tool, result}, staff_task_id, transcript_ref
```

**Screens:**
1. Tonight's calls, newest first, with urgent ones on top.
2. A call detail page that shows everything in the record.

Login is required even for the demo.

**Urgent alert:** sent to the on-call provider through the voice platform (SMS or call). For the demo, a visible "alert sent" entry on the record is enough if live paging isn't wired.

## 7. Timeline (all MT)

| When | Work |
|---|---|
| Thu night | Get Kanaya's latest code pushed. Run `scripts/verify-sandbox.ts`. Fix action names and the silent empty-list returns (`02_REPO_AUDIT.md` §3–4). Confirm the action map for Built tools. Add P0/P1 Planned tools: cancellation reasons, appointment types, appointment details, balance, insurance policy, staff task. Disable FHIR appointment tools in the agent. |
| Fri 9 AM | Call record store and on-call notebook screens. After-hours mode switch. |
| Fri 12 PM | End-to-end runs of scenarios 1–5 by phone, three times each. Fix what breaks. |
| Fri 2 PM | **Code freeze.** Record a narrated screen + audio video of scenarios 1, 2 and 4. This is the backup if the sandbox is down, and it is also the "workflow video" Veradigm's API assessment requires. |
| Fri 4:30 PM | Final live test call on (208) 904-3641. |

## 8. Demo script (5 minutes)

1. The owner calls the test line as **Ed Smith (12/06/1952)** and moves his next appointment. (Scenario 1)
2. Ali calls as **John Smith (01/15/1980)** and asks for his medications and allergies, then asks whether to change a dose. The agent transfers instead of advising. (Scenarios 2–3)
3. Switch to after-hours mode, call with a routine message, and open the Drawbridge app to show the complete record and the staff task. (Scenario 4)

## 9. After the demo (production path)

- Veradigm Connect Gold or Platinum plan in place (required to enter certification).
- Security Questionnaire and Unity API Assessment, which needs:
  - integration description
  - the full Unity action list (section 3)
  - system/sequence diagram
  - install and config screenshots
  - narrated workflow video
  - EHR/PM workflows
  - credential management process
- Credential renewals: Unity production credentials every 6 months; EHR/PM user passwords about every 90 days. Subscribe to expiry notices in the Developer Portal.
- Ask VeradigmConnect@veradigm.com:
  - (a) Does a read-only FHIR system app need any review before production at a client site?
  - (b) Is there a FHIR license fee?
  - (c) Written consent for the VeradigmAI name and veradigmai.com (Integrator Agreement §1.5 and §9.2(b)).
- Idaho Kidney: Unity is already connected, so their side is two approvals plus a system user and call scripts.

## 10. Open questions for Kanaya (answer tonight)

1. Is there code newer than the Feb 13 `main`? Push it. Which Veradigm action does each Built tool actually call in that code?
2. Which Retell agent serves (208) 904-3641, and is it pointed at `unity.veradigmai.com` / `fhir.veradigmai.com` on AWS?
3. Are the PM and EHR sandbox users the same login or two?
4. What FHIR auth flow is used against the sandbox today?
5. Where should call records live (database, and is it in the MOATiT data center)?
