import { CTA, COMPAT_LINE } from "../site.mjs";
import {
  icon, btnPrimary, btnSecondary, liveCallButton, liveCallDialog, trustStrip, intakeLedger, reviewCard, callCard, proofCards,
  ctaBand, FAQS, faqList, faqSchema, phoneLinks, emailLink, itNeedsBlock,
} from "../partials.mjs";

// Hero variants for A/B landing pages (see docs/campaign/AB_TESTS.md)
export const HEROES = {
  a: {
    kicker: "Drawbridge, MOATiT's AI technology for healthcare practices",
    h1: 'Lab results filed. Calls answered. <span class="accent-i">Every one checked.</span>',
    lede: `For practices on <strong>Veradigm® EHR and Veradigm® Practice Management</strong>. Drawbridge reads incoming faxes and lab results and files them to the right patient's chart, and its phone assistant answers the calls you route to it, day and night, verifying every caller before it shares a thing. Anything that needs judgment goes to a person, already read and explained. <strong>More capacity for the team you already have.</strong>`,
  },
  fax: {
    kicker: "Drawbridge fax &amp; lab intake, A MOATiT Service",
    h1: 'Every fax and lab result, <span class="accent-i">filed for you.</span>',
    lede: `Drawbridge reads every incoming fax and lab result, matches it to exactly one patient on full name and date of birth, and files it to the right category in <strong>Veradigm® EHR</strong>, with a review task for the ordering provider. Anything that needs a person lands in your staff queue, already read, so your team spends its time on patients.`,
  },
  phone: {
    kicker: "Drawbridge phone assistant, A MOATiT Service",
    h1: 'Calls answered, <span class="accent-i">day and night.</span>',
    lede: `Drawbridge answers the calls you route to it, day and night. It verifies callers, books, moves and confirms visits in <strong>Veradigm® Practice Management</strong> with a read-back, and takes clear messages for your staff. Emergencies are directed to 911, and clinical questions stay with your clinicians.`,
  },
};

export const homeHero = (v = "a") => {
  const h = HEROES[v];
  return `<section class="hero" aria-labelledby="hero-title">
  <div class="wrap">
    <p class="eyebrow">${h.kicker}</p>
    <div class="hero-grid">
      <h1 id="hero-title">${h.h1}</h1>
      <div class="hero-side">
        <p class="lede">${h.lede}</p>
        <div class="btn-row">${btnPrimary()}${v === "fax" ? btnSecondary(CTA.fax.label, "#sample-filing") : liveCallButton()}</div>
        <p class="hero-note">Prefer to talk? ${phoneLinks(" or ")} · ${emailLink()}</p>
      </div>
    </div>
    ${intakeLedger()}
    ${trustStrip()}
  </div>
</section>
${v === "fax" ? "" : liveCallDialog()}`;
};

export const demoBand = () => `<section class="section on-white" id="demo" aria-labelledby="demo-title">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">See it work</p>
      <h2 id="demo-title">Two jobs your front desk does all day. <span class="accent-i">Done carefully.</span></h2>
      <p class="lede">Every sample on this site uses invented patients. In a walkthrough we run them live on a test system.</p>
    </div>
    <div class="demo-grid">
      <div class="demo-col sticky" id="sample-filing">
        <h3>A fax that needs a person</h3>
        <p>This one goes to a person: the address on the fax differs from the chart, so staff receive it already read, with the reason and a suggested patient.</p>
        ${reviewCard("demo-review")}
      </div>
      <div class="demo-col" id="sample-call">
        <h3>A reschedule call, handled</h3>
        <p>Verified first, offered real open times, read back, then booked.</p>
        ${callCard("demo-call", { play: false })}
        <p class="mt-1"><a class="btn-link" href="/phone-assistant/#sample-call">Play the call on the phone assistant page</a></p>
      </div>
    </div>
  </div>
</section>`;

