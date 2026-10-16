# Voice agent v7 experiment: cascade (gpt-4.1) vs speech-to-speech (gpt-realtime-2.1)

Date: 2026-10-15. Brief: the recommendations of `VOICE_LATENCY_REVIEW.md` (Tier 0, Tier 1 and the Tier 3 S2S experiment) and Ali's decisions of Oct 15 (A: try Retell S2S on gpt-realtime-2.1, B: do all three steps, C: no automatic FHIR fallback; system status and help-desk alerting instead).

Nothing was published. No phone number was changed. The live agent (`agent_972b0d5df0a066741f4fe81cc8`, published v6 on +1 208-904-3641) is untouched. All test calls were Retell **web calls** with **synthetic sandbox patients only**.

---

## 1. Summary and recommendation

| | v6 (live) | v7 cascade (gpt-4.1) | v7 realtime (gpt-realtime-2.1) |
|---|---|---|---|
| Tool turn, caller hears something | p50 3.3 s, p90 5.7 s (silence) | **p50 1.36 s, p90 1.73 s** (filler) | p50 1.50 s, p90 3.50 s (its own preamble) |
| Tool turn, caller hears the answer | p50 3.3 s, p90 5.7 s | **p50 2.45 s**, p90 4.43 s | p50 4.92 s, p90 5.98 s (n=4) |
| Plain turn gap | p50 1.42 s, p90 2.60 s | p50 1.39 s, p90 3.06 s | p50 1.51 s, p90 1.96 s |
| Model latency | llm p50 926 ms, p90 3,348 ms | **llm p50 784 ms, p90 1,062 ms** | s2s p50 1,226 ms, p90 1,777 ms |
| Input tokens per LLM request | 4,800 to 5,200 | 3,000 to 3,400 | n/a (Retell reports none) |
| Retell cost per minute (phone) | about $0.175 | **about $0.165** | **about $0.46** |
| Exact safety wording | yes | yes (911 and no-medical-advice lines verbatim) | 911 line verbatim; no-medical-advice line paraphrased |
| Tool accuracy in the tests | see bugs below | right tools and arguments after the fixes | right tools; asks name, last name and DOB one at a time |

**Recommendation: ship the cascade (v7 gpt-4.1) after the Drawbridge code is deployed; do not use speech-to-speech yet.**

- The cascade gets the caller's first audio on tool turns from 3.3 s to about 1.4 s and the answer itself to about 2.4 s, cuts the gpt-4.1 tail (p90 3.3 s to 1.1 s), removes Retell's token surcharge and is about 6% cheaper than v6.
- Realtime was not faster on the turns that matter. Its plain turns are smooth (p90 under 2 s), but tool turns took about 5 s to the answer. It also paraphrases the scripted lines, ignores Retell's static fillers, costs about 2.7 times v6, and Retell's BAA coverage of OpenAI Realtime is not confirmed.
- Re-test realtime after OpenAI or Retell ship tool-turn improvements, or as a half-cascade. Revisit if callers rate naturalness much higher in a blind listen.

The sample is small (3 web calls per variant, 39 turns per variant). Web calls have no telephony leg. Treat these as directional and re-measure on the PSTN before publishing (section 8).

---

## 2. What was built (branch `drawbridge/cert-hardening`)

### 2.1 Call mode at call start: Retell inbound-call webhook
- `POST /webhooks/retell-inbound` (`src/platform/modules/activity/retell-inbound.ts`). Retell calls it before the call connects.
- Drawbridge answers with dynamic variables:
  - `call_mode`: BUSINESS_HOURS or AFTER_HOURS;
  - `records_status`: UP, DOWN, DEGRADED or UNKNOWN;
  - `fhir_tools`: OFF unless `DRAWBRIDGE_FHIR_TOOLS=on`.
- It also warms the Veradigm sessions for the call.
- Verification: Retell's `x-retell-signature` (HMAC-SHA256 of raw body + timestamp, 5-minute window) with `RETELL_WEBHOOK_API_KEY`, the Retell API key with the "webhook" badge (falls back to `RETELL_API_KEY`). It is implemented natively, with no SDK needed. The first live call got 401 because the badged key was not `RETELL_API_KEY`.
- The prompt reads `{{call_mode}}`. The LLM's default variables are `UNKNOWN`, and only then does the agent call `drawbridge_get_call_mode`, which stays for compatibility.
- **Not yet active**: the webhook URL is set per phone number, and this task did not change any number (see section 9).

