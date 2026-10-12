# Fax / lab intake: accuracy on synthetic documents

Status Oct 11, 2026, branches `drawbridge/fax-intake` and `drawbridge/fax-intake-accuracy` (newest section first). Offline test bench: no Veradigm call, no real patient data, and OCR runs in our own container.

## Accuracy work: more auto-filing, still no wrong patient (Oct 11, branch `drawbridge/fax-intake-accuracy`)

Goal: file more of the documents that belong to a known patient, with **0 wrong-patient filings**. Four changes, each measured on its own: a second OCR reading of the patient lines, field consensus and checks, sender templates, and an optional name + DOB rule (off by default; the clinic decides). **Everything here is synthetic** (invented patients, our own six layouts, our own fax degradation). Real faxes will read worse; the safety checks carry over better than the recall numbers.

### Headline (held-out seed 6006, 3,000 fresh documents)

Every document goes through what the pipeline does: page check and split, match, OCR gate. A document counts as filed when **every result page** went to a chart. "Fileable" documents are the ones the default rule should file completely (every page belongs to a roster patient whose name, DOB and a second identifier are printed and readable to a person). The seed was generated after the OCR variants were chosen on seed 5005; nothing was changed after looking at it.

| Step (seed 6006) | Rule | Fileable-doc recall | Auto-filed (all docs) | **Wrong-patient pages** | Never-auto docs filed | Recall: text PDF | fine | standard | poor | Batch lab |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **Before** (base-branch code and OCR) | default | 84.3% (1,241/1,472) | 41.4% | **0** | 1 | 99.4% | 96.6% | 72.8% | 54.4% | 66.1% |
| + field consensus and checks | default | 84.4% | 41.5% | **0** | 1 | 99.4% | 96.6% | 73.0% | 55.0% | 66.1% |
| + sender template (extraction side) | default | 84.7% | 41.6% | **0** | 1 | 99.4% | 96.6% | 73.6% | 55.6% | 67.2% |
| field consensus + OCR header pass | default | 87.4% | 42.9% | **0** | 0 | 99.4% | 98.6% | 77.4% | 61.4% | 67.2% |
| **After** (all changes, default rule) | default | **87.7%** (1,291/1,472) | 43.0% | **0** | **0** | 99.4% | 98.6% | 78.0% | 62.6% | 68.6% |
| After, with `INTAKE_MATCH_RULE=name_dob` | name_dob | 87.5% (1,582/1,808) | **52.7%** | **0** | **0** | 99.5% | 98.5% | 78.1% | 61.2% | 67.5% |

