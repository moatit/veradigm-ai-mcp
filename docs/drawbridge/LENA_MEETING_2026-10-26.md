# Veradigm certification call with Lena Wilser: Mon Oct 26, 2026, 2:00 PM ET (11:30 PM IST)

Internal prep sheet for Kanhaiya. Not for sending to Veradigm.

On the call, say **Veradigm® EHR**, **Veradigm® PM** and **Drawbridge**. Avoid "MCP", "FHIR" and "Unity" unless Lena uses them first.

---

## 0. Have these open before the call

- Postman: collection `postman/drawbridge/Drawbridge_Certification_Oct26.postman_collection.json` and environment `Drawbridge-Certification`, with credentials filled in **Current value** only. Run **1. Sign in** about 5 minutes before the call. Tokens expire after 20 minutes of inactivity, so sign in again if needed.
- The API Assessment (rev Oct 22) on Drive.
- The staff app at https://unity.veradigmai.com/app (logged in) → **Activity** and **Veradigm connection** screens.
- `docs/drawbridge/UNITY_ACTIONS_FOR_CERTIFICATION.md` (the action list with a reason for each).
- `docs/drawbridge/SCHEDULING_WRITE_TEST_2026-10-15.md` (write test timestamps).
- Veradigm Connect portal, logged in. Lena may show client activation there.
- Recording: ask "Is it OK if I record this call for our notes?" at the start.

**Sandbox check today (Oct 26):** every release 1.0 read passed on Veradigm® PM and Veradigm® EHR: sign-in, GetServerInfo, LastLogs, patient matching, 15 PM reads, the EHR reads and RetireToken. Two declared-but-unused actions fail (see section 1, question 3). Writes were not run today.

**Rules during the call:**
- Do not run folder **5. PM writes** or **8. EHR writes** unless Lena asks. Use synthetic patient Teodoro Brightwater only (PM 51389 / EHR 81069). After `SaveAppointment`, cancel the appointment in the same session.
- If sign-in fails, **do not retry**. Repeated failures can lock the account. Say "Let me check the credentials and come back to it."
- Never share the screen while `.env`, the Postman environment values or the token are visible.

---

## 1. Questions to ask Lena

### Certification status
1. **What is left before Drawbridge is certified?** Is QA testing done after today, or is anything else needed: a recorded demo, more call timestamps, Services and Support handoff, billing (Billtrust / API fees)?
2. **Will we get a written confirmation** (email or certificate) that we can share with Idaho Kidney Institute (IKI)?
3. **Two declared actions fail on the sandbox.** `GetPatientAilments` returns "Action is not valid for this license" on both Veradigm® PM and Veradigm® EHR. `GetDictionary` returns "Your login credentials are incorrect" even after GetUserAuthentication. Neither is used in release 1.0. Should we keep them declared (and you enable them), or remove them from the API Assessment?
4. **Open encounters from GetPatientDiagnosis.** Before we removed it, our tests called `GetPatientDiagnosis` on EHR patient 50 (Oct 16, Oct 21) and EHR patient 81214 (Oct 16). Do we need to close any encounters this left open, or will your team handle it?
5. **Do you need the API Assessment updated again** (product version / build line), or is rev Oct 22 final?

### Going live with IKI (client activation)
6. **How do we submit the activation request**, and what does IKI fill in? How long does it take? Our notes say 2–5 business days.
7. **Is there one request per product** (Veradigm® PM and Veradigm® EHR separately)?
8. **What does IKI need to have ready:** CDH account number, IT contact, signed MOATiT–IKI agreement, Unity license key? IKI already uses Unity for another integration. Does that make activation simpler?
9. **Production credentials:** where do we get the production endpoint, the Ubiquity IDs for PM and EHR, and the production service credentials? Does the app name stay `MOATiT.MOATiT-Castle-AGENT.TestApp`, or do we get a production app name?
10. **Integration user:** who creates the dedicated Drawbridge user in IKI's Veradigm® EHR and Veradigm® PM (IKI, Veradigm or us), and what permissions should it have? (Portal ticket 19046 asked this for the sandbox.)
11. **Can we activate on an IKI test environment first**, if IKI has one?
12. **First production writes:** do we need to tell Veradigm before the first `SaveAppointment` / `SaveTask` in production, or is there a verification call?