### 2.2 Unity session keep-warm
- `TokenKeepWarm` (`src/unity/services/unity-health.ts`) and `UnityAuthService.refreshSession()`.
- While a phone-agent tool ran in the last 30 minutes, each system's session is renewed 120 s before the cached token is due.
- The new token replaces the old one only after GetToken and GetUserAuthentication both succeed.
- Settings: `UNITY_KEEP_WARM_MINUTES` and `UNITY_KEEP_WARM_LEAD_SEC`.
- The health check (2.5) also keeps the session alive.

### 2.3 Upcoming visits with a verified search match
- `attachUpcomingVisits` (`src/unity/agent-edge.ts`) runs at the agent edge only. It applies when `unity_search_patients` identifies exactly one patient by first name, last name and date of birth, and the match is not a spelling variant still waiting for the caller's yes.
- The result then carries that patient's next visits:
  - at most 3;
  - date, time, provider, type, status and appointment ID only.
- The lookup is the normal audited `unity_get_patient_appointments` and must finish within `UNITY_SEARCH_VISITS_BUDGET_MS` (2.5 s).
- If it is late or fails, nothing is added. The agent is never told "no visits" because of a failure.

### 2.4 Prompt and tool list near 4k tokens
- **Prompt** (`retell-prompts/unity-healthcare-agent.md`): 9.4k to 6.2k characters.
- **Agent tool list** (`src/platform/agent-tools.ts`):
  - 15.9k to 8.7k characters, about 3.6k tokens together with the prompt;
  - built from the code's own schemas, and the build fails if a listed parameter or required field doesn't exist;
  - all 28 custom functions kept, including the 6 FHIR tools.
- **Safety rules kept**: the exact 911 line, no medical advice, identity before information, read-back before every change, errors are not empty results, RESTRICTED, and a person on request.
- **Removed**: the "fall back to the FHIR tools" instruction.
  - The FHIR tools are gated by `{{fhir_tools}}` (OFF) and never used as a fallback after a Unity error.
  - Tool failures now also say "Do not switch to other tools to work around it."
