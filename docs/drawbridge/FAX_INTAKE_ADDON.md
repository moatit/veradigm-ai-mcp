# Drawbridge add-on: fax and document intake

**Goal:** lab results, imaging reports, consult letters and other documents that outside offices fax or email are read, matched to the right patient and **filed straight into the patient's Veradigm® EHR chart**, so front-desk staff no longer index them by hand. A provider review task goes out for each filed result.

Status (Oct 11, 2026): **working end to end on the Veradigm sandbox** with synthetic patients (branch `drawbridge/fax-intake`). A dropped fax is read by local OCR, matched, filed with `SaveScanDocument` and gets a linked provider review task. Live run: 40 synthetic faxes, 11 auto-filed, all 11 to the right patient and read back from the chart; the other 29 went to staff review as designed. Offline accuracy on 4,000 synthetic documents: `INTAKE_ACCURACY.md`. Filing stays off by default (`INTAKE_FILING=off`). Oct 13: IKI's clinic rules tested end to end on the sandbox, scenario by scenario, with read-back: [IKI_RULES_SANDBOX_TEST.md](IKI_RULES_SANDBOX_TEST.md).

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
3. **Match.** `unity_search_patients` (PM + EHR, name + DOB), under the MOATiT standard in [Matching](#matching): **two identifiers, name + date of birth**, exactly one patient, nobody look-alike, no conflicting MRN or phone; and a **third identifier** (SSN last 4 or address) checked whenever the document carries one. Anything else → `needs_review`.
4. **Choose the document type.** Map the kind to a `GetDocumentType` entry (e.g. lab → "Labs/Procedures", consult → "Consultant Letter"); unknown → "(ready for indexing)".
5. **File.** `SaveScanDocument` to the matched patient's chart (EHR patient ID) with the clinical date and a short title ("Outside lab Oct 8 2026 - <sender>"; Veradigm shows ~50 characters and strips "/"). Auto-filing only in `INTAKE_FILING=auto`, for two-identifier matches with a specific document type; for batch senders only after every page passed the page check; never for a duplicate file, for senders in `INTAKE_NO_AUTO_SENDERS` (optional "always staff" list) or for the document types the clinic always gives to a person (`INTAKE_ALWAYS_PERSON`, see [Clinic rules](#clinic-rules-set-per-clinic)).
6. **Notify.** `SaveTask` "Review" linked to the filed document, to the review user or the ordering provider (`INTAKE_TASK_TARGET`); a critical result as High priority with "CRITICAL" first and a phone call recorded as required; none for a result collected on the day of the patient's appointment when the clinic says so (`INTAKE_SAME_DAY_NO_NOTIFY`). See [Clinic rules](#clinic-rules-set-per-clinic).
7. **Fallback.** Low confidence or any failure → file under "(ready for indexing)" for the patient if matched, else leave it in the Drawbridge review queue. Staff confirm or correct with one click on `/app/intake`.

## MOATiT standard process (Ali, Oct 11, 2026)

- **Patient identification:** two identifiers, full name + date of birth, matching exactly one patient (`INTAKE_MATCH_RULE=name_dob`). When the document also carries the last 4 of the SSN or the patient's address, that third identifier is checked as well. A disagreement, or a look-alike patient, sends the document to staff.
- **Go-live:** one week in shadow mode first (`INTAKE_MODE=shadow`). Staff keep indexing as usual; Drawbridge records what it would have done and compares it with where staff filed each document. The team reviews the differences and fixes them, then filing into the chart is switched on.

## Clinic rules (set per clinic)

Idaho Kidney Institute's practice manager answered the setup sheet on Oct 13, 2026 (branch `drawbridge/fax-intake-iki-rules`). Each answer is a setting, so another clinic can answer differently. Code: `src/platform/modules/intake/rules.ts` (settings, pure decisions) and `notify.ts` (the two Veradigm® reads and the review task's plan); filing and the task in `file.ts`.

