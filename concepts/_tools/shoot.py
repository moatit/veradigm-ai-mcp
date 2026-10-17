"""Review screenshots for the concept pages (Playwright + local Chrome).

    python concepts/_tools/shoot.py <page path under concepts/> <out dir> [--motion]

Writes <name>-1440.png (full page), <name>-1440-N.png (1300 px slices),
<name>-393.png (full page) and <name>-393-sheet.png (phone page tiled into columns).
Reduced motion is on by default so reveals don't hide content in a still.
"""
import os
import sys

from PIL import Image
from playwright.sync_api import sync_playwright

page_path, out_dir = sys.argv[1], sys.argv[2]
motion = "--motion" in sys.argv
base = "http://127.0.0.1:4431/"
name = page_path.replace("/", "_").replace(".html", "")
os.makedirs(out_dir, exist_ok=True)

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome")
    for w, h, mobile in ((1440, 900, False), (393, 852, True)):
        ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=2 if mobile else 1,
                            is_mobile=mobile, has_touch=mobile,
                            reduced_motion="no-preference" if motion else "reduce")
        pg = ctx.new_page()
        pg.goto(base + page_path, wait_until="networkidle")
        pg.evaluate("""async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 80)); } window.scrollTo(0, 0); }""")
        pg.wait_for_timeout(2600 if motion else 500)
        out = os.path.join(out_dir, f"{name}-{w}.png")
        pg.screenshot(path=out, full_page=True)
        ctx.close()
        im = Image.open(out)
        if not mobile:
            for i, y in enumerate(range(0, im.height, 1300)):
                im.crop((0, y, im.width, min(im.height, y + 1300))).save(os.path.join(out_dir, f"{name}-{w}-{i}.png"))
        else:
            im = im.resize((im.width // 2, im.height // 2))
            colh = 1500
            cols = [im.crop((0, y, im.width, min(im.height, y + colh))) for y in range(0, im.height, colh)]
            sheet = Image.new("RGB", (im.width * len(cols) + 24 * (len(cols) - 1), colh), "#888")
            for i, c in enumerate(cols):
                sheet.paste(c, (i * (im.width + 24), 0))
            sheet.save(os.path.join(out_dir, f"{name}-{w}-sheet.png"))
    b.close()
print("done", name)
