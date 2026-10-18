# Activity module

Audit log (build spec §4 rule 8), Retell call events, and the staff Activity screens.

## What it does

| Piece | Where |
|---|---|
| Audit store, shared by both servers | `src/platform/audit.ts` |
| Hook: Veradigm® PM/EHR tool calls | `executeTool` in `src/unity/unity-test-server.ts` |
| Hook: Veradigm® EHR (read-only) tool calls | `executeFhirTool` in `src/test-server.ts` (covers `/`, `/api/retell`, `/tools/call`, `/mcp/tools/call`) |
| Retell webhook | `POST /webhooks/retell` (`mountRetellWebhook(app)`, mounted before `express.json()`) |
| Same events behind the tool key (relay / tests) | `POST /api/activity/retell-events` with `x-drawbridge-key` |
| Staff screens | `/app/activity` (tool calls and per-tool metrics for a day), `/app/activity/calls` (recent calls) |

### Audit log

One JSON line per tool call in `<AUDIT_DIR>/audit/YYYY-MM-DD.jsonl` (clinic-local day, file mode 0600):

```
{"ts","server":"unity|fhir","call_id","tool","patient_id","success","error_code","latency_ms","channel"}
```

`patient_id` is filled only from a `patientId` / `patient` argument that looks like a plain ID. Arguments, results, names, birth dates and chart contents are never written. Writes are queued and async. A failed write logs one warning and never reaches the request path. Day files older than `AUDIT_RETENTION_DAYS` are deleted at startup and at the first write of each day.

### Retell call events

Handles `call_started`, `call_ended` and `call_analyzed` (other events get a 204 and are ignored):

- Calls index `<AUDIT_DIR>/calls.json`: call ID, start, end, direction, last 4 digits of the from/to numbers, agent ID, disconnection reason, and whether a summary exists. It is trimmed to the retention window and a maximum of 5,000 calls.
- On-call notebook: **only if a record for that call ID already exists**, the module sets `transcript_ref: "retell:<call_id>"` and `call_meta` (end time, duration, disconnection reason, `call_analysis.call_summary` cut to 1,000 characters). Events never create records.
- Transcripts are never stored. They stay in Retell.

### Call analytics records (admin app)

When `CALL_ANALYTICS_FORWARD=on`, `call_ended` and `call_analyzed` also queue **one minimum-necessary call analytics record per call** for the admin app (`POST ${ADMIN_PORTAL_URL}/api/call-records`, `x-api-key: ADMIN_API_KEY`). It is **handled as PHI under the BAA**; it isn't Safe Harbor de-identified. The record holds:
- a call reference (keyed hash of the vendor call ID), practice ID, agent version, the start hour in clinic local time, duration, direction, disconnection reason (documented list, else `other`);
- the post-call analysis enums (call reason, request category, resolved, transferred, sentiment, call successful);
- repeat-caller counts computed in this stack;
- the tools used, with call and failure counts.

It never holds the vendor call ID, an exact start time, a transcript, summary text, a phone number or a patient ID. Records wait in an outbox (`<AUDIT_DIR>/call-records-outbox.json`, 0600) and are retried. The repeat-caller history (`caller-history.json`, keyed hashes only, 8 days) never leaves the stack.

- Code: `call-analytics.ts` (the allow-listed record), `call-forwarder.ts` (outbox and retry).
- Setup, including the analysis fields to add on the agent: `docs/drawbridge/CALL_ANALYTICS.md`.

## Webhook verification: what to configure

Both Retell webhooks (`/webhooks/retell` call events and `/webhooks/retell-inbound`) use the same check (`retell-signature.ts`, Retell's documented scheme, no SDK needed). A request is accepted when either of these holds:

1. **Retell signature.** `x-retell-signature: v=<ms timestamp>,d=<hex>` where the digest is HMAC-SHA256 of the raw request body followed by the timestamp, keyed with the Retell API key that has the **"webhook" badge** (Retell dashboard, Settings, API Keys). Retell signs webhooks only with that key, and it may not be the key in `RETELL_API_KEY`. Set it as `RETELL_WEBHOOK_API_KEY`. When that is unset, `RETELL_API_KEY` is used. The timestamp must be within 5 minutes, the digest is compared in constant time, and it is computed over the exact bytes received (`express.raw` on the route, mounted before the app-wide JSON parser), never over re-serialized JSON.
2. **Shared secret (relays and tests).** `RETELL_WEBHOOK_SECRET` is set and the request carries the same value in the header `x-drawbridge-webhook-secret`. Nothing goes in the URL or query string.

If neither is configured, the endpoint returns **503** and stores nothing. A failed check returns **401** (body `{"error":"bad signature"}`), records a `webhook_rejected` security event, and logs the reason on the server: `missing signature`, `bad signature format`, `stale timestamp (Ns off)`, `digest mismatch (verified with RETELL_API_KEY | RETELL_WEBHOOK_API_KEY)` or `shared secret mismatch`. The key, the signature and the body are never logged. A `digest mismatch` with a fresh timestamp almost always means the wrong key: put the webhook-badged key in `RETELL_WEBHOOK_API_KEY`.

**In Retell:** set the agent's (or account's) webhook URL to `https://drawbridge.moatit.dev/webhooks/retell`. Alternatively, have a relay you control post to `/api/activity/retell-events` with `x-drawbridge-key`.

Until one of these is set up, call events don't arrive. The audit log and the Activity tool-call screens still work, because they depend only on tool calls.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `AUDIT_DIR` | `CALL_RECORDS_DIR`, else `./data` | Base directory for `audit/*.jsonl` and `calls.json`. Both containers must point at the same volume (`/app/data` in `deploy/local`). |
| `AUDIT_RETENTION_DAYS` | `2190` (6 years) | Delete audit day files and calls-index entries older than this. |
| `RETELL_WEBHOOK_API_KEY` | unset (falls back to `RETELL_API_KEY`) | The Retell API key with the "webhook" badge (Retell dashboard, Settings, API Keys). Verifies `x-retell-signature` on both Retell webhooks. |
| `RETELL_API_KEY` | unset | Retell API calls (outbound dialer). Verifies webhooks only when `RETELL_WEBHOOK_API_KEY` is unset. |
| `RETELL_WEBHOOK_SECRET` | unset | Optional shared secret expected in `x-drawbridge-webhook-secret` (relays, tests). |
| `CLINIC_TIMEZONE` | `America/Boise` | Decides which day file a call lands in. Set it the same in both containers. |

| `CALL_ANALYTICS_FORWARD` | off | `on` sends call analytics records to the admin app (`docs/drawbridge/CALL_ANALYTICS.md`). |
| `DRAWBRIDGE_PRACTICE_ID` | empty | Practice slug on each call analytics record. |
| `CALL_ANALYTICS_HASH_KEY` | required in production; generated into `AUDIT_DIR` elsewhere | Key for the repeat-caller hash and the call reference. It stays in this stack. In production, set it from the secret store; without it forwarding refuses to start. |
| `CALL_ANALYTICS_HTTP_HOSTS` | empty | Host names allowed over plain http besides loopback (for example `admin`). |

Secrets go in `.env` only.

## Tests

`npm run smoke:activity` runs offline. It checks that audit lines carry no arguments or PHI, the metrics math, retention, webhook accept/reject (shared secret, and the SDK path with a stand-in verifier), that events update only existing records, and that the index holds no transcript, summary text or full phone numbers. The webhook route itself is exercised over 127.0.0.1.

`npm run smoke:call-records` (also offline) checks the call analytics record and the forwarder; see `docs/drawbridge/CALL_ANALYTICS.md`.
