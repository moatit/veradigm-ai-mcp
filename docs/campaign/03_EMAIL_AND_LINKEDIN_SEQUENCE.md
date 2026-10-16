# Drawbridge launch campaign 3/6: 4-email + LinkedIn sequence

Status: **draft copy, not loaded into any tool, nothing sent.** Sending needs Ali's approval of the copy, the list, the sending domain and the unsubscribe mechanism (see `05_COMPLIANCE_RULES.md`).

**Sender:** Ali Khan, CEO, MOATiT (or Musab for existing clients he manages). From: a person, not "noreply". Reply-to monitored.
**Footer on every email (required):** see the template at the end.
**Merge fields:** `{{first_name}}`, `{{practice_name}}`, `{{specialty}}`, `{{landing_url}}` (from the segmentation output, includes UTM), `{{unsubscribe_url}}`.
**Rules:** plain text or very light HTML; no images needed; one link plus the unsubscribe link; no attachments; no patient data, ever; stop the sequence on any reply, bounce, unsubscribe or booked meeting.

## Cadence

| Day | Channel | Touch |
|---|---|---|
| 0 | LinkedIn | View profile; connection request (note A) |
| 1 | Email 1 | The problem + the promise |
| 4 | Email 2 | How it decides (safety) |
| 6 | LinkedIn | If connected: message B |
| 9 | Email 3 | Proof + shadow week (risk reversal) |
| 13 | LinkedIn | Engage with one post of theirs (like/comment if genuine), or skip |
| 16 | Email 4 | Polite close-the-loop |

Persona variants change only the first two sentences of each email (section "Persona openers").

---

## Email 1: the problem and the promise (day 1)

**Subject A:** The fax pile at {{practice_name}}
**Subject B:** Lab results filed before your first patient

Hi {{first_name}},

Most practices on Veradigm® EHR that we talk to have someone spending a good part of each morning indexing faxed lab results: open, read, find the patient, pick the category, route to the provider. Then the phones start.

We built Drawbridge, MOATiT's AI technology for healthcare practices, to take that load off. It reads incoming faxes and lab results, matches each to exactly one patient on full name and date of birth, files it to the right category in the chart and sends the ordering provider a review task. Its phone assistant answers your line 24/7 and books or moves visits in Veradigm® PM, verifying every caller first.

When it isn't sure, it doesn't guess: the document goes to your staff, already read, with the reason.

Worth a 20-minute look? {{landing_url}}

Ali Khan
CEO, MOATiT · Drawbridge — A MOATiT Service
(208) 900-6628 · (855) 550-6628

## Email 2: how it decides (day 4)

**Subject A:** "Nothing guessed"
**Subject B:** How Drawbridge decides which chart

Hi {{first_name}},

The question we hear first is: what if it files a result to the wrong patient?

Drawbridge follows a few written rules:
- Two identifiers, name and date of birth, matching exactly one patient. If the page also shows an SSN last 4 or an address, those must agree too.
- Look-alike names, twins, a second patient on the page, an unreadable page: it goes to a person.
- Records requests, prior authorizations, refill requests and referrals always go to a person by default.
- Critical lab flags create a High-priority review task marked CRITICAL.

On the phone, the same idea: no record is read or changed until the caller is verified on that call, and every appointment change is read back before it's made. No medical advice; emergencies are told to call 911.

The full list is here: {{landing_url}}

Ali

## Email 3: proof and the shadow week (day 9)

**Subject A:** A week of proof before anything changes
**Subject B:** 0 wrong-patient filings (and how we measured it)

Hi {{first_name}},

We're new, so we won't show you logos. Here's what our testing shows, labeled for what it is:
- 0 wrong-patient filings across held-out synthetic test sets of 3,000 documents (invented patients, Oct 2026).
- On a vendor test system, 20 of 20 auto-filed documents landed in the right chart; everything uncertain went to staff.

Your own documents will differ, so every practice starts with a shadow week: Drawbridge reads everything and files nothing, and compares its decisions with where your staff filed each document. We review every difference with you before anything is switched on.

If that sounds reasonable, pick a time: {{landing_url}}

Ali

## Email 4: close the loop (day 16)

**Subject:** Should I close the file?

Hi {{first_name}},

I haven't heard back, so I'll assume the timing isn't right and stop here.

If faxes or phones become a pain point later, Drawbridge's time-savings calculator shows the numbers for your volumes without asking for an email: https://drawbridge.moatit.com/roi/

Thanks for reading,
Ali

---

## Persona openers (replace the first two sentences)

| Persona | Email 1 opener | Email 2 opener |
|---|---|---|
| Owner / physician | "Results reaching the right chart, and the right provider, is a safety issue before it's an efficiency one." | "As a physician you'll want to know exactly when it files on its own and when it doesn't." |
| Practice manager | "Between the fax pile, the daily lab batch and the phones, front-desk hours disappear before 10 a.m." | "Your staff stay in charge: Drawbridge only files what passes every check." |
| Front-desk lead | "If your morning starts with the fax queue and the lab batch, this is for you." | "You'd still review every uncertain document, just with it already read and matched." |
| IT / security | "We're the IT, phone and security team behind practices across the Intermountain West, and we built Drawbridge to our own standard." | "MFA for every user, a six-year tamper-evident audit log and server-enforced caller verification; the details are on our trust center." |

## LinkedIn

**A. Connection note (≤ 300 chars):** "Hi {{first_name}}, I run MOATiT in Pocatello. We work with practices on Veradigm® on their IT and phones, and just launched Drawbridge for fax/lab intake and calls. Happy to connect."

**B. Message after connecting:** "Thanks for connecting, {{first_name}}. One question I'm asking practice leaders: how much of your team's morning goes to indexing faxed results? We built Drawbridge to file what it's sure of and hand staff the rest, already read. If useful, here's a 2-minute overview: https://drawbridge.moatit.com/?utm_source=linkedin&utm_medium=social&utm_campaign=drawbridge_launch_2026q4 . No pressure either way."

**Company page launch post (Ali + MOATiT page):** "Today we're launching Drawbridge, MOATiT's AI technology for healthcare practices. It files faxed lab results to the right chart and answers the clinic line 24/7, verifying every caller. Our rule: when it isn't sure, a person decides. Integrates with Veradigm® EHR and Veradigm® Practice Management. drawbridge.moatit.com"

LinkedIn rules: manual sends only (no automation tools that violate LinkedIn's terms), ≤ 20 connection requests per day per person, no messages to people who decline or ignore twice, never mention patients or clients by name.

---

## Required footer (every email)

```
Drawbridge — A MOATiT Service
MOATiT, LLC · 2306 Pocatello Creek Rd · Pocatello, ID 83201
(208) 900-6628 · (855) 550-6628 · questions@moatit.com
You're receiving this because {{reason}}. Unsubscribe: {{unsubscribe_url}}
Veradigm® is a registered trademark of Veradigm Inc. or its affiliates; it is named to describe compatibility only.
```
