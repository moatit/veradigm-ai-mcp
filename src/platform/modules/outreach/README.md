# Outreach module

Reminder calls, no-show follow-up and recall outreach (deck slide 9), placed as outbound calls by the VeradigmAI Retell agent.

- Staff screen: `/app/outreach` (nav "Outreach"). Propose jobs from Veradigm® PM, approve or skip, "Call approved now".
- Agent tools (outbound agent): `drawbridge_outreach_context`, `drawbridge_outreach_result`. Rescheduling, cancelling and confirming use the existing `unity_*` tools after identity is verified.
- Prompt: `retell-prompts/outbound-outreach-agent.md`.
- Store: `$CALL_RECORDS_DIR/outreach-jobs.json` (mode 0600, holds first names, phone numbers and appointment details; same handling as call records).
- Reads Veradigm® PM only (`GetSchedule`, `GetAppointmentsByChangeDTTM`, `GetRecalls`, `GetPatient`). Never writes to it.
- Test: `npm run smoke:outreach` (offline).

## Flow

1. Staff click "Propose reminders / no-show calls / recall calls". Drawbridge reads Veradigm® PM and creates `proposed` jobs (patients with no usable phone number, or who opted out, are created as `skipped` with the reason). If a read fails, nothing is saved and the screen shows the error.
2. Staff tick jobs and click "Approve selected". Nothing dials automatically.
3. Staff click "Call approved now". Each approved job is checked (allowlist, calling hours, attempts) and either recorded as a dry run, placed with Retell, or refused with a reason.
4. During the call the agent calls `drawbridge_outreach_context` and finally `drawbridge_outreach_result`. `voicemail` / `no_answer` leave the job `failed` so staff can re-approve it (max 2 attempts). `opted_out` excludes the patient from future outreach.

## Environment

| Variable | Meaning |
|---|---|
| `RETELL_API_KEY` | Retell API key. Without it (or without `RETELL_OUTBOUND_AGENT_ID`) the module runs in **dry run**: nothing is dialed, jobs record "would call". |
| `RETELL_OUTBOUND_AGENT_ID` | Retell agent ID of the outbound agent (sent as `override_agent_id`). |
| `RETELL_FROM_NUMBER` | Retell phone number to call from, E.164 (e.g. `+1208XXXXXXX`). Required for live calls. |
| `OUTBOUND_ENABLED` | Must be exactly `true` for any real call. Anything else refuses every live call. |
| `OUTBOUND_ALLOWLIST` | Comma-separated E.164 numbers. When non-empty, any number not on it is refused. Set this in dev/test to your own test phones. |
| `CLINIC_TIMEZONE` | Calling hours are 09:00–19:00 in this zone (default `America/Boise`). |
| `CALL_RECORDS_DIR` | Folder for the job store (shared with the on-call notebook). |

Retell receives only: `patient_first_name`, `appointment_date`, `appointment_time`, `provider_name`, `outreach_type`, `clinic_name` (plus `metadata.drawbridge_job_id`). No diagnoses, medications or other chart data.

## Retell setup (outbound agent)

1. Create a new Retell agent (separate from the inbound agent) with the prompt in `retell-prompts/outbound-outreach-agent.md`. Replace `[CLINIC MAIN NUMBER]` with the clinic's callback number.
2. Add custom functions, all `POST https://<drawbridge host>/unity/api/retell` with header `x-drawbridge-key: <DRAWBRIDGE_TOOL_KEY>`, using the schemas from the tool list (`/unity/tools` or `getTools()`):
   `drawbridge_outreach_context`, `drawbridge_outreach_result`, `unity_search_patients`, `unity_confirm_appointment`, `unity_get_open_slots`, `unity_save_appointment`, `unity_get_cancellation_reasons`, `unity_cancel_appointment`, `unity_create_staff_task`.
3. Enable voicemail detection, or leave it to the prompt's voicemail script (no PHI in the message either way).
4. Put the agent ID in `RETELL_OUTBOUND_AGENT_ID`, the outbound number in `RETELL_FROM_NUMBER`, the key in `RETELL_API_KEY` (in `.env` / SSM only).
5. Test in dry run first, then set `OUTBOUND_ALLOWLIST` to a test phone and `OUTBOUND_ENABLED=true`.

## Veradigm® PM parameter assumptions (verify in the sandbox)

The Veradigm reference lists action names only. Rows are parsed with several candidate field names.

| Action | Sent | Fields read |
|---|---|---|
| `GetSchedule` | Parameter1 = start date MM/DD/YYYY, Parameter2 = end date (same day); rows re-filtered by date | patientid/patid, apptid/appointmentid, apptdate/appointmentdate/startdatetime, appttime/starttime, resourcename/providername, status/apptstatus, patientfirstname/firstname/patientname |
| `GetAppointmentsByChangeDTTM` | Parameter1 = "MM/DD/YYYY 00:00:00" (N days ago), Parameter2 = "MM/DD/YYYY 23:59:59" (today) | as above; status matched by "no show" / "noshow" / "missed" |
| `GetRecalls` | Parameter1 = due-date start, Parameter2 = due-date end (MM/DD/YYYY); rows re-filtered by due date | patientid, recalltype/description, duedate/recalldate, status (completed/closed skipped) |
| `GetPatient` | PatientID in the envelope, Parameter1 = `N` (no picture), target PM | cellphone/mobilephone, homephone/phone, workphone, firstname |
