# Intake OCR container

Tesseract 5 (English) + poppler, used by the document intake add-on (`src/platform/modules/intake/ocr.ts`) for dropped and uploaded files without a text layer. Documents are PHI: the service runs on the internal `drawbridge` Docker network with **no published ports**, makes no outbound calls, keeps each request in a private temp directory that is removed afterwards, and logs only method, path, status, size and time.

## Reading order

1. **PDF with a text layer** (emailed results): `pdftotext -layout`, no OCR. `mean_confidence` = 100.
2. **Images** (fax TIFF G3/G4, image-only PDF, PNG, JPEG), page by page:
   - native resolution (fax TIFFs carry 204x98 or 204x196 dpi; image PDFs are rendered at 300 dpi)
   - despeckle (specks away from text) and removal of fax streaks
   - upscale to 300 dpi (non-square fax pixels made square), deskew (±4°), light blur
   - `tesseract --oem 1 --psm 6 -c preserve_interword_spaces=1`, so `Patient Name: X      DOB: Y` stays two fields

On 452 standard and poor fax pages, PSM 6 with blur and despeckle was the best of the variants tried (PSM 3/4, no blur, 400 dpi, no despeckle). Without despeckling, mean confidence drops below the auto-match gate on most noisy faxes. See `docs/drawbridge/INTAKE_ACCURACY.md`.

## API

| | |
|---|---|
| `POST /ocr` | body = file bytes → `200 {text, pages, mean_confidence, used_text_layer, page_texts, page_confidences}`; `400 {error: UNSUPPORTED_TYPE \| EMPTY_BODY}`, `413 TOO_LARGE \| TOO_MANY_PAGES`, `422 UNREADABLE_PDF \| UNREADABLE_IMAGE`, `500 OCR_FAILED \| OCR_TIMEOUT \| TESSERACT_FAILED`, `503 BUSY` |
| `POST /pages?select=2,3` | body = file bytes → `200` a new file holding only those pages, in that order, same format (PDF pages copied with `pdfseparate`/`pdfunite`, not re-rendered; TIFF frames kept, CCITT G4 for fax images, LZW otherwise; PNG/JPEG page 1 only). Header `X-Source-Pages` = pages in the input. `400 BAD_PAGES` (not strictly increasing from 1), `422 PAGE_OUT_OF_RANGE`, plus the `/ocr` errors. Used to split a batch fax into one file per patient. |
| `GET /health` | `{ok, tesseract}` |

Pages are joined with a form feed in `text` (unchanged). `page_texts` holds one text per page of the file (`''` for a blank page; a text layer is split at pdftotext's form feeds, and if that doesn't give one piece per page, `page_texts` is the whole text as one entry so the count never matches by accident) and `page_confidences` the mean word confidence per page (100 for a text layer). `mean_confidence` is the mean Tesseract word confidence (0–100) over all words. Batch mode writes `page_confidences` into `<stem>.json`.

| Env | Default | |
|---|---|---|
| `OCR_PORT` | 8090 | listen port inside the container |
| `OCR_CONCURRENCY` | 2 | OCR jobs at once (one Tesseract thread each); others wait up to 5 min, then 503 |
| `OCR_MAX_MB` / `OCR_MAX_PAGES` | 25 / 40 | |
| `OCR_PSM`, `OCR_TARGET_DPI`, `OCR_BLUR`, `OCR_DESPECKLE` | 6, 300, 1, 1 | tuning knobs, for experiments only |

## Run

```
docker build -t drawbridge-intake-ocr deploy/ocr

# Batch: every PDF/TIFF/PNG/JPEG in IN -> OUT/<stem>.txt + <stem>.json (no network at all)
docker run --rm --network none -v <in>:/in:ro -v <out>:/out drawbridge-intake-ocr batch /in /out --workers=8
```

In the local stack it is the `ocr` service in `deploy/local/docker-compose.yml` (read-only root, tmpfs `/tmp`, all capabilities dropped); `unity` reaches it at `http://ocr:8090` (`INTAKE_OCR_URL`).
