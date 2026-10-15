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
  3. Header pass (OCR_HEADER_PASS, on): the lines that carry patient identifiers are read again when
     a word on them is weak or a field fails a check (no valid date after a DOB label, a label with
     nothing after it), and always for a sender template's header lines: each line is cut out on its
     own, enlarged 2x, read in several variants (OCR_HEADER_VARIANTS, incl. the tessdata_best model)
     and the readings are merged by a confidence-weighted character vote. Only those lines change.
  mean_confidence is the mean Tesseract word confidence (0-100) over all pages (first pass).

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
# First-pass model: "fast" (Debian's tessdata_fast) or "best" (tessdata_best LSTM, baked into the image).
# On the bench, best alone read standard faxes worse than fast but made different mistakes, so the
# default reads pages with fast and lets best vote in the header pass.
MODEL = os.environ.get("OCR_MODEL", "fast")
MODEL_LANG = {"best": "eng_best", "fast": "eng"}
# Second pass over the patient header lines (see header_pass): "1" on, "0" off.
HEADER_PASS = os.environ.get("OCR_HEADER_PASS", "1") != "0"
# A header line is read again when any of its words is below this confidence, or a field on it
# fails validation (no valid date after a DOB label, a label with no value). 101 = every header line.
HEADER_MIN_CONF = float(os.environ.get("OCR_HEADER_MIN_CONF", "93"))
# Upscale of the second pass, relative to the 300 dpi first pass.
HEADER_SCALE = float(os.environ.get("OCR_HEADER_SCALE", "2.0"))
# Variants of the header pass: preprocessing name, optionally "@model" (plain, smooth, close, thick,
# thin, lanczos, orig). Chosen on the bench (INTAKE_ACCURACY.md): more variants were slower, not better.
HEADER_VARIANTS = [v for v in os.environ.get("OCR_HEADER_VARIANTS", "plain,smooth,orig@best,plain@best").split(",") if v]
HEADER_MERGE = os.environ.get("OCR_HEADER_MERGE", "rover")  # rover | medoid
# Sender templates (JSON, one per sender): /app/templates baked in, plus OCR_TEMPLATES_DIR if set.
TEMPLATE_DIRS = [d for d in ("/app/templates", os.environ.get("OCR_TEMPLATES_DIR", "")) if d] if os.environ.get("OCR_TEMPLATES", "1") != "0" else []
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
    return preprocess_both(img, dpi)[0]


def preprocess_both(img: Image.Image, dpi: tuple[float, float]) -> tuple[Image.Image, np.ndarray]:
    """(the first-pass image, the same page deskewed at 300 dpi before the blur: the header pass crops it)."""
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
    pre = clean
    if BLUR:
        clean = cv2.GaussianBlur(clean, (3, 3), 0)
    return Image.fromarray(clean), pre


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

def tesseract_cmd(src: str, base: str, psm: str, outputs: list[str], lang: str = "", whitelist: str = "") -> list[str]:
    cfg = ["-c", f"tessedit_char_whitelist={whitelist}"] if whitelist else []
    return ["tesseract", src, base, "-l", lang or LANG, "--oem", "1", "--psm", psm, "-c", "preserve_interword_spaces=1"] + cfg + outputs


def read_tsv(path: str) -> list[dict]:
    """Tesseract TSV -> one dict per word (level 5): line key, box, confidence, text."""
    words = []
    with open(path, encoding="utf-8", errors="replace") as f:
        next(f, None)
        for line in f:
            p = line.rstrip("\n").split("\t")
            if len(p) < 12 or p[0] != "5" or not p[11].strip():
                continue
            try:
                conf = float(p[10])
                x, y, w, h = (int(v) for v in p[6:10])
            except ValueError:
                continue
            words.append({"line": (int(p[2]), int(p[3]), int(p[4])), "x": x, "y": y, "w": w, "h": h, "conf": conf, "text": p[11]})
    return words


