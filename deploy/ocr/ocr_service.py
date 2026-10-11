"""
Drawbridge intake OCR: local Tesseract 5 for faxed and scanned documents.

Documents are PHI. This service makes no outbound calls, writes only to a private temp directory
that is removed after each request, and logs method, path, status, size and time, never content.

  serve                        HTTP on 0.0.0.0:$OCR_PORT (default 8090)
      POST /ocr                body = the file bytes (PDF, TIFF, PNG, JPEG)
                               200 {text, pages, mean_confidence, used_text_layer,
                                    page_texts, page_confidences}
                               400 unsupported type, 413 too large, 422 unreadable, 503 busy
      POST /pages?select=1,2   body = the file bytes; 200 = a new file holding only those pages, in
                               that order. PDF stays PDF (pages copied, not re-rendered), TIFF stays
                               TIFF (lossless). Header X-Source-Pages = page count of the input.
                               400 BAD_PAGES, 422 PAGE_OUT_OF_RANGE, plus the /ocr errors
      GET  /health             {ok, tesseract}
  batch IN_DIR OUT_DIR         every PDF/TIFF/PNG/JPEG in IN_DIR -> OUT_DIR/<stem>.txt + <stem>.json
      [--workers=N] [--force]

Reading order:
  1. PDF with a text layer (emailed results): pdftotext -layout, no OCR. mean_confidence = 100.
  2. Otherwise each page image is preprocessed for fax quality and read by Tesseract:
       native resolution (fax TIFFs carry 204x98 or 204x196 dpi; image PDFs are rendered at 300)
       -> despeckle (isolated specks away from text) and streak removal
       -> upscale to 300 dpi (non-square fax pixels made square)
       -> deskew (projection profile, +/-4 degrees)
       -> tesseract --oem 1 --psm $OCR_PSM -c preserve_interword_spaces=1
     Interword spaces are kept so "Patient Name: X      DOB: Y" stays two fields for the extractor.
  mean_confidence is the mean Tesseract word confidence (0-100) over all pages.

Per page: `text` joins the pages with a form feed, as before. `page_texts` has one entry per page of
the file ('' for a blank page) and `page_confidences` the mean word confidence of each page (100 for
a text layer, 0 for a page without words). The intake pipeline uses them to find which patient each
page belongs to, and /pages to split a batch fax into one file per patient.
"""
from __future__ import annotations

import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional

import cv2
import numpy as np
from PIL import Image, ImageSequence

Image.MAX_IMAGE_PIXELS = 120_000_000

MAX_BYTES = int(float(os.environ.get("OCR_MAX_MB", "25")) * 1024 * 1024)
MAX_PAGES = int(os.environ.get("OCR_MAX_PAGES", "40"))
PSM = os.environ.get("OCR_PSM", "6")
TARGET_DPI = int(os.environ.get("OCR_TARGET_DPI", "300"))
BLUR = os.environ.get("OCR_BLUR", "1") != "0"
DESPECKLE = os.environ.get("OCR_DESPECKLE", "1") != "0"
PAGE_TIMEOUT_S = 120
# A text layer counts when it carries at least this many letters/digits per page.
MIN_TEXT_LAYER_CHARS = 40


class OcrFailure(Exception):
    def __init__(self, code: str, status: int):
        super().__init__(code)
        self.code = code
        self.status = status


def sniff(data: bytes) -> str:
    if data[:4] == b"%PDF":
        return "pdf"
    if data[:4] in (b"II*\x00", b"MM\x00*"):
        return "tiff"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpeg"
    return ""


def run(cmd: list[str], timeout: int = PAGE_TIMEOUT_S) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, timeout=timeout, check=False)


def tesseract_version() -> str:
    r = run(["tesseract", "--version"], timeout=10)
    m = re.search(r"tesseract\s+v?([\d.]+)", (r.stdout + r.stderr).decode("utf-8", "replace"))
    return m.group(1) if m else "unknown"


# ── Preprocessing ────────────────────────────────────────────────────────────

