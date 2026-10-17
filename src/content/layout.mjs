import { SITE, ORG, NAV, CTA, TRADEMARK_NOTE, COMPAT_LINE } from "./site.mjs";
import { esc, phoneLinks, emailLink } from "./partials.mjs";

const abs = (p) => SITE.url + p;

export const orgSchema = () => ({
  "@type": "Organization",
  "@id": `${SITE.url}/#moatit`,
  name: ORG.brand,
  legalName: ORG.legalName,
  url: ORG.url,
  email: ORG.email,
  foundingDate: ORG.founded,
  logo: abs("/assets/brand/drawbridge-mark.svg"),
  address: {
    "@type": "PostalAddress",
    streetAddress: ORG.address.street,
    addressLocality: ORG.address.city,
    addressRegion: ORG.address.region,
    postalCode: ORG.address.postal,
    addressCountry: ORG.address.country,
  },
  contactPoint: ORG.phones.map((p) => ({
    "@type": "ContactPoint",
    telephone: p.tel,
    contactType: "sales",
    email: ORG.email,
    areaServed: "US",
    availableLanguage: "English",
  })),
});

export const appSchema = () => ({
  "@type": "SoftwareApplication",
  "@id": `${SITE.url}/#drawbridge`,
  name: "Drawbridge",
  alternateName: "Drawbridge, A MOATiT Service",
  description:
    "MOATiT's AI technology for healthcare practices: fax and lab-result intake that files documents to the right patient chart, and a 24/7 AI phone assistant that verifies callers and manages appointments. Integrates with Veradigm® EHR and Veradigm® Practice Management.",
  applicationCategory: "BusinessApplication",
  applicationSubCategory: "Healthcare practice automation",
  operatingSystem: "Web",
  url: SITE.url + "/",
  image: abs(SITE.ogImage),
  provider: { "@id": `${SITE.url}/#moatit` },
  publisher: { "@id": `${SITE.url}/#moatit` },
  featureList: [
    "Fax and lab-result intake with local OCR",
    "Patient matching on full name and date of birth, with conflicting identifiers sent to staff",
    "Filing to the EHR chart category with a provider review task",
    "Multi-patient batch file splitting",
    "Critical-result High-priority tasks",
    "Staff review queue with one-click file or correct",
    "24/7 AI phone assistant with server-enforced caller verification",
    "Appointment booking, rescheduling, cancellation and confirmation with read-back",
    "Reminder calls, recalls, huddle brief, pre-visit check and on-call notebook",
    "Tamper-evident audit log and patient access reports",
  ],
});

const websiteSchema = () => ({
  "@type": "WebSite",
  "@id": `${SITE.url}/#website`,
  url: SITE.url + "/",
  name: "Drawbridge, A MOATiT Service",
  publisher: { "@id": `${SITE.url}/#moatit` },
  inLanguage: "en-US",
});

const breadcrumbSchema = (crumbs) => ({
  "@type": "BreadcrumbList",
  itemListElement: crumbs.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: abs(c.href) })),
});

const header = (path) => `<a class="skip-link" href="#main">Skip to content</a>
<div class="utility">
  <div class="wrap">
    <p class="u-tag mb-0">Drawbridge, ${esc(SITE.tagline)}</p>
    <p class="u-contact mb-0"><span><span class="u-label">Talk to us: </span>${phoneLinks(" · ")}</span><span>${emailLink()}</span></p>
  </div>
</div>
<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/" aria-label="Drawbridge, A MOATiT Service, home">
      <img src="/assets/brand/drawbridge-lockup.svg" width="240" height="56" alt="Drawbridge, A MOATiT Service">
    </a>
    <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav"><span class="nav-toggle-bars" aria-hidden="true"><span></span></span>Menu</button>
    <nav class="site-nav" id="site-nav" aria-label="Main">
      <ul>
${NAV.map((n) => `        <li><a href="${n.href}"${path === n.href ? ' aria-current="page"' : ""}>${n.label}</a></li>`).join("\n")}
      </ul>
      <div class="nav-cta"><a class="btn btn-primary" href="${CTA.primary.href}">Book a walkthrough</a></div>
    </nav>
  </div>
</header>`;

