"""Generate the Drawbridge logo set as font-independent SVG (text converted to outlines).

Run with a Python that has fonttools, brotli and uharfbuzz:
    python scripts/brand/make_logo.py

Outputs to src/assets/brand/ (used by the site) and brand/logo/ (brand kit).
Fonts: Newsreader (wordmark) and Public Sans (endorsement), both SIL OFL 1.1.
"""
from __future__ import annotations

import io
import os
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parents[2]
FONTS = ROOT / "src" / "assets" / "fonts"
OUT_SITE = ROOT / "src" / "assets" / "brand"
OUT_KIT = ROOT / "brand" / "logo"

# MOATiT-derived palette (see brand/BRAND_KIT.md)
INDIGO = "#3E3E85"      # MOATiT Indigo (logo wordmark)
INDIGO_900 = "#1C1C45"  # Drawbridge Night
SKY = "#29ABE2"         # MOATiT Sky (logo arc / site accent)
AMBER = "#F5A623"       # MOATiT Amber (site accent)
PAPER = "#F7F5F0"
WHITE = "#FFFFFF"


def instance(path: Path, wght: int) -> tuple[TTFont, bytes]:
    font = TTFont(str(path))
    if "fvar" in font:
        font = instantiateVariableFont(font, {"wght": wght})
    font.flavor = None
    buf = io.BytesIO()
    font.save(buf)
    data = buf.getvalue()
    return TTFont(io.BytesIO(data)), data


def text_path(font: TTFont, data: bytes, text: str, size: float, x: float, baseline: float,
              tracking: float = 0.0) -> tuple[str, float]:
    """Return (svg path d, advance width) for text shaped with HarfBuzz (kerning applied)."""
    upem = font["head"].unitsPerEm
    face = hb.Face(data)
    hbfont = hb.Font(face)
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(hbfont, buf, {"kern": True, "liga": True})
    glyph_order = font.getGlyphOrder()
    gs = font.getGlyphSet()
    scale = size / upem
    pen = SVGPathPen(gs, ntos=lambda v: f"{v:.2f}".rstrip("0").rstrip("."))
    cx = 0.0
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        name = glyph_order[info.codepoint]
        tx = x + (cx + pos.x_offset) * scale
        ty = baseline - pos.y_offset * scale
        tpen = TransformPen(pen, (scale, 0, 0, -scale, tx, ty))
        gs[name].draw(tpen)
        cx += pos.x_advance + tracking * upem
    width = (cx - tracking * upem) * scale
    return pen.getCommands(), width


# ---------------------------------------------------------------- the mark
# A gate tower (with the doorway) and its bridge, mid-lowering: the deck is
# hinged at the tower, the hoist chain runs from the tower to the deck's tip,
# and the dotted arc is the path the deck travels to meet the far bank. The
# wave below is the moat (a nod to MOATiT). The amber pin is the hinge: one
# controlled crossing, opened only for the right patient.

def mark(x: float, y: float, s: float, ink: str, accent: str, hinge: str, water: str) -> str:
    """Mark in a 64x64 box, placed at (x, y) and scaled by s/64."""
    k = s / 64
    return f"""<g transform="translate({x:.2f} {y:.2f}) scale({k:.4f})">
  <path d="M58.4 44.6 A34 34 0 0 1 58.8 51" fill="none" stroke="{accent}" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="0.1 4.6"/>
  <path fill-rule="evenodd" fill="{ink}" d="M6 52 V9 H11 V14 H14 V9 H19 V14 H22 V9 H27 V52 Z M12.5 52 V43.5 a4 4 0 0 1 8 0 V52 Z"/>
  <rect x="24" y="44" width="34" height="7" rx="1.6" fill="{ink}" transform="rotate(-15 24 51)"/>
  <path d="M26 15.5 L54.4 36" stroke="{accent}" stroke-width="2.2" stroke-linecap="round"/>
  <circle cx="27.2" cy="47.6" r="2.7" fill="{hinge}"/>
  <path d="M6 58 q3.5 -2.6 7 0 t7 0 t7 0 t7 0 t7 0 t7 0 t7 0" fill="none" stroke="{water}" stroke-width="2.4" stroke-linecap="round"/>
</g>"""


def svg(w: float, h: float, body: str, title: str, bg: str | None = None) -> str:
    rect = f'<rect width="100%" height="100%" fill="{bg}"/>' if bg else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.0f} {h:.0f}" width="{w:.0f}" height="{h:.0f}" '
            f'role="img" aria-labelledby="t"><title id="t">{title}</title>{rect}{body}</svg>\n')


