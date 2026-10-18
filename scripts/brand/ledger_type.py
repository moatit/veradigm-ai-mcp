"""Ledger type: the outlined letters of the Drawbridge wordmark and endorsement.

Type-design pass on the concept's stroked skeleton (Oct 18, 2026). Every letter is a filled
outline built on a geometric construction, with the corrections a typeface makes:

- stroke contrast: horizontals (the tops and bottoms of bowls) are about 87% of the verticals;
- overshoot: round letters rise above the x-height and dip below the baseline by 10 units;
- lighter joins: bowls that meet a stem are thinner at the join than the free-standing "o";
- terminals cut on the radius, an i-dot about 1.28x the stem, pointed but trimmed vertices;
- spacing from per-letter side bearings plus kerning pairs, not a formula.

Design units, y up: x-height 520, cap height 720, ascender 760, descender about -225.
`Type(...).word(text, colour)` returns an SVG group scaled to the requested x-height, baseline at y=0
and y growing downward, so it drops into the lockup code unchanged.
"""
import math

H, CAP, ASC, OV = 520.0, 720.0, 760.0, 10.0


def _f(v):
    s = f"{v:.1f}"
    return s[:-2] if s.endswith(".0") else s


def _pt(cx, cy, rx, ry, t):
    a = math.radians(t)
    return cx + rx * math.cos(a), cy + ry * math.sin(a)


def _arc(cx, cy, rx, ry, t1, t2):
    """SVG arc command (y-up coordinates) from angle t1 to t2; counter-clockwise when t2 > t1."""
    x, y = _pt(cx, cy, rx, ry, t2)
    large = 1 if abs(t2 - t1) > 180 else 0
    sweep = 1 if t2 > t1 else 0  # y-up: counter-clockwise is the positive-angle direction
    return f"A{_f(rx)} {_f(ry)} 0 {large} {sweep} {_f(x)} {_f(y)}"


def ellipse(cx, cy, rx, ry):
    x0, y0 = _pt(cx, cy, rx, ry, 0)
    return f"M{_f(x0)} {_f(y0)} {_arc(cx, cy, rx, ry, 0, 180)} {_arc(cx, cy, rx, ry, 180, 360)} Z"


def ring(cx, cy, rxo, ryo, rxi, ryi):
    return ("evenodd", ellipse(cx, cy, rxo, ryo) + " " + ellipse(cx, cy, rxi, ryi))


def ring_segment(cx, cy, rxo, ryo, rxi, ryi, t1, t2):
    """Annulus segment from t1 to t2 (either direction), cut on the radius at both ends."""
    x1, y1 = _pt(cx, cy, rxo, ryo, t1)
    xi2, yi2 = _pt(cx, cy, rxi, ryi, t2)
    return ("nonzero", f"M{_f(x1)} {_f(y1)} {_arc(cx, cy, rxo, ryo, t1, t2)} L{_f(xi2)} {_f(yi2)} "
                       f"{_arc(cx, cy, rxi, ryi, t2, t1)} Z")


def rect(x0, y0, x1, y1):
    return ("nonzero", f"M{_f(x0)} {_f(y0)} H{_f(x1)} V{_f(y1)} H{_f(x0)} Z")


def poly(points):
    return ("nonzero", "M" + " L".join(f"{_f(x)} {_f(y)}" for x, y in points) + " Z")


def _line_x(a, b, y):
    (x0, y0), (x1, y1) = a, b
    return x0 + (x1 - x0) * (y - y0) / (y1 - y0)


def _clip(poly_pts, ymin, ymax):
    """Sutherland-Hodgman against the horizontal band ymin <= y <= ymax."""
    def cut(pts, keep, edge_y):
        out = []
        for i, cur in enumerate(pts):
            prev = pts[i - 1]
            if keep(cur):
                if not keep(prev):
                    out.append((_line_x(prev, cur, edge_y), edge_y))
                out.append(cur)
            elif keep(prev):
                out.append((_line_x(prev, cur, edge_y), edge_y))
        return out
    pts = cut(poly_pts, lambda p: p[1] >= ymin, ymin)
    return cut(pts, lambda p: p[1] <= ymax, ymax)