def _despeckle(ink: np.ndarray, sx: float, sy: float) -> np.ndarray:
    """
    Remove specks that sit away from text. `ink` is 255 where black. Components up to ~0.25 mm^2
    are specks unless they are near a larger component (periods, colons, the dot of an i).
    Streaks: columns mostly ink, rows mostly ink (fax transmission lines) are cleared.
    """
    n, labels, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    if n <= 1:
        return ink
    # Speck size in pixels at this resolution (fax standard 204x98 ~ 4 px, 300x300 ~ 9 px).
    speck = max(2, int(round(9 * sx * sy)))
    areas = stats[:, cv2.CC_STAT_AREA]
    small = areas <= speck
    small[0] = False
    big_mask = np.isin(labels, np.nonzero(~small)[0][1:]).astype(np.uint8) * 255
    kx = max(3, int(round(9 * sx)) | 1)
    ky = max(3, int(round(7 * sy)) | 1)
    near = cv2.dilate(big_mask, np.ones((ky, kx), np.uint8)) > 0
    keep = np.zeros(n, dtype=bool)
    keep[np.unique(labels[near])] = True
    drop = np.nonzero(small & ~keep)[0]
    out = ink.copy()
    out[np.isin(labels, drop)] = 0
    h, w = out.shape
    cols = (out > 0).sum(axis=0) > 0.5 * h
    rows = (out > 0).sum(axis=1) > 0.6 * w
    out[:, cols] = 0
    out[rows, :] = 0
    return out


def _skew_angle(gray: np.ndarray) -> float:
    """Projection-profile skew estimate in degrees (positive = rotate counter-clockwise)."""
    small = cv2.resize(gray, None, fx=0.25, fy=0.25, interpolation=cv2.INTER_AREA)
    ink = (small < 160).astype(np.float32)
    if ink.sum() < 50:
        return 0.0
    h, w = ink.shape
    c = (w / 2, h / 2)

    def score(a: float) -> float:
        m = cv2.getRotationMatrix2D(c, a, 1.0)
        r = cv2.warpAffine(ink, m, (w, h), flags=cv2.INTER_NEAREST, borderValue=0)
        rows = r.sum(axis=1)
        return float(np.sum(np.diff(rows) ** 2))

    best = max(np.arange(-4.0, 4.01, 0.25), key=score)
    best = max(np.arange(best - 0.25, best + 0.26, 0.05), key=score)
    return float(best)


def preprocess(img: Image.Image, dpi: tuple[float, float]) -> Image.Image:
    """One page image (any mode) at `dpi` -> clean 8-bit grayscale at 300 dpi."""
    gray = np.array(img.convert("L"))
    xdpi, ydpi = dpi
    sx, sy = xdpi / TARGET_DPI, ydpi / TARGET_DPI
    _, ink = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    if DESPECKLE:
        ink = _despeckle(ink, sx, sy)
    clean = 255 - ink
    fx, fy = TARGET_DPI / xdpi, TARGET_DPI / ydpi
    if abs(fx - 1) > 0.05 or abs(fy - 1) > 0.05:
        clean = cv2.resize(clean, None, fx=fx, fy=fy, interpolation=cv2.INTER_CUBIC)
    angle = _skew_angle(clean)
    if abs(angle) >= 0.1:
        h, w = clean.shape
        m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
        clean = cv2.warpAffine(clean, m, (w, h), flags=cv2.INTER_CUBIC, borderValue=255)
    if BLUR:
        clean = cv2.GaussianBlur(clean, (3, 3), 0)
    return Image.fromarray(clean)


def page_dpi(img: Image.Image) -> tuple[float, float]:
    dpi = img.info.get("dpi")
    if dpi and len(dpi) == 2 and dpi[0] > 50 and dpi[1] > 50:
        return float(dpi[0]), float(dpi[1])
    w = img.size[0]
    if 1700 <= w <= 1760:  # fax width (1728 px) without a resolution tag
        ratio = img.size[1] / w
        return (204.0, 98.0) if ratio < 0.8 else (204.0, 196.0)
    return (300.0, 300.0) if w > 2000 else (200.0, 200.0)


# ── Tesseract ────────────────────────────────────────────────────────────────

def tesseract_page(img: Image.Image, work: str, n: int) -> tuple[str, list[float]]:
    src = os.path.join(work, f"p{n}.png")
    img.save(src, dpi=(TARGET_DPI, TARGET_DPI))
    base = os.path.join(work, f"p{n}")
    r = run(["tesseract", src, base, "-l", "eng", "--oem", "1", "--psm", PSM,
             "-c", "preserve_interword_spaces=1", "txt", "tsv"])
    if r.returncode != 0:
        raise OcrFailure("TESSERACT_FAILED", 500)
    with open(base + ".txt", encoding="utf-8", errors="replace") as f:
        text = f.read()
    confs: list[float] = []
    with open(base + ".tsv", encoding="utf-8", errors="replace") as f:
        next(f, None)
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 12 and parts[0] == "5" and parts[11].strip():
                try:
                    c = float(parts[10])
                except ValueError:
                    continue
                if c >= 0:
                    confs.append(c)
    return text, confs


