# Repo audit: `moatit/veradigm-ai-mcp`

**Audited:** October 8, 2026, from a shallow clone of `main` at `edaf08f`.
**Not verified live:** the sandbox was unreachable from the auditing workspace. Every "not in Veradigm's reference" finding below needs the sandbox check (`scripts/verify-sandbox.ts`) before code changes.

## 1. What's in the repo

| Path | What |
|---|---|
| `src/index.ts`, `src/test-server.ts` | FHIR MCP server (port 3000): 22 tools in `src/tools/*` |
| `src/unity/index.ts`, `src/unity/unity-test-server.ts` | Unity MCP server (port 3001): 13 tools in `src/unity/tools/*` |
| `src/services/fhir.service.ts`, `auth.service.ts` | FHIR client: search/read/POST, OAuth token cache |
| `src/unity/services/unity.service.ts`, `unity-auth.service.ts` | Unity MagicJson client: GetToken → GetUserAuthentication → actions; token cache |
| `src/unity/config/unity-endpoints.ts` | Unity action name constants (lines 52–125) |
| `src/middleware/access-control.ts`, `admin-logger.ts` | Access control and logging middleware |
| `retell-prompts/unity-healthcare-agent.md` | The Retell voice agent prompt (Unity tools only) |
| `postman/` | Collections for all FHIR and Unity tools; sandbox environments (**check these for secrets before sharing**) |
| `infra/` | Terraform (AWS EC2, ECR, IAM, SSM params), nginx for `admin.`, `fhir.`, `unity.veradigmai.com`, prod compose |
| `.github/workflows/deploy.yml` | **Push to `main` deploys to AWS.** Ignores `infra/**`, `*.md`, `postman/**` |
| `.env.example` | All config keys (FHIR, Unity, admin portal) |

The admin portal (port 5001, NextAuth, DB) is referenced in `.env.example` and nginx but **its code is not in this repo.**

## 2. Repo freshness