def stroke(points, width, ymin, ymax):
    """Outline of a polyline stroked with mitred joins and square ends, clipped to a band.
    Mitred joins put each vertex where the offset edges meet, as a drawn letter would."""
    hw = width / 2
    n = len(points)
    normals, dirs = [], []
    for i in range(n - 1):
        (x0, y0), (x1, y1) = points[i], points[i + 1]
        L = math.hypot(x1 - x0, y1 - y0)
        dx, dy = (x1 - x0) / L, (y1 - y0) / L
        dirs.append((dx, dy))
        normals.append((-dy, dx))

    def side(sign):
        pts = [(points[0][0] + sign * hw * normals[0][0], points[0][1] + sign * hw * normals[0][1])]
        for j in range(1, n - 1):
            p1 = (points[j][0] + sign * hw * normals[j - 1][0], points[j][1] + sign * hw * normals[j - 1][1])
            p2 = (points[j][0] + sign * hw * normals[j][0], points[j][1] + sign * hw * normals[j][1])
            d1, d2 = dirs[j - 1], dirs[j]
            den = d1[0] * d2[1] - d1[1] * d2[0]
            t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / den
            pts.append((p1[0] + t * d1[0], p1[1] + t * d1[1]))
        pts.append((points[-1][0] + sign * hw * normals[-1][0], points[-1][1] + sign * hw * normals[-1][1]))
        return pts

    outline = side(+1) + side(-1)[::-1]
    return poly(_clip(outline, ymin, ymax))


