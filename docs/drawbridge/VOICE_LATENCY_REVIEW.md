# Drawbridge voice agent: latency and naturalness review

Date: 2026-10-15. Scope: Retell agent `agent_972b0d5df0a066741f4fe81cc8` (published v5 on +1 208-904-3641, draft v6), Retell LLM `llm_6f0eb9c3edb1f2d62cb7fe5b02fe`.
Method: read-only. Retell config via GET, call metrics via `POST /v3/list-calls` + `GET /v2/get-call/{id}` (latency and tool-timing fields only, no transcripts), Drawbridge audit log (`/app/data/audit/*.jsonl`, latency_ms only), and curl timing of `https://drawbridge.moatit.dev/unity/health`. Nothing was created, updated, published or called in Retell.

Caveat: the sample is small. Retell has 6 calls for this agent (4 phone calls on v4 on Oct 9, 2 web calls on v6 on Oct 15; none on v5 yet), giving 52 LLM turns, 14 e2e samples and 17 tool calls. The Drawbridge audit log has 316 tool executions (Oct 8 to 15). Treat the numbers as directional and re-measure after each change.

---

## 1. Summary

The agent is slow for three stacked reasons, in order of impact:

1. **Silent tool turns (biggest perceived problem).** Every one of the 27 custom tools has `speak_during_execution: false`. A turn that calls a tool is LLM (decide + emit tool call) -> HTTPS round trip -> Veradigm -> LLM again -> TTS, with dead air the whole time. Measured user-stops-talking to agent-starts-talking gap: **p50 3.3 s, p90 5.7 s, max 6.1 s on tool turns**, versus p50 1.4 s on plain turns. Turns longer than about 2 s are where callers say "hello?".
2. **LLM time to first token (gpt-4.1 with about 5,000 input tokens per turn).** Retell `llm` latency: **p50 926 ms, p90 3.3 s, p95 4.7 s, max 11.3 s**; 26% of LLM turns exceed 2 s. Prompt is about 2,350 tokens plus about 5,800 tokens of tool schemas (29 tools); Retell reports 4,600 to 6,000 tokens per request. Retell also bills an `llm_token_surcharge` because of this size.
3. **Backend tail latency.** Veradigm Unity sandbox calls are mostly fast (server-side p50 241 ms across 316 calls) but have heavy tails: `unity_search_patients` max 8.8 s (cold Unity token after 19+ min idle), `unity_get_patient_appointments` p50 660 ms / max 3.6 s. The FHIR fallback tools (`verify_patient_identity`, `get_allergies`) **failed 17 of 17 times** with p50 about 2.9 s and up to 33 s, and the prompt tells the LLM to fall back to them on Unity errors, so a failure costs a second silent round.

Not the problem:
- **Cloudflare tunnel to the workstation:** Retell-observed tool time minus server-side time is **median 170 ms (108 to 382 ms)** per tool call. From this machine, `/unity/health` via the tunnel is about 190 to 200 ms on a fresh TLS connection and about 95 ms on a reused one (local origin: 4 ms; edge PHX). Worth fixing for production for reliability and HIPAA reasons, but it is only 5 to 10% of a tool turn.
- **TTS (ElevenLabs via Retell):** p50 184 ms, p95 210 ms.
- **ASR:** p50 198 ms, p95 394 ms.

Retell's measured e2e (user end of speech to agent audio) is **p50 1.63 s, p90 3.0 s** on non-tool turns; Retell's own guidance targets well under 1 s. ChatGPT voice feels better because a speech-to-speech model starts audio in a few hundred ms, produces backchannels and prosody natively, and has no tool calls to a remote EHR in its typical turn.

---

## 2. Current configuration (published v5; draft v6 is identical in all latency-relevant fields)

