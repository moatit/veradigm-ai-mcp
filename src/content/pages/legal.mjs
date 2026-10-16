import { ORG, SITE, TRADEMARK_NOTE } from "../site.mjs";
import { pageHero } from "../layout.mjs";
import { emailLink, phoneLinks, addressLine, esc } from "../partials.mjs";

const draft = `<div class="draft-banner" role="note"><strong>Draft for legal review.</strong> This page is a placeholder written for launch planning. It must be reviewed and approved by MOATiT's counsel before the site goes public.</div>`;
const contactBlock = () => `<p>${addressLine()}<br>Phone: ${phoneLinks(" · ")}<br>Email: ${emailLink()}</p>`;

const legalPage = (path, name, title, description, html) => ({
  path,
  title,
  description,
  crumbs: [{ name, href: path }],
  body: `${pageHero({ eyebrow: "Legal", title: esc(name), lede: `Last updated ${SITE.lastUpdated}.`, crumbs: [{ name, href: path }] })}
<section class="section"><div class="wrap"><div class="prose">${draft}${html}</div></div></section>`,
});

export const privacy = legalPage(
  "/legal/privacy/",
  "Privacy policy",
  "Website privacy policy",
  "How MOATiT, LLC handles information collected through the Drawbridge website at drawbridge.moatit.com.",
  `<p>This policy explains what information ${ORG.legalName} ("MOATiT", "we") collects through this website, drawbridge.moatit.com, and how we use it. It covers the website only. Patient information that Drawbridge processes for a practice is governed by that practice's business associate agreement with MOATiT, not by this policy.</p>
<h2>What we collect</h2>
<ul>
<li><strong>Information you give us:</strong> when you request a walkthrough or contact us, your name, work email, practice name, phone number (optional), the systems you use, practice size and your message.</li>
<li><strong>Technical information:</strong> our hosting provider records standard server logs (IP address, browser type, pages requested and time) for security and reliability. We keep these logs for a limited time.</li>
</ul>
<p>We do not ask for, and you should not send, patient health information through this website.</p>
<h2>Cookies and analytics</h2>
<p>This website does not use advertising or tracking cookies, and it does not load third-party analytics or tracking scripts. If we add privacy-friendly analytics in the future, we will update this policy first and ask for your consent where required.</p>
<h2>How we use information</h2>
<ul><li>To respond to your request and arrange a walkthrough.</li><li>To send you information about Drawbridge you asked for. Every marketing email includes an unsubscribe link and our postal address.</li><li>To keep the website secure.</li></ul>
<h2>Sharing</h2>
<p>We do not sell personal information. We share it only with service providers that help us run the website and respond to you (for example hosting and email), under contracts that limit their use of it, or when the law requires.</p>
<h2>Your choices</h2>
<p>You can ask us to access, correct or delete the information you gave us, or to stop contacting you, at any time.</p>
<h2>Contact</h2>${contactBlock()}`
);

export const terms = legalPage(
  "/legal/terms/",
  "Terms of use",
  "Website terms of use",
  "Terms of use for the Drawbridge website operated by MOATiT, LLC.",
  `<p>These terms govern your use of this website, drawbridge.moatit.com, operated by ${ORG.legalName}. Use of the Drawbridge service itself is governed by a separate agreement and business associate agreement between MOATiT and each practice.</p>
<h2>Information on this site</h2>
<p>We work to keep this site accurate. Numbers labeled "synthetic test", "sandbox test" or "pre-release test" come from testing with invented data and are not guarantees of results in your practice. The time savings calculator gives estimates based on assumptions you can see and change; it is not a quote or a promise.</p>
<h2>No medical advice</h2>
<p>Nothing on this website is medical advice. Drawbridge does not provide medical advice to patients or practices.</p>
<h2>Trademarks</h2>
<p>Drawbridge and MOATiT are trademarks of ${ORG.legalName}. ${esc(TRADEMARK_NOTE)} Other names may be trademarks of their owners.</p>
<h2>Limitation of liability</h2>
<p>This website is provided "as is". To the extent the law allows, MOATiT is not liable for damages arising from your use of the website.</p>
<h2>Governing law</h2>
<p>These terms are governed by the laws of the State of Idaho.</p>
<h2>Contact</h2>${contactBlock()}`
);

export const hipaa = legalPage(
  "/legal/hipaa/",
  "HIPAA notice",
  "HIPAA notice",
  "How HIPAA applies to Drawbridge and this website: MOATiT acts as a business associate to practices under a BAA.",
  `<h2>MOATiT as a business associate</h2>
<p>When a healthcare practice uses Drawbridge, ${ORG.legalName} acts as that practice's business associate under the Health Insurance Portability and Accountability Act (HIPAA). MOATiT signs a business associate agreement (BAA) with each practice before any protected health information (PHI) is processed, and uses and discloses PHI only as that agreement allows.</p>
<h2>Patients</h2>
<p>If you are a patient, your practice's Notice of Privacy Practices explains how your health information is used and your rights. Please contact your practice with questions about your records. MOATiT cannot answer questions about individual patients through this website.</p>
<h2>This website</h2>
<p>This marketing website does not collect PHI. Please do not send patient information through our forms or by email.</p>
<h2>Safeguards</h2>
<p>Our administrative, technical and physical safeguards are summarized on our <a href="/security/">Security &amp; HIPAA</a> page. HIPAA has no official certification program; we describe our controls instead of displaying a "HIPAA certified" badge.</p>
<h2>Report a concern</h2>${contactBlock()}`
);

export const accessibility = legalPage(
  "/legal/accessibility/",
  "Accessibility statement",
  "Accessibility statement",
  "MOATiT's commitment to an accessible Drawbridge website, targeting WCAG 2.2 Level AA.",
  `<p>We want everyone to be able to use this website, including people who use screen readers, keyboard navigation, magnification or voice control.</p>
<h2>Our target</h2>
<p>This site is designed to meet the Web Content Accessibility Guidelines (WCAG) 2.2 at Level AA. It uses semantic HTML, visible focus indicators, sufficient color contrast, text alternatives for images, form labels and error messages, and it respects reduced-motion settings.</p>
<h2>Known limitations</h2>
<p>Animated samples play once when they scroll into view and can be replayed with a button; with reduced motion turned on, they appear without animation.</p>
<h2>Feedback</h2>
<p>If something on this site doesn't work for you, tell us and we'll help and fix it.</p>${contactBlock()}`
);
