"""Hand-built logo generator for the three Drawbridge concept directions.

No fonts, no dependencies: every letter is drawn from lines and arcs on a
Poppins-like geometric skeleton, so the SVGs render the same everywhere.

    python concepts/_tools/build_logos.py
"""
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# MOATiT house colours (moatit.com CSS and the MOATiT document style)
NAVY = "#3E3E84"   # logo wordmark / document navy
INK = "#222236"    # moatit.com heading ink
NIGHT = "#1A1A33"  # deepened ink for dark grounds
BLUE = "#29AAE1"   # logo arc / site accent
GOLD = "#C68010"   # document gold (text-safe on white at large sizes)
AMBER = "#F5A623"  # site amber (on dark only)
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
            cid = f"c{len(clips)}_{abs(hash((text, x))) % 99999}"
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


# ---------------------------------------------------------------- marks (64 grid)
def mark_gatehouse(navy, gold, animate=False, uid="g"):
    """D monogram; its counter is the gate, and the gold deck runs out of it across the moat.
    A 2-unit channel is cut around the deck so it still reads in one colour."""
    mid = f"dbcut-{uid}-{navy.strip('#')}"
    return (f'<mask id="{mid}" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">'
            f'<rect width="64" height="64" fill="#fff"/><rect x="19" y="33" width="45" height="10" fill="#000"/></mask>'
            f'<path mask="url(#{mid})" fill="{navy}" fill-rule="evenodd" d="M8 6 H30 A23 23 0 0 1 30 52 H8 Z '
            f'M19 17 H29 A12 12 0 0 1 29 41 H19 Z"/>'
            f'<rect class="deck" x="19" y="35" width="41" height="6" fill="{gold}"/>')


def mark_rings(navy, blue, gold):
    """A 'D' drawn with MOATiT's rings: navy post, blue outer ring, gold inner ring (the one crossing)."""
    return (f'<rect x="7" y="5" width="9" height="54" fill="{navy}"/>'
            f'<path d="M16 9.5 H29 A22.5 22.5 0 0 1 29 54.5 H16" fill="none" stroke="{blue}" stroke-width="9"/>'
            f'<path d="M16 24.5 H29 A7.5 7.5 0 0 1 29 39.5 H16" fill="none" stroke="{gold}" stroke-width="7"/>')


def mark_shield(navy, gold, inner="#FFFFFF"):
    """MOATiT's shield with a gate: arched doorway, gold deck lowered over the threshold."""
    shield = "M32 4 L56 11 V30 C56 45 46 55 32 61 C18 55 8 45 8 30 V11 Z"
    door = "M24 52 V34 A8 8 0 0 1 40 34 V52 Z"
    return (f'<path fill="{navy}" fill-rule="evenodd" d="{shield} {door}"/>'
            f'<rect x="20" y="47" width="24" height="5" fill="{gold}"/>')


# favicons are redrawn on a 32 grid, snapped to whole pixels for 16 px
def fav_gatehouse(bg, fg, gold):
    return (f'<rect width="32" height="32" rx="6" fill="{bg}"/>'
            f'<path fill="{fg}" fill-rule="evenodd" d="M5 5 H16 A11.5 11.5 0 0 1 16 28 H5 Z M10 11 H16 A5.5 5.5 0 0 1 16 22 H10 Z"/>'
            f'<rect x="10" y="18" width="20" height="5" fill="{bg}"/>'
            f'<rect x="10" y="19" width="19" height="3" fill="{gold}"/>')


def fav_rings(bg, fg, blue, gold):
    return (f'<rect width="32" height="32" rx="6" fill="{bg}"/>'
            f'<rect x="5" y="4" width="5" height="24" fill="{fg}"/>'
            f'<path d="M10 6 H15 A10 10 0 0 1 15 26 H10" fill="none" stroke="{blue}" stroke-width="4"/>'
            f'<path d="M10 13 H15 A3 3 0 0 1 15 19 H10" fill="none" stroke="{gold}" stroke-width="4"/>')


def fav_shield(bg, fg, gold):
    return (f'<rect width="32" height="32" rx="6" fill="{bg}"/>'
            f'<path fill="{fg}" fill-rule="evenodd" d="M16 3 L27 6 V15 C27 22 22 26.5 16 29 C10 26.5 5 22 5 15 V6 Z M12 25 V17 A4 4 0 0 1 20 17 V25 Z"/>'
            f'<rect x="10" y="23" width="12" height="3" fill="{gold}"/>')


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


