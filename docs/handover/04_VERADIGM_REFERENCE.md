# Veradigm reference: what the docs say

Every point below cites a source file in `source-docs/` (text versions in `source-docs/text/`) or a Veradigm developer portal page checked on Oct 8, 2026. Where something wasn't found, it says so.

## 1. Two APIs, two jobs

| | FHIR R4 | Unity |
|---|---|---|
| Access | **Read only.** "limited to read-only access and not write-backs" | **Read and write** (bidirectional) |
| Use for | Chart reads (USCDI data) | All Practice Management data (demographics, appointments, financial) and EHR actions |
| Rule | — | "To integrate with Veradigm Practice Management, developers must utilize Unity to read or write patient demographic, appointment, or financial data." |
| Licensing | FHIR apps "must be explicitly licensed for individual client sites" | Certification, then per-client activation |
| Source | developer.veradigm.com/Fhir/ProcessOverview | same page; Certification Process Overview |

## 2. FHIR R4

**Supported resources (27), from developer.veradigm.com/Fhir/Resources:**
AllergyIntolerance, CarePlan, CareTeam, Condition, Coverage, Device, DiagnosticReport, DocumentReference, Encounter, Goal, Group, Immunization, Location, Medication, MedicationDispense, MedicationRequest, Observation, Organization, Patient, Practitioner, PractitionerRole, Procedure, Questionnaire, QuestionnaireResponse, RelatedPerson, ServiceRequest, Specimen.

**Not supported: Appointment, MedicationStatement.** EHR versions before 26.0 can differ, so check the Capability Statement: `GET [base]/metadata`.

**Formats and version** (FHIR - Introduction):
- JSON by default (`Accept: application/fhir+json`).
- Add `fhirVersion=4.0` to the Accept header on version-less environments.
- DSTU2 support ended **6/1/2025**. Use R4 only.

**Endpoints** come from the Endpoint Directory: open.platform.veradigm.com/fhirendpoints.
- `/fhir` endpoints are for product users (Provider badge).
- `/open` endpoints are for patient apps.

**Auth flows:**
- **Standalone launch for a product user and SMART launch** both put a person at a login screen. They won't work for a phone agent. (FHIR - Introduction)
- **Standalone launch for a patient:** a patient-facing app flow.
- **System (backend) app** is the one for Drawbridge (developer.veradigm.com/Fhir/SMARTonFHIR):
  1. Register the system app with a JWKS endpoint.
  2. Sign a JWT client assertion. It's single use and expires in **2–20 minutes**.
  3. POST to the token endpoint with `client_assertion`, `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`, `grant_type` (client credentials) and `scope`.
  4. Veradigm syncs JWKS nightly.
- The client must authorize the app in Veradigm's **License Management Portal**.

**Searching** (FHIR - Searching):
- Dates: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. Comparators `eq gt ge lt le`, e.g. `date=ge2026-10-01&date=le2026-10-31`.
- Common parameters: `_id`, `_lastUpdated`, `_count`, `_include` / `_revinclude` (Provenance only), `_summary`.
- Errors: 401, 403, 404, 413.
- **Redacted data:** results can be marked "redacted" when Veradigm's Clinical Authorization Service decides the requester can't see them. The data exists but is hidden. Never report it as "none on file."

## 3. Unity

**Calling pattern** (repo `unity.service.ts`, Veradigm sample code):
1. `POST .../UnityService.svc/json/GetToken` with the Unity app (service) credentials. Returns a token (~20-minute life).
2. `POST .../json/MagicJson` with `{Action, Appname, AppUserID, PatientID, Token, Parameter1..Parameter6, Data}`. The `Data` field must be present, even empty.
3. Call `GetUserAuthentication` first in every session. It binds the token to the EHR/PM user.
4. `Echo` tests the connection. `LastLogs` is the troubleshooting log (useful for HTTP 500s).
5. Every call must use HTTPS before OpenQA testing.