class Type:
    """One optical size of the Ledger letters.

    sv: vertical stem, sh: horizontal stroke, sd: diagonal stroke (all design units at x-height 520).
    height: rendered x-height in output units.
    """

    def __init__(self, height, sv=72.0, sh=62.0, sd=68.0, cap_sv=None, cap_sh=None, spacing=1.0):
        self.k = height / H
        self.sv, self.sh, self.sd = sv, sh, sd
        self.cv = cap_sv or sv * 1.08
        self.ch = cap_sh or sh * 1.06
        self.spacing = spacing
        # attributes the lockup code reads, in output units
        self.h, self.cap, self.asc, self.s = height, CAP * self.k, ASC * self.k, sv * self.k

    # ------------------------------------------------------------ glyphs
    # each returns (shapes, ink_width, lsb, rsb); shapes are (fill_rule, path) in design units
    def glyph(self, ch):
        sv, sh, sd, cv, chh = self.sv, self.sh, self.sd, self.cv, self.ch
        cy = H / 2
        ry_o = cy + OV                       # round letters overshoot top and bottom
        if ch == "o":
            rx = 266
            return [ring(rx, cy, rx, ry_o, rx - sv, ry_o - sh)], 2 * rx, 40, 40
        if ch in "bdag":
            rx = 256                         # bowls on a stem are a touch narrower than "o"
            ryi = ry_o - sh * 0.9            # and lighter where they meet it
            if ch == "b":
                cx = sv + rx - sv            # counter touches the stem's right edge
                shapes = [rect(0, 0, sv, ASC), ring(cx, cy, rx, ry_o, rx - sv, ryi)]
                return shapes, cx + rx, 64, 40
            cx = rx
            stem_x = cx + rx - sv
            top = ASC if ch == "d" else H
            if ch != "g":
                return [ring(cx, cy, rx, ry_o, rx - sv, ryi), rect(stem_x, 0, cx + rx, top)], 2 * rx, 40, 64
            # g: the stem drops to the descender and turns left into a hook
            hy, rxh, ryh = -20.0, 236.0, 205.0
            hx = cx + rx - rxh
            shapes = [ring(cx, cy, rx, ry_o, rx - sv, ryi), rect(stem_x, hy, cx + rx, H),
                      ring_segment(hx, hy, rxh, ryh, rxh - sv, ryh - sh, 0, -163)]
            return shapes, 2 * rx, 40, 64
        if ch == "e":
            rx = 262
            bar_c, bar_h = cy + 12, sh * 0.95
            shapes = [ring_segment(rx, cy, rx, ry_o, rx - sv, ry_o - sh, 0, 328),
                      rect(sv * 0.5, bar_c - bar_h / 2, 2 * rx, bar_c + bar_h / 2)]
            return shapes, 2 * rx, 40, 34
        if ch == "c":
            rx = 252
            return [ring_segment(rx, cy, rx, ry_o, rx - sv, ry_o - sh, 44, 316)], 2 * rx, 40, 24
        if ch == "r":
            rxo, ryo = 212.0, 240.0
            ccx, ccy = rxo, H + OV - ryo
            shapes = [rect(0, 0, sv, H), ring_segment(ccx, ccy, rxo, ryo, rxo - sv, ryo - sh, 178, 66)]
            ink = _pt(ccx, ccy, rxo, ryo, 66)[0]
            return shapes, ink, 64, 6
        if ch == "i":
            dr = sv * 0.64
            return [rect(0, 0, sv, H), ("nonzero", ellipse(sv / 2, H + 1.30 * sv + dr, dr, dr))], sv, 64, 64
        if ch in "wv":
            # zigzag centre lines, vertices pushed past the clip lines so they trim to a small flat
            vd = sd * 0.42
            if ch == "w":
                q = 176.0
                xs = [0, q, 2 * q, 3 * q, 4 * q]
                ys = [H + vd, -vd, H + vd, -vd, H + vd]
            else:
                q = 232.0
                xs = [0, q, 2 * q]
                ys = [H + vd, -vd, H + vd]
            # extend the two outer ends along their own segments, so every leg keeps one angle
            pts = list(zip(xs, ys))
            for i, j in ((0, 1), (-1, -2)):
                (x0, y0), (x1, y1) = pts[i], pts[j]
                pts[i] = (x0 - (x1 - x0) * 0.3, y0 - (y1 - y0) * 0.3)
            shape = stroke(pts, sd, 0, H)
            xsx = [float(p.split()[0]) for p in shape[1][1:-2].split(" L")]
            x0 = min(xsx)
            shape = ("nonzero", _shift(shape[1], -x0))
            return [shape], max(xsx) - x0, 10, 10
        # ---- capitals (endorsement and the D)
        if ch == "D":
            xc, rxo = 228.0, 300.0
            rxi, ryi = rxo - cv, CAP / 2 - chh
            d = (f"M0 0 H{_f(xc)} {_arc(xc, CAP / 2, rxo, CAP / 2, -90, 90)} H0 Z "
                 f"M{_f(cv)} {_f(chh)} H{_f(xc)} {_arc(xc, CAP / 2, rxi, ryi, -90, 90)} H{_f(cv)} Z")
            return [("evenodd", d)], xc + rxo, 72, 34
        if ch == "O":
            rx, ry = 372.0, CAP / 2 + OV
            return [ring(rx, CAP / 2, rx, ry, rx - cv, ry - chh)], 2 * rx, 40, 40
        if ch == "T":
            w = 452.0
            return [rect(0, CAP - chh, w, CAP), rect((w - cv) / 2, 0, (w + cv) / 2, CAP)], w, 14, 14
        if ch == "A":
            w, vd = 600.0, sd * 0.5
            pts = [(-60, -200), (w / 2, CAP + vd), (w + 60, -200)]
            shape = stroke(pts, sd * 1.04, 0, CAP)
            xsx = [float(p.split()[0]) for p in shape[1][1:-2].split(" L")]
            x0 = min(xsx)
            bar_y = CAP * 0.27
            lx = _line_x((-60, -200), (w / 2, CAP + vd), bar_y) - x0
            rx_ = _line_x((w + 60, -200), (w / 2, CAP + vd), bar_y) - x0
            return [("nonzero", _shift(shape[1], -x0)), rect(lx, bar_y, rx_, bar_y + chh * 0.92)], max(xsx) - x0, 8, 8
        if ch == "M":
            w = 700.0
            vy = CAP * 0.16
            pl, pm, pr = (sd * 0.6, CAP), (w / 2, vy), (w - sd * 0.6, CAP)
            ext = lambda p: (p[0] + (p[0] - pm[0]) * 0.35, p[1] + (p[1] - pm[1]) * 0.35)
            stroke_v = stroke([ext(pl), pm, ext(pr)], sd, 0, CAP)
            return [rect(0, 0, cv, CAP), rect(w - cv, 0, w, CAP), stroke_v], w, 72, 72
        if ch == "S":
            sp_c = CAP * 0.53
            ryu = (CAP + OV - (sp_c - chh / 2)) / 2
            ryl = ((sp_c + chh / 2) + OV) / 2
            yu, yl = CAP + OV - ryu, ryl - OV
            rxl, rxu = 232.0, 214.0
            cx = rxl + 4
            shapes = [ring_segment(cx, yu, rxu, ryu, rxu - cv, ryu - chh, 24, 270),
                      ring_segment(cx, yl, rxl, ryl, rxl - cv, ryl - chh, 90, -156)]
            return shapes, 2 * rxl + 8, 34, 34
        if ch == " ":
            return [], 0, 0, H * 0.46
        raise KeyError(ch)

    # ------------------------------------------------------------ setting
    KERN = {("r", "a"): -18, ("r", "e"): -14, ("r", "v"): -10, ("A", "T"): -46, ("T", "i"): -34,
            ("i", "T"): -20, ("O", "A"): -22, ("A", "M"): -4, ("D", "r"): -18, ("a", "w"): -6,
            ("w", "b"): -4, ("r", "i"): -2, ("e", "r"): -4, ("c", "e"): -4}

    def layout(self, text, tracking=0.0):
        """Returns ([(x, shapes)], advance) in design units."""
        x, prev, out = 0.0, None, []
        for ch in text:
            shapes, ink, lsb, rsb = self.glyph(ch)
            lsb, rsb = lsb * self.spacing, rsb * self.spacing
            if prev is not None:
                x += self.KERN.get((prev, ch), 0) + tracking
            x += lsb
            out.append((x, shapes))
            x += ink + rsb
            prev = ch
        # trim the outer side bearings so the word's box starts and ends at its ink
        first_lsb = self.glyph(text[0])[2] * self.spacing
        last_rsb = self.glyph(text[-1])[3] * self.spacing
        out = [(gx - first_lsb, s) for gx, s in out]
        return out, x - first_lsb - last_rsb

    def word(self, text, colour, tracking=0.0):
        """SVG group, baseline at y=0, y down, in output units. Returns (svg, width)."""
        placed, adv = self.layout(text, tracking)
        paths = []
        for gx, shapes in placed:
            for rule, d in shapes:
                d = _shift(d, gx)
                paths.append(f'<path fill-rule="{rule}" d="{d}"/>' if rule == "evenodd" else f'<path d="{d}"/>')
        k = self.k
        return (f'<g fill="{colour}" transform="scale({k:.5f} {-k:.5f})">{"".join(paths)}</g>', adv * k)


def _shift(d, dx):
    """Shift every x coordinate of a path made by this module (M/L/H/A/V/Z commands) by dx."""
    if dx == 0:
        return d
    out, toks = [], d.replace("M", " M ").replace("L", " L ").replace("H", " H ").replace("V", " V ") \
        .replace("A", " A ").replace("Z", " Z ").split()
    i = 0
    while i < len(toks):
        t = toks[i]
        if t in ("M", "L"):
            out += [t, _f(float(toks[i + 1]) + dx), toks[i + 2]]
            i += 3
        elif t == "H":
            out += [t, _f(float(toks[i + 1]) + dx)]
            i += 2
        elif t == "V":
            out += [t, toks[i + 1]]
            i += 2
        elif t == "A":
            out += [t] + toks[i + 1:i + 6] + [_f(float(toks[i + 6]) + dx), toks[i + 7]]
            i += 8
        elif t == "Z":
            out.append("Z")
            i += 1
        else:
            raise ValueError(t)
    return " ".join(out).replace("M ", "M").replace("L ", "L").replace("H ", "H").replace("V ", "V").replace("A ", "A")