| Setting | Value | Note |
|---|---|---|
| LLM model | `gpt-4.1` | Strong tool use, but slowest of the GPT-4.1 family to first token |
| `model_high_priority` (fast tier) | not set | |
| `s2s_model` | not set | cascaded STT -> LLM -> TTS |
| Prompt size | 9,412 chars, about 2,350 tokens | |
| Tools | 29 (27 custom webhooks + end_call + transfer), schemas about 5,800 tokens | 7 FHIR backup tools that currently always fail |
| Input tokens per LLM request | p50 5,000, max 6,006 | triggers Retell token surcharge |
| `speak_during_execution` | **false on all 27 custom tools** | silent tool turns |
| `speak_after_execution` | true | |
| Tool `timeout_ms` | 20,000 | a hung backend = up to 20 s of silence |
| `begin_message` | static greeting | good: no LLM call for the greeting |
| `drawbridge_get_call_mode` | prompt says call it at the start of every call | adds an LLM tool round to the first caller turn |
| Voice | `11labs-Grace`, `voice_speed` 1, `voice_temperature` 1, no `voice_model` set | |
| `responsiveness` | not set (default 1) | |
| `interruption_sensitivity` | 0.9 | |
| `enable_backchannel` | not set (off) | |
| `ambient_sound` | `mountain-outdoor` | odd choice for a clinic line; can sound like noise on PSTN |
| `boosted_keywords` | 7 demo names | fine |
| `end_call_after_silence_ms` | 603,000 | |
| `data_storage_setting` | `everything` | relevant to HIPAA posture (see section 6) |
| `pii_config` | post_call, no categories | |

Retell cost breakdown on a sample call (per minute): Retell voice engine $0.055, ElevenLabs TTS $0.040, gpt-4.1 $0.045, token surcharge $0.060 (prompt size), Twilio $0.015.

---

## 3. Measurements

### 3.1 Retell latency breakdown (6 calls pooled, ms)

| Component | n | p50 | p90 | p95 | max |
|---|---|---|---|---|---|
| e2e (non-tool turns as reported by Retell) | 14 | 1,634 | 2,996 | 3,225 | 3,335 |
| llm | 52 | 926 | 3,348 | 4,707 | 11,287 |
| tts | 47 | 184 | 204 | 210 | 265 |
| asr | 32 | 198 | 331 | 394 | 462 |

By version: v4 phone calls llm p50 943 / p90 3,813 (n=45); v6 web calls llm p50 751 / p90 1,385 (n=7).

### 3.2 Turn gaps from word timestamps (user last word end -> agent first word start)

| Turn type | n | p50 | p90 | max |
|---|---|---|---|---|
| No tool call | 21 | 1,419 ms | 2,599 ms | 3,335 ms |
| Tool call in the turn | 12 | **3,332 ms** | **5,656 ms** | 6,115 ms |

### 3.3 Tool round trips as Retell saw them (`tool_calls[].latency_ms`)

| Tool | n | p50 | max |
|---|---|---|---|
| unity_search_patients | 7 | 785 | 9,050 |
| unity_get_patient_appointments | 2 | 2,498 | 3,738 |
| unity_get_open_slots | 2 | 1,645 | 2,321 |
| unity_get_account_balance | 2 | 1,102 | 1,623 |
| unity_get_insurance_policy | 2 | 1,082 | 1,637 |
| unity_save_appointment | 1 | 580 | 580 |
| transfer_to_staff | 1 | 5,462 | 5,462 |
| All custom tools | 17 | 1,259 (p90 4,428) | 9,050 |

### 3.4 Network overhead (Retell -> Cloudflare -> workstation -> back)

Matched 16 Retell tool calls to the server-side audit rows for the same call_id and tool: overhead = Retell latency - server latency = **median 170 ms, min 108, max 382**.

curl from this workstation (hairpins out to the Cloudflare edge, PHX):
- fresh connection: DNS about 7 ms, TCP about 50 ms, TLS done about 105 ms, total about 190 to 200 ms;
- reused connection: about 95 ms;
- origin directly on 127.0.0.1:8095: about 4 ms.

### 3.5 Drawbridge server-side latency (audit log, 316 rows, Oct 8 to 15, ms)