- **Wrong-patient pages filed: 0** in every row, also page by page (4,264 result pages; no document or split part filed with another patient's page). Under name_dob as well.
- The one "never-auto" document filed before is `D01104`: twins Daniel and Danielle Underwood share name prefix and DOB, so by the rules the document is ambiguous; OCR read "DANIELM", which matches only Daniel, and the MRN agreed. Right patient (the MRN's owner), but the "never choose between two patients" rule was side-stepped by an OCR artefact. After the changes the same fax reads "Patlent Name:", so it goes to staff; that is luck too. The quirk sits in the default decision table (`decideMatch`, unchanged here): a garbled first name that agrees with only one twin, plus that twin's MRN, files to that twin. Worth a look by whoever owns the default rule.
- The whole-document match alone (no page check) would still auto-decide 5 multi-patient batches (6 before); the pipeline never files those because the page check runs first (above). Unchanged by this work.

**By fax quality** (seed 6006, default rule, documents):

| Quality | Docs | Should be filed | Filed right, before → after | Recall, before → after | Auto-filed (all docs), before → after |
|---|---:|---:|---:|---:|---:|
| text-layer PDF | 616 | 315 | 313 → 313 | 99.4% → 99.4% | 50.8% → 50.8% |
| fine fax | 1,037 | 494 | 477 → 487 | 96.6% → 98.6% | 46.0% → 47.0% |
| standard fax | 983 | 492 | 358 → 384 | 72.8% → 78.0% | 36.4% → 39.1% |
| poor fax | 364 | 171 | 93 → 107 | 54.4% → 62.6% | 25.8% → 29.4% |

**By layout** (should be filed: before → after filed right): reference lab 361 → 369 of 387; hospital lab 175 → 195 of 212; small clinic 197 → 201 of 219; imaging 185 → 192 of 202; consult letter 89 → 91 of 98; daily batch 234 → 243 of 354.

**Field accuracy** (seed 6006, before → after): name 92.4% → 93.4%, DOB 93.7% → 96.0%, MRN 93.9% → 96.7%, phone 94.8% → 95.5%. Expected-auto documents not auto-matched (whole-document decision): 181 → 135 of 1,358; name or DOB unreadable 147 → 111, an MRN or phone digit misread 28 → 19.

### Fileable and never-auto documents (seed 6006)

| Class (from the truth only) | Docs | Default rule: filed right | name_dob: filed right | Wrong-patient pages |
|---|---:|---:|---:|---:|
| **Fileable** (name + DOB + a second identifier, readable to a person) | 1,472 | 1,291 (87.7%) | 1,291 (87.7%) | 0 |
| **One identifier only** (exact name + DOB, nobody similar, no MRN or phone printed) | 336 | 0 (by design) | 291 (86.6%) | 0 |
| **Should never auto-file** | 1,179 | 0 | 0 | 0 |
| Mixed (a batch where some patients are fileable and others not) | 13 | 0 whole (some parts) | 0 whole | 0 |

Never-auto documents, none of which had any page auto-filed under either rule: not in the roster 210, wrong MRN 152, the sender's own MRN (conflicts with ours) 132, true duplicates (same name and DOB) 115, DOB typo 41, outdated phone 47, several roster patients match (twins, prefix names) 47, blotted identifiers 4, multi-patient batches that can't be split safely 84, and 347 one-identifier documents that don't qualify even for name_dob (a weak "RE:"/"Name:" label, a similar name nearby, a first name that only starts the chart name).

### What each change did

**1. OCR header pass** (`deploy/ocr`). The lines that carry patient identifiers are read a second time when a word on them is weak (under 93) or a field fails a check (a DOB label without a valid calendar date after it, a label with nothing after it), and always for a sender template's header lines. Each line is cut out on its own (its words' boxes plus a white border, so neighbouring lines never leak in), enlarged 2x and read four ways: plain and smoothed with Debian's tessdata_fast model, at its own scale and enlarged with tessdata_best. The first pass and the four readings are merged by a confidence-weighted character vote (ROVER). A merge far from the first pass, or one that loses a valid date, is dropped. This is the change that moved the numbers: fileable recall +3.0 points on seed 6006, standard faxes +4.4, poor +6.4.

**2. Field consensus and checks** (`extract.ts`). The name, DOB and MRN read most often across the document's pages win (ties keep the first read, as before), and `reads_agree` records any disagreement. "Bernard P, Colfax" (a middle initial's period read as a comma) is First M. Last. An MRN- or phone-like number in the patient block that wasn't read as the MRN or patient phone sets `unread_identifier`; an MRN-like one also stops the phone from standing in for the MRN (like an unreadable MRN label). That last check is a **tightening of the default rule**: on seed 5005 it cost 4 documents of recall and removed the only document filed although the rules said review (a wrong MRN OCR missed, then the phone matched). Alone, the consensus changed little on synthetic sets: most misreads are on documents where the patient appears once.