def tesseract_page(img: Image.Image, work: str, n: int, pre: Optional[np.ndarray] = None) -> tuple[str, list[float], dict]:
    """(page text, word confidences, header-pass facts). `pre` enables the header pass."""
    src = os.path.join(work, f"p{n}.png")
    img.save(src, dpi=(TARGET_DPI, TARGET_DPI))
    base = os.path.join(work, f"p{n}")
    r = run(tesseract_cmd(src, base, PSM, ["txt", "tsv"]))
    if r.returncode != 0:
        raise OcrFailure("TESSERACT_FAILED", 500)
    with open(base + ".txt", encoding="utf-8", errors="replace") as f:
        text = f.read()
    words = read_tsv(base + ".tsv")
    confs = [w["conf"] for w in words if w["conf"] >= 0]
    info: dict = {"lines": 0, "reread": 0, "changed": 0}
    if HEADER_PASS and pre is not None:
        text, info = header_pass(text, words, pre, work, n)
    return text, confs, info


# ── Header pass: the patient lines read again, larger, several ways ──────────
#
# Small type on a 98 dpi fax loses strokes, and one misread letter in a name or digit in a date sends
# a document to staff. The lines that carry patient identifiers (name, DOB, MRN, phone labels, as OCR
# reads them) are cut from the deskewed page, enlarged (OCR_HEADER_SCALE) and read again in several
# preprocessing variants. The readings, with the first pass, are merged character by character (a
# ROVER-style vote aligned on the first-pass line) or the most central one is taken (medoid). A line is
# read again only when it needs it: a word under OCR_HEADER_MIN_CONF, or a field that fails a check (no
# valid calendar date after a DOB label). A merged line that would turn a valid date into an invalid
# one is not used. Only these lines change; nothing is invented (every character comes from a reading).

HEADER_RE = re.compile(
    r"(?:^|\s)P[TI1l][.:;!,'t|]?\s|Pat[il1I|]?[eE]?n|PAT[LI1|]EN|Name|\bD[.,]?\s?[O0QN][.,]?\s?[BR8]\b|[DN][O0]B|"
    r"Birth|M\s?R\s?N|Med\w{0,5}\.?\s*Re|Chart|Phone|\bRE\s*[:;]",
    re.I,
)
DOB_LABEL_RE = re.compile(r"\b(?:D[.,]?\s?[O0QN][.,]?\s?[BR8]\b\.?|[DN][O0]B|Date\s+of\s+Birth|Birth\s*Date|Birthdate)", re.I)
VALUE_LABEL_RE = re.compile(r"(?:\bMRN|Patient\s*[I1l]D|\bD[.,]?\s?[O0][.,]?\s?B|Birth\w*|Name|(?:^|\s)PT)\s*[:;!.,]?\s*$", re.I)
MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def _valid(y: int, m: int, d: int) -> bool:
    import datetime as _dt
    if not (1900 <= y <= 2100):
        return False
    try:
        _dt.date(y, m, d)
        return True
    except ValueError:
        return False


def dob_state(line: str) -> str:
    """'none' (no DOB label), 'valid' (a real calendar date follows the label) or 'invalid'."""
    m = DOB_LABEL_RE.search(line)
    if not m:
        return "none"
    rest = line[m.end():m.end() + 30]
    rest = re.sub(r"(?<=\d)[Oo]|[Oo](?=\d)", "0", rest)
    rest = re.sub(r"(?<=\d)[lI|]|[lI|](?=\d)", "1", rest)
    for pat, order in ((r"(\d{4})-(\d{1,2})-(\d{1,2})", "ymd"), (r"(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b", "mdy")):
        g = re.search(pat, rest)
        if g:
            a, b, c = (int(x) for x in g.groups())
            if order == "ymd":
                return "valid" if _valid(a, b, c) else "invalid"
            y = c if c > 99 else 1900 + c
            return "valid" if _valid(y, a, b) or _valid(y, b, a) else "invalid"
    g = re.search(r"([A-Za-z]{3})[a-z]*\.?[\s-]+(\d{1,2}),?[\s-]+(\d{4})", rest)
    if g and g.group(1).lower() in MONTHS:
        return "valid" if _valid(int(g.group(3)), MONTHS[g.group(1).lower()], int(g.group(2))) else "invalid"
    g = re.search(r"(\d{1,2})[\s-]+([A-Za-z]{3})[a-z]*\.?[\s-]+(\d{4})", rest)
    if g and g.group(2).lower() in MONTHS:
        return "valid" if _valid(int(g.group(3)), MONTHS[g.group(2).lower()], int(g.group(1))) else "invalid"
    return "invalid"


