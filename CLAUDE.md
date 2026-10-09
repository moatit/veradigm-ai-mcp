# CLAUDE.md: Drawbridge (veradigm-ai-mcp)

You're working on **Drawbridge**, MOATiT's MCP servers that let the VeradigmAI phone agent (Retell) read and act on Veradigm EHR and Veradigm PM for clinics. The first client is Idaho Kidney Institute. Full context lives in `docs/handover/`. Start with `docs/handover/00_START_HERE.md`.

## Hard rules

1. **Never push to `main` without the owner's explicit OK.** `.github/workflows/deploy.yml` deploys every push to `main` to AWS. Work on a branch; open a PR.
2. **Never put credentials anywhere but `.env` or AWS SSM.** Not in code, commits, logs, test fixtures, Postman files or chat. Real patient data never goes in fixtures or logs.
3. **Sandbox only.** Don't point anything at a production Veradigm endpoint unless the owner explicitly says so.
4. **The agent never writes to the chart.** Allowed writes: `SaveAppointment`, `SetAppointmentStatus` (cancel/confirm), `SavePatient` (register/update contact), `SaveTask` (staff task). Anything else needs owner approval and a deck update.
5. **Errors are never empty results.** A tool must not return `[]` / "none found" when the Veradigm call failed. Return `{ success: false, error_code, retryable }` so the agent says "I'm having trouble" instead of "you have no appointments."
6. **FHIR is read only** (Veradigm docs). No POST/PUT to FHIR. Appointments and demographics go through Unity PM.
7. **Use Veradigm's action names.** Every Unity action must exist in Veradigm's PM or EHR API reference (`docs/handover/04_VERADIGM_REFERENCE.md`), or be proven to work by `npm run verify:sandbox`. Keep action names in config, not scattered literals.
8. In anything client-facing, say **Veradigm® EHR / Veradigm® PM** and **Drawbridge**, never "MCP," "FHIR" or "Unity." Write **MOATiT** exactly like that.

## Layout

- `src/index.ts`, `src/tools/*`, `src/services/fhir.service.ts`: FHIR MCP server (port 3000)
- `src/unity/index.ts`, `src/unity/tools/*`, `src/unity/services/*`: Unity MCP server (port 3001)
- `src/unity/config/unity-endpoints.ts`: Unity action names (several need fixing; see audit §3)
- `src/scripts/verify-sandbox.ts`: read-only sandbox check of every action and FHIR read
- `retell-prompts/`: voice agent prompt. Additions are in `docs/handover/07_AGENT_PROMPT_ADDENDUM.md`
- `infra/`: Terraform (AWS EC2/ECR/SSM), nginx for `admin.` / `fhir.` / `unity.veradigmai.com`

## Commands

```
npm ci
npm run build                 # tsc
npm run dev / dev:unity       # MCP servers over stdio
npm run server / server:unity # HTTP test servers
npm run verify:sandbox        # needs .env and network access to the Veradigm sandboxes
npx tsc --noEmit -p .         # type-check
```

## Current priorities (demo Fri Oct 9, 2026, 5 PM MT; code freeze 2 PM)

Follow `docs/handover/01_DEMO_BUILD_SPEC.md`. In order:
1. Run `verify:sandbox`.
2. Fix action names.
3. Fix silent empty-list returns.
4. Disable FHIR appointment tools and `get_medication_statements` in the agent.
5. Add P0/P1 planned tools: cancellation reasons, appointment types, appointment details, account balance, insurance policy, staff task.
6. After-hours mode and the call-record store for the on-call notebook.

Tool catalog with exact Veradigm actions: `docs/handover/03_TOOL_CATALOG.csv`.
