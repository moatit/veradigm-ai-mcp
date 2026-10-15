# Drawbridge: Veradigm® Unity actions for certification

For the Veradigm API Assessment. This is the complete list of Veradigm Unity calls Drawbridge makes, taken from the code on branch `drawbridge/cert-hardening` after unused action names were removed from `src/unity/config/unity-endpoints.ts`. Every action name lives in that one file, and each can be overridden per client with `UNITY_ACTION_<KEY>`.

Notes on the table:

- **System**: PM is Veradigm® PM (Practice Management) on the PM Ubiquity ID; EHR is Veradigm® EHR on the EHR Ubiquity ID. Each system has its own token and its own `GetUserAuthentication`.
- **R/W**: R is a read. W changes Veradigm data.
- **Phone agent** means the VeradigmAI voice agent's tools (`unity_*` and `drawbridge_*`, called by Retell). **Staff app** means screens behind the staff login.

## Required actions (Veradigm certification)

| Action | System | R/W | Where Drawbridge uses it | What it does |
|---|---|---|---|---|
| `GetToken` (JSON endpoint) | PM, EHR | auth | Every session, `unity-auth.service.ts` | Gets a security token with the Unity service credentials (Ubiquity ID prefix). Concurrent callers share one request. 30 s timeout. A token is reused for `UNITY_TOKEN_CACHE_TTL` minus `UNITY_TOKEN_REFRESH_BUFFER` seconds. |
| `GetUserAuthentication` | PM, EHR | auth | Once per token and system, before any other action | Binds the token to the EHR/PM user. Runs once for concurrent callers. A rejected token is replaced once; a wrong password is never retried, so the account can't be locked out. |
| `GetServerInfo` | PM, EHR | R | Server start (after the first token), then at most every `UNITY_SERVER_INFO_REFRESH_HOURS` (6). Shown on the staff screen "Veradigm connection" and on the authenticated `GET /diagnostics/veradigm` | Gets the product, version, time zone and server time. Only those fields are kept. If the call fails, the system shows as "unavailable" and the server keeps running. |
| `LastLogs` | PM, EHR | R | After an action fails on Veradigm's side (HTTP 5xx, unexpected exception). At most once a minute per system, and never after a failed `LastLogs` | Gets Veradigm's troubleshooting log. Each entry keeps the timestamp, action and message, with dates, long numbers and e-mail addresses masked. Entries go to the server log and to the "Veradigm connection" staff screen. |
| `RetireToken` (JSON endpoint) | PM, EHR | auth | Graceful shutdown of the HTTP servers (SIGINT/SIGTERM) and of the stdio server | Retires only the tokens this process holds. It never requests a token just to retire it. |

### Not used: `GetTokenValidation`

`GetTokenValidation` checks a token that Veradigm EHR passes to an app it **launches** (an in-EHR app opened from the chart with a token). Veradigm EHR never launches Drawbridge. Drawbridge is a server-side integration that gets its own token with `GetToken` and binds it with `GetUserAuthentication`, so it never receives a token from Veradigm to validate. The name stays in `unity-endpoints.ts` (`Auth.GET_TOKEN_VALIDATION`), marked unused, so it can be added without a code search if Drawbridge is ever launched from Veradigm EHR. That would also require recertification.

## Veradigm® PM actions