| Tool | n | p50 | p95 | max |
|---|---|---|---|---|
| unity_search_patients | 114 | 244 | 1,070 | 8,823 |
| unity_get_open_slots | 24 | 223 | 895 | 2,110 |
| unity_get_providers | 16 | 204 | 537 | 1,387 |
| unity_get_patient_appointments | 16 | 660 | 1,712 | 3,620 |
| unity_get_account_balance | 16 | 360 | 718 | 1,471 |
| unity_get_insurance_policy | 16 | 204 | 614 | 1,255 |
| unity_get_appointment_details | 14 | 402 | 482 | 495 |
| unity_get_patient_medications | 14 | 208 | 279 | 284 |
| verify_patient_identity (FHIR) | 10 | 2,842 | 20,616 | 33,102 |
| get_allergies (FHIR) | 7 | 3,085 | 21,092 | 27,546 |
| drawbridge_previsit_check | 7 | 904 | 930 | 936 |
| drawbridge_get_call_mode | 8 | 1 | 1 | 1 |
| other unity_* tools | 5 to 7 each | 188 to 728 | under 1,200 | |
| **All** | 316 | **241** | **1,592** | 33,102 |

Retell channel: successful calls p50 229 / p95 1,189 ms (n=184); failed calls p50 2,576 / p95 27,546 ms (n=21, all FHIR plus a few Unity).
All 17 FHIR tool calls via Retell returned `UNKNOWN_ERROR`.

### 3.6 Where the time goes in a typical tool turn (p50, about 3.3 s)

| Step | ms |
|---|---|
| ASR finalisation + endpointing (responsiveness default) | about 200 to 400 |
| LLM pass 1 (decide and emit the tool call) | about 900 |
| Network to Drawbridge and back (tunnel) | about 170 |
| Veradigm Unity (server side) | about 250 to 700 |
| LLM pass 2 (phrase the result) | about 900 |
| TTS first audio | about 185 |
| **Total silent time** | **about 2.6 to 3.3 s** (p90 5.7 s) |

So about 55 to 65% of a tool turn is the two gpt-4.1 passes, 15 to 25% is Veradigm, 5% is the tunnel.

---

Retell's dashboard `e2e` metric counts only turns where the agent speaks, so silent tool waits are **not** in it (per Retell's latency docs). The dashboard therefore understates what callers hear. Use the word-timestamp gap in 3.2 as the main KPI.

---

## 4. What Retell offers today (docs checked 2026-10-15)

Sources: docs.retellai.com API reference (create-agent, create-retell-llm), `build/llm-options`, `reliability/troubleshoot-latency`, `reliability/check-actual-latency`, `build/single-multi-prompt/custom-function`, `general/compliance`, retellai.com/pricing and changelog. UNVERIFIED marks claims not confirmed in an official Retell source.

### 4.1 LLM choice and Fast Tier
- `model` options include gpt-4.1, gpt-4.1-mini, gpt-5 / 5.x / 6.x families, Claude 4.5 to 5.5 (Sonnet/Haiku/Opus) and Gemini 3.x Flash. Retell's default is now gpt-5.6-terra. gpt-4.1 is still supported.
- **Fast Tier** = `model_high_priority: true`. It uses a dedicated pool. Retell claims a 50% reduction in latency variance and 25% better average response time. For gpt-4.1 it costs 1.5x ($0.045 -> $0.0675/min); GPT-5.x is shown at 2x on the pricing page.
- Retell's latency guide says smaller models are faster and that every prompt token adds to time to first token. Tool schemas count toward the prompt.
- Price reference: gpt-4.1-mini $0.0128/min, gpt-5.6-terra $0.064/min, voice infrastructure $0.055/min.

### 4.2 Speech-to-speech (S2S)
- The Retell LLM has `s2s_model`, which replaces `model` (you set one or the other, not both). Values: gpt-realtime-2.1, gpt-realtime-2.1-mini, gpt-realtime-2, gpt-realtime-1.5, gpt-realtime, gpt-realtime-mini.
- Retell price: $0.38/min for realtime-2 / 2.1, $0.345 for gpt-realtime / 1.5, $0.07 for mini. This replaces both the LLM and the TTS line items.
- Not documented by Retell (UNVERIFIED): whether knowledge base, begin_message, backchannel, boosted keywords and medical vocab work under S2S. Voices appear limited to OpenAI voices (openai-Ash / Coral / Sage per a changelog snippet).
- The call object has an `s2s` latency field for these calls.
- A community thread reports gpt-realtime on Retell missing short replies such as "yes" (anecdotal).

