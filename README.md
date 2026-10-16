# drawbridge-website

Marketing website, brand kit and launch campaign for **Drawbridge — A MOATiT Service**, MOATiT's AI technology for healthcare practices. Target domain: **https://drawbridge.moatit.com** (not deployed; see `docs/DEPLOYMENT.md`).

## Run it locally

```
npm run build     # static build → dist/
npm run serve     # http://127.0.0.1:4417  (PORT=… to change; 8095/8096 are refused: they belong to the Drawbridge stack)
```

No runtime dependencies. The npm dev-dependencies are only the font packages the fonts were copied from.

## What's here

| Path | What |
|---|---|
| `src/content/site.mjs` | Single source of truth: domain, contact details, claims (proof numbers), nav and CTA labels |
| `src/content/pages/*.mjs` | Page content: home, fax & labs, phone assistant, staff tools, security/trust center, integrations, about, contact (walkthrough form), ROI calculator, pricing, FAQ, legal (privacy, terms, HIPAA notice, accessibility), A/B landing variants, brand kit |
| `src/content/partials.mjs`, `layout.mjs` | Shared components, FAQ data, ROI calculator, page layout, schema.org JSON-LD |
| `src/assets/` | CSS (inlined at build), JS, self-hosted fonts (OFL), brand SVGs, responsive images |
| `scripts/build.mjs` | Build: pages, sitemap, robots, manifest, security.txt, `_headers` with CSP |
| `scripts/serve.mjs` | Local preview server with production headers and a placeholder form endpoint |
| `scripts/brand/` | Logo generator (text to outlines) and icon/OG exporter |
| `scripts/campaign/segment.mjs` | Company-list import and segmentation (sends nothing) |
| `brand/` | Brand kit (`BRAND_KIT.md`), logo files (SVG + PNG), generated imagery sources |
| `docs/research/TOP10_MEDICAL_AI_SITES.md` | Competitive research: 10 medical-AI marketing sites |
| `docs/campaign/` | Positioning, ICP & list segmentation, email + LinkedIn sequence, A/B tests, CAN-SPAM / HIPAA-safe / trademark rules, KPIs, tracking and timeline |
| `docs/CLAIMS_REGISTER.md` | Every claim on the site, its source, and what must be confirmed before launch |
| `docs/DEPLOYMENT.md`, `docs/QA_REPORT.md` | Hosting at drawbridge.moatit.com; Lighthouse / accessibility / functional results |
| `docs/screenshots/` | Desktop and mobile screenshots of every page |

## Rules for editing

- Every number goes in `CLAIMS` (`src/content/site.mjs`) and the claims register. Synthetic numbers stay labeled.
- Veradigm® only in factual compatibility statements, never in brand names or titles; never imply endorsement (see `docs/campaign/05_COMPLIANCE_RULES.md`).
- No client names, no PHI, no invented testimonials or logos.
- Client-facing text never says "MCP", "FHIR" or "Unity".
- Don't push or deploy without Ali's approval.
