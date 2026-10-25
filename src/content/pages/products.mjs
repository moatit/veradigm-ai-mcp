import { CTA, COMPAT_LINE } from "../site.mjs";
import { pageHero } from "../layout.mjs";
import { icon, btnPrimary, btnSecondary, liveCallButton, liveCallDialog, gateCard, reviewCard, callCard, proofCards, ctaBand, faqList, faqSchema, FAQS, itNeedsBlock } from "../partials.mjs";

const faxFaqs = FAQS.filter((f) => /right patient|needs a person|always handled|going live|from our practice|train AI|stored/i.test(f.q));
const phoneFaqs = FAQS.filter((f) => /medical advice|verify callers|needs a person|from our practice|HIPAA/i.test(f.q));

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
    lede: "Drawbridge reads every incoming fax and lab file on MOATiT's own servers, matches it to exactly one patient, files it to the right category in Veradigm® EHR and tells the right provider. Anything that needs judgment goes to your Veradigm® EHR document queue for staff, already read, with the reason.",
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
      <li><h3>Receive</h3><p>Faxes and lab files come to Drawbridge first, through the fax routing and lab file drop MOATiT sets up with you. Duplicates are caught.</p></li>
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
      <h2 id="sample-title">Clear matches filed. <span class="accent-i">Close calls handed over.</span></h2>
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
      <div class="card"><div class="icon">${icon("user")}</div><h3>Patient matching on two identifiers</h3><p>Two identifiers (full name and date of birth) matching exactly one patient. A conflicting MRN, phone, SSN last 4 or address sends the document to staff, even when everything else agrees. Twins and look-alike names are checked for on every decision.</p></div>
      <div class="card"><div class="icon">${icon("split")}</div><h3>Daily lab batches, split by patient</h3><p>One file with many patients' results is read page by page and cut into one document per patient, each matched and filed on its own. If any page needs a second look, the whole file goes to staff.</p></div>
      <div class="card"><div class="icon">${icon("alert")}</div><h3>Critical results, flagged</h3><p>A lab's critical flags (HH, LL, CRITICAL, PANIC) create a High-priority review task marked CRITICAL, with a phone call recorded as required. Your staff make that call.</p></div>
      <div class="card"><div class="icon">${icon("users")}</div><h3>Review task to the ordering provider</h3><p>Drawbridge reads the ordering provider from the document and matches them to one of your EHR users. If it can't, the task goes to your designated reviewer.</p></div>
      <div class="card"><div class="icon">${icon("calendar")}</div><h3>Same-day appointment rule</h3><p>If your providers see same-day results at the visit, results collected on an appointment day can be filed without an extra task. Critical results always notify.</p></div>
      <div class="card"><div class="icon">${icon("clipboard")}</div><h3>Always to a person</h3><p>Records requests, prior authorizations, refill requests and referrals go to staff by default, even with a perfect match. Your practice decides the list.</p></div>
      <div class="card"><div class="icon">${icon("list")}</div><h3>A staff queue that saves clicks</h3><p>Everything that needs a person arrives already read, with the suggested patient and the reason. File it or correct it with one click.</p></div>
      <div class="card"><div class="icon">${icon("eye")}</div><h3>Shadow week before go-live</h3><p>For one week Drawbridge files nothing. It records what it would have done and compares it with where your staff filed each document.</p></div>
      <div class="card"><div class="icon">${icon("lock")}</div><h3>Documents stay with MOATiT</h3><p>Documents are read on MOATiT's own infrastructure. Drawbridge's working copies are deleted 30 days after filing; the chart copy is the record.</p></div>
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
  title: "AI phone assistant for medical practices, day and night",
  description:
    "Drawbridge's AI phone assistant answers the calls you route to it, day and night. It verifies callers, shares upcoming visits and open times, books, reschedules, cancels and confirms with read-back, and takes messages. No medical advice; 911 for emergencies.",
  app: true,
  crumbs: [{ name: "Phone assistant", href: "/phone-assistant/" }],
  schema: [faqSchema(phoneFaqs)],
  body: `${pageHero({
    eyebrow: "AI phone assistant",
    title: 'Calls answered. <span class="accent-i">Every caller verified.</span>',
    lede: "Drawbridge answers the calls you route to it, day and night. It checks who is calling before it shares anything, handles the routine requests your front desk takes all day, and passes everything else to a person, so your staff can focus on the patients in front of them.",
    crumbs: [{ name: "Phone assistant", href: "/phone-assistant/" }],
    actions: btnPrimary() + liveCallButton(),
  })}
<section class="section" id="sample-call" aria-labelledby="call-title">
  <div class="wrap split">
    <div>
      <p class="eyebrow">A sample call</p>
      <h2 id="call-title">Verified, offered, read back, booked.</h2>
      <p class="lede">The assistant asks for name and date of birth first. Drawbridge's server releases or changes a record only after they match exactly one patient on that call.</p>
      <ul class="checks">
        <li><span>Upcoming visits and open appointment times</span></li>
        <li><span>Book, reschedule, cancel and confirm, always with a read-back and a yes</span></li>
        <li><span>Balance and insurance on file</span></li>
        <li><span>Medication and allergy lists on file (read only; no advice)</span></li>
        <li><span>Recent results, as recorded (read only; never interpreted)</span></li>
        <li><span>Messages for staff, filed as tasks in your EHR</span></li>
        <li><span>Transfer to staff whenever a caller asks</span></li>
      </ul>
      <div class="btn-row">${liveCallButton("btn btn-primary")}<button class="btn-link btn-replay" type="button" data-replay="phone-call">Replay the call</button></div>
    </div>
    ${callCard("phone-call")}
  </div>
</section>
${liveCallDialog()}
<section class="section on-night blueprint" aria-labelledby="safety-title">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">Safety on the line</p>
      <h2 id="safety-title">Friendly on the phone. <span class="accent-i">Strict on the server.</span></h2>
    </div>
    <div class="grid grid-3">
      <div class="card"><div class="icon">${icon("key")}</div><h3>Identity before information</h3><p>First name, last name and date of birth must match exactly one patient. The server answers record requests only for people verified on that call, and logs every attempt.</p></div>
      <div class="card"><div class="icon">${icon("users")}</div><h3>Family calls, within limits</h3><p>A parent can handle a child's visit: each person is verified on their own. At most two people per call, and lookups are capped to stop fishing.</p></div>
      <div class="card"><div class="icon">${icon("alert")}</div><h3>911 for emergencies, clinicians for clinical questions</h3><p>Emergencies hear one line: "If this is an emergency, please hang up and call 911 now." The assistant never interprets results, symptoms or medications and never advises; clinical questions go to your clinicians.</p></div>
      <div class="card"><div class="icon">${icon("refresh")}</div><h3>Read-back on every change</h3><p>Every booking, move and cancellation happens after the caller hears the change and says yes. A reschedule keeps the old visit until the new one is booked.</p></div>
      <div class="card"><div class="icon">${icon("eye")}</div><h3>Recordings with PII redacted</h3><p>Call recordings and transcripts have personal details redacted after the call and are kept 30 days.</p></div>
      <div class="card"><div class="icon">${icon("server")}</div><h3>Honest when systems are down</h3><p>If the EHR connection drops, callers hear so right away and can leave a message or be transferred. MOATiT's help desk is alerted automatically.</p></div>
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
        <li><span><strong>Urgent:</strong> flagged for your on-call provider in the on-call notebook, with a short brief (who is calling and why, plus the medication, allergy and problem lists, latest results and last and next visit), and the caller is told how to reach them. Emergencies are directed to 911.</span></li>
        <li><span><strong>In progress:</strong> live transfer to your on-call provider, with the brief</span></li>
        <li><span><strong>Routine:</strong> filed as a staff task for the morning</span></li>
        <li><span><strong>On-call notebook:</strong> every after-hours call in one place for the on-call provider and the morning team</span></li>
      </ul>
    </div>
    <div class="card">
      <p class="eyebrow">Measured in testing</p>
      ${proofCards(["latency"])}
    </div>
  </div>
</section>
<section class="section on-white" aria-labelledby="ph-faq-title">
  <div class="wrap narrow"><h2 id="ph-faq-title">Questions about the phone assistant</h2>${faqList(phoneFaqs)}</div>
</section>
${ctaBand({ title: "Hear it on a call.", text: "In a 20-minute walkthrough we call a test line together with a synthetic patient: verify, check visits, reschedule, leave a message. Then we talk through your hours, transfers and on-call routing." })}`,
};