### 4.3 Agent settings that affect latency and naturalness

| Setting | Range / default | Ours | Note |
|---|---|---|---|
| `responsiveness` | 0 to 1, default 1 | default | already fastest |
| `enable_dynamic_responsiveness` | default false | off | adapts the wait to the caller's pace |
| `interruption_sensitivity` | 0 to 1, default 1 | 0.9 | |
| `enable_backchannel` / `backchannel_frequency` | off / 0.8 | off | "mm-hm", "got it" while the caller talks: big naturalness win |
| `stt_mode` | fast (default) / accurate / custom | default (fast) | custom lets you set endpointing (Deepgram minimum 10 ms) |
| `vocab_specialization` | general / medical | general | medical is English only |
| `boosted_keywords` | list | 7 names | Retell says boosted keywords add latency |
| `denoising_mode` | default noise-cancellation | default | |
| `voice_model` | eleven_flash_v2_5, eleven_v3_conversational, eleven_v4_turbo, sonic-3.x (Cartesia), gpt-4o-mini-tts, inworld, minimax, fish, etc. | not set | |
| `voice_speed`, `voice_temperature` | 0.5 to 2 / 0 to 2 | 1 / 1 | |
| `enable_dynamic_voice_speed` | default false | off | |
| `ambient_sound` | none by default | mountain-outdoor | |
| `begin_message_delay_ms` | 0 to 5,000 | 0 | fine |
| `reminder_trigger_ms` | default 10,000 | default | |

There is no separate "turbo" switch. The speed levers are Fast Tier, a smaller model, a shorter prompt, STT fast mode / shorter endpointing, and the voice model.

### 4.4 Tool (custom function) settings
- `speak_during_execution` (default off) together with `execution_message_description` and `execution_message_type`:
  - `static_text` speaks a fixed line instantly.
  - `prompt` has the LLM generate the line, which costs an LLM pass.
- `enable_typing_sound` plays keyboard sounds while the tool runs.
- `speak_after_execution` is on by default.
- `timeout_ms` defaults to 120,000 (range 1,000 to 600,000). `max_retry` is 0 to 5, and the timeout applies to each attempt.
- If the caller interrupts, the agent answers them and the webhook still runs to completion.
- There is no async/background or parallel-execution field in the API. A docs overview page mentions "run in background" but no field backs it (UNVERIFIED). Multiple function calls in one turn have been supported since Dec 2024.

### 4.5 Voices
- Providers: ElevenLabs, Cartesia, OpenAI, MiniMax, Fish, Inworld and Retell Platform Voices (telephony-tuned, with automatic fallback).
- Price: $0.015/min for Cartesia, OpenAI, Platform, MiniMax, Fish and Inworld. ElevenLabs is $0.04 (Flash) to $0.10/min (v3/v4).
- Retell publishes no latency ranking. Our measured TTS is already 184 ms p50, so the voice choice is about **naturalness and cost, not latency**.

### 4.6 Retell latency guidance
- Retell cites e2e as low as about 600 ms and says to keep the estimate under 1.5 s.
- Its fixes: a smaller or faster model, Fast Tier, a shorter prompt (it says above about 8k tokens is noticeably slower; we send 5 to 6k), fast STT mode, a short endpointing window, fewer boosted keywords, checking "Response Wait" (can add up to 5.5 s), and a local phone number.

### 4.7 HIPAA and region
- Retell requires a signed BAA before PHI is sent. It can be self-signed (click-agreements.retellai.com) at no fee, and Retell's Aug 2026 blog says pay-as-you-go qualifies. The pricing page still lists BAA under enterprise, so **confirm our BAA status in the Retell dashboard before any real patient call**.
- `data_storage_setting` can be everything, everything_except_pii or basic_attributes_only. Retention is configurable from 1 day to 2 years. PII removal costs +$0.01/min.
- UNVERIFIED: which downstream providers (OpenAI LLM / Realtime, ElevenLabs, Twilio) Retell's BAA covers. Get it in writing, especially before using S2S.
- Retell has no documented region selector or US-only residency option.

---

## 5. Alternatives to Retell

