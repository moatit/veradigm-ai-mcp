import { SITE, ORG, CTA } from "../site.mjs";
import { pageHero } from "../layout.mjs";
import {
  icon, btnPrimary, btnSecondary, ctaBand, FAQS, faqList, faqSchema, roiCalculator, phoneLinks, emailLink, addressLine, picture,
} from "../partials.mjs";

export const about = {
  path: "/about/",
  title: "About MOATiT, the team behind Drawbridge",
  description:
    "Drawbridge is MOATiT's AI technology for healthcare practices. MOATiT, LLC was founded in Pocatello, Idaho, in 2013 and runs managed IT, cybersecurity, phones, fax and EHR hosting across the Intermountain West.",
  crumbs: [{ name: "About MOATiT", href: "/about/" }],
  body: `${pageHero({
    eyebrow: "About",
    title: 'Drawbridge is <span class="accent-i">MOATiT\'s</span> AI technology for healthcare practices.',
    lede: "MOATiT, LLC has been the IT department for businesses and medical practices in Idaho, Utah and Wyoming since 2013. Drawbridge is what we built after years of watching front desks drown in faxes and phone calls.",
    crumbs: [{ name: "About MOATiT", href: "/about/" }],
  })}
<section class="section" aria-labelledby="who-title">
  <div class="wrap split">
    <div>
      <p class="eyebrow">Who we are</p>
      <h2 id="who-title">A local technology team, not a call center.</h2>
      <p>Founded in Pocatello, Idaho, in 2013, MOATiT provides managed IT, cybersecurity, business phone systems, online fax, backup and disaster recovery, and EHR hosting. Many of the practices we support have run on our networks, phones and fax lines for years.</p>
      <p>That is why Drawbridge looks the way it does. We already guard the moat around your practice's systems; Drawbridge is the one controlled way in, for documents and calls, and it only comes down for the right patient.</p>
      <div class="badge-row"><span class="badge">${icon("pin", "")}Pocatello, Idaho</span><span class="badge">Since 2013</span><span class="badge">Idaho · Utah · Wyoming</span></div>
    </div>
    <figure class="figure">${picture({ name: "documents", widths: [640, 960, 1280], sizes: "(min-width: 960px) 50vw, 100vw", alt: "Blank paper documents sorted neatly into blue folders on a deep indigo desk.", w: 1280, h: 960 })}<figcaption>AI-generated illustration</figcaption></figure>
  </div>
</section>
<section class="section on-white" aria-labelledby="principles-title">
  <div class="wrap">
    <div class="section-head"><p class="eyebrow">How we build</p><h2 id="principles-title">Four principles behind Drawbridge</h2></div>
    <div class="grid grid-4">
      <div class="card"><h3>Never guess</h3><p>If the evidence isn't there, a person decides. Every time.</p></div>
      <div class="card"><h3>Show the work</h3><p>Every decision carries its reason, and every action is logged.</p></div>
      <div class="card"><h3>Prove it first</h3><p>A shadow week on your real documents before anything is filed.</p></div>
      <div class="card"><h3>Say what's true</h3><p>Test numbers are labeled as tests. Unfinished work is labeled unfinished.</p></div>
    </div>
  </div>
</section>
<section class="section" aria-labelledby="contact-title">
  <div class="wrap grid grid-2">
    <div>
      <p class="eyebrow">Contact</p>
      <h2 id="contact-title">Talk to the team</h2>
      <ul class="contact-list">
        <li><span class="k">Phone</span>${phoneLinks(" · ")}</li>
        <li><span class="k">Email</span>${emailLink()}</li>
        <li><span class="k">Office</span>${addressLine()}</li>
        <li><span class="k">Company website</span><a href="${ORG.url}" rel="noopener">moatit.com</a></li>
      </ul>
    </div>
    <div class="aside-card"><h3>See it for yourself</h3><p>A 20-minute walkthrough with a MOATiT engineer, on synthetic data.</p>${btnPrimary()}</div>
  </div>
</section>`,
};

const sel = (id, label, opts, req = true) => `<div class="field">
  <label for="${id}">${label}${req ? ' <span class="req" aria-hidden="true">*</span>' : ' <span class="hint">(optional)</span>'}</label>
  <select id="${id}" name="${id}"${req ? " required" : ""} aria-describedby="${id}-e">
    <option value="">Choose one</option>
    ${opts.map((o) => `<option>${o}</option>`).join("")}
  </select>
  <span class="error" id="${id}-e">Please choose an option.</span>
</div>`;
const inp = (id, label, type, auto, req = true, full = false, err = "Please fill this in.") => `<div class="field${full ? " full" : ""}">
  <label for="${id}">${label}${req ? ' <span class="req" aria-hidden="true">*</span>' : ' <span class="hint">(optional)</span>'}</label>
  <input id="${id}" name="${id}" type="${type}" autocomplete="${auto}"${req ? " required" : ""} aria-describedby="${id}-e">
  <span class="error" id="${id}-e">${err}</span>
</div>`;

