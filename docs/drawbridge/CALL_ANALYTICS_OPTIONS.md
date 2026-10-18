# Call analytics: options not built yet

Written Oct 18, 2026, as a proposal for the owner to decide on. **Nothing here is built.** The call records in `CALL_ANALYTICS.md` work without either option.

---

## Option A: a post-call satisfaction question

Today satisfaction is a proxy:
- the analysis model's **caller sentiment**;
- whether the call was **resolved** or **transferred**;
- **repeat calls** within 24 hours;
- disconnections such as `user_hangup` before resolution.

A direct question gives a real score. There are two ways to ask it, and a practice could have either, both or neither.

### A1. Keypad question at the end of the call (recommended first)

- **What the caller hears**, after the agent has finished helping: "Before you go, how did I do today? Press 1 to 5, where 5 is great. Or just hang up." One question, asked once, skipped on urgent, after-hours on-call, transferred and outbound calls.
- **How:**
  - The agent prompt gets a closing step.
  - A new Drawbridge tool, `drawbridge_record_satisfaction`, takes `{ score: 1..5 }` and the call ID from the platform, never from the caller.
  - Keypad input uses the platform's DTMF capture. If the caller says a number instead, the agent maps it to 1 to 5.
- **Stored:** only the score, `null` if skipped, on the call record (new fields `satisfaction_score` and `satisfaction_asked`). No comment and no free text; if the caller adds remarks, nothing is captured.
- **Reports:** average score and response rate by practice, by call reason and over time. Low scores (1 or 2) are listed by call ID, so staff can review that call in the stack.
- **Cost:** about 5 to 10 seconds per answered call. Expect 20 to 40% of callers to answer.
- **Risks:**
  - It must never delay an urgent path.
  - The prompt change needs the usual agent review and an A/B on a draft version.
  - A score with a call ID isn't PHI by itself, but it stays tied to the call record and its rules.

### A2. SMS survey (only where the practice opts in)

- One text after the call: "Thanks for calling <Practice>. Reply 1 to 5 to rate the call." It's sent only to inbound mobile callers who don't object, and never after urgent or clinical calls.
- **This needs:**
  - TCPA review;
  - practice opt-in;
  - an opt-out (STOP) list, which the outreach module already keeps;
  - a carrier and 10DLC registration;
  - an SMS provider under a BAA.

  Under HIPAA the text itself is a disclosure that the person contacted the practice, so keep it generic.
- **Stored:** the score only, matched to the call inside the stack. The admin app gets the score on the call record, never the number.
- **Recommendation:** don't start here. A1 has no new vendor and no consent questions.

---

## Option B: a PHI-safe transcript store (for search and topic mining)

Searchable transcripts let staff and MOATiT find "every call about a prior authorization" and mine topics beyond the fixed enums. Transcripts are **PHI**: names, dates of birth, symptoms, medications. So the store belongs **inside each practice's Drawbridge stack**, never in the admin app.

### Placement and the BAA chain

- **Location:** the per-practice stack's encrypted data volume, or its database if one is added, next to the on-call records. The admin app gets only the categories this store produces. It never gets text.
- **BAAs:**
  - practice ↔ MOATiT (business associate);
  - MOATiT ↔ voice vendor (subcontractor; transcripts are created there);
  - MOATiT ↔ the hosting provider of the stack;
  - MOATiT ↔ any model provider used for topic mining. Mining has to run under a BAA, in the stack or with a provider that has signed one.
- **Fetching:** after `call_analyzed`, the stack fetches the transcript from the vendor's get-call API over TLS. The webhook body already carries it, but the stack shouldn't keep webhook bodies. It then stores the transcript **without the recording URL**. Recordings stay with the vendor, or are turned off, which is the vendor's opt-out setting.

### Encryption

- **At rest:** AES-256-GCM per transcript, with a per-practice data key. The data key is wrapped by a key in the practice's KMS or secret store, never in `.env` in clear.
- **On disk:** the volume itself is encrypted, as it is today (`HIPAA_TECHNICAL_SAFEGUARDS.md`), which gives two layers.
- **Rotation:** rotating the key re-wraps the data keys. Deleting the practice's key crypto-erases everything.
- **In transit:** TLS 1.2+ end to end. No transcript in logs, error messages, URLs or support tickets.

### Retention

- **Default:** 90 days for searchable text, configurable per practice (`TRANSCRIPT_RETENTION_DAYS`). Kept for that window and then deleted, so there's no indefinite archive. The categories (call reason, topics) can live as long as the call record.
- **Legal hold:** a practice administrator can hold specific call IDs, and every hold is audited.
- **Deletion:** a daily job, `startDailyRetention`, deletes expired transcripts. The vendor-side copy follows the vendor's retention setting, which should be set to the same window.

### Access

- Staff screen in the stack only: `/app/calls/<id>/transcript`. There's no admin-app view and no export by default.
- **Roles:**
  - a new `transcripts` permission held by named staff users (privacy officer, practice manager);
  - administrators grant it;
  - MOATiT support gets no standing access. It's break-glass only, which needs the practice's approval, expires, and is audited.
- **Audit:** every view and search is written to the hash-chained audit log (`kind: "view"` with `object: "transcript:<call_id>"`), so it shows on the access and disclosure report per patient and per staff user. Unusual volume raises the existing security event.
- **Minimum necessary:** search results show call ID, time and matching category, and open the full text only on click (logged). Patient IDs are linked only where a tool call already bound one.

### Topic mining

- **Inside the stack:** a job reads each new transcript and assigns topics from a practice-approved list, plus "other" for review. Only the topic IDs go onto the call record, so they reach the admin app as more enums.
- **Free-text topics** (for discovering new categories) are reviewed in the stack by a person with transcript access. A topic name is promoted to the approved list by hand, never automatically.
- **Prompts for the mining model** must never be logged with transcript text.

### Effort (rough)

| Piece | Effort |
|---|---|
| Fetch, encrypted store, retention job | 3 to 4 days |
| Staff screen, permission, audit, search | 3 days |
| Topic mining with an approved list | 2 to 3 days |
| BAA paperwork and the vendor retention setting | organizational |

### Decision needed

1. Do we want searchable transcripts at all, or are the fixed enums plus option A enough for now?
2. If yes: the retention window, who gets the `transcripts` permission at each practice, and which model provider (under a BAA) does the topic mining.