def pdf_pages(path: str) -> int:
    r = run(["pdfinfo", path], timeout=30)
    m = re.search(rb"^Pages:\s+(\d+)", r.stdout, re.M)
    if r.returncode != 0 or not m:
        raise OcrFailure("UNREADABLE_PDF", 422)
    return int(m.group(1))


def page_mean(confs: list[float]) -> float:
    return round(float(np.mean(confs)), 1) if confs else 0.0


def layer_pages(layer: str, pages: int) -> list[str]:
    """pdftotext output -> one string per page (pdftotext ends every page with a form feed)."""
    parts = layer.split("\f")
    if len(parts) == pages + 1 and not parts[-1].strip():
        parts = parts[:-1]
    if len(parts) != pages:
        # Never guess page boundaries: the caller sees a count that does not match and does not split.
        return [layer]
    return [p.rstrip() for p in parts]


def ocr_bytes(data: bytes) -> dict:
    kind = sniff(data)
    if not kind:
        raise OcrFailure("UNSUPPORTED_TYPE", 400)
    if len(data) > MAX_BYTES:
        raise OcrFailure("TOO_LARGE", 413)
    work = tempfile.mkdtemp(prefix="ocr-")
    try:
        os.chmod(work, 0o700)
        texts: list[str] = []
        confs: list[float] = []
        page_confs: list[float] = []
        if kind == "pdf":
            src = os.path.join(work, "in.pdf")
            with open(src, "wb") as f:
                f.write(data)
            pages = pdf_pages(src)
            if pages > MAX_PAGES:
                raise OcrFailure("TOO_MANY_PAGES", 413)
            r = run(["pdftotext", "-layout", "-enc", "UTF-8", src, "-"], timeout=60)
            layer = r.stdout.decode("utf-8", "replace") if r.returncode == 0 else ""
            if len(re.findall(r"[A-Za-z0-9]", layer)) >= MIN_TEXT_LAYER_CHARS * pages:
                return {"text": layer, "pages": pages, "mean_confidence": 100.0, "used_text_layer": True,
                        "page_texts": layer_pages(layer, pages), "page_confidences": [100.0] * pages}
            r = run(["pdftoppm", "-r", str(TARGET_DPI), "-gray", "-png", src, os.path.join(work, "pg")], timeout=PAGE_TIMEOUT_S * 2)
            if r.returncode != 0:
                raise OcrFailure("UNREADABLE_PDF", 422)
            files = sorted((x for x in os.listdir(work) if x.startswith("pg") and x.endswith(".png")),
                           key=lambda x: int(re.sub(r"\D", "", x) or 0))
            for i, name in enumerate(files):
                with Image.open(os.path.join(work, name)) as im:
                    t, c = tesseract_page(preprocess(im, (TARGET_DPI, TARGET_DPI)), work, i)
                texts.append(t)
                page_confs.append(page_mean(c))
                confs += c
        else:
            try:
                im = Image.open(io.BytesIO(data))
                frames = [(f.copy(), page_dpi(f)) for f in ImageSequence.Iterator(im)]
            except Exception:
                raise OcrFailure("UNREADABLE_IMAGE", 422)
            pages = len(frames)
            if pages > MAX_PAGES:
                raise OcrFailure("TOO_MANY_PAGES", 413)
            for i, (frame, dpi) in enumerate(frames):
                t, c = tesseract_page(preprocess(frame, dpi), work, i)
                texts.append(t)
                page_confs.append(page_mean(c))
                confs += c
        page_texts = [t.rstrip() for t in texts]
        text = "\f\n".join(page_texts)
        mean = round(float(np.mean(confs)), 1) if confs else 0.0
        return {"text": text, "pages": pages, "mean_confidence": mean, "used_text_layer": False,
                "page_texts": page_texts, "page_confidences": page_confs}
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ── Page selection (one file per patient from a batch fax) ───────────────────

def parse_select(raw: str) -> list[int]:
    """'1,2,5' -> [1, 2, 5]. Strictly increasing page numbers from 1, at most MAX_PAGES of them."""
    if not re.fullmatch(r"\d{1,3}(?:,\d{1,3})*", raw or ""):
        raise OcrFailure("BAD_PAGES", 400)
    pages = [int(x) for x in raw.split(",")]
    if len(pages) > MAX_PAGES or pages[0] < 1 or any(b <= a for a, b in zip(pages, pages[1:])):
        raise OcrFailure("BAD_PAGES", 400)
    return pages


