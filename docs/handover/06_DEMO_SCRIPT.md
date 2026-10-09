# Demo run of show: Idaho Kidney Institute, Friday Oct 9, 2026, 5:00 PM MT

**Presenter:** Ali Khan. **Line:** (208) 904-3641. **Deck:** see `09_PRESENTATION.md`.

## Before the meeting

| When | Check |
|---|---|
| 2:00 PM | Code freeze. Nothing merges to `main` after this (push to `main` deploys to AWS). |
| 2:00–3:00 PM | Record the backup video: scenarios 1, 2 and 4 with narration. |
| 4:30 PM | Live test call: Ed Smith reschedule end to end. Then John Smith meds. |
| 4:45 PM | Reset sandbox state if the test call moved Ed Smith's appointment (put it back, or note the new time). |
| 4:50 PM | Phone on speaker, backup video open in a tab, deck on slide 1. |

## In the meeting (about 5 minutes of demo)

1. **Slide 1 (cover):** invite the owner to call the number on screen. Hand them the card: *Ed Smith, born December 6, 1952.*
2. **Scenario 1, reschedule (owner calls):**
   - "I need to move my appointment."
   - The agent verifies, lists the visit, offers times, reads back the new time, books it, and confirms the old visit is cancelled.
3. **Scenario 2, chart lookup (Ali calls as John Smith, 01/15/1980):**
   - "What medications am I on? Any allergies on file?"
   - Then: "Should I take an extra dose tonight?" The agent declines to advise and offers a transfer.
4. **Scenario 3, guardrail:** wrong birth date. The agent gives nothing and asks again, then offers a transfer.
5. **Scenario 4, after hours (if built):**
   - Switch to after-hours mode and call with a routine message.
   - Open the Drawbridge app on-call notebook and show the full record and the staff task.
6. Back to the deck: slides 6–12.

## Lines to have ready

- **"Is this real patient data?"** No. This is Veradigm's sandbox with test patients. Your data never leaves your Veradigm system until you approve.
- **"What does it cost us to integrate?"** Nothing. Certification, integration and Veradigm fees are included in our price.
- **"How long until it's live?"**
  - Chart reads can start as soon as you approve and Veradigm licenses it for your site.
  - Scheduling follows Veradigm's review of the new tools, typically 4–6 weeks.
  - Don't promise a date.
- **"What if it gets something wrong?"**
  - It only acts through a fixed set of tools.
  - It reads back every change before making it.
  - It never writes to the chart, never gives medical advice, and transfers on request.

## If something breaks

| Problem | Do |
|---|---|
| Agent says "no appointments" or "no openings" for Ed Smith | Likely a silent Unity error. Switch to the backup video for scenario 1. |
| Patient not found | Check the right sandbox (Unity vs FHIR patient). Retry once, then the video. |
| Line doesn't answer | Backup video. Offer a live call next week. |
| Sandbox down | Backup video for everything. Say Veradigm's test system is down and offer a follow-up session. |
