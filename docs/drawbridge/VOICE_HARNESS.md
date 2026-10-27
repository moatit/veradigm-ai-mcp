# Drawbridge voice harness (path B): our own extension on the PBX

Branch `drawbridge/voice-harness` (from `drawbridge/cert-hardening`). Started Oct 18 2026. Proof of concept on Titan test extension 4515, synthetic patients only (e.g. Lucius Marchetti, DOB 03/03/1960).

This is an internal document; it names vendors. Do not share it outside MOATiT as is (no-vendor-names rule for external documents).

Retell stays live and untouched. The voice harness only runs when `VOICE_ENABLED=on` and the `voice-gw` container is started; nothing changes for the Retell agents or their phone number.

---

## 1. Decision and options

**Owner's decision (Ali, Oct 18 2026): path B.** Drawbridge registers as an ordinary SIP extension, like a desk phone.
- It works with any PBX, including a clinic's own phone system, with no routing changes there.
- The PBX keeps routing, transfers, conferences and dial-in/out.
- The voice model is hosted, speech to speech; there is no self-hosted STT/TTS stack. Selectable per agent configuration:
  - **OpenAI Realtime** (`gpt-realtime-2.1`, voice `marin`). MOATiT has a BAA with OpenAI. This is the primary provider.
  - **ElevenLabs Conversational AI**: second adapter. No BAA yet, so synthetic tests only (see 6.5).
- What we build is the harness:
  - agent configuration;
  - tools run by Drawbridge during the call;
  - live transcripts with speaker labels;
  - call records, audit, latency metrics;
  - handoff actions (transfer, voicemail, park, warm transfer).

This replaces the cascade-with-Asterisk recommendation in `OWN_VOICE_LAYER_PLAN.md` (see the decision note at the top of that file).

**Path A (documented, not built).** Titan "SIP URI Connection": a route to `sip:<project>@sip.api.openai.com;transport=tls`, with OpenAI's incoming-call webhook and a sideband WebSocket for tool calls.
- **For:** least code.
- **Against:**
  - the media never touches us, so there are no exact scripted clips, no echo or barge-in control, no per-leg transcripts and no local conference;
  - it is a trunk route, not an extension, so it does not carry over to a clinic's own PBX;
  - BAA coverage of `/v1/realtime/calls` is unconfirmed.

---

## 2. Architecture

```
Caller -PSTN-> Titan PBX (routing, IVR, ring groups, voicemail, park)
                  |  SIP over TLS 1.2 (5061) to the edge proxy, SRTP (SDES) media, G.722 or G.711
                  v
   +-------------- Docker host (drawbridge-dev) ------------------------------------------+
   | voice-gw (Go, deploy/voice-gw)              network "voice-egress" -> internet        |
   |   SIP user agent: REGISTER ext 4515, answer, BYE, REFER (blind / Replaces),          |
   |   dial internal extensions, hold (re-INVITE sendonly), DTMF (RFC 4733)               |
   |   media: SRTP, G.722 / PCMU / PCMA <-> 16 kHz PCM, resampling, echo gate,            |
   |          local conference mixer, playout queue, RTP quality                         |
   |        |  WebSocket, HMAC-authenticated, network "voice" (internal: no route out),   |
   |        |  no host port; PCM frames tagged by leg + JSON control                      |
   |        v                                                                              |
   | unity (existing Drawbridge server process, src/platform/modules/voice)               |
   |   VoiceHarness: admission, minted call ID voice_<uuid>, CallSession per call         |
   |   provider adapter (OpenAI Realtime / ElevenLabs) -- TLS --> hosted model            |
   |   tools: executeAgentTool() in-process = same gate as /api/retell                    |
   |          (staff-only refusal, call binding, minimum necessary, idempotency, audit)   |
   |   scripted clips, emergency backstop, transcripts, metrics, admin screen /app/voice  |
   +---------------------------------------------------------------------------------------+
```

### 2.1 Why two containers, and why the harness lives in the unity process

