# Scheduling write test on the Veradigm® PM sandbox, Oct 15, 2026

**What was tested:** Drawbridge's appointment writes (`SaveAppointment` and `SetAppointmentStatus`), using Veradigm's documented parameters.

**Approval:** the owner (Ali) approved this test on Oct 15, 2026. The limits were:

- one synthetic patient only;
- at most 4 `SaveAppointment` and 6 `SetAppointmentStatus` calls;
- every appointment created must end Canceled.

**How it ran:** the built code (`dist/`, branch `drawbridge/cert-hardening`) ran on the host against `UNITY_UBIQUITY_ENDPOINT` (open-uny-ubiquity.platform.veradigm.com). The running Docker stack was not touched.

**Safeguards:** a wrapper counted writes, allowed writes for PM patient 51389 only, and stopped all further writes on any permission or login error.

## Patient

- Synthetic test patient p03 (a fictional patient created for sandbox testing).
- Veradigm® PM patient ID 51389.
- No real patient data was used.
- Provider: MARFEE ("FEELGOOD, MARK M", Resource_ID 50), the sandbox provider used for p03.

## Results (all times UTC)

| # | Time (ISO 8601) | Action | Input | Outcome |
|---|---|---|---|---|
| 1 | 2026-10-15T22:59:02.883Z | `GetRecalls` (read) | PatientID 51389 | Success. 0 recalls. |
| 2 | 2026-10-15T22:59:05.051Z | `GetAvailableSchedule` (read) | MARFEE, 10/19 to 11/05/2026 | Success. 24 day rows. Each row carries `Scheduling_Location_ID` 1 (OFFICE) and `Scheduling_Department_ID` 4 (HOSINP) or 2 (SURGI). |
| 3 | 2026-10-15T22:59:10.725Z to 22:59:11.099Z | `GetAvailableSchedule`, `GetSchedulingLocations`, `GetSchedulingDepartments` (reads) | Slot check for 10/22/2026 9:15 AM | Success. Slot open in location 1 / department 4, which map to OFFICE / HOSINP. |
| 4 | 2026-10-15T22:59:11.237Z | **`SaveAppointment`** (write 1 of 4) | `<appt>`: `10/22/2026 09:15`, 15 min, type `OV`, `OFFICE`/`HOSINP`, resource `MARFEE`, comment, location ID 1, department ID 4 | **Success.** `Appointment_ID` **369721**, `Encounter_Number` 369721. |
| 5 | 2026-10-15T22:59:11.399Z | `GetScheduleByPatientID` (read-back) | 51389 | 369721 present: 10/22/2026 9:15 AM, status S, resource 50, location 1, department 4, type 4 (Office Visit), 15 min. |
| 6 | 2026-10-15T22:59:17.445Z | **`SetAppointmentStatus`** (write 1 of 6) | P1 369721, P2 `C`, P3 blank, P4 `1659`, P5 `20` (Patient notified), P6 blank | **Success** (`Status` "Success"). |
| 7 | 2026-10-15T22:59:17.779Z | `GetScheduleByPatientID` | 51389 | 369721 status **C**. |
| 8 | 2026-10-15T22:59:23.341Z | **`SetAppointmentStatus`** (write 2 of 6) | P1 369721, P2 `X`, P3 blank, P4 `1659`, P5 blank, P6 `5` (Booked in Error) | **Success.** |
| 9 | 2026-10-15T22:59:23.659Z | `GetScheduleByPatientID` | 51389 | 369721 status **X**, `Cancellation_Reason_ID` 5. |
| 10 | 2026-10-15T22:59:36.257Z | **`SaveAppointment`** (write 2 of 4) | Same layout, `10/23/2026 09:00`, OFFICE/HOSINP | **Success.** `Appointment_ID` **369722**, `Encounter_Number` 369722. Read-back: status S. |
| 11 | 2026-10-15T22:59:42.356Z | **`SetAppointmentStatus`** (write 3 of 6) | P1 369722, P2 `X`, P4 `1659`, P6 `5`. Sent directly from Scheduled. | **Success.** The sandbox allowed Scheduled to Canceled, so the confirm-first fallback was not needed. |
| 12 | 2026-10-15T22:59:47.728Z | `GetScheduleByPatientID` | 51389 | 369721 **X** (reason 5) and 369722 **X** (reason 5). |

**Writes used:** 2 of 4 `SaveAppointment` and 3 of 6 `SetAppointmentStatus`. No call failed.

**End state:** both appointments the test created (369721, 369722) are **Canceled**. No permission error came back. The PM user has the "Appointment Scheduling" right (Sched.ApptSch).

## Findings

1. **The earlier error is fixed.** The old error was "Invalid scheduling location=blank". The documented `<appt>` layout with `schedulingLocation`/`schedulingDepartment` abbreviations and their IDs books on the first attempt.
2. **Elements the sandbox needs:** the sandbox accepts `appointmentDateTime`, `appointmentDuration`, `appointmentType`, `schedulingLocation`, `schedulingDepartment`, `resource`, `comments`, `schedulingLocationID` and `schedulingDepartmentID`. It does not need `referDr`, `coverageType`, `visitType`, `referralRequired` or `ailmentID`. If a production practice requires them, they can be set with `UNITY_APPT_REFER_DR`, `UNITY_APPT_COVERAGE_TYPE`, `UNITY_APPT_VISIT_TYPE`, `UNITY_APPT_REFERRAL_REQUIRED` and `UNITY_APPT_AILMENT_ID`.
3. **IDs:** `schedulingLocationID` / `schedulingDepartmentID` are the `Scheduling_Location_ID` / `Scheduling_Department_ID` from the `GetAvailableSchedule` row. They are not the general `Location_ID` / `Department_ID`, although for OFFICE and HOSINP both pairs are 1 and 4.
4. **Success reply:** `SetAppointmentStatus` returns `[{"setappointmentstatusinfo":[{"Status":"Success"}]}]` (capital S). Drawbridge compares without regard to case. Anything else, including an empty reply, is reported as a failure.
5. **Scheduled to Canceled:** Veradigm's reference says this transition is refused on 2019.3+ PM. The sandbox allowed it. Drawbridge still keeps the documented fallback for production: if X is refused as a status transition and the visit is Scheduled, it confirms (C) and then cancels (X). If the confirm works but the cancel does not, the result is a failure that says the visit is now Confirmed. Offline tests cover this path (`npm run smoke:appointment-writes`).
6. **Recalls:** `GetRecalls` for 51389 returned 0 rows. The patient has no recalls; the call itself succeeded.

No credentials, tokens or real patient data appear in this file or in the test logs.
