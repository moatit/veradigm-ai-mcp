# Status: Friday Oct 9, 2026, 6:50 AM MT (demo 5:00 PM, code freeze 2:00 PM)

## TL;DR

The phone line, Drawbridge and the staff app are live on Ali's machine at `https://drawbridge.moatit.dev`. The test number **(208) 904-3641** answers with the new agent: safety rules, transfers to Ali's cell, after-hours flow, on-call notebook. **Patient data is still blocked by two Veradigm-side items.** Neither can be fixed from our side:

| Blocker | Waiting on | Effect |
|---|---|---|
| Unity sandbox user `Kanhaiya.K.MOATiT` has no working password (EHR and PM have separate passwords; both stale) | **Veradigm ticket 19041** (Kanhaiya opened it 08:49 UTC). Kanhaiya sends the password once Veradigm confirms it in the EHR front end. | No appointments, open slots, balance, insurance or Unity chart reads. The agent says "I'm having trouble pulling that up" and offers staff. |
| FHIR system app "MVA" logs in with our new key | **Veradigm's nightly JWKS sync** (portal shows our key; the token endpoint still answers `invalid_client` at 06:49) | No meds/allergies through FHIR |

## What works now (verified)

- **Phone → Retell → Drawbridge.** Agent `drawbridge-healthcare-agent` (v1) is bound to (208) 904-3641. Its 28 functions hit `https://drawbridge.moatit.dev` with the shared key. Retell tool calls reach the gateway (verified via the Retell test chat + gateway log).
- **Guardrails.**
  - "Chest pain" → 911 instruction and transfer offer (tested).
  - A failed lookup → "I'm having trouble pulling that up" plus an offer of staff, never "you have no appointments" (tested).
- **Transfer.** The `transfer_to_staff` tool goes to Ali's cell **+1 208-776-0388**. Real phone calls only; Retell's browser test can't transfer.
- **After-hours / on-call (P1).** Call mode by schedule or manual switch, call records, and the notebook at `/app/oncall`.
- **Staff app** at `https://drawbridge.moatit.dev/app`: on-call, staff assistant, huddle brief, outreach (dry-run), activity/audit. These screens show "Couldn't reach Veradigm® PM" until the user password is fixed.
- **Admin portal** (moatit/veradigmai) at `http://127.0.0.1:8096`. Tool-call logs flow into it.
- **Infrastructure.**
  - Docker stack `drawbridge-dev` (ports 8095/8096 only).
  - Tunnel runs as the scheduled task "Drawbridge Dev Tunnel" (survives Claude/session restarts).
  - Cloudflare Bot Fight Mode is off on moatit.dev; it was 403-ing Retell.
- **AWS.** Kanhaiya renewed the cert (fhir/unity/admin.veradigmai.com valid to Jan 7, 2027) and put the new Unity service user on AWS.

## What changed overnight (all on `drawbridge/platform`, pushed; nothing on `main`)

- **Unity login fixes**
  - `ValidUser=NO` is now a failed login. Before, it was treated as success and caused confusing per-action errors.
  - Separate PM login settings (`UNITY_PM_USERNAME/PASSWORD`). With none set, PM calls are refused locally, so we can't lock the PM account.
  - Placeholder users are never sent to Veradigm.
- **FHIR**
  - `private_key_jwt` login for Veradigm FHIR R4 (`FHIR_AUTH_MODE=private_key_jwt`).
  - The local stack points at Veradigm's CP00101 sandbox (same practice as the Unity EHR sandbox).
  - The JWKS is published at `https://drawbridge.moatit.dev/.well-known/jwks.json`, and the MVA app's JWKS URL points there (Ali changed it in the portal; the old URL was dead).
- **Retell**
  - Transfer tool added. Prompt rule: every "transfer" uses `transfer_to_staff`.
- **Facts confirmed by Kanhaiya**
  - There is **no newer code than `edaf08f`**, so our branch has all of his work.
  - The sandbox user is `Kanhaiya.K.MOATiT`, with separate EHR and PM passwords.
- **Account safety log for `Kanhaiya.K.MOATiT`.** 5 failed logins tonight (4 at ~05:50 UTC EHR+PM, 1 EHR at ~07:20 UTC with a password that turned out to be his developer-portal password). Not locked. No attempts since. The username stays out of `.env` until Veradigm confirms a password.

## To do once the password arrives (about 1–2 h of work)

1. Put `UNITY_EHR_USERNAME/PASSWORD` in `deploy/local/.env`. Make **one** EHR `GetUserAuthentication` and check `ValidUser=YES`.
2. Restart unity. Run `docker exec drawbridge-dev-unity-1 node dist/scripts/verify-sandbox.js` and fix parameter formats (not verified yet):
   - `SearchPatients` XML
   - `GetScheduleByPatientID` / `GetAppointments`
   - `GetAllAvailableAppointments`
   - `SetAppointmentStatus`
   - `SaveTask`
3. With the PM password: the same for PM (one attempt), then a reschedule test on Ed Smith 12/06/1952 in Retell's text test.
4. Three live phone runs per scenario before 4:30 PM.

## 5 PM demo plan

**A. If the password is fixed by ~2 PM:** run the original script (`06_DEMO_SCRIPT.md`). Owner calls as Ed Smith → reschedule. Ali calls for meds/allergies → dose question → transfer. Then after-hours → notebook.

**B. If not (likely, given Veradigm's turnaround), show only what works live, honestly:**
1. **Owner calls the test line.** Greeting. "I have chest pain" → 911 instruction + transfer offer.
2. **"Can I talk to a person?"** → live transfer to Ali's cell (rings on stage).
3. **After hours.** Switch the line to after-hours in `/app/oncall`, call, leave a routine message. Open the notebook and show the record.
4. **Staff app tour.** Huddle brief, staff assistant, outreach queue (dry-run), activity log. Admin portal call reports.
5. **Patient lookups.** Say plainly that Veradigm is resetting the sandbox test user today. Show the deck's flow (slides 5–6) and how the agent fails safe ("I'm having trouble pulling that up" + transfer) instead of guessing.

**Before 4:30 PM:** one live call through each flow above; check `/health` and the tunnel. Ensure the test number is still bound to `drawbridge-healthcare-agent` (rollback command in `docs/drawbridge/RETELL_SETUP.md`).

**No backup video yet.** If time allows before 2 PM, record flows B1–B4 as the fallback.

## Decisions for Ali

- **Demo mode?** Do you want a clearly labelled "demo data" mode (sample appointments returned by Drawbridge when Veradigm is unreachable)? Recommendation: **no** for a client demo, since it isn't Veradigm data. Use plan B and be upfront about the sandbox reset.
- **Push Veradigm.** Push ticket 19041 by phone/email in the morning (VeradigmConnect@veradigm.com, Sanket Pandhare, who handled the PTE in Dec/Jan). Ask for the EHR **and** PM passwords for `Kanhaiya.K.MOATiT` and for the JWKS sync of FHIR app `d7ae9265-…` to be run now.
