import { ORG, COMPAT_LINE, TRADEMARK_NOTE } from "../site.mjs";
import { pageHero } from "../layout.mjs";
import { icon, btnPrimary, btnSecondary, ctaBand, esc, emailLink, phoneLinks, itNeedsBlock } from "../partials.mjs";

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
    "How Drawbridge protects patient information: BAA, multi-factor sign-in, a tamper-evident six-year audit log, per-call caller verification, no model training on your data, the encryption and US hosting every production deployment requires, an independent code audit and SOC 2 in process.",
  crumbs: [{ name: "Security & HIPAA", href: "/security/" }],
  body: `${pageHero({
    eyebrow: "Trust center",
    title: 'Security &amp; HIPAA, <span class="accent-i">in plain words.</span>',
    lede: "What patient information Drawbridge handles, how it's protected, and what is still in progress. We list what is true today, and label work in progress as in progress.",
    crumbs: [{ name: "Security & HIPAA", href: "/security/" }],
    actions: btnPrimary("Request our security packet", "/contact/?topic=security") + btnSecondary("Email questions@moatit.com", "mailto:questions@moatit.com?subject=Drawbridge%20security"),
  })}
<section class="section" aria-labelledby="summary-title">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">Summary</p>
      <h2 id="summary-title">What Drawbridge touches, and why</h2>
    </div>
    <div class="grid grid-3">
      <div class="card"><div class="icon">${icon("fax")}</div><h3>Incoming documents</h3><p>Faxes, lab results and other documents sent to your practice, so they can be read, matched and filed to the right chart.</p></div>
      <div class="card"><div class="icon">${icon("phone")}</div><h3>Calls to your line</h3><p>Who is calling and what they need, so the assistant can verify them and help with visits, balances and messages.</p></div>
      <div class="card"><div class="icon">${icon("calendar")}</div><h3>Schedule and chart data</h3><p>Only what each task needs, read from and written to your EHR and practice-management system through a dedicated Drawbridge user that your practice administrator creates.</p></div>
    </div>
    <p class="mt-2 lede">MOATiT is your business associate under HIPAA. We sign a BAA with every practice before any patient data flows, and we have signed BAAs with every service provider that handles patient information for us.</p>
  </div>
</section>
<section class="section on-white" aria-labelledby="controls-title">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">Controls</p>
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
          ${row("Encryption at rest", "Data volumes and backups on encrypted disks, in our US cloud hosting and in MOATiT's data center.", "req")}
          ${row("US hosting", "Hosted in the United States, in a US cloud region and in MOATiT's data center; single-tenant per practice.", "req")}
          ${row("Minimum necessary", "The phone assistant receives only what a verified caller's request needs. Full SSNs are never stored; only the last four digits are used, to check a match.", "ok")}
          ${row("No patient data in logs", "Server logs carry tool names, IDs and outcomes only, never names, birth dates or chart contents.", "ok")}
          ${row("Call recordings", "Personal information is redacted from recordings and transcripts after each call; kept 30 days.", "ok")}
          ${row("Retention", "Original faxes deleted 30 days after filing (the chart copy is the record); patient details on intake records after 90 days; call records after 30 days.", "ok")}
          ${row("Backups", "Every two hours, kept six months, encrypted and immutable: required for every production deployment.", "req")}
          ${row("Document integrity", "Each document is fingerprinted on arrival and checked again before it is filed.", "ok")}
          ${row("No model training on your data", "No AI models are trained on your data, including your calls.", "ok")}
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
          ${row("System status and alerts", "Connection health checked every two minutes; MOATiT's help desk is alerted by email when it goes down and when it recovers. Alert delivery is configured for every production deployment.", "req")}
          ${row("Endpoint protection", "Managed endpoint detection and response; critical patches applied within seven days after testing.", "org")}
        </tbody>
      </table>
    </div>
    <div class="table-wrap mt-2">
      <table>
        <caption>Program, people and assurance</caption>
        <thead><tr><th scope="col">Item</th><th scope="col">Detail</th><th scope="col">Status</th></tr></thead>
        <tbody>
          ${row("Business associate agreements", "Signed with every practice before any patient data flows, and with every service provider that handles patient information for us.", "ok")}
          ${row("HIPAA training", "Annual HIPAA security and privacy training for the MOATiT workforce.", "org")}
          ${row("Incident response", "Documented incident response plan, with breach notification to practices as set out in the BAA.", "org")}
          ${row("Disaster recovery &amp; continuity", "Documented disaster recovery and business continuity plans.", "org")}
          ${row("Independent testing", "Annual vulnerability scans and penetration tests by an independent outside firm.", "org")}
          ${row("Independent code audit", "Security and HIPAA technical-safeguards audit of the Drawbridge code by MOATiT's compliance officer, who is not involved in Drawbridge's development, October 2026: audit passed, with every high-severity finding fixed.", "ok")}
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
      <p class="eyebrow">AI safety</p>
      <h2 id="ai-title">Where the AI stops and the rules begin.</h2>
      <p class="lede">AI reads documents and holds the conversation. Deciding which chart a document belongs to, and whether a caller may hear anything, is done by written rules you can inspect.</p>
    </div>
    <ul class="checks">
      <li><span>Two identifiers, one patient, no conflicts, or the document goes to a person</span></li>
      <li><span>Records requests, prior authorizations, refill requests and referrals always to a person by default</span></li>
      <li><span>Original documents filed exactly as received, with clinical content left as written</span></li>
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
    "Drawbridge integrates with Veradigm® EHR and Veradigm® Practice Management your fax routing, a lab file drop and your phone line. See what it reads and the short list of things it is allowed to write.",
  crumbs: [{ name: "Integrations", href: "/integrations/" }],
  body: `${pageHero({
    eyebrow: "Integrations",
    title: 'Works inside the systems <span class="accent-i">you already use.</span>',
    lede: `${COMPAT_LINE}. Drawbridge works inside the systems you already have, filing into the chart and booking into the schedule your staff already use. A read-only shadow week comes first.`,
    crumbs: [{ name: "Integrations", href: "/integrations/" }],
    actions: btnPrimary(),
  })}
