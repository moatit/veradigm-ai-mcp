# Drawbridge brand kit: "Drawbridge, A MOATiT Service"

Drawbridge is MOATiT's AI technology and product for healthcare practices. The brand is an **endorsed brand**: Drawbridge has its own name and mark, and it always appears with MOATiT's endorsement and in MOATiT's colors.

The current identity is **Ledger** (concept B, chosen by Ali on Oct 17, 2026; it replaced the Oct 16 launch look). The product's own record is the brand: a white, structured page, hairline rules, tabular figures, MOATiT blue as the lead accent, and the intake ledger as the hero.

Preview page (local build): `/brand/` (noindex). Source files: `brand/logo/`. Generators: `scripts/brand/make_logo.py` (every letter is a drawn path, so the SVGs need no fonts and no dependencies) and `scripts/brand/make_icons.py` (PNG, ICO and Open Graph exports; Playwright with local Chrome).

## 1. The idea

MOATiT's name is a moat: the protection around a practice's systems. Drawbridge is the one **controlled crossing**: it comes down only for the right patient. That is the product's real behavior: two identifiers or the document doesn't cross, and callers are verified before anything is shared. Lines to use: *"Nothing guessed."*, *"AI reads the page. Rules you can audit decide where it goes."*, *"The drawbridge rules."*

Ledger shows that behavior instead of illustrating it: a morning's synthetic faxes, the ones that filed and the ones that went to a person, each with the reason.

## 2. Logo

| File | Use |
|---|---|
| `drawbridge-lockup.svg` | Primary. Horizontal lockup on white. |
| `drawbridge-lockup-reverse.svg` | On MOATiT Ink (`#222236`) or other dark grounds. |
| `drawbridge-lockup-stacked.svg` / `-stacked-reverse.svg` | Square-ish spaces: social avatars, slide title pages, signage. |
| `drawbridge-lockup-mono-indigo.svg` / `-mono-white.svg` | One-color printing (ink, or white out of a dark ground), fax cover sheets, embossing. The filename is kept from the launch kit; the color is now MOATiT Ink. |
| `drawbridge-mark.svg` / `-reverse.svg` / `-mono.svg` | The mark alone, only where "Drawbridge, A MOATiT Service" also appears nearby (app icon, favicon, footer of a page that already shows the lockup). |
| `favicon.svg`, `favicon-32.png`, `favicon-64.png` | Browser icon, redrawn on a 32 px grid so it stays crisp at 16 px. |
| `*@4x.png` | Raster exports for email signatures and documents. |

**The mark.** A D drawn with MOATiT's rings: a navy post, an outer MOATiT-blue ring, and an inner gold ring for the one controlled crossing. The concentric arcs come straight from the MOATiT logo, so the family tie shows even without the endorsement.

**The wordmark.** A light geometric skeleton in MOATiT Ink, on a thin MOATiT-blue rule, with "A MOATiT Service" beneath (MOATiT in navy). The letters are hand-drawn paths; never retype the wordmark in a font.

**The endorsement.** "A MOATiT Service" is part of the lockup: never remove it from the primary lockup, and never re-typeset it. "MOATiT" keeps its lowercase *i*: never write "MOATIT" or "Moatit". In text, write the name as **"Drawbridge, A MOATiT Service"** (a comma, never a dash).

**Clear space.** On every side, at least the width of the mark's navy post.

**Minimum size.** Horizontal lockup 150 px wide on screen (38 mm in print). Below that, use the mark plus the words "Drawbridge, A MOATiT Service" in text.

**Don't.** Recolor outside the palette; add effects, shadows or outlines; separate the endorsement; combine the logo with any third-party logo (including Veradigm's) into one lockup.

## 3. Color

MOATiT's own colors: navy, blue and gold from the MOATiT document style, ink from moatit.com. Roughly 62% white, 18% ink, the rest accents.

| Token | Hex | Use |
|---|---|---|
| White | `#FFFFFF` | Page background. No cream, no off-white. |
| MOATiT Ink | `#222236` | Text, headings, primary buttons, dark sections, footer. |
| Slate | `#5A5C78` | Secondary text. |
| Hairline | `#DCE3EA` | Rules between rows and blocks. |
| Callout Blue | `#EAF6FC` | Panels, table heads, "filed / ok" states. |
| MOATiT Blue | `#29AAE1` | The lead accent: header rule, ticks on dark, markers, status-tag bars, focus ring on dark. |
| Blue 700 | `#0F6E9C` | Blue for text, links, ticks and the focus ring on white. |
| MOATiT Navy | `#3E3E84` | The mark's post; secondary emphasis; primary-button hover. |
| MOATiT Gold | `#C68010` | Means exactly one thing: **a person decides / needs attention**. Text in Gold 700 `#8A5A0B`; tint `#FBF1DF`. |
| Error Red | `#B0301F` on `#FCEBE8` | Errors and critical states only. |

