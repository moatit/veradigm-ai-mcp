# Connecting the Retell agent to the local Drawbridge platform

Base URL (dev): `https://drawbridge.moatit.dev`. It runs on Ali's workstation in Docker (`deploy/local`) behind a Cloudflare tunnel.

## Every custom function

| Setting | Value |
|---|---|
| Method | POST |
| URL | Veradigm PM / EHR tools and `drawbridge_*` tools: `https://drawbridge.moatit.dev/unity/api/retell`<br>Chart reads (FHIR tool names): `https://drawbridge.moatit.dev/fhir/api/retell` |
| Header | `x-drawbridge-key: <DRAWBRIDGE_TOOL_KEY from deploy/local/.env>` |
| Body | Retell's default `{ name, args, call }` |
| Speak after execution | On |

The server picks the tool from `name`, so every function on one server uses the same URL.

## Functions to register (inbound agent, test line 208-904-3641)

**`/unity/api/retell`**: `drawbridge_get_call_mode`, `drawbridge_save_call_record`, `unity_search_patients`, `unity_get_patient`, `unity_get_patient_appointments`, `unity_get_appointment_details`, `unity_get_open_slots`, `unity_get_appointment_types`, `unity_save_appointment`, `unity_get_cancellation_reasons`, `unity_cancel_appointment`, `unity_confirm_appointment`, `unity_get_account_balance`, `unity_get_insurance_policy`, `unity_create_staff_task`. Optional: `unity_get_patient_allergies`, `unity_get_patient_problems`, `unity_get_patient_medications`.

**`/fhir/api/retell`**: `verify_patient_identity`, `get_patient_medications`, `get_allergies`, `check_refill_status`, `get_patient_conditions`, `get_recent_observations`.

**Remove** from the agent: `create_appointment`, `get_upcoming_appointments`, `get_appointment_details` (FHIR), `check_appointment_status`, `find_patient_next_appointment`, `get_appointments_by_date_range`, `get_medication_statements`.

Each function's parameter schema is served at `GET /tools` inside each container. To print one:

```bash
docker exec drawbridge-dev-unity-1 node -e "fetch('http://localhost:3001/tools').then(r=>r.json()).then(j=>console.log(JSON.stringify(j.tools,null,2)))"
```

## Prompt

Paste `retell-prompts/unity-healthcare-agent.md` as the agent prompt.

## Staff app

`https://drawbridge.moatit.dev/app`. The login is `DRAWBRIDGE_USERNAME` / `DRAWBRIDGE_PASSWORD` in `deploy/local/.env`.

## Current state (Oct 8, 2026, night)

- Agent `drawbridge-healthcare-agent` (`agent_972b0d5df0a066741f4fe81cc8`, LLM `llm_6f0eb9c3edb1f2d62cb7fe5b02fe`) was created by `deploy/local/retell/build_agent.py` from the live tool list. It is published as v0.
- The test number (208) 904-3641 answers with it.
- **Rollback:** `PATCH https://api.retellai.com/update-phone-number/+12089043641` with `{"inbound_agents":[{"agent_id":"agent_050307fbc07b09d456a538fa44","agent_version":36,"weight":1}]}`. This is Kanhaiya's `unity-healthcare-agent`, which is unchanged.
- Cloudflare Bot Fight Mode is **off** on `moatit.dev`. With it on, Retell's server requests got a 403 challenge.