<section class="section" aria-labelledby="ehr-title">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">EHR &amp; practice management</p>
      <h2 id="ehr-title">Veradigm® EHR and Veradigm® Practice Management</h2>
      <p class="lede">Drawbridge connects through Veradigm's secure API, over encrypted connections, with the access you authorize through Veradigm®.</p>
    </div>
    <div class="grid grid-2">
      <div class="card">
        <h3>What Drawbridge reads</h3>
        <ul class="checks">
          <li><span>Patient search (to verify callers and match documents)</span></li>
          <li><span>Schedules, open times and appointment types</span></li>
          <li><span>Balance and insurance on file</span></li>
          <li><span>Medication, allergy and problem lists and recent results, for verified callers and on-call briefs</span></li>
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
        <p class="small">Drawbridge writes only the items above. It never writes clinical content (notes, orders, result values or medication changes), and the phone assistant never interprets results or medications.</p>
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
      <div class="card"><div class="icon">${icon("fax")}</div><h3>Faxes and lab files</h3><p>When you go live, faxes and lab files come to Drawbridge first; MOATiT sets up the fax routing and the lab file drop with you. Multi-patient lab batches are split by patient. Anything that needs a person goes to your Veradigm® EHR document queue for staff, as today.</p></div>
      <div class="card"><div class="icon">${icon("phone")}</div><h3>Your clinic number</h3><p>Your line forwards the calls you choose (after hours, overflow or all) to Drawbridge first; moving the number over comes later. During business hours calls transfer back to your staff; after hours, urgent calls are flagged for your on-call provider.</p></div>
      <div class="card"><div class="icon">${icon("bell")}</div><h3>Status alerts</h3><p>Status alerts by encrypted email to MOATiT's help desk whenever the Veradigm® connection changes.</p></div>
      <div class="card"><div class="icon">${icon("hospital")}</div><h3>MOATiT-hosted</h3><p>Drawbridge runs single-tenant per practice on MOATiT's infrastructure. If you decide not to go ahead after the shadow week, we switch it off; nothing in your system changed.</p></div>
    </div>
    <p class="tm-note">${esc(TRADEMARK_NOTE)}</p>
  </div>
</section>
<section class="section" id="it-needs" aria-labelledby="int-it-needs">
  <div class="wrap">
    ${itNeedsBlock({ headingId: "int-it-needs", tag: "h2" })}
  </div>
</section>
${ctaBand({ title: "Not on Veradigm? Talk to us.", text: "Drawbridge launches for practices on Veradigm® EHR and Veradigm® Practice Management. If you use another system, tell us which one; it helps us decide what comes next." })}`,
};
