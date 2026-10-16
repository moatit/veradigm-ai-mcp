import { CTA, COMPAT_LINE } from "../site.mjs";
import { pageHero } from "../layout.mjs";
import { icon, btnPrimary, btnSecondary, picture, gateCard, reviewCard, callCard, proofCards, ctaBand, faqList, faqSchema, FAQS, itNeedsBlock } from "../partials.mjs";

const faxFaqs = FAQS.filter((f) => /right patient|isn't sure|always handled|going live|IT team|train AI|stored/i.test(f.q));
const phoneFaqs = FAQS.filter((f) => /medical advice|verify callers|isn't sure|IT team|HIPAA/i.test(f.q));

export const fax = {
  path: "/fax-lab-intake/",
  title: "Fax & lab-result intake: filed to the right chart",
  description:
    "Drawbridge reads incoming faxes and lab results with local OCR, matches each to exactly one patient on full name and date of birth, files it to your Veradigm® EHR category and sends a review task to the ordering provider.",
  app: true,
  crumbs: [{ name: "Fax & lab intake", href: "/fax-lab-intake/" }],
  schema: [faqSchema(faxFaqs)],
  body: `${pageHero({
    eyebrow: "Fax &amp; lab-result intake",
    title: 'The fax pile, <span class="accent-i">filed</span>, to the right chart.',
    lede: "Drawbridge reads every fax, emailed result and lab drop file on MOATiT's own servers, matches it to exactly one patient, files it to the right category in Veradigm® EHR and tells the right provider. Anything it isn't sure of goes to your staff, already read, with the reason.",
    crumbs: [{ name: "Fax & lab intake", href: "/fax-lab-intake/" }],
    actions: btnPrimary() + btnSecondary("See a fax get filed", "#sample-filing"),
  })}
<section class="section" aria-labelledby="flow-title">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">How a document crosses</p>
      <h2 id="flow-title">Six steps, every one logged.</h2>
    </div>
    <ol class="flow cols-6">
      <li><h3>Receive</h3><p>From your fax line, a lab's drop folder (PDF, TIFF, PNG, JPEG), emailed results or a staff upload. Duplicates are caught.</p></li>
      <li><h3>Read</h3><p>OCR on MOATiT's servers, page by page: patient name, date of birth, MRN, sender, document type, dates and abnormal flags.</p></li>
      <li><h3>Match</h3><p>Full name + date of birth must match exactly one patient. SSN last 4 or address, when printed, must agree.</p></li>
      <li><h3>Categorize</h3><p>Mapped to your EHR's own document categories, for example lab results to "Lab Results".</p></li>
      <li><h3>File</h3><p>The original document is filed to the patient's chart, unaltered, with clinical date and a clear title.</p></li>
      <li><h3>Notify</h3><p>A review task linked to the document goes to the ordering provider, or the reviewer you choose.</p></li>
    </ol>
  </div>
</section>
<section class="section on-white" id="sample-filing" aria-labelledby="sample-title">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">Samples</p>
      <h2 id="sample-title">Filed when sure. <span class="accent-i">Handed over when not.</span></h2>
    </div>
    <div class="demo-grid">
      <div class="demo-col">${gateCard("fax-gate")}<p class="mt-1"><button class="btn-link btn-replay" type="button" data-replay="fax-gate">Replay the filing</button></p></div>
      <div class="demo-col">${reviewCard("fax-review")}</div>
    </div>
  </div>
</section>
<section class="section" aria-labelledby="features-title">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">What it handles</p>
      <h2 id="features-title">Built around how practices actually receive results.</h2>
    </div>
    <div class="grid grid-3">
      <div class="card"><div class="icon">${icon("user")}</div><h3>Patient matching that never guesses</h3><p>Two identifiers (full name and date of birth) matching exactly one patient. A conflicting MRN, phone, SSN last 4 or address sends the document to staff, even when everything else agrees. Twins and look-alike names are checked for on every decision.</p></div>
      <div class="card"><div class="icon">${icon("split")}</div><h3>Daily lab batches, split by patient</h3><p>One file with many patients' results is read page by page and cut into one document per patient, each matched and filed on its own. Any doubt about a page, and the whole file goes to staff.</p></div>
      <div class="card"><div class="icon">${icon("alert")}</div><h3>Critical results, flagged</h3><p>A lab's critical flags (HH, LL, CRITICAL, PANIC) create a High-priority review task marked CRITICAL, with a phone call recorded as required. Drawbridge never places that call itself.</p></div>
      <div class="card"><div class="icon">${icon("users")}</div><h3>Review task to the ordering provider</h3><p>Drawbridge reads the ordering provider from the document and matches them to one of your EHR users. If it can't, the task goes to your designated reviewer.</p></div>
      <div class="card"><div class="icon">${icon("calendar")}</div><h3>Same-day appointment rule</h3><p>If your providers see same-day results at the visit, results collected on an appointment day can be filed without an extra task. Critical results always notify.</p></div>
      <div class="card"><div class="icon">${icon("clipboard")}</div><h3>Always to a person</h3><p>Records requests, prior authorizations, refill requests and referrals go to staff by default, even with a perfect match. Your practice decides the list.</p></div>
      <div class="card"><div class="icon">${icon("list")}</div><h3>A staff queue that saves clicks</h3><p>Everything that needs a person arrives already read, with the suggested patient and the reason. File it or correct it with one click.</p></div>
      <div class="card"><div class="icon">${icon("eye")}</div><h3>Shadow week before go-live</h3><p>For one week Drawbridge files nothing. It records what it would have done and compares it with where your staff filed each document.</p></div>
      <div class="card"><div class="icon">${icon("lock")}</div><h3>Documents stay with MOATiT</h3><p>Faxes are received and read on MOATiT's infrastructure. No consumer cloud folders. Originals are deleted 30 days after filing; the chart copy is the record.</p></div>
    </div>
  </div>
</section>
<section class="section on-paper-2" aria-labelledby="fax-proof-title">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">Results so far</p>
      <h2 id="fax-proof-title">Tested against thousands of synthetic documents.</h2>
      <p class="lede">Six document layouts, clean and poor-quality faxes, twins, namesakes, multi-patient batches. Real faxes will vary, which is why every practice starts with a shadow week.</p>
    </div>
    ${proofCards(["wrongPatient", "liveSandbox", "autoFile"])}
  </div>
</section>
<section class="section" aria-labelledby="settings-title">
  <div class="wrap split">
    <div>
      <p class="eyebrow">Your rules</p>
      <h2 id="settings-title">Your practice sets the policy. <span class="accent-i">We set it up.</span></h2>
      <p class="lede">A five-minute setup sheet for your practice manager. Each answer becomes a setting, so your clinic's rules are your own.</p>
    </div>
    <ul class="checks">
      <li><span>Who reviews results: the ordering provider, or a reviewer or pool</span></li>
      <li><span>Who is told about critical results</span></li>
      <li><span>Which documents always go to a person</span></li>
      <li><span>Your category names (for example "Lab Results")</span></li>
      <li><span>Which senders send daily batches, and which always go to staff</span></li>
      <li><span>Whether same-day results need a task</span></li>
      <li><span>Filing mode: watch only, staff click to file, or automatic for proven senders</span></li>
    </ul>
  </div>
  <div class="wrap mt-3">${itNeedsBlock({ headingId: "fax-it-needs" })}</div>
</section>
<section class="section on-white" aria-labelledby="fax-faq-title">
  <div class="wrap narrow"><h2 id="fax-faq-title">Questions about intake</h2>${faqList(faxFaqs)}</div>
</section>
${ctaBand({ title: "Watch a fax get filed, live.", text: "In a 20-minute walkthrough we drop a synthetic lab fax and you watch it read, matched, filed and assigned, then we send one that should go to a person." })}`,
};

export const phone = {
  path: "/phone-assistant/",
  title: "AI phone assistant for medical practices, 24/7",
  description:
    "Drawbridge's AI phone assistant answers your clinic line 24/7. It verifies callers, shares upcoming visits and open times, books, reschedules, cancels and confirms with read-back, and takes messages. No medical advice; 911 for emergencies.",
  app: true,
  crumbs: [{ name: "Phone assistant", href: "/phone-assistant/" }],
  schema: [faqSchema(phoneFaqs)],
  body: `${pageHero({
    eyebrow: "AI phone assistant",
    title: 'Every call answered. <span class="accent-i">Every caller verified.</span>',
    lede: "Drawbridge answers your clinic line day and night. It checks who is calling before it shares anything, handles the routine requests your front desk takes all day, and passes everything else to a person, so your staff can focus on the patients in front of them.",
    crumbs: [{ name: "Phone assistant", href: "/phone-assistant/" }],
    actions: btnPrimary() + btnSecondary("See a sample call", "#sample-call"),
  })}
<section class="section" id="sample-call" aria-labelledby="call-title">
  <div class="wrap split">
    <div>
      <p class="eyebrow">A sample call</p>
      <h2 id="call-title">Verified, offered, read back, booked.</h2>
      <p class="lede">The assistant asks for name and date of birth first. Drawbridge's server won't release or change any record until they match exactly one patient on that call.</p>
      <ul class="checks">
        <li><span>Upcoming visits and open appointment times</span></li>
        <li><span>Book, reschedule, cancel and confirm, always with a read-back and a yes</span></li>
        <li><span>Balance and insurance on file</span></li>
        <li><span>Medication and allergy lists on file (read only; no advice)</span></li>
        <li><span>Messages for staff, filed as tasks in your EHR</span></li>
        <li><span>Transfer to staff whenever a caller asks</span></li>
      </ul>
      <p><button class="btn-link btn-replay" type="button" data-replay="phone-call">Replay the call</button></p>
    </div>
    ${callCard("phone-call")}
  </div>
</section>
<section class="section on-night blueprint" aria-labelledby="safety-title">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">Safety on the line</p>
      <h2 id="safety-title">Friendly on the phone. <span class="accent-i">Strict on the server.</span></h2>
    </div>
    <div class="grid grid-3">
      <div class="card"><div class="icon">${icon("key")}</div><h3>Identity before information</h3><p>First name, last name and date of birth must match exactly one patient. The server refuses any record request for someone not verified on that call, and logs it.</p></div>
      <div class="card"><div class="icon">${icon("users")}</div><h3>Family calls, within limits</h3><p>A parent can handle a child's visit: each person is verified on their own. At most two people per call, and lookups are capped to stop fishing.</p></div>
      <div class="card"><div class="icon">${icon("alert")}</div><h3>911 and no medical advice</h3><p>Emergencies hear one line: "If this is an emergency, please hang up and call 911 now." The assistant never interprets results, symptoms or medications.</p></div>
      <div class="card"><div class="icon">${icon("refresh")}</div><h3>Read-back on every change</h3><p>Nothing is booked, moved or cancelled until the caller hears the change and says yes. A reschedule keeps the old visit until the new one is booked.</p></div>
      <div class="card"><div class="icon">${icon("eye")}</div><h3>Recordings with PII redacted</h3><p>Call recordings and transcripts have personal details redacted after the call and are kept 30 days.</p></div>
      <div class="card"><div class="icon">${icon("server")}</div><h3>Honest when systems are down</h3><p>If the EHR connection drops, callers hear so right away and can leave a message or be transferred. Your help desk is alerted automatically.</p></div>
    </div>
  </div>
</section>
<section class="section" aria-labelledby="after-title">
  <div class="wrap split reverse">
    <div>
      <p class="eyebrow">After hours</p>
      <h2 id="after-title">The night line, <span class="accent-i">with a notebook.</span></h2>
      <p class="lede">After hours, the assistant greets callers as your after-hours line, verifies them and takes the message in their own words.</p>
      <ul class="checks">
        <li><span><strong>Urgent:</strong> transferred to your on-call provider with a short brief: who is calling and why, plus the medication, allergy and problem lists, latest results and last and next visit</span></li>
        <li><span><strong>Routine:</strong> filed as a staff task for the morning</span></li>
        <li><span><strong>On-call notebook:</strong> every after-hours call in one place for the on-call provider and the morning team</span></li>
      </ul>
    </div>
    <div class="card">
      <p class="eyebrow">Measured in testing</p>
      ${proofCards(["latency"])}
      <p class="small mt-1 mb-0">The assistant says a short "one moment" line while it looks something up, so callers aren't left in silence.</p>
    </div>
  </div>
</section>
<section class="section on-white" aria-labelledby="ph-faq-title">
  <div class="wrap narrow"><h2 id="ph-faq-title">Questions about the phone assistant</h2>${faqList(phoneFaqs)}</div>
</section>
${ctaBand({ title: "Hear it on a call.", text: "In a 20-minute walkthrough we call a test line together with a synthetic patient: verify, check visits, reschedule, leave a message. Then we talk through your hours, transfers and on-call routing." })}`,
};

export const platform = {
  path: "/platform/",
  title: "Staff tools: reminders, huddle brief, on-call notebook, audit",
  description:
    "Beyond fax intake and the phone assistant, Drawbridge gives your staff reminder and recall calls, a morning huddle brief, pre-visit checks, an on-call notebook, system status alerts, a tamper-evident audit log and patient access reports.",
  crumbs: [{ name: "Staff tools", href: "/platform/" }],
  body: `${pageHero({
    eyebrow: "Staff tools",
    title: 'One sign-in for <span class="accent-i">the whole front desk.</span>',
    lede: "Drawbridge's staff app puts calls, documents, outreach and the day's schedule in one place, with multi-factor sign-in and every action logged.",
    crumbs: [{ name: "Staff tools", href: "/platform/" }],
    actions: btnPrimary(),
  })}
<section class="section" aria-labelledby="tools-title">
  <div class="wrap">
    <h2 id="tools-title" class="visually-hidden">Tools</h2>
    <div class="grid grid-3">
      <div class="card"><div class="icon">${icon("bell")}</div><h3>Reminder &amp; recall calls</h3><p>Appointment reminder calls, no-show follow-up and recall outreach. Calls go out only after a staff click or on a schedule you set, and patients can opt out.</p></div>
      <div class="card"><div class="icon">${icon("sun")}</div><h3>Morning huddle brief</h3><p>The day's schedule summarized for the team huddle, so everyone starts with the same picture.</p></div>
      <div class="card"><div class="icon">${icon("clipboard")}</div><h3>Pre-visit check</h3><p>A quick check of each upcoming visit so gaps are found before the patient arrives, not at the desk.</p></div>
      <div class="card"><div class="icon">${icon("moon")}</div><h3>On-call notebook</h3><p>Every after-hours call and message, with the brief the on-call provider heard, ready for the morning team.</p></div>
      <div class="card"><div class="icon">${icon("chat")}</div><h3>Staff assistant</h3><p>Ask in plain words, such as "who has an opening Tuesday afternoon?", and get the answer from the live schedule.</p></div>
      <div class="card"><div class="icon">${icon("list")}</div><h3>Intake review queue</h3><p>Documents that need a person, already read, with the suggested patient and the reason. One click to file or correct.</p></div>
      <div class="card"><div class="icon">${icon("gauge")}</div><h3>System status &amp; help-desk alerts</h3><p>A status banner on every staff screen and automatic alerts to your help desk when the EHR connection goes down and when it recovers, with the number of messages taken in between.</p></div>
      <div class="card"><div class="icon">${icon("shield")}</div><h3>Audit log</h3><p>Every tool call, staff view and change is recorded in a tamper-evident, hash-chained log kept for six years. No clinical content in the log, only IDs and outcomes.</p></div>
      <div class="card"><div class="icon">${icon("doc")}</div><h3>Patient access reports</h3><p>Administrators can report every access to one patient's records, or everything one staff user did, for any date range: the basis for an accounting of disclosures.</p></div>
    </div>
  </div>
</section>
<section class="section on-white" aria-labelledby="signin-title">
  <div class="wrap split">
    <div>
      <p class="eyebrow">Access</p>
      <h2 id="signin-title">Named logins. Two factors. <span class="accent-i">No shared passwords.</span></h2>
    </div>
    <ul class="checks">
      <li><span>A named login for every staff member, with roles for staff and the privacy officer</span></li>
      <li><span>Authenticator-app codes required for every sign-in</span></li>
      <li><span>Passwords expire every 90 days; the last five can't be reused</span></li>
      <li><span>Lockout after repeated failed sign-ins</span></li>
      <li><span>Automatic sign-out after 15 minutes idle, and after 12 hours regardless</span></li>
      <li><span>A sealed emergency login that is time-limited and flagged in the log</span></li>
    </ul>
  </div>
</section>
${ctaBand()}`,
};