def select_pages(data: bytes, pages: list[int]) -> tuple[bytes, str, int]:
    """(new file, media type, page count of the input). Same format as the input; never re-OCRs."""
    kind = sniff(data)
    if not kind:
        raise OcrFailure("UNSUPPORTED_TYPE", 400)
    if len(data) > MAX_BYTES:
        raise OcrFailure("TOO_LARGE", 413)
    if kind in ("png", "jpeg"):
        if pages != [1]:
            raise OcrFailure("PAGE_OUT_OF_RANGE", 422)
        return data, "image/png" if kind == "png" else "image/jpeg", 1
    if kind == "tiff":
        try:
            im = Image.open(io.BytesIO(data))
            frames = [f.copy() for f in ImageSequence.Iterator(im)]
        except Exception:
            raise OcrFailure("UNREADABLE_IMAGE", 422)
        total = len(frames)
        if total > MAX_PAGES:
            raise OcrFailure("TOO_MANY_PAGES", 413)
        if pages[-1] > total:
            raise OcrFailure("PAGE_OUT_OF_RANGE", 422)
        chosen = [frames[p - 1] for p in pages]
        first = chosen[0]
        out = io.BytesIO()
        # Fax TIFFs are 1-bit: CCITT G4. Anything else: LZW. Both lossless; the resolution tag is kept
        # (fax pages share one resolution).
        first.save(out, format="TIFF", save_all=True, append_images=chosen[1:],
                   compression="group4" if first.mode == "1" else "tiff_lzw",
                   dpi=first.info.get("dpi") or page_dpi(first))
        return out.getvalue(), "image/tiff", total
    work = tempfile.mkdtemp(prefix="pages-")
    try:
        os.chmod(work, 0o700)
        src = os.path.join(work, "in.pdf")
        with open(src, "wb") as f:
            f.write(data)
        total = pdf_pages(src)
        if total > MAX_PAGES:
            raise OcrFailure("TOO_MANY_PAGES", 413)
        if pages[-1] > total:
            raise OcrFailure("PAGE_OUT_OF_RANGE", 422)
        parts = []
        for p in pages:
            dst = os.path.join(work, f"p{p}.pdf")
            r = run(["pdfseparate", "-f", str(p), "-l", str(p), src, dst], timeout=60)
            if r.returncode != 0 or not os.path.exists(dst):
                raise OcrFailure("UNREADABLE_PDF", 422)
            parts.append(dst)
        out = parts[0]
        if len(parts) > 1:
            out = os.path.join(work, "out.pdf")
            r = run(["pdfunite", *parts, out], timeout=60)
            if r.returncode != 0:
                raise OcrFailure("UNREADABLE_PDF", 422)
        if pdf_pages(out) != len(pages):
            raise OcrFailure("UNREADABLE_PDF", 422)
        with open(out, "rb") as f:
            return f.read(), "application/pdf", total
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ── HTTP ─────────────────────────────────────────────────────────────────────

SLOTS = threading.BoundedSemaphore(max(1, int(os.environ.get("OCR_CONCURRENCY", "2"))))
QUEUE_WAIT_S = 300


