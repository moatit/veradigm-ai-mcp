# Intake module (fax and document intake)

Staff-side add-on: documents faxed or dropped in by outside offices are read, matched to one patient and queued for staff. Design, hosting and safety rules: `docs/drawbridge/FAX_INTAKE_ADDON.md`. Filing to the chart is built and off by default (`INTAKE_FILING=off`). Batch faxes with several patients are split into one document per patient.

## What it does

| Piece | Where |
|---|---|
| Working store (`items.json` + `files/`, atomic writes, dedupe by source ref and SHA-256) | `store.ts`, `<CALL_RECORDS_DIR or /app/data>/intake/` |
| MOATiT Fax webhook `POST /webhooks/moatit-fax` + enterprise API client | `moatit-fax.ts`, `mountFaxWebhook(app)` in `src/unity/unity-test-server.ts` (before `express.json()`) |
| Drop folder watcher (every 30 s, PDF/TIFF/PNG/JPEG untouched for 10 s) | `folder.ts`, `INTAKE_DROP_DIR` |
| Field extraction (name, DOB, MRN, phone, sender, collection date, kind, abnormal flags; the value read most often across pages wins) | `extract.ts` (pure, with confidences) |
| Sender templates (a frequent sender's labels, name order, date formats, MRN pattern) | `templates.ts`, JSON in `deploy/ocr/templates/` (`INTAKE_SENDER_TEMPLATES_DIR`) |
| Per-page check and split plan (which patient each page belongs to; batch senders) | `pages.ts` (pure) |
| Patient match (two-identifier rule; optional name + DOB rule, off by default) | `match.ts` (`decideMatch` is the pure decision table) |
| Document type suggestion (`GetDocumentType`, cached 1 h) | `doctypes.ts` |
| Local OCR for files without text (Tesseract 5 container, no outside service) | `ocr.ts` → `deploy/ocr` (`ocr` service, `INTAKE_OCR_URL`) |
| Processing queue (fetch → read/OCR → pages/split → match → type → auto-file) | `pipeline.ts` |
| Filing guard (`SaveDocumentImage` is a TODO) | `file.ts` |
| Clinic rules: documents always to a person, critical results, who gets the review task, same-day appointments | `rules.ts` (settings, pure), `notify.ts` (`GetProviders`, `GetScheduleByPatientID`, read-only; the task's plan) |
| Staff screens `/app/intake`, `/app/intake/item/:id`, upload | `index.ts` |

Lifecycle: `received → read → split | matched | needs_review | failed → filed | sent_to_indexing` (a failed OCR, split or search is `failed` with its code; staff can retry). `split`: the file showed several patients and was cut into one part per patient; the parent is never filed, each part is its own item.

### Pages, batch senders and splitting

Text is kept per page: the OCR container returns `page_texts` and `page_confidences` (and `text` joined with form feeds, as before); a PDF text layer is split at pdftotext's form feeds; MOATiT Fax `ocr.raw_text` "--- Page N ---" markers become form feeds (`parseFaxJob`, which now also reads `ocr.raw_text` and `page_count`).

`pages.ts` runs for a batch sender (`INTAKE_BATCH_SENDERS`: part of the name in the extracted sender or anywhere in the text, or the sending fax number) and for any document naming more than one patient. Each page is read with `extractFields`; a page identifies a patient with name + DOB or an MRN. Cover sheets before the first patient page are left out. Continuation pages (no identifier) go with the patient before them, except for batch senders, where any page without a full identifier sends the file to staff. Identifiers are compared exactly; near-equal ones (OCR noise or similar patients) send the file to staff, except the same MRN read exactly. Other review triggers: two patients on a page, non-contiguous pages, results above a page's patient line or a ruled-off block of results without one, page-count mismatch, a part that still names two patients. Every review carries a staff-readable reason.

Split (`pipeline.ts` `splitFile`): `OcrClient.extractPages` → `POST /pages?select=…` on the OCR container cuts each part (same format; `X-Source-Pages` must equal the text's page count). Parts are created only after every cut succeeded (`IntakeStore.addPart`, keyed `split:<parent>:p<pages>`, so re-processing reuses them), carry their pages' text and OCR confidence (`partOcr`), `parent_id` and `part {index, of, pages}`, and get a passed `pages_check`. Then each part runs through match, `suggest(kind, subtype)` and the auto-file gate on its own. The parent gets `status: 'split'` and `split {children, pages, cover_pages}`.

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

- **auto** (`matched`): exactly one patient matches name + DOB **and** a second identifier agrees: the MRN (the PM MRN **or** the EHR chart MRN / PatientNumber), or the exact full name + DOB + the patient phone, SSN last 4 or address on the document.
- **review**: one match without a second identifier, an MRN that equals neither of the patient's MRNs, a different phone, an SSN last 4 or address that differs from the patient's record (also when the MRN agrees), an MRN label whose value OCR couldn't read (the phone never stands in for it), no EHR chart, or OCR text below `INTAKE_OCR_MIN_CONFIDENCE` (the candidate is shown, never auto-matched).
- **Third identifier** (MOATiT standard, Oct 11, 2026): the SSN's last 4 (`***-**-1234`, `XXX-XX-1234`, `SSN Last 4: 1234`; a full SSN is read for its last 4 only and masked in the stored text) and the patient's address (labelled, or a street line under the patient with city, state and ZIP) are read with confidences. Whenever the document carries one and the patient's record has one, it is checked: disagreeing sends the document to staff; agreeing is recorded (`third_identifier`) and shown on the item. Address agrees on street number + ZIP or street number + street name (St/Street, Ave/Avenue, N/North, Apt/# ignored). A record without one (Veradigm® search returns the SSN blank) leaves it unchecked: an MRN, phone or the other third identifier still confirms the match, but name + DOB alone never file over an SSN or address that couldn't be checked or read.
- **Name + DOB rule** `INTAKE_MATCH_RULE=name_dob` (the MOATiT standard; deployments set it; unset = the stricter default above): a document with **no MRN or patient phone at all** may also be **auto** when the exact full name (under an explicit patient label) and DOB match exactly one patient, every read of them on the document agrees, no other patient has a similar name (one edit, Soundex, first-name prefix, swapped, or the same last name) with the same DOB or one a digit off, no MRN label or MRN- or phone-like number near the patient went unread, and the OCR gate passes. Two wider searches back this check (same DOB by the last name's first two letters; the last name at any DOB), through the same search path as the match (Veradigm® or the local patient list, `INTAKE_ROSTER_CSV`); a failed one is an error. The match records `rule: 'name_dob'`. Nothing the default rule files, rejects or calls ambiguous changes.
- **none / ambiguous**: no match; more than one patient matches; or the document itself names more than one patient (a daily batch report, two patients' results in one fax). Such a document is split into one part per patient when its pages allow it (above); otherwise staff split it.
- **error** (`failed`): the search failed. A failed search is never treated as "no match".

### Filing

`file.ts`: `SaveScanDocument` (+ a linked `SaveTask` review task when `INTAKE_REVIEW_USER` is set), verified on the sandbox Oct 11. Refusals are structured (`{ success:false, error_code, retryable }`): `FILING_DISABLED` unless `INTAKE_FILING` is `review` or `auto` **and** `INTAKE_SAVE_DOCUMENT_FORMAT_CONFIRMED=true`; `NOT_READY` (including a `split` parent: file its parts) / `ALREADY_FILED`; `FILING_REJECTED` / `FILING_UNCERTAIN` from Veradigm® EHR. Auto-filing (`autoFileBlocker` in `pipeline.ts`) also needs a specific chart category, a passed page check for batch senders, no `duplicate_of`, and a sender outside `INTAKE_NO_AUTO_SENDERS`. Every refused attempt is written to the item's history.

## Shadow mode (measure on real documents, file nothing)

`INTAKE_MODE=shadow` runs the whole pipeline on real documents (OCR, pages and split, extract, match, category) and records on each item what it **would** have done (`shadow`: auto-file to which patient under which category, or why staff, as a stable reason code). Filing is impossible whatever `INTAKE_FILING` says: `file.ts` refuses, the pipeline stops before the filing step, and every Veradigm® call goes through an allowlist of reads (`shadow.ts`: `SearchPatients`, `GetDocumentType`, `GetDocuments`, `GetDocumentsByDocumentType`, `GetDocumentImage`). The data-center deployment runs it as its own server (`src/platform/shadow-server.ts`, `deploy/datacenter/README.md`).

| Piece | Where |
|---|---|
| Mode, read-only guards, decision, ground truth, agreement | `shadow.ts` |
| Optional local patient list instead of the live search (`INTAKE_ROSTER_CSV`; same result shape, same `decideMatch`, a missing list is an error) | `roster.ts` |
| Category list as fallback to `GetDocumentType` (`INTAKE_CATEGORIES_CSV`) | `doctypes.ts` `CsvDocTypes`, `FallbackDocTypes` |
| Staff filing observer: the "(ready for indexing)" queue tracked by DocumentID; where staff indexed each fax = ground truth | `observe.ts` |
| Confirm panel (fallback ground truth) and queue filters | `shadow-ui.ts` |
| Report (counts only) and the per-document staff file | `shadow-report.ts`, `npm run eval:shadow` |
| Read-in-place folders (Express Lab) | `folder.ts` `INTAKE_WATCH_DIRS` |
| Bulk import of old faxes | `npm run intake:import` |

**Ground truth**, per unit (a whole document or a split part), in order: a staff confirmation on the Confirm panel; where staff were seen to file it in Veradigm® EHR (observer, high or medium confidence); the whole file's confirmation. A unit with none is unconfirmed and never counted as correct. The observer links a queue document to an intake item by arrival time (SortDate in the clinic's zone), equal page count and sender, and on a tie by the file itself (same bytes, or the same OCR text); a page-count difference is never the same fax. Faxes with no queue trail are searched in the candidates' charts by date and pages (medium confidence at most). A file Drawbridge split by patient is observed but the observation is not given to its parts (staff index a batch fax as one document): confirm those on the panel.

The exact `GetDocumentsByDocumentType` and `GetDocumentImage` parameters and fields were verified read-only on the sandbox; `GetDocuments` row fields are read through aliases (only the list call itself was verified).

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
| `INTAKE_OCR_URL` | `http://ocr:8090` | Local OCR container; `off` sends text-less files straight to review |
| `INTAKE_OCR_MIN_CONFIDENCE` | `60` | Mean OCR confidence below which a document is never auto-matched |
| `INTAKE_OCR_FAX` | unset | `local`: faxes from MOATiT Fax are read by the local OCR container too (header second pass, sender templates) and its text is used; if that read fails, MOATiT Fax's text is kept |
| `INTAKE_MATCH_RULE` | `two_identifiers` | `name_dob` is the MOATiT standard (Oct 11, 2026): name + DOB are the two identifiers, see above. The `.env.example` files set it |
| `INTAKE_SENDER_TEMPLATES_DIR` | unset | Folder of sender templates (JSON, as in `deploy/ocr/templates/`); unset = no templates |
| `INTAKE_PRACTICE_NAME` | `Idaho Kidney Institute` | The receiving practice: never taken as the document's sender |
| `INTAKE_BATCH_SENDERS` | unset | Batch-report senders (comma-separated, case-insensitive part of the name, or a 10-digit fax number): every page must identify its patient; multi-patient files are split. Replaces listing the batch lab in `INTAKE_NO_AUTO_SENDERS` |
| `INTAKE_SPLIT` | `on` | `off`: multi-patient files go to staff instead of being split |
| `INTAKE_NO_AUTO_SENDERS` | unset | Optional: senders whose documents always wait for staff (same matching as above) |
| `INTAKE_REVIEW_USER` | unset | Veradigm® EHR user who gets the review task of a filed document (unset: no task) |
| `INTAKE_ALWAYS_PERSON` | all four | Document types never auto-filed: `records_request`, `prior_auth`, `refill_request`, `referral` (comma list), or `none`. Unknown names keep all four |
| `INTAKE_TASK_TARGET` | `review_user` | `ordering_provider`: the review task goes to the ordering provider on the document, matched to one Veradigm® EHR user (`GetProviders`); else `INTAKE_REVIEW_USER` |
| `INTAKE_CRITICAL_NOTIFY` | unset | Veradigm® EHR user for critical results' tasks (High priority, "CRITICAL" first); unset: the normal recipient |
| `INTAKE_SAME_DAY_NO_NOTIFY` | `off` | `on`: no review task for a lab or imaging result collected on an appointment day (`GetScheduleByPatientID`); critical results always notify |
| `CALL_RECORDS_DIR` | `/app/data` | Base of `intake/` |
| `INTAKE_MODE` | `live` | `shadow`: nothing filed, read-only Veradigm®, decisions and ground truth recorded |
| `INTAKE_ROSTER_CSV` | unset | Local patient list instead of `unity_search_patients` (columns: `deploy/datacenter/README.md`) |
| `INTAKE_CATEGORIES_CSV` | unset | Category names, one per line, when `GetDocumentType` isn't available |
| `INTAKE_WATCH_DIRS` | unset | Folders read in place (never changed), subfolders too; `INTAKE_WATCH_SINCE`, `INTAKE_WATCH_MAX` |
| `INTAKE_QUEUE_SOURCE` (`_EVERY_MIN`, `_WINDOW_DAYS`, `_PER_RUN`) | off | Shadow week: documents read straight from the "(ready for indexing)" queue, read-only; shadow mode only; never filed (`queue-source.ts` header) |
| `INTAKE_OBSERVE*` | on in shadow mode | Staff filing observer (`observe.ts` header) |
| `DRAWBRIDGE_USERS_FILE` | unset | Named staff logins (scrypt lines, `npm run staff:user`); replaces the shared login |

Secrets go in `.env` only. Logs carry item IDs, job IDs, counts and error codes. They never carry keys, file names, document text or patient identifiers.

## Open TODOs

- Staff split by hand on the item screen (pick the pages per patient) for files the page check sends to review.
- Confirm Express Lab's real layout on de-identified samples: one patient per page with the patient line repeated on every page is what auto-files; packed pages (several patients per page) always go to staff.
- The real `unity_search_patients` rows must carry both MRNs (PM MRN and EHR PatientNumber) for the either-MRN rule to help; `toCandidates` already reads `mrn`, `patientNumber`, `chartMrn`, `ehrMrn`, `pmMrn`.
- Confirm the MOATiT Fax job and download response fields against the live API.
- Staff "pick a different patient" on the item screen.

## Tests

`npm run smoke:intake` runs offline with made-up patients. It covers HMAC good/bad/missing, the event allowlist, durable dedupe, the webhook and staff routes on 127.0.0.1, extraction on three synthetic documents and under fax-OCR noise (multi-patient batch, unreadable MRN), the match decision table, document-type mapping and cache, the pipeline with fake Veradigm and MOATiT Fax, the OCR client and pipeline against a fake OCR server (success, low confidence, empty, 5xx, 4xx, bad JSON, timeout, unreachable), the drop folder, the filing guard, screen wording, and logs without content. Accuracy work: consensus across pages and `reads_agree`, "First M, Last" commas, unread MRN- or phone-like numbers near the patient, sender templates (OCR-tolerant labels that never match `PTH-I` or `PT PHONE`, name order, date formats, MRN pattern, invalid files skipped, off by default), the optional `name_dob` rule (its own decision table, never changing a default decision, the wider searches and their failures), and `INTAKE_OCR_FAX=local`. Pages and batches: form feeds and MOATiT Fax page markers, sender lists, every page rule and review trigger, and a batch fax end to end against a fake OCR server (`/ocr` per page, `/pages` cuts): split, parts matched and auto-filed to their own charts, the blind spot to review, idempotent re-processing, split failure and retry, page-count mismatch, OCR off, screens and retention.

`npm run smoke:intake` also runs `smoke-intake-rules.ts` (the clinic rules, against a fake Veradigm®: request detection and its false positives, the hold with its reason, critical flags and the High task, back to staff when the task fails and "Provider was told", ordering-provider extraction and matching with fallbacks, same-day lookups and their failures, the "Lab Results" category, logs) and `smoke-intake-shadow.ts` (offline, made-up patients and a fake roster): roster parsing and matching, categories, the read-only guards, the shadow pipeline with live search and with the roster (filing impossible with `INTAKE_FILING=auto`), the batch split, the Confirm panel and filters, the report and its leak check, the importer, watched folders, named logins, the shadow server, and the staff filing observer against fakes with the sandbox's verified shapes.

`npm run eval:intake -- --set <dir>` measures accuracy on a large synthetic set (generator `tools/intake-synth`, OCR `deploy/ocr`): per-field accuracy, decisions against the expected ones, auto-file rate, and page by page the filing outcome before / after batch splitting, with **wrong-patient pages filed** (must be 0). Method and numbers: `docs/drawbridge/INTAKE_ACCURACY.md`.