**3. Sender templates** (`templates.ts`, `deploy/ocr/templates/`). See [Sender templates](FAX_INTAKE_ADDON.md#sender-templates). On the synthetic daily batch (`sawtooth-rapid-lab.json`): labels OCR mangles are read anyway ("PTt", "PT!", "PATLENT 1D!", "DOB:" with no space after it), "SCHMITT ALMA" without its comma is Schmitt, Alma, only the batch's two date formats are accepted, an MRN that isn't 5-8 digits is unreadable (never matched), and the OCR container always re-reads those lines with upper-case letters, digits and `: , . ' - / # ( )` only. Gain on seed 6006: batch-lab documents filed 234 → 243 of 354 with all changes (67.2% → 68.6% on top of the header pass), batch-lab pages filed 569 → 591 of 890 that should be. Honest reading: **the template is not what limits the batch lab**. Its misses are DOB and name digits/letters lost in 8.5 pt Courier at 98 dpi (OCR), and batches whose pages the rules send to staff (blotted lines, packed pages). The template mechanism is there for Express Lab's real layout, which we haven't seen.

**4. Optional rule `INTAKE_MATCH_RULE=name_dob`** (`match.ts`, off by default). See [Optional rule: name + DOB](FAX_INTAKE_ADDON.md#optional-rule-name--dob). On seed 6006 it would raise the share of documents auto-filed from **43.0% to 52.7%** (+291 one-identifier documents: reference labs, imaging reports, batch-lab pages, hospital labs and small clinics that print no MRN or phone of ours; consult letters gain nothing because their patient line is "RE:"), with **0 wrong-patient pages** and no never-auto document filed. Recall on the documents it should file stays at 87.5%. What it can't see, and the bench doesn't contain: a document about someone who is **not** our patient but has exactly the name and DOB of one of ours, with no MRN on it.

### OCR options (dev seed 5005, 900 standard and poor faxes re-read; other documents as before)

All with the final extraction code, default rule, no template. Seconds per page are measured with ~20 jobs sharing 32 cores (other workloads were running); single-worker numbers below.

| OCR | Fileable-doc recall | Standard | Poor | Wrong-patient pages | s/page (contended) | Image |
|---|---:|---:|---:|---:|---:|---:|
| Tesseract 5.5, tessdata_fast, first pass only (**before**) | 86.7% | 74.6% | 65.7% | 0 | 1.3 | 667 MB |
| tessdata_best, first pass only | 84.1% | 67.5% | 64.2% | 0 | 3.1 | 695 MB |
| fast + header pass v1 (crops with neighbours, plain vote) | 85.0% | 75.8% | 50.0% | 0 | n/m | |
| best + header pass v1 | 82.5% | 67.2% | 53.0% | 0 | n/m | |
| fast + header pass: plain, smooth, orig@best | 88.7% | 80.0% | 67.9% | 0 | 5.3 | 695 MB |
| **fast + header pass: plain, smooth, orig@best, plain@best (chosen)** | **89.4%** | **81.5%** | **69.4%** | 0 | 6.5 | **695 MB** |
| fast + header pass: 6 variants | 88.9% | 80.9% | 67.2% | 0 | 8.0 | 695 MB |
| docTR (OnnxTR, onnxruntime CPU; same preprocessing) | 87.5% | 76.1% | 67.9% | 0 | 9.9 | 1.56 GB |
| PaddleOCR 3 (PP-OCRv5 det + English rec, paddlepaddle CPU; same preprocessing) | 86.2% | 72.8% | 66.4% | 0 | 22.4 | 2.48 GB |

- **Chosen: Tesseract with the header pass**, in the same container, CPU only, no network at run time (the best model is baked in, pinned by checksum). Image 695 MB (667 MB before).
- **Speed, one worker, same 40 standard/poor faxes (73 pages): 1.27 → 2.98 s/page** (median document 1.5 → 4.0 s). Fine faxes trigger fewer re-reads; text-layer PDFs cost nothing extra. At `OCR_CONCURRENCY=2` that is about 40 standard-fax pages a minute, ample for a clinic's daily fax volume.
- tessdata_best is worse than tessdata_fast as a first pass on these faxes, but it errs differently, which is what makes it useful as a voter.
- The first header-pass version cropped lines with a margin that caught the neighbouring line ("Patient: Rirthdatar EVELYN 01/12/1Q7A INGRAM") and voted without weights; it hurt poor faxes badly. Tight crops, confidence weights and the sanity checks fixed that.
- Neural engines: docTR was better than Tesseract's first pass but worse than the header pass, slower than it (9.9 vs 6.5 s/page under the same load) and more than twice the image. PaddleOCR was no better than the first pass, 3.4x slower than the header pass and 3.6x the image. CPU time per page on one core: docTR 7.2 s, PaddleOCR 18.9 s (its detector already capped at 1,600 px; uncapped about 70 s), against 2.98 s for the chosen option. Their models are not tuned for 98 dpi fax type either.

### What still fails

On seed 6006, 135 of 1,358 expected-auto documents (whole-document decision) were not auto-matched; 128 are standard or poor faxes. 111 have a name or DOB that OCR could not read (staff pick the patient), 19 an MRN or phone digit misread (staff confirm the candidate shown). Poor faxes still file 62.6% of the time, standard 78.0%, fine 98.6%, text PDFs 99.4%. **"Near 100%" holds only for emailed PDFs and fine faxes.** For standard and poor faxes the remaining lever is the image itself (MOATiT Fax receiving in fine mode where the sender supports it) or an OCR model trained on fax type; every miss goes to staff, never to a guess.

Production note: faxes that arrive through MOATiT Fax come with MOATiT Fax's own OCR text, and the pipeline uses that text. The header pass and templates only help those faxes with `INTAKE_OCR_FAX=local` (opt-in): the fax image is then read by our container too and its text is used (MOATiT Fax's text is kept if our read fails).

## Summary (scaffold → first accuracy pass, seed 2002)

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

## Batch faxes: split by patient (Oct 11, branch `drawbridge/fax-intake-batch`)

The daily batch file from IKI's lab (Express Lab; "Sawtooth Rapid Lab" in the synthetic set) now auto-files, one document per patient. Design: `FAX_INTAKE_ADDON.md`, [Batch faxes](FAX_INTAKE_ADDON.md#batch-faxes-one-document-per-patient). The bench scores it **page by page**: for every page, which chart it went to (or staff) against the patient whose content is on it.

| 1,000 fresh documents, page by page | Seed 3003 (dev) | Seed 3004 (held out) |
|---|---:|---:|
| Result pages | 1,438 | 1,408 |
| **Wrong-patient pages filed, after** (must be 0) | **0** | **0** |
| Wrong-patient pages filed, before with the stopgap (batch lab in `INTAKE_NO_AUTO_SENDERS`) | 0 | 0 |
| Wrong-patient pages filed, before without the stopgap (the blind spot) | 1 | 2 |
| Pages auto-filed: before → after | 379 → 580 | 405 → 587 |
| Page recall (filed where the rules say they should be): before → after | 54.3% → 83.1% | 58.3% → 84.5% |
| Page-level accuracy (outcome = the ideal one): before → after | 77.8% → 91.8% | 79.4% → 92.3% |
| **Batch lab only**: pages auto-filed, before → after | 2 → 178 of 485 | 7 → 159 of 467 |
| Batch lab only: page recall, before → after | 0.8% → 70.6% | 3.0% → 67.4% |
| Multi-patient files (batches with 2-6 patients, faxes with two reports) | 88 | 90 |
| ...split | 44 | 52 |
| ...split exactly as the truth (same page groups) / pages in the right part | 44 of 44 / 100% | 52 of 52 / 100% |

- "Before" is the code on `drawbridge/fax-intake` (whole-document match; multi-patient documents ambiguous) on the same OCR text. Every page it filed went to the right chart only because of the stopgap: without it, a two-patient batch whose second patient's labels are all blotted out is filed whole to the first patient (`D00695` in seed 3003). The stopgap itself let 2 and 7 batch-lab files through, because it only looked at the sender name as OCR read it (all to the right patient). `INTAKE_BATCH_SENDERS` also matches the name anywhere in the text and the sending fax number.
- Seed 3003 was looked at while building: three fixes came from it (a cover sheet whose "RE:" names the patient is still a cover; the same MRN read exactly on two pages is one patient even when the name is misread; a page with results above its patient line goes to staff). The last one fixed the only wrong-patient page "after" ever produced (`D00876`: a packed page that began with the end of one patient and then showed the next one). Seed 3004 was generated after all changes and run once.
- Whole-document numbers (fields, decisions) are unchanged by this work: `extract.ts` and `match.ts` were not touched. Seed 3003: decision = expected 90.7%, auto recall 87.4%; seed 3004: 91.0%, 88.6%.

**What goes to staff, and why** (both seeds, batch-lab and multi-patient files sent to review):

| Reason | Seed 3003 | Seed 3004 |
|---|---:|---:|
| A page with no readable identifier (continuation pages without the patient line, blotted lines, OCR loss) | 41 | 39 |
| A page with only a name or only a DOB (the rest misread) | 15 | 14 |
| Results above a page's patient line (packed pages) | 2 | 5 |
| A page shows two patients (packed pages) | 6 | 4 |
| Two pages almost, but not exactly, the same patient | 3 | 2 |
| Pages with different readable identifiers that can't be compared | 0 | 2 |

By layout style (seed 3004): one patient per page with the patient line repeated: 28 of 36 split, the rest to staff for OCR misses; no repeat on continuation pages, packed pages and blotted identifiers: all to staff, as the rules require. Faxes with two single-patient reports (other senders): 23 of 23 split. Single-patient batch files: 87 of 107 auto-checked as one patient on every page.

Two cases look odd but are safe: a page whose MRN is the only readable identifier and is misread short (`44824` for `446247`) counts as another patient, so the file is split and that page's part goes to staff (it can't be matched without name and DOB). And a split part is gated on its own pages' OCR confidence.

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
   **Per page** (sets made since the batch work): which patients' content is on each page, whether their identifiers are readable or blotted out, and the expected outcome under the page rules (filed to whom, or staff). Daily batches hold 2-6 patients, one or more pages each, in three styles: a new page per patient with the patient line repeated on continuation pages (65%), the same without the repeat (15%), packed several to a page (20%); 30% of the multi-patient fax copies have one page's or one whole patient's identifier lines blotted out. A separate case carries two single-patient reports in one fax.
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

