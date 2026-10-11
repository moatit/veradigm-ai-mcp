# intake-synth: synthetic faxes and lab results

Generates large, seeded sets of **invented** documents for the intake accuracy bench (`npm run eval:intake`). Every person, MRN, phone number (555-01xx), provider, lab and clinic is made up; no real logos or trademarks. Output goes to a git-ignored folder (`deploy/local/intake/synth/`).

```
docker build -t drawbridge-intake-synth tools/intake-synth
docker run --rm --network none -v "<repo>/deploy/local/intake/synth:/out" drawbridge-intake-synth \
  generate --roster 300 --docs 1000 --seed 42 --out /out/set-s42
```

Same seed and arguments give the same documents (each document has its own RNG, so `--workers` does not matter). 1,000 documents take about 15 s.

## What it makes

- **Roster** (`roster.json`): patients with both Veradigm MRNs (PM MRN and EHR chart MRN / PatientNumber), home and cell phones, and hard cases: same name with a different DOB, true duplicates (same name and DOB, different MRNs), sound-alike last names (Beasley / Beesly, two pairs also share the DOB), hyphenated, apostrophe and two-word surnames, twins (same last name, DOB and phone), households sharing a phone. `outside.json` holds people who are not in the roster, some with a roster patient's full name.
- **Six layouts** (`synth/layouts.py`): reference lab, hospital lab (its own `H…` MRN or ours), small clinic (point-of-care, plain `Phone:`), daily batch (stand-in for "Express Lab", one or several patients), renal ultrasound, consult letter. Varied labels (`DOB` / `Date of Birth` / `Birthdate` / `D.O.B.`, `Patient:` / `Patient Name:` / `RE:` / `PT:`), name orders and date formats. Some multi-page, some with a fax cover sheet.
- **Content** (`synth/content.py`): BMP/CMP/renal panel, creatinine, eGFR, BUN, K, phosphorus, calcium, PTH, vitamin D, CBC, urinalysis, UACR, HbA1c, lipids, driven by a CKD stage, with reference ranges and H/L/HH/LL/critical flags.
- **Quality** (`synth/fax.py`): clean text-layer PDF (emailed), or a fax copy: fine 204x196 or standard 204x98 dpi, black and white, ±2° skew (±3° poor), speckle, streaks, a fax header line, saved as multi-page TIFF (Group 4 or Group 3) or an image-only PDF.
- **Ground truth** (`truth/<id>.json`): intended patient (roster key, `not_in_roster` or `multiple`), the expected match decision (the matching rules applied to what is printed), printed name/DOB/MRN/phone, kind, sender, collection date, abnormal flags, layout, quality, container.

Cases per 1,000 documents (approx.): normal 500, no MRN 100, wrong MRN 55, not in roster 75, duplicates 40, same name / different DOB 40, sound-alike 40, hyphen/apostrophe 40, multi-patient batch 30, twins 20, households 20, two-word surnames 20, outdated phone 15, DOB typo 15.
