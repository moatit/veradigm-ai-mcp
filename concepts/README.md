# Drawbridge brand concepts

Three look-and-feel and logo directions for **Drawbridge, A MOATiT Service**, prepared Oct 17, 2026 for Ali to react to. These are concepts only: the live site, `src/`, `dist/` and `brand/` are untouched.

Open `concepts/index.html` (it needs a local server for the images; see below).

## Summary for Ali

**Recommendation: B, Ledger.** It turns Drawbridge's own behavior into the brand. The hero is a morning's synthetic faxes: two filed and three handed to a person, each with the reason written down. The headline is the rule: "Two identifiers, or it doesn't file." No stock design move can fake that, and it's the strongest answer to "AI slop". The mark is a D drawn with MOATiT's rings, so the family tie shows even without the endorsement.

- **A, Gatehouse** is the safe choice: the MOATiT document style turned into a product brand. Its D-with-gold-deck monogram is the clearest mark of the three at 16 px. If you like Ledger's page but want a simpler mark, the Gatehouse mark can move across.
- **C, Night Watch** is the most striking: dark, about the 2 a.m. calls and overnight faxes, built on MOATiT's shield. I'd keep it for campaign pages rather than the main site, because practice managers read under office lighting.

All three follow your note on sister brands. They use MOATiT's own colors (navy #3E3E84, blue #29AAE1, gold #C68010, plus ink #222236 and amber #F5A623 from moatit.com) and MOATiT's own type (Poppins from the MOATiT documents, Barlow from moatit.com). One finding: moatit.com itself uses Barlow, not Poppins. Poppins appears in the MOATiT documents.

Why the launch brand reads as amateur, in detail: `CRITIQUE.md`. The short version: a clip-art tower mark with seven ideas in it, a serif with one italic phrase per headline, numbered monospace labels, a cream page, purple-leaning colors, AI photographs and the same card section repeated nine times.

## What's here

| Path | What |
|---|---|
| `index.html` | The three directions side by side, with the recommendation and the design bans |
| `CRITIQUE.md` | Why the launch brand reads as amateur: mark, type, color, layout, imagery |
| `<direction>/index.html` | Concept page: hero plus three sections in that direction's style |
| `<direction>/brand.html` | Identity sheet: lockups, mark at large, 32 and 16 px, mono, reverse, favicon, palette with roles, type, motion |
| `<direction>/RATIONALE.md` | The thinking, and the risks |
| `<direction>/logo/*.svg` | Lockup (primary, reverse, mono), mark (color, reverse, mono), favicon, wordmark. All letters are drawn paths, with no font files. |
| `screenshots/` | Every concept page and the overview at 1440 and 393 wide, plus the thumbnails `index.html` uses |
| `_tools/build_logos.py` | Generates every logo SVG: a small hand-built geometric stroke alphabet plus the three marks |
| `_tools/build_sheets.py` | Generates the identity sheets |
| `_tools/shoot.py`, `_tools/thumbs.py` | Review screenshots (Playwright with local Chrome) |

Directions: `gatehouse/` (A), `ledger/` (B), `nightwatch/` (C).

## Viewing

```
python -m http.server 4431 --bind 127.0.0.1 --directory concepts
```

Then open http://127.0.0.1:4431/. Fonts load from Google Fonts; everything else is local.

## Review notes

- Every page was screenshotted at 1440 and 393 wide (in the app's built-in browser and in headless Chrome) and reviewed. Fixes made from that review: the logo lockups were clipped and their endorsement was too small; the first Ledger mark read as an "h" with a wifi icon and was redrawn; the first Gatehouse mark read as an "n" and was redrawn; Gatehouse's headline orphaned a word; the slip wrapped names on phones; Night Watch's illustration ran under the lede and buttons; and a color rule was overriding the Night Watch clock.
- None of the pages scroll sideways at 393. Each signature motion was checked to end in its final state. All motion is off under prefers-reduced-motion, and content stays visible without JavaScript.
- Copy was checked for em dashes, the banned words and vendor names (none found). Samples use invented patients and are labeled. Proof numbers are the existing labeled synthetic results with their dates.
- Motion references (guanmo-ai/awesome-ai-motion, heygen-com/hyperframes, iart-ai/javascript-animation-skills) were read only. The ideas taken: one timeline with small displacements, hold then stop, a single signature moment and self-review by still frames. No code was copied or run, and nothing was installed. GSAP wasn't needed; motion is plain CSS plus a few lines of JavaScript for scroll reveals.

## Not done (on purpose)

- No rollout to the real site, `brand/` or `src/`. That's a separate decision once a direction is picked.
- The wordmarks are hand-drawn approximations of a geometric sans, good enough to judge direction. Before production, the chosen one should get a type-design pass (spacing and the r, g and S curves) or be redrawn over licensed Poppins outlines.
- No images were generated, nothing was uploaded or sent anywhere, and nothing was pushed or deployed.
