"""Render PNG icons and the Open Graph image from the SVG brand files (Playwright + local Chrome).

    python scripts/brand/make_icons.py
Writes src/static/favicon.ico, src/static/apple-touch-icon.png, src/assets/brand/icon-{192,512}.png,
src/assets/img/og-drawbridge.png and brand/logo/*.png exports.
"""
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / "src" / "assets" / "brand"
STATIC = ROOT / "src" / "static"
IMG = ROOT / "src" / "assets" / "img"
KIT = ROOT / "brand" / "logo"
STATIC.mkdir(parents=True, exist_ok=True)

OG_HTML = """<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:N;src:url('%(fonts)s/newsreader-latin-wght-normal.woff2');font-weight:300 800}
@font-face{font-family:NI;src:url('%(fonts)s/newsreader-latin-wght-italic.woff2');font-weight:300 800}
@font-face{font-family:P;src:url('%(fonts)s/public-sans-latin-wght-normal.woff2');font-weight:100 900}
html,body{margin:0;width:1200px;height:630px;overflow:hidden;background:#1c1c45}
.bg{position:absolute;inset:0;background:url('%(img)s/hero-bridge-1536.webp') 72%% 50%%/cover}
.sh{position:absolute;inset:0;background:linear-gradient(90deg,rgba(28,28,69,.98) 0%%,rgba(28,28,69,.92) 42%%,rgba(28,28,69,.25) 78%%,rgba(28,28,69,.1) 100%%)}
.c{position:absolute;left:72px;top:64px;right:420px}
.logo{height:74px}
h1{font:600 64px/1.02 N,serif;color:#fff;margin:56px 0 22px;letter-spacing:-1.4px}
h1 i{font-family:NI;font-weight:500;color:#29abe2}
p{font:500 24px/1.4 P,sans-serif;color:#c9cbe8;margin:0}
.u{position:absolute;left:72px;bottom:44px;font:600 19px P,sans-serif;color:#f5a623;letter-spacing:.3px}
</style></head><body><div class="bg"></div><div class="sh"></div>
<div class="c"><img class="logo" src="%(brand)s/drawbridge-lockup-reverse.svg">
<h1>Lab results filed. Calls answered. <i>Nothing guessed.</i></h1>
<p>MOATiT's AI technology for healthcare practices.</p></div>
<div class="u">drawbridge.moatit.com</div></body></html>"""


def main() -> None:
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", args=["--allow-file-access-from-files"])
        page = b.new_page(viewport={"width": 512, "height": 512})
        svg = (BRAND / "favicon.svg").read_text(encoding="utf-8")
        for size, out in [(512, BRAND / "icon-512.png"), (192, BRAND / "icon-192.png"), (180, STATIC / "apple-touch-icon.png"),
                          (64, KIT / "favicon-64.png"), (32, KIT / "favicon-32.png")]:
            page.set_viewport_size({"width": size, "height": size})
            page.set_content(f'<html><body style="margin:0;background:transparent">{svg.replace("<svg ", f"<svg width=\"{size}\" height=\"{size}\" ", 1)}</body></html>')
            page.screenshot(path=str(out), omit_background=True, clip={"x": 0, "y": 0, "width": size, "height": size})
        # transparent PNG exports of the lockups for docs and email signatures
        for name, w, h, bg in [("drawbridge-lockup", 243, 82, None), ("drawbridge-lockup-reverse", 243, 82, "#1c1c45"),
                               ("drawbridge-lockup-stacked", 240, 188, None), ("drawbridge-mark", 64, 64, None)]:
            scale = 4
            page.set_viewport_size({"width": w * scale, "height": h * scale})
            page.set_content(f'<html><body style="margin:0;background:{bg or "transparent"}"><img src="file:///{(BRAND / (name + ".svg")).as_posix()}" width="{w*scale}" height="{h*scale}"></body></html>')
            page.wait_for_timeout(150)
            page.screenshot(path=str(KIT / f"{name}@4x.png"), omit_background=bg is None)
        # Open Graph image
        og = OG_HTML % {"fonts": (ROOT / "src/assets/fonts").as_uri(), "img": IMG.as_uri(), "brand": BRAND.as_uri()}
        tmp = ROOT / "scripts" / "brand" / "_og.html"
        tmp.write_text(og, encoding="utf-8")
        page.set_viewport_size({"width": 1200, "height": 630})
        page.goto(tmp.as_uri(), wait_until="networkidle")
        page.wait_for_timeout(300)
        page.screenshot(path=str(IMG / "og-drawbridge.png"))
        tmp.unlink()
        b.close()
    Image.open(BRAND / "icon-512.png").save(STATIC / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    print("icons and OG image written")


if __name__ == "__main__":
    main()