**Practice Management actions relevant to us** (Veradigm Practice Management API Reference):
- Patients: `SearchPatients` (XML in Parameter1, max 100), `SavePatient` (adds *or updates* demographics; call SearchPatients first), `GetPatientDemographics`
- Schedule: `GetScheduleByPatientID`, `GetAppointmentById`, `GetAllAvailableAppointments`, `GetFirstAvailableAppointments`, `GetAvailableSchedule`, `GetAvailableTimeBlocks`, `SaveAppointment`, `SaveForcedAppointment` (don't use; overrides blocks), `SetAppointmentStatus`, `GetAppointmentCancellationReasons`, `GetAppointmentConfirmationResults`, `GetAppointmentTypes`, `GetAppointmentRestrictions`, `GetSchedule`, `GetAppointmentsByChangeDTTM`, `GetRecalls`, `GetSchedulingLocations`, `GetSchedulingDepartments`, `GetResources`
- Financial: `GetPatientAccountBalance` (one record per voucher, so sum them), `GetPatientAccountBalanceCalc`, `GetPatientPolicy`
- Provider: `GetPractitioners`, `GetPractitionerSpecialties`
- Admin/Security: `Echo`, `GetServerInfo` (PM version, time zone), `LastLogs`, `GetUserAuthentication`

**EHR actions relevant to us** (Veradigm EHR API Reference):
- Patient: `GetPatient`, `GetPatientByMRN` (MRN can match more than one patient), `GetPatientFull` (with insurance), `SearchPatients`, `SearchPatientsXML`
- Clinical (PAMI): `GetProblems`, `GetAllergies`, `GetImmunization`, `GetPatientDiagnosis`, `GetClinicalSummary`, `GetPatientSections`, `GetVitalsData`, `GetResults`, `GetOrders`
- Tasks: `SaveTask`, `GetTask`, `GetTaskList`
- Other: `GetLocation` (includes business hours), `GetProviders`, `GetProvider`, `GetPatientPharmacies`, `GetSchedule`
- Admin/Security: `Echo`, `GetServerInfo`, `LastLogs`, `GetUserAuthentication`, `GetTokenValidation`, `SetPatientAccessReason`

**Not found in either reference:** `UpdateDemographics`, `CancelAppointment`, `GetOpenSlots`, `GetAppointments`, `BookAppointment`, `GetPatientProblems`, `GetPatientMedications`, `GetPatientAllergies`, `SearchProviders`, `LastLog`. See `02_REPO_AUDIT.md` §3.

**Code samples** on the developer portal: C# (SOAP and JSON), Java, Ruby, Python, for both EHR and PM. HTTPS handling isn't included.

## 4. Certification (Certification Process Overview; API Assessment form)

- **Typically 4–6 weeks.**
- **Gold or Platinum subscription required** to enter certification.
- **Recertification required when Unity actions are added** or workflows change.

**Steps:**
1. Veradigm Connect membership and plan.
2. API development in Veradigm test environments, with our own test credentials.
3. **Security Questionnaire**: emailed to VeradigmConnect@veradigm.com.
4. **API Assessment**: submitted once code-complete and unit-tested. Keep timestamps of successful calls. It must include:
   - integration description
   - the full list of Unity actions
   - a system/sequence diagram
   - install and config screenshots
   - a **narrated workflow video** against the test environments
   - EHR/PM workflows, including patient workflows for non-launcher apps
   - the credential management process
5. QA testing: a recorded live demo against the sandboxes; QA can send the app back to development.
6. Services and Support handoff.
7. Certified.
8. **Billing**: set up Billtrust for API fees; the subscription is paid through the portal.

**Developer expectations:**
- SSL on everything.
- Reconfigurable Unity endpoint, service credentials, EHR/PM user and password, and polling interval.
- Customer settings stored centrally, per client.

## 5. Client activation (Client Activation Process)

- Needs an **active contract** between MOATiT and the client, plus a completed certification.
- **Pre-submission checklist** (from the client):
  - client name
  - **CDH account number** (from their Central account)
  - IT contact
  - Veradigm product(s), with **one activation request per product** (PM and EHR separately)
  - Unity license key, if available
- **Flow:**
  1. We submit the request in the portal.
  2. The client gets an automated "Authorization Requested" email and fills in the form.
  3. Veradigm completes the request in **about 2–5 business days**.
  4. Pre-install: Unity version, Ubiquity if needed.
  5. The license is applied to production. It refreshes after 24h.
- **Post-activation support:** contact the consultant directly for 7 business days; after that, a Client Support Request.
- **Expirations:** Unity production credentials every **6 months** (subscribe to notices). EHR/PM user passwords about every **90 days**.
- **Migrations** change Client ID or Unity URL, and the license may need reapplying.
- **Test app activation** before certification is possible if the client has a test environment. Email the details in the doc.
- **Pricing:** "no cost to connect to a test environment"; "our mutual clients do not incur a fee for API usage from Veradigm."
- **Deactivation:** invoicing ends the next billing cycle.
- IKI already has Unity connected for another integration, so the pre-install steps should be minimal.

## 6–7. Fees and contract restrictions

Confidential (Integrator Agreement). Not stored in the repo. See the handover folder's `04_VERADIGM_REFERENCE.md` and `08_DECISIONS_AND_OPEN_QUESTIONS.md`, held by MOATiT management.