- **Booking**: the agent passes `providerId`, `locationId` and `departmentId` from the offered slot. Open-slot results now carry those IDs (`[providerId 7, locationId 3, departmentId 12]`), which the old summary dropped.
- **New in the prompt**:
  - today's date (`{{current_time_America/Boise}}`, see bug 3);
  - the call type (a web call can't transfer);
  - the coordinator's two bug fixes (section 6).

### 2.5 System status and help-desk alerting (decision C)
- **Health checker** (`UnityHealthChecker`, `src/unity/services/unity-health.ts`):
  - It probes every configured system (PM, EHR) every 2 minutes. `UNITY_HEALTH_CHECK_MIN` sets the interval, with a 2-minute floor per Veradigm's polling rule.
  - Each probe uses the tools' session (GetToken and GetUserAuthentication when due) plus `GetServerInfo`. That read carries no patient data and is already on the certified action list.
  - A probe times out after 15 s.
  - Two failed probes make a system DOWN. One good probe, or one successful real call, makes it UP.
  - A real call failing with a network, timeout, auth or server error asks for an early probe, still at most one every 2 minutes.
- **System status** (`src/platform/system-status.ts`):
  - Overall status is up, degraded or down. It is kept in `<CALL_RECORDS_DIR>/system-status.json`, so a restart neither forgets an outage nor re-alerts.
  - The status line is "Veradigm PM down (AUTH_ERROR: GetToken: Access is denied)", with the error class and a scrubbed probe detail. There is no PHI and no account name.
- **Staff dashboard** (`src/platform/status-ui.ts`):
  - A red **SYSTEM STATUS** banner on every signed-in page, for example "Veradigm® connection DOWN — Veradigm® PM: DOWN since 2:04 PM — GetToken: Access is denied (AUTH_ERROR)". It also shows messages taken and when the help desk was notified.
  - A status card on Overview and on Veradigm connection, with history.
- **Help desk** (`src/platform/helpdesk.ts`):
  - E-mail via `HELPDESK_SMTP_URL`: smtps://, or smtp:// with mandatory STARTTLS. It never sends in clear text, and a test checks that. Recipients are `HELPDESK_ALERT_TO` (default help@moatit.com) from `HELPDESK_ALERT_FROM`.
  - And/or a JSON webhook (`HELPDESK_WEBHOOK_URL`, https only, optional HMAC signature `HELPDESK_WEBHOOK_SECRET`).
  - De-duplicated:
    - one alert when the connection leaves UP;
    - a reminder every `HELPDESK_REMINDER_HOURS` (4) while it stays down;
    - one alert on recovery;
    - a failed send is retried after 5 minutes.
  - Alerts contain the system, status, times, error class, the probe detail and the **number of messages the agent took during the outage**. No PHI.
- **Audit**: every transition and alert is a security/ops event in the audit log: `system_down`, `system_recovered`, `helpdesk_alert`, `helpdesk_alert_failed`.
- **Phone agent**:
  - While both systems are DOWN, the Veradigm tools answer `RECORDS_UNAVAILABLE` at once (`UNITY_FAIL_FAST_WHEN_DOWN`). Callers don't sit through timeouts.
  - The agent says "I'm sorry, I can't reach our records system right now." and offers a transfer or a message.
  - The new **`drawbridge_take_message`** saves the message in Drawbridge's call record. The caller's name, DOB and callback are marked "as stated, not verified". The message shows in the on-call notebook and is counted for the help-desk alert. SaveTask is impossible while Veradigm is down.
  - The same tool covers an unverified caller and a transfer that is not possible.
- **Not set yet**: `HELPDESK_SMTP_URL` (or a webhook) has to be added to `.env` / SSM. Without it, the banner says "Help-desk alerts are not configured" and a `helpdesk_alert_failed NO_TRANSPORT` event is logged.

### 2.6 Other code changes
- **Successful empty answers** say so unmistakably, for example "SUCCESS: this patient has no upcoming appointments. This is a real answer, not an error." The same applies to open slots, medications, allergies, problems, results and lookups. A search without a match says "NO MATCH (the search worked; not an error)".
- **First-name spelling variant** in `unity_search_patients`. When the full name and DOB find nobody, Drawbridge searches by last name. It accepts a record with the exact DOB, the same (or same-sounding) last name and a same-sounding first name ("Theodoro" heard, "Teodoro" on file). It returns it as "Matched on a spelling variant", which still needs the caller's yes.
- `UnityService.onOutcome` hook, used for passive status.
- `src/scripts/dump-agent-tools.ts` prints the agent tool list.
- `deploy/local/retell/build_v7.py` creates or updates the v7 agents.
- `nodemailer` 10.0.13 is pinned, released Sep 30. `npm audit --omit=dev` reports 0 vulnerabilities.
- **Appointment type per time block** (after the first live booking failed with "Appointment type is not valid for this day and time, requested=ACUTE, available=FOLLOWUP|OV|MEDREC|..."). `unity_get_open_slots` lists the visit types a time allows when its schedule block restricts appointment categories (`Elig_Appointment_Category_ID` / `Inelig_Appointment_Category_ID` mapped through `GetAppointmentTypes`), and its `appointmentType` filter now works. `unity_save_appointment` never swaps the type: when the block (or Veradigm's refusal) does not allow it, nothing is booked and the agent gets `NOT BOOKED (APPOINTMENT_TYPE_NOT_ALLOWED)` with "That time only allows: Follow-up Visit, Office Visit. Ask the caller which one fits, then book again". The prompt source (`retell-prompts/unity-healthcare-agent.md`, plus the compact tool text in `src/platform/agent-tools.ts`) says to choose from the allowed types and ask when unsure. **The Retell agents were not updated or published**; run `build_v7.py` to push the prompt to `agent_243e4907285fbfc2386832f3d8` when Ali decides.

### 2.6a Identity before information, enforced by the server (Oct 15)
Ali asked: "can a caller keep asking and pull any patient's information?" Before this change the answer depended on the prompt: the tool endpoints accepted any patient ID, and patient IDs are small sequential numbers. Now (`src/platform/call-binding.ts`, `SECURITY_CONTROLS.md` §1.2a):
- Each Retell call (`call.call_id`) has its own list of verified patients. A patient is verified only by `unity_search_patients` (or `verify_patient_identity`) with first name, last name and date of birth that matches exactly one patient.
- Every patient tool, and every appointment ID, works only for a patient verified on that call. Otherwise the agent gets `TOOL_ERROR (NOT_VERIFIED ...)` with "verify the caller first", nothing reaches Veradigm®, and a security event is logged.
- At most 2 verified patients per call (caller plus a family member, `DRAWBRIDGE_CALL_MAX_VERIFIED_PATIENTS`) and 5 identity searches (`DRAWBRIDGE_CALL_MAX_SEARCHES`, then `SEARCH_LIMIT`, logged as possible enumeration).
- The v7 prompt (`retell-prompts/unity-healthcare-agent.md`) and the outbound prompt now explain NOT_VERIFIED / SEARCH_LIMIT / VERIFIED_LIMIT, "act only for the verified caller", and the family-member rule. Prompt + tools: about 3,930 tokens (limit 4,200). **The Retell agents were not updated**: re-run `build_v7.py` (never publishes) to put the new prompt on the v7 drafts, and the live v6 prompt needs the same lines before this server change reaches the live line.
- `npm run smoke:call-binding` covers it (9 groups, both HTTP servers end to end).

### 2.7 Tests
- `npm run smoke:voice` passes 9 groups: status, transports, health, keep-warm, agent edge, inbound webhook, take-message, spelling variant, and tool list + prompt.
- Type-check and build pass.
- All other suites pass, except `smoke:scheduling`, which has the known date-fixture failure ("0 !== 3", 10/13/2026 is in the past).
- `smoke:hipaa` needed `npm run docs:hipaa`, because evidence line numbers moved.

---

## 3. Retell agents created (drafts, not published, no phone number)

| Variant | Agent | LLM | Voice |
|---|---|---|---|
| drawbridge-v7-realtime | `agent_7fa79d60e90548f4a5a7e5c30a` (version 0, draft) | `llm_20cb3605f31783a510ddc33756fa`, `s2s_model: gpt-realtime-2.1` (no `model`) | `openai-Marin` |
| drawbridge-v7-cascade | `agent_243e4907285fbfc2386832f3d8` (version 0, draft) | `llm_7da26d4f3f8d7057a74a9fb714a8`, `model: gpt-4.1`, `model_high_priority: false` | `11labs-Grace` (as v6) |

Separate agents were used because Retell keeps one editable draft per agent, so two A/B drafts of the live agent are not possible. Both use the same Drawbridge endpoints (`https://drawbridge.moatit.dev/unity/api/retell` and `/fhir/api/retell`) with the `x-drawbridge-key` header.

Settings on both agents:
- the trimmed prompt and the 28 compact custom functions, plus `end_call` and `transfer_to_staff` (copied from v6);
- `speak_during_execution` with `static_text` fillers on lookups ("One moment while I pull that up.", "Let me check the schedule."), and on writes after the caller's yes ("Okay, booking that now.");
- `timeout_ms` 8000, `max_retry` 0;
- begin message: "Hello! You have reached the automated assistant for Idaho Kidney Institute. How can I help you today?";
- default variables UNKNOWN/UNKNOWN/OFF;
- backchannel on (frequency 0.6), no ambient sound, `vocab_specialization: medical`;
- copied from v6: PII redaction (post-call, 14 categories), signed URLs, `data_storage_setting: everything`, 30-day retention, post-call analysis, interruption sensitivity 0.9 and boosted keywords.

Rebuild or update both with `python deploy/local/retell/build_v7.py`. IDs are in `deploy/local/retell/v7-agents.json`.

**What S2S supports on Retell (observed):**

| Feature | Accepted by the API | Observed in calls |
|---|---|---|
| Custom tools | yes | yes: right tools and arguments, including `patientId` vs `chartPatientId` |
| `begin_message` exact | yes | yes: spoken verbatim |
| Static fillers (`speak_during_execution`) | yes | **no**: the model speaks its own preamble instead ("Okay, I'm going to pull up your record...") |
| Backchannel | yes | not verifiable from transcripts (no recording review) |
| `vocab_specialization: medical`, boosted keywords | yes | unknown: Retell's STT is not in the S2S path. ASR latency is still reported. |
| Voice choice | OpenAI voices only (`openai-Marin`, `openai-Cedar`, etc. are listed) | Marin accepted. Retell also bills a TTS item for the static greeting. |
| Exact safety wording | — | 911 line verbatim. The no-medical-advice line is paraphrased ("I can't give medical advice, including whether to take an extra blood pressure pill, but..."). |
| Transcripts | — | arrive in fragments and late (`"Okay, I'm going to pull" / "up your" / ...`), as the review warned |

---

## 4. Test method

- A headless Chromium (Playwright) ran the Retell web SDK 2.0.8. Its microphone was a WebAudio stream fed with ElevenLabs "Chris" clips (`iP95p4xoKVk53GoZ742B`).
- A scripted responder answered the agent's last question: name, DOB, spelling, callback, message, and yes to read-backs.
- `POST /v2/create-web-call` passed `call_mode=BUSINESS_HOURS`, `records_status=UP` and `fhir_tools=OFF`. The tests run the daytime flow; it was after hours by the clinic schedule.
- Synthetic sandbox patients only: Imogen Fairweather, Teodoro Brightwater and Harlan Quillfeather from the sandbox roster.
- None of the synthetic patients has an upcoming visit in the sandbox, so every appointment question exercised the empty-answer case (coordinator bug 1). No booking was made.
- 3 calls per variant:

| Scenario | What it covers |
|---|---|
| s1 | Identify, next appointment, balance, open times next week (no booking), message to staff |
| s2 | Spelled name, appointments, "a real person" on a web call (transfer impossible), message |
| s4 | Chest pain (911 line), extra-pill question (no medical advice), spelled name, open times next week |

- Metrics come from `GET /v2/get-call`:
  - `latency.*`;
  - `tool_calls[].latency_ms`;
  - word-timestamp gaps split into plain and tool turns;
  - `call_cost.product_costs` (cost / minutes).

**Limitations:**
- The Drawbridge code above is **not deployed** to `drawbridge.moatit.dev`; that dev stack runs the branch head before these changes, and redeploying it would also change what the live v6 agent gets. The tests therefore measured the Retell-side changes (model, fillers, prompt and tools, timeouts, backchannel) against the current server. Upcoming visits with the search, the new SUCCESS wording, slot IDs, `drawbridge_take_message`, the first-name variant, keep-warm and the inbound webhook were covered by the offline suite only. In the cascade s2 call `drawbridge_take_message` returned TOOL_ERROR because the server doesn't have it yet.
- The responder sometimes answered stale realtime transcript text, because S2S transcripts lag. In realtime s1 the caller spoke two requests back to back, and the realtime agent answered only the second. In realtime s4 the responder said goodbye instead of giving its name, so the realtime spelling/open-times path was not reached in s4. It was covered in s2: "Teodoro" was searched correctly.
- Side effects in the Veradigm **sandbox**:
  - 2 staff tasks (SaveTask) for synthetic patients: Imogen Fairweather (EHR 81074) and Teodoro Brightwater (EHR 81069);
  - the read-only appointment check of the 11 roster patients.
- The dev server was in after-hours mode by schedule, so it logged the test calls' tool actions into on-call notebook records. All are synthetic.

Test call IDs:
- cascade: `call_51fc3f1bf018b62005e91ec95d1`, `call_69612fdcd56b1c25f7d84352532`, `call_dc0e92fc37a4d8de611a8a40cc6`;
- realtime: `call_eacf5a842665bd72f4cb0a78da8`, `call_dc77cad3622a5f91bfc276abb39`, `call_2827927c61a37665b7e0a250a80`.

---

## 5. Measurements

### 5.1 Retell latency components (ms)

| Component | v6 (review, 6 calls) | v7 cascade (3 calls) | v7 realtime (3 calls) |
|---|---|---|---|
| e2e (Retell's own, excludes silent tool waits) | p50 1,634, p90 2,996 (n=14) | p50 1,358, p90 2,383, max 3,907 (n=23) | p50 1,514, p90 2,906, max 3,495 (n=21) |
| llm | p50 926, p90 3,348, max 11,287 (n=52) | p50 784, p90 1,062, max 1,467 (n=41) | — |
| s2s | — | — | p50 1,226, p90 1,777, max 2,768 (n=23) |
| tts | p50 184 | p50 179, p90 190 | p50 619 (n=6, greeting/static lines only) |
| asr | p50 198, p95 394 | p50 314, p90 1,256 | p50 237, p90 305 |

The cascade's ASR p90 comes from the long spelled-out answers ("T, E, O, D, O, R, O ..."), where endpointing waits.

### 5.2 Turn gaps from word timestamps (caller's last word to agent's first word, ms)

| Turn | v6 | v7 cascade | v7 realtime |
|---|---|---|---|
| Plain turn | p50 1,419, p90 2,599 (n=21) | p50 1,388, p90 3,063 (n=17) | p50 1,514, p90 1,957 (n=10) |
| Tool turn: first audio | p50 3,332, p90 5,656 (n=12, silent) | **p50 1,361, p90 1,733** (n=13, filler) | p50 1,502, p90 3,495 (n=9, own preamble) |
| Tool turn: the answer | same as above | **p50 2,447, p90 4,434** (n=11) | p50 4,918, p90 5,979 (n=4) |

Tool-turn first audio improved 59% at p50 and 69% at p90. That passes the review's bar (tool-turn gap p50 at least 30% better), subject to the PSTN re-test.

### 5.3 Tool round trips as Retell saw them (ms)

| Tool | v6 p50 | v7 cascade | v7 realtime |
|---|---|---|---|
| unity_search_patients | 785 (max 9,050) | 630 (n=3, max 3,847) | 880 (n=2, max 2,520) |
| unity_get_patient_appointments | 2,498 | 1,296 (n=1) | 288 (n=1) |
| unity_get_open_slots | 1,645 | 708 (n=6, max 2,023) | — |
| unity_get_account_balance | 1,102 | 791 | 915 |
| unity_create_staff_task | — | 1,115 | 640 |

The 3.8 s search was the first call after the server's token had expired. Keep-warm (2.2), once deployed, addresses this.

---

## 6. Quality: bugs found and fixed

| # | Bug | Seen in | Fix | Re-test |
|---|---|---|---|---|
| 1 | A successful "No appointments found." was treated as an error ("I'm having trouble...", transfer offered) | v6 (coordinator) | Server says `SUCCESS: this patient has no upcoming appointments. This is a real answer, not an error.` The prompt explains TOOL_ERROR vs SUCCESS-empty and also treats any "No ... found" without TOOL_ERROR as a real answer. | Every call that reached the question (cascade s1, realtime s1 and s2) told the caller plainly "I don't see any upcoming appointments for you". This was against the current server's old wording, so the prompt fix alone works. |
| 2 | Caller spelled "T-E-O-D-O-R-O" and the agent kept searching misheard variants | v6 (coordinator); **reproduced in cascade s2** (searched "Theodoro" once, then gave up) | Prompt: "Spelled letters always win over the word you heard... search with that"; after two searches without a match, stop guessing and offer transfer or message. Server: first-name spelling-variant fallback (2.6), which needs the caller's yes. | Cascade s4 (same breath, spelled) searched "Teodoro" and matched on the first try. Realtime s2 searched "Teodoro" correctly. |
| 3 | **No current date in the prompt**: v7 cascade s1 searched open times in **June 2024** for "next week" | v7 cascade before the fix (v6 has the same prompt gap) | `Now: {{current_time_America/Boise}}` in the prompt | Cascade s4 searched 10/19 to 10/25/2026 correctly |
| 4 | Web call: transfer impossible | coordinator | Prompt: if the transfer fails or isn't possible, don't retry or loop; offer a message | Both variants said staff can't be reached on this line and took the message (cascade via take_message, which the old server rejects; realtime via unity_create_staff_task for the verified caller) |
| 5 | Realtime transfers immediately after the 911 line (doesn't "offer") and repeats the 911 line on the next turn | realtime s4 | — (model behaviour) | open |
| 6 | Realtime collects first name, last name and DOB in three turns | realtime s1, s2 | — | open: adds about 2 turns per call |

**v6 is affected now** by bugs 1, 2 and 3. Bug 3 means any "next week" date search on the live line is likely wrong. That is reason enough to move to the v7 prompt soon.

---

## 7. Cost per minute (from Retell's `call_cost`, cost / minutes)

| Line item | v6 web (4 calls) | v4 phone (4 calls) | v7 cascade web | v7 realtime web |
|---|---|---|---|---|
| retell_voice_engine | $0.0550 | $0.0550 | $0.0550 | $0.0550 |
| elevenlabs_tts_03_2026 | $0.0399 | $0.0400 | $0.0400 | — |
| gpt_4_1 | $0.0449 | $0.0450 | $0.0450 | — |
| llm_token_surcharge | $0.0123 (applied on the turns over Retell's threshold; $0.06 list) | $0.0121 | **none** | — |
| gpt_realtime_2_1 | — | — | — | **$0.3800** |
| pii_scrubbing | $0.0081 | — (not enabled then) | $0.0100 | $0.0100 |
| us_twilio_telephony | — (web) | $0.0151 | — (web) | — (web) |
| **Total, as measured** | **$0.160** | **$0.167** | **$0.150** | **$0.445** |
| **Total on the phone line** (+ telephony, PII on) | **about $0.175** | | **about $0.165** | **about $0.46** |

Compared with the brief's estimate ($0.21 today vs $0.38 for S2S), the real numbers are about **$0.175 vs $0.46**, which makes realtime **2.6 times** the cost. The S2S line item alone is $0.38. Retell still bills its $0.055 voice engine, plus PII scrubbing and telephony, on top.

At 1,000 call minutes a month: v6 about $175, cascade about $165, realtime about $460.

---

## 8. Before publishing (any variant)

1. **Deploy the Drawbridge code** on this branch to the server the agent calls (dev stack, then AWS). The v7 prompt expects:
   - `drawbridge_take_message`;
   - the SUCCESS wording;
   - slot IDs;
   - upcoming visits with the search;
   - the inbound webhook;
   - the health checker;
   - the per-call verification binding (section 2.6a). Every tool call must carry Retell's `call` object (custom functions do); without a call ID, patient tools answer `CALL_ID_MISSING`. Update the live v6 prompt with the NOT_VERIFIED lines at the same time.

   Set `HELPDESK_SMTP_URL` (or `HELPDESK_WEBHOOK_URL`), `HELPDESK_ALERT_FROM` and `DRAWBRIDGE_PUBLIC_URL` in `.env` / SSM, and `RETELL_WEBHOOK_API_KEY` (the Retell API key with the "webhook" badge; without it the inbound webhook answers 401 unless that key is `RETELL_API_KEY`).
2. **Re-test over the PSTN**: at least 20 calls with the same scripts, per review section 8. Web calls hide telephony latency, and the review's pass rule needs PSTN numbers. Use a separate test number, not 208-904-3641, or a weighted split (step 4).
3. Blind-listen 5 recordings per variant (2 to 3 staff).
4. **Realtime only**: get written confirmation that Retell's BAA covers OpenAI Realtime processing before any real patient call.

## 9. How to publish and roll back (Ali's decision; not done)

Replace `<N>` with the version that `retell_api.py versions <agent>` shows after publishing.

**Option A: publish the v7 cascade agent and point the number at it.**
```
python deploy/local/retell/retell_api.py publish agent_243e4907285fbfc2386832f3d8 0 "v7 cascade"
python deploy/local/retell/retell_api.py versions agent_243e4907285fbfc2386832f3d8      # note the published version <N>
PATCH https://api.retellai.com/update-phone-number/+12089043641
  {"inbound_agents":[{"agent_id":"agent_243e4907285fbfc2386832f3d8","agent_version":<N>,"weight":1}],
   "inbound_webhook_url":"https://drawbridge.moatit.dev/webhooks/retell-inbound"}
```

A gradual alternative: keep v6 and send part of the traffic to v7 with weights:
```
"inbound_agents":[{"agent_id":"agent_972b0d5df0a066741f4fe81cc8","agent_version":6,"weight":0.5},
                  {"agent_id":"agent_243e4907285fbfc2386832f3d8","agent_version":<N>,"weight":0.5}]
```

**Option B: keep the live agent ID.**
1. PATCH `agent_972b0d5df0a066741f4fe81cc8` and its LLM with the v7 settings. `build_v7.py` holds the exact bodies.
2. This creates draft v7. Test it, then run `retell_api.py publish agent_972b0d5df0a066741f4fe81cc8 7`.
3. PATCH the number to `agent_version` 7 and set the inbound webhook URL.

**Rollback**, either option:
```
PATCH https://api.retellai.com/update-phone-number/+12089043641
  {"inbound_agents":[{"agent_id":"agent_972b0d5df0a066741f4fe81cc8","agent_version":6,"weight":1}],
   "inbound_webhook_url":null}
```

Drawbridge's server changes are backward compatible with v6:
- the same tool names, with new ones added;
- the search result can carry upcoming visits;
- empty answers now start with "SUCCESS:".

They can be deployed first, independently of the agent switch.

---

## 10. Moving Drawbridge to AWS (Kanhaiya's infrastructure; documented, not changed)

What the voice path needs from the AWS deployment (`infra/`, see also `SECURITY_CONTROLS.md` §10):

1. **Host**:
   - Run the Unity and FHIR servers in the same US region as Retell's workers. Retell publishes none; us-west-2 is closest to its 100.20.5.228 webhook IP.
   - Put them behind nginx with TLS 1.2+.
   - Only 443 public. 3000/3001 reachable from nginx only.
   - Encrypted EBS (KMS).
2. **DNS**: point `drawbridge.moatit.dev` at the AWS host (or a production name), then re-run `build_v7.py` / update the tool URLs.
   - This takes PHI off the home workstation tunnel.
   - The Cloudflare BAA question (Enterprise only) goes away for the tool path.
3. **Keep-alive**: nginx `keepalive` to the upstream, plus HTTP keep-alive from Retell. The review measured about 95 ms on a reused connection vs about 200 ms on a fresh one.
4. **SSM parameters**:
   - `DRAWBRIDGE_TOOL_KEY`, `RETELL_WEBHOOK_API_KEY` (webhook verification: the Retell key with the "webhook" badge), `RETELL_API_KEY`;
   - `HELPDESK_SMTP_URL` (secret) or `HELPDESK_WEBHOOK_URL` (+ `HELPDESK_WEBHOOK_SECRET`);
   - `HELPDESK_ALERT_TO`, `HELPDESK_ALERT_FROM`, `DRAWBRIDGE_PUBLIC_URL`;
   - plus the existing list in `SECURITY_CONTROLS.md` §10.5.
5. **Persistent volume** for `CALL_RECORDS_DIR` (call records, `system-status.json`) and the audit log, so an outage and its alert state survive restarts.
6. **Outbound access** from the host: Veradigm Unity (443), the SMTP relay (465 or 587 with STARTTLS) or the ticketing webhook, and api.retellai.com.
7. **Monitoring**: alert on `[SYSTEM]` and `[SECURITY] system_down` log lines in CloudWatch, as a backstop if e-mail itself fails.

## 11. What Ali needs to decide

1. **Which variant goes forward.** Recommended: v7 cascade (gpt-4.1). Realtime stays an experiment, at 2.6 times the cost, with slower tool turns, paraphrased safety lines and the BAA unconfirmed.
2. **When to deploy this branch to the dev stack.** It changes what the live v6 line gets, compatibly, and fixes bugs 1 to 3 on the server side for v6 too. The two independent audits apply only if the PCI scope is touched, and it is not: this branch has no payment code.
3. **The help-desk transport**: SMTP relay credentials for help@moatit.com (`HELPDESK_SMTP_URL`, `HELPDESK_ALERT_FROM`) and/or a ticketing webhook URL.
4. **The number change** (section 9), including the inbound webhook URL, and whether to start with a weighted split.
5. **Whether to fix the v6 date bug now**: add `{{current_time_America/Boise}}` to the live prompt as a v6 hotfix draft, independently of v7.