| Action | R/W | Feature (tool or screen) | What it does |
|---|---|---|---|
| `SearchPatients` | R | Phone agent `unity_search_patients` (caller identification); document intake patient match (through the same tool); intake shadow mode | Search by "Last, First" or MRN (plain text). Results are filtered by date of birth in Drawbridge. Also sent to Veradigm® EHR (see below). |
| `GetPatient` | R | Outreach list builders (reminder, no-show and recall calls) | Gets the patient's first name and phone number for an approved outbound call. Also used on EHR. |
| `SavePatient` | W | Phone agent `unity_save_patient` (register a new patient), `unity_update_demographics` (contact details) | Adds a patient or updates contact fields. Write tools carry an idempotency key. |
| `GetScheduleByPatientID` | R | Phone agent `unity_get_patient_appointments`; read-back after `SaveAppointment`; ownership and current-status check before every `SetAppointmentStatus`; intake clinic rules (same-day appointment check) | Gets one patient's appointments. Drawbridge keeps the future ones. `SetAppointmentStatus` ignores PatientID, so Drawbridge only changes a visit that is on the verified patient's own schedule. |
| `GetAppointmentById` | R | Phone agent `unity_get_appointment_details` when no patient ID is given | Gets one appointment's details. |
| `SaveAppointment` | W | Phone agent `unity_save_appointment` | Books an appointment in an open slot. PatientID = PM patient ID; Parameter1 = the `<appt>` XML from Veradigm's PM reference (`appointmentDateTime` MM/DD/YYYY HH:mm, `appointmentDuration`, `appointmentType`, `schedulingLocation`, `schedulingDepartment`, `resource`, `comments`, `schedulingLocationID`, `schedulingDepartmentID`; `referDr`, `coverageType`, `visitType`, `referralRequired`, `ailmentID` only when configured, because the sandbox does not require them). The slot is checked with `GetAvailableSchedule` first. A reply without `saveappointmentinfo.Appointment_ID` is a failure. Never retried; idempotent per call. Verified on the sandbox Oct 15, 2026 (`SCHEDULING_WRITE_TEST_2026-10-15.md`). |
| `SetAppointmentStatus` | W | Phone agent `unity_cancel_appointment`, `unity_confirm_appointment` | Cancels (X) or confirms (C) an appointment. Parameter1 = appointment ID, Parameter2 = status letter, Parameter3 blank (today), Parameter4 = clinic time HHMM, Parameter5 = confirmation result ID (confirm), Parameter6 = cancellation reason ID (cancel). Only `Status` = "success" counts as done. If Veradigm refuses Scheduled to Canceled (2019.3+ transition rule), Drawbridge confirms and then cancels. Verified on the sandbox Oct 15, 2026. |
| `GetAvailableSchedule` | R | Phone agent `unity_get_open_slots`; staff and agent `drawbridge_find_openings` (scheduling); slot check before `SaveAppointment` | Gets the open time for a resource and date range (5-minute bitmaps). Each row carries the scheduling location and department IDs and the eligible appointment categories. |
| `GetResources` | R | Open-slot lookup and `SaveAppointment` (provider to resource abbreviation and default appointment type); `unity_get_providers` (scheduling) | Lists the schedulable resources and providers. |
| `GetAppointmentCancellationReasons` | R | Phone agent `unity_get_cancellation_reasons`; reason name to ID for cancel (cached 1 h) | Gets the valid cancellation reasons. |
| `GetAppointmentConfirmationResults` | R | `unity_confirm_appointment` (optional confirmation result name to ID, cached 1 h) | Gets the appointment confirmation results for `SetAppointmentStatus` Parameter5. |
| `GetSchedulingLocations` | R | `unity_save_appointment` (cached 1 h) | Lists the scheduling locations. Drawbridge maps the slot's `Scheduling_Location_ID` to the abbreviation that `SaveAppointment` needs. |
| `GetSchedulingDepartments` | R | `unity_save_appointment` (cached 1 h) | Lists the scheduling departments. Drawbridge maps the slot's `Scheduling_Department_ID` to the abbreviation that `SaveAppointment` needs. |
| `GetAppointmentTypes` | R | Phone agent `unity_get_appointment_types`; type names in appointment details; type name to abbreviation and category for `SaveAppointment` | Gets the appointment types. |
| `GetSchedule` | R | Staff huddle brief (day schedule); outreach reminder list; `unity_get_day_schedule` (scheduling) | Gets a day's schedule. It is never called with a PatientID. |
| `GetAppointmentsByChangeDTTM` | R | Outreach no-show follow-up list; `unity_get_changed_appointments` | Gets appointments changed in a date range. |
| `GetRecalls` | R | Outreach recall list; `unity_get_patient_recalls` | Gets patient recalls that are due. |
| `GetPatientAccountBalance` | R | Phone agent `unity_get_account_balance`; huddle brief and pre-visit check | Gets the account balance (one row per voucher; Drawbridge adds them up). |
| `GetPatientPolicy` | R | Phone agent `unity_get_insurance_policy`; huddle brief and pre-visit check | Gets the insurance on file. |

