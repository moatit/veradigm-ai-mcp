# Drawbridge launch campaign 5/6: CAN-SPAM, HIPAA-safe marketing and trademark rules

These rules apply to every email, LinkedIn message, ad, post and page in the launch. When in doubt, don't send; ask Ali. This is operational guidance, not legal advice; have counsel review before the first send.

## 1. CAN-SPAM (15 U.S.C. 7701 et seq.; FTC rule 16 CFR Part 316)

CAN-SPAM covers business-to-business commercial email too.

1. **Honest headers.** "From", "To", "Reply-To" and routing must identify MOATiT accurately. Send from a real person at an `@moatit.com` (or a dedicated, authenticated sending subdomain such as `mail.moatit.com`) with SPF, DKIM and DMARC configured.
2. **Honest subject lines.** No "Re:"/"Fwd:" tricks, no false urgency, nothing the email doesn't deliver.
3. **Identify it as an ad** where the recipient hasn't opted in. A plain line in the footer is enough ("You're receiving this because … ").
4. **Physical postal address in every email:** MOATiT, LLC, 2306 Pocatello Creek Rd, Pocatello, ID 83201.
5. **Clear unsubscribe in every email.** One-click (RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post` headers, also required by Gmail and Yahoo for bulk senders), working for at least 30 days after sending, no login, no fee, no more than the email address requested.
6. **Honor opt-outs within 10 business days** (target: immediately). Add to `data/suppression.csv`; never sell or transfer opted-out addresses.
7. **Monitor anyone sending on MOATiT's behalf.** MOATiT is liable for vendors and tools.
8. **No harvested or dictionary-generated addresses**, no open relays.

**Deliverability (not law, but required in practice):** warm the sending domain; ≤ 50 cold emails per sender per day at first; keep spam complaints < 0.1% (hard ceiling 0.3%); verify addresses before sending; stop on hard bounce.

**Other channels.** No cold SMS or auto-dialed / prerecorded calls to mobile numbers (TCPA). LinkedIn messages are manual only. Canadian contacts (CASL) need express or implied consent: exclude them unless they opted in.

## 2. HIPAA-safe marketing

Drawbridge marketing is B2B: we market **to practices**, never **to their patients**, and we never use PHI for marketing.

1. **No PHI anywhere in marketing:** emails, posts, ads, decks, case studies, screenshots, demo recordings, CRM notes, analytics. Demos and screenshots use only synthetic patients (e.g. "Rowan Ellery") and are labeled "synthetic".
2. **Never use a client practice's patient data** (or the fact that a person is a patient) for any marketing, even internally. Under HIPAA, using PHI for marketing needs the patient's written authorization (45 CFR 164.501, 164.508(a)(3)); MOATiT's BAAs don't allow it.
3. **No client names or logos** without the client's written permission. No quotes, testimonials or case studies until a client signs off in writing; never invent them, even anonymized.
4. **Forms collect business contact data only**, with the on-page warning "Please don't include patient information". If a prospect sends PHI anyway: don't forward it; delete it from the inbox and CRM; log the incident per MOATiT's policy.
5. **No tracking pixels on pages where patients could enter health information.** The marketing site has no patient-facing forms; keep it that way. Never place marketing pixels in the Drawbridge staff app or any patient-facing surface.
6. **Analytics:** none today. If added, use a cookieless, first-party, privacy-friendly tool, with no third-party ad pixels (Meta, Google Ads, LinkedIn Insight) unless Ali approves, a consent banner is added and the privacy policy is updated first.
7. **Claims:** only verifiable statements; synthetic-test numbers labeled with N, date and method; "HIPAA certified" is never used (there is no such certification): say "BAA available" and describe controls.

## 3. Veradigm® trademark and Veradigm Connect rules

1. Never use "Veradigm" in the product name, logo, domain, page titles as a brand, hashtags, ad account names or email sender names.
2. Never imply endorsement, partnership or certification: no "Veradigm partner", "certified for Veradigm", "official", "powered by Veradigm", until certification is complete **and** Veradigm's guidelines allow it.
3. Allowed: factual compatibility ("Integrates with Veradigm® EHR and Veradigm® Practice Management"), with ® on first use and the attribution line.
4. After certification: use only the official "Member of Veradigm Connect" boilerplate and logo, unmodified, per Veradigm's brand guidelines, approved by Musab.
5. Don't use Veradigm screenshots, UI, logos or colors in marketing.

## 4. Approvals before any send

- [ ] Ali approves the final copy, list segment and sending schedule.
- [ ] Sending domain authenticated (SPF, DKIM, DMARC) and one-click unsubscribe tested.
- [ ] Suppression list loaded (existing opt-outs, current clients who asked not to be marketed to, competitors, Canada unless opted in).
- [ ] Musab confirms Veradigm wording.
- [ ] Every landing URL live on drawbridge.moatit.com with HTTPS.