export const rulesSection = () => `<section class="section on-night blueprint" id="rules" aria-labelledby="rules-title">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">The drawbridge rules</p>
      <h2 id="rules-title">AI reads the page. <span class="accent-i">Rules you can audit</span> decide where it goes.</h2>
      <p class="lede">A drawbridge only comes down for the right traveler. Drawbridge works the same way: every document and every caller passes these checks first, and every decision is logged.</p>
    </div>
    <div class="rules">
      <div class="rule"><span class="n">Rule 1</span><h3>Two identifiers, one patient.</h3><p>Full name and date of birth must match exactly one patient. A last-4 SSN or address on the document must agree too. Look-alikes, twins and conflicts go to a person.</p></div>
      <div class="rule"><span class="n">Rule 2</span><h3>Close calls go to your staff.</h3><p>More than one patient on a page, a hard-to-read page in a batch, or a doubtful digit: the document goes to staff, with the reason written on it.</p></div>
      <div class="rule"><span class="n">Rule 3</span><h3>Some documents always go to a person.</h3><p>Records requests, prior authorizations, refill requests and referrals always go to staff by default. Your practice sets the list.</p></div>
      <div class="rule"><span class="n">Rule 4</span><h3>Critical results get attention right away.</h3><p>Lab critical flags create a High-priority review task marked CRITICAL, with a phone call required. They notify even on same-day visits.</p></div>
      <div class="rule"><span class="n">Rule 5</span><h3>Verify the caller before anything else.</h3><p>Enforced by the server itself: the caller is verified on the call before any patient record is read or changed.</p></div>
      <div class="rule"><span class="n">Rule 6</span><h3>Read it back. Wait for a yes.</h3><p>Every booking, move, cancellation and confirmation is read back to the caller and made only after they agree.</p></div>
      <div class="rule"><span class="n">Rule 7</span><h3>Clinical questions go to clinicians. Emergencies go to 911.</h3><p>The assistant never interprets results or medications and never advises; clinical questions go to your clinicians. Emergencies hear one clear line: hang up and call 911 now.</p></div>
      <div class="rule"><span class="n">Rule 8</span><h3>A person, whenever you ask.</h3><p>Callers can ask for staff at any time. After hours, urgent calls are flagged for your on-call provider in the on-call notebook, and callers are told how to reach them. Emergencies are directed to 911.</p></div>
    </div>
  </div>
</section>`;

export const rolloutSection = () => `<section class="section" id="rollout" aria-labelledby="rollout-title">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">Going live</p>
      <h2 id="rollout-title">Your staff keep working as usual through <span class="accent-i">a week of proof.</span></h2>
      <p class="lede">A read-only shadow week first, so you see the results before anything changes. Nothing is written to your chart until you approve.</p>
    </div>
    <ol class="flow cols-4">
      <li><h3>Five-minute setup sheet</h3><p>Your practice manager answers 15 questions about your rules and how documents flow today: who reviews results, which documents always go to a person, booking rules.</p></li>
      <li><h3>BAA and Veradigm® access</h3><p>You sign our business associate agreement and authorize Veradigm® to give Drawbridge access.</p></li>
      <li><h3>Shadow week, read-only</h3><p>For one week Drawbridge runs read-only alongside your team. Staff keep indexing in Veradigm® EHR as today. Drawbridge reads each incoming document, decides where it would file it, and compares that with where your staff filed it. Nothing is written to the chart.</p></li>
      <li><h3>Go live when you approve</h3><p>Faxes and lab files come to Drawbridge first; MOATiT sets up the fax routing and the lab file drop with you. Drawbridge files what it can match with certainty and sends a review task. Anything that needs a person goes to your Veradigm® EHR document queue for staff, as today.</p></li>
    </ol>
    <p class="small mt-1">For the phone assistant, your line forwards to Drawbridge first; moving the number over comes later. If you decide not to go ahead, we switch Drawbridge off. Nothing in your system changed during the shadow week.</p>
  </div>
</section>`;