- **The harness stays in the unity process.** The call-binding store, the hash-chained audit log (its chain head is cached per process), the Veradigm sessions, keep-warm and system status are all per process. A second process writing tool calls would break `audit:verify` and could not see bindings made on the same call (`OWN_VOICE_LAYER_PLAN.md` 1.3).
- **SIP/RTP lives in a small separate container.** The real-time parts (20 ms RTP timing, codecs, SRTP, NAT keepalives) are kept off the Node event loop. It holds no patient logic.
- **Stack choice:** `emiago/diago` v0.41.0 with `emiago/sipgo` v1.6.0 (Go, pinned in `go.sum`), and G.722 from `gotranspile/g722`.
  - They cover REGISTER over TLS with digest auth, SDES-SRTP (pion/srtp), symmetric RTP, REFER (RFC 3515/3892), RFC 4733 DTMF, re-INVITE hold, and outbound INVITE.
  - That is one static binary on distroless, non-root, read-only.
  - Asterisk (the plan's choice) would add a large C service and its config language for the same job.
  - PJSIP/pjsua2 and baresip need C modules and bindings.

### 2.2 Files

| Path | Role |
|---|---|
| `deploy/voice-gw/main.go`, `config.go` | Start-up, env config (fail closed), TLS client config, STUN, log redaction (`redact.go`) |
| `deploy/voice-gw/gateway.go` | Registration loop (TLS probe, REGISTER, re-REGISTER at 45% of expiry, CRLF keepalive), source guard, MWI NOTIFY ack, call admission, echo-test mode |
| `deploy/voice-gw/session.go` | One harness session per inbound call: legs, dial, hold/resume, conference, blind and attended REFER |
| `deploy/voice-gw/call.go`, `codec.go`, `dsp.go`, `playout.go`, `mixer.go`, `echo.go` | Media: codecs, 16 kHz path, resampler, playout segments, local conference, echo gate, VAD, quality |
| `deploy/voice-gw/link.go`, `status.go` | Harness link (HMAC header, message types), registration status / healthcheck |
| `src/platform/modules/voice/gw-server.ts` | Link server, admission, clip preparation, status to security events |
| `src/platform/modules/voice/session.ts` | `CallSession`: audio routing by leg, tools, scripts, barge-in, emergency backstop, transfers, warm transfer state machine, metrics |
| `src/platform/modules/voice/providers/*` | OpenAI Realtime adapter, ElevenLabs adapter (+ agent provisioning), per-leg transcriber |
| `src/platform/modules/voice/config.ts` | Agent configuration (validation, store, handoff actions, allow-lists) |
| `src/platform/modules/voice/scripts.ts`, `guard.ts` | Scripted lines and clip store (SHA-256 checked), emergency phrase detector |
| `src/platform/modules/voice/transcript.ts` | Voice call records, transcripts with speaker labels, turn metrics, retention, calls index |
| `src/platform/modules/voice/index.ts` | Admin screen `/app/voice` (configuration, status, recent calls, transcript view) |
| `src/scripts/smoke-voice-harness.ts` | Offline tests (fake providers and gateway) |

### 2.3 Call flow

1. The PBX sends an INVITE to 4515 over our TLS connection.
2. voice-gw checks the source: it must be a proxy IP.
3. voice-gw checks the media policy: SRTP is required by default, otherwise 488.
4. It opens a per-call WebSocket to the harness and sends `call_start` (caller ID as presented, codecs, SRTP).
5. The harness admits or rejects the call:
   - it rejects with 480 or 503 when there is no SRTP, no provider key, no BAA, missing clips, schema drift, too many calls, or the model cannot connect;
   - the PBX's no-answer route then takes the call.
6. On admission the harness mints `voice_<uuid>`, connects the model (prompt + tools + variables), and replies `accept`.
7. voice-gw answers (200 OK, G.722 preferred), streams 16 kHz caller audio (resampled to the model's rate) and plays the agent's audio.
8. The greeting clip plays immediately, without waiting for the model. Its exact text goes into the model's history.
9. Caller turn: the model's server-side voice detection ends the turn. A tool call runs in-process under the minted ID. The filler clip plays if nothing else is playing, then the answer.
10. Barge-in: the provider reports caller speech, so the harness clears the gateway queue and truncates the model's item to what was actually played. Safety clips are never cut off.
11. Hang-up: transcript and metrics are saved, the call binding is forgotten, and the audit gets `voice_call_end`.

### 2.4 Speaker labels

Labels come from the leg the audio arrived on, never from guessing.

| Label | Source |
|---|---|
| `caller` | leg 0, the inbound call (the model's input transcription while it hears only leg 0) |
| `far_end` | leg 0 after the PBX re-negotiated that leg itself (it may have joined a third party in a PBX-side conference; those voices arrive mixed in one stream and are not told apart) |
| `staff:<ext>` | a leg we dialled (warm transfer), with its own transcription session |
| `agent` | model speech (`kind: speech`, `truncated` when cut off) or a clip (`kind: script`, with the script ID) |
| `system` | tool calls (name and outcome only, never results), transfers, hold, keypad |

In a local conference every human leg is transcribed separately. The model's mixed input transcription is not used for labels there.

---

## 3. Titan PBX notes (verified Oct 18 2026)

**Registration and signalling:**
- The SIP domain `mit.voip.moatit.net` has no A record. The DNS SRV `_sip._udp` record points to `kam00{1,2,3}.z1.{grr,phl}.voipproxy.net` port 7000 (Kamailio). There is no SRV for TCP or TLS.
- TLS 1.2 answers on 5061 on the same hosts. We set `VOICE_SIP_PROXIES` explicitly: kam001 grr, kam002 grr, kam002 phl.
- All of them present one GoDaddy certificate whose CN is `kam001.phl.wlcomm.net` (the SANs list other wlcomm hosts, not the voipproxy names).
  - We verify the chain against the system roots and accept exactly that name (`VOICE_SIP_TLS_SERVER_NAME`).
  - Verification is never disabled.
- REGISTER result: 200 OK over TLS 1.2, `TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384`. The PBX sees us at 136.46.162.67 (the office NAT).
  - The portal shows the contact `sip:…@136.46.162.67:<port>;transport=tls`, Expires 540, and the User-Agent `Drawbridge-voice-gw/0.2.0` (from build 4970dd5).
- **The provider's internal hop is outside our control.** The portal shows the proxy path `162.252.250.41:7000;transport=udp`. We use TLS to the edge proxy, but Titan's own hop from the edge to its core is UDP inside their network. Signalling (no audio) on that hop is Titan's responsibility under their agreement.

**Proxy behaviour:**
- Occasionally a new TLS connection to one proxy fails (`tls_connect_failed`).
- The gateway checks each proxy's certificate once per process, rotates to the next proxy, and re-registers.
- The keepalive is a double CRLF (RFC 5626) on the registration's own connection every 25 s, plus an OPTIONS liveness check every 5 minutes. Earlier builds sent OPTIONS every 25 s; kam002 did not answer them, which caused needless re-registration.

**Media:**
- First call (19:58 UTC): the PBX offered RTP/AVP (no SRTP), PCMU, PCMA and telephone-event.
- The owner then turned on SRTP and G.722 (16 kHz) for 4515. Codecs on now: PCMU, PCMA, G.722 16k.
- See 9 for the verification call.

**Capacity:** Titan allows 10 simultaneous calls system-wide (raisable on request). The gateway caps itself at `VOICE_MAX_CALLS=4` dialogs (inbound plus dialled legs), so the agent can never take all of the clinic's lines. The harness caps itself at `VOICE_MAX_SESSIONS=4` conversations.

**Call control:** the Titan REST API (api.titan.host/api/v2) is a read-only inventory with no call control. Transfers are SIP REFER from our user agent.

**Feature codes on this system (owner, Oct 18 2026):**

| Code | Feature | Agent use |
|---|---|---|
| `**<ext>` | Direct to voicemail | Handoff action `voicemail` (e.g. `**4500`) |
| `*3` | Park | Handoff action `park` (staff retrieve with `*5`) |
| `*4` | Valet park (assigns and announces a slot) | Handoff action `valet_park`. The slot is announced to the party being parked. Staff need the park list on their phones, or the agent tells them by message. To verify. |
| `*5` | Retrieve | Staff side only; never an agent target |
| `*0<ext>` | Intercom (auto-answers a staff phone) | **Never**: not allowed in configuration |
| `*72` / `*73` / `*74` / `*56` | Call forward enable / disable / toggle / update | **Never**: the agent may not change PBX settings |
| `*67`, `*2` | Privacy, dynamic caller ID | Not needed for inbound; never allowed |
| `*11` / `*12` / `*13` | Hot desking | Not used; never allowed |
| `6683` | Move Call | Off on this system |

Whether Titan accepts each code as a REFER target is checked on the test extension (see 9). If the PBX refuses a REFER, the agent plays the transfer-failed line and offers a message instead.

---

## 4. Agent configuration (`/app/voice`, administrators only)

Stored in `<CALL_RECORDS_DIR>/voice/agents.json` (mode 0600). It holds no secrets: validation refuses anything that looks like a key or token.

| Field | Notes |
|---|---|
| provider, model, voice, language | `openai` / `gpt-realtime-2.1` / `marin`; or `elevenlabs` + voice ID + ElevenLabs agent ID |
| prompt | Default: `retell-prompts/unity-healthcare-agent.md` (the Retell v7 prompt, variables filled per call) plus the voice-line addendum (say_script, transfer, end_call). Custom prompts must keep the safety rules. |
| enabled tools | Any of the Unity phone-agent tools (`AGENT_TOOLS`, same compact schemas as Retell) plus `say_script` (cannot be turned off), `transfer_to_staff`, `warm_transfer`, `end_call`. FHIR backup tools are not offered (they live in the FHIR process). |
| handoff actions | `id \| label \| kind \| target \| when to use`. Kinds: `transfer` (2-8 digit extension, ring group or queue, or a 10-digit US/NANP number), `voicemail` (`**<ext>`), `park` (`*3`), `valet_park` (`*4`). Nothing else. The model sees the action IDs and labels, never the numbers. |
| dial allow-list | Extensions and outside US numbers the agent may call out to (warm transfer) or transfer to when outside. `allow_any_nanp` (off by default) allows any US/NANP number. |
| dial limits | `max_dials_per_call` (default 2) and `max_dials_per_hour` per agent (default 20). Outside transfers and every warm-transfer dial count. When a limit is hit: refused, `voice_dial_limit` security event, help-desk alert (at most hourly). |
| warm transfer | Destinations: transfer actions on the dial allow-list (internal or outside); mode `conference` (local 3-way, then the agent leaves) or `attended_refer` (REFER with Replaces, conference if refused); ring timeout (default 25 s); hold timeout (default 90 s); agent leaves or stays muted; transcription after the agent leaves (default off) |
| turn detection | `semantic_vad` (eagerness) or `server_vad` (silence ms) |

The default configuration has no handoffs until `VOICE_FRONT_DESK_EXT` is set in `.env`; it then gets "front desk" (transfer) and "front desk voicemail".

**Outside numbers (owner decision, Oct 18 2026):** the agent may dial and transfer inside (extensions, queues, groups) and outside (US/NANP), under guardrails (`src/platform/modules/voice/dialplan.ts`, mirrored in `deploy/voice-gw/dialplan.go`).
- **Always refused:**
  - international (`011`, `+` not 1, NANP area codes of other countries such as 809/876);
  - premium (900, 976 exchanges, 5XX personal numbers, 700);
  - N11 service codes;
  - emergency numbers: the agent never dials 911; it plays the 911 line instead;
  - 7-digit numbers;
  - star codes other than `**ext`, `*3`, `*4`.
- **Checked twice:** the harness checks the agent's handoff actions and allow-list, plus the per-call and per-hour limits; the gateway re-classifies every REFER and dial target.
- **Audit and logs:** the target appears as `ext:<ext>` or `pstn:...<last 4>`. Logs and transcripts keep the last 4 digits only.
- **Live test (owner, Oct 18):** the owner's cell is on the test agent's allow-list (stored in the agent configuration on the data volume, not in code) together with his desk extension (4501).
- **PBX side:** Titan records every inbound and outbound call (owner). Outbound calls are free on this plan.

---

## 5. Tools, scripts and safety

- **Tools.** Every Unity tool goes through `executeAgentTool(name, args, callId, callerPhone, "voice")`, the function `/api/retell` uses. That means:
  - staff-only refusal;
  - call binding (identity before information);
  - minimum necessary;
  - idempotent writes;
  - after-hours call records;
  - the fail-fast records-unavailable answer;
  - audit with `channel: "voice"`.
- **The call ID is minted by the harness** (`voice_<uuid>`). A `call_id` in the model's arguments is stripped. This closes `SECURITY_CONTROLS.md` §12 ("anyone with the agent key can choose any call ID") for this channel.
- A tool not enabled on the agent is refused (`TOOL_NOT_ENABLED`) and audited before anything runs.
- **Scripted lines** (`scripts.ts`):
  - GREETING, GREETING_AFTER_HOURS, EMERGENCY_911, NO_MEDICAL_ADVICE, RECORDS_DOWN, CANT_VERIFY, GOODBYE, TRANSFER, TRANSFER_VOICEMAIL, PARK, HOLD, STAFF_UNAVAILABLE, TRANSFER_FAILED, plus the tool fillers.
  - Rendered once with the agent's own voice (OpenAI `gpt-4o-mini-tts` for OpenAI agents, ElevenLabs TTS for ElevenLabs agents). The clip text never contains patient data.
  - Stored with a SHA-256 (checked on every load) and played byte for byte.
  - The safety clips cannot be cut off by barge-in.
  - A call is refused (503 to the gateway, so the PBX's no-answer route takes it) when a required clip is missing.
- **Emergency backstop.** If the caller's transcript matches an emergency phrase (chest pain, can't breathe, stroke signs, bleeding, fainting, overdose, self-harm, "911", ...), the harness:
  - cancels the model's response;
  - plays EMERGENCY_911 itself;
  - tells the model to offer a transfer;
  - does this at most once a minute; it is audited as `voice_emergency_backstop`.
- **The model never hears itself:**
  1. Only human legs' inbound audio is sent to the model.
  2. The gateway's echo gate (`VOICE_ECHO_GATE_DB`, default 10 dB) replaces inbound frames much quieter than what we just played (800 ms window) with silence, so line or acoustic residue of the agent's voice cannot trigger a false barge-in. A caller talking over the agent is louder and passes.
  3. In a conference each party hears the other parties, never itself.
- **Warm transfer** (`warm_transfer` tool):
  1. The HOLD clip plays, then the caller is held (re-INVITE `sendonly`) and the model hears nothing from them.
  2. The allow-listed extension is dialled.
  3. When staff answer, the model speaks only to staff and briefs them with the minimum necessary: "a caller verified on this call as <name>" only if the call binding has a verified patient, else "a caller who is NOT verified", plus the reason.
  4. Staff accept by saying so (the model calls `connect_caller`) or with keypad 1, or decline (keypad 2 or `staff_declined`).
  5. On accept: resume the caller, local conference, and the agent leaves (or stays muted).
  6. No answer, decline or the hold timeout: hang up the staff leg, resume the caller, play STAFF_UNAVAILABLE, and offer voicemail or a staff message.
  7. If the caller hangs up during the consult, the staff leg is dropped.
  - Audited: `voice_dial`, `voice_hold`, `voice_resume`, `voice_conference_join`, `voice_conference_leave`, `voice_transfer`.

---

## 6. Security and HIPAA

### 6.1 Transport

**SIP signalling:**
- TLS 1.2+ only.
- Certificate verified against the system roots and one explicitly allowed name.
- The gateway does not start without the TLS proxy list and that name (fail closed).

**Media:**
- `VOICE_MEDIA_ENCRYPTION=srtp-required` (default) refuses calls without SDES-SRTP with 488, and logs the `srtp_refused` security event.
- `srtp-preferred-synthetic-only` is for synthetic test calls only.
- The harness refuses non-SRTP calls a second time unless `VOICE_ALLOW_PLAIN_RTP=synthetic-only`.
- For outbound legs with `srtp-required` we offer RTP/SAVP and hang up a leg that did not negotiate SRTP.

**Model providers:** WSS/HTTPS only. Keys are sent only in headers (OpenAI `Authorization`, ElevenLabs `xi-api-key`), never in URLs.

**Gateway link:**
- A WebSocket on the internal Docker network `voice` (`internal: true`: no route off the host). Only unity and voice-gw are attached.
- No host port, and nginx never proxies it (the harness listens on 3010; nginx only knows 3001).
- Every connection carries `X-Voice-Gw-Auth: v1,kind,ts,nonce,mac`: HMAC-SHA256 with `VOICE_GW_SECRET` (32+ chars), a 30 s window, single-use nonces, and a constant-time compare.
- Failures are logged as `voice_gw_rejected` security events (throttled).
- Without the secret the harness does not listen at all.
- The link is plain `ws://` inside the host's isolated bridge network, as the owner's design asked. The PCM never leaves the machine's memory or virtual network. Moving the gateway to another host would need `wss://` with a pinned certificate (supported by the gateway's URL check; not built).

### 6.2 Secrets

- `SIP_USERNAME`, `SIP_PASSWORD`, `VOICE_GW_SECRET`, `OPENAI_API_KEY` and `ELEVENLABS_API_KEY` live in `deploy/local/.env` (or SSM) only.
- voice-gw receives only the SIP variables and the link secret (explicit `environment:`, no `env_file`).
- The gateway's log handler redacts the SIP user and password, the link secret, digest fields and phone numbers (last 4 kept), even inside library log lines that quote SIP headers.
- Nothing secret is in code, image, Git, docs or the agent configuration (validated).

### 6.3 Logging and audit

- **Server logs:** IDs, codes and timings only. Never transcript text, tool results or full phone numbers. Tested: `smoke:voice-harness` section 5.
- **Audit (hash chain, same process):**
  - every tool call (`channel: voice`) and every refusal;
  - `voice_call_start`, `voice_call_answered`, `voice_say_script`, `voice_emergency_backstop`, `voice_transfer`, `voice_dial`, `voice_hold`, `voice_resume`, `voice_conference_join`, `voice_conference_leave`, `voice_hangup`, `voice_call_end`, `voice_call_refused`.
- **Security events:** `voice_gw_rejected`, `sip_registered`, `sip_registration_lost`, `sip_tls_failure`, `srtp_refused`.

### 6.4 Transcripts and records (PHI)

- `<CALL_RECORDS_DIR>/voice/calls/<call_id>.json` (mode 0600, on the data volume), deleted after `CALL_RECORDS_RETENTION_DAYS` (default 30) like the on-call records.
- The calls index gets the call with the caller's last 4 digits only.
- An after-hours notebook record for the call gets `transcript_ref: voice:<id>`.
- The transcript screen is admin-only, and every view is in the staff access audit.
- No audio is recorded.

### 6.5 Business associates

| Party | Sees | Status |
|---|---|---|
| Titan (MOATiT's hosted PBX provider) | Call audio, caller ID | MOATiT's carrier/PBX agreement; the internal UDP signalling hop is theirs |
| OpenAI (Realtime, transcription, TTS for clips) | Caller audio, transcripts, tool results | BAA (owner). Confirm in writing that `/v1/realtime` (conversation and `intent=transcription`) is covered, with zero data retention on the project. Clip TTS text has no PHI. |
| ElevenLabs | Same as OpenAI when selected | **No BAA**: the harness refuses ElevenLabs agents unless `VOICE_ALLOW_NON_BAA_PROVIDER=synthetic-only`. Needs an Enterprise BAA with zero-retention mode before any real call. |

---

## 7. Environment variables

**voice-gw** (compose passes these explicitly):

| Variable | Default | |
|---|---|---|
| `SIP_REALM` (or `SIP_SERVER`), `SIP_USERNAME`, `SIP_PASSWORD`, `SIP_EXPIRES` | from `.env` | Extension credentials (secret) |
| `VOICE_SIP_AOR_USER` | `SIP_USERNAME` | AOR user if different from the auth user |
| `VOICE_SIP_PROXIES` | kam001/kam002 grr, kam002 phl `:5061` | TLS proxies, tried in order |
| `VOICE_SIP_TLS_SERVER_NAME` | `kam001.phl.wlcomm.net` | The one certificate name accepted |
| `VOICE_MEDIA_ENCRYPTION` | `srtp-required` | or `srtp-preferred-synthetic-only` |
| `VOICE_STUN_SERVER`, `VOICE_PUBLIC_IP` | `stun.cloudflare.com:3478` | Public address for SDP (symmetric RTP latches anyway) |
| `VOICE_RTP_PORT_MIN/MAX` | 20000-20199 | Inside the container; nothing published |
| `VOICE_MAX_CALLS` | 4 | Dialogs at once on the registration (Titan allows 10 system-wide) |
| `VOICE_GW_MODE` | `harness` | `greeting-echo` = stage-2 test (greeting clip then echo) |
| `VOICE_GW_SECRET` | from `.env` | Link HMAC key (32+ chars) |
| `VOICE_HARNESS_URL` | `ws://unity:3010/voice-gw` | |
| `VOICE_GW_FALLBACK_TARGET` | unset | REFER target if the harness drops mid-call (`sip:4500@realm`) |
| `VOICE_ECHO_GATE_DB` | 10 | 0 turns the echo gate off |
| `VOICE_GW_USER_AGENT` | `Drawbridge-voice-gw/<version>` | |

**unity (harness):**

| Variable | Default | |
|---|---|---|
| `VOICE_ENABLED` | off | `on` starts the harness |
| `VOICE_GW_SECRET` | | Same value as the gateway's |
| `VOICE_HARNESS_PORT` / `VOICE_HARNESS_HOST` | 3010 / 0.0.0.0 | Internal network only |
| `OPENAI_API_KEY` / `ELEVENLABS_API_KEY` | | Provider keys (secret) |
| `VOICE_AGENT_ID` | the stored active agent | |
| `VOICE_FRONT_DESK_EXT` | unset | Seeds the default handoffs and dial allow-list |
| `VOICE_MAX_SESSIONS` | 4 | |
| `VOICE_ALLOW_PLAIN_RTP` | unset | `synthetic-only` admits non-SRTP calls (tests) |
| `VOICE_ALLOW_NON_BAA_PROVIDER` | unset | `synthetic-only` admits ElevenLabs agents (tests) |
| `VOICE_PROMPT_FILE` | `retell-prompts/unity-healthcare-agent.md` | |
| `VOICE_TTS_MODEL`, `VOICE_OPENAI_TRANSCRIBE_MODEL`, `VOICE_ELEVENLABS_TTS_MODEL` | `gpt-4o-mini-tts`, `gpt-4o-transcribe`, `eleven_flash_v2_5` | |
| `SIP_REALM` | | Builds REFER and dial targets |

---

## 8. How to run (local stack)

The local stack runs release-1 (see the `local-first-deploy` notes). The voice harness runs on top of it with one more override file outside the repo, `%LOCALAPPDATA%\drawbridge\compose\voice-harness.override.yml`:
- it adds `voice-gw` (build context `wt-voice-harness/deploy/voice-gw`);
- for stage 3 it points the unity build at an integration worktree (release-1 merged with this branch) and joins unity to the `voice` network.

```
cd D:\VeradigmAI-DrawBridge\veradigm-ai-mcp\deploy\local
docker compose -f docker-compose.yml -f %LOCALAPPDATA%\drawbridge\compose\release-1.override.yml `
  -f %LOCALAPPDATA%\drawbridge\compose\voice-harness.override.yml up -d --build --no-deps voice-gw unity
```

- **Stop the voice line:** `docker compose ... rm -sf voice-gw`. The extension unregisters, and the PBX's unavailable route takes 4515's calls.
- **Roll back unity:** rebuild with only the release-1 override.

In the repo compose file (`deploy/local/docker-compose.yml`), `voice-gw` sits behind the opt-in `voice` profile: `docker compose --profile voice up -d voice-gw`.

---

## 9. Test procedure and results

**Offline:**
- `npm run build`;
- `npm run smoke:voice-harness` (11 checks: link auth, config, tool gate, scripts, labels, warm transfer, echo control, admission, OpenAI adapter, prompt);
- the existing offline suites;
- in `deploy/voice-gw`: `go test ./...` (resampler, G.722, playout segments, mixer: three-way without self-audio, echo gate, refer/dial allow-lists, SDP, auth token, redaction, config fail-closed).

**Live (owner calls 4515 from his desk phone; synthetic patients only):**

| Stage | What | Result |
|---|---|---|
| 1 | REGISTER over TLS | 200 OK, TLS 1.2 ECDHE-RSA-AES256-GCM, certificate verified as kam001.phl.wlcomm.net |
| 2 | Echo test (greeting clip, then echo), Oct 18 19:58 UTC | Answered; greeting played in full (11.3 s); two-way audio (first inbound RTP 266 ms after 200 OK; 1,939 in / 1,960 out over 39 s). **SRTP not offered** (RTP/AVP); PCMU. Owner heard a 0.25-0.5 s echo delay (network and phone/PBX jitter buffers; our internal queue is one 20 ms frame). |
| 2b | After SRTP + G.722 were enabled on 4515 | Pending the owner's call |
| 3 | Agent on OpenAI Realtime: verify, look up visits, emergency line, transfer by REFER | Pending |
| 4 | Warm transfer to an allow-listed extension: hold, brief, conference; second simultaneous call | Pending |

**Usage and cost per call** (`usage.ts`, counts only):
- **Realtime model:** every `response.done` usage is summed per call: input text and audio tokens (each split cached / uncached), output text and audio tokens, and the model name.
- **Transcription:** per leg (caller; each `staff:<ext or ...last4>` leg). It records the audio seconds we sent to the transcription model and what the session reported (duration or tokens).
- **Estimate:** the call duration gives the estimated cost and the cost per minute.
- **Price table:** `<CALL_RECORDS_DIR>/voice/prices.json`, USD; editable on `/app/voice`, so prices change without a code change.
  - Seeded Oct 18 2026:
    - gpt-realtime-2.1: audio $32 in, $0.40 cached, $64 out; text $4 in, $0.40 cached, $24 out per 1M tokens;
    - gpt-realtime-2.1-mini: audio $10 / $0.30 / $20; its text prices ($0.60 / $0.06 / $2.40) are an assumption, to be verified;
    - gpt-4o-transcribe: $0.006 per minute.
  - Each record keeps the prices it used.
- **Where it shows:** on `/app/voice` (minutes, estimated cost and cost per minute per call; a usage card on each call) and in one metadata log line per call.
- **ElevenLabs usage is not collected yet.** Its transcription is listed as `elevenlabs-asr` (unpriced).

**Latency** is recorded per turn: caller end of speech (gateway energy detector) to the first agent audio leaving the gateway, plus the provider's own end-of-speech to first audio, plus tool timings. It is shown on `/app/voice` and in each call record.

---

## 10. Known limitations and open risks

**TODO (from the live calls, Oct 18):**
- **Tool-turn latency is 3.5-5.8 s** (caller end of speech to the answer after a Veradigm tool; the tool itself 0.7-1.5 s). The time goes to the model's spoken preamble plus a second model pass. To investigate:
  - no preamble when the tool is fast;
  - our filler clip only if the tool takes longer than about 1 s;
  - returning function results so that one pass can answer.
- **Hold:** Titan refused our hold re-INVITE (sendonly, fresh SDES keys) with 488.
  - Local hold is now the default: the caller hears only our hold line, never the briefing.
  - To find out why Titan refuses, the gateway logs Titan's reason and Warning header when SIP hold is enabled.
  - Options to try: keep the same SDES key, use UPDATE, or ask Titan.
- **Caller-side transcription on narrowband PCMU** mis-heard a spelled name; the model recovered by asking the caller to spell it. To improve:
  - get G.722 offered end to end (enabled on 4515; Titan's offer did not include it);
  - check the transcription language/prompt settings.
- **Staff-leg transcripts** during a consult did not appear in the 20:51 call. Check that the per-leg transcription session (`intent=transcription`) returns text.
- **OpenAI error `invalid_value` once per call:** the log now names the refused parameter. Find which request causes it.

- **SRTP:** until the owner's verification call confirms SDES-SRTP on 4515, patient calls are refused by design.
- **PBX internal hop:** Titan's edge-to-core signalling hop is UDP (provider's network).
- **NAT:** the dev host is behind NAT plus Docker NAT. We rely on symmetric RTP latching at Titan's media relay (we send from the first 20 ms) and TLS connection reuse for inbound INVITEs. One-way audio is reported as `media_warning no_inbound_rtp`. A VPN or a static public address is preferable in production.
- **Attended transfer through Titan:** REFER with Replaces through a B2BUA may be refused. The harness then keeps the local conference (our gateway stays in the media path for the rest of the call).
- **Valet park (`*4`):** the slot announcement goes to the parked party. How staff learn the slot is to be checked on Titan.
- **Hold music:** we hold with re-INVITE `sendonly` and play the HOLD line first. Whether Titan plays music on hold to the held caller is to be verified; if not, a hold clip loop can be added.
- **Realtime model limits** (see `VOICE_V7_EXPERIMENT.md`):
  - generated speech cannot be text-guarded before it is spoken;
  - only scripted lines are exact;
  - the model may paraphrase medical-advice refusals unless it calls `say_script`.
  - The emergency backstop is deterministic; the no-medical-advice line depends on the model calling the tool.
- **FHIR backup tools** are not offered on this channel (they live in the FHIR process; `fhir_tools` is forced OFF in the prompt).
- **ElevenLabs:** the adapter and agent provisioning are written to the documented API, but they are not exercised live yet (no BAA; synthetic tests only).
- **Barge-in on ElevenLabs:** no truncate API; we drop the rest of the interrupted response.
- **Outbound calls** (outreach) stay on Retell.
- **G.722.1 / Opus:** not supported (G.722.1 is off on 4515).
- **diago v0.41.0** was released Oct 6 2026. It is pinned and reviewed for the parts we use; watch upstream fixes.
