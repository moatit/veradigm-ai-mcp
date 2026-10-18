# Call analytics: what callers need, and how the calls end

Internal operations doc (it names the voice vendor; client-facing screens say "Voice"). Oct 18, 2026.

Drawbridge sends the MOATiT admin app **one minimum-necessary call analytics record per phone call, handled as PHI under the BAA**. The admin reports (Reports, Call Analytics) use it to show:
- the call reasons ranked;
- resolution and transfer rates;
- caller sentiment over time;
- repeat callers within 24 hours.

There's no vendor call ID, exact call time, transcript, summary text, phone number (full, partial or hashed) or patient ID in it.

**It is not de-identified under HIPAA Safe Harbor.** It keeps the date and hour of each call, and with the practice and call reason it could be linked back to a person by someone with access to the stack or the vendor. So the admin app must treat `call_records` as PHI: role-restricted reads, an audit trail, a retention period and encryption at rest (independent audit of Oct 18, 2026, finding M3). Calling it de-identified would need an Expert Determination.

To keep it minimal:
- the vendor call ID is replaced by a keyed hash under the stack-only key, so the admin app can update the same call but can't open it at the vendor;
- the start time is cut to the hour in clinic local time;
- every value is a fixed enum, boolean, count or pattern-checked ID.

```
Retell  ──call_ended / call_analyzed──▶  Drawbridge stack (per practice)  ──1 record per call──▶  admin app
         (verified webhook)              activity module:                    POST /api/call-records
                                          call-analytics.ts  builds it        (x-api-key, upsert by call reference)
                                          call-forwarder.ts  outbox + retry
```

## 1. Post-call analysis fields on the agent (vendor dashboard)

> **Don't change the live agent from this doc.** Add the fields to a new draft version, test it with web calls, and publish it only after the owner approves, like any other agent change (see `RETELL_SETUP.md` and `VOICE_V7_EXPERIMENT.md`). Until the fields exist, records still arrive. The analysis values in them are just empty, and the reports show them as "Not analyzed".

In the Retell dashboard, open the agent, then go to **Post-Call Analysis**.

1. **Built-in fields:** keep **Call Summary**, **User Sentiment** and **Call Successful** on.
   - Drawbridge reads `user_sentiment` (Positive / Neutral / Negative / Unknown) and `call_successful`.
   - Drawbridge never forwards `call_summary`. It's only attached to on-call notebook records inside the stack, as before.
2. **Add four data extraction fields.** The name must match exactly.

| Name | Type | Choices | Description to paste (it guides the analysis model) |
|---|---|---|---|
| `call_reason` | Selector | `appointment_new`, `appointment_change`, `appointment_cancel`, `appointment_confirm`, `prescription_refill`, `test_results`, `billing_insurance`, `records_forms`, `referral`, `clinical_question`, `message_for_staff`, `office_info`, `wrong_number`, `other` | The main reason the caller called, as one choice. If there were several, pick the one the caller cared about most. Never write names, dates of birth or other details. |
| `request_category` | Selector | `question`, `action_request`, `problem`, `follow_up`, `urgent`, `other` | What kind of request it was: a question; a request for the clinic to do something; a problem or complaint (something went wrong for the caller); a follow-up on an earlier call or visit; or urgent (a symptom or safety concern). |
| `resolved` | Boolean | n/a | True if the caller's main need was fully handled during this call, without staff having to call back. |
| `transferred_to_staff` | Boolean | n/a | True if the call was transferred to a person, or a staff task or message was created so a person follows up. |

3. **Analysis model:** leave it at the account default. That model already processes the transcript under the vendor BAA, and adding fields sends nothing new outside the vendor.
4. **Webhook events:** the agent's or account's webhook (`https://<stack host>/webhooks/retell`) must include `call_analyzed`. Today it includes `call_started` and `call_ended` too, and verification is unchanged; see `src/platform/modules/activity/README.md`.

**Do not add Text-type fields** for analytics. Drawbridge only accepts the choices above. Any other value becomes `other` for the two selectors and empty for anything else, and unknown fields are ignored. That way, a free-text field added later can never carry PHI into the admin app.

