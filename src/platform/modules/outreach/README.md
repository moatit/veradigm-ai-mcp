# Call & Confirm module (outreach)

Outbound appointment confirmation calls, no-show follow-up and recall calls, placed by the outbound VeradigmAI Retell agent. Overview, sample week and sample transcripts: `docs/drawbridge/CALL_AND_CONFIRM.md`.

**Today: dry run and simulation only.** `OUTBOUND_ENABLED` stays false. Live mode only ever dials numbers on a test allowlist.

- Staff screen: `/app/outreach` (nav "Call & Confirm"). It shows:
  - today's plan by window;
  - the one-click list approval;
  - the projected week;
  - the Unconfirmed list;
  - each patient's attempt timeline;
  - opt-outs and bad-number tasks;
  - "Simulate a week" and "Run the 7 test calls".
- Huddle brief: visits on the Unconfirmed list get an "Unconfirmed" flag and a tile.
- Agent tools (outbound agent): `drawbridge_outreach_context`, `drawbridge_outreach_result`. Confirming, moving and cancelling use the existing `unity_*` tools after identity is verified.
- Machine API (header `x-drawbridge-key`, `DRAWBRIDGE_TOOL_KEY`):
  - `GET /unity/api/outreach/plan?days=7`: read-only plan summary, counts only.
  - `GET /unity/api/outreach/settings` and `PUT /unity/api/outreach/settings`: per-practice settings, validated.
- Prompt: `retell-prompts/outbound-outreach-agent.md`.
- Store: `$CALL_RECORDS_DIR/outreach-jobs.json` (jobs, daily lists, projection, opt-outs) and `outreach-settings.json`. Both are mode 0600. Jobs hold first names, phone numbers and visit details, with the same handling as call records.
- Tests: `npm run smoke:outreach` (offline, synthetic). Demo of the real screens on a synthetic clinic: `npm run demo:outreach -- --warm`. It binds to 127.0.0.1 on a free port and uses a temp data folder.

## Files

