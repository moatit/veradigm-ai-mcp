"""Generate the Drawbridge "Ledger" logo set (chosen Oct 17, 2026) as font-free SVG.

No fonts and no dependencies: every letter is drawn from lines and arcs on a
Poppins-like geometric skeleton, so the SVGs render the same everywhere.
Adapted from the concept generator in concepts/_tools/build_logos.py (direction B).

    python scripts/brand/make_logo.py

Writes the site set to src/assets/brand/ and the brand-kit set to brand/logo/,
under the same filenames the site has always used. Then run make_icons.py for the PNGs.
"""
import itertools
import math
import os

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

# ---------------------------------------------------------------- stroke font
class Font:
    """A tiny geometric stroke alphabet. y grows downward, baseline at 0."""

    def __init__(self, s, h=52.0, cap=72.0, asc=74.0):
        self.s, self.h, self.cap, self.asc = s, h, cap, asc
        self.R = (h - s) / 2  # x-height bowl radius (centreline)

    # each glyph returns (strokes, fills, width, clip, left_kind, right_kind)
    # clip = (ytop, ybottom) to cut diagonal strokes flat
    def glyph(self, ch):
        s, h, C, A, R = self.s, self.h, self.cap, self.asc, self.R
        cy = -h / 2
        f = lambda v: f"{v:.2f}"

        def circle(cx, cyy, r):
            return (f"M{f(cx - r)},{f(cyy)} A{f(r)},{f(r)} 0 1 0 {f(cx + r)},{f(cyy)} "
                    f"A{f(r)},{f(r)} 0 1 0 {f(cx - r)},{f(cyy)}")

        def pt(cx, cyy, r, deg):
            a = math.radians(deg)
            return cx + r * math.cos(a), cyy + r * math.sin(a)

        W = 2 * R + s
        if ch == "o":
            return [circle(W / 2, cy, R)], [], W, None, "r", "r"
        if ch == "b":
            return [f"M{f(s/2)},{f(-A)} V0", circle(s / 2 + R, cy, R)], [], W, None, "s", "r"
        if ch == "d":
            x = s / 2 + 2 * R
            return [circle(s / 2 + R, cy, R), f"M{f(x)},{f(-A)} V0"], [], W, None, "r", "s"
        if ch == "a":
            x = s / 2 + 2 * R
            return [circle(s / 2 + R, cy, R), f"M{f(x)},{f(-h)} V0"], [], W, None, "r", "s"
        if ch == "g":
            x = s / 2 + 2 * R
            rg = R * 0.95
            gy = 2.0
            ex, ey = pt(x - rg, gy, rg, 158)
            return ([circle(s / 2 + R, cy, R),
                     f"M{f(x)},{f(-h)} V{f(gy)} A{f(rg)},{f(rg)} 0 0 1 {f(ex)},{f(ey)}"],
                    [], W, None, "r", "s")
        if ch == "e":
            cx = W / 2
            ex, ey = pt(cx, cy, R, 38)
            return ([f"M{f(cx - R)},{f(cy)} H{f(cx + R)} "
                     f"A{f(R)},{f(R)} 0 1 0 {f(ex)},{f(ey)}"], [], W, None, "r", "r")
        if ch == "c":
            cx = W / 2
            sx, sy = pt(cx, cy, R, -42)
            ex, ey = pt(cx, cy, R, 42)
            return [f"M{f(sx)},{f(sy)} A{f(R)},{f(R)} 0 1 0 {f(ex)},{f(ey)}"], [], W * 0.97, None, "r", "r"
        if ch == "r":
            ra = R * 0.92
            x0 = s / 2
            return ([f"M{f(x0)},{f(-h)} V0",
                     f"M{f(x0)},{f(-h + s / 2 + ra)} A{f(ra)},{f(ra)} 0 0 1 {f(x0 + ra)},{f(-h + s / 2)} h{f(s * 0.35)}"],
                    [], x0 + ra + s * 0.35, None, "s", "d")
        if ch == "i":
            dr = s * 0.62
            return ([f"M{f(s/2)},{f(-h)} V0"],
                    [circle(s / 2, -h - s * 0.85 - dr, dr)], s, None, "s", "s")
        if ch == "w":
            q = R * 0.70
            ww = 4 * q + s
            pts = [(s / 2, -h), (s / 2 + q, 0), (s / 2 + 2 * q, -h), (s / 2 + 3 * q, 0), (s / 2 + 4 * q, -h)]
            return [self._poly(pts, 1.0)], [], ww, (-h, 0), "d", "d"
        if ch == "v":
            q = R * 0.95
            pts = [(s / 2, -h), (s / 2 + q, 0), (s / 2 + 2 * q, -h)]
            return [self._poly(pts, 1.0)], [], 2 * q + s, (-h, 0), "d", "d"
        # ---- capitals
        if ch == "A":
            wa = C * 0.92
            pts = [(s * 0.3, 0), (wa / 2, -C), (wa - s * 0.3, 0)]
            yb = -C * 0.30
            t = (C + yb) / C
            xl = s * 0.3 + (wa / 2 - s * 0.3) * (1 - t) + 0
            xl = s * 0.3 + (wa / 2 - s * 0.3) * (-yb / C)
            xr = wa - xl
            return [self._poly(pts, 1.0), f"M{f(xl)},{f(yb)} H{f(xr)}"], [], wa, (-C, 0), "d", "d"
        if ch == "M":
            wm = C * 0.98
            pts = [(s / 2, 0), (s / 2, -C), (wm / 2, -C * 0.22), (wm - s / 2, -C), (wm - s / 2, 0)]
            return [self._poly(pts, 1.0, extend_ends=False)], [], wm, (-C, 0), "s", "s"
        if ch == "O":
            ro = (C - s) / 2
            return [circle(s / 2 + ro, -C / 2, ro)], [], 2 * ro + s, None, "r", "r"
        if ch == "T":
            wt = C * 0.70
            return [f"M0,{f(-C + s/2)} H{f(wt)}", f"M{f(wt/2)},{f(-C)} V0"], [], wt, None, "d", "d"
        if ch == "I":
            return [f"M{f(s/2)},{f(-C)} V0"], [], s, None, "s", "s"
        if ch == "S":
            rs = (C - s) / 4
            cx = s / 2 + rs * 1.02
            cu = -C + s / 2 + rs
            cl = -s / 2 - rs
            sx, sy = pt(cx, cu, rs, -28)
            ex, ey = pt(cx, cl, rs, 152)
            return ([f"M{f(sx)},{f(sy)} A{f(rs)},{f(rs)} 0 1 0 {f(cx)},{f(cu + rs)} "
                     f"A{f(rs)},{f(rs)} 0 1 1 {f(ex)},{f(ey)}"], [], 2 * rs + s + rs * 0.04, None, "r", "r")
        if ch == "D":
            rd = (C - s) / 2
            xm = s / 2 + C * 0.10
            return ([f"M{f(s/2)},{f(-C)} V0",
                     f"M{f(s/2)},{f(-C + s/2)} H{f(xm)} A{f(rd)},{f(rd)} 0 0 1 {f(xm)},{f(-s/2)} H{f(s/2)}"],
                    [], xm + rd + s / 2, None, "s", "r")
        if ch == "B":
            rb = (C - s) / 4
            xu = s / 2 + C * 0.20
            xl = s / 2 + C * 0.24
            rl = rb
            return ([f"M{f(s/2)},{f(-C)} V0",
                     f"M{f(s/2)},{f(-C + s/2)} H{f(xu)} A{f(rb)},{f(rb)} 0 0 1 {f(xu)},{f(-C/2)} H{f(s/2)}",
                     f"M{f(s/2)},{f(-C/2)} H{f(xl)} A{f(rl)},{f(rl)} 0 0 1 {f(xl)},{f(-s/2)} H{f(s/2)}"],
                    [], xl + rl + s / 2, None, "s", "r")
        if ch == "R":
            rb = (C * 0.52 - s) / 2
            xu = s / 2 + C * 0.20
            yb = -C + s / 2 + 2 * rb
            wr = xu + rb + s / 2
            return ([f"M{f(s/2)},{f(-C)} V0",
                     f"M{f(s/2)},{f(-C + s/2)} H{f(xu)} A{f(rb)},{f(rb)} 0 0 1 {f(xu)},{f(yb)} H{f(s/2)}",
                     f"M{f(xu - s*0.2)},{f(yb)} L{f(wr + s*0.15)},{f(s)}"],
                    [], wr, (-C - s, 0), "s", "d")
        if ch == "G":
            rg = (C - s) / 2
            cx, cyy = s / 2 + rg, -C / 2
            sx, sy = pt(cx, cyy, rg, -40)
            return ([f"M{f(sx)},{f(sy)} A{f(rg)},{f(rg)} 0 1 0 {f(cx + rg)},{f(cyy + s*0.1)} V{f(cyy)} H{f(cx + rg*0.05)}"],
                    [], 2 * rg + s, None, "r", "r")
        if ch == "E":
            we = C * 0.56
            return ([f"M{f(s/2)},{f(-C)} V0",
                     f"M{f(s/2)},{f(-C + s/2)} H{f(we)}",
                     f"M{f(s/2)},{f(-C/2)} H{f(we * 0.9)}",
                     f"M{f(s/2)},{f(-s/2)} H{f(we)}"], [], we, None, "s", "d")
        if ch == "W":
            q = C * 0.30
            pts = [(s / 2, -C), (s / 2 + q, 0), (s / 2 + 2 * q, -C), (s / 2 + 3 * q, 0), (s / 2 + 4 * q, -C)]
            return [self._poly(pts, 1.0)], [], 4 * q + s, (-C, 0), "d", "d"
        if ch == " ":
            return [], [], self.h * 0.42, None, "x", "x"
        raise KeyError(ch)

    def _poly(self, pts, ext=1.0, extend_ends=True):
        """Polyline; first and last segments are extended so a flat clip cuts them square."""
        p = list(pts)
        if extend_ends:
            for i, j in ((0, 1), (-1, -2)):
                (x0, y0), (x1, y1) = p[i], p[j]
                dx, dy = x0 - x1, y0 - y1
                L = math.hypot(dx, dy)
                k = self.s * 1.2 * ext / L
                p[i] = (x0 + dx * k, y0 + dy * k)
        else:
            # vertical stems: extend past the clip lines too
            (x0, y0) = p[0]
            p[0] = (x0, y0 + self.s)
            (x1, y1) = p[-1]
            p[-1] = (x1, y1 + self.s)
        return "M" + " L".join(f"{x:.2f},{y:.2f}" for x, y in p)


