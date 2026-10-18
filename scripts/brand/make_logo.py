"""Generate the Drawbridge "Ledger" logo set (chosen Oct 17, 2026) as font-free SVG.

No fonts and no dependencies: every letter is a filled outline from ledger_type.py
(geometric construction with overshoot, stroke contrast, light joins and kerning),
so the SVGs render the same everywhere.

    python scripts/brand/make_logo.py

Writes the site set to src/assets/brand/ and the brand-kit set to brand/logo/,
under the same filenames the site has always used. Then run make_icons.py for the PNGs.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT_SITE = os.path.join(ROOT, "src", "assets", "brand")
OUT_KIT = os.path.join(ROOT, "brand", "logo")

# Ledger palette (see brand/BRAND_KIT.md)
NAVY = "#3E3E84"   # MOATiT navy: the mark's post
INK = "#222236"    # MOATiT ink: wordmark
SLATE = "#5A5C78"  # endorsement
BLUE = "#29AAE1"   # MOATiT blue: outer ring, rule under the wordmark
GOLD = "#C68010"   # MOATiT gold: inner ring, the one controlled crossing
AMBER = "#F5A623"  # gold on dark grounds
ON_INK = "#C9CAE6" # endorsement on dark grounds
WHITE = "#FFFFFF"

# ---------------------------------------------------------------- type
# The letters are outlines from ledger_type.py (type-design pass, Oct 18, 2026).
from ledger_type import Type  # noqa: E402


def word(font, text, color, tracking=0.0, unit=None):
    return font.word(text, color, tracking)


def mark_rings(navy, blue, gold):
    """A 'D' drawn with MOATiT's rings: navy post, blue outer ring, gold inner ring (the one crossing)."""
    return (f'<rect x="7" y="5" width="9" height="54" fill="{navy}"/>'
            f'<path d="M16 9.5 H29 A22.5 22.5 0 0 1 29 54.5 H16" fill="none" stroke="{blue}" stroke-width="9"/>'
            f'<path d="M16 24.5 H29 A7.5 7.5 0 0 1 29 39.5 H16" fill="none" stroke="{gold}" stroke-width="7"/>')


def fav_rings(bg, fg, blue, gold):
    """Favicon drawn on a 16-pixel grid: every straight edge lands on a whole pixel at 16, 32 and 48 px.
    Navy post 2 px; blue D band 2 px; 1 px of white; gold inner band 2 px."""
    return (f'<rect width="16" height="16" rx="3" fill="{bg}"/>'
            f'<rect x="2" y="2" width="2" height="12" fill="{fg}"/>'
            f'<path fill-rule="evenodd" fill="{blue}" d="M4 2H8A6 6 0 0 1 8 14H4V12H8A4 4 0 0 0 8 4H4Z"/>'
            f'<path fill-rule="evenodd" fill="{gold}" d="M4 5H8A3 3 0 0 1 8 11H4V9H8A1 1 0 0 0 8 7H4Z"/>')


def app_icon(bg, navy, blue, gold):
    """Home-screen and app icon: the full mark on a padded tile (the favicon is too coarse at 180+ px)."""
    return (f'<rect width="64" height="64" rx="12" fill="{bg}"/>'
            f'<g transform="translate(9.5 8) scale(0.75)">{mark_rings(navy, blue, gold)}</g>')


# ---------------------------------------------------------------- writers
def svg(viewbox, body, title, w=None, h=None):
    vb = " ".join(f"{v:.2f}" if isinstance(v, float) else str(v) for v in viewbox)
    size = f' width="{w:.0f}" height="{h:.0f}"' if w else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}"{size} role="img" aria-label="{title}">'
            f"<title>{title}</title>{body}</svg>\n")


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(content)


def endorsement(font, colors, tracking):
    """'A MOATiT Service' with MOATiT emphasised, like MOATiT's own bold wordmark."""
    c_lead, c_moat = colors
    a, wa = word(font, "A", c_lead, tracking)
    m, wm = word(font, "MOATiT", c_moat, tracking)
    sv, ws = word(font, "Service", c_lead, tracking)
    gap = font.h * 0.62
    body = (f'{a}<g transform="translate({wa + gap:.2f} 0)">{m}</g>'
            f'<g transform="translate({wa + gap + wm + gap:.2f} 0)">{sv}</g>')
    return body, wa + gap + wm + gap + ws


def lockup_horizontal(mark_body, mark_scale, wm_font, wm_text, wm_color, en_font, en_colors,
                      rule_color=None, wm_tracking=0.0, en_tracking=0.0, wm_unit=None):
    """Mark at left; wordmark over endorsement at right."""
    wm, wmw = word(wm_font, wm_text, wm_color, wm_tracking, wm_unit)
    en, enw = endorsement(en_font, en_colors, en_tracking)
    pad = 4.0
    top = max(wm_font.asc, wm_font.cap) if "g" in wm_text or "b" in wm_text else wm_font.cap
    wm_base = pad + top
    desc = wm_font.h * 0.50 if "g" in wm_text else wm_font.cap * 0.10
    rule = ""
    if rule_color:
        ry = wm_base + desc + en_font.cap * 0.30
        rh = max(1.5, wm_font.s * 0.22)
        rule_w = wmw
        rule = f'<rect x="{{tx}}" y="{ry:.2f}" width="{rule_w:.2f}" height="{rh:.2f}" fill="{rule_color}"/>'
        en_base = ry + rh + en_font.cap * 0.45 + en_font.cap
    else:
        en_base = wm_base + desc + en_font.cap * 0.45 + en_font.cap
    text_h = en_base + pad
    # mark artwork spans roughly y 4..61 of its 64 grid; size it to the text block
    mark_scale = mark_scale * (en_base - pad) / 57.0
    mx = pad
    my = pad - 4 * mark_scale
    tx = mx + 58 * mark_scale + (en_base - pad) * 0.22
    width = tx + max(wmw, enw) + pad
    rule = rule.replace("{tx}", f"{tx:.2f}")
    body = (f'<g transform="translate({mx:.2f} {my:.2f}) scale({mark_scale:.4f})">{mark_body}</g>'
            f'<g transform="translate({tx:.2f} {wm_base:.2f})">{wm}</g>{rule}'
            f'<g transform="translate({tx:.2f} {en_base:.2f})">{en}</g>')
    return body, width, text_h




