# Fax / lab intake: accuracy on synthetic documents

Status Oct 11, 2026, branch `drawbridge/fax-intake`. Offline test bench: no Veradigm call, no real patient data, and OCR runs in our own container.

## Summary

| | Before | After |
|---|---:|---:|
| **Wrong-patient auto-files** (must be 0) | **5** in 4,000 docs | **0** in 4,000 docs |
| Auto-filed (seed 2002, 2,000 docs) | 16.4% | 41.5% |
| Auto recall (auto-filed when the rules say it should be) | 34.1% | 87.0% |
| Decision = expected | 54.9% | 89.5% |
| Mean field accuracy (8 fields) | 78.0% | 96.0% |

- Every wrong-patient auto-file from the original code was a **multi-patient daily batch fax**. The whole fax would have gone into one patient's chart, along with other patients' results. Both causes are fixed (see [Safety failures](#safety-failures-found-and-fixed)).
- Everything that is not auto-filed goes to staff review. None of it is lost or guessed: no document for a patient outside the roster, no true duplicate, and no document with a wrong MRN was auto-filed.
- These are **synthetic** documents in six layouts we wrote ourselves. Field accuracy on real IKI faxes will be lower until we measure on de-identified real samples (see [Next steps](#next-steps)). The safety mechanisms carry over better than the field numbers do.

## Method

```
tools/intake-synth  ──► docs/*.tif|pdf + truth/*.json + roster.json   (deploy/local/intake/synth/, git-ignored)
deploy/ocr (batch)  ──► ocr/*.txt + ocr/*.json                         (Tesseract 5.5, no network)
npm run eval:intake ──► report.md, summary.json, rows.jsonl           (real extract.ts + match.ts)
```

1. **Generator** (`tools/intake-synth`, seeded):
   - Roster of 300 invented patients, each with both Veradigm MRNs (PM MRN and EHR chart MRN / PatientNumber) and phones. Hard cases are built in: same name with a different DOB, true duplicates, sound-alike surnames, hyphen, apostrophe and two-word surnames, twins, and households sharing a phone. A pool of people not in the roster holds some who share a roster patient's full name.
   - Six fictional layouts: reference lab, hospital lab, small clinic, daily batch (the "Express Lab" stand-in), renal ultrasound and consult letter. Content is nephrology panels with ranges and H/L/critical flags.
   - About 35% of faxes start with a cover sheet.
   - Quality: 20% clean text-layer PDFs (emailed). The rest are fax copies: 35% fine (204x196 dpi), 33% standard (204x98), 12% poor (204x98 with heavy speckle, ±3° skew and streaks). They are saved as G4 or G3 TIFF or as image-only PDF, with a fax header line.
2. **Ground truth** per document: the intended patient, plus the **expected decision**, which is the matching rules applied to what is actually printed. A document for patient A that prints a wrong MRN is expected to go to `review`. A batch naming two patients is expected to be `ambiguous`.
3. **OCR**: every document goes through the `deploy/ocr` container in batch mode. 1,000 documents (1,385 pages) take 70 s on 28 workers. The median is 1–2 s per document on one core, and mean Tesseract confidence on fax images is 84.6.
4. **Harness** (`src/scripts/eval-intake.ts`):
   - Runs the production `extractFields()` and `matchPatient()`, so the real `decideMatch()`, on the OCR text.
   - Patient lookup goes through an in-memory fake of `unity_search_patients`. It returns the same shape as the real tool and mimics the EHR search: DOB exact, a two-letter name prefix, hyphenated names found, and both MRNs returned.
   - The pipeline's OCR-confidence gate is applied as well.
   - A **wrong-patient auto-file** is an `auto` decision for any chart other than the intended patient's. That includes any auto-file of a multi-patient document or of a patient outside the roster.
5. **Sets**:
   - **Seed 42** (1,000 docs) was the development set: the fixes were made looking at it.
   - **Seed 1001** (1,000 docs) was held out until it exposed the second batch failure. After that fix it no longer counts as clean.
   - **Seed 2002** (2,000 docs) was held out for safety. It was used once, to find a recall bug: the loose MRN-label check matched the phrase "medical renal disease". Its wrong-patient count was 0 before that fix and after it.
   - "Before" is the scaffold's `extract.ts`/`match.ts` (commit `6eacda4`) on the same OCR text, without the OCR gate.

## Results

### Overall

| Set | Docs | Wrong-patient auto | Auto-filed | Needs review | Auto recall | Decision = expected |
|---|---:|---:|---:|---:|---:|---:|
| seed 42 (dev): before → after | 1,000 | **1 → 0** | 14.5% → 41.0% | 85.5% → 59.0% | 29.9% → 85.8% | 52.6% → 90.0% |
| seed 1001: before → after | 1,000 | **2 → 0** | 14.7% → 41.6% | 85.3% → 58.4% | 29.7% → 85.8% | 52.6% → 88.9% |
| seed 2002: before → after | 2,000 | **2 → 0** | 16.4% → 41.5% | 83.7% → 58.5% | 34.1% → 87.0% | 54.9% → 89.5% |

"Needs review" counts review, none and ambiguous. No document ended `failed`: no OCR or search errors occurred in these runs. About 48% of documents are expected to auto-file. The rest are expected to need a person: no second identifier, an MRN conflict, a patient not in the roster, duplicates, or multi-patient documents.

### Field accuracy (seed 2002)

A field counts as right when the value the matcher would use (high or medium confidence) equals what is printed, or when nothing is printed and nothing is extracted.

| Field | Before | After |
|---|---:|---:|
| Patient name | 71.7% | 93.0% |
| Date of birth | 94.2% | 94.8% |
| MRN | 91.8% | 95.3% |
| Patient phone | 87.1% | 96.8% |
| Sender | 37.8% | 95.3% |
| Collection / service date | 78.7% | 96.0% |
| Document kind | 81.0% | 99.8% |
| Abnormal / critical flags | 81.5% | 97.2% |

### Decisions (seed 2002, after; rows = expected, columns = actual)

| expected \ actual | auto | review | none | ambiguous |
|---|---:|---:|---:|---:|
| **auto** (954) | **830** | 28 | 94 | 2 |
| **review** (715) | 0 | 639 | 74 | 2 |
| **none** (175) | 0 | 0 | 175 | 0 |
| **ambiguous** (156) | 0 | 1 | 8 | 147 |

The only cell that would be unsafe is a non-auto row landing in the auto column, and every such cell is 0. Every miss falls toward review.

### By layout (seed 2002: before → after)

| Layout | Docs | Mean field acc. | Decision = expected | Auto-filed | Auto recall | Wrong-patient auto |
|---|---:|---:|---:|---:|---:|---:|
| reference lab | 417 | 84.5% → 97.0% | 67.4% → 94.2% | 34.5% → 60.4% | 53.1% → 93.0% | 0 → 0 |
| hospital lab | 328 | 86.5% → 96.3% | 69.8% → 87.5% | 21.0% → 35.7% | 49.3% → 83.6% | 0 → 0 |
| small clinic | 291 | 75.4% → 98.7% | 52.2% → 95.9% | 9.6% → 47.4% | 18.8% → 92.6% | 0 → 0 |
| daily batch ("Express Lab") | 353 | 49.9% → 89.7% | 11.9% → 80.5% | 3.7% → 41.9% | 5.7% → 77.1% | **2 → 0** |
| renal ultrasound | 275 | 88.0% → 97.8% | 65.8% → 90.9% | 22.5% → 42.9% | 47.0% → 89.4% | 0 → 0 |
| consult letter | 336 | 85.1% → 97.2% | 63.1% → 88.7% | 3.3% → 17.0% | 15.7% → 81.4% | 0 → 0 |

### By fax quality (seed 2002: before → after)

| Quality | Docs | Mean field acc. | Decision = expected | Auto recall | Wrong-patient auto |
|---|---:|---:|---:|---:|---:|
| text-layer PDF (emailed) | 403 | 78.2% → 99.5% | 69.7% → 100.0% | 44.2% → 100.0% | 0 → 0 |
| fine fax 204x196 | 706 | 83.0% → 99.2% | 56.8% → 98.3% | 37.6% → 98.0% | 2 → 0 |
| standard fax 204x98 | 674 | 74.9% → 92.8% | 47.5% → 79.5% | 27.8% → 75.3% | 0 → 0 |
| poor fax | 217 | 70.8% → 89.1% | 43.8% → 72.8% | 25.0% → 64.4% | 0 → 0 |

### Hard cases (seed 2002, after)

| Case | Docs | Decision = expected | Auto-filed | Wrong-patient auto |
|---|---:|---:|---:|---:|
| not in roster | 154 | 100% | 0% | 0 |
| true duplicates (same name + DOB) | 66 | 93.9% | 0% | 0 |
| wrong MRN on the document | 128 | 90.6% | 0% | 0 |
| multi-patient batch | 58 | 94.8% | 0% | 0 |
| same name, different DOB | 81 | 88.9% | 59.3% | 0 |
| sound-alike surnames (Beasley/Beesly) | 76 | 86.8% | 53.9% | 0 |
| hyphen / apostrophe | 78 | 88.5% | 64.1% | 0 |
| two-word surnames | 25 | 84.0% | 56.0% | 0 |
| twins (same last name, DOB, phone) | 36 | 91.7% | 19.4% | 0 |
| households (shared phone) | 40 | 90.0% | 55.0% | 0 |
| outdated phone | 12 | 91.7% | 0% | 0 |
| DOB typo | 21 | 100% | 0% | 0 |
| no MRN | 238 | 87.8% | 26.9% | 0 |

## Safety failures found and fixed

1. **Multi-patient fax auto-filed to one patient** (seed 42, `D00837`). A daily batch fax had results for several patients, and its cover sheet named the first one. The first patient's name, DOB and Patient ID matched, so the matcher auto-filed the whole fax. The other patients' results would have landed in that chart.
   *Fix:* `extract.ts` now counts the distinct patients on a document (`patient_count`), and `match.ts` returns `ambiguous` ("split it and file each part by hand") when there is more than one. Labelled names and DOBs are clustered so OCR noise in a repeated header doesn't count as a second person.
2. **The same failure when OCR loses the labels** (seed 1001, `D00747`, poor fax). OCR read `PT:` as `Pri` and `DOB` as `NOB`, so the first patient's name and DOB were invisible, and the fax was auto-filed to the second patient.
   *Fix:* distinct MRN values (one OCR edit allowed) also count toward `patient_count`. Digits that OCR split with a space (`005696 14`) are joined, so a repeated page header is not a second patient.
3. **Phone standing in for an MRN OCR couldn't read** (seed 42, `D00611`). The document printed a *wrong* MRN, OCR read its label as `Med Ree #`, and the matcher fell back to the phone and auto-filed. This time it was the right patient, but the rule had been bypassed.
   *Fix:* when anything that looks like an MRN label is printed but no MRN is read (`mrn_unreadable`), the phone is not used and the document goes to review. The label pattern also tolerates `Ree`. The first version of this check also matched "medical renal disease" in ultrasound findings, which sent good imaging reports to review. Fixed: "Med Rec" must be followed by `#`, `No`, `Num` or a colon.
4. **Defence in depth: OCR-confidence gate.** OCR text with a mean confidence below `INTAKE_OCR_MIN_CONFIDENCE` (default 60) is never auto-matched. On seed 42, only 17% of documents under 60 had both name and DOB right. No auto-match fell there, so the gate costs nothing today and covers garbage scans.
5. Not patient safety, but clinical: the line "Critical values are telephoned to the ordering client" was flagged as a critical result, and "RE: Report attached" was read as a patient name. Both are fixed.

The safety rules are unchanged: never auto-file on one identifier, never choose between two patients. Each fix only moves documents from auto to review.

## Other changes behind the numbers

- **Either MRN agrees.** Veradigm keeps a PM MRN and an EHR chart MRN (PatientNumber), and outside documents carry either. Before, an EHR MRN on the document read as an MRN *conflict*. This was the largest single cause of missed auto-files.
- OCR punctuation: `;` `!` `,` `.` read in place of `:`; `D,O.B.` and `D0B`; `Patient 1D`; `Collactad`; O/0 and l/1 inside numbers.
- Batch labels `PT:` and `COLL:`. A plain `Phone:` counts as the patient's only inside the patient block. Surname particles are handled (Van Wyk, De La Cruz).
- Sender comes from the cover sheet "From:" or the letterhead, never the fax machine header or the receiving practice (`INTAKE_PRACTICE_NAME`).
- Lab units and "batch/test results" mark lab results. `*H`, `(C)`, `(A)` and a lone `A` column count as abnormal flags.
- OCR settings were chosen on 452 standard and poor faxes: PSM 6, despeckle, blur and 300 dpi gave the best decisions. PSM 3/4, no blur and 400 dpi were slightly worse. Without despeckle, mean confidence fell under the gate on most noisy faxes.

## What still fails, and why

On seed 2002, 124 of the 954 documents that should auto-file did not. 117 of them are standard or poor faxes:

| Cause | Docs | Outcome |
|---|---:|---|
| Name or DOB misread or unlabelled (e.g. "Rernard", "Iral", a year digit, `PT:` read as `Pri`) | 94 | `none`: no match, staff pick the patient |
| MRN or phone digit misread → conflict | 27 | `review` with the candidate shown |
| False "two patients" (a header misread differently on two pages) | 2 | `ambiguous` |
| OCR confidence under the gate | 1 | `review` with the candidate shown |

- **The daily batch layout is the weakest** (77% auto recall). It uses small Courier type, and at 98 dpi vertical OCR loses characters in names and dates.
- **Standard and poor faxes** reach 64–75% auto recall, against 98% for fine faxes and 100% for emailed PDFs.
- **Consult letters** auto-file only 17% of the time, because they rarely print an MRN or patient phone. That is correct: they need a person.
- **Hospital labs that print their own MRN** (`H…`) always conflict, so they go to review by design.
- **Twins whose first names share a prefix** (Daniel / Danielle) are `ambiguous` by design.

## Limits of this test

- The six layouts are ours, and the extractor has been tuned against them. Real faxes add logos, stamps, handwriting, tables with ruled lines, rotated pages, several documents per fax, and senders we have never seen. Expect lower field accuracy on real traffic. The safety logic (multi-patient detection, unreadable MRN, OCR gate, two-identifier rule) does not depend on layout.
- The fake search mirrors the EHR behaviour we know. The real `unity_search_patients` rows must carry **both** MRNs (PM MRN and EHR PatientNumber) for the either-MRN rule to work in production. `toCandidates` already reads `mrn`, `patientNumber`, `chartMrn`, `ehrMrn` and `pmMrn`.
- Multi-patient detection needs at least one readable identifier for each extra patient. A batch where every label of the second patient is unreadable would still look like one patient. See the next steps: batch senders should never be auto-filed.

## Next steps

1. **Real de-identified IKI samples.** Collect 200–500 real faxes (labs, imaging, consults, Express Lab batches) on MOATiT infrastructure under the BAA, label them with the same truth schema, and run `eval:intake` on them. This is the go/no-go input for `INTAKE_FILING=review` and later `auto`.
2. **Sender policy before `auto` mode.** Senders that send batch reports (Express Lab) should be "never auto". Add per-sender settings keyed by sending fax number (MOATiT Fax `sender_fax`) and layout.
3. **Better OCR for small type on standard faxes.** Fine-tune Tesseract on fax fonts, or evaluate a stronger local engine (docTR, PaddleOCR) in the same container slot. Measure each with this harness; the target is standard-fax auto recall at or above 85%.
4. **A fine-tuned or local model for field extraction** (a layout-aware model, or the local LLM already in the MOATiT Fax stack with constrained JSON output). `decideMatch` and the safety rules stay as the gate.
5. **Ask labs to echo IKI's MRN** (client patient ID) on orders. MRN is the strongest second identifier, and consults and hospital labs often lack it.
6. **Review-mode helpers.** When name or DOB can't be read but the MRN can, search by MRN and *suggest* the candidate to staff. This would be review only, never auto.

## How to run

```
docker build -t drawbridge-intake-synth tools/intake-synth
docker build -t drawbridge-intake-ocr deploy/ocr
cd deploy/local/intake/synth          # git-ignored
docker run --rm --network none -v "$PWD:/out" drawbridge-intake-synth generate --roster 300 --docs 2000 --seed 2002 --out /out/set-s2002
docker run --rm --network none -v "$PWD/set-s2002/docs:/in:ro" -v "$PWD/set-s2002/ocr:/out" drawbridge-intake-ocr batch /in /out --workers=8
cd ../../../..
npm run eval:intake -- --set deploy/local/intake/synth/set-s2002 --label after   # exit 1 if any wrong-patient auto-file
```

On Windows Git Bash, prefix the `docker run` commands with `MSYS_NO_PATHCONV=1` and use `$(pwd -W)`.