## What still failed after the first pass (seed 2002; see the newest section for today)

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
- Multi-patient detection needs at least one readable identifier for each extra patient. A batch where every label of the second patient is unreadable would still look like one patient. For batch senders (`INTAKE_BATCH_SENDERS`) every page must now show its patient, which closes this on page boundaries. What page rules can't see: on a *packed* page (several patients per page), a second patient whose identifier lines are all unreadable, below the first patient's. A ruled-off block of results without a patient line is caught; a layout without separator lines would not be. Packed batch files almost always go to staff anyway (pages show two patients); confirm Express Lab starts each patient on a new page, and if it doesn't, keep it in `INTAKE_NO_AUTO_SENDERS` too.
- Other senders: an unlabelled continuation page goes with the patient before it (the agreed rule). A second patient whose every label is unreadable on a later page of a non-batch fax is the original blind spot, still open for those senders.

## Next steps

1. **Real IKI documents, in shadow mode.** Built on `drawbridge/fax-intake-shadow`: intake runs on MOATiT's IKI fax server under the BAA, files nothing, and takes its ground truth from where staff index each fax in Veradigm® EHR (staff filing observer) or from the Confirm panel. `npm run eval:shadow` gives the same safety number (wrong-patient auto-files) on real traffic. This is the go/no-go input for `INTAKE_FILING=review` and later `auto`. See `deploy/datacenter/README.md`.
2. **Sender policy before `auto` mode.** Done for batch reports: `INTAKE_BATCH_SENDERS` (name or sending fax number) with the per-page check and split; `INTAKE_NO_AUTO_SENDERS` stays as an "always staff" list. Next: run the page bench on de-identified real Express Lab files, and a staff "split by hand" screen for the files that go to review.
3. **Better OCR for small type on standard faxes.** Done in part (Oct 11): the header pass lifted standard faxes from 72.8% to 78.0% and poor from 54.4% to 62.6% (seed 6006); docTR and PaddleOCR were measured and not chosen. Next: fine-tune Tesseract on fax fonts with real de-identified headers, and `INTAKE_OCR_FAX=local` in shadow mode to compare with MOATiT Fax's OCR on real traffic. The target stays standard-fax recall at or above 85%.
4. **A fine-tuned or local model for field extraction** (a layout-aware model, or the local LLM already in the MOATiT Fax stack with constrained JSON output). `decideMatch` and the safety rules stay as the gate.
5. **Ask labs to echo IKI's MRN** (client patient ID) on orders. MRN is the strongest second identifier, and consults and hospital labs often lack it.
6. **Review-mode helpers.** When name or DOB can't be read but the MRN can, search by MRN and *suggest* the candidate to staff. This would be review only, never auto.

