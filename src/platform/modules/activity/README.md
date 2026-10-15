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

`retell-sdk` is not installed, and installing it needs network, so Drawbridge cannot use Retell's own `Retell.verify()` today. We did not reimplement Retell's signature scheme from memory. The endpoint accepts a request when either of these holds:

1. **Shared secret (works today).** `RETELL_WEBHOOK_SECRET` is set and the request carries the same value in the header `x-drawbridge-webhook-secret`. Nothing goes in the URL or query string.
2. **Retell signature (automatic once the SDK is installed).** `RETELL_API_KEY` is set, `retell-sdk` is installed (`npm i retell-sdk`), and `Retell.verify(rawBody, RETELL_API_KEY, x-retell-signature)` passes. No code change is needed. The module loads the SDK when it's present and checks the raw request body.

If neither is configured, the endpoint returns **503** and stores nothing. A failed check returns **401**.

**In Retell:** set the agent's (or account's) webhook URL to `https://drawbridge.moatit.dev/webhooks/retell`.
- If Retell lets you add a custom header to the webhook, add `x-drawbridge-webhook-secret: <RETELL_WEBHOOK_SECRET>`.
- If it doesn't, Retell can't pass the shared-secret check. Install `retell-sdk` and set `RETELL_API_KEY` (option 2), or have a relay you control add the header and post to `/api/activity/retell-events` with `x-drawbridge-key`.

Until one of these is set up, call events don't arrive. The audit log and the Activity tool-call screens still work, because they depend only on tool calls.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `AUDIT_DIR` | `CALL_RECORDS_DIR`, else `./data` | Base directory for `audit/*.jsonl` and `calls.json`. Both containers must point at the same volume (`/app/data` in `deploy/local`). |
| `AUDIT_RETENTION_DAYS` | `30` | Delete audit day files and calls-index entries older than this. |
| `RETELL_WEBHOOK_SECRET` | unset (webhook closed) | Shared secret expected in `x-drawbridge-webhook-secret`. |
| `RETELL_API_KEY` | unset | Used for `x-retell-signature` verification only when `retell-sdk` is installed. |
| `CLINIC_TIMEZONE` | `America/Boise` | Decides which day file a call lands in. Set it the same in both containers. |

Secrets go in `.env` only.

## Tests

`npm run smoke:activity` runs offline. It checks that audit lines carry no arguments or PHI, the metrics math, retention, webhook accept/reject (shared secret, and the SDK path with a stand-in verifier), that events update only existing records, and that the index holds no transcript, summary text or full phone numbers. The webhook route itself is exercised over 127.0.0.1.
