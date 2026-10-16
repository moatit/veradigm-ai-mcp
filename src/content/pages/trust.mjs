import { ORG, COMPAT_LINE, TRADEMARK_NOTE } from "../site.mjs";
import { pageHero } from "../layout.mjs";
import { icon, btnPrimary, btnSecondary, ctaBand, esc, emailLink, phoneLinks } from "../partials.mjs";

// Status legend for the trust center. Keep in sync with docs/CLAIMS_REGISTER.md.
const S = {
  ok: '<span class="pill pill-ok">In place</span>',
  req: '<span class="pill pill-req">Every deployment</span>',
  org: '<span class="pill pill-org">MOATiT policy</span>',
  prog: '<span class="pill pill-prog">In progress</span>',
};

const row = (control, detail, status) => `<tr><th scope="row">${control}</th><td>${detail}</td><td>${S[status]}</td></tr>`;

export const security = {
  path: "/security/",
  title: "Security & HIPAA trust center",
  description:
    "How Drawbridge protects patient information: BAA, multi-factor sign-in, encryption in transit and at rest, a tamper-evident six-year audit log, per-call caller verification, US hosting, independent audit and SOC 2 in process.",
  crumbs: [{ name: "Security & HIPAA", href: "/security/" }],
  body: `${pageHero({
    eyebrow: "Trust center",
    title: 'Security &amp; HIPAA, <span class="accent-i">in plain words.</span>',
    lede: "What patient information Drawbridge handles, how it's protected, and what is still in progress. We list only what is true today, and say so when something isn't finished.",
    crumbs: [{ name: "Security & HIPAA", href: "/security/" }],
    actions: btnPrimary("Request our security packet", "/contact/?topic=security") + btnSecondary("Email questions@moatit.com", "mailto:questions@moatit.com?subject=Drawbridge%20security"),
  })}
<section class="section" aria-labelledby="summary-title">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">01 — Summary</p>
      <h2 id="summary-title">What Drawbridge touches, and why</h2>
    </div>
    <div class="grid grid-3">
      <div class="card"><div class="icon">${icon("fax")}</div><h3>Incoming documents</h3><p>Faxes, lab results and other documents sent to your practice, so they can be read, matched and filed to the right chart.</p></div>
      <div class="card"><div class="icon">${icon("phone")}</div><h3>Calls to your line</h3><p>Who is calling and what they need, so the assistant can verify them and help with visits, balances and messages.</p></div>
      <div class="card"><div class="icon">${icon("calendar")}</div><h3>Schedule and chart data</h3><p>Only what each task needs, read from and written to your EHR and practice-management system through a dedicated integration user.</p></div>
    </div>
    <p class="mt-2 lede">MOATiT is your business associate under HIPAA. We sign a BAA with every practice before any patient data flows, and hold BAAs with the service providers that handle patient information for us.</p>
  </div>
</section>
<section class="section on-white" aria-labelledby="controls-title">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">02 — Controls</p>
      <h2 id="controls-title">Safeguards, one by one</h2>
      <p class="lede"><span class="pill pill-ok">In place</span> built into Drawbridge and checked in our launch audit. <span class="pill pill-req">Every deployment</span> a hosting requirement every production deployment must meet before patient data flows. <span class="pill pill-org">MOATiT policy</span> covered by MOATiT's company program. <span class="pill pill-prog">In progress</span> not finished yet.</p>
    </div>
    <div class="table-wrap">
      <table>
        <caption>Access and identity</caption>
        <thead><tr><th scope="col">Control</th><th scope="col">How it works</th><th scope="col">Status</th></tr></thead>
        <tbody>
          ${row("Multi-factor sign-in", "Authenticator-app (TOTP) codes required for every staff user; each code works once.", "ok")}
          ${row("Password policy", "At least 12 characters; common passwords and simple variants refused; expiry every 90 days, the last five can't be reused. Stored as salted scrypt hashes.", "ok")}
          ${row("Lockout", "Five failed sign-ins in 15 minutes lock that username for 15 minutes; repeated failures from one network address are blocked too.", "ok")}
          ${row("Automatic sign-out", "After 15 minutes idle and 12 hours at most; signing out ends the session on the server.", "ok")}
          ${row("Unique, role-based logins", "Named users with staff, administrator and time-limited emergency roles. No shared logins in production.", "ok")}
          ${row("Caller verification on every call", "The phone assistant can read or change only the records of callers verified on that call by first name, last name and date of birth. Enforced by the server; at most two verified people and five lookups per call.", "ok")}
        </tbody>
      </table>
    </div>
    <div class="table-wrap mt-2">
      <table>
        <caption>Data protection</caption>
        <thead><tr><th scope="col">Control</th><th scope="col">How it works</th><th scope="col">Status</th></tr></thead>
        <tbody>
          ${row("Encryption in transit", "TLS 1.2 or later on every connection; staff pages use strict transport security and secure cookies. Production refuses unencrypted connections to the EHR and fax systems.", "req")}
          ${row("Encryption at rest", "Data volumes and backups on encrypted disks (AWS EBS with KMS, or full-disk encryption in MOATiT's data center).", "req")}
          ${row("US hosting", "Hosted in the United States on AWS and in MOATiT's data center; single-tenant per practice.", "req")}
          ${row("Minimum necessary", "The phone assistant receives only what a verified caller's request needs. Full SSNs are never stored; only the last four digits are used, to check a match.", "ok")}
          ${row("No patient data in logs", "Server logs carry tool names, IDs and outcomes only, never names, birth dates or chart contents.", "ok")}
          ${row("Call recordings", "Personal information is redacted from recordings and transcripts after each call; kept 30 days.", "ok")}
          ${row("Retention", "Original faxes deleted 30 days after filing (the chart copy is the record); patient details on intake records after 90 days; call records after 30 days.", "ok")}
          ${row("Backups", "Every two hours, kept six months, encrypted and immutable.", "org")}
          ${row("Document integrity", "Each document is fingerprinted on arrival and checked again before it is filed.", "ok")}
          ${row("No model training on your data", "Drawbridge does not use your practice's data to train AI models.", "ok")}
        </tbody>
      </table>
    </div>
    <div class="table-wrap mt-2">
      <table>
        <caption>Audit and monitoring</caption>
        <thead><tr><th scope="col">Control</th><th scope="col">How it works</th><th scope="col">Status</th></tr></thead>
        <tbody>
          ${row("Tamper-evident audit log", "Every tool call, staff view and change is written to a hash-chained log kept for six years; edits, deletions and re-ordering are detectable.", "ok")}
          ${row("Access and disclosure reports", "Administrators can list every access to one patient, or every action by one user, for any date range.", "ok")}
          ${row("Security events", "Sign-in failures, lockouts, rejected keys, emergency access and unusual export volumes are recorded as security events for review.", "ok")}
          ${row("System status and alerts", "Connection health checked every two minutes; your help desk is alerted when it goes down and when it recovers.", "ok")}
          ${row("Endpoint protection", "SentinelOne endpoint detection and response; critical patches applied within seven days after testing.", "org")}
        </tbody>
      </table>
    </div>
    <div class="table-wrap mt-2">
      <table>
        <caption>Program, people and assurance</caption>
        <thead><tr><th scope="col">Item</th><th scope="col">Detail</th><th scope="col">Status</th></tr></thead>
        <tbody>
          ${row("Business associate agreements", "With every practice, and with the providers that handle patient information for us (including AWS).", "org")}
          ${row("HIPAA training", "Annual HIPAA security and privacy training for the MOATiT workforce.", "org")}
          ${row("Incident response", "Documented incident response plan, with breach notification to practices as set out in the BAA.", "org")}
          ${row("Disaster recovery &amp; continuity", "Documented disaster recovery and business continuity plans.", "org")}
          ${row("Independent testing", "Annual vulnerability scans and penetration tests by an outside firm (Garrison).", "org")}
          ${row("Independent launch audit", "Security and HIPAA technical-safeguards audit of the Drawbridge code by a reviewer who did not write it, October 2026: passed, with every high-severity finding fixed.", "ok")}
          ${row("SOC 2", "In process; the audit is to be completed before the end of 2027.", "prog")}
          ${row("Veradigm Connect certification", "MOATiT's certification for Drawbridge is in progress.", "prog")}
        </tbody>
      </table>
    </div>
  </div>
</section>
<section class="section on-night blueprint" aria-labelledby="ai-title">
  <div class="wrap split">
    <div>
      <p class="eyebrow">03 — AI safety</p>
      <h2 id="ai-title">Where the AI stops and the rules begin.</h2>
      <p class="lede">AI reads documents and holds the conversation. Deciding which chart a document belongs to, and whether a caller may hear anything, is done by written rules you can inspect.</p>
    </div>
    <ul class="checks">
      <li><span>Two identifiers, one patient, no conflicts, or the document goes to a person</span></li>
      <li><span>Records requests, prior authorizations, refill requests and referrals always to a person by default</span></li>
      <li><span>Original documents filed unaltered; Drawbridge never summarizes or edits clinical content</span></li>
      <li><span>A shadow week before any filing; switch on in stages</span></li>
      <li><span>No medical advice on the phone; emergencies told to call 911</span></li>
      <li><span>Read-back and a yes before any appointment change</span></li>
    </ul>
  </div>
</section>
<section class="section" aria-labelledby="report-title">
  <div class="wrap grid grid-2">
    <div class="aside-card">
      <h2 id="report-title" class="h3like">Report a security issue</h2>
      <p>If you believe you've found a vulnerability in Drawbridge or this website, email ${emailLink()} with "Security" in the subject line, or call ${phoneLinks(" or ")}. Please don't include patient information. We'll acknowledge your report within one business day.</p>
    </div>
    <div class="aside-card">
      <h2 class="h3like">Documents on request</h2>
      <p>Our security packet includes our vendor security questionnaire answers, HIPAA safeguards checklist, BAA template and the launch audit summary. Ask during your walkthrough or request it below.</p>
      <div class="btn-row">${btnPrimary("Request the security packet", "/contact/?topic=security")}</div>
    </div>
  </div>
</section>
${ctaBand()}`,
};

