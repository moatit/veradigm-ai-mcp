"""Screenshot helper (Playwright + local Chrome).

    python scripts/shot.py <url> <out.png> [width] [height] [--full] [--dark]
"""
import sys

from playwright.sync_api import sync_playwright

url, out = sys.argv[1], sys.argv[2]
nums = [a for a in sys.argv[3:] if a.isdigit()]
w = int(nums[0]) if nums else 1440
h = int(nums[1]) if len(nums) > 1 else 900
full = "--full" in sys.argv
dark = "--dark" in sys.argv
mobile = w < 600

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", args=["--allow-file-access-from-files"])
    ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=2 if mobile else 1,
                        is_mobile=mobile, has_touch=mobile, color_scheme="dark" if dark else "light",
                        reduced_motion="reduce")
    page = ctx.new_page()
    page.goto(url, wait_until="networkidle")
    if full:  # trigger lazy images and in-view animations
        page.evaluate("""async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 60)); } window.scrollTo(0, 0); }""")
    page.wait_for_timeout(600)
    page.screenshot(path=out, full_page=full)
    b.close()
print("saved", out)
