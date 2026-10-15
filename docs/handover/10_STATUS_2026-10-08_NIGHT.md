# Status: Thursday Oct 8, 2026, night (branch `handover/demo-2026-10-09`)

## Root cause of the "certificate expired" error on Retell

The Let's Encrypt certificate on `fhir.`, `unity.` and `admin.veradigmai.com` (one cert, CN `admin.veradigmai.com`) **expired July 12, 2026**. Retell can't open HTTPS to Drawbridge until it's renewed. Fix on the EC2 host (folder with `docker-compose.prod.yml`):

```
docker exec veradigm-certbot certbot renew --webroot -w /var/www/certbot --force-renewal
docker exec veradigm-nginx nginx -s reload
curl -vI https://unity.veradigmai.com/health   # expiry ~90 days out
```

Cause: certbot renewed in its container but nginx never reloaded. The branch adds a 6-hour `nginx -s reload` loop (`infra/docker-compose.prod.yml`, `infra/terraform/user-data.sh`). Infra changes don't auto-deploy; apply by hand.

**Separately**, the Unity service credentials expired and were recreated (Ali's email to Kanhaiya, Oct 8). Put the new values in SSM `/veradigm/unity/svc-username` and `svc-password`, rerun `fetch-secrets.sh`, and restart `unity-mcp`. With the old credentials, every Unity tool now returns `TOOL_ERROR (AUTH_ERROR, retryable=no)`.

## Done on this branch (type-checked; `npm run smoke` passes 13 offline checks)

| Spec item | Change |
|---|---|
| Silent empty lists (audit §4) | Unity tools throw on failed calls. Servers return `{success:false, error_code, retryable}` and the agent hears `TOOL_ERROR ...`, never "no appointments/openings". Raw error text is no longer read to callers. |
| Action names (audit §3) | All names are in `unity-endpoints.ts`, each overridable with `UNITY_ACTION_<KEY>`. **Defaults are unchanged** (the Feb 13 names) because the sandbox isn't verified yet. `LastLog` → `LastLogs`. |
| P0/P1 planned tools | `unity_get_cancellation_reasons`, `unity_get_appointment_types`, `unity_get_appointment_details`, `unity_confirm_appointment`, `unity_get_account_balance` (sums vouchers), `unity_get_insurance_policy` (member ID last 4 only), `unity_create_staff_task` (SaveTask, the only EHR write) |
| Idempotency | Write tools are de-duplicated on Retell `call_id` + tool + args (15 min) |
| FHIR appointment tools | Disabled in the FHIR servers' tool lists and executors (`src/config/disabled-tools.ts`) |
| Identity gate | `verify_patient_identity` needs exact first name, last name and DOB, with exactly one match. It returns nothing (and no other patients) otherwise. |
| Redacted FHIR data | Marked `redacted`; the agent hears `RESTRICTED ...`, never "none on file" |
| Audit log hygiene | No request/response bodies in server logs (they held PHI and chart data) |
| Retell prompt | `retell-prompts/unity-healthcare-agent.md` merged with addendum 07. **Paste it into the Retell agent** and add the new custom functions. |
| After-hours + notebook (P1) | `drawbridge_get_call_mode`, `drawbridge_save_call_record`; notebook at `https://unity.veradigmai.com/oncall` (login). Needs SSM `/veradigm/oncall/username`, `password`, `session-secret`. |

## Still open (in order)

1. **Kanhaiya: push newer code** to a branch, if any exists. Then rebase this branch onto it.
2. **Renew the TLS cert and update the Unity credentials** (above). Then `npm run verify:sandbox` on a machine with `.env`.
3. **Set action names from the report.** For each pair where the reference name passes and the repo name fails, set `UNITY_ACTION_<KEY>`. Parameter layouts for `GetScheduleByPatientID`, `GetAllAvailableAppointments`, `SetAppointmentStatus` and `SaveTask` are **unverified** (Veradigm's reference lists names only). Check the report detail and adjust.
4. **Write actions by hand on a sandbox test appointment:** book, cancel (with a reason ID), confirm, staff task.
5. **Retell agent:** paste the prompt and register the new functions (`unity_get_cancellation_reasons`, `unity_get_account_balance`, `unity_get_insurance_policy`, `unity_create_staff_task`, `unity_get_appointment_details`, `unity_confirm_appointment`, `drawbridge_get_call_mode`, `drawbridge_save_call_record`). Remove the FHIR appointment functions.
6. **Deploy:** merge to `main` only with Ali's OK (it deploys). Then three phone runs per scenario.
7. **After the demo:** fix the `SearchPatients` Parameter1 format (audit §5); tighten `unity_search_patients` to exact name + DOB match server-side; move call records to the production DB (Q5/Q6).
