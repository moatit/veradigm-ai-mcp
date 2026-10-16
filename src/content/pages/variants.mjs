// A/B landing-page variants for the launch campaign (canonical points at the home page; not in the sitemap).
// See docs/campaign/AB_TESTS.md.
import { homeHero, heroImage, rulesSection, rolloutSection } from "./home.mjs";
import { proofCards, ctaBand, callCard, reviewCard, faqList, FAQS } from "../partials.mjs";
import { COMPAT_LINE } from "../site.mjs";

const variant = (slug, v, title, description, middle) => ({
  path: `/lp/${slug}/`,
  canonicalPath: "/",
  sitemap: false, // indexable but canonical → "/" (Google's guidance for A/B test variants)
  title,
  description,
  app: true,
  preloadImage: heroImage,
  body: `${homeHero(v)}
${middle}
${rulesSection()}
<section class="section" aria-labelledby="lp-proof"><div class="wrap"><div class="section-head"><p class="eyebrow">Results so far</p><h2 id="lp-proof">Honest numbers, clearly labeled.</h2></div>${proofCards()}</div></section>
${rolloutSection()}
<section class="section on-white" aria-labelledby="lp-faq"><div class="wrap narrow"><h2 id="lp-faq">Questions</h2>${faqList(FAQS.filter((f) => f.home))}</div></section>
${ctaBand()}
<div class="wrap"><p class="tm-note">${COMPAT_LINE}. Veradigm® is a registered trademark of Veradigm Inc. or its affiliates; naming Veradigm® describes compatibility only and does not imply endorsement by Veradigm.</p></div>`,
});

export const lpFax = variant(
  "fax",
  "fax",
  "Stop indexing faxes by hand | Drawbridge — A MOATiT Service",
  "Drawbridge reads incoming faxes and lab results, matches each to exactly one patient and files it to Veradigm® EHR with a review task for the ordering provider. Unsure? It goes to your staff.",
  `<section class="section on-white" id="sample-filing" aria-labelledby="lp-fax-demo"><div class="wrap"><div class="section-head"><p class="eyebrow">See it work</p><h2 id="lp-fax-demo">Filed when sure. Handed over when not.</h2></div><div class="split"><div><p class="lede">The sample at the top was filed: one patient, two identifiers, no conflicts. This one wasn't. The address disagrees with the chart, so a person decides, with the document already read and the reason in front of them.</p><ul class="checks"><li><span>Daily lab batches split into one document per patient</span></li><li><span>Critical results as High-priority tasks marked CRITICAL</span></li><li><span>Records requests, prior auths, refills and referrals always to a person</span></li></ul></div>${reviewCard("lp-review")}</div></div></section>`
);

export const lpPhone = variant(
  "phone",
  "phone",
  "An AI phone assistant that answers every call | Drawbridge — A MOATiT Service",
  "Drawbridge answers your clinic line 24/7, verifies every caller, books and reschedules with read-back in Veradigm® PM, and takes messages. No medical advice; 911 for emergencies.",
  `<section class="section on-white" id="sample-call" aria-labelledby="lp-call-demo"><div class="wrap split"><div><p class="eyebrow">See it work</p><h2 id="lp-call-demo">Verified, offered, read back, booked.</h2><p class="lede">The server won't release or change any record until the caller is verified on that call.</p></div>${callCard("lp-call")}</div></section>`
);
