# Drawbridge add-on: fax and document intake

**Goal:** lab results, imaging reports, consult letters and other documents that outside offices fax or email are read, matched to the right patient and **filed straight into the patient's Veradigm® EHR chart**, so front-desk staff no longer index them by hand. A provider review task goes out for each filed result.

Status: **design + scaffold** (branch `drawbridge/fax-intake`, Oct 9, 2026). Nothing files to a chart until the upload action is verified on the sandbox and Ali approves the first write.

## Why it's possible

- Veradigm® EHR's Unity API has `SaveDocumentImage`: attach a document (PDF/TIFF/image) to a patient under a document type. Files filed this way show up in the chart directly. The sandbox already holds PDFs that other partner apps filed this way (Ed Smith's chart: "Annual Eye Exam – Submitted by ProviderFlow…TestApp").
- `GetDocumentType` (verified Oct 9) lists the 128 sandbox document types (Labs/Procedures, Consultant Letter, Colonoscopy Report, …), including **"(ready for indexing)"**, the queue staff work today.
- MOATiT Fax (repo `moatit/MOATiTFaxService`, `D:\MOATiTFax`) already receives faxes (FreeSWITCH/T.38), stores them encrypted, OCRs them and exposes an enterprise API and signed webhooks.

## Where the files live (hosting)

Patient documents are PHI: they stay in MOATiT's own infrastructure, encrypted at rest, with access logged. **No Google Drive, Dropbox or personal folders.**

| Source | Where the file is | How Drawbridge gets it |
|---|---|---|
| **Faxes** (main source) | **MOATiT Fax storage** (`fax_storage` volume, encrypted, in MOATiT's data center next to the IKI Veradigm hosting) | MOATiT Fax sends a signed `fax.received` webhook → Drawbridge fetches `GET /api/v1/enterprise/fax/{job_id}` (OCR + metadata) and `GET …/{job_id}/download` (original) with a `fax:read` API key. No second copy of the fax is needed outside the two MOATiT systems. |
| **Emailed results, scans, files from other systems** | **Drawbridge intake drop folder**: a Docker volume on the Drawbridge host (`/app/intake/inbox`). Dev: bind mount `D:\VeradigmAI-DrawBridge\intake\inbox` (git-ignored). Production: encrypted volume on the MOATiT data-center host, reachable by SFTP for partner systems. | Folder watcher picks up PDF, TIFF, PNG and JPEG files. |
| **Staff uploads** | Same intake store | "Upload document" on the staff screen (`/app/intake`). |

Intake working store (both sources): `/app/data/intake/` with `items.json` (status, extracted fields, match, audit) and `files/` (originals, encrypted at rest by the volume). Lifecycle: `received → read → matched → filed | needs_review | sent_to_indexing | failed`. Originals are deleted 30 days after filing (configurable); the chart copy is the record.

Optional later: an S3 bucket with SSE-KMS under MOATiT's AWS BAA (account already used for Drawbridge on AWS) if intake moves to AWS.

## Flow

1. **Receive.** A webhook (fax) or the folder watcher creates an intake item. Dedupe by `X-Webhook-Id` / file hash.
2. **Read.** Text from MOATiT Fax OCR (or Drawbridge's own OCR for dropped files). Extract: patient name, DOB, MRN, sender (lab/office, fax number), document kind, collection/test date, abnormal flags. OCR is treated as untrusted until matched.
3. **Match.** `unity_search_patients` (PM + EHR, name + DOB). **Auto-file only when exactly one patient matches AND a second identifier agrees** (MRN, or phone, or the ordering provider + recent order). Anything else → `needs_review`.
4. **Choose the document type.** Map the kind to a `GetDocumentType` entry (e.g. lab → "Labs/Procedures", consult → "Consultant Letter"); unknown → "(ready for indexing)".
5. **File.** `SaveDocumentImage` to the matched patient's chart (EHR patient ID), with the date and a description ("Outside lab – Quest – CBC – 10/08/2026").
6. **Notify.** `SaveTask` to the ordering provider / results pool: "New outside result for review", abnormal flags called out.
7. **Fallback.** Low confidence or any failure → file under "(ready for indexing)" for the patient if matched, else leave it in the Drawbridge review queue. Staff confirm or correct with one click on `/app/intake`.

## Safety rules

- Never file to a chart on one identifier. Never guess between two patients.
- Never alter or summarize clinical content inside the document; the original file is what's filed.
- Every filing is audited (who/what/when, intake item, patient ID, document ID) and visible on `/app/intake`.
- Writes are idempotent per intake item (same item never filed twice).
- The phone agent never files documents; this is a staff-side add-on.
- `INTAKE_FILING=off` by default. Modes: `off` (read + match + queue only), `review` (staff click to file), `auto` (high-confidence auto-file, everything else review).

## Veradigm actions

| Action | System | Use | Status |
|---|---|---|---|
| `GetDocumentType` | EHR | List document types | Verified Oct 9 |
| `SearchPatients` (via `unity_search_patients`) | PM + EHR | Match patient | Verified Oct 9 |
| `GetDocuments` | EHR | Confirm the filed document appears; avoid duplicates | Verified Oct 9 (read) |
| `SaveDocumentImage` | EHR | File the document | **Format to confirm (Kanhaiya / Veradigm reference); not yet run** |
| `SaveTask` | EHR | Provider review task | Format to confirm; not yet run |

**Certification:** `SaveDocumentImage` must be in the Unity action list submitted for certification (adding it later forces recertification). See `VERADIGM_APPROVAL_GUIDE.md`.

## Build plan

1. Scaffold (this branch): intake store, MOATiT Fax webhook receiver (HMAC, dedupe), folder watcher, field extraction, patient matcher, document-type mapping, review screen, smoke tests. Filing disabled.
2. Confirm `SaveDocumentImage` and `SaveTask` formats; with Ali's approval, file one test PDF to a sandbox test patient and read it back with `GetDocuments`.
3. Pilot in `review` mode on IKI faxes (staff click to file), measure match accuracy.
4. Turn on `auto` for document kinds and senders that reached the agreed accuracy.