| Setting | Values (default first) | IKI | What it does |
|---|---|---|---|
| `INTAKE_ALWAYS_PERSON` | unset = all four / a comma list of `records_request`, `prior_auth`, `refill_request`, `referral` / `none` | all four | These documents are never auto-filed, even with a perfect patient match. The item goes to **Needs review** with the reason first ("Prior authorization: always reviewed by staff."), shown in the queue and on the item; staff can still file it. An unknown name in the list keeps all four (a typo never lets a prior authorization through). |
| `INTAKE_CRITICAL_NOTIFY` | unset = the normal recipient / a Veradigm® EHR user name | unset (not named yet) | Who gets a critical result's review task. |
| `INTAKE_TASK_TARGET` | `review_user` / `ordering_provider` | `ordering_provider` | Who gets the review task of a filed document: `INTAKE_REVIEW_USER`, or the ordering provider printed on the document matched to one Veradigm® EHR user (`INTAKE_REVIEW_USER` when there is no confident match). |
| `INTAKE_SAME_DAY_NO_NOTIFY` | `off` / `on` | `on` | `on`: a lab or imaging result collected on the day of one of the patient's appointments is filed without a review task. Critical results always get one. |
| `INTAKE_CATEGORY_MAP` | (existing) | `{"lab_result":"Lab Results"}` | IKI files lab results under "Lab Results". Without the map, an EHR that has both "Labs/Procedures" and "Lab Results" (the sandbox does) gets "Labs/Procedures", so IKI sets it. |

