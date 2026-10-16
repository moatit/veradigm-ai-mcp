/**
 * Phone-agent edge helpers (Retell custom functions and MCP tools/call on the Unity server).
 *
 * 1. Records unavailable: while the system status says the Veradigm connection is DOWN (all configured
 *    systems failing their health checks), Veradigm tools answer RECORDS_UNAVAILABLE at once instead of
 *    waiting through timeouts; the prompt then says so and takes a message (drawbridge_take_message) or
 *    transfers. UNITY_FAIL_FAST_WHEN_DOWN=off sends the calls anyway.
 * 2. Upcoming visits with a verified match: a successful unity_search_patients that identifies exactly
 *    one patient by first name, last name AND date of birth (not a spelling-variant match, which still
 *    needs the caller's yes) also carries that patient's next visits, saving the agent a full tool round
 *    in the most common flow (verify, then "when is my appointment?"). Minimum necessary: only that
 *    patient, at most UPCOMING_MAX visits, date / time / provider / type / status and the appointment ID.
 *    The lookup has UNITY_SEARCH_VISITS_BUDGET_MS (default 2500; 0 = off) to finish; if it fails or is
 *    late the search result goes out without visits (never "no visits") and the agent asks
 *    unity_get_patient_appointments as before.
 */
export const RECORDS_UNAVAILABLE = 'RECORDS_UNAVAILABLE';
export const UPCOMING_MAX = 3;

/** Platform tools that call Veradigm (everything named unity_* does too). */
const VERADIGM_PLATFORM_TOOLS = new Set(['drawbridge_previsit_check', 'drawbridge_find_openings', 'drawbridge_outreach_context']);

export function needsVeradigm(name: string): boolean {
  return name.startsWith('unity_') || VERADIGM_PLATFORM_TOOLS.has(name);
}

export function recordsUnavailable(tool: string) {
  return {
    success: false as const,
    error_code: RECORDS_UNAVAILABLE,
    retryable: false,
    tool,
    message: 'The Veradigm connection is down (health check); the call was not sent.',
  };
}

export function visitsBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.UNITY_SEARCH_VISITS_BUDGET_MS;
  if (raw === undefined || String(raw).trim() === '') return 2500;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 8000) : 2500;
}

const filled = (v: unknown) => typeof v === 'string' && v.trim() !== '';

export interface UpcomingVisit {
  date: string;
  time: string;
  providerName?: string;
  appointmentType?: string;
  status?: string;
  id?: string;
}

/**
 * Attach the verified patient's upcoming visits to an agent-facing search result (see above).
 * `fetchVisits` runs unity_get_patient_appointments the normal way (audited). Never throws.
 */
export async function attachUpcomingVisits(
  args: any,
  result: any,
  fetchVisits: (patientId: string) => Promise<any>,
  budgetMs: number = visitsBudgetMs()
): Promise<any> {
  try {
    if (!budgetMs || !result || result.success === false || result.withheld) return result;
    if (!Array.isArray(result.patients) || result.patients.length !== 1) return result;
    if (!filled(args?.firstName) || !filled(args?.lastName) || !filled(args?.dateOfBirth)) return result;
    if (filled(result.note)) return result; // spelling variant: the caller has not confirmed yet
    const p = result.patients[0];
    if (!filled(p?.patientId)) return result;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), budgetMs);
    });
    const visits = await Promise.race([fetchVisits(String(p.patientId)).catch(() => null), late]);
    if (timer) clearTimeout(timer);
    if (!visits || visits.success === false || !Array.isArray(visits.appointments)) return result;
    const list: UpcomingVisit[] = visits.appointments.slice(0, UPCOMING_MAX).map((a: any) => {
      const v: UpcomingVisit = { date: String(a.date || ''), time: String(a.time || '') };
      if (a.providerName) v.providerName = String(a.providerName);
      if (a.appointmentType) v.appointmentType = String(a.appointmentType);
      if (a.status) v.status = String(a.status);
      if (a.id) v.id = String(a.id);
      return v;
    });
    return { ...result, upcomingVisits: list, upcomingTotal: visits.appointments.length };
  } catch {
    return result;
  }
}
