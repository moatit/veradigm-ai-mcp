// Shared components (HTML string builders). All content is static and authored here.
import { SITE, ORG, CLAIMS, CTA, COMPAT_LINE, TEST_LINE } from "./site.mjs";

export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------------------------------------------------------------- icons
const P = {
  fax: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M10 11h5M10 14h5M10 17h3"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4.5 4.5-6.5 8-6.5s6.5 2 8 6.5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1-3.8 3.6-5.5 6.5-5.5s5.5 1.7 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.8.7 3 2.4 3.6 5.2"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M8 14h3v3H8z"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  alert: '<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4.5M12 17.5v.5"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>',
  server: '<rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/><path d="M8 7.5h.01M8 16.5h.01"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/>',
  split: '<path d="M4 6h6l4 6-4 6H4"/><path d="M14 12h6M17 9l3 3-3 3"/>',
  flask: '<path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3"/><path d="M7.5 15h9"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16"/><path d="M20 20v-4h-4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  clipboard: '<rect x="5" y="4.5" width="14" height="17" rx="2"/><path d="M9 3h6v3H9z"/><path d="M8.5 12l2 2 4-4M8.5 17h7"/>',
  hospital: '<path d="M4 21V7l8-4 8 4v14"/><path d="M10 21v-5h4v5"/><path d="M12 8v5M9.5 10.5h5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6l8.5 7 8.5-7"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  gauge: '<path d="M3.5 16a8.5 8.5 0 1 1 17 0"/><path d="M12 16l4-5"/>',
  doc: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.2 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/>',
};
export const icon = (name, cls = "") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[name] || P.check}</svg>`;

// ---------------------------------------------------------------- buttons
export const btnPrimary = (label = CTA.primary.label, href = CTA.primary.href) =>
  `<a class="btn btn-primary" href="${href}">${esc(label)}</a>`;
export const btnSecondary = (label, href) => `<a class="btn btn-secondary" href="${href}">${esc(label)}</a>`;

// ---------------------------------------------------------------- live test call (popover; no JavaScript needed)
export const liveCallButton = (cls = "btn btn-secondary") =>
  `<button class="${cls} btn-live" type="button" popovertarget="live-call">${esc(CTA.live.label)}</button>`;

export const liveCallDialog = () => `<div class="live-call" id="live-call" popover role="dialog" aria-labelledby="live-call-title" aria-describedby="live-call-note">
  <div class="lc-head">
    <h2 id="live-call-title">Call the Drawbridge test line</h2>
    <button class="lc-close" type="button" popovertarget="live-call" popovertargetaction="hide" aria-label="Close">Close</button>
  </div>
  <p class="lc-intro">Talk to the phone assistant yourself. It answers on a test system, so play the part of a sample patient.</p>
  <a class="lc-number" href="tel:${TEST_LINE.tel}"><span>Call</span>${TEST_LINE.label}</a>
  <div class="lc-patient">
    <p class="ledger-sample"><b>Synthetic sample</b><span>Test records in a Veradigm® sandbox, not real people.</span></p>
    <dl>
      <div><dt>Your name</dt><dd>${TEST_LINE.patients[0].name}</dd></div>
      <div><dt>Date of birth</dt><dd>${TEST_LINE.patients[0].dob}</dd></div>
    </dl>
    <p class="lc-alt">Or call as ${TEST_LINE.patients[1].name}, born ${TEST_LINE.patients[1].dob}.</p>
  </div>
  <h3>Things to try</h3>
  <ol class="lc-try">
    <li>&ldquo;When is my next appointment?&rdquo;</li>
    <li>&ldquo;Can I move it to later in the week?&rdquo;</li>
    <li>&ldquo;What times do you have open on Friday?&rdquo;</li>
    <li>&ldquo;Please leave a message for the front desk.&rdquo;</li>
  </ol>
  <p class="lc-note" id="live-call-note">The assistant verifies you by name and date of birth first, then reads back every change before making it. This line is connected to a test system with synthetic records only, so please use the sample patient above and keep real health information off the call. Standard call rates apply.</p>
