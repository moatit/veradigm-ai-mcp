# IKI clinic rules: end-to-end test on the Veradigm® sandbox (Oct 13, 2026)

**Scope.** Idaho Kidney Institute's intake clinic rules (`FAX_INTAKE_ADDON.md`, [Clinic rules](FAX_INTAKE_ADDON.md#clinic-rules-set-per-clinic)), tested for real against the Veradigm® EHR / PM **sandbox** through the normal intake path. Synthetic documents for the synthetic patients created on Oct 11 (session roster `sandbox_roster.json`, 11 patients) went into the local stack's drop folder (`deploy/local/intake/inbox`). Each filing and task was then checked in Veradigm® with read-only calls.

**Result: 11 of 11 scenarios PASS** (A-J, plus B2 added to read back a High-priority task). Writes used: **5 `SaveScanDocument` + 5 `SaveTask`** (budget 8 + 8), all to synthetic patients. Two code fixes were made on the way (below).

| | Scenario | Expected | Result |
|---|---|---|---|
| A | Normal lab, ordering provider 1 | Filed under Lab Results, Medium task to provider 1 | **PASS** (task recipient confirmed indirectly, see note) |
| B | Critical lab (K 6.9 HH, CRITICAL), provider 1 | Filed, High task "CRITICAL…" to provider 1, item shows phone call required | **PASS** (task recipient confirmed indirectly) |
| B2 | Critical lab, provider who matches nobody | Filed, High task "CRITICAL…" to `INTAKE_REVIEW_USER` (readable) | **PASS** (High read back as `UrgentNA`) |
| C | Lab, provider who matches nobody | Filed, Medium task to `INTAKE_REVIEW_USER` | **PASS** (task read back) |
| D | Renal ultrasound, provider 2 | Filed under the imaging category, task to provider 2 | **PASS** (task recipient confirmed indirectly) |
| E | Prior authorization, perfect name + DOB | Not filed, Needs review, "always reviewed by staff" | **PASS** |
| F | Medical records request, perfect name + DOB | Same | **PASS** |
| G | Prescription refill request, perfect name + DOB | Same | **PASS** |
| H | Referral letter, perfect name + DOB | Same | **PASS** |
| I | Same-day rule, no write (plan only, real schedule) | No task on an appointment day; task otherwise; critical always | **PASS** (7 of 7 decisions) |
| J | Name + DOB match, address differs from the chart | Not filed, staff, address reason | **PASS** |

**Note on "task recipient confirmed indirectly".** A task Drawbridge sends to another provider can't be read back with our sandbox user. `GetTaskList` only lists tasks addressed to our own user, with any parameters tried. `GetTask` on another user's task answers "That task has already been completed or the user does not have the rights to access it." Reading that provider's list would mean acting as that user, which we don't do. The evidence for A, B and D is:
1. The item records the `SaveTask` target (`ENTLER` / `SLAKSHMI`), taken from `GetProviders` `UserName`.
2. Veradigm® accepted the call and returned a task ID (`ENTLER`/`SLAKSHMI` are real sandbox logins from `GetProviders`). What Veradigm® does with a user name that doesn't exist was not tried (it would cost a write); the smoke tests assume a refusal.
3. The task is not in our own task list, and `GetTask` says we have no rights to it.

The two tasks addressed to our own user (C, B2) read back in full, with the right recipient code, priority, subject, type and patient. That shows the read-back method works and the routing code produces the expected `SaveTask`.

## Setup