def main() -> None:
    OUT_SITE.mkdir(parents=True, exist_ok=True)
    OUT_KIT.mkdir(parents=True, exist_ok=True)
    serif, serif_data = instance(FONTS / "newsreader-latin-wght-normal.woff2", 620)
    sans, sans_data = instance(FONTS / "public-sans-latin-wght-normal.woff2", 600)
    sans_b, sans_b_data = instance(FONTS / "public-sans-latin-wght-normal.woff2", 800)

    title = "Drawbridge, A MOATiT Service"

    def lockup(ink: str, accent: str, hinge: str, water: str, endorse: str, endorse_brand: str,
               rule: str, bg: str | None) -> str:
        # Horizontal lockup: mark | Drawbridge / rule / A MOATiT Service
        m = mark(0, 2, 76, ink, accent, hinge, water)
        word_d, word_w = text_path(serif, serif_data, "Drawbridge", 56, 92, 48, tracking=-0.012)
        a_d, a_w = text_path(sans, sans_data, "A ", 15, 94, 74, tracking=0.06)
        mo_d, mo_w = text_path(sans_b, sans_b_data, "MOATiT", 15, 94 + a_w, 74, tracking=0.06)
        sv_d, sv_w = text_path(sans, sans_data, " Service", 15, 94 + a_w + mo_w, 74, tracking=0.06)
        endorse_w = a_w + mo_w + sv_w
        width = 92 + max(word_w, endorse_w) + 6
        body = (m
                + f'<path d="{word_d}" fill="{ink}"/>'
                + f'<rect x="94" y="57" width="{endorse_w:.1f}" height="1.2" fill="{rule}"/>'
                + f'<path d="{a_d}" fill="{endorse}"/><path d="{mo_d}" fill="{endorse_brand}"/><path d="{sv_d}" fill="{endorse}"/>')
        return svg(width, 82, body, title, bg)

    def stacked(ink: str, accent: str, hinge: str, water: str, endorse: str, endorse_brand: str, bg: str | None) -> str:
        word_d, word_w = text_path(serif, serif_data, "Drawbridge", 56, 0, 0, tracking=-0.012)
        a_d, a_w = text_path(sans, sans_data, "A ", 15, 0, 0, tracking=0.06)
        mo_d, mo_w = text_path(sans_b, sans_b_data, "MOATiT", 15, 0, 0, tracking=0.06)
        sv_d, sv_w = text_path(sans, sans_data, " Service", 15, 0, 0, tracking=0.06)
        width = word_w + 24
        cx = width / 2
        ew = a_w + mo_w + sv_w
        ex = cx - ew / 2
        word_d, _ = text_path(serif, serif_data, "Drawbridge", 56, cx - word_w / 2, 150, tracking=-0.012)
        a_d, _ = text_path(sans, sans_data, "A ", 15, ex, 178, tracking=0.06)
        mo_d, _ = text_path(sans_b, sans_b_data, "MOATiT", 15, ex + a_w, 178, tracking=0.06)
        sv_d, _ = text_path(sans, sans_data, " Service", 15, ex + a_w + mo_w, 178, tracking=0.06)
        body = (mark(cx - 48, 0, 96, ink, accent, hinge, water)
                + f'<path d="{word_d}" fill="{ink}"/>'
                + f'<path d="{a_d}" fill="{endorse}"/><path d="{mo_d}" fill="{endorse_brand}"/><path d="{sv_d}" fill="{endorse}"/>')
        return svg(width, 188, body, title, bg)

    files = {
        # primary, on light backgrounds
        "drawbridge-lockup.svg": lockup(INDIGO, SKY, AMBER, SKY, "#4A4A6A", INDIGO, SKY, None),
        # reverse, on Drawbridge Night / dark imagery
        "drawbridge-lockup-reverse.svg": lockup(WHITE, SKY, AMBER, SKY, "#C9CBE8", WHITE, SKY, None),
        # single colour
        "drawbridge-lockup-mono-indigo.svg": lockup(INDIGO, INDIGO, INDIGO, INDIGO, INDIGO, INDIGO, INDIGO, None),
        "drawbridge-lockup-mono-white.svg": lockup(WHITE, WHITE, WHITE, WHITE, WHITE, WHITE, WHITE, None),
        "drawbridge-lockup-stacked.svg": stacked(INDIGO, SKY, AMBER, SKY, "#4A4A6A", INDIGO, None),
        "drawbridge-lockup-stacked-reverse.svg": stacked(WHITE, SKY, AMBER, SKY, "#C9CBE8", WHITE, None),
        "drawbridge-mark.svg": svg(64, 64, mark(0, 0, 64, INDIGO, SKY, AMBER, SKY), "Drawbridge mark"),
        "drawbridge-mark-reverse.svg": svg(64, 64, mark(0, 0, 64, WHITE, SKY, AMBER, SKY), "Drawbridge mark"),
        "drawbridge-mark-mono.svg": svg(64, 64, mark(0, 0, 64, INDIGO, INDIGO, INDIGO, INDIGO), "Drawbridge mark"),
        # app icon / favicon: mark reversed on a Night tile
        "favicon.svg": ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
                        f'<rect width="64" height="64" rx="14" fill="{INDIGO_900}"/>'
                        + mark(7, 5, 50, WHITE, SKY, AMBER, SKY) + "</svg>\n"),
    }
    for name, content in files.items():
        for out in (OUT_SITE, OUT_KIT):
            (out / name).write_text(content, encoding="utf-8")
    # Wordmark-only paths for inline use in the site header (no mark, no endorsement)
    print("wrote", len(files), "files to", OUT_SITE, "and", OUT_KIT)


if __name__ == "__main__":
    main()