</div>`;

export const phoneLinks = (sep = " · ") =>
  ORG.phones.map((p) => `<a href="tel:${p.tel}">${p.label}</a>`).join(sep);
export const emailLink = () => `<a href="mailto:${ORG.email}">${ORG.email}</a>`;
export const addressLine = () =>
  `${ORG.legalName}, ${ORG.address.street}, ${ORG.address.city}, ${ORG.address.region} ${ORG.address.postal}`;

// ---------------------------------------------------------------- trust strip (hero)
export const trustStrip = () => `<div class="trust-strip" role="list">
  <div role="listitem">${icon("shield")}<span><strong>BAA with every practice</strong>HIPAA business associate agreement before any patient data flows.</span></div>
  <div role="listitem">${icon("eye")}<span><strong>A shadow week first</strong>Drawbridge watches and compares for a week before it files anything.</span></div>
  <div role="listitem">${icon("user")}<span><strong>A person for every close call</strong>Anything that needs judgment goes to your staff, already read.</span></div>
  <div role="listitem">${icon("link")}<span><strong>${COMPAT_LINE}</strong>Works from the documents already in your Veradigm® EHR queue. Your workflow stays exactly as it is.</span></div>
</div>`;

// ---------------------------------------------------------------- intake ledger (home hero; synthetic)
// The rows fill in once on load (CSS only; off under prefers-reduced-motion).
const LEDGER = [
  ["7:42", "Lab result, 3 pages", "Rowan Ellery", "04/12/1961", "1", "ok", "Filed", "Lab Results. Review task to the ordering provider."],
  ["7:58", "Imaging report, 2 pages", "Jordan Pike", "09/30/1974", "1", "person", "To a person", "The address on the page differs from the chart."],
  ["8:05", "Referral letter, 4 pages", "Amara Quinn", "02/17/1988", "1", "person", "To a person", "Referrals always go to staff. Your practice set that rule."],
  ["8:11", "Lab batch, 6 pages", "Two names on page 4", "Two dates", "2", "person", "To a person", "Two patients on one page. A person decides."],
  ["8:20", "Lab result, 1 page", "Dana Whitlock", "11/03/1956", "1", "ok", "Filed", "Critical flag: high-priority task, call required."],
];
export const intakeLedger = () => `<div class="ledger" role="region" aria-labelledby="ledger-title" aria-describedby="ledger-sample">
  <p class="ledger-sample" id="ledger-sample"><b>Synthetic sample</b><span>Invented patients and documents, shown to illustrate how Drawbridge handles a morning's faxes.</span></p>
  <div class="ledger-head">
    <h2 id="ledger-title">Sample morning: five incoming faxes</h2>
    <p>Filed: 2. <b>Sent to a person: 3.</b></p>
  </div>
  <div class="ledger-rows" role="table" aria-labelledby="ledger-title">
    <div class="lr-head" role="row"><span role="columnheader">Time</span><span role="columnheader">Document</span><span role="columnheader">Full name</span><span role="columnheader">Date of birth</span><span role="columnheader">Matches</span><span role="columnheader">Outcome</span></div>
${LEDGER.map(([t, doc, name, dob, n, kind, out, why]) => {
  const id = n === "1" ? "ok" : "no";
  return `    <div class="lr" role="row"><span role="cell" class="lr-time">${t}</span><span role="cell" class="lr-doc">${doc}</span><span role="cell" class="lr-${id}">${name}</span><span role="cell" class="lr-${id}">${dob}</span><span role="cell" class="lr-n">${n}</span><span role="cell" class="lr-out${kind === "person" ? " person" : ""}"><b>${out}</b><em>${why}</em></span></div>`;
}).join("\n")}
  </div>
  <p class="ledger-foot">Synthetic sample with invented patients. In practice, every decision is logged with who, what and when, and staff confirm or correct a suggestion with one click.</p>