def _lev_align(a: str, b: str) -> tuple[int, list[str], list[str]]:
    """Edit distance a->b, and for each position of a: b's aligned char ('' = deleted) and the text b
    inserts before it (index len(a) = inserted at the end)."""
    n, m = len(a), len(b)
    d = [list(range(m + 1))]
    for i in range(1, n + 1):
        prev, ai = d[-1], a[i - 1]
        cur = [i] + [0] * m
        for j in range(1, m + 1):
            x = prev[j - 1] + (ai != b[j - 1])
            y = prev[j] + 1
            z = cur[j - 1] + 1
            cur[j] = x if x <= y and x <= z else (y if y <= z else z)
        d.append(cur)
    sub = [""] * n
    ins = [""] * (n + 1)
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and d[i][j] == d[i - 1][j - 1] + (a[i - 1] != b[j - 1]):
            sub[i - 1] = b[j - 1]
            i, j = i - 1, j - 1
        elif i > 0 and d[i][j] == d[i - 1][j] + 1:
            sub[i - 1] = ""
            i -= 1
        else:
            ins[i] = b[j - 1] + ins[i]
            j -= 1
    return d[n][m], sub, ins


def _squash(s: str) -> str:
    """Field gaps (2+ spaces) become a tab so the vote keeps them; single spaces stay."""
    return re.sub(r" {2,}|\t+", "\t", s.strip())


def merge_readings(readings: list[str], weights: Optional[list[float]] = None) -> tuple[str, float]:
    """
    (merged line, agreement 0-1). readings[0] is the first pass; weights are the readings' mean word
    confidences (0-100). Strings use _squash spacing. The pivot is the weighted medoid (the reading
    closest to the others); with three or more readings each of its characters is then put to a
    confidence-weighted vote (ROVER), and text a majority inserts is added.
    """
    ws = list(weights) if weights else [1.0] * len(readings)
    pairs = [(r, max(0.05, w)) for r, w in zip(readings, ws) if r.strip()]
    if not pairs:
        return readings[0] if readings else "", 0.0
    rs = [r for r, _ in pairs]
    wt = [w for _, w in pairs]
    dist = [[0] * len(rs) for _ in rs]
    for i in range(len(rs)):
        for j in range(i + 1, len(rs)):
            dist[i][j] = dist[j][i] = _lev_align(rs[i], rs[j])[0]
    med = min(range(len(rs)), key=lambda i: (sum(d * w for d, w in zip(dist[i], wt)), i))
    pivot = rs[med]
    if HEADER_MERGE == "medoid" or len(rs) < 3:
        out = pivot
    else:
        from collections import defaultdict
        subs = [defaultdict(float) for _ in pivot]
        inss = [defaultdict(float) for _ in range(len(pivot) + 1)]
        for r, w in zip(rs, wt):
            _, sub, ins = _lev_align(pivot, r)
            for k, ch in enumerate(sub):
                subs[k][ch] += w
            for k, t in enumerate(ins):
                inss[k][t] += w
        total = sum(wt)
        parts = []
        for k in range(len(pivot) + 1):
            t, c = max(inss[k].items(), key=lambda kv: kv[1])
            if t and c > total / 2:
                parts.append(t)
            if k < len(pivot):
                # Weighted plurality; the pivot's own character wins ties.
                best = max(subs[k].items(), key=lambda kv: (kv[1], kv[0] == pivot[k]))
                parts.append(best[0])
        out = "".join(parts)
    agree = sum(w for r, w in zip(rs, wt) if r == out) / sum(wt)
    return out, agree