const footer = () => `<footer class="site-footer">
  <div class="wrap">
    <div class="footer-grid">
      <div class="footer-brand">
        <img src="/assets/brand/drawbridge-lockup-reverse.svg" width="240" height="56" alt="Drawbridge, A MOATiT Service" loading="lazy">
        <p>Drawbridge is MOATiT's AI technology for healthcare practices. ${COMPAT_LINE}.</p>
        <address>
          ${ORG.legalName}<br>
          ${ORG.address.street}<br>
          ${ORG.address.city}, ${ORG.address.region} ${ORG.address.postal}<br>
          ${phoneLinks("<br>")}<br>
          ${emailLink()}
        </address>
      </div>
      <nav aria-labelledby="f-product">
        <h2 id="f-product">Product</h2>
        <ul>
          <li><a href="/fax-lab-intake/">Fax &amp; lab-result intake</a></li>
          <li><a href="/phone-assistant/">AI phone assistant</a></li>
          <li><a href="/platform/">Staff tools</a></li>
          <li><a href="/integrations/">Integrations</a></li>
          <li><a href="/roi/">Time savings calculator</a></li>
          <li><a href="/pricing/">Pricing</a></li>
        </ul>
      </nav>
      <nav aria-labelledby="f-trust">
        <h2 id="f-trust">Trust</h2>
        <ul>
          <li><a href="/security/">Security &amp; HIPAA</a></li>
          <li><a href="/legal/hipaa/">HIPAA notice</a></li>
          <li><a href="/legal/privacy/">Privacy policy</a></li>
          <li><a href="/legal/terms/">Terms of use</a></li>
          <li><a href="/legal/accessibility/">Accessibility</a></li>
        </ul>
      </nav>
      <nav aria-labelledby="f-company">
        <h2 id="f-company">Company</h2>
        <ul>
          <li><a href="/about/">About MOATiT</a></li>
          <li><a href="/faq/">FAQ</a></li>
          <li><a href="/contact/">Book a walkthrough</a></li>
          <li><a href="${ORG.url}" rel="noopener">moatit.com</a></li>
        </ul>
      </nav>
    </div>
    <div class="footer-legal">
      <p>© 2026 ${ORG.legalName}. Drawbridge and MOATiT are trademarks of ${ORG.legalName}.</p>
      <p>${esc(TRADEMARK_NOTE)}</p>
      <p>This website does not collect patient health information. Please don't send patient information through our forms or by email.</p>
    </div>
  </div>
</footer>`;

export function render(page) {
  const path = page.path;
  const canonical = abs(page.canonicalPath || path);
  const title = page.title.includes("Drawbridge") ? page.title : `${page.title} | Drawbridge, A MOATiT Service`;
  const graph = [orgSchema(), websiteSchema()];
  if (page.app) graph.push(appSchema());
  if (page.crumbs) graph.push(breadcrumbSchema([{ name: "Home", href: "/" }, ...page.crumbs]));
  if (page.schema) graph.push(...[].concat(page.schema));
  const ld = JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
  const og = page.ogImage || SITE.ogImage;
  const preload = page.preloadImage
    ? `<link rel="preload" as="image" type="image/avif" imagesrcset="${page.preloadImage.srcset}" imagesizes="${page.preloadImage.sizes}" fetchpriority="high">`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(page.description)}">
<link rel="canonical" href="${canonical}">
${page.noindex ? '<meta name="robots" content="noindex, follow">' : '<meta name="robots" content="index, follow, max-image-preview:large">'}
<meta name="theme-color" content="#222236">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Drawbridge, A MOATiT Service">
<meta property="og:title" content="${esc(page.ogTitle || page.title)}">
<meta property="og:description" content="${esc(page.description)}">
<meta property="og:url" content="${abs(path)}">
<meta property="og:image" content="${abs(og)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Drawbridge, A MOATiT Service. AI for healthcare practices.">
<meta property="og:locale" content="${SITE.locale}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(page.ogTitle || page.title)}">
<meta name="twitter:description" content="${esc(page.description)}">
<meta name="twitter:image" content="${abs(og)}">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/assets/brand/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="preload" href="/assets/fonts/poppins-latin-500-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/barlow-latin-500-normal.woff2" as="font" type="font/woff2" crossorigin>
${preload}
${page.inlineCss ? `<style>${page.inlineCss}</style>` : `<link rel="stylesheet" href="/assets/css/site.css?v=${page.assetVersion}">`}
<script type="application/ld+json">${ld}</script>
</head>
<body>
${header(path)}
<main id="main" tabindex="-1">
${page.body}
</main>
${footer()}
<script src="/assets/js/site.js?v=${page.assetVersion}" defer></script>
</body>
</html>
`;
}

export const pageHero = ({ eyebrow, title, lede, crumbs = [], actions = "" }) => `<section class="page-hero">
  <div class="wrap">
    ${crumbs.length ? `<nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li>${crumbs.map((c, i) => (i === crumbs.length - 1 ? `<li aria-current="page">${esc(c.name)}</li>` : `<li><a href="${c.href}">${esc(c.name)}</a></li>`)).join("")}</ol></nav>` : ""}
    <p class="eyebrow">${eyebrow}</p>
    <h1>${title}</h1>
    ${lede ? `<p class="lede">${lede}</p>` : ""}
    ${actions ? `<div class="btn-row">${actions}</div>` : ""}
  </div>
</section>`;