| File | What |
|---|---|
| `settings.ts` | Per-practice settings (exact shape for the admin console), validation, file store |
| `generators.ts` | List builders: confirm, no-show, recall; phone lookup |
| `scheduler.ts` | Attempt plans, calling days and windows, per-patient limits (pure functions) |
| `daily.ts` | 07:00 daily list, one-click approval, projection, plan summary (the endpoint's JSON) |
| `dialer.ts` | Dispatcher: every check before a call, re-read and stop rules, dry run / simulate / live, outcomes, staff tasks |
| `tools.ts` | Outbound agent tools |
| `screen.ts` | Staff screen |
| `sim.ts`, `simulate.ts` | Synthetic clinic + fake Veradigm® PM client; simulated week; 7 test calls through the real tool code |
| `store.ts` | Job store (file-backed, or in memory for simulations) |

## Flow

1. **07:00 on a business day** (scheduler on: settings `enabled`), or "Build today's list now". The list builders read Veradigm® PM and create jobs, each with an attempt plan. Today's attempts go on the daily list. A failed read is an error, never an empty list.
   - Confirm: `GetSchedule` 1–3 business days out. Visits already confirmed (status, or a positive `GetAppointmentConfirmationResults` code on the row) and cancelled visits are skipped.
   - No-show: `GetAppointmentsByChangeDTTM` since the previous business day, status no show / missed.
   - Recall: `GetRecalls` past due and open. A patient with a visit already booked (`GetScheduleByPatientID`) is skipped. At most `OUTREACH_RECALL_DAILY_CAP` (default 20) new recall jobs a day, oldest due first.
   - Phones: `GetPatient` (cell, then home, then work). No usable number or opted out means the job is created as `skipped`.
2. **Staff click "Approve today's list"** once. Nothing on an unapproved list is dialed.
3. **Every minute** (or "Run due calls now"), the dispatcher takes approved attempts whose window is open. Before each attempt it checks:
   - the attempt is approved, it is today, inside its window and calling hours, and today is a calling day;
   - the patient's limits across all call types: 1 a day, 3 in any 7 days;
   - live mode only: `OUTBOUND_ENABLED=true`, an allowlist containing the number, Retell configured.

   Then it re-reads Veradigm® PM (`GetScheduleByPatientID`, `GetPatient`) and **stops** when:
   - the visit was confirmed, moved or cancelled;
   - the patient rebooked;
   - the patient opted out;
   - the number is gone. A staff task to fix it (`SaveTask`) is created.

   A failed re-read means "not called", never "stop". An approved attempt whose window ends is marked missed.
4. **On the call** the agent calls `drawbridge_outreach_context`, verifies name + date of birth, and finally `drawbridge_outreach_result`. Outcomes:
   - `confirmed`, `moved`, `booked`, `cancelled`, `callback_requested`, `other`: the job completes.
   - `voicemail`, `no_answer`: the next attempt stays planned. After the last attempt a confirm job becomes `unconfirmed`.
   - `wrong_number`: calls stop and a staff task is created.
   - `opted_out`: the patient is never called again.

   The old names `reschedule_requested` / `cancel_requested` are still accepted.

## Attempt plans

| Call type | Attempt 1 | Attempt 2 | Attempt 3 |
|---|---|---|---|
| Confirm | 3 business days before, 10:00–11:30 | 2 days before, 15:00–16:30 | 1 day before, 17:00–18:30 |
| Confirm, booked under 3 days out | next business morning | day before, late afternoon | none |
| No-show | same day 14:00–16:00 | next business day 10:00–11:30 | none |
| Recall | day 0, 10:00–11:30 | day 3, 15:00–16:30 | day 7, 17:00–18:30 |

Rules:
- Confirm `days_before` and no-show `day_offset` count business days. Recall `day_offset` counts calendar days, rolled forward to a business day.
- "Booked under 3 days out" means the first attempt has already passed when the job is created. If both short-plan attempts fall on one day, only the morning one is kept.
- An attempt that breaks a per-patient limit moves to the next business day. A confirm attempt only moves while it is still before the visit; otherwise it is dropped (shown on the timeline).
- Only the last kept attempt may leave a voicemail (`leave_voicemail` = `yes`).

## Settings

Per practice (`OUTREACH_PRACTICE_ID`, default `default`), in this exact shape (the admin console builds against it):

```json
{
  "enabled": false, "mode": "dry_run",
  "call_types": {"confirm": true, "no_show": true, "recall": true},
  "confirm": {"attempts": [{"days_before": 3, "window": "10:00-11:30"}, {"days_before": 2, "window": "15:00-16:30"}, {"days_before": 1, "window": "17:00-18:30"}]},
  "no_show": {"attempts": [{"day_offset": 0, "window": "14:00-16:00"}, {"day_offset": 1, "window": "10:00-11:30"}]},
  "recall": {"attempts": [{"day_offset": 0, "window": "10:00-11:30"}, {"day_offset": 3, "window": "15:00-16:30"}, {"day_offset": 7, "window": "17:00-18:30"}]},
  "limits": {"max_per_day": 1, "max_per_7_days": 3, "calling_hours": "09:00-19:00", "weekdays_only": true, "holidays": []},
  "voicemail": "last_attempt", "approval": "daily_list", "test_allowlist": []
}
```

`PUT` refuses unknown or missing fields. It also refuses:
- limits above 1 a day or 3 in 7 days;
- more than 3 attempts;
- windows outside calling hours, or calling hours outside 08:00–21:00;
- two attempts on one day;
- holidays that are not `YYYY-MM-DD`.

`mode: "live"` is refused unless `OUTBOUND_ENABLED=true` and an allowlist is set. A stored live setting falls back to dry run if `OUTBOUND_ENABLED` is later turned off.

## Plan endpoint

`GET /unity/api/outreach/plan?days=7` (1–14 days from today) returns:
- `practice`, `timezone`, `generated_at`, `enabled`, `mode`;
- `days[]`, each with:
  - `date`, `weekday`, `calling_day`;
  - `list`: built / approved / `pending_approval`;
  - `planned` and `projected`, each `{confirm, no_show, recall, total}`;
  - `windows[]`, each `{window, planned, projected}`;
  - `results`: `{confirmed, moved, cancelled, voicemail, no_answer, opted_out, bad_number}`;
  - `would_call`;
  - `stopped`: stop rule counts;
- `totals`, `unconfirmed`, `opted_out`, `bad_number_tasks`.

Counts only: no names, numbers or IDs.

## Environment

| Variable | Meaning |
|---|---|
| `OUTBOUND_ENABLED` | Must be exactly `true` for any real call (and for saving `mode: "live"`). |
| `OUTBOUND_ALLOWLIST` | Comma-separated numbers, added to settings `test_allowlist`. In live mode only numbers on the combined list are called. |
| `RETELL_API_KEY`, `RETELL_OUTBOUND_AGENT_ID`, `RETELL_FROM_NUMBER` | Retell outbound agent. Required in live mode. |
| `CLINIC_NAME` | Said by the agent (`clinic_name`). |
| `CLINIC_CALLBACK_NUMBER` | Callback number the agent says in the opening and the voicemail (`callback_number`), e.g. `(208) 555-0100`. |
| `CLINIC_TIMEZONE` | Clinic time for calling hours, windows and "today" (default `America/Boise`). |
| `OUTREACH_PRACTICE_ID` | Which practice's settings this server uses (default `default`). |
| `OUTREACH_RECALL_DAILY_CAP` | New recall jobs per day (default 20). |
| `OUTREACH_RETENTION_DAYS` | Jobs not updated for this many days are deleted (default 30). Opt-outs are kept. |
| `CALL_RECORDS_DIR` | Folder for the job and settings files. |

Retell receives only these dynamic variables, plus `metadata.drawbridge_job_id`:
- `patient_first_name`, `appointment_date`, `appointment_time`, `provider_name`;
- `outreach_type` (`confirm` | `no_show` | `recall`), `clinic_name`, `callback_number`;
- `leave_voicemail` (`yes` on the final attempt).

No diagnoses, medications or other chart data.

## Retell setup (outbound agent)

1. Create a Retell agent, separate from the inbound agent, with the prompt in `retell-prompts/outbound-outreach-agent.md`.
2. Add custom functions, all `POST https://<drawbridge host>/unity/api/retell` with header `x-drawbridge-key: <DRAWBRIDGE_AGENT_KEY>`, using the schemas from the tool list:
   `drawbridge_outreach_context`, `drawbridge_outreach_result`, `unity_search_patients`, `unity_confirm_appointment`, `unity_get_open_slots`, `unity_save_appointment`, `unity_get_cancellation_reasons`, `unity_cancel_appointment`, `unity_create_staff_task`.
3. Turn on voicemail detection. The prompt leaves a message only when `leave_voicemail` is `yes`.
4. Put the agent ID, outbound number and key in `.env` / SSM only.
5. Test in dry run, then with the simulation. Only then set `test_allowlist` to staff phones, `OUTBOUND_ENABLED=true` and `mode: "live"`.

## Veradigm® PM parameter assumptions (verify in the sandbox)

The Veradigm reference lists action names only. Rows are parsed with several candidate field names.

| Action | Sent | Fields read |
|---|---|---|
| `GetSchedule` | Parameter1 = start date MM/DD/YYYY, Parameter2 = end date; rows re-filtered by date | patientid, apptid/appointmentid, apptdate/appointmentdate/startdatetime, appttime, resourcename/providername, status, Appt_Confirmation_Result_ID / ConfirmationResultID |
| `GetAppointmentConfirmationResults` | none (read when a schedule row carries a result code) | Appt_Confirmation_Result_ID, Short_Description |
| `GetAppointmentsByChangeDTTM` | Parameter1 = "MM/DD/YYYY 00:00:00" (previous business day), Parameter2 = "MM/DD/YYYY 23:59:59" (today) | as GetSchedule; status matched by "no show" / "missed" / "N" |
| `GetRecalls` | Parameter1 = due-date start (a year back), Parameter2 = yesterday | patientid, recalltype, duedate, status (completed/closed skipped) |
| `GetScheduleByPatientID` | PatientID in the envelope | Appointment_ID, Appointment_DateTime, Status (C / X / N letters) |
| `GetPatient` | PatientID in the envelope, Parameter1 = `N` | cellphone/mobilephone, homephone/phone, workphone, firstname |
