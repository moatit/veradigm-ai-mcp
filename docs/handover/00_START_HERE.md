# VeradigmAI on Drawbridge: Handover (start here)

**Prepared:** Thursday, October 8, 2026, evening (MT)
**For:** the engineer or coding agent taking over the build (Kanaya, a Claude Code session, or both)
**Owner:** Ali Khan, MOATiT

---

## The one-paragraph version

MOATiT is building **VeradigmAI**, an AI phone agent for **Idaho Kidney Institute (IKI)**, a MOATiT client on Veradigm whose data MOATiT hosts in its own data center. The agent answers patient calls and works directly on top of Veradigm EHR and Veradigm PM through **Drawbridge**, MOATiT's MCP server. Drawbridge is the only way the agent can touch Veradigm, through a fixed set of tools. The code is in `github.com/moatit/veradigm-ai-mcp`. Ali presents a **live demo on Veradigm sandbox data to IKI's owner on Friday, October 9, 2026 at 5:00 PM MT.** After that, the path to production is Veradigm certification and two approvals from IKI.

## Deadline and definition of done

- **Demo:** Friday, October 9, 2026, 5:00 PM MT. **Code freeze: 2:00 PM MT.**
- **Test phone line:** (208) 904-3641 (voice agent, Retell; connected to the sandbox).
- **Done means:** the P0 scenarios in `01_DEMO_BUILD_SPEC.md` work live by phone, three runs in a row each, and a narrated backup video exists.

## Read in this order

| File | What it is |
|---|---|
| `00_START_HERE.md` | This page |
| `01_DEMO_BUILD_SPEC.md` | What to build for tomorrow, priorities, rules, timeline |
| `02_REPO_AUDIT.md` | What's in the repo today, what's wrong, file and line references |
| `03_TOOL_CATALOG.csv` | All 39 tools, the Veradigm action behind each, status, priority |
| `04_VERADIGM_REFERENCE.md` | Everything we learned from Veradigm's docs, distilled, with sources |
| `05_TEST_DATA.md` | Sandbox endpoints and test patients (no secrets) |
| `06_DEMO_SCRIPT.md` | Run of show for the 5 PM presentation, plus fallback |
| `07_AGENT_PROMPT_ADDENDUM.md` | Guardrails to add to the Retell agent prompt |
| `08_DECISIONS_AND_OPEN_QUESTIONS.md` | Decisions, costs, open questions (**handover folder only**: contains confidential contract terms) |
| `09_PRESENTATION.md` | The client deck: link and slide-by-slide summary |
| `CLAUDE.md` | Instructions for a coding agent working in the repo (repo root) |
| `scripts/verify-sandbox.ts` | Read-only sandbox check of every action (repo: `src/scripts/verify-sandbox.ts`, run with `npm run verify:sandbox`) |
| `repo-patch/` | The same CLAUDE.md, docs and script as a git commit, ready to apply |
| `source-docs/` | Veradigm docs (originals + text), Kanaya's tool email, the Integrator Agreement (confidential). **Handover folder only.** |
| `brand/` | MOATiT logo, Drawbridge logo (standard + light). **Handover folder only.** |

> **In the repo:** `docs/handover/` holds this file and 01, 02, 03, 05, 06, 07, 09, plus a version of 04 without the confidential fee and contract sections. `CLAUDE.md` is at the repo root and the script is `src/scripts/verify-sandbox.ts`.

## Status at handover

| Area | State |
|---|---|
| Client deck | Done (17 slides incl. appendix), MOATiT branded. See `09_PRESENTATION.md`. |
| Repo `main` | Last commit **Feb 13, 2026**. Newer work may exist only on Kanaya's machine. **First task: get it pushed.** |
| FHIR server (22 tools) | Built. 7 tools use resources Veradigm's FHIR API doesn't have (Appointment, MedicationStatement). Disable for the demo. |
| Unity server (13 tools) | Built. 7 tools send action names not in Veradigm's PM/EHR references. **Unverified** until the sandbox check runs. |
| Planned tools (14) | Not built. P0/P1 ones are listed in the spec. |
| On-call notebook (Drawbridge app) | Not built. Minimal version is P1 for the demo. |
| Sandbox verification | Script written (`scripts/verify-sandbox.ts`), **not yet run.** It must run on a machine that can reach the sandbox. |

## Blockers (as of handover)

1. **Unpushed code.** Kanaya must push whatever is newer than Feb 13 before anyone builds on `main`.
2. **Sandbox not reachable from the Claude cloud workspace.** Its network allowlist blocks `ubiquityunity.azurewebsites.net` and `*.open.allscripts.com`. Run tests on the AWS server, Kanaya's machine, or Ali's computer (via the Claude desktop app link).
3. **Claude can't push to the repo.** The Claude GitHub App isn't installed for the `moatit` org. An org admin can install it at https://github.com/apps/claude/installations/select_target. Until then, use `repo-patch/`.
4. **Credentials.** The sandbox `.env` values are on Ali's computer and Kanaya's. They never go in chat, tickets, or the repo.

## First hour checklist for whoever picks this up

1. Pull the latest code (ask Kanaya to push first). Apply `repo-patch/` with `git am` (it adds `CLAUDE.md`, `docs/handover/`, `src/scripts/verify-sandbox.ts` and the npm script).
2. With a working `.env`, on a machine that can reach the sandbox, run `npm run verify:sandbox`. Save `verify-sandbox-report.json` (sandbox data only).
3. Fix the Unity action names using the report (see `02_REPO_AUDIT.md` §3).
4. Fix the silent empty-list returns (`02_REPO_AUDIT.md` §4). This is the top demo risk.
5. Then build P0/P1 from `01_DEMO_BUILD_SPEC.md` in order.

## People

| Who | Role |
|---|---|
| Ali Khan | Founder/CEO, MOATiT. Product owner; presents the demo. ali@moatit.com |
| Kanaya (Kanhaiya Kumar) | Developer; built the Drawbridge tools. kanhaiya@moatit.com |
| Prashant, Musab | MOATiT team, cc'd on the Veradigm thread |
| IKI owner | Audience for the Oct 9 presentation |
| Veradigm Connect | VeradigmConnect@veradigm.com (certification, activation, licensing, fees) |
