# Drawbridge add-on: fax and document intake

**Goal:** lab results, imaging reports, consult letters and other documents that outside offices fax or email are read, matched to the right patient and **filed straight into the patient's Veradigm® EHR chart**, so front-desk staff no longer index them by hand. A provider review task goes out for each filed result.

Status (Oct 11, 2026): **working end to end on the Veradigm sandbox** with synthetic patients (branch `drawbridge/fax-intake`). A dropped fax is read by local OCR, matched, filed with `SaveScanDocument` and gets a linked provider review task. Live run: 40 synthetic faxes, 11 auto-filed, all 11 to the right patient and read back from the chart; the other 29 went to staff review as designed. Offline accuracy on 4,000 synthetic documents: `INTAKE_ACCURACY.md`. Filing stays off by default (`INTAKE_FILING=off`).

## Why it's possible

- Veradigm® EHR's Unity API has `SaveScanDocument`: save a PDF/TIFF/image to a patient's scanned documents under a document type, with a clinical date, title and status (Submitted = waits for staff approval in Veradigm® EHR; Approved = in the chart at once). `SaveTask` type "Review" links a provider review task to that document. Both verified on the sandbox Oct 11. (`SaveDocumentImage`, a plain chart attachment, also exists; other partner apps use it, but a review task can't link to it.)
- `GetDocumentType` (verified Oct 9) lists the 128 sandbox document types (Labs/Procedures, Consultant Letter, Colonoscopy Report, …), including **"(ready for indexing)"**, the queue staff work today.
- MOATiT Fax (repo `moatit/MOATiTFaxService`, `D:\MOATiTFax`) already receives faxes (FreeSWITCH/T.38), stores them encrypted, OCRs them and exposes an enterprise API and signed webhooks.

## Where the files live (hosting)

Patient documents are PHI: they stay in MOATiT's own infrastructure, encrypted at rest, with access logged. **No Google Drive, Dropbox or personal folders.**

| Source | Where the file is | How Drawbridge gets it |
|---|---|---|
| **Faxes** (main source) | **MOATiT Fax storage** (`fax_storage` volume, encrypted, in MOATiT's data center next to the IKI Veradigm hosting) | MOATiT Fax sends a signed `fax.received` webhook → Drawbridge fetches `GET /api/v1/enterprise/fax/{job_id}` (OCR + metadata) and `GET …/{job_id}/download` (original) with a `fax:read` API key. No second copy of the fax is needed outside the two MOATiT systems. |
| **Emailed results, scans, files from other systems** | **Drawbridge intake drop folder**: a Docker volume on the Drawbridge host (`/app/intake/inbox`). Dev: bind mount `D:\VeradigmAI-DrawBridge\intake\inbox` (git-ignored). Production: encrypted volume on the MOATiT data-center host, reachable by SFTP for partner systems. | Folder watcher picks up PDF, TIFF, PNG and JPEG files. |
| **Staff uploads** | Same intake store | "Upload document" on the staff screen (`/app/intake`). |

Intake working store (both sources): `/app/data/intake/` with `items.json` (status, extracted fields, match, audit) and `files/` (originals, encrypted at rest by the volume). Lifecycle: `received → read → split | matched → filed | needs_review | sent_to_indexing | failed`. A file with several patients becomes `split`: one part (its own intake item, with only that patient's pages) per patient, each going through the same steps. Originals are deleted 30 days after filing (configurable; a split original once every part is filed); the chart copy is the record.

Optional later: an S3 bucket with SSE-KMS under MOATiT's AWS BAA (account already used for Drawbridge on AWS) if intake moves to AWS.

## Flow

1. **Receive.** A webhook (fax) or the folder watcher creates an intake item. Dedupe by `X-Webhook-Id` / file hash.
2. **Read.** Text from MOATiT Fax OCR, or Drawbridge's own OCR container (`deploy/ocr`, Tesseract 5 on the internal Docker network, with a second, larger reading of the patient lines) for dropped and uploaded files (and for faxes too with `INTAKE_OCR_FAX=local`), **page by page** (form feeds between pages; MOATiT Fax's `--- Page N ---` markers are converted). Extract: patient name, DOB, MRN, sender (lab/office, fax number), document kind, collection/test date, abnormal flags. OCR is treated as untrusted until matched.
   **Pages and batch files.** For a batch sender (`INTAKE_BATCH_SENDERS`, e.g. IKI's Express Lab daily file) or any document that names more than one patient, every page is read on its own and grouped by patient (see [Batch faxes](#batch-faxes-one-document-per-patient)). Several patients, cleanly separated: the file is **split into one document per patient** and each part goes through steps 3-6 on its own. Any doubt: the whole file goes to staff.
3. **Match.** `unity_search_patients` (PM + EHR, name + DOB). **Auto-file only when exactly one patient matches AND a second identifier agrees** (MRN, or phone, or the ordering provider + recent order). Anything else → `needs_review`.
   *Optional, off by default, pending the clinic's decision:* `INTAKE_MATCH_RULE=name_dob` also auto-files a document that carries **no MRN or patient phone at all** when the exact full name and DOB match exactly one patient and nobody with a similar name has that DOB or one a digit off (see [Optional rule: name + DOB](#optional-rule-name--dob)).
4. **Choose the document type.** Map the kind to a `GetDocumentType` entry (e.g. lab → "Labs/Procedures", consult → "Consultant Letter"); unknown → "(ready for indexing)".
5. **File.** `SaveScanDocument` to the matched patient's chart (EHR patient ID) with the clinical date and a short title ("Outside lab Oct 8 2026 - <sender>"; Veradigm shows ~50 characters and strips "/"). Auto-filing only in `INTAKE_FILING=auto`, for two-identifier matches with a specific document type; for batch senders only after every page passed the page check; never for a duplicate file or for senders in `INTAKE_NO_AUTO_SENDERS` (optional "always staff" list).
6. **Notify.** `SaveTask` to the ordering provider / results pool: "New outside result for review", abnormal flags called out.
7. **Fallback.** Low confidence or any failure → file under "(ready for indexing)" for the patient if matched, else leave it in the Drawbridge review queue. Staff confirm or correct with one click on `/app/intake`.

## Safety rules

- Never file to a chart on one identifier. Never guess between two patients. A document that shows more than one patient (a daily batch) is never filed to one chart: it is split into one document per patient, or it goes to staff. **A page is never filed to a patient it does not name** (outside batch senders, an unlabelled continuation page goes with the patient on the page before it).
- Never alter or summarize clinical content inside the document; the original file is what's filed.
- Every filing is audited (who/what/when, intake item, patient ID, document ID) and visible on `/app/intake`.
- Writes are idempotent per intake item (same item never filed twice).
- The phone agent never files documents; this is a staff-side add-on.
- `INTAKE_FILING=off` by default. Modes: `off` (read + match + queue only), `review` (staff click to file), `auto` (high-confidence auto-file, everything else review).

## Optional rule: name + DOB

Many documents (consult letters, hospital labs that print their own MRN, small clinics) carry the patient's name and DOB but no MRN or phone of ours. Under the default rule they always go to staff. Whether an exact full name + DOB matching exactly one patient is enough is the clinic's call (question to IKI, Oct 2026). Until it decides, `INTAKE_MATCH_RULE` stays `two_identifiers`.

With `INTAKE_MATCH_RULE=name_dob`, such a document is auto-matched only when **all** of these hold (`match.ts` `nameDobCheck`):

- the exact normalized full name (first + last) and DOB, both next to an explicit patient label (`Patient:`, `Patient Name:`, `PT:`; not `RE:` or `Name:`), and every labelled read of them on the document identical;
- exactly one patient has that exact name + DOB;
- no other patient has a similar name (one edit apart, Soundex sound-alike, a first name that starts the other, first/last swapped, or the same last name: twins) **and** the same DOB, a DOB one character off, or day/month swapped. Two wider searches back this: same DOB with the last name's first two letters, and the last name at any DOB. A failed search is an error (retry), never "nobody similar";
- no MRN or patient phone on the document (one that agrees already files under the default rule; one that disagrees sends it to staff), no MRN label left unread, and no MRN- or phone-like number near the patient line that wasn't read as one;
- the OCR-confidence gate.

Everything the default rule files, rejects or calls ambiguous is unchanged. Residual risk the bench can't measure: a document about someone who is **not** our patient but has exactly the name and DOB of one of our patients, with no MRN on it. A sender template can mark a sender's "RE:" line as its patient label.

## Sender templates

A frequent sender (Express Lab) gets a small JSON file describing its layout: where its patient header sits (the labels, or a band of the page), how it words them, name order, date formats and MRN pattern. The OCR container reads those lines again every time (optionally with a character whitelist), and the extractor reads the sender's labels even as OCR misreads them ("PTt", "D0B;") and rejects an MRN that doesn't fit the pattern. Files: `deploy/ocr/templates/*.json` (baked into the OCR image; more at `OCR_TEMPLATES_DIR`) and the same folder for the intake module (`INTAKE_SENDER_TEMPLATES_DIR`). The one shipped, `sawtooth-rapid-lab.json`, is for the **synthetic** daily batch; Express Lab's real one is written once de-identified samples arrive. A template never relaxes a matching rule.

## Batch faxes: one document per patient

IKI's lab (Express Lab) sends a daily file with many patients' results. Until Oct 11 any document showing more than one patient went to staff, and the batch lab sat in `INTAKE_NO_AUTO_SENDERS`, so none of its files were auto-filed. That stopgap covered a blind spot: if every label of a second patient on a later page is unreadable, the file looks like one patient and could be filed whole to the first patient's chart. `INTAKE_BATCH_SENDERS` replaces it.

**Per-page check** (`src/platform/modules/intake/pages.ts`). Each page is read with the same extractor as a whole document. A page *identifies* a patient when it shows a readable name + date of birth, or an MRN.

| Page | Batch sender (`INTAKE_BATCH_SENDERS`) | Other senders |
|---|---|---|
| Fax cover sheet without identifiers (an "RE:" name alone doesn't count), before the first patient page | not a patient page; stays with the original | same |
| Identifies a patient | that patient | same |
| No identifier (continuation, blotted, unreadable) | **whole file to staff** | belongs to the patient on the page before |
| Only a name or only a DOB | **whole file to staff** | must equal the patient before, else staff |

The whole file goes to staff, with the reason on the item, when a page shows two patients; a patient's pages are not contiguous; two pages' identifiers are close but not equal (a misread digit, twins Daniel / Danielle: never merged, never split; the same MRN read exactly on both pages is the one exception); a page has result lines above its patient line, or a ruled-off block of results without a patient line (the end of the previous patient, or a second patient on a packed page whose label is unreadable); the page count of the text differs from the file's; a part would still name two patients; or splitting is off (`INTAKE_SPLIT=off`) or the OCR service is unavailable. Documents from other senders that name one patient are filed whole, as before.

**Split.** When the check finds two or more patients, the OCR container cuts the original (`POST /pages?select=…`: PDF pages copied, TIFF G4 kept, nothing re-rendered) into one file per patient. Each part is a new intake item with only its pages and their text, linked to the parent (`parent_id`, part *k* of *n*, pages); the parent becomes **`split`** and lists its parts. Nothing is created until every part is cut and the file's page count matches; a part is keyed by parent + pages, so re-processing a parent never makes duplicates, and a failed cut leaves the parent `failed` (retry). Each part is then matched, categorized (`suggest(kind, subtype)`) and gated (two identifiers, its own pages' OCR confidence) like any document. The parent is never filed. Staff screens show the parent with its parts (patient, pages, status) and each part with a link back.

**Bench** (`INTAKE_ACCURACY.md`, 1,000 fresh synthetic documents with per-page truth): wrong-patient pages filed **0** after (1 without the stopgap, the blind spot reproduced); batch-lab pages auto-filed rose from 2 of 485 to about 180, all to the right patient.

## Veradigm actions

| Action | System | Use | Status |
|---|---|---|---|
| `GetDocumentType` | EHR | List document types | Verified Oct 9 |
| `SearchPatients` (via `unity_search_patients`) | PM + EHR | Match patient | Verified Oct 9 |
| `GetDocuments` | EHR | Confirm the filed document appears; avoid duplicates | Verified Oct 9 (read) |
| `SaveScanDocument` | EHR | File the document (single call; 1 MB chunks over 2 MB) | **Verified Oct 11** (synthetic patients; incl. a 2.6 MB chunked file) |
| `SaveTask` ("Review", WorkObjectID = document ID) | EHR | Provider review task linked to the document | **Verified Oct 11** |
| `SavePatient` | PM | Create the synthetic test patients (test setup only; the EHR chart appears at once) | Verified Oct 11 |

**Certification:** `SaveScanDocument` and `SaveTask` must be in the Unity action list submitted for certification (adding it later forces recertification). See `VERADIGM_APPROVAL_GUIDE.md`.

## Build plan

1. Scaffold (this branch): intake store, MOATiT Fax webhook receiver (HMAC, dedupe), folder watcher, field extraction, patient matcher, document-type mapping, review screen, smoke tests. Filing disabled.
2. Confirm `SaveDocumentImage` and `SaveTask` formats; with Ali's approval, file one test PDF to a sandbox test patient and read it back with `GetDocuments`.
3. Pilot in `review` mode on IKI faxes (staff click to file), measure match accuracy. Synthetic bench and current numbers: `INTAKE_ACCURACY.md` (0 wrong-patient auto-files in 4,000 synthetic documents; next is de-identified real IKI samples).
4. Turn on `auto` for document kinds and senders that reached the agreed accuracy.