class Handler(BaseHTTPRequestHandler):
    server_version = "drawbridge-ocr"
    sys_version = ""

    def log_message(self, fmt: str, *args) -> None:  # noqa: D401 - content never logged
        return

    def _send(self, status: int, body: dict, started: float, size: int = 0) -> None:
        raw = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)
        ms = int((time.time() - started) * 1000)
        print(f"[ocr] {self.command} {self.path.split('?')[0]} {status} bytes={size} ms={ms}", flush=True)

    def do_GET(self) -> None:
        t = time.time()
        if self.path.split("?")[0] == "/health":
            self._send(200, {"ok": True, "tesseract": TESSERACT}, t)
        else:
            self._send(404, {"error": "NOT_FOUND"}, t)

    def _send_file(self, data: bytes, mime: str, source_pages: int, started: float, size: int) -> None:
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Source-Pages", str(source_pages))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)
        ms = int((time.time() - started) * 1000)
        print(f"[ocr] {self.command} {self.path.split('?')[0]} 200 bytes={size} ms={ms}", flush=True)

    def do_POST(self) -> None:
        t = time.time()
        route, _, query = self.path.partition("?")
        if route not in ("/ocr", "/pages"):
            self._send(404, {"error": "NOT_FOUND"}, t)
            return
        select: list[int] = []
        if route == "/pages":
            raw = ""
            for kv in query.split("&"):
                k, _, v = kv.partition("=")
                if k == "select":
                    raw = v.replace("%2C", ",").replace("%2c", ",")
            try:
                select = parse_select(raw)
            except OcrFailure as e:
                self._send(e.status, {"error": e.code}, t)
                return
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = -1
        if length <= 0:
            self._send(400, {"error": "EMPTY_BODY"}, t)
            return
        if length > MAX_BYTES:
            self._send(413, {"error": "TOO_LARGE"}, t, length)
            return
        data = self.rfile.read(length)
        if not SLOTS.acquire(timeout=QUEUE_WAIT_S):
            self._send(503, {"error": "BUSY"}, t, length)
            return
        try:
            if route == "/pages":
                out, mime, total = select_pages(data, select)
                self._send_file(out, mime, total, t, length)
            else:
                self._send(200, ocr_bytes(data), t, length)
        except OcrFailure as e:
            self._send(e.status, {"error": e.code}, t, length)
        except subprocess.TimeoutExpired:
            self._send(500, {"error": "OCR_TIMEOUT"}, t, length)
        except Exception as e:  # never echo content
            self._send(500, {"error": "OCR_FAILED", "type": type(e).__name__}, t, length)
        finally:
            SLOTS.release()


def serve() -> None:
    port = int(os.environ.get("OCR_PORT", "8090"))
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    httpd.daemon_threads = True
    print(f"[ocr] listening on :{port} (tesseract {TESSERACT}, psm {PSM})", flush=True)
    httpd.serve_forever()


# ── Batch ────────────────────────────────────────────────────────────────────

EXTS = (".pdf", ".tif", ".tiff", ".png", ".jpg", ".jpeg")


def _batch_one(args: tuple[str, str, bool]) -> tuple[str, Optional[str]]:
    src, out_dir, force = args
    stem = os.path.splitext(os.path.basename(src))[0]
    out_txt = os.path.join(out_dir, stem + ".txt")
    out_json = os.path.join(out_dir, stem + ".json")
    if not force and os.path.exists(out_json):
        return stem, None
    t = time.time()
    try:
        with open(src, "rb") as f:
            r = ocr_bytes(f.read())
        meta = {k: v for k, v in r.items() if k not in ("text", "page_texts")}
        text = r["text"]
        err = None
    except OcrFailure as e:
        meta, text, err = {"error": e.code}, "", e.code
    except Exception as e:
        meta, text, err = {"error": "OCR_FAILED", "type": type(e).__name__}, "", "OCR_FAILED"
    meta["elapsed_ms"] = int((time.time() - t) * 1000)
    meta["source"] = os.path.basename(src)
    with open(out_txt, "w", encoding="utf-8") as f:
        f.write(text)
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(meta, f)
    return stem, err


def batch(argv: list[str]) -> int:
    import multiprocessing as mp

    pos = [a for a in argv if not a.startswith("--")]
    if len(pos) != 2:
        print("usage: ocr_service.py batch IN_DIR OUT_DIR [--workers=N] [--force]", file=sys.stderr)
        return 2
    workers = os.cpu_count() or 2
    for a in argv:
        if a.startswith("--workers="):
            workers = int(a.split("=", 1)[1])
    in_dir, out_dir = pos
    os.makedirs(out_dir, exist_ok=True)
    files = sorted(os.path.join(in_dir, f) for f in os.listdir(in_dir) if f.lower().endswith(EXTS))
    force = "--force" in argv
    t = time.time()
    errors = 0
    with mp.Pool(workers) as pool:
        for i, (stem, err) in enumerate(pool.imap_unordered(_batch_one, [(f, out_dir, force) for f in files], chunksize=2), 1):
            if err:
                errors += 1
            if i % 50 == 0 or i == len(files):
                print(f"[ocr] batch {i}/{len(files)} done, {errors} error(s), {int(time.time() - t)} s", flush=True)
    return 0


TESSERACT = tesseract_version() if shutil.which("tesseract") else "missing"

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "serve"
    if cmd == "serve":
        serve()
    elif cmd == "batch":
        sys.exit(batch(sys.argv[2:]))
    else:
        print("usage: ocr_service.py serve | batch IN_DIR OUT_DIR [--workers=N] [--force]", file=sys.stderr)
        sys.exit(2)