def _variant(crop: np.ndarray, name: str) -> np.ndarray:
    s = HEADER_SCALE
    big = cv2.resize(crop, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
    if name == "plain":
        return cv2.GaussianBlur(big, (3, 3), 0)
    if name == "smooth":  # blur then threshold: rounder strokes, fewer jaggies from the 98 dpi rows
        b = cv2.GaussianBlur(big, (5, 5), 0)
        return np.where(b < 170, 0, 255).astype(np.uint8)
    if name == "close":  # fill white dropouts inside strokes
        inv = 255 - big
        inv = cv2.morphologyEx(inv, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        return cv2.GaussianBlur(255 - inv, (3, 3), 0)
    if name == "thick":  # thicker strokes for faint type
        return cv2.GaussianBlur(cv2.erode(big, np.ones((2, 2), np.uint8)), (3, 3), 0)
    if name == "thin":  # thinner strokes where ink bleeds letters together
        return cv2.GaussianBlur(cv2.dilate(big, np.ones((2, 2), np.uint8)), (3, 3), 0)
    if name == "orig":  # the first pass's own scale: mostly useful read by the other model
        return cv2.GaussianBlur(crop, (3, 3), 0)
    if name == "lanczos":
        b = cv2.resize(crop, None, fx=s * 1.25, fy=s * 1.25, interpolation=cv2.INTER_LANCZOS4)
        return cv2.GaussianBlur(b, (5, 5), 0)
    return cv2.GaussianBlur(big, (3, 3), 0)


def _line_text(words: list[dict]) -> str:
    """Words of one line -> text, with a field gap (2+ spaces) where the gap is wider than ~1.6 characters."""
    ws = sorted(words, key=lambda w: w["x"])
    if not ws:
        return ""
    cw = np.median([w["w"] / max(1, len(w["text"])) for w in ws])
    out = ws[0]["text"]
    for a, b in zip(ws, ws[1:]):
        gap = b["x"] - (a["x"] + a["w"])
        out += ("    " if gap > 1.6 * cw else " ") + b["text"]
    return out


# ── Sender templates ─────────────────────────────────────────────────────────
#
# The same JSON files the intake module reads (src/platform/modules/intake/templates.ts). Here a
# template says where a sender's patient header sits: lines that carry its labels ("ocr.header_labels",
# default every field label), read OCR-tolerantly, and optionally "ocr.header_region" [top, bottom] as
# fractions of the page height. Those lines are always read again (not only when a word is weak).

CONFUSIONS = {"A": "A4", "B": "B8R", "D": "DO0", "E": "EF", "G": "G6", "I": "I1l|!L", "L": "L1I|", "M": "MN", "N": "NHM",
              "O": "O0QD", "P": "PR", "R": "RB", "S": "S5$", "T": "T7", "Z": "Z2", "0": "0OD", "1": "1Il|", "5": "5S", "8": "8B"}


def label_pattern(label: str) -> "re.Pattern":
    """Mirror of labelPattern() in templates.ts."""
    body = ""
    chars = list(label.strip())
    for i, c in enumerate(chars):
        last = i == len(chars) - 1
        if c.isalnum():
            v = CONFUSIONS.get(c.upper(), c.upper())
            body += "[" + re.escape(v + v.lower()) + "]"
        elif c == " ":
            body += r"\s?"
        elif last and c in ":#.":
            body += r"(?:[:;!,.#|']|[tij](?=\s))"
        else:
            body += re.escape(c) + "?"
    tail = "" if label.strip()[-1:] in ":#." else r"(?=\s)"
    return re.compile(r"(?:^\W{0,3}|(?<=\s))" + body + tail)


def _letters(s: str) -> str:
    return re.sub(r"[^A-Z]", "", s.upper())


def fuzzy_contains(hay: str, needle: str, k: int) -> bool:
    """`needle` in `hay` with at most k edits (Sellers)."""
    if not needle:
        return False
    if needle in hay:
        return True
    prev = list(range(len(needle) + 1))
    for ch in hay:
        cur = [0]
        for i in range(1, len(needle) + 1):
            cur.append(min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + (needle[i - 1] != ch)))
        if cur[-1] <= k:
            return True
        prev = cur
    return False


def load_templates() -> list[dict]:
    out = []
    for d in TEMPLATE_DIRS:
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            if not f.endswith(".json"):
                continue
            try:
                with open(os.path.join(d, f), encoding="utf-8") as fh:
                    t = json.load(fh)
                labels = [l for fld in (t.get("fields") or {}).values() for l in (fld or {}).get("labels", [])]
                ocr = t.get("ocr") or {}
                t["_texts"] = [_letters(x) for x in (t.get("match") or {}).get("text", []) if len(_letters(x)) >= 6]
                t["_labels"] = [label_pattern(l) for l in (ocr.get("header_labels") or labels)]
                t["_region"] = ocr.get("header_region")
                out.append(t)
            except Exception:
                print(f"[ocr] template {f} skipped: not valid", flush=True)
    return out


TEMPLATES = load_templates()


def find_template(text: str) -> Optional[dict]:
    hay = _letters(text[:20000])
    hits = [t for t in TEMPLATES if any(fuzzy_contains(hay, x, 2 if len(x) >= 10 else 0) for x in t["_texts"])]
    return hits[0] if len(hits) == 1 else None


def header_pass(text: str, words: list[dict], pre: np.ndarray, work: str, n: int) -> tuple[str, dict]:
    """Read the header lines again (see above). Returns the page text with merged lines, and counts."""
    info = {"lines": 0, "reread": 0, "changed": 0}
    tpl = find_template(text)
    if tpl:
        info["template"] = tpl.get("id", "")
    # First-pass lines in reading order, with their boxes.
    order: list[tuple] = []
    by_line: dict[tuple, list[dict]] = {}
    for w in words:
        if w["line"] not in by_line:
            by_line[w["line"]] = []
            order.append(w["line"])
        by_line[w["line"]].append(w)
    # Map the text's lines onto TSV lines (same words in the same order); unmatched lines are left alone.
    tlines = text.split("\n")
    mapping: dict[int, tuple] = {}
    k = 0
    for i, tl in enumerate(tlines):
        flat = " ".join(tl.split())
        if not flat:
            continue
        for j in range(k, min(k + 3, len(order))):
            if " ".join(w["text"] for w in by_line[order[j]]) == flat:
                mapping[i] = order[j]
                k = j + 1
                break
    todo = []
    H, W = pre.shape
    for i, key in mapping.items():
        tl = tlines[i]
        ws = by_line[key]
        pinned = False
        if tpl:
            pinned = any(p.search(tl) for p in tpl["_labels"])
            reg = tpl["_region"]
            if not pinned and reg and len(reg) == 2:
                yc = np.mean([w["y"] + w["h"] / 2 for w in ws]) / H
                pinned = reg[0] <= yc <= reg[1]
        if not pinned and not HEADER_RE.search(tl):
            continue
        info["lines"] += 1
        low = min(w["conf"] for w in ws) < HEADER_MIN_CONF
        bad = dob_state(tl) == "invalid" or bool(VALUE_LABEL_RE.search(tl))
        if pinned or low or bad:
            todo.append((i, ws, pinned))
    if not todo:
        return text, info
    crops = []
    for i, ws, _ in todo:
        # The line's own band only (its words' boxes, which hold ascenders and descenders, plus two
        # pixels), then a white border: neighbouring lines never leak into the crop. Horizontally the
        # words plus about three characters each side (not the page edges, where streaks read as "|").
        y0 = max(0, min(w["y"] for w in ws) - 2)
        y1 = min(H, max(w["y"] + w["h"] for w in ws) + 2)
        cw = int(np.median([w["w"] / max(1, len(w["text"])) for w in ws])) + 1
        x0 = max(0, min(w["x"] for w in ws) - 3 * cw)
        x1 = min(W, max(w["x"] + w["w"] for w in ws) + 3 * cw)
        band = pre[y0:y1, x0:x1]
        b = max(6, (y1 - y0) // 2)
        crops.append(cv2.copyMakeBorder(band, b, b, b, b, cv2.BORDER_CONSTANT, value=255))
    readings: list[list[str]] = [[_squash(tlines[i])] for i, _, _ in todo]
    weights: list[list[float]] = [[float(np.mean([w["conf"] for w in ws]))] for _, ws, _ in todo]
    # A template may restrict the characters on its header lines (e.g. upper case, digits, : , / - .).
    wl = str((tpl or {}).get("ocr", {}).get("whitelist") or "")
    groups = [[k for k, t in enumerate(todo) if not (wl and t[2])], [k for k, t in enumerate(todo) if wl and t[2]]]
    for v, spec in enumerate(HEADER_VARIANTS):
        # "name@model": a preprocessing variant read with another model (best / fast) for diversity.
        name, _, model = spec.partition("@")
        lang = _lang(model) if model else LANG
        for g, idxs in enumerate(groups):
            if not idxs:
                continue
            # All lines of a variant in one image (white gaps between them): one Tesseract run.
            imgs = [_variant(crops[k], name) for k in idxs]
            gap = int(max(im.shape[0] for im in imgs))
            width = max(im.shape[1] for im in imgs)
            bands = []
            for im in imgs:
                bands.append(np.full((gap, width), 255, np.uint8))
                row = np.full((im.shape[0], width), 255, np.uint8)
                row[:, : im.shape[1]] = im
                bands.append(row)
            bands.append(np.full((gap, width), 255, np.uint8))
            src = os.path.join(work, f"h{n}_{v}_{g}.png")
            Image.fromarray(np.vstack(bands)).save(src, dpi=(int(TARGET_DPI * HEADER_SCALE),) * 2)
            base = os.path.join(work, f"h{n}_{v}_{g}")
            r = run(tesseract_cmd(src, base, "6", ["tsv"], lang, wl if g == 1 else ""))
            if r.returncode != 0:
                continue
            got = read_tsv(base + ".tsv")
            y = 0
            for k, im in zip(idxs, imgs):
                y += gap
                top, bot = y, y + im.shape[0]
                y = bot
                inside = [w for w in got if top <= w["y"] + w["h"] / 2 < bot]
                readings[k].append(_squash(_line_text(inside)))
                weights[k].append(float(np.mean([w["conf"] for w in inside])) if inside else 0.0)
    lines_out = list(tlines)
    for (i, _, _), rs, wts in zip(todo, readings, weights):
        info["reread"] += 1
        merged, _agree = merge_readings(rs, wts)
        first = rs[0]
        # Sanity: a merge far from the first pass read something else (a neighbouring line, noise).
        if first and _lev_align(first, merged)[0] > max(3, 0.25 * len(first)):
            continue
        # A merge that loses a valid date (or the DOB label itself) is not used.
        if dob_state(first) == "valid" and dob_state(merged) != "valid":
            continue
        if dob_state(merged) == "invalid":
            valid = [(r, w) for r, w in zip(rs, wts) if dob_state(r) == "valid"]
            if valid:
                merged = merge_readings([r for r, _ in valid], [w for _, w in valid])[0] if len(valid) > 2 else max(valid, key=lambda x: x[1])[0]
        if merged != first:
            info["changed"] += 1
            lead = re.match(r"\s*", tlines[i]).group(0)
            lines_out[i] = lead + merged.replace("\t", "    ")
    return "\n".join(lines_out), info


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
        header = {"lines": 0, "reread": 0, "changed": 0}

        def ocr_page(page_img: Image.Image, dpi: tuple[float, float], i: int) -> None:
            first, pre = preprocess_both(page_img, dpi)
            t, c, h = tesseract_page(first, work, i, pre)
            texts.append(t)
            page_confs.append(page_mean(c))
            confs.extend(c)
            for k in ("lines", "reread", "changed"):
                header[k] += h.get(k, 0)
            if h.get("template"):
                header["template"] = h["template"]

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
                    ocr_page(im, (TARGET_DPI, TARGET_DPI), i)
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
                ocr_page(frame, dpi, i)
        page_texts = [t.rstrip() for t in texts]
        text = "\f\n".join(page_texts)
        mean = round(float(np.mean(confs)), 1) if confs else 0.0
        return {"text": text, "pages": pages, "mean_confidence": mean, "used_text_layer": False,
                "page_texts": page_texts, "page_confidences": page_confs,
                "engine": f"tesseract-{TESSERACT}-{MODEL}", "header_pass": header if HEADER_PASS else None}
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


def _lang(model: str = "") -> str:
    """The traineddata for a model name (default OCR_MODEL); Debian's eng (tessdata_fast) when missing."""
    want = MODEL_LANG.get(model or MODEL, "eng")
    if want in _LANGS_CACHE:
        return want
    r = run(["tesseract", "--list-langs"], timeout=10) if shutil.which("tesseract") else None
    have = (r.stdout + r.stderr).decode("utf-8", "replace").split() if r else []
    _LANGS_CACHE.update(have)
    return want if want in have else "eng"


_LANGS_CACHE: set = set()
LANG = _lang()

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "serve"
    if cmd == "serve":
        serve()
    elif cmd == "batch":
        sys.exit(batch(sys.argv[2:]))
    else:
        print("usage: ocr_service.py serve | batch IN_DIR OUT_DIR [--workers=N] [--force]", file=sys.stderr)
        sys.exit(2)
