# Sandbox endpoints and test data

All patients below are **Veradigm sandbox test records, not real people.** No credentials are in this folder. They live in the `.env` on Ali's and Kanaya's machines and in AWS SSM (`/veradigm/*`) for the deployed servers.

## Endpoints

| What | Value | Source |
|---|---|---|
| Unity (sandbox) | `https://ubiquityunity.azurewebsites.net/UnityService.svc/json/` (`GetToken`, `MagicJson`, `RetireToken`) | Kanaya, Oct 8 email; repo `unity-endpoints.ts` |
| FHIR (sandbox, current) | `https://scmlatestdev.open.allscripts.com/FHIR` | Kanaya, Oct 8 email |
| FHIR capability statement | `GET [base]/metadata` | Veradigm FHIR docs |
| FHIR endpoint directory | `https://open.platform.veradigm.com/fhirendpoints` | Veradigm FHIR docs |
| Deployed Drawbridge (AWS) | `fhir.veradigmai.com`, `unity.veradigmai.com`, `admin.veradigmai.com` | repo `infra/nginx/default.conf` |
| Test phone line | (208) 904-3641 | Ali |

## Test patients (from Ali's "Test info" email, Oct 8, 2026)

**Unity sandbox** (use for scheduling, demographics, billing, staff tasks):

| Name | DOB | Patient ID | MRN |
|---|---|---|---|
| Ed Smith | 12/06/1952 | 56500 | 56500 |
| Nichole Albanese | 04/24/1928 | 29700 | 29700 |

**FHIR sandbox** (use for chart reads: meds, allergies, conditions, observations):

| Name | DOB | Patient ID |
|---|---|---|
| John Smith | 1980-01-15 | (look up by name + DOB) |
| Smith (no first name given) | 1990-01-01 | 69006 |

**The two sandboxes hold different patients.** A Unity patient won't be found by a FHIR lookup, and the other way round. Pick the demo patient by the system the flow uses.

## Environment variables (names only; from `.env.example`)

```
# FHIR server (port 3000)
CLIENT_ID, CLIENT_SECRET, FHIR_BASE_URL_SANDBOX, AUTH_URL_SANDBOX, TOKEN_URL_SANDBOX,
MCP_SERVER_PORT, MCP_SERVER_HOST, TOKEN_CACHE_TTL, CACHE_ENABLED, LOG_LEVEL
# Unity server (port 3001)
UNITY_APP_NAME, UNITY_SVC_USERNAME, UNITY_SVC_PASSWORD, UNITY_EHR_USERNAME, UNITY_EHR_PASSWORD,
UNITY_UBIQUITY_ENDPOINT, UNITY_UBIQUITY_ID_PM, UNITY_UBIQUITY_ID_EHR,
UNITY_TOKEN_CACHE_TTL, UNITY_TOKEN_REFRESH_BUFFER, UNITY_MCP_SERVER_PORT, UNITY_MCP_SERVER_HOST
# Admin portal (port 5001)
DB_PASSWORD, NEXTAUTH_URL, NEXTAUTH_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_API_KEY, MCP_CHANNEL
```

The verification script (`scripts/verify-sandbox.ts`) adds these, all optional:

```
VERIFY_UNITY_PATIENT_ID=56500        # Ed Smith
VERIFY_UNITY_LAST=Smith  VERIFY_UNITY_FIRST=Ed  VERIFY_UNITY_DOB=12/06/1952
VERIFY_FHIR_FAMILY=Smith  VERIFY_FHIR_GIVEN=John  VERIFY_FHIR_BIRTHDATE=1980-01-15
VERIFY_APPOINTMENT_ID=               # set to test GetAppointmentById / cancel (with --writes)
```