### After go-live
13. **Credential expiry:** production service credentials rotate every 6 months. Which email gets the expiry notice? Can we add more contacts (Ali, Kanhaiya, Prashant, Musab)?
14. **Support:** if something breaks in production, do we open a Client Support Request or contact someone directly? (Our notes: the activation consultant for 7 business days, then a Client Support Request.)
15. **Using a declared-but-unused action later** (for example GetTaskList): is it already covered by this certification, or do we tell Veradigm first?
16. **A new action or workflow later:** full recertification, or an update to the API Assessment?
17. **Logs:** if your engineers need our logs, what format and how should we send them (no PHI)?

### Other
18. **While you're out (Oct 31 – Nov 9):** who should we contact?
19. *(Only if there is time)* The chart-data app "MVA" (FHIR, read only) is a separate production-access process, right? The sandbox reads still return "Invalid configuration" (tickets 16763 / 16777). Who can we follow up with?

---

## 2. Questions Lena may ask, with answers

### About the product

**Q: Give me a quick overview of what Drawbridge does.**
A: Drawbridge connects VeradigmAI, MOATiT's phone agent, to Veradigm® PM and Veradigm® EHR. A patient calls the clinic. The agent verifies them by first name, last name and date of birth, then it can tell them about upcoming appointments, find open times, book, cancel or confirm a visit, tell them their account balance and insurance on file, and create a staff task for anything it can't handle. Staff also get a web app with call records, a daily huddle, and an optional document intake add-on. The agent never writes to the chart.

**Q: What does it write to Veradigm?**
A: Only four actions write:
- `SaveAppointment`: book a visit (Veradigm® PM).
- `SetAppointmentStatus`: cancel or confirm a visit (Veradigm® PM).
- `SaveTask`: a staff task, for example a contact-detail change or a callback (Veradigm® EHR).
- `SaveScanDocument`: staff-side document intake add-on only. It is off by default and needs two-identifier patient matching. The phone agent never files documents.

We don't use `SavePatient` in release 1.0. Contact changes go to staff as a task.

**Q: Why did you remove GetPatientDiagnosis?**
A: You told us it opens an encounter that has to be closed with `CloseEncounter`, which is a write to the chart. We don't need the diagnosis list: the problem list comes from `GetClinicalSummary`. So we removed it, and the server now refuses that action before sending anything.



**Q: How do you match the PM patient to the EHR chart?**
A: `GetPatientDemographics` on Veradigm® PM gives `Patient_Number`, which is the EHR MRN. We call `GetPatientByMRN` on Veradigm® EHR. One MRN can return more than one chart, so we only accept a chart whose name and date of birth match the PM patient, and only when exactly one does. Otherwise we don't link them.





**Q: How do you verify the caller?**
A: The server enforces it, not just the voice prompt. A patient counts as verified on a call only when a search with first name, last name and date of birth finds exactly one patient with exactly that data. Every patient tool is refused (`NOT_VERIFIED`) for any patient not verified on that call, and nothing is sent to Veradigm. There are limits: 2 verified patients per call (caller plus one family member) and 5 identity searches per call.

**Q: How does the agent read appointments without seeing other patients?**
A: It uses `GetScheduleByPatientID`, never the full day schedule. Cancel and confirm check that the appointment is on the verified patient's own schedule first. `GetAppointmentById` is not used by the agent. `GetSchedule` (day schedule) is used only for the staff huddle and reminder lists, never with a PatientID.

**Q: What about restricted / "break the glass" patients?**
A: We don't call `SetPatientAccessReason`. The agent transfers the caller to staff instead.

### Authentication and tokens

**Q: How do you handle tokens?**
A: For each system: one `GetToken` and one `GetUserAuthentication`, shared by all concurrent calls. We replace the token a little before Veradigm's 20-minute inactivity expiry. If Veradigm rejects a token, we get a new one once. We call `RetireToken` on shutdown. Every auth call times out after 30 seconds.

**Q: What if the password is wrong or expired? Will you lock the account?**
A: No. If Veradigm refuses the sign-in for a reason a retry can't fix (ValidUser not YES, 401/403, access denied), Drawbridge "latches" that system. It sends no further logins, even after restarts, until the credentials change or an admin presses Retry. The agent then takes messages and our help desk gets an alert.

**Q: Where are credentials stored?**
A: In AWS SSM Parameter Store (SecureString), loaded into the container at deploy time. Never in code, git, logs or Postman files. In production the server refuses to start without the production endpoint and Ubiquity IDs set, so it can never fall back to the sandbox.

