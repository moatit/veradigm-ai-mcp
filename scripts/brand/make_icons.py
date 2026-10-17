"""Render PNG icons and the Open Graph image from the SVG brand files (Playwright + local Chrome).

    python scripts/brand/make_logo.py   # first, if the SVGs changed
    python scripts/brand/make_icons.py

Writes src/static/favicon.ico, src/static/apple-touch-icon.png, src/assets/brand/icon-{192,512}.png,
src/assets/img/og-drawbridge.png and brand/logo/*.png exports. Ledger style: white ground, MOATiT blue
rule, Poppins headline, no photography.
"""
from io import BytesIO
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / "src" / "assets" / "brand"
STATIC = ROOT / "src" / "static"
IMG = ROOT / "src" / "assets" / "img"
FONTS = ROOT / "src" / "assets" / "fonts"
KIT = ROOT / "brand" / "logo"
STATIC.mkdir(parents=True, exist_ok=True)

# The OG card: the headline and a slice of the synthetic intake ledger from the home page.
OG_HTML = """<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Poppins;src:url('%(fonts)s/poppins-latin-500-normal.woff2');font-weight:500}
@font-face{font-family:Poppins;src:url('%(fonts)s/poppins-latin-600-normal.woff2');font-weight:600}
@font-face{font-family:Barlow;src:url('%(fonts)s/barlow-latin-500-normal.woff2');font-weight:500}
@font-face{font-family:Barlow;src:url('%(fonts)s/barlow-latin-600-normal.woff2');font-weight:600}
html,body{margin:0;width:1200px;height:630px;overflow:hidden;background:#fff;color:#222236}
body{border-top:10px solid #29AAE1;box-sizing:border-box;position:relative}
.logo{position:absolute;left:72px;top:56px;height:78px}
h1{position:absolute;left:72px;top:176px;width:1000px;margin:0;font:500 70px/1.02 Poppins,sans-serif;letter-spacing:-2.4px}
h1 span{color:#0F6E9C}
.rows{position:absolute;left:72px;right:72px;bottom:86px;border-top:2px solid #222236;font:500 22px/1 Barlow,sans-serif}
.r{display:grid;grid-template-columns:120px 1fr 230px;align-items:center;gap:20px;padding:16px 0;border-bottom:1px solid #DCE3EA}
.r i{font-style:normal;color:#5A5C78;font-variant-numeric:tabular-nums}
.r b{justify-self:start;font:600 18px/1 Poppins,sans-serif;padding:8px 12px;border-left:4px solid #29AAE1;background:#EAF6FC}
.r b.p{border-color:#C68010;background:#FBF1DF;color:#8A5A0B}
.u{position:absolute;left:72px;bottom:34px;font:600 20px Barlow,sans-serif;color:#5A5C78}
.s{position:absolute;right:72px;bottom:34px;font:500 18px Barlow,sans-serif;color:#8A5A0B}
</style></head><body>
<img class="logo" src="%(brand)s/drawbridge-lockup.svg">
<h1>Lab results filed. Calls answered. <span>Nothing guessed.</span></h1>
<div class="rows">
<div class="r"><i>7:42</i><span>Lab result, 3 pages</span><b>Filed</b></div>
<div class="r"><i>8:11</i><span>Lab batch, two patients on one page</span><b class="p">To a person</b></div>
</div>
<div class="u">drawbridge.moatit.com</div><div class="s">Synthetic sample, invented patients</div>
</body></html>"""


def svg_png(page, svg_text: str, size: int) -> bytes:
    page.set_viewport_size({"width": size, "height": size})
    sized = svg_text.replace("<svg ", f'<svg width="{size}" height="{size}" ', 1)
    sized = sized.replace(' width="32" height="32" role', ' role', 1).replace(' width="64" height="64" role', ' role', 1)
    page.set_content(f'<html><body style="margin:0;background:transparent">{sized}</body></html>')
    return page.screenshot(omit_background=True, clip={"x": 0, "y": 0, "width": size, "height": size})


def main() -> None:
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", args=["--allow-file-access-from-files"])
        page = b.new_page(viewport={"width": 512, "height": 512})
        fav = (BRAND / "favicon.svg").read_text(encoding="utf-8")
        for size, out in [(512, BRAND / "icon-512.png"), (192, BRAND / "icon-192.png"), (180, STATIC / "apple-touch-icon.png"),
                          (64, KIT / "favicon-64.png"), (32, KIT / "favicon-32.png")]:
            out.write_bytes(svg_png(page, fav, size))
        # favicon.ico: each size rendered from the pixel-snapped 32-grid SVG, not downsampled from 512
        ico = [Image.open(BytesIO(svg_png(page, fav, s))).convert("RGBA") for s in (48, 32, 16)]
        ico[0].save(STATIC / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)], append_images=ico[1:])
        # transparent PNG exports of the lockups for docs and email signatures (reverse on MOATiT ink)
        for name, bg in [("drawbridge-lockup", None), ("drawbridge-lockup-reverse", "#222236"),
                         ("drawbridge-lockup-stacked", None), ("drawbridge-mark", None)]:
            svg = (BRAND / (name + ".svg")).read_text(encoding="utf-8")
            vb = [float(v) for v in svg.split('viewBox="')[1].split('"')[0].split()]
            w = 512 if name.endswith("mark") else round(vb[2] * 1.6)  # about 4x the on-screen header size
            h = round(w * vb[3] / vb[2])
            page.set_viewport_size({"width": w, "height": h})
            page.set_content(f'<html><body style="margin:0;background:{bg or "transparent"}"><img src="file:///{(BRAND / (name + ".svg")).as_posix()}" width="{w}" height="{h}"></body></html>')
            page.wait_for_timeout(150)
            page.screenshot(path=str(KIT / f"{name}@4x.png"), omit_background=bg is None)
        # Open Graph image
        og = OG_HTML % {"fonts": FONTS.as_uri(), "brand": BRAND.as_uri()}
        tmp = ROOT / "scripts" / "brand" / "_og.html"
        tmp.write_text(og, encoding="utf-8")
        page.set_viewport_size({"width": 1200, "height": 630})
        page.goto(tmp.as_uri(), wait_until="networkidle")
        page.wait_for_timeout(300)
        page.screenshot(path=str(IMG / "og-drawbridge.png"))
        tmp.unlink()
        b.close()
    print("icons and OG image written")


if __name__ == "__main__":
    main()