def lockup_stacked(mark_body, wm_font, wm_text, wm_color, en_font, en_colors, rule_color, wm_tracking=0.0):
    """Mark centred above the wordmark; blue rule and endorsement below, all centred."""
    wm, wmw = word(wm_font, wm_text, wm_color, wm_tracking)
    en, enw = endorsement(en_font, en_colors, 0.0)
    pad = 4.0
    width = max(wmw, enw) + 2 * pad
    mark_size = 128.0
    mark_scale = mark_size / 64.0
    mx = (width - mark_size) / 2
    wm_base = pad + mark_size + 22 + max(wm_font.asc, wm_font.cap)
    desc = wm_font.h * 0.50
    ry = wm_base + desc + en_font.cap * 0.30
    rh = max(1.5, wm_font.s * 0.22)
    en_base = ry + rh + en_font.cap * 0.45 + en_font.cap
    height = en_base + pad
    body = (f'<g transform="translate({mx:.2f} {pad:.2f}) scale({mark_scale:.4f})">{mark_body}</g>'
            f'<g transform="translate({(width - wmw) / 2:.2f} {wm_base:.2f})">{wm}</g>'
            f'<rect x="{(width - wmw) / 2:.2f}" y="{ry:.2f}" width="{wmw:.2f}" height="{rh:.2f}" fill="{rule_color}"/>'
            f'<g transform="translate({(width - enw) / 2:.2f} {en_base:.2f})">{en}</g>')
    return body, width, height


def build():
    mid = Type(52)                                              # wordmark: x-height 52
    small = Type(24, sv=88, sh=78, sd=84, spacing=1.12)         # endorsement: small optical size
    title = "Drawbridge, A MOATiT Service"
    files = {}

    # horizontal lockups: (filename, post, outer ring, inner ring, wordmark, endorsement colours, rule)
    for name, navy, blue, gold, wmc, enc, rule in (
        ("drawbridge-lockup", NAVY, BLUE, GOLD, INK, (SLATE, NAVY), BLUE),
        ("drawbridge-lockup-reverse", WHITE, BLUE, AMBER, WHITE, (ON_INK, WHITE), BLUE),
        ("drawbridge-lockup-mono-indigo", INK, INK, INK, INK, (INK, INK), INK),
        ("drawbridge-lockup-mono-white", WHITE, WHITE, WHITE, WHITE, (WHITE, WHITE), WHITE),
    ):
        body, w, h = lockup_horizontal(mark_rings(navy, blue, gold), 1.0, mid, "Drawbridge", wmc, small, enc,
                                       rule_color=rule)
        files[name] = svg((0, 0, round(w, 2), round(h, 2)), body, title, w, h)

    for name, navy, blue, gold, wmc, enc in (
        ("drawbridge-lockup-stacked", NAVY, BLUE, GOLD, INK, (SLATE, NAVY)),
        ("drawbridge-lockup-stacked-reverse", WHITE, BLUE, AMBER, WHITE, (ON_INK, WHITE)),
    ):
        body, w, h = lockup_stacked(mark_rings(navy, blue, gold), mid, "Drawbridge", wmc, small, enc, BLUE)
        files[name] = svg((0, 0, round(w, 2), round(h, 2)), body, title, w, h)

    for name, args in (("drawbridge-mark", (NAVY, BLUE, GOLD)), ("drawbridge-mark-reverse", (WHITE, BLUE, AMBER)),
                       ("drawbridge-mark-mono", (INK, INK, INK))):
        files[name] = svg((0, 0, 64, 64), mark_rings(*args), "Drawbridge mark", 64, 64)
    files["favicon"] = svg((0, 0, 16, 16), fav_rings(WHITE, NAVY, BLUE, GOLD), "Drawbridge", 32, 32)
    files["drawbridge-app-icon"] = svg((0, 0, 64, 64), app_icon(WHITE, NAVY, BLUE, GOLD), "Drawbridge", 64, 64)

    # the wordmark alone (for places where the mark already appears nearby)
    for name, colour in (("drawbridge-wordmark", INK), ("drawbridge-wordmark-reverse", WHITE)):
        g, w = word(mid, "Drawbridge", colour)
        top, bottom = mid.asc + 2, mid.h * 0.47 + 2
        files[name] = svg((-2, round(-top, 2), round(w + 4, 2), round(top + bottom, 2)), g, "Drawbridge", w + 4, top + bottom)

    for out in (OUT_SITE, OUT_KIT):
        for name, content in files.items():
            write(os.path.join(out, name + ".svg"), content)
    for name, content in files.items():
        if name.endswith(("lockup", "reverse", "stacked", "mark", "favicon")):
            print(f"{name}.svg  {content.split('viewBox=\"')[1].split('\"')[0]}")
    print("logos written to src/assets/brand/ and brand/logo/")


if __name__ == "__main__":
    build()
