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

Secrets go in `.env` only.

## Tests

`npm run smoke:activity` runs offline. It checks that audit lines carry no arguments or PHI, the metrics math, retention, webhook accept/reject (shared secret, and the SDK path with a stand-in verifier), that events update only existing records, and that the index holds no transcript, summary text or full phone numbers. The webhook route itself is exercised over 127.0.0.1.