</div>`;

// ---------------------------------------------------------------- sample filing (animated)
export const gateCard = (id = "gate-demo") => `<figure class="gate-card" id="${id}" data-play aria-labelledby="${id}-cap">
  <header><span>INTAKE · fax 7:42 AM</span><span class="tag">Synthetic sample</span></header>
  <div class="gate-doc">
    <div class="fax-thumb" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
    <div class="meta"><strong>Outside lab result · 3 pages</strong>Sender: reference lab (sample)<br>Patient: Rowan Ellery · DOB 04/12/1961</div>
  </div>
  <ol class="gate-steps">
    <li><span class="ok">${icon("check")}</span><span><b>Read on MOATiT's servers</b><span class="d">Page by page, with MOATiT's own OCR.</span></span></li>
    <li><span class="ok">${icon("check")}</span><span><b>Matched: full name + date of birth</b><span class="d">Exactly one patient, with every identifier in agreement.</span></span></li>
    <li><span class="ok">${icon("check")}</span><span><b>Category: Lab Results</b><span class="d">Your clinic's own category name.</span></span></li>
    <li><span class="ok">${icon("check")}</span><span><b>Review task → ordering provider</b><span class="d">Linked to the filed document in the EHR task list.</span></span></li>
  </ol>
  <div class="gate-result">${icon("shield")}<span><strong>Filed to the chart.</strong> Logged with who, what and when.</span></div>
  <figcaption class="sample-note" id="${id}-cap">Illustration with an invented patient. When any check fails, the document goes to your staff queue instead, with the reason.</figcaption>
</figure>`;

// ---------------------------------------------------------------- sample: sent to staff
export const reviewCard = (id = "review-demo") => `<figure class="gate-card review-card" id="${id}" aria-labelledby="${id}-cap">
  <header><span>STAFF QUEUE · needs review</span><span class="tag">Synthetic sample</span></header>
  <div class="gate-doc">
    <div class="fax-thumb" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
    <div class="meta"><strong>Imaging report · 2 pages</strong>Read: Jordan Pike · DOB 09/30/1974<br>Suggested: Jordan Pike (one patient with this name and DOB)</div>
  </div>
  <ol class="gate-steps">
    <li><span class="ok">${icon("check")}</span><span><b>Name + date of birth match one patient</b></span></li>
    <li class="warn"><span class="ok">${icon("alert")}</span><span><b>Address on the document is different</b><span class="d">An old address, or someone else. A person decides.</span></span></li>
  </ol>
  <div class="review-actions" aria-hidden="true"><span class="fake-btn primary">File to Jordan Pike</span><span class="fake-btn">Choose another patient</span></div>
  <figcaption class="sample-note" id="${id}-cap">Illustration with an invented patient. Staff confirm or correct with one click; every decision is logged with who and when.</figcaption>
</figure>`;

// ---------------------------------------------------------------- sample call (animated)
const callLines = [
  ["agent", "Drawbridge", "Thanks for calling the clinic. This is the clinic's automated assistant. How can I help?"],
  ["caller", "Caller", "Hi, I need to move my appointment next week."],
  ["agent", "Drawbridge", "I can help with that. First, can I have your first and last name, and your date of birth?"],
  ["caller", "Caller", "Rowan Ellery, April 12, 1961."],
  ["system", "", "Identity verified on this call · name + DOB match exactly one patient"],
  ["agent", "Drawbridge", "Thank you, Rowan. I see a follow-up visit on Tuesday at 9:30 with Dr. Hale. I have Thursday at 2:15 or Friday at 10:00 with the same provider."],
  ["caller", "Caller", "Thursday works."],
  ["agent", "Drawbridge", "Just to confirm: I'll move your follow-up from Tuesday at 9:30 to Thursday at 2:15 with Dr. Hale. Shall I make that change?"],
  ["caller", "Caller", "Yes, please."],
  ["system", "", "Rescheduled in the practice-management system · read back and confirmed"],
  ["agent", "Drawbridge", "Done. You're booked for Thursday at 2:15. Is there anything else?"],
];
export const callCard = (id = "call-demo", { play = true } = {}) => `<figure class="call-card" id="${id}"${play ? " data-play" : ""} aria-labelledby="${id}-cap">
  <header><span class="live">Sample call · business hours</span><span>Synthetic patient</span></header>
  <ol class="transcript">
