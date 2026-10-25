// Static build for drawbridge.moatit.com. No dependencies: node scripts/build.mjs → dist/
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SITE, ORG } from "../src/content/site.mjs";
import { render, pageHero } from "../src/content/layout.mjs";
import home from "../src/content/pages/home.mjs";
import { fax, phone, callConfirm, platform } from "../src/content/pages/products.mjs";
import { security, integrations } from "../src/content/pages/trust.mjs";
import { about, contact, roi, pricing, faq } from "../src/content/pages/company.mjs";
import { privacy, terms, hipaa, accessibility } from "../src/content/pages/legal.mjs";
import { lpFax, lpPhone } from "../src/content/pages/variants.mjs";
import { brand } from "../src/content/pages/brand.mjs";
import { btnPrimary } from "../src/content/partials.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
// DRAWBRIDGE_OUT builds somewhere other than dist/ (npm run check uses a temporary folder, so a check
// never replaces what the preview server is serving).
const DIST = process.env.DRAWBRIDGE_OUT ? resolve(process.env.DRAWBRIDGE_OUT) : join(ROOT, "dist");

const hash = (...files) => {
  const h = createHash("sha256");
  for (const f of files) h.update(readFileSync(join(SRC, f)));
  return h.digest("hex").slice(0, 10);
};
const assetVersion = hash("assets/css/site.css", "assets/js/site.js");

// The stylesheet is small, so it is minified and inlined in every page (no render-blocking request).
// The CSP allows exactly this stylesheet by its SHA-256 hash.
const minifyCss = (css) =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{};,>])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
const inlineCss = minifyCss(readFileSync(join(SRC, "assets/css/site.css"), "utf8")).replace(/\.\.\/fonts\//g, "/assets/fonts/");
const cssHash = "sha256-" + createHash("sha256").update(inlineCss).digest("base64");

const notFound = {
  path: "/404.html",
  canonicalPath: "/",
  noindex: true,
  sitemap: false,
  title: "Page not found",
  description: "This page doesn't exist. Find Drawbridge's fax intake, phone assistant, security and contact pages here.",
  body: `${pageHero({
    eyebrow: "404",
    title: 'This bridge <span class="accent-i">doesn\'t go anywhere.</span>',
    lede: "The page you asked for isn't here. Try one of these, or call (208) 900-6628.",
    actions: `${btnPrimary()}<a class="btn btn-secondary" href="/">Go to the home page</a>`,
  })}`,
};

// The internal brand-kit page ships only in the preview build (DRAWBRIDGE_PREVIEW=1), never to production.
const previewBuild = process.env.DRAWBRIDGE_PREVIEW === "1";
const pages = [home, fax, phone, callConfirm, platform, security, integrations, about, contact, roi, pricing, faq, privacy, terms, hipaa, accessibility, lpFax, lpPhone, ...(previewBuild ? [brand] : []), notFound];

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
cpSync(join(SRC, "assets"), join(DIST, "assets"), { recursive: true });
if (existsSync(join(SRC, "static"))) cpSync(join(SRC, "static"), DIST, { recursive: true });

for (const page of pages) {
  const html = render({ ...page, assetVersion, inlineCss });
  const out = page.path.endsWith(".html") ? join(DIST, page.path) : join(DIST, page.path, "index.html");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
}

// sitemap.xml — indexable pages only
const urls = pages.filter((p) => !p.noindex && p.sitemap !== false);
const priority = (p) => (p.path === "/" ? "1.0" : p.path.startsWith("/legal/") ? "0.3" : "0.8");
writeFileSync(
  join(DIST, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((p) => `  <url><loc>${SITE.url}${p.path}</loc><lastmod>${SITE.lastUpdated}</lastmod><priority>${priority(p)}</priority></url>`).join("\n")}
</urlset>
`
);

// robots.txt — production allows crawling; the preview build (DRAWBRIDGE_PREVIEW=1) blocks it.
const preview = process.env.DRAWBRIDGE_PREVIEW === "1";
writeFileSync(
  join(DIST, "robots.txt"),
  preview
    ? "User-agent: *\nDisallow: /\n"
    : `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE.url}/sitemap.xml\n`
);

writeFileSync(
  join(DIST, "site.webmanifest"),
  JSON.stringify(
    {
      name: "Drawbridge, A MOATiT Service",
      short_name: "Drawbridge",
      start_url: "/",
      display: "browser",
      background_color: "#ffffff",
      theme_color: "#222236",
      icons: [
        { src: "/assets/brand/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/assets/brand/icon-512.png", sizes: "512x512", type: "image/png" },
        { src: "/assets/brand/favicon.svg", sizes: "any", type: "image/svg+xml" },
      ],
    },
    null,
    2
  )
);

// RFC 9116 security.txt
mkdirSync(join(DIST, ".well-known"), { recursive: true });
writeFileSync(
  join(DIST, ".well-known", "security.txt"),
  `Contact: mailto:${ORG.email}\nContact: tel:${ORG.phones[0].tel}\nExpires: 2027-10-16T00:00:00.000Z\nPreferred-Languages: en\nCanonical: ${SITE.url}/.well-known/security.txt\nPolicy: ${SITE.url}/security/\n`
);

// Security headers for static hosts that read _headers. See docs/DEPLOYMENT.md.
export const CSP =
  `default-src 'self'; script-src 'self'; style-src 'self' '${cssHash}'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; upgrade-insecure-requests`;
writeFileSync(
  join(DIST, "_headers"),
  `/*
  Content-Security-Policy: ${CSP}
  Strict-Transport-Security: max-age=63072000; includeSubDomains
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()
  Cross-Origin-Opener-Policy: same-origin

/assets/fonts/*
  Cache-Control: public, max-age=31536000, immutable

/assets/js/*
  Cache-Control: public, max-age=31536000, immutable

/assets/brand/*
  Cache-Control: public, max-age=86400

/assets/img/*
  Cache-Control: public, max-age=86400
`
);
writeFileSync(join(DIST, "csp.txt"), CSP + "\n");

console.log(`built ${pages.length} pages → ${process.env.DRAWBRIDGE_OUT ? DIST : "dist/"} (assets v${assetVersion}${preview ? ", preview robots" : ""})`);
