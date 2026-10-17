"""Thumbnails and full-page review shots for concepts/index.html and concepts/screenshots/.

    python concepts/_tools/thumbs.py
"""
import os
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "screenshots")
os.makedirs(OUT, exist_ok=True)
base = "http://127.0.0.1:4431/"
pages = ["gatehouse", "ledger", "nightwatch"]

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome")
    for slug in pages + ["index"]:
        for w, h, mobile in ((1440, 900, False), (393, 852, True)):
            ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=2 if mobile else 1,
                                is_mobile=mobile, has_touch=mobile, reduced_motion="reduce")
            pg = ctx.new_page()
            url = base + ("index.html" if slug == "index" else f"{slug}/index.html")
            pg.goto(url, wait_until="networkidle")
            pg.evaluate("""async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 60)); } window.scrollTo(0, 0); }""")
            pg.wait_for_timeout(500)
            tmp = os.path.join(OUT, "_tmp.png")
            pg.screenshot(path=tmp, full_page=True)
            ctx.close()
            im = Image.open(tmp).convert("RGB")
            tag = "1440" if not mobile else "393"
            full = im if not mobile else im.resize((im.width // 2, im.height // 2), Image.LANCZOS)
            full.save(os.path.join(OUT, f"{slug}-{tag}-full.jpg"), quality=78, optimize=True)
            if slug != "index":
                if not mobile:
                    im.crop((0, 0, 1440, 900)).resize((720, 450), Image.LANCZOS).save(os.path.join(OUT, f"{slug}-hero.jpg"), quality=82, optimize=True)
                else:
                    im.crop((0, 0, im.width, int(im.width * 850 / 393))).resize((392, 850), Image.LANCZOS).save(os.path.join(OUT, f"{slug}-phone.jpg"), quality=82, optimize=True)
            os.remove(tmp)
    b.close()
print("thumbs written")