export default {
  path: "/",
  title: "AI fax intake and phone assistant for medical practices | Drawbridge, A MOATiT Service",
  ogTitle: "Drawbridge: lab results filed, calls answered, every one checked",
  description:
    "Drawbridge is MOATiT's AI technology for healthcare practices. It files faxes and lab results to the right patient chart and answers the calls you route to it, day and night, verifying every caller. Integrates with Veradigm® EHR and PM.",
  app: true,
  schema: [faqSchema(FAQS.filter((f) => f.home))],
  body: `${homeHero("a")}
${demoBand()}
<section class="section" id="problem" aria-labelledby="problem-title">
  <div class="wrap split lead-left">
    <div>
      <p class="eyebrow">The front desk, today</p>
      <h2 id="problem-title">Your front desk is the drawbridge. <span class="accent-i">It's up all day.</span></h2>
      <p class="lede">Every fax, lab result and phone call crosses one desk. The work is careful, repetitive and never finished.</p>
    </div>
    <div>
      <ul class="checks pains">
        <li><span><strong>The fax pile.</strong> Each result is opened, read, matched to a patient, put in the right category and routed to a provider, one page at a time.</span></li>
        <li><span><strong>The daily lab batch.</strong> One file, many patients' results, split by hand before any of it can be filed.</span></li>
        <li><span><strong>The phone line.</strong> "Can I move my appointment?" "What's my balance?" Calls queue while staff check patients in.</span></li>
        <li><span><strong>After hours.</strong> Voicemail until morning, or an answering service that can't see the schedule.</span></li>
      </ul>
      <p class="pains-close">Drawbridge takes the routine crossings and hands your staff only the ones that need judgment, already read and explained, so your people spend their day on the work they're great at: patients and care.</p>
    </div>
  </div>
</section>
<section class="section on-night blueprint" id="vision" aria-labelledby="vision-title">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">The future of your practice</p>
      <h2 id="vision-title">Is your practice ready for <span class="accent-i">more capacity?</span></h2>
      <p class="lede">Drawbridge adds capacity. It works alongside your current system and your staff and multiplies what they can do. Your team does the work they're great at, with patients and care, while Drawbridge handles the repetitive indexing and the routine calls.</p>
    </div>
    <div class="grid grid-3">
      <div class="card"><div class="icon">${icon("users")}</div><h3>More capacity, same team</h3><p>Drawbridge is built so the same team can serve many times more patients. Imagine your front desk handling ten times the volume without adding headcount.</p></div>
      <div class="card"><div class="icon">${icon("gauge")}</div><h3>Room to grow</h3><p>More calls answered, results routed sooner and fewer bottlenecks at the desk give the practice room to see more patients and grow revenue.</p></div>
      <div class="card"><div class="icon">${icon("link")}</div><h3>Proof before change</h3><p>A read-only shadow week first. Nothing is written to your chart until you approve, and if you decide not to go ahead, we switch Drawbridge off.</p></div>
    </div>
    <p class="small mt-2 vision-note">This is our vision for what Drawbridge makes possible, not a measured result. Our measured numbers are under "Results so far".</p>
  </div>
</section>
<section class="section on-paper-2" id="products" aria-labelledby="products-title">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">Two products, one platform</p>
      <h2 id="products-title">What Drawbridge handles</h2>
    </div>
    <div class="grid grid-2">
      <a class="card card-link" href="/fax-lab-intake/">
        <div class="icon">${icon("fax")}</div>
        <h3>Fax &amp; lab-result intake</h3>
        <p>Reads incoming faxes and lab files on MOATiT's servers. Matches each to one patient, splits multi-patient batch files, files to your category and sends a review task to the ordering provider.</p>
        <ul class="checks">
          <li><span>Local OCR; nothing sent to outside AI services</span></li>
          <li><span>Critical results as High-priority tasks</span></li>
          <li><span>Staff review queue with one-click file or correct</span></li>
        </ul>
        <span class="btn-link">Fax &amp; lab intake</span>
      </a>
      <a class="card card-link" href="/phone-assistant/">
        <div class="icon">${icon("phone")}</div>
        <h3>AI phone assistant</h3>
        <p>Answers the calls you route to it, day and night. Verifies callers, shares upcoming visits and open times, books, moves, cancels and confirms with read-back, and takes messages for staff.</p>
        <ul class="checks">
          <li><span>Balance, insurance, medication and allergy lists and recent results, as recorded</span></li>
          <li><span>After-hours notebook for the on-call provider</span></li>
          <li><span>Transfers to staff whenever a caller asks</span></li>
        </ul>
        <span class="btn-link">Phone assistant</span>
      </a>
    </div>
    <div class="grid grid-4 mt-2">
      <div class="card"><div class="icon">${icon("bell")}</div><h3>Reminders &amp; recalls</h3><p>Reminder calls, no-show follow-up and recall outreach, only with a staff click or a schedule you set.</p></div>
      <div class="card"><div class="icon">${icon("sun")}</div><h3>Huddle brief</h3><p>A morning summary of the day's schedule, plus a pre-visit check for each patient.</p></div>
      <div class="card"><div class="icon">${icon("moon")}</div><h3>On-call notebook</h3><p>Every after-hours call and message in one place for the on-call provider and the morning team.</p></div>
      <div class="card"><div class="icon">${icon("gauge")}</div><h3>Status &amp; alerts</h3><p>System status on every staff screen and automatic alerts to MOATiT's help desk if the EHR connection drops.</p></div>
    </div>
    <p class="mt-2"><a class="btn-link" href="/platform/">All staff tools</a></p>
  </div>
</section>
${rulesSection()}
<section class="section" id="proof" aria-labelledby="proof-title">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">Results so far</p>
      <h2 id="proof-title">Honest numbers, <span class="accent-i">clearly labeled.</span></h2>
      <p class="lede">Drawbridge is newly launched, so we don't show customer logos or testimonials yet. Here is what our testing shows, with how each number was measured. Your shadow week measures your own.</p>
    </div>
    ${proofCards()}
    <p class="small mt-1">All tests used invented patients and documents; no real patient data. Methods and full results are available on request.</p>
  </div>
</section>
${rolloutSection()}
<section class="section on-white" id="roi" aria-labelledby="roi-title">
  <div class="wrap split">
    <div>
      <p class="eyebrow">Time back</p>
      <h2 id="roi-title">How many hours would your staff get back?</h2>
      <p class="lede">Enter your fax and call volumes. Every assumption is shown and editable, and nothing you type leaves your browser.</p>
      <div class="btn-row mt-1">${btnPrimary(CTA.roi.label, CTA.roi.href)}</div>
    </div>
    <div class="card">
      <p class="eyebrow">Example practice</p>
      <p class="mb-0">60 documents and 120 calls a day, with our default assumptions:</p>
      <p class="roi-big roi-big-light">≈ 82 hours<small>of staff time back per month: about half of a full-time role</small></p>
      <p class="small mt-1 mb-0">Fax: (60 × 45% × 3 min + 60 × 55% × 1 min) × 21 days ≈ 40 h. Phone: 120 × 25% × 4 min × 21 days = 42 h. An estimate, not a guarantee.</p>
    </div>
  </div>
</section>
<section class="section on-night" id="security" aria-labelledby="sec-title">
  <div class="wrap split">
    <div>
      <p class="eyebrow">Security &amp; HIPAA</p>
      <h2 id="sec-title">Built by a security-first IT company.</h2>
      <p class="lede">MOATiT has run IT, phones and security for businesses since 2013. Drawbridge was built to the HIPAA Security Rule from the first line of code, and its code passed an independent audit in October 2026; the production re-review is pending.</p>
      <div class="btn-row mt-1">${btnSecondary(CTA.security.label, CTA.security.href)}</div>
    </div>
    <ul class="checks">
      <li><span><strong>BAA with every practice</strong>, before any patient data flows</span></li>
      <li><span><strong>Multi-factor sign-in</strong> for every staff user; passwords expire every 90 days; lockout after failed attempts</span></li>
      <li><span><strong>Encryption</strong> in transit (TLS 1.2+) and at rest, and US hosting: required for every production deployment before patient data flows</span></li>
      <li><span><strong>Tamper-evident audit log</strong> kept six years, with patient access reports</span></li>
      <li><span><strong>Minimum necessary</strong>: the phone assistant sees only what the verified caller's request needs</span></li>
      <li><span><strong>Code audit passed</strong> (Oct 2026), production re-review pending; SOC 2 in process, to be completed before the end of 2027</span></li>
    </ul>
  </div>
</section>
<section class="section" id="pricing" aria-labelledby="pricing-title">
  <div class="wrap split">
    <div>
      <p class="eyebrow">Pricing</p>
      <h2 id="pricing-title">Priced for your practice. <span class="accent-i">Ask us.</span></h2>
      <p class="lede">Pricing depends on your fax and call volume and which parts of Drawbridge you use. Every plan includes setup, the shadow week, a BAA and support from a local team.</p>
      <div class="btn-row mt-1">${btnPrimary("Contact us for pricing", "/contact/")}<a class="btn-link" href="/pricing/">How pricing works</a></div>
    </div>
    <div class="aside-card">
      <h3>Talk to a person</h3>
      <ul class="contact-list">
        <li><span class="k">Phone</span>${phoneLinks(" · ")}</li>
        <li><span class="k">Email</span>${emailLink()}</li>
        <li><span class="k">Office</span>MOATiT, LLC, 2306 Pocatello Creek Rd, Pocatello, ID 83201</li>
      </ul>
    </div>
  </div>
</section>
<section class="section on-white" id="faq" aria-labelledby="faq-title">
  <div class="wrap narrow">
    <div class="section-head">
      <p class="eyebrow">Questions</p>
      <h2 id="faq-title">Frequently asked</h2>
    </div>
    ${faqList(FAQS.filter((f) => f.home))}
    <p class="mt-2"><a class="btn-link" href="/faq/">All questions</a></p>
  </div>
</section>
<section class="section" id="note" aria-labelledby="note-title">
  <div class="wrap note">
    <div>
      <p class="eyebrow">Why we built it</p>
      <h2 id="note-title">A note from MOATiT</h2>
      <img src="/assets/brand/drawbridge-mark.svg" width="96" height="96" alt="" loading="lazy">
    </div>
    <blockquote>
      <p>For more than a decade we've run the networks, phones, fax lines and EHR hosting behind medical practices in Idaho and the Intermountain West. We've watched front-desk teams spend their mornings indexing faxes and their afternoons on hold.</p>
      <p>We built Drawbridge to give that time back to patients and care, without ever trading safety for speed. It works alongside your systems and your people and multiplies what they can do. It files the clear matches, explains the rest, and leaves the judgment calls to your team.</p>
      <footer class="small note-sign">Ali Khan, CEO, MOATiT</footer>
    </blockquote>
  </div>
</section>
${ctaBand()}
<div class="wrap"><p class="tm-note">${COMPAT_LINE}. Veradigm® is a registered trademark of Veradigm Inc. or its affiliates; naming Veradigm® describes compatibility only and does not imply endorsement by Veradigm.</p></div>`,
};