## Live sandbox run (Oct 11, 2026)

The same pipeline, running in the local Drawbridge stack, on 40 synthetic faxes about the 11 synthetic patients created in the Veradigm sandbox (owner-approved; generator `--roster-file`, seed 1011). Settings: `INTAKE_FILING=auto`, `INTAKE_DOC_STATUS=approved`, the batch lab in `INTAKE_NO_AUTO_SENDERS`.

| Outcome | Docs |
|---|---:|
| Auto-filed with `SaveScanDocument` + review task | 11 |
| ...to the right patient | **11** |
| ...found in the chart by `GetDocuments` (right category and clinical date) | 11 |
| Matched but held: batch sender set to staff review | 2 |
| Needs review (one match, no second identifier; wrong MRN) | 15 |
| No match (not in the sandbox, or name/DOB unreadable) | 10 |
| Ambiguous (more than one patient on the fax) | 2 |
| Failed | 0 |

Same-name patients (two "Harlan Quillfeather", different DOB) each got their own documents; hyphenated names matched; both batch faxes with two patients were held. Every miss went to staff, never to a guess. Sandbox documents 22604-22614, tasks 21709-21719.

## Live sandbox run: batch lab (Oct 11, 2026)

15 synthetic batch-lab faxes (the daily-batch layout, standing in for Express Lab) about the sandbox's synthetic patients, with `INTAKE_BATCH_SENDERS` set to that lab and splitting on. 11 single-patient files plus 4 multi-patient files (3 to 6 patients each).

