# Drawbridge launch campaign 6/6: KPIs, tracking plan and launch timeline

## 1. KPIs

**North star:** qualified walkthroughs held (practices on Veradigm® products, 2–40 providers).

| Stage | KPI | Launch target (first 60 days) | Source |
|---|---|---|---|
| Reach | Emails delivered | ≥ 97% of sent | Sending tool |
| | Bounce rate | < 2% | Sending tool |
| | Spam complaint rate | < 0.1% | Postmaster tools |
| Engagement | Reply rate (any) | ≥ 4% | Sending tool / inbox |
| | Positive reply rate | ≥ 1.5% | Manual tag |
| | Unsubscribe rate | < 1% per email | Sending tool |
| | LinkedIn acceptance rate | ≥ 30% | Manual log |
| Site | Visitor → walkthrough request (campaign traffic) | ≥ 3% | Form endpoint + UTM |
| | ROI calculator use → request | ≥ 10% | First-party event (if analytics approved) |
| Pipeline | Walkthroughs held | 15 | Calendar / CRM |
| | Shadow weeks started | 4 | CRM |
| | Shadow week → signed | ≥ 50% | CRM |
| Quality | Lighthouse (all four categories) | ≥ 95 on every page | CI / manual run |

Open rates are unreliable (Apple Mail Privacy Protection); report them, don't optimize for them.

## 2. Tracking plan (privacy-first)

**Today:** the site has no analytics, no cookies and no third-party scripts. The only measurement is UTM parameters captured with the demo form submission.

**UTM convention** (set by `scripts/campaign/segment.mjs`):
`utm_source` = email | linkedin | direct_mail | event; `utm_medium` = outbound | social | referral; `utm_campaign` = `drawbridge_launch_2026q4`; `utm_content` = `<tier>_<persona>` or the email number (`e1`…`e4`).

**Form payload** (to the placeholder endpoint; to be wired to the CRM): name, email, practice, EHR, providers, interest, phone, message, plus `landing_path`, `utm_*` from the URL and the A/B variant. No IP storage beyond standard server logs; no PHI.

**If Ali approves analytics (phase 2):**
- Tool: a cookieless, first-party, self-hostable product (e.g. Plausible or Umami self-hosted on MOATiT infrastructure). No Google Analytics / ad pixels.
- Events: `cta_click` (label, location), `demo_open` (fax | call), `roi_change` (debounced, no values), `form_start`, `form_submit`, `form_error` (field name only), `variant_view` (a | fax | phone).
- Consent: cookieless tools don't need a cookie banner in the US, but the privacy policy must be updated first and Do-Not-Track / Global Privacy Control respected. Add a consent banner before any cookie-setting or third-party tool.
- CSP: add only the analytics origin to `script-src` and `connect-src`.

## 3. Launch timeline (proposed; dates move with approvals)

| Week | Dates (2026) | Milestones | Owner |
|---|---|---|---|
| 0 | Oct 16–23 | Ali reviews site, brand kit and campaign; collects the company list; decides demo CTA destination (calendar link or form → CRM) | Ali |
| 1 | Oct 26–30 | Fix review notes; legal review of `/legal/*`; Musab confirms Veradigm wording; resolve CONFIRM items in `docs/CLAIMS_REGISTER.md` | Ali, Musab, counsel |
| 1 | Oct 26–30 | DNS for `drawbridge.moatit.com` (Ali/Martyn); static hosting + TLS; real form endpoint; sending domain authenticated | Ali, Martyn |
| 2 | Nov 2–6 | Soft launch: site public; LinkedIn launch post; optional personal notes to the priority segment of existing MOATiT IT clients on the list (Ali) | Ali |
| 3–4 | Nov 9–20 | Sequence to Tier A new (≤ 50/day/sender), then Tier B; LinkedIn touches | Sales |
| 5 | Nov 23–27 | Thanksgiving week: pause sends; review KPIs and A/B data | Ali |
| 6–8 | Nov 30–Dec 18 | Continue Tier B; first shadow weeks; update the site's proof section if a client agrees to be named | Ali, Musab |
| After | Dec 2026– | After Veradigm Connect certification: add the official member boilerplate/logo (per guidelines); refresh proof with real (permissioned) shadow-week numbers | Musab |
