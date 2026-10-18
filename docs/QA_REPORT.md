# QA report (local build, Oct 16, 2026; re-run after revision 2: turnkey + capacity copy)

## Ledger look-and-feel rollout (Oct 17, 2026)

The site was restyled to the "Ledger" identity (see `brand/BRAND_KIT.md`). Presentation only: no copy claims, routes, form behavior, calculator logic, script behavior, sitemap/robots/security.txt logic or CSP rules changed (the CSP style hash is recomputed by the build as before). Checked on the local build (`npm run build`, `npm run serve`) with Playwright and local Chrome:

- **Build:** all 19 pages build (13 indexable pages, 4 legal pages, `/lp/fax/`, `/lp/phone/`, `/brand/`, `/404.html`).
- **Parity:** an inventory of headings, links, buttons, form fields, images and ids on every page, before and after, at 1440 and 393 px. No link, button or form field was lost. Changes: the brand name in titles, alt text and the home link label is now "Drawbridge, A MOATiT Service" (no dash); the three AI photos are gone; the home and `/lp/` hero's sample-filing card is replaced by the synthetic intake ledger (new heading "This morning's faxes"; the sample filing card still appears on `/fax-lab-intake/`); `/brand/` gained "Logo rules" and "Layout rules".
- **Layout:** no horizontal scroll at 393 px on any page; no console errors or CSP violations; no requests to any other host.
- **Layout shift (Chrome, local):** CLS ≤ 0.023 on every page at 393, 768 and 1440 px (width-matched Arial fallbacks for Poppins and Barlow, per weight).
- **Motion:** the home ledger fills in once (0.5 to 0.6 s per step, last step ends at about 2.1 s) and ends fully visible; the sample filing and sample call still play in view and replay on demand. With `prefers-reduced-motion: reduce` no animation runs and everything shows in its final state; without JavaScript all content is visible.
- **Contrast:** every text pair is ≥ 4.5:1 (lowest: `#8E90B6` on ink 5.05:1, Blue 700 on Callout Blue 5.1:1); input borders 3.2:1; the focus ring is Blue 700 on light surfaces (MOATiT Blue would be 2.6:1) and MOATiT Blue on ink (5.9:1).
- **Banned patterns in the built HTML:** no italic, no 999px radius, no monospace, no gradients, no shadows or backdrop blur, no Google Fonts URLs, no Newsreader / Public Sans / IBM Plex Mono.
- **Functional:** demo form (5 inline errors, focus to "Full name", valid POST with utm fields and confirmation), ROI calculator (82 h default, 109 h at 100 docs/day), mobile menu (opens, Escape closes and returns focus) and every replay button behave as before.
- **Lighthouse:** see the Oct 18 section below; the launch-look scores further down are kept for comparison.

## Audit release-1 fixes (Oct 18, 2026)

The fixes for the independent audit `audits/release-1-2026-10-18/marketing-site.md` are in commits `9118126` (copy and claims: H2, H4, M1-M4, L5, L7) and `5a13105` (preview form error M5; L1-L4, L6, L8). H1 and H3 copy is unchanged, waiting for Ali.

- **`npm run check`** builds the **production** site into a temporary folder by default (`DRAWBRIDGE_PREVIEW=1` checks the preview build), so a check never replaces what the preview serves. It now scans every text file in `dist/` (pages, scripts, styles, manifest, `_headers`, robots, sitemap, security.txt, SVG). Production: OK on 41 text files, 18 pages, 637 internal links and anchors. Preview: OK on 42 text files, 19 pages, 676. Negative test: an em dash and "GPT" in the manifest name and "Amazon" in robots.txt were all caught.
- **Behavior checked in Chrome:** the preview's `/api/demo-request` answers 503 and the form shows "We couldn't send the form just now" with the phone numbers; the live-call pop-up moves focus to its heading on open and Escape returns focus to the button; the home transcript is static and fully visible, and the replay works on `/phone-assistant/`.

Lighthouse 12.8.2 on a **production** build (production robots, `/brand/` excluded), served locally on a separate port so the preview was not touched:

| Page | Mobile P / A / BP / SEO | Desktop P / A / BP / SEO |
|---|---|---|
| `/` | 100 / 100 / 100 / 100 | 100 / 100 / 100 / 100 |
| `/fax-lab-intake/` | 100 / 100 / 100 / 100 | 100 / 100 / 100 / 100 |
| `/phone-assistant/` | 100 / 100 / 100 / 100 | 100 / 100 / 100 / 100 |
| `/contact/` | 100 / 100 / 100 / 100 | 100 / 100 / 100 / 100 |

Mobile LCP 1.4 to 1.7 s, desktop 0.4 s, TBT 0 ms. CLS 0 everywhere except home on mobile at 0.01 (it was 0.079; the reworded hero paragraph no longer lands on a line-break boundary). The only flagged audit is the informational network-dependency tree.

## Brand finish and checks (Oct 18, 2026)

Lighthouse 12.8.2 (`npx lighthouse@12.8.2`, run locally against `scripts/serve.mjs` on 127.0.0.1:4417; nothing uploaded), default mobile (Moto G Power, slow 4G, 4x CPU) and `--preset=desktop`, on the preview build:

| Page | Mobile P / A / BP / SEO | Desktop P / A / BP / SEO |
|---|---|---|
| `/` | 98 / 100 / 100 / 100* | 100 / 100 / 100 / 100* |
| `/fax-lab-intake/` | 100 / 100 / 100 / 100* | 100 / 100 / 100 / 100* |
| `/phone-assistant/` | 100 / 100 / 100 / 100* | 100 / 100 / 100 / 100* |
| `/contact/` | 100 / 100 / 100 / 100* | 100 / 100 / 100 / 100* |

\* Lighthouse reports SEO 69 on the preview build because its robots.txt blocks crawling on purpose (`DRAWBRIDGE_PREVIEW=1`). With that one audit counted as passing, which the production build's robots.txt does, SEO is 100 on all eight runs. Mobile LCP 1.3 to 1.7 s, desktop 0.4 s, TBT 0 ms, CLS 0 except home on mobile.

- **Home, mobile CLS 0.079** (inside the "good" band, under 0.1). On the 412 px emulated phone, the hero paragraph lands on a line-break boundary and wraps to one more line when Barlow replaces the metric-matched fallback. Seven fallback `size-adjust` settings were tested against 136 text blocks on these four pages at 360, 393 and 412 px; the current setting is already the best (3 mismatches). Removing the last shift would need `font-display: optional` for Barlow, which shows body text in Arial on slow first visits; that trade-off is left to Ali. Fixed in passing: buttons in a row now take the full width on phones, so that row no longer reflows with the font.
- **`npm run check`** now exists (`scripts/check.mjs`): build; banned CSS (italic, pill radius, monospace, gradients, glass, Google Fonts); banned words, vendor names, MCP/FHIR/Unity and em dashes in pages, metadata and scripts; and every internal link, srcset, popover target and #anchor. Result: OK, 19 pages, 675 internal links and anchors. Negative test: planting an em dash, "solutions", "AWS", a broken link and a missing anchor produced exactly those five failures.

## Launch look (Oct 16, 2026)


Served by `scripts/serve.mjs` on `http://127.0.0.1:4417` with production-equivalent headers and Brotli compression. Lighthouse 12.8.2, default mobile (Moto G Power, slow 4G, 4× CPU) and `--preset=desktop`.

## Lighthouse

