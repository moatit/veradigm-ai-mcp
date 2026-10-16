# QA report (local build, Oct 16, 2026)

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

Mobile LCP 1.8–2.3 s, CLS 0–0.003, TBT 0 ms. Remaining hints are informational (network-dependency tree; a 9 KB image-format saving on the hero).

What got the scores there: the stylesheet is minified and inlined (allowed by CSP hash, so no `unsafe-inline`), fonts are self-hosted and preloaded with metric-matched fallbacks (no layout shift on swap), the hero image is AVIF/WebP with `srcset` and `fetchpriority=high`, and the only script is 5 KB, deferred.

## Accessibility (WCAG 2.2 AA)

- Lighthouse/axe: 100 on every page.
- Skip link, landmarks (header, nav with labels, main, footer), one `h1` per page, ordered headings.
- Keyboard: visible focus ring on every control (sky on light, amber on dark); mobile menu toggles with `aria-expanded` and closes on Escape, returning focus.
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