${callLines
  .map(
    ([cls, who, text], i) =>
      `    <li class="${cls}">${who ? `<span class="who">${who}</span>` : `<span class="visually-hidden">System note: </span>`}${esc(text)}</li>`
  )
  .join("\n")}
  </ol>
  <figcaption class="sample-note" id="${id}-cap">Illustrative transcript with an invented patient and provider. The assistant only shares or changes anything after the caller is verified, and reads back every change before making it.</figcaption>
</figure>`;

// ---------------------------------------------------------------- proof cards
export const proofCards = (keys = ["wrongPatient", "liveSandbox", "autoFile", "latency"]) => `<div class="proof">
${keys
  .map((k) => {
    const c = CLAIMS[k];
    return `  <div class="stat"><span class="label">${c.label}</span><span class="num">${c.num}</span><p class="what">${esc(c.what)}</p><p class="how">${esc(c.how)}</p></div>`;
  })
  .join("\n")}
</div>`;

// ---------------------------------------------------------------- what we need from the practice
// Drawbridge works from the practice's Veradigm EHR document queue: no fax forwarding, no lab access, no IT work.
// It is the same for every practice, whoever runs its IT.
export const IT_NEEDS = [
  ["clipboard", "A five-minute setup sheet", "Your practice manager answers 15 questions about your rules and how documents flow today: who reviews results, which documents always go to a person, your booking rules."],
  ["key", "A signed BAA and Veradigm® access", "You sign our business associate agreement and authorize Veradigm® to give Drawbridge access to your Veradigm® EHR and Veradigm® Practice Management."],
];

export const itNeedsBlock = ({ title = "What we need from you", lede = "Two things, and we handle the rest.", headingId = "it-needs-title", tag = "h3" } = {}) => `<div class="it-needs" role="region" aria-labelledby="${headingId}">
  <${tag} id="${headingId}">${title}</${tag}>
  <p>${lede}</p>
  <ul class="it-list">
${IT_NEEDS.map(([ic, t, d]) => `    <li><span class="icon">${icon(ic)}</span><span><strong>${t}</strong>${d}</span></li>`).join("\n")}
  </ul>
  <p class="small mb-0">Drawbridge works from the documents already in your Veradigm® EHR document queue, so your fax lines, lab feeds and staff workflow stay exactly as they are. The work is simply done for you. Filed results and review tasks appear in Veradigm® EHR, where your team already works. For the phone assistant, we set up the calls you choose (after hours, overflow or all) with your phone provider, and your number stays the same.</p>
</div>`;

// ---------------------------------------------------------------- CTA band
export const ctaBand = ({
  title = "Are you ready for the future of your practice?",
  text = "See Drawbridge in a 20-minute walkthrough with a MOATiT engineer: a fax filed live on synthetic data, a sample call, and what your shadow week would look like. No pressure, no patient data needed.",
} = {}) => `<section class="section-tight" aria-labelledby="cta-title">
  <div class="wrap">
    <div class="cta-band">
      <div>
        <h2 id="cta-title">${title}</h2>
        <p>${text}</p>
      </div>
      <div>
        <div class="btn-row">${btnPrimary()}${btnSecondary("Call (208) 900-6628", "tel:+12089006628")}</div>
        <div class="contact-lines mt-1"><span>Toll-free <a href="tel:+18555506628">(855) 550-6628</a> · ${emailLink()}</span></div>
      </div>
    </div>
  </div>
