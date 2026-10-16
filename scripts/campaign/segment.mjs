// Segment a company/contact list for the Drawbridge launch. Reads a CSV, writes CSVs. Sends nothing.
// Usage: node scripts/campaign/segment.mjs <input.csv> [outdir=data/segments]
// See docs/campaign/02_ICP_AND_LIST_SEGMENTATION.md. Output folders under data/ are git-ignored.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const [input, outdir = "data/segments"] = process.argv.slice(2);
if (!input) {
  console.error("usage: node scripts/campaign/segment.mjs <input.csv> [outdir]");
  process.exit(2);
}

// --- minimal RFC 4180 CSV parser / writer ---
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v !== "")) rows.push(row);
  return rows;
}
const cell = (v) => {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula injection guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (cols, rows) => [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";

// --- header normalization ---
const ALIASES = {
  practice_name: ["practice", "company", "company_name", "organization", "account", "name"],
  website: ["domain", "url", "web"],
  specialty: ["speciality", "specialties", "type"],
  providers: ["provider_count", "num_providers", "physicians", "doctors"],
  state: ["st", "province"],
  ehr: ["emr", "ehr_system", "emr_system"],
  pm: ["pm_system", "practice_management"],
  contact_first: ["first", "first_name", "firstname"],
  contact_last: ["last", "last_name", "lastname"],
  contact_title: ["title", "job_title", "role"],
  contact_email: ["email", "e-mail", "email_address"],
  contact_phone: ["phone", "phone_number"],
  linkedin_url: ["linkedin"],
  is_moatit_client: ["client", "moatit_client", "customer"],
  do_not_contact: ["dnc", "unsubscribed", "opt_out"],
};
const norm = (h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const canon = (h) => {
  const n = norm(h);
  for (const [k, list] of Object.entries(ALIASES)) if (n === k || list.includes(n)) return k;
  return n;
};

const yes = (v) => /^(y|yes|true|1)$/i.test(String(v || "").trim());
const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const REGION = new Set(["ID", "UT", "WY", "MT", "NV", "OR", "WA", "CO"]);
const DOC_HEAVY = /nephro|internal|family|endocr|cardio|oncol|hemat|rheum|gastro|urolog|ob.?gyn|obstet|gyn|pediat|primary/i;
const FAX_FIRST = /nephro|internal|endocr|oncol|hemat|cardio/i;
const PHONE_FIRST = /pediat|ob.?gyn|obstet|family|dermat|ortho/i;

const persona = (t = "") =>
  /owner|physician|md\b|do\b|doctor|president|ceo|founder|partner|medical director/i.test(t) ? "owner_physician"
  : /practice manager|administrator|office manager|operations|coo|director of operations|practice admin/i.test(t) ? "practice_manager"
  : /front|reception|scheduler|patient access|medical records|referral|desk/i.test(t) ? "front_desk_lead"
  : /it\b|information|technology|security|systems|cio|cto|network/i.test(t) ? "it_security"
  : "other";

function score(r) {
  let s = 0;
  const e = `${r.ehr} ${r.pm}`.toLowerCase();
  const hasEhr = /veradigm.*ehr|ehr.*veradigm|allscripts|touchworks|professional ehr/.test(e) || /veradigm ehr/.test(e);
  const hasPm = /veradigm.*pm|practice management|\bpm\b/.test(e);
  if (/veradigm|allscripts/.test(e)) s += hasEhr && hasPm ? 30 : 20;
  else if (!e.trim() || /unknown/.test(e)) s += 5;
  const p = parseInt(String(r.providers).replace(/[^0-9].*$/, ""), 10);
  if (p >= 2 && p <= 40) s += 20;
  else if (p === 1 || (p > 40 && p <= 100)) s += 8;
  if (DOC_HEAVY.test(r.specialty || "")) s += 15;
  if (yes(r.is_moatit_client)) s += 15;
  if (REGION.has(String(r.state || "").trim().toUpperCase())) s += 10;
  if (r.persona === "practice_manager") s += 10;
  return Math.min(100, s);
}

const variant = (r) => {
  if (FAX_FIRST.test(r.specialty || "")) return "fax";
  if (PHONE_FIRST.test(r.specialty || "")) return "phone";
  const h = createHash("sha256").update(String(r.company_id)).digest()[0];
  return h % 2 ? "fax" : "phone";
};

// --- load ---
const raw = readFileSync(input, "utf8").replace(/^﻿/, "");
const [header, ...body] = parseCsv(raw);
const cols = header.map(canon);
const records = body.map((r) => Object.fromEntries(cols.map((c, i) => [c, (r[i] ?? "").trim()])));

const suppression = new Set();
const supFile = join("data", "suppression.csv");
if (existsSync(supFile)) for (const [v] of parseCsv(readFileSync(supFile, "utf8"))) if (v) suppression.add(v.trim().toLowerCase());

const seenEmail = new Set();
const keep = [], rejected = [];
for (const r of records) {
  r.contact_email = (r.contact_email || "").toLowerCase();
  r.company_id = r.company_id || "C-" + createHash("sha256").update(`${r.practice_name}|${r.state}|${r.website}`.toLowerCase()).digest("hex").slice(0, 8);
  r.persona = persona(r.contact_title);
  const domain = r.contact_email.split("@")[1] || "";
  let why = "";
  if (!r.practice_name) why = "missing practice_name";
  else if (yes(r.do_not_contact)) why = "do_not_contact";
  else if (r.contact_email && (suppression.has(r.contact_email) || suppression.has(domain))) why = "suppressed";
  else if (r.contact_email && !EMAIL.test(r.contact_email)) why = "invalid email";
  else if (r.contact_email && seenEmail.has(r.contact_email)) why = "duplicate email";
  else if (!r.consent_basis) why = "missing consent_basis";
  if (why) { rejected.push({ ...r, reject_reason: why }); continue; }
  if (r.contact_email) seenEmail.add(r.contact_email);
  r.fit_score = score(r);
  r.tier = r.fit_score >= 70 ? "A" : r.fit_score >= 45 ? "B" : "C";
  r.lp_variant = variant(r);
  r.utm_campaign = "drawbridge_launch_2026q4";
  r.landing_url = `https://drawbridge.moatit.com/lp/${r.lp_variant}/?utm_source=email&utm_medium=outbound&utm_campaign=drawbridge_launch_2026q4&utm_content=${r.tier}_${r.persona}`;
  keep.push(r);
}

const OUT_COLS = ["company_id", "practice_name", "website", "specialty", "providers", "state", "ehr", "pm", "is_moatit_client", "contact_first", "contact_last", "contact_title", "persona", "contact_email", "linkedin_url", "consent_basis", "source", "fit_score", "tier", "lp_variant", "landing_url"];
mkdirSync(join(outdir, "by_persona"), { recursive: true });
const write = (name, rows, c = OUT_COLS) => writeFileSync(join(outdir, name), toCsv(c, rows));
write("seg_A_existing_clients.csv", keep.filter((r) => r.tier === "A" && yes(r.is_moatit_client)));
write("seg_A_new.csv", keep.filter((r) => r.tier === "A" && !yes(r.is_moatit_client)));
write("seg_B.csv", keep.filter((r) => r.tier === "B"));
write("seg_C_nurture.csv", keep.filter((r) => r.tier === "C"));
for (const p of ["owner_physician", "practice_manager", "front_desk_lead", "it_security", "other"]) write(`by_persona/${p}.csv`, keep.filter((r) => r.persona === p));
write("rejected.csv", rejected, [...OUT_COLS.filter((c) => !["fit_score", "tier", "lp_variant", "landing_url"].includes(c)), "reject_reason"]);

const count = (f) => keep.filter(f).length;
const summary = {
  input_rows: records.length,
  kept: keep.length,
  rejected: rejected.length,
  companies: new Set(keep.map((r) => r.company_id)).size,
  tiers: { A: count((r) => r.tier === "A"), B: count((r) => r.tier === "B"), C: count((r) => r.tier === "C") },
  personas: Object.fromEntries(["owner_physician", "practice_manager", "front_desk_lead", "it_security", "other"].map((p) => [p, count((r) => r.persona === p)])),
  variants: { fax: count((r) => r.lp_variant === "fax"), phone: count((r) => r.lp_variant === "phone") },
};
writeFileSync(join(outdir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
