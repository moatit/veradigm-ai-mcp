# Drawbridge brand kit: "Drawbridge — A MOATiT Service"

Drawbridge is MOATiT's AI technology and product for healthcare practices. The brand is an **endorsed brand**: Drawbridge has its own name and mark, and it always appears with MOATiT's endorsement and in MOATiT's colors.

Preview page (local build): `/brand/` (noindex). Source files: `brand/logo/`. Generator: `scripts/brand/make_logo.py` (text is converted to outlines, so the SVGs need no fonts) and `scripts/brand/make_icons.py` (PNG, ICO and Open Graph exports).

## 1. The idea

MOATiT's name is a moat: the protection around a practice's systems. Drawbridge is the one **controlled crossing**: it comes down only for the right patient. That is the product's real behavior: two identifiers or the document doesn't cross, and callers are verified before anything is shared. Lines to use: *"Nothing guessed."*, *"AI reads the page. Rules you can audit decide where it goes."*, *"The drawbridge rules."*

## 2. Logo

| File | Use |
|---|---|
| `drawbridge-lockup.svg` | Primary. Horizontal lockup on light backgrounds (paper, white). |
| `drawbridge-lockup-reverse.svg` | On Drawbridge Night, MOATiT Indigo or dark photography. |
| `drawbridge-lockup-stacked.svg` / `-stacked-reverse.svg` | Square-ish spaces: social avatars, slide title pages, booth signage. |
| `drawbridge-lockup-mono-indigo.svg` / `-mono-white.svg` | One-color printing, fax cover sheets, embossing. |
| `drawbridge-mark.svg` / `-reverse.svg` / `-mono.svg` | The mark alone, only where "Drawbridge — A MOATiT Service" also appears nearby (app icon, favicon, footer of a page that already shows the lockup). |
| `favicon.svg`, `favicon-32.png`, `favicon-64.png` | Browser icon (mark reversed on a Night tile). |
| `*@4x.png` | Raster exports for email signatures and documents. |

**The mark.** A gate tower with its doorway, and its bridge mid-lowering: the deck is hinged at the tower, the hoist chain (MOATiT Sky) runs to the deck's tip, and the dotted arc is the path the deck travels. The wave beneath is the moat. The amber pin is the hinge: one controlled crossing.

**The endorsement.** "A MOATiT Service" is part of the lockup: never remove it from the primary lockup, and never re-typeset it. "MOATiT" keeps its lowercase *i*: never write "MOATIT" or "Moatit".

**Clear space.** At least the height of the tower's battlements (about 1/8 of the mark's height) on every side.

**Minimum size.** Horizontal lockup 140 px wide on screen (35 mm in print). Below that, use the stacked lockup or the mark plus the words "Drawbridge — A MOATiT Service" in text.

**Don't.** Recolor outside the palette; add effects or outlines; place the color lockup on mid-tone photos (use the reverse lockup on a dark overlay); separate the endorsement; combine the logo with any third-party logo (including Veradigm's) into one lockup.

## 3. Color

Built from MOATiT's own logo and website. Extracted Oct 16, 2026, read-only, from `https://moatit.com/wp-content/uploads/2026/10/MOAT-1-logo-200.png`, `/2024/04/Favicon.png` (dominant-pixel analysis) and the homepage CSS.

| Token | Hex | Source | Use |
|---|---|---|---|
| MOATiT Indigo | `#3E3E85` | MOATiT logo wordmark (dominant pixel, 2,853 px in the 512 px favicon) | Primary brand: wordmark, headings accents, secondary buttons, indigo panels |
| MOATiT Sky | `#29ABE2` | MOATiT logo arc (`#2AACE3`) and site CSS (`#29abe2`, most used) | Accent: chain, moat, italic headline emphasis on dark, eyebrows on dark |
| MOATiT Amber | `#F5A623` | moatit.com CSS | Primary call-to-action buttons, the hinge pin, rule numbers |
| MOATiT Signal | `#D64534` | MOATiT logo arc (red segment) | Critical / error states only |
| MOATiT Shield | `#4981B5` | MOATiT logo shield | Charts and diagrams |
| Drawbridge Night | `#1C1C45` | Deepened MOATiT Indigo | Hero, dark sections, footer, app icon tile |
| Sky 700 | `#0F6E9C` | moatit.com CSS | Links and small accent text on light (meets WCAG AA) |
| Amber 700 | `#8A5A0B` | Derived | Amber text on light (labels) |
| Paper | `#F7F5F0` | New | Page background |
| Ink | `#16163A` | New | Body text |

**Contrast (WCAG 2.2 AA).** White on Night 17:1; Ink on Paper 16:1; Sky 700 on Paper 5.1:1; Sky on Night 6.3:1; Amber on Night 8.2:1; Night on Amber (buttons) 8.2:1. Never use MOATiT Sky or Amber for body text on light backgrounds.

## 4. Type

| Role | Typeface | Notes |
|---|---|---|
| Display | **Newsreader** (variable, 560 for headlines; italic 500 for the one emphasized phrase) | Editorial, trustworthy, distinct from typical health-tech sans. SIL OFL 1.1. |
| Body and UI | **Public Sans** (variable; 400 / 600 / 700) | Plain, highly legible, made for public-service interfaces. SIL OFL 1.1. |
| Labels and data | **IBM Plex Mono** 500 | Section indexes ("03 — The drawbridge rules"), sample labels, formulas. SIL OFL 1.1. |

Fonts are self-hosted (`src/assets/fonts/`, Latin subset); no third-party font requests. License texts are in the same folder.

## 5. Voice

- Plain words, short sentences, the practice's vocabulary (charts, faxes, front desk), never "MCP", "FHIR", "Unity", "pipeline" or "agentic".
- Honest by default: synthetic-test numbers are labeled "Synthetic test" with N, date and method; unfinished items say "in progress".
- Safety before speed: always say what happens when Drawbridge isn't sure.
- No invented testimonials, logos, awards or customer names. No client names at all until a client gives written permission.

## 6. Third-party names

- Veradigm® is a third-party trademark. Never in the product name, logo, taglines or page titles as a brand; never imply endorsement.
- Allowed: factual compatibility lines, e.g. "Integrates with Veradigm® EHR and Veradigm® Practice Management", with the attribution "Veradigm® is a registered trademark of Veradigm Inc. or its affiliates."
- After certification only: the official "Member of Veradigm Connect" boilerplate and logo, exactly per Veradigm's guidelines and with Musab's sign-off.

## 7. Imagery

- Original AI-generated images (Figma `generate_image`, model gpt-image-2.5, Oct 16, 2026), labeled "AI-generated illustration" where shown as a photo. Sources: `brand/imagery-source/`. No people's faces, no readable text, no logos.
- Product samples are drawn in HTML/CSS with invented patients and labeled "Synthetic sample".
- In any generated audio, write MOATiT as "Mote eye tee" and Veradigm as "Vera-dime" in the TTS text only.
