"""Identity sheets: concepts/<direction>/brand.html, one per direction, from the data below.

    python concepts/_tools/build_sheets.py
"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DIRS = [
    {
        "slug": "gatehouse", "letter": "A", "name": "Gatehouse",
        "idea": "The MOATiT document style, made into a product brand. White pages, navy type, gold used once per screen.",
        "mark": "A D monogram. Its counter is the gate; the gold deck runs out of it, across the bowl and past the letter. "
                "One idea, legible as a D at 16 px. A channel is cut around the deck so the mark still reads in one colour.",
        "wordmark": "Drawn by hand on a Poppins-like geometric skeleton at a bold weight, in MOATiT navy. "
                    "The endorsement sets MOATiT in capitals, as MOATiT's own logo does.",
        "dark": "#222236",
        "palette": [
            ("#FFFFFF", "White", "Page background. MOATiT's site and documents are white; no cream.", "60%"),
            ("#3E3E84", "MOATiT Navy", "Wordmark, primary buttons, the numbers band, rule names.", "20%"),
            ("#222236", "MOATiT Ink", "Headlines and body text (15.5:1 on white).", "10%"),
            ("#EEEEF8", "Pale Navy", "The one tinted panel per screen; table heads.", "6%"),
            ("#C68010", "MOATiT Gold", "The deck: marks, bars and rules only. 3.2:1 on white, so never small text.", "2%"),
            ("#F5A623", "Amber", "Gold on navy: labels and the deck in reverse (8.4:1 on night).", "1%"),
            ("#29AAE1", "MOATiT Blue", "The document-section tab, focus rings, links on navy.", "1%"),
        ],
        "type": [
            ("Poppins 600", "Headlines, -0.03em, 40 to 66 px. Buttons and nav at 500."),
            ("Barlow 500", "Body and UI text at 17 to 20 px. MOATiT's own website face."),
        ],
        "motion": "On load the gold deck lowers once, from upright to flat (1.5 s), then the filing slip rises in. "
                  "Sections fade up 14 px as they enter. All of it is off with prefers-reduced-motion.",
    },
    {
        "slug": "ledger", "letter": "B", "name": "Ledger",
        "idea": "The product's own record, made into the brand. A clinical, structured page where the intake ledger is the hero and MOATiT blue leads.",
        "mark": "A D drawn with MOATiT's rings: a navy post, an outer blue ring and an inner gold ring for the one controlled crossing. "
                "It borrows the concentric arcs from the MOATiT logo directly.",
        "wordmark": "The same hand-drawn skeleton at a lighter weight in MOATiT ink, sitting on a thin blue rule, with the endorsement beneath.",
        "dark": "#222236",
        "palette": [
            ("#FFFFFF", "White", "Page background.", "62%"),
            ("#222236", "MOATiT Ink", "Headlines, body, primary buttons and the dark phone section.", "18%"),
            ("#EAF6FC", "Callout Blue", "Table heads and 'filed' states. MOATiT's own callout colour.", "8%"),
            ("#29AAE1", "MOATiT Blue", "The lead accent: header rule, ticks, 'filed' markers, Drawbridge's voice in the call.", "5%"),
            ("#0F6E9C", "Blue 700", "Blue for text on white (5.6:1).", "3%"),
            ("#3E3E84", "MOATiT Navy", "The mark's post; secondary emphasis.", "2%"),
            ("#C68010", "MOATiT Gold", "Only for 'a person decides'. Text uses Gold 700 #8A5A0B (5.9:1).", "2%"),
        ],
        "type": [
            ("Poppins 500", "Headlines, -0.04em, up to 92 px. Lighter weight and tighter tracking than A."),
            ("Barlow 500", "Body and data, with tabular figures in the ledger."),
        ],
        "motion": "The signature moment is the ledger filling in. Rows appear one by one (0.3 s apart), "
                  "and each outcome stamps in after its checks. Elsewhere there are quiet fade-ups. All of it is off with prefers-reduced-motion.",
    },
    {
        "slug": "nightwatch", "letter": "C", "name": "Night Watch",
        "idea": "MOATiT at night. Dark-led and atmospheric, about the work Drawbridge does when the front desk is closed, built on MOATiT's shield.",
        "mark": "MOATiT's shield with an arched gate cut through it and the gold deck lowered across the threshold. "
                "It's the closest family tie of the three: it sits beside the MOATiT shield like a sibling.",
        "wordmark": "Spaced capitals, drawn by hand at a light weight. It reads like architectural lettering and pairs with the solid shield.",
        "dark": "#1A1A33",
        "palette": [
            ("#1A1A33", "Night", "Hero, close and footer. Deepened from MOATiT ink, not violet.", "45%"),
            ("#222236", "MOATiT Ink", "Second dark surface for alternating sections.", "20%"),
            ("#FFFFFF", "White", "The one light section (security). It keeps the page from feeling like a nightclub.", "20%"),
            ("#F2F2FA", "Fog", "Primary text on dark (15:1).", "6%"),
            ("#AEB0D4", "Mist", "Secondary text and line art on dark (8:1).", "4%"),
            ("#F5A623", "MOATiT Amber", "The crossing: primary button, the deck and the one drawn line.", "3%"),
            ("#29AAE1", "MOATiT Blue", "The moat and product labels on dark (6.4:1).", "2%"),
        ],
        "type": [
            ("Poppins 500 / 300", "Headlines at 500 and up to 104 px; the oversized clock at 300."),
            ("Barlow 500", "Body on dark at 18 to 19 px, in Mist with Fog for emphasis."),
        ],
        "motion": "The signature moment: an amber line draws a record's path across the moat and into the gate (2.4 s), "
                  "the document arrives and the doorway warms. The water drifts very slowly. Sections fade up. All of it is off with prefers-reduced-motion.",
    },
]

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{name} identity sheet</title>
<meta name="robots" content="noindex">
<link rel="icon" href="logo/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600&family=Poppins:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
:root {{ --ink: #222236; --slate: #5A5C78; --line: #DCDDEB; --dark: {dark}; }}
* {{ box-sizing: border-box; }}
body {{ margin: 0; background: #fff; color: var(--ink); font: 500 17px/1.6 "Barlow", system-ui, sans-serif; }}
img {{ display: block; max-width: 100%; }}
.wrap {{ width: min(1200px, 100% - 32px); margin-inline: auto; }}
h1, h2, h3 {{ font-family: "Poppins", system-ui, sans-serif; font-weight: 500; letter-spacing: -0.02em; margin: 0; }}
p {{ margin: 0; }}
header {{ padding: 40px 0 32px; border-bottom: 1px solid var(--line); }}
header .wrap {{ display: flex; justify-content: space-between; align-items: end; gap: 24px; flex-wrap: wrap; }}
header h1 {{ font-size: clamp(30px, 4vw, 48px); line-height: 1.05; }}
header p {{ color: var(--slate); max-width: 40em; margin-top: 12px; }}
header nav {{ display: flex; gap: 20px; font: 500 15px/1 "Poppins", sans-serif; }}
header nav a {{ color: var(--ink); }}
section {{ padding: 56px 0; border-bottom: 1px solid var(--line); }}
section > .wrap > h2 {{ font-size: 24px; margin-bottom: 8px; }}
section > .wrap > p.note {{ color: var(--slate); max-width: 46em; margin-bottom: 32px; }}
.lockups {{ display: grid; grid-template-columns: 1.3fr 1fr; gap: 16px; }}
.tile {{ border: 1px solid var(--line); padding: 40px 32px; display: grid; place-items: center; min-height: 220px; position: relative; }}
.tile.dark {{ background: var(--dark); border-color: var(--dark); }}
.tile .cap {{ position: absolute; left: 14px; bottom: 10px; font-size: 13px; color: var(--slate); }}
.tile.dark .cap {{ color: #AEB0D4; }}
.tile img.lock {{ width: min(440px, 100%); height: auto; }}
.sizes {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; margin-top: 16px; }}
.sizes .tile {{ min-height: 170px; padding: 24px; }}
.sizes img {{ image-rendering: auto; }}
.tab {{ display: flex; align-items: center; gap: 8px; background: #E8E9F1; border-radius: 8px 8px 0 0; padding: 9px 14px; width: 100%; max-width: 230px; font: 400 13px/1 system-ui, sans-serif; color: #333; }}
.tab img {{ width: 16px; height: 16px; }}
.bar {{ height: 10px; background: #fff; border: 1px solid #E8E9F1; border-top: 0; width: 100%; max-width: 230px; }}
.pal {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0; border: 1px solid var(--line); }}
.sw {{ border-right: 1px solid var(--line); }}
.sw:last-child {{ border-right: 0; }}
.chip {{ height: 120px; border-bottom: 1px solid var(--line); }}
.sw div.t {{ padding: 14px 14px 18px; }}
.sw b {{ display: block; font: 600 15px/1.3 "Poppins", sans-serif; }}
.sw code {{ font: 500 14px/1.6 "Barlow", sans-serif; color: var(--slate); }}
.sw p {{ font-size: 14px; color: var(--slate); line-height: 1.45; margin-top: 6px; }}
.share {{ display: flex; height: 18px; margin-top: 20px; border: 1px solid var(--line); }}
.type {{ display: grid; grid-template-columns: 1fr 1fr; gap: 40px; }}
.spec .big {{ font: 600 56px/1.05 "Poppins", sans-serif; letter-spacing: -0.03em; }}
.spec .body {{ font: 500 19px/1.6 "Barlow", sans-serif; }}
.spec h3 {{ font-size: 16px; margin-top: 18px; }}
.spec p.r {{ color: var(--slate); font-size: 15px; }}
.prose {{ display: grid; grid-template-columns: 1fr 1fr; gap: 40px; }}
.prose h3 {{ font-size: 18px; margin-bottom: 8px; }}
.prose p {{ color: var(--ink); }}
footer {{ padding: 32px 0 56px; color: var(--slate); font-size: 14px; }}
@media (max-width: 760px) {{
  .lockups, .type, .prose {{ grid-template-columns: 1fr; }}
  .pal {{ grid-template-columns: 1fr 1fr; }}
  .sw {{ border-bottom: 1px solid var(--line); }}
  .spec .big {{ font-size: 40px; }}
}}
</style>
</head>
<body>
<header>
  <div class="wrap">
    <div>
      <h1>Concept {letter}: {name}</h1>
      <p>{idea}</p>
    </div>
    <nav><a href="index.html">Concept page</a><a href="RATIONALE.md">Rationale</a><a href="../index.html">All concepts</a></nav>
  </div>
</header>

<section>
  <div class="wrap">
    <h2>Logo</h2>
    <p class="note">{mark}</p>
    <div class="lockups">
      <div class="tile"><img class="lock" src="logo/lockup.svg" alt="Drawbridge, A MOATiT Service, primary lockup"><span class="cap">Primary lockup</span></div>
      <div class="tile dark"><img class="lock" src="logo/lockup-reverse.svg" alt="Reverse lockup"><span class="cap">Reverse</span></div>
    </div>
    <div class="sizes">
      <div class="tile"><img src="logo/mark.svg" width="160" height="160" alt="Mark, large"><span class="cap">Mark, 160 px</span></div>
      <div class="tile"><img src="logo/mark-mono.svg" width="96" height="96" alt="Mark, one colour"><span class="cap">One colour</span></div>
      <div class="tile dark"><img src="logo/mark-reverse.svg" width="96" height="96" alt="Mark, reverse"><span class="cap">Reverse</span></div>
      <div class="tile"><div style="display:flex;gap:18px;align-items:end"><img src="logo/favicon.svg" width="64" height="64" alt="Favicon 64"><img src="logo/favicon.svg" width="32" height="32" alt="Favicon 32"><img src="logo/favicon.svg" width="16" height="16" alt="Favicon 16"></div><span class="cap">Favicon 64 / 32 / 16</span></div>
      <div class="tile"><div style="display:flex;gap:18px;align-items:end"><img src="logo/mark.svg" width="32" height="32" alt="Mark 32"><img src="logo/mark.svg" width="16" height="16" alt="Mark 16"></div><span class="cap">Mark 32 / 16</span></div>
      <div class="tile"><div><div class="tab"><img src="logo/favicon.svg" alt="">Drawbridge</div><div class="bar"></div></div><span class="cap">Browser tab, 16 px</span></div>
    </div>
    <div class="sizes">
      <div class="tile" style="min-height:120px"><img src="logo/lockup-mono.svg" alt="One-colour lockup" style="width:260px;height:auto"><span class="cap">One-colour lockup</span></div>
      <div class="tile" style="min-height:120px"><img src="logo/lockup.svg" alt="Lockup at minimum size" style="width:150px;height:auto"><span class="cap">Minimum, 150 px wide</span></div>
    </div>
    <p class="note" style="margin-top:24px">{wordmark} No fonts in the files: every letter is a drawn path (generator: <code>concepts/_tools/build_logos.py</code>).</p>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>Palette and roles</h2>
    <p class="note">MOATiT's own colours: navy #3E3E84, blue #29AAE1 and gold #C68010 from the MOATiT document style, plus ink #222236 and amber #F5A623 from moatit.com. The share bar shows roughly how much of a page each colour takes.</p>
    <div class="pal">{swatches}</div>
    <div class="share" aria-hidden="true">{share}</div>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>Type</h2>
    <p class="note">Both faces are MOATiT's own: Poppins from the MOATiT documents and Barlow from moatit.com. Both are on Google Fonts.</p>
    <div class="type">{type}</div>
  </div>
</section>

<section>
  <div class="wrap prose">
    <div><h3>Motion</h3><p>{motion}</p></div>
    <div><h3>Bans this direction keeps</h3><p>No cream background, italic accent words, numbered mono labels, pill buttons, gradient text, emoji icons, glass cards, purple-to-blue gradients, or rows of identical cards. No AI photography.</p></div>
  </div>
</section>

<footer><div class="wrap">Concept only, Oct 17, 2026. Nothing here is live.</div></footer>
</body>
</html>
"""


