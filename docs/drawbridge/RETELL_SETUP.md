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

**`/unity/api/retell`**: `drawbridge_get_call_mode`, `drawbridge_save_call_record`, `drawbridge_take_message` (v7), `unity_search_patients`, `unity_get_patient`, `unity_get_patient_appointments`, `unity_get_appointment_details`, `unity_get_open_slots`, `unity_get_appointment_types`, `unity_save_appointment`, `unity_get_cancellation_reasons`, `unity_cancel_appointment`, `unity_confirm_appointment`, `unity_get_account_balance`, `unity_get_insurance_policy`, `unity_create_staff_task`. Optional: `unity_get_patient_allergies`, `unity_get_patient_problems`, `unity_get_patient_medications`.

**`/fhir/api/retell`**: `verify_patient_identity`, `get_patient_medications`, `get_allergies`, `check_refill_status`, `get_patient_conditions`, `get_recent_observations`.

**Remove** from the agent: `create_appointment`, `get_upcoming_appointments`, `get_appointment_details` (FHIR), `check_appointment_status`, `find_patient_next_appointment`, `get_appointments_by_date_range`, `get_medication_statements`.

Each function's parameter schema is served at `GET /tools` inside each container. To print one:

```bash
docker exec drawbridge-dev-unity-1 node -e "fetch('http://localhost:3001/tools').then(r=>r.json()).then(j=>console.log(JSON.stringify(j.tools,null,2)))"
```

## Prompt

Paste `retell-prompts/unity-healthcare-agent.md` as the agent prompt. Since v7 it is trimmed (about 6k characters) and uses the dynamic variables `{{call_mode}}`, `{{records_status}}`, `{{fhir_tools}}` plus Retell's `{{current_time_America/Boise}}` and `{{call_type}}`. Set the LLM's `default_dynamic_variables` to `call_mode=UNKNOWN`, `records_status=UNKNOWN`, `fhir_tools=OFF` so a call without the webhook still works (the agent then calls `drawbridge_get_call_mode`).

## v7 agents (Oct 15, 2026, not published)

`python deploy/local/retell/build_v7.py` creates or updates two test agents from the code: the compact tool list (`src/platform/agent-tools.ts`, about 8.7k characters for 28 custom functions instead of 16k), static fillers on lookups (`speak_during_execution`, `execution_message_type: static_text`), `timeout_ms` 8000, backchannel on, no ambient sound, medical vocabulary, and the live agent's PII redaction, signed URLs, data storage and 30-day retention. IDs are in `deploy/local/retell/v7-agents.json`. Results and the publish / rollback steps: `docs/drawbridge/VOICE_V7_EXPERIMENT.md`.

## Inbound-call webhook (call mode at call start)

Set the number's **Inbound Webhook URL** to `https://drawbridge.moatit.dev/webhooks/retell-inbound` (Phone Numbers in the Retell dashboard, or `PATCH /update-phone-number/<number>` with `inbound_webhook_url`). Retell signs the request with the account API key (`x-retell-signature`); Drawbridge verifies it with `RETELL_API_KEY`. The answer is `{ call_inbound: { dynamic_variables: { call_mode, records_status, fhir_tools } } }` and the Veradigm sessions are warmed for the call. If Drawbridge doesn't answer within Retell's 10 s, Retell still connects the call and the defaults apply. Web calls pass the same variables in `retell_llm_dynamic_variables` of `POST /v2/create-web-call`.

## Retell API (current endpoints only)

Use `deploy/local/retell/retell_api.py` (versions, publish, phone-numbers, llms, calls) instead of ad-hoc curl. Retell retired the legacy endpoints and warned us on Oct 12, 2026 after one-off demo scripts used them:

| Retired | Use |
|---|---|
| `POST /publish-agent/{id}`, `POST /publish-chat-agent/{id}` | `POST /publish-agent-version/{id}` with `{"version": N}` |
| `GET /get-agent-versions/{id}`, `GET /get-chat-agent-versions/{id}` | `GET /list-agent-versions/{id}` (paged) |
| `POST /v2/list-calls` | `POST /v3/list-calls` (paged, up to 1,000 per page, `include_total`; no transcripts, GET the call for those) |
| `GET /list-phone-numbers`, `/list-retell-llms`, `/list-conversation-flows`, ... | `GET /v2/list-...` (paged) |
| `analysis_*_prompt` agent fields | `system-presets` entries in `post_call_analysis_data` (both agents already use them) |

Paged responses are `{ items, has_more, pagination_key }`, not a bare array. Drawbridge's own code uses only `POST /v2/create-phone-call` (outreach dialer), which is current.

## Staff app

`https://drawbridge.moatit.dev/app`. Named logins with an authenticator code, one line per person in `deploy/local/secrets/drawbridge-users` (`npm run staff:user -- <name> --totp`, `DRAWBRIDGE_USERS_FILE` in `deploy/local/.env`). The shared `DRAWBRIDGE_USERNAME` / `DRAWBRIDGE_PASSWORD` login works only with `DRAWBRIDGE_REQUIRE_TOTP=off` for local development.

## Current state (Oct 8, 2026, night)

- Agent `drawbridge-healthcare-agent` (`agent_972b0d5df0a066741f4fe81cc8`, LLM `llm_6f0eb9c3edb1f2d62cb7fe5b02fe`) was created by `deploy/local/retell/build_agent.py` from the live tool list. It is published as v0.
- The test number (208) 904-3641 answers with it.
- **Rollback:** `PATCH https://api.retellai.com/update-phone-number/+12089043641` with `{"inbound_agents":[{"agent_id":"agent_050307fbc07b09d456a538fa44","agent_version":36,"weight":1}]}`. This is Kanhaiya's `unity-healthcare-agent`, which is unchanged.
- Cloudflare Bot Fight Mode is **off** on `moatit.dev`. With it on, Retell's server requests got a 403 challenge.