def build():
    out = {}

    # ---------------- A. Gatehouse: bold Poppins-like wordmark, D monogram
    d = os.path.join(ROOT, "gatehouse", "logo")
    big = Font(s=11.0, h=52, cap=72, asc=76)
    small = Font(s=5.2, h=24, cap=32, asc=33)
    for name, navy, gold, wmc, enc in (
        ("lockup", NAVY, GOLD, NAVY, (INK, NAVY)),
        ("lockup-reverse", WHITE, AMBER, WHITE, ("#C9CAE6", WHITE)),
        ("lockup-mono", INK, INK, INK, (INK, INK)),
    ):
        body, w, h = lockup_horizontal(mark_gatehouse(navy, gold), 1.0, big, "Drawbridge", wmc, small, enc,
                                       wm_tracking=-0.6)
        write(os.path.join(d, f"{name}.svg"), svg((0, 0, w, h), body, "Drawbridge, A MOATiT Service"))
        out[f"gatehouse/{name}"] = (w, h)
    for name, navy, gold in (("mark", NAVY, GOLD), ("mark-reverse", WHITE, AMBER), ("mark-mono", INK, INK)):
        write(os.path.join(d, f"{name}.svg"), svg((0, 0, 64, 64), mark_gatehouse(navy, gold), "Drawbridge mark"))
    write(os.path.join(d, "favicon.svg"), svg((0, 0, 32, 32), fav_gatehouse(NAVY, WHITE, AMBER), "Drawbridge"))
    wm, wmw = word(big, "Drawbridge", NAVY, -0.6)
    write(os.path.join(d, "wordmark.svg"), svg((0, -80, wmw, 104), wm, "Drawbridge"))

    # ---------------- B. Ledger: lighter wordmark, MOATiT rings opened into a sweep
    d = os.path.join(ROOT, "ledger", "logo")
    mid = Font(s=7.0, h=52, cap=72, asc=76)
    small_b = Font(s=4.2, h=24, cap=32, asc=33)
    for name, navy, blue, gold, wmc, enc, rule in (
        ("lockup", NAVY, BLUE, GOLD, INK, ("#5A5C78", NAVY), BLUE),
        ("lockup-reverse", WHITE, BLUE, AMBER, WHITE, ("#C9CAE6", WHITE), BLUE),
        ("lockup-mono", INK, INK, INK, INK, (INK, INK), INK),
    ):
        body, w, h = lockup_horizontal(mark_rings(navy, blue, gold), 1.0, mid, "Drawbridge", wmc, small_b, enc,
                                       rule_color=rule, wm_tracking=0.4)
        write(os.path.join(d, f"{name}.svg"), svg((0, 0, w, h), body, "Drawbridge, A MOATiT Service"))
    for name, args in (("mark", (NAVY, BLUE, GOLD)), ("mark-reverse", (WHITE, BLUE, AMBER)), ("mark-mono", (INK, INK, INK))):
        write(os.path.join(d, f"{name}.svg"), svg((0, 0, 64, 64), mark_rings(*args), "Drawbridge mark"))
    write(os.path.join(d, "favicon.svg"), svg((0, 0, 32, 32), fav_rings("#FFFFFF", NAVY, BLUE, GOLD), "Drawbridge"))
    wm, wmw = word(mid, "Drawbridge", INK, 0.4)
    write(os.path.join(d, "wordmark.svg"), svg((0, -80, wmw, 104), wm, "Drawbridge"))

    # ---------------- C. Night Watch: spaced capitals, MOATiT shield with a gate
    d = os.path.join(ROOT, "nightwatch", "logo")
    caps = Font(s=6.4, h=52, cap=60, asc=60)
    small_c = Font(s=4.0, h=24, cap=32, asc=33)
    for name, navy, gold, wmc, enc in (
        ("lockup", NAVY, GOLD, INK, ("#5A5C78", NAVY)),
        ("lockup-reverse", "#F2F2FA", AMBER, "#F2F2FA", ("#AEB0D4", "#F2F2FA")),
        ("lockup-mono", INK, INK, INK, (INK, INK)),
    ):
        body, w, h = lockup_horizontal(mark_shield(navy, gold), 1.0, caps, "DRAWBRIDGE", wmc, small_c, enc,
                                       wm_tracking=12.0)
        write(os.path.join(d, f"{name}.svg"), svg((0, 0, w, h), body, "Drawbridge, A MOATiT Service"))
    for name, navy, gold in (("mark", NAVY, GOLD), ("mark-reverse", "#F2F2FA", AMBER), ("mark-mono", INK, INK)):
        write(os.path.join(d, f"{name}.svg"), svg((0, 0, 64, 64), mark_shield(navy, gold), "Drawbridge mark"))
    write(os.path.join(d, "favicon.svg"), svg((0, 0, 32, 32), fav_shield(NIGHT, "#F2F2FA", AMBER), "Drawbridge"))
    wm, wmw = word(caps, "DRAWBRIDGE", INK, 12.0)
    write(os.path.join(d, "wordmark.svg"), svg((0, -70, wmw, 80), wm, "Drawbridge"))
    print("logos written")


if __name__ == "__main__":
    build()