| Option | Latency / naturalness | Tools | Telephony | HIPAA BAA | Effort |
|---|---|---|---|---|---|
| **OpenAI Realtime direct** (gpt-realtime-2.1 over SIP) | Native S2S. Artificial Analysis measured gpt-realtime-2 time to first audio at 1.12 s with minimal reasoning and 2.33 s with high reasoning. Realtime-2.1 claims better interruption and noise handling. | Yes, including parallel tool calls and spoken preambles. Tools run over a sideband WebSocket that we host. | SIP trunk to `sip.api.openai.com` (TLS 5061 + SRTP), e.g. Twilio Elastic SIP; transfer via SIP REFER | OpenAI's API BAA requires Modified Retention / ZDR. `/v1/realtime` appears on the eligible list (help page fetched only via search index), and SIP `/v1/realtime/calls` coverage is UNVERIFIED. Twilio also needs its own BAA. | High: we build call control, recording, audit, transfer, after-hours, monitoring |
| **OpenAI GPT-Live 1** (full duplex) | Closest to the ChatGPT voice experience: it listens and talks at the same time | Delegated to a backend agent (Responses API) | SIP / WebRTC | BAA coverage UNVERIFIED ("ZDR with limitations") | High. It **cannot read a script verbatim or guarantee a greeting**, which conflicts with our exact-wording safety rules (911 line, read-backs). Not on Retell. |
| **Vapi** | Targets p50 under 500 ms, p95 under 800 ms (its own metric excludes endpointing and transport). Supports gpt-realtime. | Yes | Own SIP / Twilio | **$2,000/mo** HIPAA add-on. HIPAA mode restricts providers and can't be combined with ZDR. | Medium (port prompt and tools) |
| **LiveKit Agents / Cloud** | Open-source pipeline with full control (half-cascade, any STT/LLM/TTS, OpenAI Realtime, GPT-Live, Gemini Live) | Yes (our code) | Native SIP and numbers | BAA on the Scale plan ($500/mo) or above (exact tier UNVERIFIED). BAA scope lists SIP, agent hosting and named inference models. | High (we own the agent code) |
| **Pipecat / Pipecat Cloud (Daily)** | Same idea as LiveKit; no official latency number | Yes (our code) | Daily PSTN/SIP or Twilio | BAA via help@daily.co covering Pipecat Cloud + Daily | High |

On every platform, bringing our own model keys means we also need **our own BAA with that model vendor** (OpenAI, ElevenLabs, etc.).

**Verdict:** the measured delays come from our configuration (silent tool turns, a large gpt-4.1 prompt, backend tails), and every one can be fixed inside Retell. Leaving Retell does not fix Veradigm round trips or the two-LLM-pass tool turn. Re-evaluate a platform move only if, after the steps below, tool turns are still above about 2 s p50 or S2S on Retell proves unreliable.

---

## 6. What changes with speech-to-speech

**What it gives us:**
- natural prosody, laughter and backchannel;
- faster first audio on simple turns;
- better handling of barge-in.

**What it costs for this agent:**
- **Tool-calling reliability.** OpenAI reports gpt-realtime at 66.5% on ComplexFuncBench audio (up from 49.7%). gpt-realtime-2 improved instruction retention (Audio MultiChallenge 70.8%), but no ComplexFuncBench score is published for it. No direct comparison with text gpt-4.1 was found. With 29 tools, identity-before-information rules and mandatory read-backs, expect more wrong or extra tool calls than gpt-4.1. This must be measured before any patient use.
- **Exact wording.** There is no "say exactly this". Safety lines ("If this is an emergency, please hang up and call 911 now.") and read-backs become best effort. A half-cascade (realtime understanding with text output plus our TTS) restores control but gives back most of the naturalness gain.
- **Transcripts are asynchronous** and can arrive after the reply. This matters for our audit log and after-hours call records.
- **Voice.** Likely limited to OpenAI voices on Retell. Medical vocab and boosted keywords probably don't apply (Retell STT is bypassed; UNVERIFIED).
- **Cost.** About $0.38/min for gpt-realtime-2.1 vs about $0.215/min today (Retell voice engine $0.055 + ElevenLabs $0.04 + gpt-4.1 $0.045 + token surcharge $0.06 + telephony $0.015). The mini model is $0.07/min but weaker at tools.
- **Tool turns are still slow.** S2S still waits for the Veradigm round trip. It helps only if it speaks a preamble ("let me check") while the tool runs, which we can already do in the cascade with `speak_during_execution`.

