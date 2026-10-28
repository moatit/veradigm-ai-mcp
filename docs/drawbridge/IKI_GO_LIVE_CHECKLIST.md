# Idaho Kidney Institute (IKI) go-live checklist

Drawbridge was certified by Veradigm on **Oct 27, 2026** (email from Lena Wilser, "Congratulations - You're Certified! (MOATiT, LLC)"). Certified app: **`MOATiT.Drawbridge.ProdApp`**, for Veradigm® PM (Unity Born-on-Date 9/01/2026, PM 26.2.0 or later) and Veradigm® EHR (Unity Born-on-Date 10/06/2026, EHR 26.7 or later).

Sources: Veradigm's Implementation Guide for Drawbridge (Oct 22, 2026) and "Veradigm Connect – Client Activation Process" (both attached to the certification email; not stored in the repo because they are Veradigm proprietary).

## 1. Before the activation request (MOATiT and IKI)

- [ ] **Signed MOATiT–IKI contract.** Veradigm won't accept an activation request without an active contract with the client. *Ali*
- [ ] From IKI:
  - [ ] Client name as Veradigm has it.
  - [ ] **CDH number** (client account number, usually five digits; IKI finds it in its Veradigm Central account).
  - [ ] IT contact: name, phone, email.
  - [ ] Unity license key, if IKI has one (IKI already uses Unity for another integration).
  - [ ] Whether IKI has a Veradigm test environment. If yes, we can ask for a test-app activation first (email VeradigmConnect@veradigm.com; no cost for test environments).
- [ ] Agree with IKI who owns the **dedicated Drawbridge users** (one in Veradigm® PM, one in Veradigm® EHR), who watches password expiry (about every 90 days) and who resets them. Veradigm's guide says Veradigm creates both users and gives us the passwords; IKI maintains them after that.

## 2. Activation request (Veradigm Connect portal)

- [ ] Dashboard → **Activations** tile → **Request Client Activation** → choose `MOATiT.Drawbridge.ProdApp`.
- [ ] **Two requests:** one for Veradigm® PM, one for Veradigm® EHR.
- [ ] In Notes: "Partner: MOATiT. Unity AppName: MOATiT.Drawbridge.ProdApp. Dedicated Veradigm PM and Veradigm EHR users needed. JSON must be enabled; Unity reachable from the internet (public domain)."
- [ ] IKI gets an "Authorization Requested" email (we are copied). Follow up with IKI until they fill in the authorization form. If it stays pending, Veradigm emails us and we chase IKI directly.
- [ ] After authorization: Veradigm's activations team checks the Unity Born-on-Date, installs or updates Unity/Ubiquity if needed, applies the license (refreshes within 24 h) and sends a **secure summary email in about 2–5 business days**.

## 3. What the summary email should give us

- [ ] Production Unity endpoint (URL).
- [ ] Ubiquity IDs for Veradigm® PM and Veradigm® EHR.
- [ ] Production Unity service username and password for `MOATiT.Drawbridge.ProdApp`.
- [ ] Dedicated Veradigm® EHR username and password, and the Veradigm® PM user and password.

