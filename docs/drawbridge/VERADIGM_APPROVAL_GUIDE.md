# Getting Drawbridge approved by Veradigm

Owner: **Musab** (Veradigm approvals). Claude prepares the technical material and keeps this file current. Status as of **Oct 27, 2026**.

> **Track A is done: Drawbridge is certified (Oct 27, 2026).** Veradigm certified **`MOATiT.Drawbridge.ProdApp`** with Veradigm® PM (Unity Born-on-Date 9/01/2026) and Veradigm® EHR (Unity Born-on-Date 10/06/2026). Certificate, Implementation Guide and Client Activation Process came with Lena Wilser's email "Congratulations - You're Certified! (MOATiT, LLC)". Next: client activation for IKI, tracked in `IKI_GO_LIVE_CHECKLIST.md`. The Track A sections below are kept as history.

Drawbridge talks to Veradigm two ways, and each needs its own approval:

| Track | What it covers | Veradigm process | Who turns it on at a clinic |
|---|---|---|---|
| **A. Unity API** (app `MOATiT.MOATiT-Castle-AGENT.TestApp`) | Veradigm® PM: appointments, open times, booking, cancel, balance, insurance, patient registration. Veradigm® EHR: chart summary (meds, allergies, problems, results), staff tasks | **Certification** (typically 4–6 weeks), then **client activation** per product | Veradigm, after the clinic approves the activation request |
| **B. FHIR R4 API** (system app "MVA", client ID `d7ae9265-…`) | Read-only chart data through Veradigm's standard chart API | **Request Production Access** on the app page (processed within 10 days) | The clinic, in Veradigm's **License Management Portal** |

Sources: developer.veradigm.com (Certification Process Overview, Client Activation Process, FHIR Process Overview, SMART on FHIR). Summary in `docs/handover/04_VERADIGM_REFERENCE.md` §4–5.

## Track A: Unity certification

### Prerequisites
- [ ] Veradigm Connect membership on a **Gold or Platinum** plan (required to enter certification). Current plan: **Bronze Integrator** (portal dashboard, Oct 11). Ali: MOATiT upgrades to Gold when we start the certification process.
- [x] Test environment and credentials (PM `VHCP001PM:PMGA02^8^`, EHR `AHMCP00101:CP00101^1^`, user `Kanhaiya.K.MOATiT`). Working as of Oct 9.

### Steps (Veradigm's order)
1. **Security Questionnaire**: emailed to VeradigmConnect@veradigm.com. *Musab submits; Claude drafts the technical answers (hosting, encryption, logging, access control, credential storage).*
2. **API Assessment**: submitted when code-complete and unit-tested. It must include:
   - [ ] Integration description. *Claude drafts from the deck.*
   - [ ] **Full list of Unity actions**. *Claude: generated from `src/unity/config/unity-endpoints.ts`; only actions verified on the sandbox.* Writes: `SaveAppointment`, `SetAppointmentStatus`, `SaveTask`, `SaveScanDocument` (fax/lab intake; verified Oct 11). `SavePatient` is not used in this release (removed Oct 16: the request lacked AccountID; no certified workflow needs it). The list goes in the Certification Package (portal dashboard → Certification); the app page in the portal has no action list.
   - [ ] System / sequence diagram. *Claude*
   - [ ] Install and configuration screenshots. *Claude*
   - [ ] **Narrated workflow video** against the test environments. *Claude writes the script and runs the calls; Musab or Ali narrates and records.*
   - [ ] EHR and PM workflows, including patient workflows. *Claude*
   - [ ] Credential management process (rotation: Unity production credentials every 6 months, EHR/PM user passwords about every 90 days). *Claude*
   - [ ] **Timestamps of successful calls**. *Claude: exported from the Drawbridge activity log / admin portal.*
3. **QA testing**: a recorded live demo against the sandboxes. QA can send the app back for fixes. *Musab schedules; Claude fixes whatever QA finds.*
4. Services and Support handoff.
5. **Certified.**
6. Billing: Billtrust set up for API fees; the subscription is paid through the portal. *Musab*

**Important:** adding Unity actions or changing workflows later requires **recertification**. Submit the complete action list the first time, including the planned ones (staff task, recalls) and the **fax/document intake add-on**: `SaveDocumentImage` (file a received document to the chart), `GetDocumentType`, `GetDocuments`, and for the shadow-mode staff filing observer the reads `GetDocumentsByDocumentType` and `GetDocumentImage`. See `docs/drawbridge/FAX_INTAKE_ADDON.md`.

