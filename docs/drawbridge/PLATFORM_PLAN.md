# Drawbridge platform plan

Drawbridge is one platform: the VeradigmAI phone agent and the staff tools both act on Veradigm® EHR and Veradigm® PM only through Drawbridge's fixed set of actions. This plan covers everything in the client deck and the build spec, and how it's split across parallel builders.

## Runtime (local dev/test, then drawbridge.moatit.dev → production)

```
Retell (test line 208-904-3641) ──HTTPS──> drawbridge.moatit.dev (Cloudflare tunnel, host)
                                              │
                                   127.0.0.1:8095 gateway (nginx, deploy/local)
                         ┌────────────────────┼─────────────────────┐
                 /fhir/* (agent only)   /unity/* + /api/*        /app (staff, login)
                         │                    │                     │
                   fhir container       unity container  ◄──────────┘
                   (Veradigm EHR,       (Veradigm PM/EHR Unity tools
                    FHIR, read only)     + platform modules + call-record data volume)
```

- Staff app: `/app` (one login, shared nav). Agent tools: `/unity/api/retell`, `/fhir/api/retell` with header `x-drawbridge-key`.
- Modules live in `src/platform/modules/<name>/` (or an existing feature folder), implement `PlatformModule` (`src/platform/registry.ts`) and are registered in `src/platform/modules.ts`.
- Data: file-backed JSON stores under `CALL_RECORDS_DIR` (`/app/data` volume) for the dev platform. Move to Postgres in the MOATiT data center before real PHI (open question Q5/Q6).

## Feature map (deck → module)

| Deck / spec item | Module | Status |
|---|---|---|
| Phone agent: appointments, chart reads, billing, insurance, staff messages | Unity + FHIR tools | Built (`handover/demo-2026-10-09`), sandbox verification pending |
| On-call assistant, after-hours mode, on-call brief (slide 10) | `oncall` | Built |
| Staff assistant ("who has an opening Tuesday afternoon?"), day schedule, location hours, providers (slides 6, 9) | `scheduling` | Work package A |
| Reminder calls, no-show follow-up, recall outreach (slide 9) | `outreach` | Work package B |
| Morning huddle brief, pre-visit check (slide 9) | `huddle` | Work package C |
| Audit log (spec §4 rule 8), Retell call events → call records, activity screen | `activity` | Work package D |
| In-call assist, three-way (slide 10) | — | December 2026 (not started) |

## Rules every module follows (from CLAUDE.md)

1. Errors are never empty results. Throw; the platform returns `{success:false,error_code,retryable}`.
2. Veradigm action names come from `UnityActions` (`src/unity/config/unity-endpoints.ts`); add new ones there with `action('KEY','Name')`.
3. Writes to Veradigm only: `SaveAppointment`, `SetAppointmentStatus`, `SavePatient`, `SaveTask`. Nothing clinical.
4. No PHI in logs: log tool names, IDs and outcomes only.
5. Staff UI uses `page()`/`esc()` from `src/platform/shell.ts`; every value rendered goes through `esc()`.
6. Outbound calls go only through the outreach module, only to `OUTBOUND_ALLOWLIST` numbers in dev, and never without a staff click or an explicit schedule.
7. Client-facing text: "Veradigm® EHR", "Veradigm® PM", "Drawbridge", "MOATiT". Never "MCP", "FHIR" or "Unity".