_CLIP_IDS = itertools.count()  # deterministic clip-path ids, so reruns give identical files

SB = {"s": 1.0, "r": 0.55, "d": 0.12, "x": 0.0}


def set_text(font, text, tracking=0.0, unit=None):
    """Lay out a string. Returns (svg_group_inner, width, top, bottom)."""
    unit = unit if unit is not None else font.s * 0.95
    x = 0.0
    parts = []
    clips = []
    prev_right = None
    for ch in text:
        strokes, fills, w, clip, lk, rk = font.glyph(ch)
        if prev_right is not None and ch != " " and lk != "x":
            x += (SB[prev_right] + SB[lk]) * unit + tracking
        elif prev_right is not None:
            x += tracking
        g = []
        for d in strokes:
            g.append(f'<path d="{d}"/>')
        fill_parts = "".join(f'<path d="{d}" stroke="none" fill="currentColor"/>' for d in fills)
        if clip:
            cid = f"c{next(_CLIP_IDS)}"
            clips.append(f'<clipPath id="{cid}"><rect x="{-font.s*2:.2f}" y="{clip[0]:.2f}" '
                         f'width="{w + font.s*4:.2f}" height="{clip[1]-clip[0]:.2f}"/></clipPath>')
            parts.append(f'<g transform="translate({x:.2f} 0)"><g clip-path="url(#{cid})">{"".join(g)}</g>{fill_parts}</g>')
        else:
            parts.append(f'<g transform="translate({x:.2f} 0)">{"".join(g)}{fill_parts}</g>')
        x += w
        prev_right = rk if ch != " " else None
    defs = f"<defs>{''.join(clips)}</defs>" if clips else ""
    inner = (f'{defs}<g fill="none" stroke="currentColor" stroke-width="{font.s:.2f}" '
             f'stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="10">{"".join(parts)}</g>')
    return inner, x