**Documents that always go to a person.** `extract.ts` `classifyRequest` reads the request type from the document's title (the first 12 lines of each page: "PRIOR AUTHORIZATION REQUEST", "REQUEST FOR MEDICAL RECORDS", "PRESCRIPTION REFILL REQUEST", "REFERRAL FORM"), a subject line ("RE: Prior authorization ...") or a ticked box ("[X] Prior authorization"; an unticked box is ignored). A lab, imaging or consult report also needs two of the request's own words (member ID, NDC, pharmacy, dates of service, reason for referral, ...), so a result whose header says "Prior auth #" stays a result. Untitled, a non-report needs three of them, and a referral needs a letter that refers the patient itself ("I am referring ..."). A result that mentions a referral or a refill in passing ("referred by Dr. Hale", "Reason for referral: CKD", "refill lisinopril per PCP") is not caught; the document kind `referral` alone (which such mentions can produce) does not count. Bench: [INTAKE_ACCURACY.md](INTAKE_ACCURACY.md#clinic-rules-for-iki-oct-13-branch-drawbridgefax-intake-iki-rules).

**Critical results.** The lab's own flags: HH / LL (also written against the value, "41LL"), "(C)", a star flag OCR read as a quote ("“HH"), and the words CRITICAL / PANIC, but not the lab's policy line ("Critical values are telephoned to the ordering client", also as OCR garbles it), "Critical values: none" or a critical care unit. Such a document:
- is marked on the item as soon as it is read: **phone call required** (queue pill "critical: call required", a "Critical result" line on the item). Drawbridge never places a call;
- gets its review task as **High** priority, subject "CRITICAL: New outside document for review: ...", comment "CRITICAL result: a phone call is required.", to `INTAKE_CRITICAL_NOTIFY` (else the normal recipient). Same-day appointments never suppress it;
- is never auto-filed unless someone is set up to receive that task (`INTAKE_CRITICAL_NOTIFY` or `INTAKE_REVIEW_USER`): it waits in Matched with "critical result, and no one is set up to receive its review task";
- when filed but the task could not be created (no recipient, Veradigm® refused or did not answer, no task ID back), goes back to **Needs review**, still filed (never filed twice): "CRITICAL result filed to the chart (document N), but no review task was created (...). Tell the provider now: a phone call is required." Staff click **Provider was told** once they have; the item is then Filed, with who and when.

**Review task to the ordering provider.** Read from "Ordering Provider:", "Ordering:", "Ordered by:", "Requesting Physician:" (high), "Referring:", "Attending:", "Physician:", "Provider:" (medium), or else a cover sheet's "Attn: Dr. ...", "Please forward to Dr. ..." or a letter's "Dear Dr. ..."; OCR-tolerant (", MID" for ", MD", "Or," for "Dr."); never the interpreting, performing or signing doctor (radiologist, lab director, "Reviewed by", "Electronically signed by"). Two different people under the best label found are not used. The name is matched against Veradigm® EHR's provider list (`GetProviders`, read-only, cached for an hour): exactly one active provider with that last name and first name or initial (a last name alone when only one provider has it; one letter off only with the exact first name and nobody else close), and with a user name to send the task to. Anything else, or the list unavailable, sends the task to `INTAKE_REVIEW_USER`; the item shows the name read, the user matched or why not.

**Same-day appointments.** IKI's providers see same-day results at the visit. The date compared is the result's **collection / service date** printed on the document (not the day it arrived): a result collected at the visit and faxed the next morning is still that visit's. The patient's appointments come from `GetScheduleByPatientID` (Veradigm® PM, read-only, by the matched patient's PM ID; never `GetSchedule`, which ignores the patient). Cancelled, rescheduled and no-show appointments don't count. No collection date on the document, no PM patient ID, or a failed lookup: the task is sent as usual. Only lab and imaging results; consult letters and other documents always notify.

## Safety rules

- Never file to a chart on one identifier (name + date of birth count as two under the [MOATiT standard](#matching)). Never file when an MRN, phone, SSN last 4 or address on the document disagrees with the chart. Never guess between two patients. A document that shows more than one patient (a daily batch) is never filed to one chart: it is split into one document per patient, or it goes to staff. **A page is never filed to a patient it does not name** (outside batch senders, an unlabelled continuation page goes with the patient on the page before it).
- Never alter or summarize clinical content inside the document; the original file is what's filed.
- Every filing is audited (who/what/when, intake item, patient ID, document ID) and visible on `/app/intake`.
- Writes are idempotent per intake item (same item never filed twice).
- The phone agent never files documents; this is a staff-side add-on.
- `INTAKE_FILING=off` by default. Modes: `off` (read + match + queue only), `review` (staff click to file), `auto` (high-confidence auto-file, everything else review).

## Matching

**MOATiT standard, decided by the owner Oct 11, 2026.**

- **Two identifiers are name + date of birth.** That is the default: deployments set `INTAKE_MATCH_RULE=name_dob` (both `.env.example` files do). A document is auto-matched on them under the conditions in [Name + DOB](#name--dob) below: exact name and DOB, one patient, no look-alikes, no conflicting MRN or phone. (Unset, the code falls back to the stricter `two_identifiers` rule: name + DOB + an MRN, phone, SSN last 4 or address that agrees.)
- **A third identifier is checked whenever the document carries one:** the **last 4 of the SSN**, or the **patient's address**.
  - **Agrees:** confidence goes up. The match records it (`third_identifier: 'ssn4' | 'address'`), the reason says so, and the staff screen shows it ("Third identifier: Address, agrees"). With the exact full name + DOB it may also serve as the second identifier, the way the phone does (`second_identifier: 'ssn4' | 'address'`), behind the same look-alike guard (twins and households share an address).
  - **Disagrees:** the document goes to staff with the reason ("...but the SSN last 4 on the document is different." / "...but the address on the document is different (an old address, or someone else)."), the same way a conflicting MRN or phone does today, **also when the MRN agrees**. A patient who moved therefore goes to staff until the chart has the new address.
  - **Can't be checked:** the patient's record has none (the Veradigm® search returns the SSN blank, see below), or it is printed but unreadable (a label whose value OCR lost, an SSN-like number without its label). It might belong to someone else, so it stops a match on name + DOB alone and an SSN-4/address second identifier, the way an unconfirmed phone does; a match confirmed by an MRN, phone or the other third identifier still stands. (Found on the bench: without this, a namesake document printing only an SSN-4 the chart lacks was filed to our patient.)
- **MRN and phone** work as before: an MRN that agrees (either Veradigm® MRN) files; one that differs, or a different phone, sends the document to staff.
- Every other safety rule is unchanged: look-alike patients, several patients on a document, the OCR-confidence gate, the page checks of batch files.

**When they agree** (`match.ts` `addressAgreement`, `checkThird`):

| Identifier | Agrees when | Read from the document (`extract.ts`) |
|---|---|---|
| SSN last 4 | the 4 digits are equal | `SSN: ***-**-1234`, `XXX-XX-1234`, `SS#`, `Soc Sec #`, `SSN Last 4: 1234`, OCR-garbled masks. A full SSN is read for its last 4 only: never stored, logged or reported, and masked to `***-**-1234` in the stored document text (`redactSsn`). Two different last 4 on one document count as unreadable. |
| Address | street number + 5-digit ZIP equal, **or** street number + street name equal (St/Street, Ave/Avenue, Rd/Road, N/North ..., case ignored; Apt/Unit/# dropped; a missing suffix or directional on one side is allowed, a different one is not) | `Address:` / `Patient Address:` / `Home Address:` / `ADDR:` (OCR-tolerant), one or two lines; or an unlabelled street line with a street suffix under the patient's name/DOB, backed by city, state and ZIP. PO boxes compare by box number. The sender's letterhead is never read as the patient's address. |

**Patient data.** `SearchPatients` rows (PM and EHR) carry `AddressLine1`, `AddressLine2`, `City`, `State`, `ZipCode` and `ssn`; PM rows also `HideSSN` and `SuppressSSN`. One read-only search on the sandbox (Oct 11, 2026, after Veradigm's announced SSN masking of Oct 10): the address fields are filled in both systems; **`ssn` comes back blank** (PM: a blank value with `HideSSN = Y`, `SuppressSSN = Y`; EHR: empty). `patient.tools.ts` keeps only the last 4 digits of `ssn`, none when `HideSSN` or `SuppressSSN` is set, and merges PM and EHR (address and SSN-4 from whichever has them); the stdio agent server strips `ssnLast4` from what it returns to the agent (the voice summary never had it). So **against live Veradigm® today only the address can be checked**, and a document whose only confirmation would be an SSN last 4 goes to staff; the SSN last 4 can be checked against a patient list (`INTAKE_ROSTER_CSV` optional `SSN` and address columns, `deploy/datacenter/README.md`) or once Veradigm® returns it. Bench numbers: `INTAKE_ACCURACY.md`.

### Name + DOB

With `INTAKE_MATCH_RULE=name_dob`, a document whose name and DOB match is not confirmed by an MRN, phone, SSN-4 or address is auto-matched only when **all** of these hold (`match.ts` `nameDobCheck`):

- the exact normalized full name (first + last) and DOB, both next to an explicit patient label (`Patient:`, `Patient Name:`, `PT:`; not `RE:` or `Name:`), and every labelled read of them on the document identical;
- exactly one patient has that exact name + DOB;
- no other patient has a similar name (one edit apart, Soundex sound-alike, a first name that starts the other, first/last swapped, or the same last name: twins) **and** the same DOB, a DOB one character off, or day/month swapped. Two wider searches back this: same DOB with the last name's first two letters, and the last name at any DOB. A failed search is an error (retry), never "nobody similar";
- no MRN or patient phone on the document (one that agrees already files under the default rule; one that disagrees sends it to staff), no MRN label left unread, and no MRN- or phone-like number near the patient line that wasn't read as one;
- no SSN last 4 or address on the document that disagrees with the record, none printed but unreadable, and none the record has nothing to compare with;
- the OCR-confidence gate.

Everything the stricter `two_identifiers` rule files, rejects or calls ambiguous is unchanged. Residual risk: a document about someone who is **not** our patient but has exactly the name and DOB of one of our patients. When it carries that person's SSN last 4 or address, the third-identifier check sends it to staff (the synthetic bench now has such "namesake" documents); when it carries neither, nothing on the page tells them apart. A sender template can mark a sender's "RE:" line as its patient label.

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

## Shadow mode: real documents, nothing filed

Before any filing on IKI's production, intake runs in **shadow mode** (`INTAKE_MODE=shadow`, branch `drawbridge/fax-intake-shadow`) on MOATiT's dedicated IKI fax server in MOATiT's data center: MOATiT Fax's `fax.received` webhook, the Express Lab folder and the archive of old faxes (both read-only). Every document is read, split and matched; what Drawbridge **would** have done is recorded, and nothing is filed (`file.ts` refuses whatever `INTAKE_FILING` says; only Veradigm® read actions can run). Patients come from the live read-only search once IKI's activation exists, or from an exported patient list for an early start (`INTAKE_ROSTER_CSV`).

Ground truth comes mainly from watching staff: they keep indexing faxes from Veradigm® EHR's "(ready for indexing)" queue as today, and the **staff filing observer** tracks each queue document by DocumentID until it shows the patient and category staff chose. A Confirm panel on each document is the fallback. `npm run eval:shadow` reports the auto-file rate, precision, wrong-patient auto-files, category accuracy, agreement with staff, reasons for staff review and the busiest sender layouts, in counts only. Deployment, outbound limits (only the Veradigm® Unity host), backups and deletion: `deploy/datacenter/README.md`.

## Veradigm actions

| Action | System | Use | Status |
|---|---|---|---|
| `GetDocumentType` | EHR | List document types | Verified Oct 9 |
| `SearchPatients` (via `unity_search_patients`) | PM + EHR | Match patient; address (and SSN last 4 when returned) for the third identifier | Verified Oct 9; SSN and address fields checked Oct 11 (SSN blank) |
| `GetDocuments` | EHR | Confirm the filed document appears; avoid duplicates; shadow observer: a candidate's chart | Verified Oct 9 (read) |
| `GetDocumentsByDocumentType` | EHR | Shadow observer: the "(ready for indexing)" queue and category listings (all patients, date window) | Verified read-only on the sandbox |
| `GetDocumentImage` | EHR | Shadow observer: a queue document as PDF, to tell two similar faxes apart | Verified read-only on the sandbox |
| `SaveScanDocument` | EHR | File the document (single call; 1 MB chunks over 2 MB) | **Verified Oct 11** (synthetic patients; incl. a 2.6 MB chunked file) |
| `SaveTask` ("Review", WorkObjectID = document ID) | EHR | Provider review task linked to the document | **Verified Oct 11** (Medium); **Oct 13**: High (read back as TaskPriority "UrgentNA"; Medium is "RoutineNA"), "CRITICAL:" subject, and tasks to two sandbox providers' user names (accepted with a task ID; not readable by our own user) |
| `GetProviders` | EHR | Ordering provider → Veradigm® EHR user name for the review task (`INTAKE_TASK_TARGET=ordering_provider`) | **Verified read-only Oct 13**: rows under `getprovidersinfo` with `FirstName`, `LastName`, `UserName` (the task target), `EntryCode`, `ProviderInactive`, `UserInactive` ([IKI_RULES_SANDBOX_TEST.md](IKI_RULES_SANDBOX_TEST.md)) |
| `GetScheduleByPatientID` | PM | Same-day appointment check (`INTAKE_SAME_DAY_NO_NOTIFY`) | Verified Oct 9 (read); same-day decisions checked read-only on the sandbox Oct 13 (statuses S, C, A, X) |
| `GetTask`, `GetTaskList` | EHR | Test read-back of review tasks (not used by the app) | Verified read-only Oct 13: only tasks addressed to our own user are visible |
| `SavePatient` | PM | Create the synthetic test patients (test setup only; the EHR chart appears at once) | Verified Oct 11 |

**Certification:** `SaveScanDocument` and `SaveTask` must be in the Unity action list submitted for certification (adding it later forces recertification). See `VERADIGM_APPROVAL_GUIDE.md`.

## Build plan

1. Scaffold (this branch): intake store, MOATiT Fax webhook receiver (HMAC, dedupe), folder watcher, field extraction, patient matcher, document-type mapping, review screen, smoke tests. Filing disabled.
2. Confirm `SaveDocumentImage` and `SaveTask` formats; with Ali's approval, file one test PDF to a sandbox test patient and read it back with `GetDocuments`.
3. Pilot in `review` mode on IKI faxes (staff click to file), measure match accuracy. Synthetic bench and current numbers: `INTAKE_ACCURACY.md` (0 wrong-patient auto-files in 4,000 synthetic documents; next is de-identified real IKI samples).
4. Turn on `auto` for document kinds and senders that reached the agreed accuracy.
