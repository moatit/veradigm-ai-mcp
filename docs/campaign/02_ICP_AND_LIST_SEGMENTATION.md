# Drawbridge launch campaign 2/6: ICP, list import and segmentation

**Nothing here contacts anyone.** The segmentation script reads a CSV and writes CSVs locally. Sending is a separate, approved step (see `05_COMPLIANCE_RULES.md`).

## 1. Ideal customer profile

**Must have**
- A US medical practice running **Veradigm® EHR and/or Veradigm® Practice Management** (Ali's company list).
- 2–40 providers, one to five locations.
- Receives faxed or dropped lab results and outside documents daily, and has a staffed front desk / phone line.

**Strong fit signals (score up)**
- Specialty with heavy outside results: nephrology, internal medicine, family medicine, endocrinology, cardiology, oncology, rheumatology, gastroenterology, urology, OB/GYN, pediatrics.
- Daily lab batch files from a reference lab.
- Located where MOATiT already operates (Idaho, Utah, Wyoming, Montana; Intermountain West) or already a MOATiT IT / phone / fax / EHR-hosting client.
- Practice-management staff titles present (practice manager, administrator, office manager).
- Hiring for front-desk / medical records / indexing roles (manual research signal).

**Disqualifiers**
- Hospital-owned or health-system-employed groups with central IT procurement (route to a separate enterprise track later).
- Practices not on Veradigm® products (keep for a "notify me" list only).
- Any record without a lawful basis to email (see compliance rules) or on the suppression list.

## 2. CSV import format

Ali's company list may arrive in any shape; map it to these columns (`docs/campaign/templates/company_list_template.csv`). Only business contact data. **Never patient data.**

| Column | Required | Example | Notes |
|---|---|---|---|
| `company_id` | yes | `C-000123` | Stable ID; generated if missing |
| `practice_name` | yes | `Example Family Medicine, PLLC` | |
| `website` | no | `examplefm.com` | Used for dedupe and research |
| `specialty` | no | `Internal Medicine` | Free text; normalized by the script |
| `providers` | no | `6` | Number or range |
| `locations` | no | `2` | |
| `city`, `state`, `zip` | state yes | `Boise`, `ID`, `83702` | |
| `ehr` | yes | `Veradigm EHR` | Any of: Veradigm EHR, Veradigm PM, both, other, unknown |
| `pm` | no | `Veradigm PM` | |
| `is_moatit_client` | no | `yes` | yes/no |
| `contact_first`, `contact_last` | no | | One row per contact; company repeats |
| `contact_title` | no | `Practice Manager` | Mapped to a persona |
| `contact_email` | no | | Business email only |
| `contact_phone` | no | | Business line only; **no cold texting** |
| `linkedin_url` | no | | For manual LinkedIn touches |
| `source` | yes | `Ali list 2026-10` | Where the record came from (needed for consent records) |
| `consent_basis` | yes | `existing_customer` / `business_contact` / `opt_in` | See compliance rules |
| `do_not_contact` | no | `yes` | Hard suppression |

## 3. Segmentation

Script: `node scripts/campaign/segment.mjs <input.csv> [outdir]` (default `data/segments/`, git-ignored). It:
1. normalizes headers, trims fields, lower-cases emails, and validates email syntax;
2. drops rows with `do_not_contact=yes` or present in `data/suppression.csv` (emails or domains);
3. de-duplicates contacts by email and companies by website/name + state;
4. maps titles to personas (owner/physician, practice manager, front-desk lead, IT, other);
5. scores fit (0–100) and assigns a tier;
6. writes one CSV per segment plus `summary.json` (counts only).

**Fit score**

| Signal | Points |
|---|---:|
| On Veradigm® EHR **and** PM | 30 (one of them: 20; unknown: 5) |
| Providers 2–40 | 20 (1 or 41–100: 8) |
| High-document specialty | 15 |
| Existing MOATiT client | 15 |
| In MOATiT's region (ID, UT, WY, MT, NV, OR, WA, CO) | 10 |
| Named practice-manager-type contact | 10 |

**Tiers:** A ≥ 70 (personal outreach by Ali/Musab + sequence), B 45–69 (sequence), C < 45 (newsletter / nurture only, after opt-in).

**Segments written**

| File | Who | Track |
|---|---|---|
| `seg_A_existing_clients.csv` | Tier A, MOATiT clients | Personal email from Ali + walkthrough offer |
| `seg_A_new.csv` | Tier A, not clients | 4-email + LinkedIn sequence, fax-first or phone-first variant by specialty |
| `seg_B.csv` | Tier B | 4-email sequence |
| `seg_C_nurture.csv` | Tier C | No cold sequence; content/newsletter only with opt-in |
| `by_persona/*.csv` | All contacts by persona | Persona-specific copy |
| `rejected.csv` | Invalid email, suppressed, duplicates | With reason column |

**Variant assignment:** nephrology, internal medicine, endocrinology, oncology, cardiology → *fax-first* (`/lp/fax/`); pediatrics, OB/GYN, family medicine, dermatology, orthopedics → *phone-first* (`/lp/phone/`); others alternate A/B by `company_id` hash (see `04_AB_TESTS.md`).