Token username format (Veradigm's guide): `UbiquityID:PMClientID^TenantID^UnityUsername`. Drawbridge builds it as `UNITY_UBIQUITY_ID_<PM|EHR>` + `UNITY_SVC_USERNAME`.

## 4. Production configuration (AWS)

Production values go only into AWS SSM (SecureString), never into code, git, email or chat.

- [ ] SSM `/veradigm/unity/app-name` = `MOATiT.Drawbridge.ProdApp` (today it is the test app name).
- [ ] SSM: production endpoint, both Ubiquity IDs, service username/password, EHR username/password, PM username/password (or `pm-share-ehr-login` if one user is used for both).
- [ ] EC2 compose (`/opt/veradigm/docker-compose.yml`, from `infra/terraform/user-data.sh` lines 153 and 179): `NODE_ENV=sandbox` → `production` for fhir-mcp and unity-mcp. In production Drawbridge refuses to start without the endpoint and Ubiquity IDs, so it can't fall back to the sandbox.
- [ ] Deploy, then check: staff app **Veradigm connection** screen shows both systems UP and `GetServerInfo` answers.
- [ ] Owner's OK before switching from the sandbox to production (CLAUDE.md rule 3).

## 5. Onboarding reads at IKI (read only; Veradigm's guide requires them per site)

- [ ] `GetDictionary` with Parameter1 **`MSGTYPE`**: the allowed SaveTask task types. Pick the one for phone-agent staff tasks and set SSM `unity/task-type` (`UNITY_TASK_TYPE`; code default "Call Patient"). Set `unity/task-target` (`UNITY_TASK_TARGET`) to the IKI user or team that should get the tasks.
- [ ] Task priority values for SaveTask (`<taskpriority>`): `GetDictionary` with **`MSGPRIOR`** (found with `GetListOfDictionaries`, as Lena advised, Oct 27). Sandbox: Low (0), Medium (1), High (2). Drawbridge sends `Medium` and `High` (intake review tasks); confirm both exist at IKI. There is also a `PRIORITY` dictionary (Routine, STAT, Urgent); the guide's example `<taskpriority>Routine</taskpriority>` may come from it, but only Medium and High have been tested with SaveTask. `GetTaskList` shows Medium/High back as "RoutineNA"/"UrgentNA".
- [ ] `GetDictionary` with **`SCAN_DOCUMENTTYPE`**: IKI's document categories for SaveScanDocument (document intake add-on; set `INTAKE_CATEGORY_MAP`). Intake filing stays off (`INTAKE_FILING`) until IKI and the owner approve.
- [ ] Clinic settings: `CLINIC_NAME`, `CLINIC_TIMEZONE` (America/Boise), `CLINIC_HOURS`, providers and scheduling locations/departments from `GetResources`, `GetSchedulingLocations`, `GetSchedulingDepartments`.
- [ ] Note: `GetPatientAilments` returned "Action is not valid for this license" on the sandbox. It isn't used in release 1.0; check it on IKI's license before anyone starts using it.

## 6. Phone agent (Retell)

- [ ] Agent `drawbridge-v7-cascade`: every custom function URL `https://unity.veradigmai.com/api/retell`, header `x-drawbridge-key` = SSM `drawbridge/agent-key`.
- [ ] Phone number pinned to the published agent version that has those URLs.
- [ ] Inbound webhook `https://unity.veradigmai.com/webhooks/retell-inbound` once `retell/webhook-api-key` is in SSM.
- [ ] Rotate the dev-server (`drawbridge.moatit.dev`) agent key that was exposed in a screenshot on Oct 26. *Ali*

## 7. First production day

- [ ] First reads only: a test call with a test patient that IKI sets up in production. Keep real patient data out of logs, tickets and chat.
- [ ] First writes (`SaveAppointment`, `SaveTask`) with IKI staff watching, on a patient IKI chooses.
- [ ] Support for 7 business days after the summary email: the Veradigm consultant who did the activation. After that: Client Support Request in the developer portal, or VeradigmConnect@veradigm.com.

## 8. Ongoing

- [ ] **Unity production credentials expire every 6 months.** Expiry notices go to Ali, Kanhaiya and Prashant (add Musab) via the developer portal. Renew 30 days before (MOATiT operations calendar), update SSM, redeploy, verify, then retire the old ones.
- [ ] **EHR/PM user passwords: about every 90 days**, with IKI.
- [ ] **Client migrations** (IKI moving server, hosting or Unity URL): IKI or Veradigm Support tells us; endpoint, Ubiquity ID or license may change, and vendor users may need to be re-added.
- [ ] Adding a Unity action or changing a workflow needs Veradigm recertification.
- [ ] Deactivation (if ever): portal → View Activations → Deactivate.
