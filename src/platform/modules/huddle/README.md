# Huddle module

Morning huddle brief and pre-visit check (deck slide 9). Read only: no Veradigm writes.

## What it does

**Huddle brief** (`/app/huddle`, nav "Huddle brief")

1. `GetSchedule` (Veradigm® PM) for one clinic date (default today in `CLINIC_TIMEZONE`).
2. Each patient on the schedule is checked through `deps.runTool`, the same path the phone agent uses, so structured errors and audit apply:
   `unity_get_account_balance`, `unity_get_insurance_policy`, `unity_get_patient_allergies`, `unity_get_patient_problems`.
   A patient with two visits is checked once. At most 4 calls run at a time, inside one time budget per brief.
3. Each visit gets flags: new patient, balance due, no insurance on file, allergies on file, and "couldn't check" for any lookup that failed or ran out of time. A failed lookup never shows as "none".
4. Summary tiles: visits, providers, balances due, missing insurance, checks that couldn't run.
5. If `GetSchedule` itself fails, the screen shows "Couldn't reach Veradigm® PM" instead of an empty day.

Briefs are cached in memory per date for 10 minutes (1 minute if any check failed). **Refresh** bypasses the cache. **Print** uses print CSS that hides the nav and buttons.

**Agent tools**

| Tool | Who | Args | Returns |
|---|---|---|---|
| `drawbridge_previsit_check` | Phone agent, after identity verification | `patientId` | `{ success, hasUpcomingVisit, nextVisit, checklist[], message }` |
| `drawbridge_get_huddle_brief` | **Staff only** (future staff voice assistant) | `date` (optional) | `{ success, date, summary, providerLines[], message }` (counts only, no patient names) |

The pre-visit checklist covers: date/time/provider of the next visit, insurance on file (carrier and last 4 of the member ID only), balance due, bring a medication list and photo ID, and arrival instructions. A failed insurance or balance lookup says "I couldn't check", never "nothing on file".

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PREVISIT_INSTRUCTIONS` | `Please arrive 15 minutes early to check in.` | Arrival line read at the end of the pre-visit checklist. |
| `HUDDLE_TIME_BUDGET_MS` | `45000` | Total time for one brief's patient checks. Keep it under the gateway's proxy timeout (nginx default 60 s). Unfinished checks show "couldn't check". |
| `CLINIC_TIMEZONE` | `America/Boise` | Shared. Defines "today". |
| `UNITY_ACTION_GET_SCHEDULE` | `GetSchedule` | Shared action-name override. |

## To verify against the sandbox

- `GetSchedule` parameters: we send `Parameter1 = MM/DD/YYYY`, everything else blank, against Veradigm® PM (`brief.ts` → `fetchSchedule`). Confirm the layout, and whether the service user sees every provider's schedule or only its own.
- `GetSchedule` field names: parsed from several candidates (`PatientID`, `PatientName` / first+last, `ApptTime`/`StartTime`, `ResourceName`/`ProviderName`, `ApptType`, `Status`, `NewPatient`). Adjust `parseSchedule` once a real row is seen.
- "New patient" comes from a schedule flag field or a visit type containing "new"; it is not derived from visit history.
- The PM patient ID from the schedule is passed to the Veradigm® EHR allergy/problem tools. Confirm the IDs match across PM and EHR for this client.
- The pre-visit check calls `unity_get_patient_appointments` without a date range and filters to upcoming, non-cancelled visits itself.

## Tests

`npm run smoke:huddle`: offline, fake Veradigm service and fake `runTool`.