### Before we can submit (engineering blockers)
- [ ] **Write actions verified on the sandbox**: `SaveScanDocument`, `SaveTask` verified Oct 11 (`SavePatient` was used Oct 11 only to create synthetic test patients and is not in this release) (synthetic patients, Ali's OK). `SaveAppointment` and `SetAppointmentStatus` (cancel `X`, confirm) still to run. No write is run without Ali's OK.
- [ ] **Dedicated integration user** (Veradigm requires one): requested in portal ticket **19046** (Oct 11) for the EHR and PM sandboxes; also asks whether filing into existing document types is fine for certification.
- [x] Read actions verified Oct 9 (see `docs/handover/11_STATUS_2026-10-09_MORNING.md` and the commit log on `drawbridge/platform`).
- [ ] `main` fixed: patient appointments must use `GetScheduleByPatientID`, not `GetSchedule` (privacy). Asked Kanhaiya Oct 9.
- [ ] Unity service credentials removed from `postman/` on `main` and rotated.

### Client activation (after certification), Idaho Kidney Institute

Current step-by-step list: `IKI_GO_LIVE_CHECKLIST.md`.
Checklist from the client:
- [ ] Signed MOATiT ↔ IKI service agreement (Veradigm requires an active contract).
- [ ] IKI's **CDH account number** (from their Veradigm Central account).
- [ ] IKI IT contact.
- [ ] Products: **one activation request per product** (Veradigm® PM and Veradigm® EHR separately).
- [ ] Unity license key, if IKI has one (IKI already uses Unity for another integration, so pre-install should be minimal).

Flow: we submit the request in the portal → IKI gets an "Authorization Requested" email and fills in the form → Veradigm completes it in about 2–5 business days → the license applies to production (refreshes within 24 h). For 7 business days after activation, contact the consultant directly; after that, use a Client Support Request.

Option: **test-app activation before certification** is possible if IKI has a test environment. Worth asking IKI; it lets us test on their data shape early.

## Track B: FHIR app "MVA"

### Current state (Oct 9)
- App type **System**, purpose of use "healthcare operations", JWKS `https://drawbridge.moatit.dev/.well-known/jwks.json`, status **Test Only**, licensed by "Veradigm Connect".
- Login with the original client secret works on the CP00101 sandbox (token 200, `system/*.read`).
- **Blocker:** every read returns HTTP 500 "There is a Configurations Error … Invalid configuration". This is Veradigm-side: Veradigm confirmed on ticket **16763** (Apr 27) it is a server-side CP00101 sandbox issue. Ticket **16777** (Kanhaiya, Feb) was answered Oct 11: still occurring, with the request IDs below. The client secret posted in 16763 must be rotated. Request IDs: `ac4bb0a7-8da0-492f-8c31-3e1ae02bf0e2`, `3dbb7d8c-dae1-46a1-8d77-2e82b58009fa`, `9692b1da-3cae-4ade-badd-f86716296c29`. *Musab / Kanhaiya: open a Veradigm Connect ticket with these IDs.*
- The newer JWT key and the "drawbridge-dev" secret aren't synced to CP00101 yet (`invalid_client`). Veradigm syncs JWKS nightly.

### Steps
1. [ ] **Fix the scopes before requesting production.** The app is System type but also has user/patient scopes ticked (`fhir`, `fhirUser`, `launch/patient`, `profile`). Veradigm: "The scopes must match the FHIR App Type," and an app requesting mismatched scopes "will not be approved." Keep only `system/*.read` (or the specific `system/…read` scopes we use). Don't mix V1 (`.read`) and V2 (`.rs`) scopes.
2. [ ] Get the "Invalid configuration" ticket resolved and run all 15 chart reads on the sandbox.
3. [ ] **Request Production Access** (button on the FHIR App page). Processed within 10 days. **After approval, the app name, type and Purpose of Use can't be changed**, so confirm them first:
   - Name: "MOATiT-AGENTIC VOIP AGENT" (shown to clinics in the License Management Portal; consider a clearer name such as "MOATiT VeradigmAI Phone Agent").
   - Type: System.
   - Purpose of Use: healthcare operations (confirm; "treatment" may fit patient-facing calls better).
4. [ ] IKI authorizes the app in the **License Management Portal**.

## Who does what

| Task | Musab | Claude | Others |
|---|---|---|---|
| Plan level (Gold/Platinum), contracts, billing | ✔ | | Ali |
| Security Questionnaire | submits | drafts technical answers | |
| API Assessment package | submits | drafts all documents, diagram, action list, call timestamps | |
| Workflow video | narrates or records | script + runs the calls | Ali |
| Veradigm tickets and calls | ✔ | prepares the details | Kanhaiya (sandbox user) |
| Write-action formats | | implements and tests (with Ali's OK) | Kanhaiya |
| QA fixes | | ✔ | |
| IKI activation paperwork | ✔ | | IKI IT |

Contacts: VeradigmConnect@veradigm.com (certification, activation, licensing, fees). Sanket Pandhare handled our partner test environment in Dec/Jan.