</section>`;

// ---------------------------------------------------------------- FAQ data (shared by home + FAQ page + schema)
export const FAQS = [
  {
    q: "What does Drawbridge do?",
    a: "Drawbridge is MOATiT's AI technology for healthcare practices. It reads incoming faxes and lab results and files them to the right patient's chart, and its phone assistant answers the calls you route to it, day and night: it verifies callers, handles appointments and takes messages for your staff. Staff tools such as reminder calls, a morning huddle brief and an on-call notebook come with it.",
    home: true,
  },
  {
    q: "Which EHR and practice-management systems does it work with?",
    a: "Drawbridge integrates with Veradigm® EHR and Veradigm® Practice Management. It files documents into the chart and books appointments in the schedule your staff already use. Veradigm® is a trademark of Veradigm Inc. or its affiliates; naming Veradigm® describes compatibility only and does not imply endorsement by Veradigm.",
    home: true,
  },
  {
    q: "How does it make sure a lab result goes to the right patient?",
    a: "It needs two identifiers, full name and date of birth, matching exactly one patient. If the document also shows the last four of the SSN or an address, those must agree too. A look-alike patient, a conflicting identifier, a hard-to-read page or more than one patient on a page sends the document to a person instead. In our synthetic testing, Drawbridge made zero wrong-patient filings.",
    home: true,
  },
  {
    q: "What happens when a document needs a person?",
    a: "It goes to your staff review queue with the reason (for example, 'address on the document is different'), already read and with its best suggestion, so staff can file or correct it with one click. On the phone, the assistant offers a transfer during business hours or takes a message.",
    home: true,
  },
  {
    q: "Are some documents always handled by a person?",
    a: "Yes. By default, records requests, prior authorizations, refill requests and referrals always go to your staff, even when the patient match is perfect. Your practice can change that list. Critical lab results are filed with a High-priority review task marked CRITICAL and a note that a phone call is required; your staff make that call.",
  },
  {
    q: "Can the phone assistant give medical advice?",
    a: "No. It never gives medical advice. If a caller describes an emergency, it tells them to hang up and dial 911. It can tell callers about upcoming visits, open times, balances and insurance on file, and read their medication and allergy lists and recent results as recorded, but only after it has verified who is calling. It never interprets results or medications.",
    home: true,
  },
  {
    q: "How does the phone assistant verify callers?",
    a: "It asks for first name, last name and date of birth, and these must match exactly one patient. This is enforced by Drawbridge's server, not just by the assistant's instructions: until a caller is verified on that call, the system refuses to return or change any patient record. Each call can verify at most two people (for example, a parent and a child), and repeated lookups are capped and logged.",
  },
  {
    q: "Does Drawbridge replace our staff or our current systems?",
    a: "No. Drawbridge works alongside your current system and your staff and multiplies what they can do. It works alongside Veradigm® EHR, Veradigm® Practice Management and your phones, and takes on the repetitive indexing and routine calls. Your team spends more of its time on patients and care, and the practice has room to grow without the front desk becoming the bottleneck.",
    home: true,
  },
  {
    q: "What does going live look like?",
    a: "Four steps. (1) Your practice manager answers a 15-question setup sheet about your rules and how documents flow today, in about five minutes. (2) You sign our BAA and authorize Veradigm® to give Drawbridge access. (3) Drawbridge runs in shadow mode for one week: your staff keep working as usual while Drawbridge records what it would have done. We compare the two and align Drawbridge to the way your practice works. (4) We switch filing on step by step, starting with staff-click filing. Your workflow stays exactly as it is throughout, and you can switch Drawbridge off at any time.",
    home: true,
  },
  {
    q: "What do you need from our practice?",
    a: "Two things: about five minutes for the setup sheet, and your signature on the BAA with the Veradigm® authorization. Drawbridge works from the documents already in your Veradigm® EHR document queue, so your fax lines, lab feeds and staff computers stay exactly as they are, whoever runs your IT. For the phone assistant, we set up the calls you choose with your phone provider, and your number stays the same.",
    home: true,
  },
  {
    q: "Is Drawbridge HIPAA compliant? Will you sign a BAA?",
    a: "MOATiT signs a business associate agreement with every practice before any patient data flows. Drawbridge was built around the HIPAA Security Rule: multi-factor sign-in for every user, a tamper-evident audit log kept six years, minimum-necessary access and per-call caller verification. Encryption in transit and at rest and US hosting are required for every production deployment before patient data flows. There is no official HIPAA 'certification', so we publish our controls on the Security page instead.",
  },
  {
    q: "Is our patient data used to train AI models?",
    a: "Drawbridge's own software does not train AI models on your practice's data: documents are read by OCR running on MOATiT's own servers, and the decision of which chart a document goes to is made by rules you can audit. For calls, written confirmation that the voice platform the assistant runs on does not train on your data is in progress.",
  },
  {
    q: "Where is our data stored, and for how long?",
    a: "In the United States, on MOATiT's cloud infrastructure and in MOATiT's data center, single-tenant per practice: required for every production deployment before patient data flows. The chart copy in your EHR is the record: Drawbridge deletes the original fax 30 days after filing and patient details on its intake records after 90 days, keeps call records 30 days, and keeps the audit log for six years.",
  },
  {
    q: "How much does Drawbridge cost?",
    a: "Pricing depends on your document and call volume and which parts you use. Contact us for a quote: call (208) 900-6628 or (855) 550-6628, or email questions@moatit.com. Setup, the shadow week and support are part of every plan.",
    home: true,
  },
  {
    q: "Who is MOATiT?",
    a: "MOATiT, LLC is a technology company founded in Pocatello, Idaho, in 2013. It provides managed IT, cybersecurity, business phone systems, online fax and EHR hosting to businesses and medical practices across Idaho, Utah and Wyoming. Drawbridge is MOATiT's AI technology and product for healthcare practices, and it works the same whether your IT is run by your own team, another provider or MOATiT.",
  },
  {
    q: "Is Drawbridge certified by Veradigm?",
    a: "Not yet. MOATiT's Veradigm Connect certification for Drawbridge is in progress. We will update this page when it is complete.",
  },
];

export const faqList = (items) => `<div class="faq">
${items
  .map(
    (f) => `  <details>
    <summary>${esc(f.q)}</summary>
    <div class="answer"><p>${esc(f.a)}</p></div>
  </details>`
  )
  .join("\n")}