## Veradigm® EHR actions

| Action | R/W | Feature (tool or screen) | What it does |
|---|---|---|---|
| `SearchPatients` | R | Phone agent `unity_search_patients` (same tool as on PM) | Searches the EHR chart. Results are merged with the PM results. |
| `GetPatient` | R | Phone agent `unity_get_patient` | Gets a patient's demographics. |
| `GetPatientByMRN` | R | Phone agent `unity_get_patient_by_mrn` | Looks up a patient by MRN. If that fails, Drawbridge searches by MRN instead. |
| `GetClinicalSummary` | R | Phone agent `unity_get_patient_problems`, `unity_get_patient_medications`, `unity_get_patient_allergies`, `unity_get_recent_results` (sections `results`, `vitals`); huddle brief (allergy and problem counts) | Gets one chart summary section (Parameter1 = section). |
| `GetPatientDiagnosis` | R | Phone agent `unity_get_patient_diagnosis` | Gets the patient's diagnoses. |
| `SaveTask` | W | Phone agent `unity_create_staff_task` (the agent's only EHR write); intake review task linked to a filed document | Creates a staff task. |
| `GetLocation` | R | `unity_get_location_hours` (scheduling) | Gets location details and business hours. |
| `GetProviders` | R | Intake clinic rules: who gets the review task | Lists providers and users (inactive ones are skipped). |
| `GetDocumentType` | R | Document intake: category list | Lists the chart document categories. |
| `SaveScanDocument` | W | Document intake filing, staff side only. Off unless `INTAKE_FILING` and `INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED` allow it (owner-approved exception, `FAX_INTAKE_ADDON.md`). Never the phone agent | Files a received document to the chart. |
| `GetDocumentsByDocumentType` | R | Intake shadow mode, staff filing observer (read only), polled at most every `INTAKE_OBSERVE_EVERY_MIN` (30; never below 2 minutes) | Lists documents of a category in a date range. |
| `GetDocuments` | R | Intake shadow mode, staff filing observer | Lists a patient's chart documents. |
| `GetDocumentImage` | R | Intake shadow mode, staff filing observer (breaking ties) | Gets one document's image. |

## Verification only (not called by the app)

| Action | System | Used by |
|---|---|---|
| `Echo` | PM, EHR | `npm run verify:sandbox` connection check. |

## Removed from the configuration (never called)

These names were in `unity-endpoints.ts` but no code called them. They were removed after a repo-wide search: `GetPatientFull` (and its unused helper), `GetChangedPatients`, `BookAppointment`, `GetRecallTypes`, `GetFirstAvailableAppointments`, `GetEncounter`, `GetEncounterList`, `SaveSimpleEncounter`, `GetEncounterSummary`, `SaveDocumentImage`, `GetPatientDemographics`, `GetProvider`, the duplicate `GET_AVAILABLE_SCHEDULE` key (`GET_OPEN_SLOTS` holds `GetAvailableSchedule`). Their `UNITY_ACTION_*` overrides now have no effect. `GetSchedulingLocations`, `GetSchedulingDepartments` and `GetAppointmentConfirmationResults` were removed in the same pass and added back on Oct 15, 2026, when `SaveAppointment` and `SetAppointmentStatus` moved to Veradigm's documented parameters (see the PM table). `npm run verify:sandbox` uses the configured names for every read in this document.

## Calling rules that apply to every action

- HTTPS to the Ubiquity endpoint (`UNITY_UBIQUITY_ENDPOINT`). In production the endpoint and both Ubiquity IDs must be set, because there are no sandbox defaults in production.
- 30 s timeout per call. A read is retried once on 502/503/504 or a dropped connection. Writes (`Save*`, `Set*`) are never retried for those errors. After a rejected token the call is sent once more with a fresh login, which Veradigm never ran, so this is safe for writes too.
- A failed call is reported as `{ success: false, error_code, retryable }` and never as an empty result.
- Unity is never polled more often than every 2 minutes.
- Every tool call is written to the audit log, and so is every action a staff module sends directly (intake, huddle, outreach, scheduling, diagnostics). Each line has the tool or action name, the patient ID if there is one, the outcome and the latency (`SECURITY_CONTROLS.md`).