- Branch `drawbridge/fax-intake` after merging `origin/drawbridge/fax-intake-iki-rules` (plus the fixes below). `npx tsc --noEmit -p .` clean, `npm run smoke:intake` 23 + 15 + 7 checks pass (before and after the fixes).
- Local stack `drawbridge-dev`, only the `unity` service rebuilt (`docker compose up -d --build --no-deps unity`) and the gateway restarted. No other container or port touched.
- `deploy/local/.env` (IKI's answers): `INTAKE_TASK_TARGET=ordering_provider`, `INTAKE_SAME_DAY_NO_NOTIFY=on`, `INTAKE_CATEGORY_MAP={"lab_result":"Lab Results"}`, `INTAKE_ALWAYS_PERSON` unset (= all four), `INTAKE_CRITICAL_NOTIFY` unset; unchanged: `INTAKE_FILING=auto`, `INTAKE_MATCH_RULE=name_dob`, `INTAKE_REVIEW_USER` (our sandbox EHR user; its name is not written here), `INTAKE_DOC_STATUS=approved`. Checked inside the container with the app's own setting readers.
- Documents: one-page PDFs with a text layer (`mini_pdf.js`), each marked "SYNTHETIC TEST DOCUMENT - NOT A REAL PATIENT". Collection / exam date 10/12/2026. Patient block: `Patient: <name>  DOB: <MM/DD/YYYY>`, no MRN or phone, so the name + DOB rule decides.
- Safety net before any write: each document went through a **read-only dry run** of the same steps (OCR container → `extractFields` → `matchPatient` with the live search → `GetDocumentType` → clinic rules → `planReviewTask`), on a Unity service that refuses every non-read action. The dry run found the merge bug below before any write was spent on it. Documents were then dropped one at a time (A, B, C, D), then E-H and J together, then B2.
- Ordering providers (step 4): **provider 1 = Miles Entler** (`ENTLER`, EntryCode 10004), **provider 2 = Lakshmi Subbarao** (`SLAKSHMI`, EntryCode 10099). Both are active, attending MDs, practice providers (`referral = N`), with no other provider within two letters of their last name among the 1,345.

## GetProviders: what the rows carry (step 4)

One read-only `GetProviders` (EHR, parameters blank) returned **1,345 rows** under `getprovidersinfo`. Field → rows with a value:

| Field | Filled | Notes |
|---|---|---|
| `UserName` | 1345 | The provider's Veradigm® EHR login: what `SaveTask` Parameter2 takes. **`notify.ts` / `rules.ts` guessed this name right.** |
| `FirstName`, `LastName` | 1345 | One `LastName` has a leading space (trimmed by the parser). |
| `EntryCode` | 1345 | Provider code; `GetTaskList` reports the recipient as this code (`msg_ToProvCode`). Read as the provider ID. |
| `ProviderInactive` | 1345 | `Y`/`N` (all `N` on the sandbox). **The parser read `Inactive` / `Active`, which Veradigm® does not send: fixed.** |
| `UserInactive` | 0 | Blank on the sandbox. Now read: an inactive login keeps the provider for matching but never sends it a task. |
| `UserType`, `Profession`, `PrimSpecialty`, `referral`, `Middle`, `npi`, `personid`, `Address`, `City`, `State`, `Zip` | various | `referral = Y` on 1,223 rows (referring providers); not used for matching. |
| `DefaultSiteName`, `DefaultSiteCode`, `SecSpecialty`, `Credentials`, `Security` | 0 | Always blank. |

Fix: commit `da08fed` "Intake: read GetProviders' real inactive fields (ProviderInactive, UserInactive)", with smoke rows in Veradigm®'s own shape. With the fix every sandbox row parses (1,345 active, all with a user name).

## GetScheduleByPatientID for our synthetic patients (step 4)

Read-only, by PM patient ID: `51387` (p01) and `51391` (p05) answer **success with no rows** (`{"getschedulebypatientidinfo": []}`): no appointments, as expected. Sandbox PM patient `46502` (not one of ours, read only) has 179 appointments, 1/12/2026 to 12/11/2026, statuses `S` 156, `C` 13, `A` 3, `X` 7. Row fields used by `notify.ts`: `Patient_ID`, `Appointment_DateTime` ("1/12/2026 2:20:00 PM"), `Status`.

## Scenarios

All IDs below were read back from Veradigm® unless marked. "Chart" = `GetDocuments` on the patient (EHR); "category listing" = `GetDocumentsByDocumentType` for the filed category, 10/10-10/14/2026, all patients. "Task" = `GetTask` + `GetTaskList`. Before/after: `GetDocuments` on all seven charts was snapshotted before the first drop.

### A. Normal lab result, ordering provider 1: PASS

- **Sent:** Summit Valley Reference Laboratory "LABORATORY REPORT" for Teodoro Brightwater (p03), DOB 02/17/1949. `Ordering Provider: Miles Entler, MD`, collected 10/12/2026. Creatinine 1.9 H, BUN 31 H, hemoglobin 11.2 L.
- **Expected:** filed under "Lab Results", Medium review task to `ENTLER`.
- **Actual:** item `in_mv6vtnyf77cd78e8c7`, auto-matched by name + DOB to EHR 81069. Filed as **document 22755** ("Outside lab Oct 12 2026 - SUMMIT VALLEY REFERENCE", Approved, clinical date 10/12/2026), on chart 81069 (the only new document there) and in the "Lab Results" listing for patient 81069. Review **task 21788** sent to `ENTLER` (ordering provider, "matched to one Veradigm® EHR provider"), Medium. Same-day check: "No appointment on 10/12/2026."
- **Task read-back:** not readable by our user (see the note at the top); accepted with an ID.

### B. Critical lab, ordering provider 1: PASS

- **Sent:** same lab layout for Marisol Dunkerley (p04), DOB 11/05/1971, provider Entler: `POTASSIUM 6.9 HH`, sodium 133 L, creatinine 4.8 H, and `*** CRITICAL RESULT: POTASSIUM 6.9 ***`.
- **Expected:** filed, High task with subject starting "CRITICAL" to `ENTLER`, item shows phone call required.
- **Actual:** item `in_mv6vw8l678247c0265`, flags read `CRITICAL, H, HH, L`. Marked `critical: true, call_required: true` when read. Filed as **document 22756** on chart 81070, Lab Results listing. **Task 21789** to `ENTLER`, **High**, subject prefix "CRITICAL: ", comment "CRITICAL result: a phone call is required. ..." (history: "CRITICAL review task 21789 sent to ENTLER, ordering provider (High)"). Veradigm® accepted High: the first High task sent from Drawbridge. No same-day lookup (critical results always notify).
- **Staff screen** (the real `/app/intake` pages, rendered in the container): item page "Critical result: **CRITICAL** A phone call is required. Drawbridge does not place calls." and "Task 21789 to ENTLER (ordering provider), High priority". The queue shows the pill "critical: call required".

### B2. Critical lab, ordering provider who matches nobody (added): PASS

Added to read back a High task, which only works when the task goes to our own user.
- **Sent:** critical lab for Lucius Marchetti (p09), DOB 03/03/1960. `Ordering Provider: Thaddeus Quimbleworth, MD`, `POTASSIUM 6.8 HH`, `*** CRITICAL RESULT ... ***`.
- **Expected:** filed, High "CRITICAL" task to `INTAKE_REVIEW_USER` (no provider match).
- **Actual:** item `in_mv6w2o4k68bbd89654`. Filed as **document 22759** on chart 81075, Lab Results listing. **Task 21792** read back: `GetTaskList` recipient code 11032 (our review user), **`TaskPriority: "UrgentNA"`**, type "Scanned Document", status Unread, patient 81075. Description "CRITICAL: New outside document for review: Outside lab Oct 12 2026 - SUMMIT VALLEY REFERENCE". `GetTask` 21792: workobject 21792, patient Lucius Marchetti, same subject.
- **Finding:** Veradigm® stores `SaveTask` priority **High as "Urgent"** and **Medium as "Routine"** (`UrgentNA` / `RoutineNA` in `GetTaskList`).

### C. Lab with an ordering provider who matches nobody: PASS

- **Sent:** lab for Augustin Pelletreau (p05), DOB 06/23/1955, `Ordering Provider: Thaddeus Quimbleworth, MD`, collected 10/12/2026.
- **Expected:** filed, Medium task to `INTAKE_REVIEW_USER`.
- **Actual:** item `in_mv6vy61a303a5a2dcf`. Ordering provider "Thaddeus Quimbleworth": "not found among the Veradigm® EHR providers". Filed as **document 22757** on chart 81071, Lab Results listing. **Task 21790** read back: recipient code 11032 (our review user), `RoutineNA` (Medium), "Scanned Document", Unread, patient 81071, subject "New outside document for review: Outside lab Oct 12 2026 - SUMMIT VALLEY REFERENCE".

### D. Imaging report (renal ultrasound), ordering provider 2: PASS

- **Sent:** Mountain View Imaging Center "RADIOLOGY REPORT" for Wilhelmina Strand (p06), DOB 01/14/1968. `Ordering Provider: Lakshmi Subbarao, MD`, `Exam Date: 10/12/2026`, "US RENAL ULTRASOUND COMPLETE", findings, impression. Also signed "Interpreting Radiologist / Electronically signed by: Corwin Ashdale, MD", to check that the signer is not taken as the orderer.
- **Expected:** filed under the imaging category, task to `SLAKSHMI`.
- **Actual:** item `in_mv6vzgci7e0260f99b`: kind imaging / subtype ultrasound, ordering provider "Lakshmi Subbarao" (the radiologist was ignored). Filed as **document 22758** "Outside ultrasound Oct 12 2026 - MOUNTAIN VIEW" under **"Radiology Report"** (the default for ultrasound: IKI's map only sets labs), on chart 81072 and in the Radiology Report listing for 81072. **Task 21791** to `SLAKSHMI` (ordering provider), Medium. Task read-back: not readable by our user.

### E-H. Documents that always go to a person: PASS (4 of 4)

| | Sent (synthetic) | Patient (EHR) | Match | Item | Reason shown | Chart |
|---|---|---|---|---|---|---|
| E | Blue Mesa Health Plan "PRIOR AUTHORIZATION REQUEST" (tolvaptan, ADPKD) | Desmond Achterberg (81073) | auto, exact name + DOB | `in_mv6w0qnv57eac93d15` Needs review | "Prior authorization: always reviewed by staff." | no new document |
| F | Teton Legal and Records "REQUEST FOR MEDICAL RECORDS" | Imogen Fairweather (81074) | auto | `in_mv6w0qo1b6d08af73a` Needs review | "Medical records request: always reviewed by staff." | no new document |
| G | Riverbend Community Pharmacy "PRESCRIPTION REFILL REQUEST" (lisinopril) | Lucius Marchetti (81075) | auto | `in_mv6w0qo813bc229e66` Needs review | "Medication refill request: always reviewed by staff." | no new document* |
| H | Snake River Family Medicine "REFERRAL FORM", "I am referring ... for nephrology evaluation" | Imogen Fairweather (81074) | auto | `in_mv6w0qod3431861162` Needs review | "Referral: always reviewed by staff." | no new document |

Each matched the right patient on a perfect name + DOB (decision `auto`) and was held only by the clinic rule. History: "needs review: always to staff"; the item page shows the reason and "Prior authorization clinic rule: never filed automatically". No `SaveScanDocument` or `SaveTask` ran for them: the write counters stayed at 4 / 4 across the drop.
\* Checked before B2. B2's document 22759 was later filed to the same synthetic patient (p09).

Side note (not a failure): F's suggested category is "Lab Results", because the request mentions lab results. Staff choose the category when they file such a document by hand.

### I. Same-day appointments, no write: PASS (7 of 7)

Synthetic patients have no appointments, and creating one is not approved. So the deployed `planReviewTask` (`notify.ts`) was run in the container for sandbox PM patient **46502**, read-only. It used the live `GetScheduleByPatientID` and `GetProviders` on a Unity service that refuses every other action. Each in-memory item had a fake collection date and ordering provider Miles Entler. Nothing was filed and no task was sent.

| | Document | Collection date | Schedule that day | Expected | Actual |
|---|---|---|---|---|---|
| I1 | lab | 01/12/2026 | `S` (scheduled) | no task | **no task**: "Appointment on 01/12/2026, the collection date: no task (clinic rule)." |
| I2 | lab | 01/11/2026 | none | task to ENTLER, Medium | **task to ENTLER, Medium**: "No appointment on 01/11/2026." |
| I3 | lab | 01/13/2026 | `C` | no task | **no task** |
| I4 | lab | 01/23/2026 | only `X` (cancelled) | task | **task to ENTLER, Medium** (cancelled doesn't count) |
| I5 | **critical** lab | 01/12/2026 | `S` | task, High, CRITICAL | **task to ENTLER, High, "CRITICAL: "** (no schedule lookup: critical always notifies) |
| I6 | imaging | 01/12/2026 | `S` | no task | **no task** |
| I7 | consult letter | 01/12/2026 | `S` | task (not a result) | **task to ENTLER, Medium** |

Veradigm® calls made: `GetScheduleByPatientID` (PM, patient 46502) and `GetProviders` (EHR) only.

### J. Name + DOB match, different address: PASS

- **Sent:** lab for Desmond Achterberg (p07), DOB 08/09/1977, with `Address: 4417 Wrenfield Lane / Pocatello, ID 83201` (made up; the chart has another address).
- **Expected:** not filed, staff, address reason.
- **Actual:** item `in_mv6w0qoj07fde264e7`, decision `review`, status Needs review: "Name and date of birth match one patient, but the address on the document is different (an old address, or someone else)." No new document on chart 81073, no write.

## Code fixes (on `drawbridge/fax-intake`)

1. **`da08fed` GetProviders inactive fields.** `rules.ts` `parseProviders` checked `Inactive`/`Active`, which Veradigm® doesn't send, so an inactive provider could have been sent a review task. It now reads `ProviderInactive` (drops the provider) and `UserInactive` (keeps the provider for matching, with no user name, never sent a task). The `UserName` mapping was already right. Smoke test uses Veradigm®'s row shape.
2. **`989a2df` Match: one patient counted twice.** Found by the read-only dry run. Brightwater (p03) went to staff as "2 patients match this name and date of birth", though the exact search returns one patient. Cause: the name + DOB rule's wider search (`"Br"` + DOB) returned the same patient as a **PM-only row** (PM ID 51389, no chart ID). `match.ts` `mergeCandidates` keyed the first row by chart ID and the second by PM ID, so they looked like two people. Candidates are now the same when either ID agrees (chart with chart, PM with PM). Different IDs are still different patients, both ways (smoke tests). This failed safe (staff review, never a wrong filing), but it blocked valid auto-filing whenever Veradigm® returned a PM-only row. After the fix A auto-filed to the right chart.
3. Docs: `file.ts` header (High verified, other-user tasks not readable), `FAX_INTAKE_ADDON.md` Veradigm actions table.

After each fix: `npx tsc --noEmit -p .` clean, `npm run smoke:intake` passes. The new match test fails on the old code. Only the `unity` service was rebuilt.

## Sandbox writes

| Action | Count | Targets |
|---|---|---|
| `SaveScanDocument` | **5** of 8 | EHR 81069 (doc 22755), 81070 (22756), 81071 (22757), 81072 (22758), 81075 (22759): synthetic patients p03, p04, p05, p06, p09 |
| `SaveTask` | **5** of 8 | 21788 (ENTLER), 21789 (ENTLER, High), 21790 (review user), 21791 (SLAKSHMI), 21792 (review user, High) |
| `SavePatient`, `SaveAppointment`, `SetAppointmentStatus`, anything else | 0 | |

Counted from the app's own log of Veradigm® actions. All test, probe and verify scripts ran on a Unity service that refuses every non-read action.

## Not covered

- **Same-day suppression with a real filing:** our synthetic patients have no appointments, and creating one was not approved. The decision was proven on real schedule data (scenario I), but no document was filed on an appointment day. One `SaveAppointment` for a synthetic patient (owner OK needed) would close it.
- **The review task in the provider's own inbox:** A, B, D were accepted for `ENTLER` / `SLAKSHMI`, but our sandbox user can't read another user's tasks. Seeing them needs that provider's view (Veradigm® EHR as that user, or Veradigm support), or a sandbox provider login of our own.
- **The phone call itself:** Drawbridge marks a critical result "phone call required" and sends a High task. It never places a call. Who calls, and how fast, is IKI's routine.
- `INTAKE_CRITICAL_NOTIFY` (IKI hasn't named the person yet): covered by the smoke tests only.
- Faxes from MOATiT Fax (webhook path), scanned (image-only) documents through OCR, multi-patient batches: tested earlier (Oct 11) and in the smoke tests, not in this run.
- A critical result whose task fails (back to staff, "Provider was told"): smoke tests only; it would have needed a failing write on the sandbox.
- Ordering-provider edge cases (initials, OCR typos, two providers with one last name, a provider with an inactive login): smoke tests only. The sandbox list has no inactive providers.