**Q: How will you rotate credentials?**
A: Unity production service credentials every 6 months (when Veradigm notifies us), EHR/PM user passwords about every 90 days. We update SSM and redeploy. Changed credentials clear the sign-in latch automatically.

### Required actions

**Q: Do you call GetServerInfo and LastLogs?**
A: Yes. `GetServerInfo` runs at startup and every 6 hours, and the health check uses it. `LastLogs` runs after a Veradigm-side error, at most once a minute per system and never in a loop. The results show on the staff "Veradigm connection" screen, scrubbed of patient data.

**Q: How often do you poll Veradigm?**
A: Never more often than every 2 minutes. The health check runs every 15 minutes by default. The document intake observer (`GetDocumentsByDocumentType`) runs every 30 minutes by default. Everything else runs only when a patient calls or a staff member opens a screen.

### Errors

**Q: What happens when a Veradigm call fails?**
A: The tool returns an error (`success: false`, an error code and whether it can be retried), never an empty list. So the agent says "I'm having trouble reaching the records" instead of "you have no appointments". If both systems are down, the agent takes a message or transfers to staff, and our help desk is alerted.

**Q: Can Drawbridge call an action that isn't in the API Assessment?**
A: No. The server has a fixed allow-list of the declared actions and refuses anything else with `ACTION_NOT_ALLOWED`, before signing in or sending a request. Configuration can't add new actions.

### Logging, PHI and security

**Q: What do you log? Is there PHI?**
A: Request and response bodies are never logged, and neither are passwords or tokens. The audit log has one line per tool call or Veradigm action: time, action, call ID, opaque patient ID, success, error code and latency. No names, dates of birth or chart contents. Audit lines are hash-chained and kept for 6 years.

**Q: Can you show timestamps of successful calls?**
A: Yes. Show the staff app **Activity** screen, or the write test report (`SCHEDULING_WRITE_TEST_2026-10-15.md`). Note: audit lines before Oct 26 were lost when the server data volume was recreated. That is fixed now, so new lines persist across deploys. The Oct 15 write test report has the exact times for the writes.

**Q: Where is it hosted?**
A: AWS (EC2, us-east-1), behind nginx with HTTPS. Staff app logins need a password plus mandatory two-factor (TOTP), with lockout after 5 failures and a 15-minute idle timeout. The phone agent uses its own key, and it only opens the phone agent endpoint.

### Testing and writes

**Q: Did you test the writes?**
A: Yes, on synthetic patients, with the owner's approval:
- `SaveTask` and `SaveScanDocument` on Oct 11.
- `SaveAppointment` and `SetAppointmentStatus` (book, confirm, cancel) on Oct 15, on PM patient 51389. Every test appointment was canceled afterwards. The report has the timestamps.

**Q: Can you run a call for me now?**
A: Yes. Use the Postman collection:
1. **1. Sign in**
2. **3. Patient matching**: Teodoro Brightwater, PM 51389 → EHR 81069
3. Whichever **4. Veradigm PM reads** / **6. Veradigm EHR reads** she wants
4. Writes (folder 5 or 8) only if she asks; cancel any appointment you create
5. **10. Sign out**

**Q: What happens to a slot between the agent offering it and booking it?**
A: Before `SaveAppointment`, Drawbridge re-checks the slot with `GetAvailableSchedule`. The agent reads back the details and the caller confirms before booking.

### Business

**Q: Who is the first client, and what volume do you expect?**
A: Idaho Kidney Institute (IKI). Volume: [confirm with Ali: calls per day / clinic locations]. Most traffic is reads during patient calls. Polling is limited to the health check and the optional intake observer.

**Q: Who supports it?**
A: MOATiT's help desk (help@moatit.com) gets automatic alerts when a Veradigm connection goes down, with reminders every 4 hours and a recovery notice. Technical contact: Kanhaiya. Owner: Ali Khan.

---

## 3. If Lena asks something not covered here

Say: "Let me confirm that and email you today." Write it down. Do not guess on anything about production, credentials or patient data.

## 4. After the call

- Send Ali (and Musab) a short summary: what was shown, what Veradigm needs from us, deadlines (before Oct 31).
- Update the "Client activation" section of `docs/drawbridge/VERADIGM_APPROVAL_GUIDE.md` with the steps Lena showed.
- If Lena says to drop `GetPatientAilments` / `GetDictionary`, remove them from `CERTIFIED_ACTIONS`, the actions doc and the API Assessment.
