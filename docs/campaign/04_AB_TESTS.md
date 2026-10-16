# Drawbridge launch campaign 4/6: A/B landing variants

Built in the site (noindex, canonical → home):

| Variant | URL | Hero | Secondary CTA | First section |
|---|---|---|---|---|
| **A: both** (control) | `/` | "Lab results filed. Calls answered. Nothing guessed." | See a sample call | Review-queue sample + sample call |
| **B: fax-first** | `/lp/fax/` | "Stop indexing faxes by hand." | See a fax get filed | "Filed when sure. Handed over when not." |
| **C: phone-first** | `/lp/phone/` | "Every call answered, even at 2 a.m." | See a sample call | Sample call transcript |

All three share the rules, proof, rollout, FAQ and CTA sections, so only the hero and first section differ.

## Assignment

- **Email traffic:** the segmentation script sets `lp_variant` by specialty (document-heavy → fax; phone-heavy → phone) and splits the rest 50/50 by a hash of `company_id`. To test the hypothesis cleanly, hold out 20% of document-heavy and phone-heavy accounts and send them to the *other* variant (flag `ab_holdout=1` when loading the list).
- **Organic / direct traffic:** always variant A (home). No client-side redirect testing (it hurts SEO and Core Web Vitals).
- **LinkedIn / paid (if approved later):** one ad set per variant.

## Hypotheses and metrics

| # | Hypothesis | Primary metric | Guardrail |
|---|---|---|---|
| H1 | Document-heavy specialties convert better on the fax-first hero than on A | Walkthrough requests / unique visitors | Bounce rate, form-error rate |
| H2 | Phone-first converts better for pediatrics / OB-GYN / family medicine | Walkthrough requests / unique visitors | Same |
| H3 | Leading with "Nothing guessed" (safety) beats an efficiency headline for owner/physician personas | Reply rate on email 1 subject A vs B | Unsubscribe rate |
| H4 | "Book a 20-minute walkthrough" beats "Contact us" as the primary CTA label | Form starts / CTA clicks | Form completion rate |

**Decision rule.** With B2B volumes, don't wait for p < 0.05 on visitor-level conversion. Run each test for at least 3 weeks or 300 visitors per variant, whichever is later; call it when one variant leads by ≥ 30% relative with ≥ 15 conversions each, otherwise keep A. Record every decision in this file.

## Copy bank for future variants

- Hero D (capacity): "More capacity for the team you already have."
- Hero F (vision): "Is your Veradigm® practice ready to be agentified?" (test against A for owner/physician personas; trademark attribution stays on the page)
- Hero G (vision): "Are you ready for the future of your practice?"
- Hero E (after hours): "Your clinic line, answered after hours, by an assistant that can see the schedule."
- Proof-first: open with the four labeled proof cards above the fold.