| Page | Mobile P / A / BP / SEO | Desktop P / A / BP / SEO |
|---|---|---|
| `/` | 98 / 100 / 100 / 100 | 100 / 100 / 100 / 100 |
| `/fax-lab-intake/` | 99 / 100 / 100 / 100 | 100 / 100 / 100 / 100 |
| `/phone-assistant/` | 99 / 100 / 100 / 100 | 100 / 100 / 100 / 100 |
| `/platform/` | 99 / 100 / 100 / 100 | 100 / 100 / 100 / 100 |
| `/security/` | 99 / 100 / 100 / 100 | 100 / 100 / 100 / 100 |
| `/integrations/` | 99 / 100 / 100 / 100 | 100 / 100 / 100 / 100 |
| `/about/` | 99 / 100 / 100 / 100 | 100 / 100 / 100 / 100 |
| `/contact/` | 99 / 100 / 100 / 100 | 100 / 100 / 100 / 100 |
| `/roi/` | 99 / 100 / 100 / 100 | 100 / 100 / 100 / 100 |
| `/pricing/` | 99 / 100 / 100 / 100 | 100 / 100 / 100 / 100 |
| `/faq/` | 100 / 100 / 100 / 100 | 100 / 100 / 100 / 100 |
| `/legal/privacy/`, `/terms/`, `/hipaa/`, `/accessibility/` | 100 / 100 / 100 / 100 | 100 / 100 / 100 / 100 |
| `/lp/fax/`, `/lp/phone/` | 99 / 100 / 100 / 100 | 100 / 100 / 100 / 100 |

Mobile LCP 1.8–2.3 s, CLS ≤ 0.042, TBT 0 ms (revision 2: same scores on every page; no horizontal overflow at 390 px; no console errors). Remaining hints are informational (network-dependency tree; a 9 KB image-format saving on the hero).

What got the scores there: the stylesheet is minified and inlined (allowed by CSP hash, so no `unsafe-inline`), fonts are self-hosted and preloaded with metric-matched fallbacks (no layout shift on swap), the hero image is AVIF/WebP with `srcset` and `fetchpriority=high`, and the only script is 5 KB, deferred.

## Accessibility (WCAG 2.2 AA)

- Lighthouse/axe: 100 on every page.
- Skip link, landmarks (header, nav with labels, main, footer), one `h1` per page, ordered headings.
- Keyboard: visible focus ring on every control (launch look: sky on light, amber on dark; Ledger: Blue 700 on light, MOATiT Blue on ink); mobile menu toggles with `aria-expanded` and closes on Escape, returning focus.
- Forms: labels for every field, required markers, inline errors linked with `aria-describedby`, `aria-invalid`, focus moves to the first error, status messages in a live region.
- Contrast: all text pairs ≥ 4.5:1 (see `brand/BRAND_KIT.md`); target sizes ≥ 44 px for buttons.
- Motion: sample animations play once in view and respect `prefers-reduced-motion` (shown complete, no animation).
- Tables become stacked label/value lists under 700 px, so nothing scrolls sideways; no horizontal page scroll at 360 px on any page (checked with a script).

## Functional checks (Playwright)

- Demo form: empty submit shows 5 inline errors and focuses "Full name"; a valid submit POSTs JSON (with `utm_*` and landing path, no honeypot field) and shows the confirmation; a failed POST shows the email/phone fallback.
- ROI calculator: server-rendered defaults (82 h / month), live recalculation on input (100 docs/day → 109 h).
- Mobile navigation opens/closes; Escape closes it.
- No console errors on any page.

## SEO

- Unique `<title>`, meta description and canonical (`https://drawbridge.moatit.com/...`) on every page; Open Graph and Twitter cards with a 1200×630 image.
- JSON-LD `@graph`: `Organization` (MOATiT, LLC, address, phones, email), `WebSite`, `SoftwareApplication` (Drawbridge, provider MOATiT), `BreadcrumbList` on inner pages, `FAQPage` on `/`, `/faq/` and the product pages.
- `sitemap.xml` (15 indexable URLs), `robots.txt` (blocks `/brand/` and `/api/`), `/.well-known/security.txt`.
- A/B variants (`/lp/*`) are crawlable but canonicalize to `/` and are left out of the sitemap, per Google's guidance for test variants.

## Privacy and security of the site itself

- No cookies, no analytics, no third-party requests of any kind (fonts and images are self-hosted).
- CSP: `default-src 'self'`; scripts from self only; styles self + the one inline stylesheet hash; `frame-ancestors 'none'`; `form-action 'self'`.
- HSTS, nosniff, X-Frame-Options DENY, strict Referrer-Policy, restrictive Permissions-Policy (`dist/_headers`).