| Outcome | Count |
|---|---:|
| Files split automatically into one part per patient | 2 (into 3 and 2 parts) |
| Documents filed (whole files and split parts) | 9 |
| ...to the right patient, checked page by page | **9** |
| ...found in the chart with the right page count | 9 |
| To staff: identical-looking patients on two pages, several patients on one page, a page without a readable identifier, wrong MRN, no match, one identifier only | 9 |

Sandbox documents 22615-22623, tasks 21722-21730. Running total of owner-approved sandbox writes: 11 synthetic patients, 23 documents, 22 tasks.

## How to run

```
docker build -t drawbridge-intake-synth tools/intake-synth
docker build -t drawbridge-intake-ocr deploy/ocr
cd deploy/local/intake/synth          # git-ignored
docker run --rm --network none -v "$PWD:/out" drawbridge-intake-synth generate --roster 300 --docs 2000 --seed 2002 --out /out/set-s2002
docker run --rm --network none -v "$PWD/set-s2002/docs:/in:ro" -v "$PWD/set-s2002/ocr:/out" drawbridge-intake-ocr batch /in /out --workers=8
cd ../../../..
npm run eval:intake -- --set deploy/local/intake/synth/set-s2002 --label after   # exit 1 if any wrong-patient auto-file
npm run eval:intake -- --set <set> --label nd --rule name_dob                     # the optional rule
npm run eval:intake -- --set <set> --label tpl --templates deploy/ocr/templates  # with sender templates
```

The accuracy-work numbers: `--seed 5005 --docs 2000` (dev; OCR options were chosen on it) and `--seed 6006 --docs 3000` (held out), `--roster 300`. "Before" ran the base branch's `extract.ts`, `match.ts`, `pages.ts` and `ocr.ts` under the same harness on the same OCR text. OCR images were built under their own tags and run with `--network none`; the header-pass variants are environment knobs of the one image (`deploy/ocr/README.md`).

On Windows Git Bash, prefix the `docker run` commands with `MSYS_NO_PATHCONV=1` and use `$(pwd -W)`.

The page-by-page section needs a set from the current generator and OCR output with per-page confidences (rebuild both images). The batch numbers above: `--seed 3003` and `--seed 3004`, 1,000 documents each, `--label batch`; the batch sender defaults to the synthetic "Sawtooth Rapid Lab" (`--batch-sender` to change it). Don't rebuild the images under the live stack's tags while it runs; any other tag works the same.