---

## 7. Recommendations (ranked)

Expected gains are estimates from the measurements above and need confirming by A/B. "Draft" means a **new unpublished agent version** (v7, based on v6), tested by web calls and a test number; v5 stays live. Changes to tools, prompt or model follow the normal review path.

### Tier 0: settings only (draft agent version, no code)

| # | Change | Expected gain | Risk | HIPAA |
|---|---|---|---|---|
| 1 | **`speak_during_execution: true` with `execution_message_type: static_text`** on Veradigm lookups: search_patients, get_patient_appointments, get_open_slots, get_appointment_details, account_balance, insurance_policy, recent_results, previsit_check, and the medication / allergy / problem tools. Use short varied lines ("One moment while I pull that up.", "Let me check the schedule."). Use static text, not prompt, so it costs no extra LLM pass. Optionally add `enable_typing_sound`. For write tools (save / cancel / confirm appointment, create_staff_task), only after the read-back yes: "Okay, booking that now." | Time to first audio on tool turns **3.3 s -> about 1.0 to 1.3 s p50** (p90 5.7 -> about 1.5 s). The biggest perceived fix. | Low. Make sure the filler never sounds like a confirmation of something not yet done. Check that the Rule 1 wording does not double up. | None |
| 2 | **Fast Tier** (`model_high_priority: true`) on gpt-4.1 | LLM p50 about 926 -> about 700 ms. Tail (p90 3.3 s) roughly halved per Retell's variance claim. Tool turns gain twice (two LLM passes). | Low. +$0.0225/min. | None (same model and vendor) |
| 3 | **Tool `timeout_ms` 20,000 -> 8,000** (max_retry 0) | A hung FHIR or Unity call now costs at most 8 s of filler + "I'm having trouble" instead of up to 20 s of silence. | Low to medium. A cold Unity token took 8.8 s once, so ship together with T1-3 (token pre-warm). | None |
| 4 | **Naturalness:** `enable_backchannel: true` (frequency about 0.6), `ambient_sound: null` (mountain-outdoor sounds like line noise on a clinic call), A/B `voice_model` `eleven_flash_v2_5` vs `eleven_v3_conversational` (or Cartesia `sonic-3.x` at $0.015/min), `vocab_specialization: medical` | Perceived naturalness. Latency neutral (TTS already about 185 ms). | Low. Backchannel can sound repetitive, so tune the frequency. | None |
| 5 | **Try `enable_dynamic_responsiveness: true`** and consider `interruption_sensitivity` 0.8 on PSTN | Fewer premature or late turn-takes. | Low. Watch for elderly callers being cut off mid-sentence. | None |
| 6 | **Model A/B: gpt-4.1-mini + Fast Tier** as the B arm against gpt-4.1 + Fast Tier | LLM p50 likely about 400 to 500 ms, roughly halving tool-turn LLM time. $0.0128/min. | **Medium to high.** Weaker at choosing among 29 tools and following safety rules. Pass only if tool-call accuracy and safety scripts score equal to gpt-4.1 on the test set. | None (same vendor) |

### Tier 1: small server and prompt changes (reviewed code, deploy to dev only)