def word(font, text, color, tracking=0.0, unit=None):
    inner, w = set_text(font, text, tracking, unit)
    return f'<g style="color:{color}" color="{color}">{inner}</g>', w



def mark_rings(navy, blue, gold):
    """A 'D' drawn with MOATiT's rings: navy post, blue outer ring, gold inner ring (the one crossing)."""
    return (f'<rect x="7" y="5" width="9" height="54" fill="{navy}"/>'
            f'<path d="M16 9.5 H29 A22.5 22.5 0 0 1 29 54.5 H16" fill="none" stroke="{blue}" stroke-width="9"/>'
            f'<path d="M16 24.5 H29 A7.5 7.5 0 0 1 29 39.5 H16" fill="none" stroke="{gold}" stroke-width="7"/>')


def fav_rings(bg, fg, blue, gold):
    return (f'<rect width="32" height="32" rx="6" fill="{bg}"/>'
            f'<rect x="5" y="4" width="5" height="24" fill="{fg}"/>'
            f'<path d="M10 6 H15 A10 10 0 0 1 15 26 H10" fill="none" stroke="{blue}" stroke-width="4"/>'
            f'<path d="M10 13 H15 A3 3 0 0 1 15 19 H10" fill="none" stroke="{gold}" stroke-width="4"/>')


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
    mark_size = 96.0
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
    mid = Font(s=7.0, h=52, cap=72, asc=76)
    small = Font(s=4.2, h=24, cap=32, asc=33)
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
                                       rule_color=rule, wm_tracking=0.4)
        files[name] = svg((0, 0, round(w, 2), round(h, 2)), body, title, w, h)

    for name, navy, blue, gold, wmc, enc in (
        ("drawbridge-lockup-stacked", NAVY, BLUE, GOLD, INK, (SLATE, NAVY)),
        ("drawbridge-lockup-stacked-reverse", WHITE, BLUE, AMBER, WHITE, (ON_INK, WHITE)),
    ):
        body, w, h = lockup_stacked(mark_rings(navy, blue, gold), mid, "Drawbridge", wmc, small, enc, BLUE, wm_tracking=0.4)
        files[name] = svg((0, 0, round(w, 2), round(h, 2)), body, title, w, h)

    for name, args in (("drawbridge-mark", (NAVY, BLUE, GOLD)), ("drawbridge-mark-reverse", (WHITE, BLUE, AMBER)),
                       ("drawbridge-mark-mono", (INK, INK, INK))):
        files[name] = svg((0, 0, 64, 64), mark_rings(*args), "Drawbridge mark", 64, 64)
    files["favicon"] = svg((0, 0, 32, 32), fav_rings(WHITE, NAVY, BLUE, GOLD), "Drawbridge", 32, 32)

    for out in (OUT_SITE, OUT_KIT):
        for name, content in files.items():
            write(os.path.join(out, name + ".svg"), content)
    for name, content in files.items():
        if name.endswith(("lockup", "reverse", "stacked", "mark", "favicon")):
            print(f"{name}.svg  {content.split('viewBox=\"')[1].split('\"')[0]}")
    print("logos written to src/assets/brand/ and brand/logo/")


if __name__ == "__main__":
    build()