export const contact = {
  path: "/contact/",
  title: "Book a 20-minute walkthrough",
  description:
    "Book a 20-minute Drawbridge walkthrough with a MOATiT engineer, or call (208) 900-6628 / (855) 550-6628, or email questions@moatit.com. MOATiT, LLC, 2306 Pocatello Creek Rd, Pocatello, ID 83201.",
  crumbs: [{ name: "Book a walkthrough", href: "/contact/" }],
  body: `${pageHero({
    eyebrow: "Book a walkthrough",
    title: 'Twenty minutes. <span class="accent-i">Synthetic data.</span> No pressure.',
    lede: "Tell us a little about your practice and we'll set up a time. Prefer to talk now? Call us.",
    crumbs: [{ name: "Book a walkthrough", href: "/contact/" }],
  })}
<section class="section" aria-labelledby="form-title">
  <div class="wrap split align-start">
    <div>
      <h2 id="form-title" class="visually-hidden">Walkthrough request</h2>
      <div class="phi-warning" role="note">${icon("alert")}<span><strong>Please don't include patient information.</strong> This form is for practice contact details only.</span></div>
      <form id="demo-form" action="${SITE.demoEndpoint}" method="post" data-endpoint="${SITE.demoEndpoint}" novalidate>
        <div class="form-grid">
          ${inp("name", "Full name", "text", "name")}
          ${inp("email", "Work email", "email", "email", true, false, "Please enter a valid email address.")}
          ${inp("practice", "Practice name", "text", "organization")}
          ${sel("ehr", "EHR / practice management", ["Veradigm® EHR and Veradigm® PM", "Veradigm® EHR only", "Veradigm® PM only", "Other system", "Not sure"])}
          ${sel("providers", "Number of providers", ["1–3", "4–10", "11–25", "26+"])}
          ${sel("interest", "Most interested in", ["Fax & lab-result intake", "Phone assistant", "Both", "Security / IT review"], false)}
          ${inp("phone", "Phone", "tel", "tel", false)}
          <div class="field full"><label for="message">Anything we should know? <span class="hint">(optional)</span></label><textarea id="message" name="message" rows="3" maxlength="1000"></textarea></div>
          <div class="hp" aria-hidden="true"><label for="company_website">Leave this empty</label><input id="company_website" name="company_website" type="text" tabindex="-1" autocomplete="off"></div>
        </div>
        <p class="small">By sending this form you agree that MOATiT may contact you about Drawbridge. See our <a href="/legal/privacy/">privacy policy</a>.</p>
        <button class="btn btn-primary" type="submit">Request my walkthrough</button>
        <div id="form-status" class="form-status" role="status" aria-live="polite"></div>
      </form>
    </div>
    <div>
      <div class="aside-card">
        <h3>What to expect</h3>
        <ul class="checks">
          <li><span>A 20-minute video call with a MOATiT engineer</span></li>
          <li><span>A synthetic lab fax filed live, and one that goes to a person</span></li>
          <li><span>A sample call: verify, check visits, reschedule</span></li>
          <li><span>What your shadow week would look like, and pricing for your volumes</span></li>
        </ul>
      </div>
      <div class="aside-card">
        <h3>Or reach us directly</h3>
        <ul class="contact-list">
          <li><span class="k">Phone</span>${phoneLinks(" · ")}</li>
          <li><span class="k">Email</span>${emailLink()}</li>
          <li><span class="k">Office</span>${addressLine()}</li>
        </ul>
      </div>
    </div>
  </div>
</section>`,
};

