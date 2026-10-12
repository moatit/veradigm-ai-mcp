# Onboarding a clinic to Drawbridge document intake

The repeatable process, first used for Idaho Kidney Institute (Oct 2026). MOATiT is usually the clinic's IT, phone and data center provider, so we collect almost everything ourselves and ask the clinic only about policy.

## 1. Internal checklist (MOATiT: Musab and Martyn)

Collected from our own systems. Only counts, settings and locations go in email; anything with patient data stays on our servers.

**Fax traffic** (fax server logs)
- Top senders over the last 3 months (number, name, faxes and pages each)
- Faxes and pages per day: average and peak
- Senders of multi-patient batch faxes
- Resolution today, and whether the clinic's fax setup can receive in fine mode (about 99% read correctly, against about 78% for standard)

**Lab drops** (e.g. Express Lab)
- Folder path, file format (PDF, TIFF, HL7), files and size per day
- What loads them into the EHR today (script, schedule, host). Drawbridge reads them first and hands only uncertain ones to that path.
- Whether results also arrive as structured lab values (results interface)

**Veradigm® EHR / PM** (admin access)
- Document categories in use, with counts per category if possible
- How results and tasks are routed (pools, routing rules)
- Test patients for the pilot
- Appointment types, and which are bookable

**Phone system**
- Hours, daytime transfer numbers, after-hours routing, on-call number

**Legal and access**
- BAA and MOU signed (templates: the IKI drafts in the "VeradigmAI - Drawbridge" Drive folder)
- Dedicated Veradigm integration user (sandbox: portal ticket; production: part of activation)
- A sample folder on the clinic's fax server (past faxes plus recent lab drops) for the shadow week

## 2. Clinic questionnaire (practice manager)

A Google Sheet with 15 questions, most answered from a dropdown, about 5 minutes. Policy only: review and routing, critical results, documents that always go to a person, who checks uncertain documents (logins), categories, test patients, hard senders, indexing shortcuts, and phone booking rules.

- Master template: "Drawbridge setup questions - TEMPLATE (copy per clinic)" in the "VeradigmAI - Drawbridge" Drive folder. Copy it, set the clinic name in B2, and share it with the practice manager as editor.
- To regenerate it: `python tools/onboarding/make_questionnaire.py out.xlsx "Clinic name"`, then upload to Drive (it converts to a Google Sheet with dropdowns).
- Email: three short paragraphs. What Drawbridge does, the sheet link ("about 5 minutes"), and that nothing changes for staff until after the shadow week.

## 3. MOATiT standard process (not asked; told)

- **Patient identification:** full name + date of birth, matching exactly one patient. The last 4 of the SSN or the address is checked when the document shows it. Anything that doesn't line up, or a look-alike patient, goes to a person.
- **Go-live:** one week in shadow mode. Staff index as usual; Drawbridge compares each document with where staff filed it. We review the differences, fix them, then switch filing on.

## 4. Turn answers into settings

| Answer | Setting |
|---|---|
| Reviewer / pool | `INTAKE_REVIEW_USER` |
| Lab category and other category names | `INTAKE_CATEGORY_MAP` |
| Batch senders | `INTAKE_BATCH_SENDERS` |
| Senders or documents always to a person | `INTAKE_NO_AUTO_SENDERS` (plus document rules) |
| Who checks uncertain documents | staff logins (`src/scripts/staff-user.ts`) |
| Matching rule | `INTAKE_MATCH_RULE=name_dob` (standard) |
| Shadow week | `INTAKE_MODE=shadow`, then `INTAKE_FILING=auto` after review |