export const integrations = {
  path: "/integrations/",
  title: "Integrations: Veradigm® EHR, Veradigm® PM, fax and phones",
  description:
    "Drawbridge integrates with Veradigm® EHR and Veradigm® Practice Management, your fax line, lab drop folders and your phone system. See what it reads and the short list of things it is allowed to write.",
  crumbs: [{ name: "Integrations", href: "/integrations/" }],
  body: `${pageHero({
    eyebrow: "Integrations",
    title: 'Works inside the systems <span class="accent-i">you already use.</span>',
    lede: `${COMPAT_LINE}. Drawbridge files into the chart and books into the schedule your staff already work in. No new EHR, no double entry.`,
    crumbs: [{ name: "Integrations", href: "/integrations/" }],
    actions: btnPrimary(),
  })}
<section class="section" aria-labelledby="ehr-title">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">EHR &amp; practice management</p>
      <h2 id="ehr-title">Veradigm® EHR and Veradigm® Practice Management</h2>
      <p class="lede">Drawbridge connects through Veradigm's secure partner interface with a dedicated integration user for your practice, over encrypted connections.</p>
    </div>
    <div class="grid grid-2">
      <div class="card">
        <h3>What Drawbridge reads</h3>
        <ul class="checks">
          <li><span>Patient search (to verify callers and match documents)</span></li>
          <li><span>Schedules, open times and appointment types</span></li>
          <li><span>Balance and insurance on file</span></li>
          <li><span>Medication, allergy and problem lists, for verified callers and on-call briefs</span></li>
          <li><span>Document categories and the provider list</span></li>
        </ul>
      </div>
      <div class="card">
        <h3>The short list it may write</h3>
        <ul class="checks">
          <li><span>Appointments: book, reschedule, cancel, confirm</span></li>
          <li><span>New-patient registration from the phone</span></li>
          <li><span>Tasks: provider review tasks and staff messages</span></li>
          <li><span>Scanned documents filed to the chart</span></li>
        </ul>
        <p class="small">Drawbridge never writes clinical content: no notes, orders, results values or medication changes.</p>
      </div>
    </div>
  </div>
</section>
<section class="section on-white" aria-labelledby="other-title">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">Documents, phones, alerts</p>
      <h2 id="other-title">Everything around the chart</h2>
    </div>
    <div class="grid grid-3">
      <div class="card"><div class="icon">${icon("fax")}</div><h3>Fax line</h3><p>Works with MOATiT Fax: faxes arrive on MOATiT's servers and are handed to Drawbridge over signed, encrypted connections.</p></div>
      <div class="card"><div class="icon">${icon("flask")}</div><h3>Lab drop folders</h3><p>Daily lab files (PDF, TIFF, PNG, JPEG) from a secure folder or SFTP drop. Batch files are split by patient.</p></div>
      <div class="card"><div class="icon">${icon("mail")}</div><h3>Emailed results &amp; uploads</h3><p>Results from other systems, or a staff upload on the intake screen, go through the same checks.</p></div>
      <div class="card"><div class="icon">${icon("phone")}</div><h3>Your clinic number</h3><p>Keep your number. Calls are routed to the assistant by hours or overflow, and transferred back to your staff or on-call provider.</p></div>
      <div class="card"><div class="icon">${icon("bell")}</div><h3>Help-desk alerts</h3><p>Status alerts by encrypted email or signed webhook to your IT help desk.</p></div>
      <div class="card"><div class="icon">${icon("hospital")}</div><h3>MOATiT-hosted</h3><p>Single-tenant per practice, run by the team that may already host your EHR, phones and network.</p></div>
    </div>
    <p class="tm-note">${esc(TRADEMARK_NOTE)}</p>
  </div>
</section>
${ctaBand({ title: "Not on Veradigm? Talk to us.", text: "Drawbridge launches for practices on Veradigm® EHR and Veradigm® Practice Management. If you use another system, tell us which one; it helps us decide what comes next." })}`,
};