- `main` last commit: **Feb 13, 2026** (Kanaya, merge PR #8 `fix-response-setup`).
- Other branches: `feat/fhir-read-operation` (Feb 11), `fix-response-setup` (Feb 13), both older or already merged.
- Ali reports the agent's appointment changes work today. If that relied on code changed after Feb 13, **that code is not in GitHub.** Get it pushed before building on `main`.

## 3. Unity action names not found in Veradigm's references

`src/unity/config/unity-endpoints.ts` sends these action names. None appear in Veradigm's Practice Management API Reference or EHR API Reference (`source-docs/`):

| Line | Constant | Sent as | Closest action in Veradigm's reference | System |
|---|---|---|---|---|
| 72 | UPDATE_DEMOGRAPHICS | `UpdateDemographics` | `SavePatient` (adds or updates demographics) | PM |
| 79 | GET_APPOINTMENTS | `GetAppointments` | `GetScheduleByPatientID` (per patient), `GetAppointmentById` (one), `GetSchedule` (date range) | PM |
| 81 | CANCEL_APPOINTMENT | `CancelAppointment` | `SetAppointmentStatus` + reason from `GetAppointmentCancellationReasons` | PM |
| 82 | GET_OPEN_SLOTS | `GetOpenSlots` | `GetAllAvailableAppointments`, `GetFirstAvailableAppointments`, `GetAvailableSchedule` | PM |
| 83 | BOOK_APPOINTMENT | `BookAppointment` | `SaveAppointment` | PM |
| 96 | GET_PATIENT_PROBLEMS | `GetPatientProblems` | `GetProblems` | EHR |
| 99 | GET_PATIENT_MEDICATIONS | `GetPatientMedications` | `GetClinicalSummary` / `GetPatientSections` (no single meds action in the EHR reference) | EHR |
| 100 | GET_PATIENT_ALLERGIES | `GetPatientAllergies` | `GetAllergies` | EHR |
| 56 | LAST_LOG | `LastLog` | `LastLogs` | both |
| 123 | SEARCH_PROVIDERS | `SearchProviders` | `GetProviders` / `GetProvider` (EHR), `GetPractitioners` (PM) | — |
| 89–91, 98, 116 | encounter/diagnosis/order constants | `GetEncounterList`, `SaveSimpleEncounter`, `GetEncounterSummary`, `SaveDiagnosis`, `GetOrderHistory` | not in the references; not used by the 13 tools | — |

Two possible explanations:
- **(a)** The sandbox is a different Veradigm product that accepts these names, and they work.
- **(b)** They fail, and the tools hide the failure (see §4).

`scripts/verify-sandbox.ts` calls both the repo name and the reference name for each pair, which settles it in one run.

**Recommended fix:** move action names to config (env or per-client JSON) with defaults from Veradigm's reference, so a product difference is a config change, not a code change. This also satisfies Veradigm's API Assessment requirement that per-client settings be centrally reconfigurable.

## 4. Silent failures that become wrong answers on a call (top demo risk)

| File:line | Behavior | Effect on a call |
|---|---|---|
| `src/unity/tools/appointment.tools.ts:224` | `get_open_slots`: on any Unity error, returns `{ slots: [], total: 0 }` | Agent says "there are no openings" when the call failed |
| `src/unity/tools/appointment.tools.ts:277` | `get_patient_appointments`: on any Unity error, returns `{ appointments: [], total: 0 }` | Agent says "you have no upcoming appointments" when the call failed |
| `src/unity/tools/patient.tools.ts:~331` | `searchPatients`: on failure returns `patients: []` with the error only in `message` | Agent may say "no match" instead of "having trouble" |

**Fix:** return an explicit `{ success: false, error_code, retryable }` result. Then the Retell prompt's existing Rule 1 ("Error → I'm having trouble pulling that up") fires instead of the empty-result branch. Apply the same pattern to every tool.

## 5. Patient search filtering

`src/unity/tools/patient.tools.ts:344` has the comment: *"Unity API often returns ALL patients regardless of filters"*. The code filters client-side. This usually means the `SearchPatients` Parameter1 format isn't what Unity expects. It works for the demo, but it's slow and pulls patient lists into memory. Check Veradigm's `SearchPatients` documentation (PM: XML in Parameter 1, max 100 results) and fix after the demo.

## 6. FHIR server vs Veradigm's FHIR API

- Veradigm's FHIR API is **read only** (Veradigm docs). `create_appointment` POSTs to `/Appointment` via `fhir.service.ts:254`. It can't work in production.
- Veradigm's published R4 resource list has **no Appointment and no MedicationStatement** resource. The six appointment tools and `get_medication_statements` (already defensive at `src/tools/medication.tools.ts:238`) should be disabled in the agent's tool list. Scheduling goes through Unity PM.
- The current sandbox base `scmlatestdev.open.allscripts.com` looks like a Sunrise (Altera) dev server, not Veradigm EHR. Move to a Veradigm EHR R4 endpoint from the Endpoint Directory after the demo.
- **Redacted data:** no handling found (`grep -ri redact src` = 0). Veradigm can return entries marked redacted. Add a check so the agent never reports "none on file" for redacted data.
- **Production auth:** use the system app (backend JWT client assertion). The current flow is configured with `CLIENT_ID`/`CLIENT_SECRET` plus auth/token URLs. Confirm it isn't the user-login flow, which needs a person at a screen.

## 7. Deployment and safety notes

- `deploy.yml` deploys on **every push to `main`**. Work on branches; merge only after the sandbox checks pass.
- The deck says Drawbridge runs in MOATiT's data center; the repo deploys to **AWS EC2**. Decide which is true for production with real PHI (see `08_DECISIONS_AND_OPEN_QUESTIONS.md`), and make sure a BAA covers whichever hosts PHI.
- Before sharing the repo with anyone new, check `postman/environments/*.json` for real credentials.