### Same configuration through the API (reference only)

`post_call_analysis_data` on the agent (`PATCH /update-agent/<agent_id>`, which creates a new draft version):

```json
[
  { "type": "enum", "name": "call_reason", "description": "<as above>",
    "choices": ["appointment_new","appointment_change","appointment_cancel","appointment_confirm","prescription_refill","test_results","billing_insurance","records_forms","referral","clinical_question","message_for_staff","office_info","wrong_number","other"] },
  { "type": "enum", "name": "request_category", "description": "<as above>",
    "choices": ["question","action_request","problem","follow_up","urgent","other"] },
  { "type": "boolean", "name": "resolved", "description": "<as above>" },
  { "type": "boolean", "name": "transferred_to_staff", "description": "<as above>" }
]
```

The values come back in `call.call_analysis.custom_analysis_data`.

## 2. The record

Built by `buildCallRecord()` in `src/platform/modules/activity/call-analytics.ts`. It's an allow-list: each field is copied by name and checked.

| Field | From | Notes |
|---|---|---|
| `schema` | constant `1` | |
| `call_id` | `call.call_id` | **Not the vendor ID:** `"cr_"` + the first 32 hex characters of `HMAC-SHA256(CALL_ANALYTICS_HASH_KEY, "drawbridge-call\|" + vendor call ID)`. It's the same for every event of a call, so the admin app can upsert. Without the stack key it can't be turned back into the vendor ID. To look a call up in the stack, compute `callRef(<vendor call ID>)` there. |
| `practice_id` | `DRAWBRIDGE_PRACTICE_ID` | Lowercase slug, for example `sagebrush-kidney`. |
| `agent_id`, `agent_version` | `call.agent_id`, `call.agent_version` | For comparing prompt versions. `agent_id` must match `^agent_[0-9a-f]{16,40}$` (the vendor's format is `agent_` + 26 hex today), otherwise it's sent empty. |
| `started_at` | `start_timestamp` | **The start of the hour** in clinic local time (`CLINIC_TIMEZONE`), with its offset, for example `2026-10-14T10:00:00-06:00`. The exact time stays in the stack. |
| `duration_s` | `duration_ms` | Seconds. |
| `direction` | `call_type` / `direction` | `inbound`, `outbound` or `web`. |
| `disconnection_reason` | `disconnection_reason` | One of the vendor's documented reasons (`DISCONNECTION_REASONS` in `call-analytics.ts`, for example `user_hangup` or `call_transfer`), `other` for anything else, or empty. Check the list against the vendor's API reference when it adds reasons. |
| `analyzed` | event | True only on `call_analyzed`. |
| `call_reason`, `request_category` | custom analysis | Enums (section 1). |
| `resolved`, `transferred_to_staff` | custom analysis | Booleans. A `call_transfer` disconnection counts as transferred when the field is empty. |
| `caller_sentiment`, `call_successful`, `in_voicemail` | built-in analysis | |
| `prior_calls_24h`, `prior_calls_7d` | caller history in the stack | Earlier inbound calls from the same number. `null` for outbound and web calls. |
| `tools` | this stack's audit log | `[{ name, calls, failed }]`: tool calls made on this call ID. No arguments or results. Names must match `^[a-z][a-z0-9_]{0,48}$` (every registered tool does); others are left out. |

The admin app pins the same formats (`call_id` `^cr_[0-9a-f]{32}$`; `started_at` `^\d{4}-\d{2}-\d{2}T\d{2}:00:00[+-]\d{2}:\d{2}$`). A record that doesn't match there gets a 400 and is dropped by the forwarder, so change both sides together.

### Repeat callers stay in the stack

The admin app never gets a number or a hash of one. When a record is built, the stack:
1. computes `HMAC-SHA256(key, "drawbridge-caller|" + digits)`, keeping the first 32 hex characters;
2. writes that value and the start time to `<AUDIT_DIR>/caller-history.json` (mode 0600, entries kept 8 days and pruned daily);
3. sends only the two counts.

The key is `CALL_ANALYTICS_HASH_KEY`, which also keys the call reference.
- **Production** (`NODE_ENV=production`): set it from the secret store (SSM), 32+ characters. Without it, forwarding refuses to start and logs `call analytics forwarding refused: hash key required in production`. No key file is ever generated there, because a key next to the hashes would let anyone with the volume brute-force the numbers.
- **Outside production:** when it's empty, a random key is generated once into `<AUDIT_DIR>/caller-history.key` (0600).

A new key restarts the repeat counts (they are counted from zero for up to 7 days) and gives every call a new reference. Records already in the admin app keep their old reference, so a call in flight during the change could appear twice.

All private files (`caller-history.json`, `caller-history.key`, `call-records-outbox.json`) are written through a fresh temp file opened exclusively with mode 0600, chmod 0600 whatever the umask, then renamed. New directories are created 0700.

## 3. Forwarding

`src/platform/modules/activity/call-forwarder.ts`:
- **Trigger:** on `call_ended` and `call_analyzed`, after the webhook has answered 204. It's never on the request path.
- **Outbox:** `<AUDIT_DIR>/call-records-outbox.json` (0600), one entry per call reference. A later event replaces the queued snapshot.
- **Send:** `POST ${ADMIN_PORTAL_URL}/api/call-records` with `x-api-key: ADMIN_API_KEY` (the stack's admin client key, the same one the tool-call logs use).
- **Retry:** every minute for anything due. Backoff starts at 30 s and doubles up to 1 h. A record is dropped after 7 days, or right away if the admin app rejects it with any 4xx other than 401, 408 or 429.
- **Transport:** `https`. Plain `http` is allowed only to loopback (`localhost`, `127.0.0.1`, `::1`) and to host names listed exactly in `CALL_ANALYTICS_HTTP_HOSTS`, for example `admin` for `http://admin:5001` in `deploy/local`. A single-label name isn't trusted on its own, because a DNS search domain can resolve it outside the stack.

| Variable | Default | Purpose |
|---|---|---|
| `CALL_ANALYTICS_FORWARD` | off | `on` turns forwarding on. |
| `ADMIN_PORTAL_URL` | unset | Admin app base URL (already used for tool-call logs). |
| `ADMIN_API_KEY` | unset | The stack's admin client key. |
| `DRAWBRIDGE_PRACTICE_ID` | empty | Practice slug on each record. |
| `CALL_ANALYTICS_HASH_KEY` | required in production; generated elsewhere | Key for the repeat-caller hash and the call reference. It stays in the stack; in production it comes from the secret store. |
| `CALL_ANALYTICS_HTTP_HOSTS` | empty | Host names allowed over plain http besides loopback, comma separated. Use it only for a container network you control. |

The admin app side (`veradigmai-repo`):
- the `call_records` table;
- `POST /api/call-records`: a strict schema, so unknown fields are a 400; upsert by `call_id` (the call reference);
- `GET /api/reports/call-analytics`: needs a signed-in session. It is PHI, so reads should be role-restricted and audited (M3; for the admin-dashboard audit to confirm).

## 4. Tests

`npm run smoke:call-records` runs offline with synthetic data. It checks:
- the record carries only allow-listed fields, even when the transcript, summary, dynamic variables and a free-text custom field hold synthetic PHI;
- the call reference in place of the vendor call ID, and the start hour in clinic local time (including a half-hour offset and DST);
- enum enforcement, including the disconnection reason allow-list;
- tools from the audit log;
- repeat counts (idempotent per call; null for outbound and web);
- the history holds no numbers;
- forwarding is off by default;
- https, or http only to loopback and `CALL_ANALYTICS_HTTP_HOSTS`;
- production without `CALL_ANALYTICS_HASH_KEY`: no forwarding, no generated key file, no record;
- private files stay 0600 over a stale 0644 temp file, and new directories are 0700. These mode assertions run on Linux; on Windows they are skipped, and the run says so;
- outbox, retry and drop behavior against a stub admin app on 127.0.0.1;
- the verified webhook end to end.

## 5. Not built yet

See `CALL_ANALYTICS_OPTIONS.md`: a post-call satisfaction question, and a PHI-safe transcript store.
