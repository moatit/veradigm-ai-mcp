# Intake module (fax and document intake)

Staff-side add-on: documents faxed or dropped in by outside offices are read, matched to one patient and queued for staff. Design, hosting and safety rules: `docs/drawbridge/FAX_INTAKE_ADDON.md`. **Scaffold only. Nothing is filed to a chart on this branch.**

## What it does

| Piece | Where |
|---|---|
| Working store (`items.json` + `files/`, atomic writes, dedupe by source ref and SHA-256) | `store.ts`, `<CALL_RECORDS_DIR or /app/data>/intake/` |
| MOATiT Fax webhook `POST /webhooks/moatit-fax` + enterprise API client | `moatit-fax.ts`, `mountFaxWebhook(app)` in `src/unity/unity-test-server.ts` (before `express.json()`) |
| Drop folder watcher (every 30 s, PDF/TIFF/PNG/JPEG untouched for 10 s) | `folder.ts`, `INTAKE_DROP_DIR` |
| Field extraction (name, DOB, MRN, phone, sender, collection date, kind, abnormal flags) | `extract.ts` (pure, with confidences) |
| Patient match (two-identifier rule) | `match.ts` (`decideMatch` is the pure decision table) |
| Document type suggestion (`GetDocumentType`, cached 1 h) | `doctypes.ts` |
| Processing queue (fetch → read → match → type) | `pipeline.ts` |
| Filing guard (`SaveDocumentImage` is a TODO) | `file.ts` |
| Staff screens `/app/intake`, `/app/intake/item/:id`, upload | `index.ts` |

Lifecycle: `received → read → matched | needs_review | failed`. `filed` and `sent_to_indexing` exist in the model but nothing sets them yet.

### Webhook

MOATiT Fax signs every delivery: `X-Webhook-Signature: sha256=<hex HMAC-SHA256 of the raw body>` with the shared secret. Drawbridge checks the HMAC over the raw bytes in constant time **before** parsing. It accepts only `X-Webhook-Event: fax.received`, requires `X-Webhook-Id: fax:<job-id>:fax.received`, and records the item on disk before it answers.

| Response | When |
|---|---|
| 503 | `MOATIT_FAX_WEBHOOK_SECRET` unset |
| 401 | missing, malformed or wrong signature |
| 400 | other event, bad webhook ID, invalid JSON, body job ID ≠ header job ID |
| 204 | recorded, or a duplicate (same webhook ID or job ID, also after a restart) |

After the 204, the item is processed in the background: `GET /api/v1/enterprise/fax/{job}` (OCR text, sender), then `GET …/{job}/download`, with 15 s / 60 s timeouts and 3 attempts (network errors, 429, 5xx). While OCR is still running the item is re-checked every minute, up to 5 times. Unfinished items resume at startup. The response field names of the MOATiT Fax API aren't confirmed yet, so `parseFaxJob` tries several.

### Matching

`unity_search_patients` by last name, first name and DOB, through the same tool path as the phone agent (structured errors, audit). Outcomes:

- **auto** (`matched`): exactly one patient matches name + DOB **and** a second identifier agrees: the MRN, or the exact full name + DOB + the patient phone on the document.
- **review**: one match without a second identifier, a different MRN or phone on the document, or no EHR chart.
- **none / ambiguous**: no match, or more than one patient.
- **error** (`failed`): the search failed. A failed search is never treated as "no match".

### Filing (disabled)

`fileToChart` and `sendToIndexing` throw a structured error (`{ success:false, error_code, retryable }`):

- `FILING_DISABLED` unless `INTAKE_FILING` is `review` or `auto` **and** `INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED=true`
- `NOT_READY` / `ALREADY_FILED` for item problems
- `FILING_NOT_IMPLEMENTED` otherwise. The `SaveDocumentImage` call is a marked TODO in `file.ts`, because its parameter layout is unconfirmed.

The staff screen shows **File to chart** and **Send to indexing** disabled, with the reason. Every refused attempt is written to the item's history.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `MOATIT_FAX_WEBHOOK_SECRET` | unset (webhook closed) | HMAC key shared with MOATiT Fax |
| `MOATIT_FAX_BASE_URL` | unset | MOATiT Fax host (`/api/v1/enterprise` is appended) |
| `MOATIT_FAX_API_KEY` | unset | Bearer key with `fax:read` |
| `INTAKE_FILING` | `off` | `off` / `review` / `auto` |
| `INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED` | `false` | Set `true` only after the sandbox test filing approved by the owner |
| `INTAKE_DROP_DIR` | `/app/intake/inbox` | Drop folder (dev: `deploy/local/intake/inbox`, git-ignored) |
| `INTAKE_MAX_FILE_MB` | `25` | Larger files are not taken in |
| `INTAKE_RETENTION_DAYS` | `30` | Originals of filed items are deleted after this (the item and its history stay) |
| `CALL_RECORDS_DIR` | `/app/data` | Base of `intake/` |

Secrets go in `.env` only. Logs carry item IDs, job IDs, counts and error codes. They never carry keys, file names, document text or patient identifiers.

## Open TODOs

- `SaveDocumentImage` call, read-back with `GetDocuments`, then the `SaveTask` provider review task (after the format is confirmed and the owner approves a sandbox test).
- OCR for dropped and uploaded files without a text layer. Today they go to `needs_review`, or staff paste the text when they upload.
- Confirm the MOATiT Fax job and download response fields against the live API.
- Staff "pick a different patient" on the item screen.

## Tests

`npm run smoke:intake` runs offline with made-up patients. It covers HMAC good/bad/missing, the event allowlist, durable dedupe, the webhook and staff routes on 127.0.0.1, extraction on three synthetic documents, the match decision table, document-type mapping and cache, the pipeline with fake Veradigm and MOATiT Fax, the drop folder, the filing guard, screen wording, and logs without content.
