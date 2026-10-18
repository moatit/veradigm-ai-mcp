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
- For the shadow week, nothing is needed beyond the integration user: Drawbridge reads the "(ready for indexing)" queue itself, read-only (section 3a). A sample folder on the clinic's fax server (past faxes plus recent lab drops) is still useful for the offline accuracy bench before the shadow week.

## 2. Clinic questionnaire (practice manager)

A Google Sheet with 15 questions, most answered from a dropdown, about 5 minutes. Policy only: review and routing, critical results, documents that always go to a person, who checks uncertain documents (logins), categories, test patients, hard senders, indexing shortcuts, and phone booking rules.

- Master template: "Drawbridge setup questions - TEMPLATE (copy per clinic)" in the "VeradigmAI - Drawbridge" Drive folder. Copy it, set the clinic name in B2, and share it with the practice manager as editor.
- To regenerate it: `python tools/onboarding/make_questionnaire.py out.xlsx "Clinic name"`, then upload to Drive (it converts to a Google Sheet with dropdowns).
- Email: three short paragraphs. What Drawbridge does, the sheet link ("about 5 minutes"), and that nothing changes for staff until after the shadow week.

## 3. MOATiT standard process (not asked; told)

- **Patient identification:** full name + date of birth, matching exactly one patient. The last 4 of the SSN or the address is checked when the document shows it. Anything that doesn't line up, or a look-alike patient, goes to a person.
- **Go-live:** one week in shadow mode. Staff index as usual; Drawbridge compares each document with where staff filed it. We review the differences, fix them, then switch filing on.

## 3a. Rollout: shadow week, go-live, or switch off (Ali, Oct 18, 2026)

**Shadow week: nothing changes for the clinic.** Faxes and lab files keep arriving in Veradigm® EHR's "(ready for indexing)" queue and staff index them as today. Drawbridge reads the waiting documents straight from that queue, read-only (`INTAKE_QUEUE_SOURCE=on` with `INTAKE_MODE=shadow`), works out the patient and category for each, and records what it would have done. When staff index a document, the same DocumentID moves into a chart; Drawbridge reads back where it went and scores itself on exactly that document. Nothing is written to Veradigm® EHR, so nothing is added to the queue and there is nothing to clean up in the clinic's system. Drawbridge's own copies of the queued documents are PHI on Drawbridge's server: they are deleted after 30 days (`INTAKE_SHADOW_RETENTION_DAYS`), and at once when the shadow week ends (go-live step 8, or switch-off). One source per document: with the queue source on, the fax copy (`MOATIT_FAX_*`) and the lab folder (`INTAKE_WATCH_DIRS`) must be off, and the server refuses the queue source otherwise. Where MOATiT already runs the clinic's fax server, a fax copy plus the lab folder can be used instead of the queue.

**Go-live: only after the clinic approves the shadow-week results.** Documents must reach Drawbridge *before* the queue from then on; Drawbridge never files a copy of a document that is already in the queue (it would leave the original waiting there as a duplicate, and the code refuses it). The go-live checklist:

1. **Fax routing.** Incoming faxes go to MOATiT Fax, which sends them to Drawbridge (`MOATIT_FAX_*`).
2. **Lab files.** The lab's daily drop (e.g. Express Lab) goes to Drawbridge's drop folder (`INTAKE_DROP_DIR`) instead of the loader that puts it in the queue.
3. **Fallback if Drawbridge is down.** MOATiT Fax must deliver a fax straight to the clinic's Veradigm® EHR queue when Drawbridge doesn't accept it within a set time (and the lab loader keeps a path to the queue), so a document is never lost or delayed; staff then index it as before. Test this before cutover: stop Drawbridge, send a test fax, confirm it reaches the queue, start Drawbridge again.
4. **Documents Drawbridge can't file.**
   - Patient found but not certain enough, or a type the clinic always gives to a person: sent to the patient's chart as "(ready for indexing)" (`SaveScanDocument`), where staff work them as today.
   - No patient found (filing needs a patient): stays on Drawbridge's **Needs review** screen (`/app/intake`). Agree with the clinic who checks it and how often, and alert the help desk when anything waits there longer than one business day.
5. **Cutover day.** Whatever is already waiting in the queue, staff finish as usual. Drawbridge never reads the queue as a source in live mode (`INTAKE_QUEUE_SOURCE` is ignored outside shadow mode).
6. **Phone.** The clinic line forwards to Drawbridge's number first; the number is ported later.
7. **Switch filing on:** `INTAKE_MODE` unset (live), `INTAKE_FILING=auto` (or `review` first).
8. **Delete the shadow-week copies.** Save the shadow report (`npm run eval:shadow`), stop the intake server, run `npm run intake:purge-shadow -- --yes`, then start it in live mode. Undecided shadow items would otherwise sit in the live Needs-review list until retention removes them.

**Not approved: switch it off.** Save the shadow report, stop the server, run `npm run intake:purge-shadow -- --yes`, and turn the intake module off (`ENABLED_MODULES` without `intake`, or leave the server stopped). Nothing in the clinic's systems changed during the shadow week, and Drawbridge keeps no copy of their documents.

**Open question for Veradigm (after the shadow week; not yet asked):** the Unity API reference has no action to index, move or change the status of a document already in the "(ready for indexing)" queue. If one exists, Drawbridge could index the waiting documents in place and the clinic would never need to change its fax or lab routing. Draft wording: `DRAWBRIDGE_BUILD_PLAN.md`, "Intake rollout per clinic".

## 4. Turn answers into settings

| Answer | Setting |
|---|---|
| Reviewer / pool | `INTAKE_REVIEW_USER` |
| Lab category and other category names | `INTAKE_CATEGORY_MAP` |
| Batch senders | `INTAKE_BATCH_SENDERS` |
| Senders always to a person | `INTAKE_NO_AUTO_SENDERS` |
| Documents always to a person (records requests, prior authorizations, refill requests, referrals) | `INTAKE_ALWAYS_PERSON` (unset = all four, `none` = off) |
| Critical results: who is informed | `INTAKE_CRITICAL_NOTIFY` (unset = the review task's normal recipient). Always High priority with "CRITICAL" first and a phone call recorded as required; Drawbridge never calls |
| Who reviews results (the ordering provider, or a reviewer / pool) | `INTAKE_TASK_TARGET=ordering_provider` or `review_user`; `INTAKE_REVIEW_USER` is the fallback |
| Notify the provider of results for same-day appointments? | `INTAKE_SAME_DAY_NO_NOTIFY=on` when they don't (critical results always notify) |
| Who checks uncertain documents | staff logins (`src/scripts/staff-user.ts`) |
| Matching rule | `INTAKE_MATCH_RULE=name_dob` (standard) |
| Shadow week | `INTAKE_MODE=shadow` + `INTAKE_QUEUE_SOURCE=on` (documents from the indexing queue, read-only); at go-live `INTAKE_MODE` unset and `INTAKE_FILING=auto` after review (section 3a) |

**Idaho Kidney Institute (answers of Oct 13, 2026):** `INTAKE_ALWAYS_PERSON=records_request,prior_auth,refill_request,referral`, `INTAKE_TASK_TARGET=ordering_provider`, `INTAKE_SAME_DAY_NO_NOTIFY=on`, `INTAKE_CATEGORY_MAP={"lab_result":"Lab Results"}`; `INTAKE_CRITICAL_NOTIFY` unset until the clinic names who gets critical results (then the ordering provider, or `INTAKE_REVIEW_USER`, gets them). What each does: [FAX_INTAKE_ADDON.md, Clinic rules](FAX_INTAKE_ADDON.md#clinic-rules-set-per-clinic).
