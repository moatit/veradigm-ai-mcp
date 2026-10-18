// Site checks, no dependencies: node scripts/check.mjs (npm run check)
//   1. build            the static build must succeed
//   2. design bans      the inlined CSS: no italics, pill radii, monospace, gradients, glass, Google Fonts
//   3. copy rules       banned marketing words, vendor or subprocessor names, "MCP/FHIR/Unity", em dashes
//   4. links            every internal href/src resolves to a built file, and every #anchor exists on its page
// Exit code 1 if anything fails. Scans dist/ (everything a visitor or a crawler can read).
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const failures = [];
const fail = (check, where, msg) => failures.push(`${check.padEnd(12)} ${where}: ${msg}`);

// ---------------------------------------------------------------- 1. build
try {
  execFileSync(process.execPath, [join(ROOT, "scripts", "build.mjs")], { stdio: "pipe", env: process.env });
} catch (e) {
  console.error(String(e.stdout || ""), String(e.stderr || ""));
  console.error("check: the build failed");
  process.exit(1);
}

const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const files = walk(DIST);
const html = files.filter((f) => f.endsWith(".html"));
const rel = (f) => "/" + relative(DIST, f).split(sep).join("/");
const read = (f) => readFileSync(f, "utf8");

// ---------------------------------------------------------------- 2. design bans (CSS only)
const CSS_BANS = [
  [/font-style\s*:\s*italic/i, "italic text"],
  [/border-radius\s*:\s*(9{2,}|[5-9]\d)px/i, "pill radius"],
  [/font-family\s*:[^;}]*monospace/i, "monospace type"],
  [/(linear|radial|conic)-gradient\(/i, "gradient"],
  [/backdrop-filter/i, "glass (backdrop-filter)"],
  [/fonts\.(googleapis|gstatic)\.com/i, "Google Fonts request"],
];
const cssOf = (s) => [...s.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
const cssFiles = files.filter((f) => f.endsWith(".css"));
for (const f of [...html, ...cssFiles]) {
  const css = f.endsWith(".css") ? read(f) : cssOf(read(f));
  for (const [re, what] of CSS_BANS) if (re.test(css)) fail("design-ban", rel(f), what);
}
for (const f of html) if (/fonts\.(googleapis|gstatic)\.com/i.test(read(f))) fail("design-ban", rel(f), "Google Fonts link");

// ---------------------------------------------------------------- 3. copy rules (visible text + metadata)
const WORDS = ["leverage", "seamless", "empower", "unlock", "robust", "actionable", "elevate", "delve", "solutions"];
const VENDORS = ["Retell", "OpenAI", "ChatGPT", "GPT-", "AWS", "Amazon Web Services", "Cloudflare", "ElevenLabs",
  "SentinelOne", "Garrison", "Twilio", "Azure", "Tesseract", "Anthropic"];
const TECH = ["MCP", "FHIR", "Unity"];
// The brand-kit page quotes the rules themselves, so it may name a banned word as an example.
const RULES_PAGES = new Set(["/brand/index.html"]);
const textOf = (s) => s
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<script(?![^>]*application\/ld\+json)[\s\S]*?<\/script>/gi, " ") // keep JSON-LD: crawlers read it
  .replace(/<[^>]+?(content|alt|title|aria-label|placeholder)="([^"]*)"[^>]*>/gi, " $2 ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&[a-z#0-9]+;/gi, (e) => ({ "&amp;": "&", "&mdash;": "—", "&#8212;": "—" }[e] || " "));
const jsFiles = files.filter((f) => f.endsWith(".js"));
for (const f of [...html, ...jsFiles]) {
  const raw = read(f);
  const text = f.endsWith(".js") ? raw : textOf(raw);
  const where = rel(f);
  if (/—/.test(raw) || /—/.test(text)) fail("em-dash", where, "contains an em dash");
  if (f.endsWith(".js")) continue; // code identifiers are not copy; only the em dash rule applies to scripts
  if (!RULES_PAGES.has(where)) {
    for (const w of WORDS) if (new RegExp(`\\b${w}`, "i").test(text)) fail("banned-word", where, `"${w}"`);
  }
  for (const v of VENDORS) if (new RegExp(`\\b${v.replace(/[-]/g, "\\-")}`, v === v.toUpperCase() ? "" : "i").test(text)) fail("vendor-name", where, `"${v}"`);
  for (const t of TECH) if (new RegExp(`\\b${t}\\b`).test(text)) fail("tech-term", where, `"${t}"`);
}

// ---------------------------------------------------------------- 4. internal links and anchors
const idsOf = new Map();
const ids = (f) => {
  if (!idsOf.has(f)) idsOf.set(f, new Set([...read(f).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  return idsOf.get(f);
};
const resolve = (from, url) => {
  const [pathPart, hash = ""] = url.split("#");
  const clean = pathPart.split("?")[0];
  let target;
  if (clean === "") target = from;
  else {
    const abs = clean.startsWith("/") ? join(DIST, clean) : join(dirname(from), clean);
    const cands = [abs, join(abs, "index.html"), abs + ".html"];
    target = cands.find((c) => existsSync(c) && statSync(c).isFile());
  }
  return { target, hash };
};
let linkCount = 0;
for (const f of html) {
  const raw = read(f).replace(/<script[\s\S]*?<\/script>/gi, "");
  for (const m of raw.matchAll(/\s(href|src|srcset|imagesrcset|popovertarget)="([^"]+)"/g)) {
    const [, attr, val] = m;
    if (attr === "popovertarget") {
      linkCount++;
      if (!ids(f).has(val)) fail("link", rel(f), `popovertarget "${val}" has no element`);
      continue;
    }
    const urls = attr.includes("srcset") ? val.split(",").map((s) => s.trim().split(/\s+/)[0]) : [val];
    for (const url of urls) {
      if (/^(https?:|mailto:|tel:|data:)/i.test(url)) continue;
      linkCount++;
      const { target, hash } = resolve(f, url);
      if (!target) { fail("link", rel(f), `${url} does not resolve`); continue; }
      if (hash && target.endsWith(".html") && !ids(target).has(decodeURIComponent(hash))) fail("link", rel(f), `${url}: no #${hash} on ${rel(target)}`);
    }
  }
}

// ---------------------------------------------------------------- report
const counts = `${html.length} pages, ${linkCount} internal links and anchors`;
if (failures.length) {
  console.error(failures.join("\n"));
  console.error(`\ncheck: ${failures.length} problem(s) in ${counts}`);
  process.exit(1);
}
console.log(`check: OK (build; design bans; copy rules; ${counts})`);
