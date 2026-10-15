# Client presentation: VeradigmAI for Idaho Kidney Institute

**Deck (Claude Slides artifact, private to Ali):** https://claude.ai/artifact/PWMZMNTRQ8efpKVhQf78Xv
Export to PowerPoint or PDF from the deck's Share/Export menu. Speaker notes on every slide carry sources and caveats.

| # | Slide | Key message |
|---|---|---|
| 1 | Cover: "A phone agent that knows the chart" | MOATiT logo; "MOATiT VeradigmAI · built on Drawbridge"; call the agent now: (208) 904-3641 |
| 2 | The opportunity | Most front-desk calls ask questions Veradigm already answers |
| 3 | How it works | Patient → voice agent → **Drawbridge** (39 tools) → Veradigm EHR (23) / Veradigm PM (16); data already hosted by MOATiT |
| 4 | What it handles | Appointments, refill questions, patient details, providers and clinics, insurance and balance; warm transfer for everything else |
| 5 | On a real call | Three call walkthroughs with the Veradigm actions behind each step |
| 6 | The tool set | 39 tools across Veradigm EHR and PM (table) |
| 7 | Changes to the record | Reads EHR and PM; changes only six things (book/move, cancel, confirm, update contact, register, message staff); nothing clinical written |
| 8 | Guardrails | Identity first, no medical advice, fixed set of actions, a person on request |
| 9 | Beyond the phone | Reminder calls, no-show follow-up, recall outreach, staff assistant, morning huddle brief, pre-visit check |
| 10 | The on-call assistant | After-hours flow, transfer with brief to on-call provider, on-call brief in the Drawbridge app; **December 2026: in-call assist** |
| 11 | Deployment | "Two approvals from you. The rest is on us." Phase 1 chart reads, Phase 2 scheduling and changes, Phase 3 go live |
| 12 | Onboarding | Your part and ours; **no build or integration cost to Idaho Kidney** |
| 13 | Your decisions | Which calls first, what it may say about labs/meds, who receives transfers/refills, after-hours handling |
| A–D | Appendix | Every tool with its Veradigm action and Built/Planned status (PM patients and billing; PM scheduling; EHR records; EHR chart reads) |

## Claims in the deck that engineering must make true

- Slide 3/12: **hosting in MOATiT's data center.** The repo deploys to AWS (see `08` Q6).
- Slide 7: **only six kinds of change.** Enforce it in the tool list. No other write tools should be exposed to the agent.
- Slide 8: **identity first, read back before writes, transfer on request.** Enforce in the prompt (`07`) and, where possible, in the tools.
- Slide 6/appendix: **Built vs Planned** labels must match what's deployed on demo day.
