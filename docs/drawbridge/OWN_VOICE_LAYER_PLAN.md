# Own phone-answering layer for Drawbridge (SIP extension) vs staying on Retell

Date: 2026-10-16. Research and planning only. Nothing was changed: no Retell agent, phone number, PBX, Drawbridge code, container or production setting. No calls were placed. The only Retell access was a read-only `POST /v3/list-calls` for `call_cost` and latency fields (no transcripts, no keys printed).

This is an internal document; it names vendors. Do not share it outside MOATiT as is (see the no-vendor-names rule for external documents).

> **Decision, Oct 18 2026 (Ali): path B, hosted speech-to-speech.** The owner chose differently from the recommendation below:
> - Drawbridge registers as an ordinary SIP extension (our own user agent, `deploy/voice-gw`, Go/diago), not through Asterisk.
> - The model is hosted speech to speech: OpenAI Realtime (MOATiT has a BAA with OpenAI) or ElevenLabs Conversational AI, selectable per agent configuration. There is no self-hosted STT/TTS cascade.
> - What we build is the harness inside the Drawbridge server process: configuration, tools under the same call binding and audit as Retell, exact scripted clips, transcripts with speaker labels, handoff actions (transfer, voicemail, park, warm transfer with a local conference) and latency metrics.
> - Path A (a Titan route straight to OpenAI's SIP endpoint) is documented, not built.
> - Build, results and limits: **`docs/drawbridge/VOICE_HARNESS.md`**. The sections below are kept as the research record (cost, latency, risks).

---

## One-page summary

### Verdict: staged hybrid. Launch on Retell; prove our own layer before building all of it.

1. **Launch on Retell v7.2 (cascade, gpt-4.1).** It is built, measured on the phone line ($0.165/min, llm p50 about 800 ms) and under a signed BAA.
   - Optional, no code: point the PBX at Retell over SIP (Retell "custom telephony": TLS + SRTP, transfers back to the PBX by SIP REFER, **no Retell telephony fee**). This gives PBX routing (IVR, ring groups, after-hours) now and lowers cost to about $0.150/min.
2. **Build our own layer as a cascade, not speech-to-speech.**
   - Design: Asterisk registers to the PBX as an ordinary extension, and a Drawbridge `voice` module runs streaming STT -> gpt-4.1 -> streaming TTS, calling the tool code in-process.
   - First step: a **4-week proof of concept on a test extension**, with a go/no-go gate (section 9).
   - Full build and cut-over only if the gate passes **and** one of these holds:
     - volume heads past about **30k minutes/month** across clinics (run-rate break-even);
     - we decide the extra safety control is worth it regardless of cost: exact scripted lines, guarded output before it is spoken, deterministic read-backs, and no third-party voice platform holding recordings.
3. **Do not build v1 on realtime (speech-to-speech) or on OpenAI's native SIP endpoint.** They cost about 2x the cascade, tool turns are slower, and no exact wording is possible without our own media path. BAA coverage of the SIP endpoint is unconfirmed. Keep realtime as a PoC comparison arm (one extra week); GPT-Live is the one to re-test later.

### Why

| | Retell v7.2 (measured) | Own cascade (estimate) | Own realtime gpt-realtime-2.1 (estimate) |
|---|---|---|---|
| Plain turn, end of speech to first audio, p50 | 1.34 to 1.55 s (phone e2e); 1.39 s gap (web) | **about 1.0 to 1.2 s** | about 1.0 to 1.3 s |
| Tool turn, first audio p50 | 1.36 s (filler) | **about 0.9 to 1.1 s** (pre-rendered filler) | about 1.0 to 1.5 s (model preamble) |
| Tool turn, the answer p50 | 2.45 s | **about 1.9 to 2.2 s** | about 2.5 to 3.2 s (Retell measured 4.9 s) |
| Exact safety wording | yes (prompt, cascade TTS) | **guaranteed**: pre-rendered clips + a text guard before speech | only through our media path; no text guard before speech |
| Variable cost / min | $0.165 ($0.150 via PBX SIP) | **about $0.035 to $0.05** | about $0.10 (range $0.05 to $0.15) |
| Fixed cost / month | $0 (20 concurrent calls free) | about $100 infra + about 0.15 FTE operations | same |
| Who runs it 24/7 | Retell | **MOATiT** | MOATiT |

**Cost at volume** (cash, before labor; detail in section 6):

| Minutes / month | Retell (Twilio number) | Retell via PBX SIP | Own cascade | Own realtime |
|---|---|---|---|---|
| 1,000 | $165 | $150 | about $150 | about $200 |
| 10,000 | $1,650 | $1,500 | about $580 | about $1,100 |
| 50,000 | $8,250 | $7,500 | about $2,500 | about $5,100 |

**Break-even** of the own cascade against Retell via the PBX (saves about $0.10/min), at an assumed $120/h loaded engineering rate:

| What is counted | Break-even volume |
|---|---|
| Cash only | about 1,000 min/month |
| Plus operations (about 0.15 FTE) | **about 30,000 min/month** |
| Plus repaying the build (about $55 to 60k) over 24 months | about 55,000 min/month |

30,000 min is about 10,000 three-minute calls a month (about 450 per business day). One clinic of IKI's size is probably below that; a multi-clinic rollout is not.

### Effort

About 11 to 14 weeks elapsed:
- **People:** 1 senior TypeScript engineer full time, 0.25 QA / clinical reviewer, a few days of the PBX admin, about 1 week of Kanhaiya for AWS.
- **Phases:**
  - PoC: 4 weeks;
  - hardening: 3 to 4 weeks;
  - shadow / A-B with Retell as the PBX fail-over: 3 to 4 weeks;
  - cut-over: 1 week, then 30 days of hypercare.

### Top risks

| Risk | Mitigation |
|---|---|
| PBX compatibility: TLS/SRTP for extensions, REFER, caller ID pass-through | Check in week 1 of the PoC |
| One-way audio from NAT/RTP on AWS | Site-to-site VPN; Asterisk NAT settings |
| Endpointing on spelled names and dates of birth, especially elderly callers | Tunable end-of-turn detection; keypad DOB option |
| We own 24/7 operations and vendor/model drift | Monitoring and alerts (section 5); Retell kept as the fail-over |
| BAAs for new vendors (OpenAI direct, STT, TTS); ElevenLabs needs Enterprise | Prefer vendors with self-serve BAAs |
| Toll fraud if the SIP credentials leak | Extension restricted to internal routes and transfer targets |

### What Ali must provide

Details in section 10:
- PBX make/version and admin access;
- one test extension with TLS + SRTP (credentials only into the deployment `.env` / SSM as `SIP_*`);
- PBX routing and transfer targets;
- network path PBX <-> AWS (VPN);
- signed BAAs: OpenAI direct with Zero Data Retention / Modified Abuse Monitoring, AssemblyAI (self-serve) or Deepgram (Enterprise), and the TTS vendor (AWS Polly is under the AWS BAA; ElevenLabs needs Enterprise);
- the recording decision.

---

## 1. Architecture

### 1.1 Ali's design as planned

```
Caller ─PSTN─> MOATiT PBX (IVR, ring groups, after-hours)
                    │  SIP over TLS 5061 + SRTP, inside a site-to-site VPN
                    ▼
     ┌──────────── AWS host (us-west-2, next to Drawbridge) ─────────────┐
     │ voice-gw container (Asterisk 22.8+/23.2+, host networking)        │
     │   PJSIP outbound REGISTER as extension <SIP_EXTENSION>            │
     │   jitter buffer, G.711/G.722 <-> slin16, DTMF, REFER, MixMonitor  │
     │        │ ARI (127.0.0.1) + chan_websocket media (slin16 frames)   │
     │        ▼                                                          │
     │ unity container (existing Drawbridge Node process)                │
     │   NEW module src/platform/modules/voice                           │
     │     CallSession: call ID, state, scripts, barge-in, metrics       │
     │     Pipeline: STT stream -> LLM (tools) -> TTS stream             │
     │     Tools: executeAgentTool() in-process (call binding, audit,    │
     │            minimum necessary, idempotency, system status)         │
     └───────────────────────────────────────────────────────────────────┘
          │ TLS                │ TLS                    │ TLS
     STT vendor (BAA)    OpenAI gpt-4.1 (BAA, ZDR)   TTS vendor (BAA)
```

- **Per deployment:** create one extension on the PBX and put its details in that deployment's `.env` / SSM:
  - `SIP_SERVER`, `SIP_TRANSPORT=tls`, `SIP_USERNAME`, `SIP_PASSWORD`, `SIP_REALM`, `SIP_EXTENSION`;
  - `SIP_TLS_CA` (the PBX's CA, for verification) and `SIP_SRTP=required`;
  - plus non-secret `VOICE_TRANSFER_TARGET`, `VOICE_PUBLIC_IP`, `VOICE_RTP_PORT_MIN/MAX`.
  - Never in code, Git, docs, chat or tickets.
- **No phone numbers or carrier in v1.** The PBX owns numbers and routing. A SIP trunk for extra numbers is a later, optional phase.
- **Transfers:** a blind transfer by SIP REFER back to the PBX (ring group, on-call or operator). If the transfer fails, the agent takes a message (`drawbridge_take_message`), as the v7 prompt already does.

### 1.2 Why Asterisk as a local media gateway (and not a pure-Node SIP stack)

Only a few stacks can **register to a PBX as an extension**. Of those, only Asterisk and FreeSWITCH give TLS, SRTP, a jitter buffer, DTMF, REFER and recording out of the box. Comparison (sources in section 12):

| Option | Registers as an extension | TLS / SRTP | Media to our code | Verdict |
|---|---|---|---|---|
| **Asterisk + ARI + chan_websocket** | Yes (PJSIP `registration`) | Yes / SDES | WebSocket frames, ulaw/alaw/slin16/opus. Asterisk **reframes and retimes** what we send, generates silence, and has `FLUSH_MEDIA` (barge-in), `MARK_MEDIA` (what was played), `DTMF_END` and flow control (`MEDIA_XOFF/XON`). Needs 20.16 / 21.11 / 22.6 / 23.0+, and 22.8 / 23.2+ for the JSON control format. | **Recommended**: mature, GPL, about 50 calls trivially, no RTP/SRTP/NAT code in Node |
| FreeSWITCH + mod_audio_fork / mod_audio_stream | Yes (sofia gateway `register=true`) | Yes | WebSocket L16. mod_audio_stream's free edition is AGPL; full duplex is commercial. | Good, steeper; binary packages need a SignalWire token |
| drachtio-srf (+ FreeSWITCH or rtpengine) | Yes, by hand (we write the refresh loop) | Yes | Through FreeSWITCH | Most control, three moving parts |
| sipgo + diago (Go) | Yes | TLS yes, SRTP UNVERIFIED | `io.Reader`/`Writer` PCM | Young; adds Go to the team |
| baresip, PJSIP/pjsua2 | Yes | Yes | Custom C module; no maintained Node binding | No |
| SIP.js / JsSIP | Signaling only | We build it | We write RTP, jitter buffer, SRTP | No |
| LiveKit SIP | **No REGISTER** (trunks only) | Yes | LiveKit room | Not for the extension model |
| jambonz | Yes (registration trunk) | TLS; SRTP not stated | `listen` verb (L16 WebSocket) | A whole CPaaS; heavy for one container |
| Pipecat | No SIP transport (provider WebSockets) | n/a | n/a | Python; still needs a SIP front end |
| OpenAI Realtime native SIP | **No REGISTER**: the PBX must trunk to `sip:proj_…@sip.api.openai.com;transport=tls` | TLS 5061, SRTP | None: media goes PBX <-> OpenAI directly; tools over a sideband WebSocket | Realtime only, no media path of our own (see 2.3) |

### 1.3 "Tools in-process": how it stays literally true

`callBindings` (`src/platform/call-binding.ts`) lives in process memory. The audit hash chain caches its head per process and server (`src/platform/audit.ts`, `chainHeads`), and the Veradigm sessions, keep-warm and system status are also per process.

- **The problem:** a separate voice container that imported the tool code would get its own binding store and Unity sessions. Worse, it would write a second `unity` chain into the same audit day file and **break `audit:verify`**.
- **The plan:** the voice orchestrator is a Drawbridge platform module inside the existing Unity server process. It calls `executeAgentTool(name, args, callId, callerPhone, "voice")` and `toVoiceSummary()` directly (`src/unity/unity-test-server.ts`). This keeps the same call binding, minimum-necessary filter, idempotency, upcoming-visits attachment, fail-fast when records are down, and audit.
- **Asterisk is the only new container.** It holds no PHI logic, only media and signaling.
- **Load isolation:**
  - Node only exchanges 20 ms frames with Asterisk, and Asterisk retimes outbound audio and queues up to about 20 s, so event-loop hiccups under about 100 ms are inaudible.
  - If load isolation is ever needed, move the orchestrator to its own process and expose `executeAgentTool` on an internal-only endpoint. That costs about 2 ms per tool call, versus about 170 ms per call through Retell and the tunnel today.

### 1.4 Media details

- **Codecs:**
  - Ask Asterisk for `slin16` on the WebSocket and let it transcode to the PBX leg (G.711 PCMU/PCMA, or G.722 wideband if the PBX offers it to the extension).
  - STT takes 16 kHz PCM, and TTS can output 16 kHz PCM (Polly `pcm` 16000, ElevenLabs `pcm_16000`), so **Node never resamples**.
  - For the realtime arm, use `ulaw` end to end (OpenAI accepts `audio/pcmu` 8 kHz).
- **NAT on AWS:**
  - Run Asterisk with host networking.
  - Set `external_media_address` / `external_signaling_address` to the elastic IP and `local_net` to the VPC CIDR.
  - Set `rtp_symmetric`, `force_rport` and `rewrite_contact`.
  - Use a small RTP range (for example 10000 to 10199 UDP) and 5061/TCP, with security groups limited to the PBX's IPs.
  - A short registration expiry (60 to 300 s) and CRLF keepalives on the TLS connection.
  - SIP ALG off on the PBX firewall.
  - Preferred: a site-to-site VPN between the PBX and the VPC, so SIP and RTP never cross the open internet even though they are already TLS/SRTP.
- **Barge-in:**
  1. On caller speech (STT speech-start, or energy VAD for at least 150 to 300 ms) during playback, send `FLUSH_MEDIA` and cancel the LLM and TTS streams.
  2. Use `MARK_MEDIA` to know what was actually played, and cut the assistant turn in the history to that.
  - **Safety scripts are not interruptible**: the 911 line always plays to the end.
  - No acoustic echo cancellation is needed on a SIP endpoint. The speech minimum guards against line echo.
- **DTMF:** `DTMF_END` events.
  - v1: "press 0 for staff" at any time.
  - Optional: key in the date of birth (MMDDYYYY), which helps with the hardest STT item.
- **Recording:** Asterisk `MixMonitor` to the encrypted data volume, only if Ali decides to record (section 4.4). Retention follows the call-records retention (30 days, like the Retell agents today).
- **Concurrency:** Asterisk handles 50 calls trivially. Each call holds 3 TLS streams (STT, LLM, TTS). Size the host for about 20 concurrent calls per deployment (a c7i.large-class instance has room); load-test 50 in hardening.
- **Fail-over:** if the extension is unregistered (container down), the PBX's "unavailable" destination for the extension sends the call to a ring group, voicemail, or **the Retell agent over SIP** during the shadow period.

---

## 2. The model behind the extension: two options, compared honestly

### 2.1 (b) Self-hosted cascade (recommended)

**Pipeline:**
1. **STT, two choices:**
   - **AssemblyAI Universal-Streaming** with `domain=medical-v1` and keyterms: self-serve BAA at no cost, streaming audio not stored under the BAA, 8 kHz µ-law or 16 kHz PCM, tunable end of turn.
   - Or **Deepgram Flux / Nova-3 Medical**: about 260 ms end of turn, but the BAA is Enterprise only.
2. **LLM:** **gpt-4.1** (the model already validated on Retell), called directly with streaming and function calling.
   - Prompt and tools are about 3.9k tokens, with prompt caching.
   - "Fast mode" (priority) is optional. gpt-4.1-mini is a fallback on timeout.
3. **TTS, chosen by blind listen in the PoC:**
   - **AWS Polly** (generative/neural) is under the existing AWS BAA.
   - ElevenLabs Flash keeps the current "Grace" voice but needs an Enterprise BAA.
   - OpenAI gpt-4o-mini-tts: BAA coverage of `/v1/audio/speech` is UNVERIFIED.

**Turn flow:**
1. End of turn (STT).
2. LLM stream.
3. As soon as the stream shows a tool call, play that tool's **pre-rendered filler** (`AGENT_TOOLS[].filler`, rendered once at start-up).
4. Run the tool in-process.
5. Second LLM pass.
6. TTS one sentence at a time.

### 2.2 (a) Self-hosted realtime speech-to-speech

**Pipeline:** gpt-realtime-2.1 over WebSocket, bridged through **our** media path (Asterisk -> Node -> OpenAI), with the same tools in-process via function calls. The `ulaw` format means no resampling.

**What we measured on Retell, and what changes when we host it:**

| Problem measured on Retell (Oct 15) | Self-hosted | Remaining gap |
|---|---|---|
| Tool turns about 4.9 s to the answer | We remove Retell's webhook hop (about 170 ms) and orchestration. The tool runs in-process. The flow is the model emits a function call (about 1 s), the tool (0.3 to 0.7 s), then a new response (about 1 s). | **About 2.5 to 3.2 s**: still two model passes; still slower than the cascade's 1.9 to 2.2 s. OpenAI's async function calling lets the model talk while a tool runs, but the docs warn it may invent results meanwhile. |
| Static fillers ignored; the model's own preamble | We play our own pre-rendered filler on the function-call event and suppress the model's preamble audio | Fine |
| No-medical-advice line paraphrased | Scripted lines become **our clips** (2.3). Generated advice can't be blocked before it is spoken, because audio and transcript arrive together. | Only post-hoc detection, unless **half-cascade**: `output_modalities: ["text"]` plus our TTS. That restores the text guard but gives back most of the naturalness. |
| Name, last name and DOB asked in 3 turns | Prompting | Measure |
| Transcripts fragmentary and late | Input transcription is async | Call records and audit need care |
| Retell BAA coverage of realtime unconfirmed | Direct OpenAI BAA: `/v1/realtime` is ZDR-eligible and appears on the HIPAA list (the official page was seen only via search snippets) | Written confirmation from OpenAI still needed |
| About $0.46/min on Retell | About $0.10/min direct (estimate, section 6) | Still about 2x the own cascade |

There are also community reports (UNVERIFIED) of gpt-realtime-2.1 answering instead of calling tools.

**OpenAI native SIP** (the PBX trunks straight to OpenAI and we only attach a sideband WebSocket for tools):
- **For:** least code.
- **Against:**
  - the media never touches our system, so **we cannot play exact clips, guard output, record or barge-in-tune**;
  - inbound codecs are undocumented;
  - BAA coverage of `/v1/realtime/calls` is UNVERIFIED (not listed separately on the data-controls page);
  - it is not "an extension" (the PBX needs a TLS trunk to OpenAI).
- **Not recommended for patient calls.**

**GPT-Live (`gpt-live-1`, GA Sep 10 2026, $0.05/min plus backend):** full duplex and the closest to ChatGPT voice. It still cannot guarantee a scripted line. Re-test it once we have our own media path, because then our clips can cover the safety lines.

### 2.3 How each option guarantees exact wording (the 911 line and the others)

One rule for both options: **scripted lines are never generated by a model.**

- **Script table** (`voice/scripts.ts`):
  - entries: `EMERGENCY_911` ("If this is an emergency, please hang up and call 911 now."), `NO_MEDICAL_ADVICE`, `TRANSFER`, `RECORDS_DOWN`, `CANT_VERIFY`, the greeting and the after-hours greeting;
  - each is pre-rendered once with the chosen voice and checksum-verified;
  - it is played by the orchestrator byte for byte.
- **How the model triggers it:** a `say_script({id})` tool. The orchestrator plays the clip and writes the exact text into the history as the assistant's turn.
  - Realtime: we cancel the model's response audio for that turn. OpenAI does not let us inject assistant *audio* into its conversation, so we add the text; that assistant text items are accepted is UNVERIFIED and must be checked in the PoC.
- **Deterministic backstop:** an emergency phrase detector on the caller's transcript (chest pain, can't breathe, stroke, bleeding, fainting, self-harm, ...).
  - If it fires and the model did not call `EMERGENCY_911` in that turn, the orchestrator plays it anyway, then lets the model offer a transfer.
  - A false positive costs one unneeded sentence.
- **Pre-speech text guard (cascade and half-cascade only):** every generated sentence is checked *before* TTS.
  - Dose/start/stop/"should come in" patterns, or an interpretation of results, are replaced by `NO_MEDICAL_ADVICE` and logged.
  - Pure realtime audio cannot be guarded this way. **This is the decisive difference.**
- **Read-back before every change**, optional in phase 2, enforced like the call binding:
  1. Write tools need a `confirmToken`.
  2. The model calls `propose_change(...)`. The orchestrator **speaks a template read-back built from the arguments** ("I'll book you with Dr. X on Tuesday, October 20 at 2:30 for a follow-up visit. Is that right?").
  3. The orchestrator, not the model, classifies the caller's next utterance as yes or no.
  4. Only on yes does the write run, with exactly the proposed arguments.
  - Retell cannot offer this.
- **Identity before information:** unchanged server-side (call binding). It is **stronger** than on Retell:
  - the orchestrator mints the call ID (`voice_<uuid>`; `normalizeCallId` rejects the `@` in SIP Call-IDs), so neither the model nor a key holder can choose it;
  - this closes the known limitation in `SECURITY_CONTROLS.md` §12, "anyone who has the agent key can choose any call ID", for this channel.

---

## 3. Tools in-process: mapping

| Today (Retell custom function / built-in) | Own layer | Notes |
|---|---|---|
| All 22 `unity_*` and `drawbridge_*` tools in `AGENT_TOOLS` (`src/platform/agent-tools.ts`) | LLM function definitions from `compactAgentTools()` (the same compact schemas, the build fails on schema drift). Execution: `executeAgentTool(name, args, callId, callerPhone, "voice")` then `toVoiceSummary()` | Same binding, minimum necessary, idempotent writes (`withIdempotency` keyed by call ID), after-hours call records, audit `channel: "voice"` |
| `filler` per tool | Pre-rendered clip played on the tool-call event | No LLM pass, no TTS latency |
| 6 FHIR backup tools (`server: 'fhir'`) | Not offered while `DRAWBRIDGE_FHIR_TOOLS` is OFF. If turned on, they need an internal call to the FHIR process (its own binding store), as today. | Per the standing rule: not dropped, but gated as now |
| `drawbridge_get_call_mode` / the inbound webhook | `callStartVariables()` (`retell-inbound.ts`) is called directly at call start: `call_mode`, `records_status`, `fhir_tools`, plus the current Boise time | One tool round and one webhook fewer. The tool stays for compatibility. |
| `end_call` | Orchestrator: play the closing, ARI hang-up (BYE), `callBindings.forget(callId)` | |
| `transfer_to_staff` | Orchestrator: play `TRANSFER`, then ARI continue into a dialplan context that runs `Transfer(PJSIP/${VOICE_TRANSFER_TARGET})` (REFER). After-hours urgent: the on-call target. On failure: take a message. | Retell's measured transfer took 5.5 s; REFER is near-instant |
| Retell call events (`retell-events.ts`: calls index, transcript ref, summary) | `voice/events.ts` writes the same calls index (last 4 digits only) and attaches the transcript reference and summary to the notebook record | Summaries: gpt-4.1 under the same BAA, post-call |
| new `say_script` | Orchestrator | Section 2.3 |
| new (phase 2) `propose_change` | Orchestrator plus a confirm-token gate next to `withCallBinding` | Section 2.3 |

**The caller's number** comes from the PBX (P-Asserted-Identity or From; the PBX must pass the external caller ID through to the extension). It is treated as "as stated, not verified", as today.

**Prompt:** `retell-prompts/unity-healthcare-agent.md` is reused. Only the Retell variables change (`{{call_mode}}` and the others are filled by the orchestrator), and the SAFETY lines say "call say_script" instead of "say exactly".

**Outbound outreach** (`POST /v2/create-phone-call` on Retell) stays on Retell until a later phase adds PBX-originated calls.

**PCI:** the voice layer has no payment function (balance due only) and must never take card numbers. If pay-by-phone is ever added, the PCI DSS gates in CLAUDE.md apply: DTMF masking, a hosted payment IVR, and both independent audits.

---

## 4. HIPAA and security

### 4.1 Every party in the PHI path

| Party | Sees | BAA status / requirement | Source |
|---|---|---|---|
| PBX (MOATiT-run) and its host | Call audio, caller ID, any PBX recordings | MOATiT-operated: our own safeguards. A hosted PBX vendor would need a BAA. | — |
| Carrier (PSTN) | Audio in transit | Generally treated as a conduit; confirm with counsel | — |
| AWS (host, EBS, SSM, CloudWatch; Polly / Transcribe if chosen) | Everything at rest | AWS BAA (in place); Polly and Transcribe are HIPAA-eligible services | AWS HIPAA eligible services |
| OpenAI (gpt-4.1; realtime arm) | Transcripts, tool results, audio (realtime) | **Direct BAA needed** (Retell's does not carry over), plus Zero Data Retention / Modified Abuse Monitoring on the project.<br>`/v1/chat/completions`, `/v1/responses` and `/v1/realtime` are ZDR-eligible (30-day abuse retention otherwise).<br>`/v1/realtime/calls` (SIP) is not listed: **UNVERIFIED**.<br>The 2024 Healthcare Addendum vs the 2026 HIPAA guide differ on ZDR-only use: get it in writing. | OpenAI data controls, HIPAA guide |
| STT: AssemblyAI | Caller audio | **Self-serve BAA, any paid account, no fee**. With the BAA, streaming audio and transcripts are not stored or used for training. | AssemblyAI security / medical mode |
| STT alternative: Deepgram | Caller audio | BAA Enterprise only. `mip_opt_out=true` for zero retention (metadata 90 days). | Deepgram pricing / data privacy |
| TTS: AWS Polly | Agent text (can contain PHI: names, dates) | AWS BAA | AWS |
| TTS alternative: ElevenLabs | Agent text | BAA and Zero Retention Mode **Enterprise only** | ElevenLabs |
| Retell (fail-over during shadow) | As today | Signed (Ali, Oct 16) | — |

### 4.2 Transport and keys

- **SIP leg:** TLS 1.2+ to the PBX with certificate verification (`SIP_TLS_CA`) and SRTP required (`media_encryption=sdes`, no fallback to RTP), inside a site-to-site VPN. **Fail closed**: no registration without TLS, no call without SRTP.
- **AI vendors:** HTTPS/WSS only.
- **Asterisk ARI and HTTP:** bound to 127.0.0.1 with a generated password. Not reachable from the internet; nginx must not proxy it.
- **The extension's class of service on the PBX:** internal destinations and the transfer targets only. No outside dialing (toll-fraud protection if the credentials leak).
- **Secrets:** `SIP_PASSWORD` and the vendor keys only in `.env` locally or SSM SecureString in AWS, and added to `fetch-secrets.sh` (`SECURITY_CONTROLS.md` §10.5). Rotate on staff change.

### 4.3 Audit and logging

- **Reused as is:** tool calls go to the hash-chained audit log with `channel: "voice"`, and call-binding refusals are security events (`agent_not_verified`, `agent_search_limit`).
- **New security events:** `sip_registration_lost`, `sip_tls_failure`, `srtp_refused`, `emergency_script_backstop`, `output_guard_blocked`, `voice_vendor_error`.
- **Server logs:** IDs, codes and latencies only, never transcript text (as today).

### 4.4 Transcripts, recordings, redaction

- **Transcripts are PHI.**
  - Keep them in the call record on the encrypted data volume (EBS with KMS; open item `SECURITY_CONTROLS.md` §10.1).
  - Same retention as the Retell agents today (30 days) unless Ali sets another.
  - Staff access is audited like every chart view.
  - The cascade produces exact agent text, which is better for the audit than Retell's realtime fragments.
- **Redaction:** the evaluation and analytics copies are redacted:
  - DOB, phone and the names of the verified patient (known from the binding);
  - numbers of 4 or more digits.
  - This replaces Retell's $0.01/min PII scrubbing.
  - No transcript leaves the BAA vendors.
- **Recording:** Ali decides. It is useful in the PoC and shadow phases with synthetic patients and for blind listening. In production, record only if needed, with notice in the greeting or IVR, 30 days, and staff-only access.

### 4.5 HIPAA checklist updates

Add the voice rows to `HIPAA_TECHNICAL_SAFEGUARDS.md` and to `smoke:hipaa`:
- 164.312(e) SIP TLS/SRTP fail-closed;
- 164.312(b) voice audit;
- 164.314 new vendor BAAs;
- 164.502(b) minimum necessary is unchanged (`forAgent`).

---

## 5. Monitoring, QA, alerting

- **Per-turn metrics**, metadata only, in the audit or a metrics file:
  - endpoint -> first audio, endpoint -> answer, and plain or tool turn;
  - STT end of turn;
  - LLM time to first token and total;
  - TTS first byte;
  - tool latency;
  - barge-ins;
  - script plays.
- **Staff dashboard:** a "Voice" card on the Activity page (`/app/activity`) with p50/p90 for the day.
- **System status and help desk** (reuse `src/platform/system-status.ts` + `helpdesk.ts`; help@moatit.com, the same de-duplication and reminders):
  - New component **voice**. It goes DOWN on:
    - SIP unregistered for more than 60 s;
    - vendor errors over 20% in 5 minutes;
    - turn latency p90 above 3 s for 15 minutes.
  - Alerts carry no PHI. The red banner shows "Phone agent: DOWN (SIP registration lost)".
  - CloudWatch alarm on `[SECURITY] sip_*` lines as the backstop.
- **Evals:**
  - **Nightly synthetic calls:** a second Asterisk endpoint dials the test extension and plays the existing scripted caller audio (scenarios s1, s2, s4 from `VOICE_V7_EXPERIMENT.md`, plus booking/cancel and after-hours) against the Veradigm **sandbox** with synthetic patients only.
  - **Hard checks:**
    - `EMERGENCY_911` clip played;
    - no patient tool before verification (the server enforces it);
    - read-back before every write;
    - no IDs read aloud;
    - transfer REFER sent.
  - **Soft checks:** an LLM judge (under the OpenAI BAA) on the redacted transcripts.
  - Regression gate on every prompt, model or vendor change.
- **Naturalness:** a blind listen of 5 recordings per variant by 2 to 3 staff, 1 to 5 scale (same method as the latency review), plus false barge-in and talk-over counts.

---

## 6. Cost per minute

### 6.1 Assumptions

- From Retell `call_cost` on the v7 phone calls (Oct 16, read-only):
  - **$0.1650/min** = voice engine 0.055 + ElevenLabs 0.040 + gpt-4.1 0.045 + Twilio 0.015 + PII scrubbing 0.010;
  - llm p50 790 to 820 ms, e2e p50 1.34 to 1.55 s (2 calls).
- About 4.5 LLM requests per call-minute (41 LLM turns over 3 calls of about 3 min).
- About 3.9k prompt + tool tokens, plus a growing history. About 85% cached.
- The agent speaks about 45% of the time, about 450 characters per call-minute.

### 6.2 Own cascade (per call-minute)

| Item | Price (official) | Per min |
|---|---|---|
| STT AssemblyAI Universal-Streaming + medical mode + keyterms | $0.15 + $0.15 + $0.04 per hour of open socket | $0.0057 |
| gpt-4.1 Standard: $2 in / $0.50 cached / $8 out per 1M | 4.5 × (3.8k cached + 0.7k new + 50 out) | about $0.017 |
| gpt-4.1 Fast mode instead: $3.50 / $0.875 / $14 | same | about $0.029 |
| TTS AWS Polly generative ($30 per 1M characters) / neural ($16) | 450 characters | $0.0135 / $0.0072 |
| TTS ElevenLabs Flash instead ($0.04 per 1k characters, plus an Enterprise contract) | 450 characters | $0.018 |
| Pre-rendered fillers and scripts | once | $0 |
| Compute, egress (G.711 about 0.7 MB/min each way) | | under $0.001 |
| **Total** | | **$0.03 (Standard + Polly neural) to $0.05 (Fast + Polly generative)** |

Fixed: about $50 to 100/month for a larger instance or the Asterisk sidecar and logs, plus a standby later. Vendor minimums are $0 with AssemblyAI, Polly and OpenAI; ElevenLabs, Deepgram or Cartesia Enterprise would add custom fees (UNVERIFIED amounts).

### 6.3 Own realtime (gpt-realtime-2.1, $32 in / $0.40 cached / $64 out per 1M audio tokens)

- Billing basis: user audio is 10 tokens/s and agent audio 20 tokens/s.
- Agent audio out: 0.45 × 1,200 × $64/M ≈ $0.035/min.
- Caller audio in, plus the history re-sent each turn at the cached rate: grows with call length.
- **About $0.05 (floor) to about $0.10/min for 5 to 10 minute calls.** Caching is "best-effort", so a cache miss on audio history costs $32/M.
- Half-cascade (text out + Polly) is about $0.08. gpt-realtime-2.1-mini is about $0.03, but weaker at tools.
- These are estimates; the PoC must read `response.done` usage.

### 6.4 Monthly totals (cash, before labor)

| Min / month | Retell v7 (Twilio) | Retell via PBX SIP (no telephony fee) | Retell realtime (measured $0.46) | Own cascade ($0.048 + $100) | Own realtime ($0.10 + $100) |
|---|---|---|---|---|---|
| 1,000 | $165 | $150 | $460 | about $148 | about $200 |
| 10,000 | $1,650 | $1,500 | $4,600 | about $580 | about $1,100 |
| 50,000 | $8,250 | $7,500 | $23,000 | about $2,500 | about $5,100 |

Retell notes: 20 concurrent calls are free, then $8 per concurrent call per month. Enterprise volume pricing is not published, so a negotiated discount would push break-even higher.

### 6.5 Labor and break-even

Assumptions (adjust to MOATiT's real rate):
- **Build:** about 12 weeks × 40 h × $120/h ≈ **$55 to 60k**, plus QA time.
- **Operations:** about 25 h/month (0.15 FTE) ≈ **$3,000/month** for on-call, vendor and model updates, PBX issues and evals.

| Break-even of the own cascade | vs Retell via PBX SIP ($0.150) | vs Retell Twilio ($0.165) |
|---|---|---|
| Cash only | about 1,000 min/month | about 900 min/month |
| Plus operations | **about 30,000 min/month** | about 26,000 min/month |
| Plus build repaid over 24 months | about 55,000 min/month | about 48,000 min/month |

---

## 7. Latency budget (own cascade over the PBX)

Estimates; the PoC must measure them. Retell's figures are measured.

| Step | p50 estimate | Basis |
|---|---|---|
| Caller audio PBX -> Asterisk (jitter buffer 40 to 60 ms) -> Node | 60 to 80 ms | Asterisk practice |
| End of turn (STT) | 250 to 400 ms | AssemblyAI `min_turn_silence` 400 ms default, tunable lower; Deepgram Flux about 260 ms |
| LLM time to first token, gpt-4.1, about 4.5k tokens mostly cached | 400 to 650 ms | UNVERIFIED. Retell's 784 ms includes Retell overhead; Fast mode reduces variance. |
| First sentence -> TTS first byte | 100 to 250 ms | Vendor claims (ElevenLabs Flash about 75 ms model time; Polly not published) |
| Node -> Asterisk -> PBX -> caller | 60 to 100 ms | |
| **Plain turn** | **about 1.0 to 1.2 s** (Retell phone 1.34 to 1.55 s) | |
| **Tool turn, first audio** (filler on the tool-call event, no TTS) | **about 0.9 to 1.1 s** (Retell 1.36 s) | |
| **Tool turn, answer**: filler length (about 1 s with shorter fillers, "One moment.") overlaps the tool (in-process, no 170 ms tunnel; Unity p50 250 to 700 ms) and LLM pass 2 | **about 1.9 to 2.2 s** (Retell 2.45 s) | |

**Where it can't go faster:** Veradigm round trips and the second LLM pass, the same limits the latency review found. The gain is about 0.2 to 0.4 s per turn, not a step change. A step change in naturalness needs a full-duplex model (GPT-Live) plus our scripts, later.

**Naturalness levers we control:**
- endpointing per field (longer when the caller is spelling or giving a DOB);
- backchannel clips (off in v1, A/B later);
- voice choice by blind listen;
- non-interruptible safety lines;
- per-turn barge-in thresholds.

---

## 8. Build plan

| Phase | Weeks | Work | Exit |
|---|---|---|---|
| 0. Prerequisites | 1 (parallel) | BAAs (OpenAI direct with ZDR/MAM, AssemblyAI self-serve, TTS); PBX test extension with TLS + SRTP; VPN PBX <-> AWS; AWS host with encrypted EBS | Credentials in SSM / `.env` only |
| 1. **PoC** on a test extension | 4 | `deploy/voice-gw` (Asterisk image, PJSIP registration from `SIP_*` env, ARI, chan_websocket); `src/platform/modules/voice` (CallSession, cascade pipeline, in-process tools, script clips, fillers, barge-in, REFER transfer, metrics); realtime arm behind a flag (+1 week); synthetic sandbox patients only | Go/no-go #1 (section 9) |
| 2. Hardening | 3 to 4 | Text guard, emergency backstop, `propose_change` gate (optional), recordings and retention, voice status component and alerts, eval harness and nightly run, 50-call load test, fail-over to Retell, HIPAA and security docs, `smoke:voice-sip` | Independent security review (not PCI scope; same two-reviewer style) |
| 3. Shadow / A-B | 3 to 4 | Staff test calls, then one live route at a time (for example business-hours overflow), with Retell as the PBX fail-over destination. Compare PSTN metrics, safety checks and blind listen. | Go/no-go #2 |
| 4. Cut-over | 1 + 30 days hypercare | All routes to the extension. Retell stays as fail-over for 30 days, then becomes outreach-only. | |
| 5. Later | — | SIP trunk for extra numbers; outbound outreach via the PBX; GPT-Live re-test; two-phase writes by default | |

**Team:** 1 senior TypeScript engineer (Node, SIP basics); 0.25 QA / clinical reviewer (the IKI scripts); the PBX admin (2 to 3 days); Kanhaiya (AWS host, VPN, SSM, about 1 week); Ali (decisions, BAAs).

**Risks:**

| Risk | Likelihood | Mitigation |
|---|---|---|
| PBX can't do TLS/SRTP to extensions, blocks REFER, or hides caller ID | Medium | Check in week 1; Asterisk can fall back to attended transfer via the PBX feature code (UNVERIFIED per PBX) |
| One-way audio or registration drops behind NAT | Medium | VPN, Asterisk NAT settings, short expiry, TLS keepalive, SIP ALG off |
| Endpointing cuts off spelled names or DOBs | Medium | Per-field turn settings, DTMF DOB, spelled-letter prompt rules (already in v7) |
| LLM provider outage or latency spike | Low to medium | Timeout -> gpt-4.1-mini; vendor errors -> "records/phone assistant unavailable" script plus PBX fail-over |
| Safety regression (911, advice) | Low (deterministic clips and guard) | Hard eval checks on every change |
| A voice-module crash takes down the staff app (same process) | Low | Defensive code, worker threads for DSP; split into its own process if it happens (1.3) |
| We own 24/7 operations | Certain | Alerts, runbook, Retell fail-over |
| BAA delays (OpenAI direct, Enterprise TTS) | Medium | Start in phase 0; prefer self-serve-BAA vendors |
| Toll fraud via a leaked extension | Low | PBX class of service, strong password, TLS only, IP-restricted |

---

## 9. Go / no-go checklists

**Go/no-go #1 (end of PoC), all required:**
- [ ] Registers over TLS with SRTP (fail-closed tested: no TLS, no call); survives 24 h without a registration drop
- [ ] Over the PSTN through the PBX, 20+ synthetic calls (s1, s2, s4, booking, cancel, after-hours):
  - plain turn p50 ≤ 1.2 s;
  - tool-turn first audio p50 ≤ 1.1 s;
  - tool answer p50 ≤ 2.3 s (each at least as good as Retell v7.2 on the same scripts).
- [ ] Safety:
  - 911 clip byte-exact in 100% of emergency scenarios (including the backstop);
  - no-medical-advice clip byte-exact;
  - zero patient-data tool calls before verification;
  - read-back before 100% of writes.
- [ ] Tool accuracy equal to v7.2 (right tool and arguments on the first try)
- [ ] REFER transfer completes to the PBX target; failure falls back to a message
- [ ] Audit chain verifies (`audit:verify`) with voice traffic; no transcript text in server logs
- [ ] Measured cost per minute ≤ $0.06

**Go/no-go #2 (end of shadow), all required:**
- [ ] Two independent reviewers signed off on the security and HIPAA review
- [ ] All BAAs signed; ZDR/MAM confirmed on the OpenAI project in writing
- [ ] Blind listen ≥ v7.2
- [ ] Alerts tested end to end to help@moatit.com
- [ ] Fail-over to Retell tested
- [ ] 2 weeks of live-route metrics within the gate-1 thresholds; zero safety failures
- [ ] Runbook and on-call owner named
- [ ] Ali's written go

---

## 10. What Ali must provide

1. **PBX facts:**
   - make and version (FreePBX/Asterisk, 3CX, Yeastar, ...) and where it runs (office or cloud);
   - whether extensions support TLS (5061) and SRTP (SDES);
   - whether REFER / blind transfer is allowed from an extension;
   - G.722 availability;
   - whether the external caller ID is passed to the extension.
2. **One test extension** for the PoC, later one per deployment:
   - server, transport, username, password, realm and extension number go **only** into the deployment `.env` / SSM as `SIP_*` (never in chat, code, docs or tickets);
   - class of service: internal and transfer targets only;
   - registration over TLS with the PBX's CA certificate.
3. **PBX steps:**
   - the routes that should reach the extension (test DID or IVR option first; later business-hours overflow / after-hours);
   - the transfer targets (front-desk ring group, on-call);
   - the extension's "unavailable" fail-over destination (Retell over SIP during shadow, then a ring group or voicemail);
   - SIP ALG off.
4. **Network:** approval for a site-to-site VPN PBX <-> the AWS VPC (or the PBX's static IPs for security-group allow-listing). Kanhaiya builds the AWS side.
5. **Vendor accounts and BAAs:**
   - OpenAI organization/project with the BAA executed and Zero Data Retention or Modified Abuse Monitoring on. Ask in writing whether gpt-4.1 Chat Completions/Responses, `/v1/realtime` and `/v1/audio/speech` are covered (and `/v1/realtime/calls` if native SIP is ever wanted).
   - AssemblyAI paid account with the self-serve BAA (or a Deepgram Enterprise BAA).
   - TTS: Polly under AWS, or an ElevenLabs Enterprise BAA with Zero Retention Mode if the current voice must stay.
6. **Decisions:**
   - record calls or not, and for how long;
   - which route goes live first;
   - the PoC budget (about 4 engineer-weeks);
   - whether to point the PBX at Retell over SIP now (step 1 of the verdict).

---

## 11. PoC design (small; for the engineer, not built)

**New files (proposed):**
- **`deploy/voice-gw/`**
  - Dockerfile: Asterisk 22.8+ or 23.2+, built with `chan_websocket`, `res_pjsip`, `res_ari`, `res_srtp`.
  - `pjsip.conf.tmpl` rendered from `SIP_*` at start-up. It holds the transport `tls` with `ca_list_file`, `method=tlsv1_2`, `verify_server=yes`, plus the `registration`, `auth`, `aor` and `endpoint` sections, with `media_encryption=sdes`, `media_encryption_optimistic=no`, `rtp_symmetric=yes`, `force_rport=yes` and `rewrite_contact=yes`.
  - `extensions.conf`: inbound calls go to `Stasis(drawbridge-voice)`, plus a `transfer` context with `Transfer(PJSIP/${VOICE_TRANSFER_TARGET}@pbx)`.
  - `ari.conf` and `http.conf` bound to 127.0.0.1; `chan_websocket.conf` with the JSON control format.
  - The rendered file goes to tmpfs, never to the image or a volume.
- **`src/platform/modules/voice/`:**

| File | Role |
|---|---|
| `index.ts` | Starts the ARI client when `VOICE_ENABLED=on` |
| `ari.ts` | StasisStart -> new `CallSession`; externalMedia `transport=websocket format=slin16`; bridge |
| `session.ts` | Call state, minted call ID, `callStartVariables()`, greeting clip, turn loop, barge-in (`FLUSH_MEDIA` / `MARK_MEDIA`), DTMF, hang-up and clean-up (`callBindings.forget`) |
| `pipeline/cascade.ts` | STT WebSocket -> LLM stream (tools from `compactAgentTools`) -> sentence splitter -> text guard -> TTS stream |
| `pipeline/realtime.ts` | The realtime arm behind a flag |
| `tools.ts` | Calls `executeAgentTool` + `toVoiceSummary`; `say_script`, `end_call`, `transfer_to_staff` |
| `scripts.ts` | Script table, clip rendering and cache with checksums |
| `guard.ts` | Emergency backstop and medical-advice text guard |
| `metrics.ts` | Per-turn timings to the audit (metadata) and the `voice` component of system status |

- **Tests:** `src/scripts/smoke-voice-sip.ts`, offline, with a fake ARI and media socket.

**Call sequence:**
1. PBX INVITE (TLS/SRTP) -> Asterisk -> `StasisStart`.
2. Node mints `voice_<uuid>`, answers, opens the media socket and plays the greeting clip.
3. The caller speaks -> STT end of turn -> LLM.
4. Tool call -> filler clip plus `executeAgentTool` in-process.
5. LLM pass 2 -> guard -> TTS -> media socket.
6. Transfer -> `continue` into the `transfer` context -> REFER.
7. Hang-up -> call index, notebook record, binding forgotten.

---

## 12. Sources

Docs checked 2026-10-16. UNVERIFIED in the text marks anything not confirmed in an official source.

**Repository (branch `drawbridge/cert-hardening`):**
- `docs/drawbridge/VOICE_LATENCY_REVIEW.md`, `VOICE_V7_EXPERIMENT.md`, `RETELL_SETUP.md`, `SECURITY_CONTROLS.md`, `HIPAA_TECHNICAL_SAFEGUARDS.md`;
- `src/platform/agent-tools.ts`, `call-binding.ts`, `audit.ts`, `system-status.ts`, `helpdesk.ts`;
- `src/unity/unity-test-server.ts` (`executeAgentTool`, `/api/retell`);
- `src/platform/modules/activity/retell-inbound.ts`, `retell-events.ts`;
- `deploy/local/retell/retell_api.py` (read-only cost query).

**OpenAI:**
- pricing: https://developers.openai.com/api/docs/pricing
- realtime costs: https://developers.openai.com/api/docs/guides/realtime-costs
- data controls / ZDR table: https://developers.openai.com/api/docs/guides/your-data
- realtime SIP: https://developers.openai.com/api/docs/guides/realtime-sip
- prompting (preambles, verbatim): https://developers.openai.com/api/docs/guides/realtime-models-prompting
- client events (`output_modalities`): https://developers.openai.com/api/reference/resources/realtime/client-events
- GPT-Live: https://developers.openai.com/api/docs/guides/live
- changelog: https://developers.openai.com/api/docs/changelog
- HIPAA guide: https://cdn.openai.com/osa/baa-hipaa-guide.pdf
- Healthcare Addendum: https://cdn.openai.com/osa/healthcare-addendum.pdf
- HIPAA-eligible list (403 to direct fetch; seen via search): https://help.openai.com/en/articles/20001069-hipaa-eligible-products-and-functionality
- tool-call regression report (community, UNVERIFIED): https://community.openai.com/t/gpt-realtime-2-1-production-tool-invocation-regression-model-answers-instead-of-calling-available-tools/1398438

**Retell:**
- https://www.retellai.com/pricing
- https://docs.retellai.com/general/compliance
- https://docs.retellai.com/deploy/custom-telephony

**STT/TTS:**
- AssemblyAI:
  - https://www.assemblyai.com/pricing
  - https://www.assemblyai.com/security
  - https://www.assemblyai.com/docs/streaming/medical-mode
  - https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api
- Deepgram:
  - https://deepgram.com/pricing
  - https://developers.deepgram.com/docs/flux/quickstart
  - https://developers.deepgram.com/trust-security/your-data
- ElevenLabs:
  - https://elevenlabs.io/pricing/api
  - https://elevenlabs.io/docs/developers/resources/zero-retention-mode
- Cartesia:
  - https://cartesia.ai/pricing
  - https://docs.cartesia.ai/enterprise/zero-data-retention
- AWS:
  - https://aws.amazon.com/polly/pricing/
  - https://aws.amazon.com/compliance/hipaa-eligible-services-reference/
  - https://docs.aws.amazon.com/polly/latest/dg/API_SynthesizeSpeech.html

**SIP and media:**
- Asterisk chan_websocket: https://docs.asterisk.org/Configuration/Channel-Drivers/WebSocket
- Asterisk NAT: https://docs.asterisk.org/Configuration/Channel-Drivers/SIP/Configuring-res_pjsip/Configuring-res_pjsip-to-work-through-NAT
- LiveKit SIP (no REGISTER): https://docs.livekit.io/sip/
- drachtio: https://drachtio.org/api
- FreeSWITCH gateways: https://developer.signalwire.com/freeswitch/users-and-endpoints/gateways/
- mod_audio_stream: https://github.com/amigniter/mod_audio_stream
- diago: https://github.com/emiago/diago
- jambonz carriers: https://docs.jambonz.org/guides/using-the-jambonz-portal/basic-concepts/creating-carriers
- LiveKit and Pipecat pricing / HIPAA:
  - https://livekit.com/pricing
  - https://livekit.com/security
  - https://docs.pipecat.ai/pipecat-cloud/security/hipaa