def build():
    for d in DIRS:
        sw = []
        share = []
        for hexv, nm, role, pct in d["palette"]:
            border = "box-shadow: inset 0 0 0 1px #DCDDEB;" if hexv.upper() in ("#FFFFFF",) else ""
            sw.append(f'<div class="sw"><div class="chip" style="background:{hexv};{border}"></div>'
                      f'<div class="t"><b>{nm}</b><code>{hexv}</code><p>{role}</p></div></div>')
            share.append(f'<span style="flex:{pct.rstrip("%")};background:{hexv}"></span>')
        ty = []
        for fam, role in d["type"]:
            if fam.startswith("Poppins"):
                ty.append(f'<div class="spec"><p class="big">Every fax in the right chart.</p><h3>{fam}</h3><p class="r">{role}</p></div>')
            else:
                ty.append(f'<div class="spec"><p class="body">Drawbridge reads incoming faxes and lab results, matches each one to exactly one patient and files it. When it isn\'t sure, a person decides.</p><h3>{fam}</h3><p class="r">{role}</p></div>')
        html = PAGE.format(name=d["name"], letter=d["letter"], idea=d["idea"], mark=d["mark"], wordmark=d["wordmark"],
                           dark=d["dark"], swatches="".join(sw), share="".join(share), type="".join(ty), motion=d["motion"])
        with open(os.path.join(ROOT, d["slug"], "brand.html"), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(html)
    print("sheets written")


if __name__ == "__main__":
    build()