const confirmFaqs = FAQS.filter((f) => /Call & Confirm/.test(f.q));

export const callConfirm = {
  path: "/call-and-confirm/",
  title: "Call & Confirm: appointment confirmation calls for medical practices",
  description:
    "Drawbridge Call & Confirm calls patients one to three business days before their visit to confirm, move or cancel it, and writes the result into Veradigm® Practice Management. It also follows up on no-shows and calls patients due for a recall visit.",
  crumbs: [{ name: "Call & Confirm", href: "/call-and-confirm/" }],
  schema: [faqSchema(confirmFaqs)],
  body: `${pageHero({
    eyebrow: "Call &amp; Confirm",
    title: 'Visits confirmed, moved or cancelled, <span class="accent-i">days ahead.</span>',
    lede: "Drawbridge calls your patients one to three business days before their visit so they can confirm it, move it or cancel it, and writes the result straight into Veradigm® Practice Management. It also follows up on no-shows and calls patients who are due for a recall visit. Your staff approve each day's list.",
    crumbs: [{ name: "Call & Confirm", href: "/call-and-confirm/" }],
    actions: btnPrimary(),
    note: '<span class="pill pill-prog">In development</span> Call &amp; Confirm is new. Ask us when it can start at your practice.',
  })}
<section class="section" id="how-it-works" aria-labelledby="cc-flow-title">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">How a day of calls works</p>
      <h2 id="cc-flow-title">Your staff approve the list. <span class="accent-i">Drawbridge makes the calls.</span></h2>
    </div>
    <ol class="flow cols-4">
      <li><h3>Approve the list</h3><p>Each day your staff see who Drawbridge plans to call and approve the list. No call goes out without that approval.</p></li>
      <li><h3>Call ahead</h3><p>One to three business days before the visit, Drawbridge calls the patient, who can confirm, move or cancel the visit on the call.</p></li>
      <li><h3>Write it to the schedule</h3><p>The result goes straight into Veradigm® Practice Management, so the schedule your staff already use is up to date.</p></li>
      <li><h3>Hand over the rest</h3><p>Patients who haven't confirmed are on an unconfirmed list for your morning huddle, so your team knows who to follow up with.</p></li>
    </ol>
  </div>
</section>
<section class="section on-white" aria-labelledby="cc-calls-title">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">Three kinds of calls</p>
      <h2 id="cc-calls-title">The outbound calls your front desk makes every week.</h2>
    </div>
    <div class="grid grid-3">
      <div class="card"><div class="icon">${icon("calendar")}</div><h3>Visit confirmations</h3><p>A call one to three business days ahead. The patient confirms, moves the visit to another open time or cancels it.</p></div>
      <div class="card"><div class="icon">${icon("refresh")}</div><h3>No-show follow-up</h3><p>Patients who missed a visit get a call so they can book again, instead of waiting for someone at the desk to find the time.</p></div>
      <div class="card"><div class="icon">${icon("bell")}</div><h3>Recall calls</h3><p>Patients who are due for a recall visit get a call to book it, from the list your staff approve.</p></div>
    </div>
  </div>
</section>
<section class="section on-night blueprint" aria-labelledby="cc-limits-title">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">Call limits and privacy</p>
      <h2 id="cc-limits-title">Persistent enough to reach people. <span class="accent-i">Never a nuisance.</span></h2>
    </div>
    <div class="grid grid-3">
      <div class="card"><div class="icon">${icon("clock")}</div><h3>Three tries, at different times</h3><p>Drawbridge tries up to three times, at different times of day, to reach people who work or keep different hours.</p></div>
      <div class="card"><div class="icon">${icon("shield")}</div><h3>Firm limits</h3><p>Never more than one call a day to a patient, and never more than three in a week.</p></div>
      <div class="card"><div class="icon">${icon("lock")}</div><h3>Voicemails without details</h3><p>Voicemails are short and leave out the details of the visit, so nothing private is left on a shared phone or answering machine.</p></div>
      <div class="card"><div class="icon">${icon("user")}</div><h3>Opt out on the call</h3><p>A patient who doesn't want these calls can say so on the call, and Drawbridge stops calling them.</p></div>
      <div class="card"><div class="icon">${icon("clipboard")}</div><h3>Staff approve every list</h3><p>Your team sees and approves each day's call list before any call is made.</p></div>
      <div class="card"><div class="icon">${icon("list")}</div><h3>Every result recorded</h3><p>Each confirmation, move and cancellation is written to the schedule, and every call is logged.</p></div>
    </div>
  </div>
</section>
<section class="section" aria-labelledby="cc-benefits-title">
  <div class="wrap split">
    <div>
      <p class="eyebrow">What it gives back</p>
      <h2 id="cc-benefits-title">A fuller schedule, <span class="accent-i">without the phone time.</span></h2>
      <p class="lede">We don't quote a no-show rate for Call &amp; Confirm. Every practice is different, so we measure it with yours.</p>
    </div>
    <ul class="checks">
      <li><span><strong>Fewer no-shows.</strong> Patients hear about their visit ahead of time, and those who can't make it can move it on the call.</span></li>
      <li><span><strong>Staff time back.</strong> Drawbridge makes the routine confirmation, no-show and recall calls, so your team calls only the patients on the unconfirmed list.</span></li>
      <li><span><strong>Open slots freed early.</strong> A visit cancelled or moved days ahead opens that time for another patient who needs it.</span></li>
    </ul>
  </div>
</section>
<section class="section on-white" aria-labelledby="cc-faq-title">
  <div class="wrap narrow"><h2 id="cc-faq-title">Questions about Call &amp; Confirm</h2>${faqList(confirmFaqs)}</div>
</section>
${ctaBand({ title: "Talk through your call list.", text: "In a 20-minute walkthrough we go through how your practice confirms visits today, which confirmation, no-show and recall calls Drawbridge would make, and how your staff approve the list." })}`,
};