export const roi = {
  path: "/roi/",
  title: "Time savings calculator for fax intake and phone calls",
  description:
    "Estimate how many staff hours Drawbridge could give back each month from fax and lab-result intake and phone calls. Every assumption is shown and editable; nothing leaves your browser.",
  crumbs: [{ name: "Time savings calculator", href: "/roi/" }],
  body: `${pageHero({
    eyebrow: "Time savings calculator",
    title: 'How many hours would <span class="accent-i">your</span> staff get back?',
    lede: "Change any number. The formulas are below the result, and nothing you type is sent anywhere.",
    crumbs: [{ name: "Time savings calculator", href: "/roi/" }],
  })}
<section class="section" aria-label="Calculator">
  <div class="wrap">${roiCalculator()}</div>
</section>
<section class="section on-white" aria-labelledby="assume-title">
  <div class="wrap narrow">
    <h2 id="assume-title">About the assumptions</h2>
    <p><strong>Auto-file share (45%).</strong> In our held-out synthetic tests, Drawbridge filed about 43–53% of all documents with no staff touch, depending on the matching rule. Real faxes vary with fax quality and senders. Your shadow week measures your actual rate before anything is filed.</p>
    <p><strong>Minutes per document (3) and per call (4), share of calls completed (25%), cost per hour ($24).</strong> These are assumptions, not Drawbridge measurements. We don't have production call data yet, so we chose conservative values. Replace them with your own.</p>
    <p><strong>What's not counted.</strong> Faster provider review of results, fewer misfiled documents, calls answered that would have gone to voicemail, and appointments kept by reminder calls. These matter, but we can't measure them for you here.</p>
  </div>
</section>
${ctaBand({ title: "Check these numbers against your real week.", text: "In a walkthrough we'll look at your fax and call volumes together, and the shadow week will measure the real thing." })}`,
};

export const pricing = {
  path: "/pricing/",
  title: "Pricing: contact us for a quote",
  description:
    "Drawbridge pricing depends on your document and call volumes and which parts you use. Every plan includes setup, a one-week shadow mode, a BAA and local support. Contact MOATiT for a quote.",
  crumbs: [{ name: "Pricing", href: "/pricing/" }],
  body: `${pageHero({
    eyebrow: "Pricing",
    title: 'Simple to start. <span class="accent-i">Priced to your volume.</span>',
    lede: "We quote each practice on its fax and call volumes and the parts of Drawbridge it uses. Tell us about your practice and we'll send a clear quote.",
    crumbs: [{ name: "Pricing", href: "/pricing/" }],
  })}
<section class="section" aria-labelledby="plan-title">
  <div class="wrap split align-start">
    <div class="price-card">
      <p class="eyebrow">Drawbridge</p>
      <h2 id="plan-title" class="price-tag">Contact us</h2>
      <p class="lede">for a quote for your practice</p>
      <h3 class="mt-2">Every plan includes</h3>
      <ul class="checks">
        <li><span>Setup by MOATiT: fax line, lab folders, EHR and PM connection, phone routing</span></li>
        <li><span>The 15-question setup sheet turned into your practice's rules</span></li>
        <li><span>One week in shadow mode, with a review of every difference</span></li>
        <li><span>A business associate agreement</span></li>
        <li><span>Hosting in the US, single-tenant, with backups and monitoring</span></li>
        <li><span>Support from a local team in Pocatello, Idaho</span></li>
      </ul>
      <div class="btn-row mt-1">${btnPrimary("Contact us for pricing", "/contact/")}</div>
    </div>
    <div>
      <h2>What shapes the price</h2>
      <ul class="checks">
        <li><span><strong>Which parts you use:</strong> fax &amp; lab intake, the phone assistant, or both</span></li>
        <li><span><strong>Volume:</strong> documents and calls per month</span></li>
        <li><span><strong>Locations and phone lines</strong></span></li>
        <li><span><strong>Outreach:</strong> reminder and recall calls, if you use them</span></li>
      </ul>
      <div class="aside-card mt-2">
        <h3>Ask us now</h3>
        <ul class="contact-list">
          <li><span class="k">Phone</span>${phoneLinks(" · ")}</li>
          <li><span class="k">Email</span>${emailLink()}</li>
        </ul>
      </div>
      <p class="mt-2"><a class="btn-link" href="/roi/">Estimate your time savings first</a></p>
    </div>
  </div>
</section>`,
};

export const faq = {
  path: "/faq/",
  title: "Frequently asked questions",
  description:
    "Answers about Drawbridge: how patient matching works, what happens when it isn't sure, the phone assistant's verification and safety rules, HIPAA and BAA, data storage, pricing and going live.",
  crumbs: [{ name: "FAQ", href: "/faq/" }],
  schema: [faqSchema(FAQS)],
  body: `${pageHero({
    eyebrow: "FAQ",
    title: "Questions, answered plainly.",
    lede: `Don't see yours? Call ${phoneLinks(" or ")} or email ${emailLink()}.`,
    crumbs: [{ name: "FAQ", href: "/faq/" }],
  })}
<section class="section">
  <div class="wrap narrow">${faqList(FAQS)}</div>
</section>
${ctaBand()}`,
};
