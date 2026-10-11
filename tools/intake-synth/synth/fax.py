"""
Fax-quality copies of a rendered PDF.

  fine       204 x 196 dpi            standard   204 x 98 dpi
  poor       204 x 98 dpi, heavier noise, wider skew, more streaks

Steps per page: render at 204 dpi (pypdfium2) -> rotate by the skew (+/-2 deg, poor +/-3) ->
resample rows to the vertical resolution -> threshold to black/white -> speckle (isolated dots and
small blobs) -> occasional streaks (vertical scanner lines, dropped rows) -> crop/pad to the fax
width of 1728 px. Output: multi-page TIFF (CCITT Group 4 or Group 3, dpi tag 204 x 98/196) or an
image-only PDF (rows doubled for standard so the PDF pixels are square).
"""
from __future__ import annotations

import random

import numpy as np
import pypdfium2 as pdfium
from PIL import Image

FAX_WIDTH = 1728
HDPI = 204

QUALITY = {
    #           vdpi, skew, speck density, blobs per page, streak prob, threshold range
    "fine": (196, 1.2, 0.0004, 40, 0.15, (150, 185)),
    "standard": (98, 2.0, 0.0008, 70, 0.3, (140, 190)),
    "poor": (98, 3.0, 0.0025, 260, 0.75, (120, 200)),
}


def degrade_page(gray: Image.Image, quality: str, rng: random.Random, nrng: np.random.Generator) -> Image.Image:
    vdpi, skew, density, blobs, streak_p, (tlo, thi) = QUALITY[quality]
    angle = rng.uniform(-skew, skew)
    img = gray.rotate(angle, resample=Image.BICUBIC, expand=False, fillcolor=255)
    w, h = img.size
    img = img.resize((w, max(1, round(h * vdpi / HDPI))), Image.BILINEAR)
    a = np.array(img, dtype=np.uint8)
    t = rng.randint(tlo, thi)
    ink = a < t  # True = black
    hh, ww = ink.shape
    # Speckle: isolated pixels and small blobs.
    ink |= nrng.random(ink.shape) < density
    for _ in range(int(blobs * nrng.uniform(0.5, 1.5))):
        y, x = nrng.integers(0, hh - 3), nrng.integers(0, ww - 3)
        ink[y : y + nrng.integers(1, 3), x : x + nrng.integers(1, 4)] = True
    # Dropouts inside strokes (thin white specks).
    ink &= ~(nrng.random(ink.shape) < density * 0.6)
    if rng.random() < streak_p:
        for _ in range(rng.randint(1, 2)):
            if rng.random() < 0.6:  # vertical scanner line, full or partial height
                x = rng.randint(0, ww - 3)
                y0 = 0 if rng.random() < 0.6 else rng.randint(0, hh // 2)
                ink[y0:, x : x + rng.randint(1, 2)] = True
            else:  # dropped or smeared rows
                y = rng.randint(hh // 8, hh - 4)
                ink[y : y + rng.randint(1, 3), :] = rng.random() < 0.3
    # Crop/pad to the fax line width.
    if ww >= FAX_WIDTH:
        off = (ww - FAX_WIDTH) // 2
        ink = ink[:, off : off + FAX_WIDTH]
    else:
        ink = np.pad(ink, ((0, 0), (0, FAX_WIDTH - ww)))
    return Image.fromarray(np.where(ink, 0, 255).astype(np.uint8)).convert("1", dither=Image.Dither.NONE)


def fax_pages(pdf_path: str, quality: str, rng: random.Random, nrng: np.random.Generator) -> list[Image.Image]:
    pdf = pdfium.PdfDocument(pdf_path)
    out = []
    try:
        for i in range(len(pdf)):
            page = pdf[i]
            gray = page.render(scale=HDPI / 72, grayscale=True).to_pil().convert("L")
            out.append(degrade_page(gray, quality, rng, nrng))
            page.close()
    finally:
        pdf.close()
    return out


def save_tiff(pages: list[Image.Image], path: str, quality: str, compression: str) -> None:
    vdpi = QUALITY[quality][0]
    pages[0].save(path, save_all=True, append_images=pages[1:], compression=compression, dpi=(HDPI, vdpi))


def save_image_pdf(pages: list[Image.Image], path: str, quality: str) -> None:
    vdpi = QUALITY[quality][0]
    sq = [p.resize((p.width, round(p.height * HDPI / vdpi)), Image.NEAREST) if vdpi != HDPI else p for p in pages]
    sq[0].save(path, "PDF", save_all=True, append_images=sq[1:], resolution=HDPI)