**Contrast (WCAG 2.2 AA).** Ink on white 15.6:1; Slate on white 6.5:1 (5.9:1 on Callout Blue); Blue 700 on white 5.6:1 (5.1:1 on Callout Blue); Gold 700 on white 5.9:1 (5.3:1 on its tint); Error Red on white 6.4:1; white on Ink 15.6:1; `#BFC1DA` on Ink 8.8:1; `#8E90B6` on Ink 5.1:1; MOATiT Blue on Ink 5.9:1. MOATiT Blue on white is only 2.6:1, so it is never used for text or the focus ring on light surfaces; Blue 700 is.

## 4. Type

| Role | Typeface | Notes |
|---|---|---|
| Headings | **Poppins** 500 (600 for small labels) | Sentence case, letter-spacing -0.02 to -0.04em, up to about 90 px in the home hero. Never italic. SIL OFL 1.1. |
| Body and UI | **Barlow** 500 (400 for long text, 600 for emphasis) | Tabular figures for times, dates and counts in tables and the ledger. SIL OFL 1.1. |

Both faces are MOATiT's own: Poppins from the MOATiT documents, Barlow from moatit.com. They are self-hosted (`src/assets/fonts/`, Latin subset, copied from the `@fontsource/poppins` and `@fontsource/barlow` packages); the CSP allows only `font-src 'self'`, so there are no Google Fonts requests. License texts are in the same folder. No monospace anywhere.

## 5. Layout, components and motion

- **Surfaces.** White page; ink for dark sections, the CTA band, the ROI result panel and the footer. A 3 px MOATiT-blue rule sits under the header on every page.
- **Blocks, not cards.** Hairline rules and white space instead of boxed, shadowed or rounded cards. A lone panel beside text uses Callout Blue with a 3 px blue top rule.
- **Buttons.** Square (2 px corners). Primary: ink fill, white text (white fill on ink). Secondary: 1.5 px ink outline. No pill buttons.
- **Status tags.** Small rectangles with a 3 px left bar: blue for ok / filed, gold for "a person decides", red for errors, navy or slate for neutral policy labels. No pill tags.
- **Eyebrows.** Barlow 600 in slate with a short blue marker. No numbers ("01 —"), no monospace, no uppercase tracking.
- **Checklists.** Blue ticks on a ruled list; gold person icon for "goes to a person" lists.
- **Steps.** Numbered squares (1, 2, 3) joined by a hairline.
- **Samples.** Square, hairline cards with a Callout Blue header and gold "Synthetic sample" text. In call transcripts, "Drawbridge" labels are Blue 700 and the verification line is highlighted with a blue bar on Callout Blue.
- **Focus.** 3 px ring, 3 px offset: Blue 700 on light surfaces, MOATiT Blue on ink.
- **Motion.** One signature moment per page at most: on the home page the intake ledger fills in row by row and each outcome stamps in after its checks. Durations 150 to 700 ms, easing `cubic-bezier(.22,.7,.16,1)`. The sample filing and sample call play once when scrolled into view and can be replayed. Everything is off under `prefers-reduced-motion`, and content is fully visible without JavaScript.

**Bans (the review bar).** No cream or off-white background, italic accent words, numbered section labels, monospace eyebrows, pill buttons or tags, gradient text, purple-to-blue gradients, glass, drop-shadow stacks, emoji or stock icon tiles as decoration, rows of identical boxed feature cards, AI-generated photos, or the same section skeleton twice in a row.

## 6. Voice

- Plain words, short sentences, the practice's vocabulary (charts, faxes, front desk), never "MCP", "FHIR", "Unity", "pipeline" or "agentic".
- Honest by default: synthetic-test numbers are labeled "Synthetic test" with N, date and method; unfinished items say "in progress".
- Safety before speed: always say what happens when Drawbridge isn't sure.
- No em dashes and none of these words in new copy: leverage, seamless, empower, unlock, robust, actionable, elevate, delve, solutions.
- No invented testimonials, logos, awards or customer names. No client names at all until a client gives written permission.

## 7. Third-party names

- Veradigm® is a third-party trademark. Never in the product name, logo, taglines or page titles as a brand; never imply endorsement.
- Allowed: factual compatibility lines, e.g. "Integrates with Veradigm® EHR and Veradigm® Practice Management", with the attribution "Veradigm® is a registered trademark of Veradigm Inc. or its affiliates."
- After certification only: the official "Member of Veradigm Connect" boilerplate and logo, exactly per Veradigm's guidelines and with Musab's sign-off.
- Client-facing copy never names vendors or subprocessors.

## 8. Imagery

- No photography and no AI-generated images. The launch kit's AI illustrations (hero bridge, front desk, documents) were retired with the Ledger rollout and removed from the site and the repo.
- Product samples are drawn in HTML/CSS with invented patients and labeled "Synthetic sample".
- The Open Graph image (`src/assets/img/og-drawbridge.png`) is the lockup, the hero headline and two synthetic ledger rows, rendered by `make_icons.py`.
- In any generated audio, write MOATiT as "Mote eye tee" and Veradigm as "Vera-dime" in the TTS text only.
