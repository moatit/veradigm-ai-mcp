/**
 * Minimum necessary (HIPAA 164.502(b), 164.514(d)) for what the phone agent receives.
 *
 * Applied at the agent edges only (Retell custom functions `POST /api/retell` and the MCP endpoints of the Unity
 * and FHIR servers), never inside Drawbridge: document intake and the staff screens call the same tools and keep
 * the full result for matching. The agent and the voice platform get:
 *
 *  - patient records cut to what identity verification and the next tool call need: first and last name, date of
 *    birth, the Veradigm® PM / EHR patient IDs, and the MRN only when the caller gave the MRN. Never the address,
 *    phone numbers, e-mail, SSN (or its last 4), gender, race, ethnicity, language or marital status;
 *  - no patient list at all from a name-only search: a search must carry the caller's date of birth (or MRN) before
 *    any record comes back, so other patients with a similar name are never disclosed; the agent is told to ask;
 *  - nothing that looks like an SSN anywhere in a result (keys named ssn / social security, FHIR identifiers with
 *    the SSN system 2.16.840.1.113883.4.1 or type code SS).
 *
 * Failures ({ success:false, error_code }) pass through unchanged (CLAUDE.md rule 5).
 *
 * Staff-only tools that list other patients (the day's schedule, changed appointments, the huddle brief) are not
 * offered to the phone agent and are refused there (STAFF_ONLY); the staff screens still use them.
 *   DRAWBRIDGE_AGENT_STAFF_TOOLS   "on" offers them on the agent endpoints too (only for a staff-facing voice
 *                                  assistant deployment, never on the patient line). Default off.
 */
export const STAFF_ONLY_TOOLS: ReadonlySet<string> = new Set(['unity_get_day_schedule', 'unity_get_changed_appointments', 'drawbridge_get_huddle_brief']);

/** May the phone agent call this tool? */
export function agentToolAllowed(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return !STAFF_ONLY_TOOLS.has(name) || /^(1|true|on|yes)$/i.test(String(env.DRAWBRIDGE_AGENT_STAFF_TOOLS || '').trim());
}

/** The structured refusal for a staff-only tool on the agent endpoints. */
export function staffOnlyFailure(name: string) {
  return {
    success: false as const,
    error_code: 'STAFF_ONLY',
    retryable: false,
    tool: name,
    message: 'This tool is for clinic staff only and is not available on patient calls.',
  };
}
const PATIENT_KEYS = ['id', 'patientId', 'chartPatientId', 'firstName', 'lastName', 'name', 'dateOfBirth', 'birthDate', 'active'];
const SSN_KEY = /^(ssn|ssn_?last_?4|ssn4|social_?security(_?number)?|socialsecuritynumber)$/i;
const SSN_SYSTEM = '2.16.840.1.113883.4.1';

/** Deep copy without SSN keys or SSN identifiers. */
export function stripSsn<T>(v: T, depth = 0): T {
  if (depth > 20 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    return v
      .filter((x) => !isSsnIdentifier(x))
      .map((x) => stripSsn(x, depth + 1)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (SSN_KEY.test(k)) continue;
    out[k] = stripSsn(val, depth + 1);
  }
  return out as T;
}

function isSsnIdentifier(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false;
  const id = x as { system?: unknown; type?: { coding?: Array<{ code?: unknown }> } };
  return (
    (typeof id.system === 'string' && id.system.includes(SSN_SYSTEM)) ||
    (Array.isArray(id.type?.coding) && id.type!.coding!.some((c) => c?.code === 'SS'))
  );
}

/** One patient record cut to the identity and ID fields. */
export function slimPatient(p: unknown, keepMrn: boolean): Record<string, unknown> {
  if (!p || typeof p !== 'object') return {};
  const src = p as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of PATIENT_KEYS) if (src[k] !== undefined && src[k] !== '') out[k] = src[k];
  if (keepMrn && src.mrn) out.mrn = src.mrn;
  return out;
}

const hasValue = (v: unknown) => typeof v === 'string' ? v.trim() !== '' : v !== undefined && v !== null;

/** Tools whose whole result is one patient record (FHIR get_patient_details returns the record itself). */
const SINGLE_PATIENT_TOOLS = new Set(['get_patient_details']);

/** The result the phone agent may see for this tool call. */
export function forAgent(toolName: string, args: unknown, result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return stripSsn(result);
  const r = result as Record<string, unknown>;
  if (r.success === false && typeof r.error_code === 'string') return result;
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const withDob = hasValue(a.dateOfBirth) || hasValue(a.birthDate) || hasValue(a.dob);
  const withMrn = hasValue(a.mrn);
  const out = stripSsn(r);

  if (SINGLE_PATIENT_TOOLS.has(toolName)) return slimPatient(out, withMrn);

  if (Array.isArray(out.patients)) {
    const n = out.patients.length;
    if (n > 0 && !withDob && !withMrn) {
      // Name-only search: say how many, never who.
      return {
        success: true,
        withheld: true,
        message:
          `${n} possible match(es) by name only; no details are given without a date of birth. ` +
          'Ask the caller for their date of birth and search again with first name, last name and date of birth. Do not read any name back.',
      };
    }
    out.patients = out.patients.map((p) => slimPatient(p, withMrn));
  }
  if (out.patient && typeof out.patient === 'object') out.patient = slimPatient(out.patient, withMrn);
  // Never other patients as "suggestions".
  delete out.suggestions;
  return out;
}