| # | Change | Expected gain | Risk |
|---|---|---|---|
| 1 | **Get call mode from Retell's inbound-call webhook** (dynamic variable `{{call_mode}}`) instead of the LLM calling `drawbridge_get_call_mode` "at the start of every call" | Removes one LLM + tool round, about 1 to 2 s, on the first caller turn | Low |
| 2 | **Diagnose and fix the FHIR tools** (`verify_patient_identity`, `get_allergies`, etc.: 17/17 `UNKNOWN_ERROR`, p50 2.9 s, max 33 s). Better still, move the Unity -> FHIR fallback **server-side**, so a Unity tool tries FHIR itself and the LLM makes one call. Per the standing rule, we fix the broken API; we don't drop the tools. | Removes a second silent round (about 3 to 6 s) on every Unity error | Medium (FHIR auth / config work) |
| 3 | **Keep the Unity token warm:** refresh before the 19-min TTL expires, or pre-warm on the call_started webhook | Removes the 8.8 s cold first search after idle | Low |
| 4 | **Trim prompt and tool schemas** (about 8k tokens -> about 4k): shorter tool descriptions, shared parameter text, fewer examples | LLM time to first token about -10 to 20%. Removes Retell's token surcharge (about $0.06/min). | Low to medium. Re-run the intake / safety test set. |
| 5 | **Composite reads:** e.g. have `unity_search_patients` return the next appointments with the verified match | Saves one full LLM + tool round in the most common flow (verify -> "when is my appointment?") | Medium. Return only after identity is verified (Rule 2). |

### Tier 2: infrastructure (before production)

- **Move Drawbridge off the home workstation tunnel to the AWS deployment** (`infra/`, same US region as Retell's workers if known). The direct gain is small (about 100 to 170 ms per tool call). The real reasons are availability and HIPAA:
  - PHI currently transits a home Windows workstation;
  - it also transits Cloudflare, and a Cloudflare BAA is available only on Enterprise plans (verify our plan).
- Keep the HTTPS keep-alive warm: a reused connection measured about 95 ms vs about 200 ms for a fresh one.

### Tier 3: experiments (draft only, separate LLM, never on the live number until it passes)

- **Retell S2S with `s2s_model: gpt-realtime-2.1`** (not mini, given tool load) on a separate draft LLM with the same tools and fillers.
  - Measure Retell's `s2s` latency, tool-call accuracy, safety-script adherence, short-utterance recognition ("yes", DOB digits) and transcript completeness.
  - Cost about $0.38/min.
  - **HIPAA blocker:** get written confirmation that Retell's BAA covers OpenAI Realtime processing before any PHI.
- Only if Tier 0 to 3 fall short: prototype a **LiveKit Agents** half-cascade or **OpenAI Realtime SIP** stack. Budget a BAA with LiveKit (Scale plan) or OpenAI (ZDR / Modified Retention) plus Twilio. GPT-Live is not suitable while our safety lines must be verbatim.

### Expected result after Tier 0 + Tier 1

| Metric | Now | Target |
|---|---|---|
| Plain-turn gap p50 / p90 | 1.42 s / 2.6 s | about 1.0 s / 1.6 s |
| Tool turn: time to first audio p50 / p90 | 3.3 s / 5.7 s | about 1.1 s / 1.6 s (filler) |
| Tool turn: time to the answer p50 | 3.3 s | about 2.2 s |
| LLM turns over 2 s | 26% | under 10% |
| Worst silence on backend failure | up to 20 s | under 2 s (filler) + under 8 s to the error line |

---

## 8. How to measure each variant

- **Same script set per variant:** at least 20 calls over the PSTN (web calls under-report telephony latency), using sandbox test patients only. Cover verify -> appointment lookup -> reschedule -> balance -> refill -> after-hours, plus an emergency phrase and a "person please" phrase.
- **Latency:**
  - Retell `latency.e2e/llm/tts/asr` (or `s2s`) p50/p90 per call;
  - **word-timestamp gaps split into plain vs tool turns** (Retell e2e hides tool turns);
  - `tool_calls[].latency_ms` per tool;
  - share of LLM turns over 2 s;
  - Drawbridge audit `latency_ms` p50/p95 per tool for the same window.
- **Correctness:** right tool and arguments on the first try, no tool call before identity is verified, read-back before every write, exact 911 line, no IDs read aloud, transfer works.
- **Naturalness:** blind listen of 5 recordings per variant by 2 to 3 staff (1 to 5 scale), plus false barge-in and talk-over counts.
- **Cost:** `call_cost.product_costs` per minute.
- **Pass rule:** a variant may be proposed for publish only if correctness is no worse than v5 and the tool-turn gap p50 improves by at least 30%. Publishing remains the owner's call.

Data-handling note for this review: only latency, timing, token-count and cost fields were read and aggregated. No transcripts, recordings or patient identifiers are reproduced here.