export const platform = {
  path: "/platform/",
  title: "Staff tools: Call & Confirm, huddle brief, on-call notebook, audit",
  description:
    "Beyond fax intake and the phone assistant, Drawbridge gives your staff Call & Confirm appointment calls, a morning huddle brief, pre-visit checks, an on-call notebook, system status alerts, a tamper-evident audit log and patient access reports.",
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
      <a class="card card-link" href="/call-and-confirm/"><div class="icon">${icon("bell")}</div><h3>Call &amp; Confirm <span class="pill pill-prog">In development</span></h3><p>Confirmation calls one to three business days before each visit, no-show follow-up and recall calls, with results written to the schedule. Staff approve each day's list, and patients can opt out.</p><span class="btn-link">Call &amp; Confirm</span></a>
      <div class="card"><div class="icon">${icon("sun")}</div><h3>Morning huddle brief</h3><p>The day's schedule summarized for the team huddle, so everyone starts with the same picture.</p></div>
      <div class="card"><div class="icon">${icon("clipboard")}</div><h3>Pre-visit check</h3><p>A quick check of each upcoming visit so gaps are found before the patient arrives, not at the desk.</p></div>
      <div class="card"><div class="icon">${icon("moon")}</div><h3>On-call notebook</h3><p>Every after-hours call and message, with the brief prepared for the on-call provider, ready for the morning team.</p></div>
      <div class="card"><div class="icon">${icon("chat")}</div><h3>Staff assistant</h3><p>Ask in plain words, such as "who has an opening Tuesday afternoon?", and get the answer from the live schedule.</p></div>
      <div class="card"><div class="icon">${icon("list")}</div><h3>Intake review queue</h3><p>Documents that need a person, already read, with the suggested patient and the reason. One click to file or correct.</p></div>
      <div class="card"><div class="icon">${icon("gauge")}</div><h3>System status &amp; help-desk alerts</h3><p>A status banner on every staff screen and automatic alerts to MOATiT's help desk when the EHR connection goes down and when it recovers, with the number of messages taken in between.</p></div>
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
