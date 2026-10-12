# Intake OCR container

Tesseract 5 (English: Debian's tessdata_fast and tessdata_best, both in the image) + poppler, used by the document intake add-on (`src/platform/modules/intake/ocr.ts`) for dropped and uploaded files without a text layer. Documents are PHI: the service runs on the internal `drawbridge` Docker network with **no published ports**, makes no outbound calls, keeps each request in a private temp directory that is removed afterwards, and logs only method, path, status, size and time.

## Reading order

1. **PDF with a text layer** (emailed results): `pdftotext -layout`, no OCR. `mean_confidence` = 100.
2. **Images** (fax TIFF G3/G4, image-only PDF, PNG, JPEG), page by page:
   - native resolution (fax TIFFs carry 204x98 or 204x196 dpi; image PDFs are rendered at 300 dpi)
   - despeckle (specks away from text) and removal of fax streaks
   - upscale to 300 dpi (non-square fax pixels made square), deskew (±4°), light blur
   - `tesseract --oem 1 --psm 6 -c preserve_interword_spaces=1`, so `Patient Name: X      DOB: Y` stays two fields

3. **Header pass** (second reading of the patient lines). Lines that carry a patient label as OCR reads it (`PT:` `Patient` `Name` `DOB`/`D0B`/`NOB` `Birth` `MRN` `Med Rec` `Chart` `Phone` `RE:`) are read again when a word on them is under `OCR_HEADER_MIN_CONF` (93) or a field fails a check (a DOB label without a valid calendar date after it, a label with nothing after it), and always when they are a sender template's header lines. Each line is cut out on its own (its words' boxes, white border, so neighbouring lines never leak in), enlarged 2x and read in four variants: plain and smoothed with the fast model, the line at its own scale and enlarged with the best model. The first pass and the four readings are merged by a confidence-weighted character vote aligned on the most central reading (ROVER). The merge is dropped when it moved far from the first pass (more than a quarter of the line), and when it would lose a valid date; when the merge has no valid date but a reading does, that reading wins. Only those lines change; every character comes from one of the readings.
4. **Sender templates** (`templates/*.json`, plus `OCR_TEMPLATES_DIR`): the same files the intake module reads (`src/platform/modules/intake/templates.ts`). Here a template, recognised by its sender name in the page text (two OCR errors allowed), pins its header lines (`ocr.header_labels`, OCR-tolerant, or `ocr.header_region` as a band of the page) for the header pass and may restrict their characters (`ocr.whitelist`). `sawtooth-rapid-lab.json` is for the synthetic daily batch (stand-in for Express Lab).

On 452 standard and poor fax pages, PSM 6 with blur and despeckle was the best first pass of the variants tried (PSM 3/4, no blur, 400 dpi, no despeckle). On 900 standard and poor faxes (Oct 11), tessdata_best alone was **worse** than tessdata_fast as a first pass (it makes different mistakes), and the header pass with both models was the best option tried; docTR and PaddleOCR were tried in the same slot and lost on accuracy, speed and size. Numbers: `docs/drawbridge/INTAKE_ACCURACY.md`, [OCR options](../../docs/drawbridge/INTAKE_ACCURACY.md#ocr-options).

## API

| | |
|---|---|
| `POST /ocr` | body = file bytes → `200 {text, pages, mean_confidence, used_text_layer, page_texts, page_confidences}`; `400 {error: UNSUPPORTED_TYPE \| EMPTY_BODY}`, `413 TOO_LARGE \| TOO_MANY_PAGES`, `422 UNREADABLE_PDF \| UNREADABLE_IMAGE`, `500 OCR_FAILED \| OCR_TIMEOUT \| TESSERACT_FAILED`, `503 BUSY` |
| `POST /pages?select=2,3` | body = file bytes → `200` a new file holding only those pages, in that order, same format (PDF pages copied with `pdfseparate`/`pdfunite`, not re-rendered; TIFF frames kept, CCITT G4 for fax images, LZW otherwise; PNG/JPEG page 1 only). Header `X-Source-Pages` = pages in the input. `400 BAD_PAGES` (not strictly increasing from 1), `422 PAGE_OUT_OF_RANGE`, plus the `/ocr` errors. Used to split a batch fax into one file per patient. |
| `GET /health` | `{ok, tesseract}` |

`/ocr` also returns `engine` (`tesseract-<version>-<model>`) and `header_pass` (`{lines, reread, changed}`, plus `template` when a sender template matched); the intake module ignores both.

Pages are joined with a form feed in `text` (unchanged). `page_texts` holds one text per page of the file (`''` for a blank page; a text layer is split at pdftotext's form feeds, and if that doesn't give one piece per page, `page_texts` is the whole text as one entry so the count never matches by accident) and `page_confidences` the mean word confidence per page (100 for a text layer). `mean_confidence` is the mean Tesseract word confidence (0–100) over all words. Batch mode writes `page_confidences` into `<stem>.json`.

| Env | Default | |
|---|---|---|
| `OCR_PORT` | 8090 | listen port inside the container |
| `OCR_CONCURRENCY` | 2 | OCR jobs at once (one Tesseract thread each); others wait up to 5 min, then 503 |
| `OCR_MAX_MB` / `OCR_MAX_PAGES` | 25 / 40 | |
| `OCR_PSM`, `OCR_TARGET_DPI`, `OCR_BLUR`, `OCR_DESPECKLE` | 6, 300, 1, 1 | tuning knobs, for experiments only |
| `OCR_MODEL` | `fast` | first-pass model: `fast` or `best` |
| `OCR_HEADER_PASS` | 1 | `0` turns the header pass off (the old behaviour) |
| `OCR_HEADER_MIN_CONF` | 93 | a header line is read again when a word is under this; `101` = always |
| `OCR_HEADER_VARIANTS` | `plain,smooth,orig@best,plain@best` | variants of the header pass (`name[@model]`: plain, smooth, close, thick, thin, lanczos, orig) |
| `OCR_HEADER_SCALE` | 2.0 | enlargement of the header pass |
| `OCR_HEADER_MERGE` | `rover` | `medoid` takes the most central reading instead of a character vote |
| `OCR_TEMPLATES` / `OCR_TEMPLATES_DIR` | 1 / unset | `0` ignores templates; a folder of extra templates (mount read-only) |

Image: about 695 MB (667 MB before; +15 MB model). Speed: see [OCR options](../../docs/drawbridge/INTAKE_ACCURACY.md#ocr-options); one worker on standard and poor faxes: 1.27 s/page before, 2.98 s/page with the header pass; nothing extra on text-layer PDFs.

## Run

```
docker build -t drawbridge-intake-ocr deploy/ocr

# Batch: every PDF/TIFF/PNG/JPEG in IN -> OUT/<stem>.txt + <stem>.json (no network at all)
docker run --rm --network none -v <in>:/in:ro -v <out>:/out drawbridge-intake-ocr batch /in /out --workers=8
```

In the local stack it is the `ocr` service in `deploy/local/docker-compose.yml` (read-only root, tmpfs `/tmp`, all capabilities dropped); `unity` reaches it at `http://ocr:8090` (`INTAKE_OCR_URL`).