</div>`;

export const faqSchema = (items) => ({
  "@type": "FAQPage",
  mainEntity: items.map((f) => ({
    "@type": "Question",
    name: f.q,
    acceptedAnswer: { "@type": "Answer", text: f.a },
  })),
});

// ---------------------------------------------------------------- ROI calculator
const roiField = (id, label, value, unit, hint, { min = 0, max = 100000, step = 1 } = {}) => `<div class="field">
  <label for="${id}">${label}</label>
  <div class="input-row"><input id="${id}" name="${id}" type="number" inputmode="decimal" value="${value}" min="${min}" max="${max}" step="${step}" aria-describedby="${id}-h"><span class="unit">${unit}</span></div>
  <span class="hint" id="${id}-h">${hint}</span>
</div>`;

// Server-render the default estimate so the page never shows "0" without JavaScript.
const ROI_DEFAULTS = (() => {
  const d = { docs: 60, idx: 3, auto: 0.45, assist: 1, calls: 120, handled: 0.25, mins: 4, after: 15, rate: 24, days: 21 };
  const fax = ((d.docs * d.auto * d.idx + d.docs * (1 - d.auto) * d.assist) * d.days) / 60;
  const phone = (d.calls * d.handled * d.mins * d.days) / 60;
  const total = fax + phone;
  const f0 = (n) => Math.round(n).toLocaleString("en-US");
  return { fax: f0(fax), phone: f0(phone), total: f0(total), fte: (total / 160).toFixed(2), month: "$" + f0(total * d.rate), year: "$" + f0(total * d.rate * 12), after: f0(d.after * 30) };
})();

export const roiCalculator = () => `<div class="roi">
  <form id="roi-form" novalidate aria-label="Time savings calculator">
    <fieldset>
      <legend>Faxes &amp; lab results</legend>
      ${roiField("r-docs", "Documents received per day", 60, "per day", "Faxes, lab results, consult letters and other documents your staff index today.")}
      ${roiField("r-idx", "Minutes to index one by hand", 3, "minutes", "Open, read, find the patient, pick the category, file, notify. Assumption: 3 minutes.", { step: 0.5 })}
      ${roiField("r-auto", "Share Drawbridge files on its own", 45, "%", "Synthetic test default (about 43–53% in our tests). Your shadow week measures your real rate.", { max: 100 })}
      ${roiField("r-assist", "Minutes saved on each document staff review", 1, "minutes", "The rest arrive already read and matched, for one-click filing. Assumption: 1 minute.", { step: 0.5 })}
    </fieldset>
    <fieldset>
      <legend>Phone line</legend>
      ${roiField("r-calls", "Calls to the clinic per day", 120, "per day", "All inbound calls to the main line during business hours.")}
      ${roiField("r-handled", "Share the assistant completes without staff", 25, "%", "Verification, visits, open times, booking, balances, messages. Assumption: 25%; we have no production data yet.", { max: 100 })}
      ${roiField("r-mins", "Average staff minutes per call", 4, "minutes", "Including hold, lookup and notes. Assumption: 4 minutes.", { step: 0.5 })}
      ${roiField("r-after", "Calls after hours per day", 15, "per day", "Counted as calls answered, not as staff time.")}
    </fieldset>
    <fieldset>
      <legend>Your practice</legend>
      ${roiField("r-rate", "Loaded staff cost per hour", 24, "USD", "Wage plus benefits and taxes. Assumption: $24/hour.", { step: 0.5 })}
      ${roiField("r-days", "Working days per month", 21, "days", "", { max: 31 })}
    </fieldset>
    <button class="btn btn-secondary visually-hidden" type="submit">Recalculate</button>
  </form>
  <aside class="roi-out" aria-labelledby="roi-out-title">
    <h2 id="roi-out-title" class="h3like">Your estimate</h2>
    <div class="roi-big" aria-live="polite"><span id="o-total">${ROI_DEFAULTS.total}</span> hours<small>of staff time back each month</small></div>
    <dl class="roi-rows">
      <div><dt>From fax &amp; lab intake</dt><dd id="o-fax">${ROI_DEFAULTS.fax} h</dd></div>
      <div><dt>From the phone assistant</dt><dd id="o-phone">${ROI_DEFAULTS.phone} h</dd></div>
      <div><dt>Full-time equivalents (160 h/month)</dt><dd id="o-fte">${ROI_DEFAULTS.fte}</dd></div>
      <div><dt>Value per month</dt><dd id="o-month">${ROI_DEFAULTS.month}</dd></div>
      <div><dt>Value per year</dt><dd id="o-year">${ROI_DEFAULTS.year}</dd></div>
      <div><dt>After-hours calls answered per month</dt><dd id="o-after">${ROI_DEFAULTS.after}</dd></div>
    </dl>
    <div class="formula">
      <p>Fax hours = (docs × auto% × index min + docs × (1 − auto%) × saved min) × days ÷ 60</p>
      <p>Phone hours = calls × completed% × min per call × days ÷ 60</p>
      <p>Value = hours × cost per hour · FTE = hours ÷ 160 · After-hours = calls × 30</p>
    </div>
    <p class="disclaimer">An estimate, not a quote or a guarantee. Defaults are assumptions you can change; the only default from Drawbridge testing is the auto-file share, and it comes from synthetic documents. Nothing you type here leaves your browser.</p>
    <div class="btn-row mt-1">${btnPrimary("Book a walkthrough to check these numbers")}</div>
  </aside>
</div>`;
