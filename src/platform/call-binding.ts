import { auditToolCall, AuditServer } from './audit';
import { securityEvent } from './security-events';

/**
 * Per-call verification binding: "identity before information", enforced by the server, not only by the prompt.
 *
 * Applies to the phone-agent tool endpoints only (Retell custom functions POST /api/retell and the MCP tools/call
 * routes of the Unity and FHIR servers). Staff screens, module APIs and internal calls (document intake, huddle,
 * the upcoming-visits lookup) run the tools directly and are not affected.
 *
 * 1. Every agent call is keyed by the Retell call ID (`call.call_id`; MCP: the x-call-id header). A tool that
 *    touches a patient record is refused (CALL_ID_MISSING) without one.
 * 2. A patient becomes VERIFIED for that call only when the identity search (unity_search_patients, FHIR
 *    verify_patient_identity) was given first name, last name AND date of birth and found exactly one patient.
 *    The call then holds that patient's IDs (Veradigm® PM patientId, Veradigm® EHR chartPatientId, or the FHIR
 *    ID): IDs and a time only, in memory, for DRAWBRIDGE_CALL_BINDING_TTL_MIN (default 120) minutes. Nothing is
 *    written to disk; no names or birth dates are kept.
 * 3. Every patient-scoped tool (RULES below) must name a patient verified on this call, in the right system
 *    (PM IDs for visits, booking, balance and insurance; chart IDs for medications, allergies, problems,
 *    results and staff tasks). A verified patient's PM ID given to a chart tool (or the reverse) is mapped to the
 *    same patient's ID in that system, never to anyone else's. An appointment tool runs only for a verified
 *    patient, and the tool itself checks that the visit is on that patient's schedule (GetScheduleByPatientID).
 *    Anything else is refused with NOT_VERIFIED: one audit line for the tool call and one security event
 *    (`agent_not_verified`: call ID, tool, the requested patient ID; never a name).
 * 4. At most DRAWBRIDGE_CALL_MAX_VERIFIED_PATIENTS (default 2: the caller and one family member) patients per call
 *    (VERIFIED_LIMIT, security event `agent_verified_limit`), and at most DRAWBRIDGE_CALL_MAX_SEARCHES (default 5)
 *    identity searches per call (SEARCH_LIMIT, security event `agent_search_limit`, code POSSIBLE_ENUMERATION).
 * 5. A search without all three of first name, last name and date of birth, or one that matches more than one
 *    patient, never returns patient identifiers. FHIR search_patient never returns identifiers to the agent.
 * 6. New-patient registration (unity_save_patient without a patientId) is allowed and binds the new patient to
 *    the call. An after-hours call record that claims a patient not verified on this call is saved as unverified.
 */

export type IdSystem = 'pm' | 'chart' | 'fhir';

export interface VerifiedPatient {
  pm?: string;
  chart?: string;
  fhir?: string;
  verifiedAt: number;
  via: string;
}

interface CallState {
  createdAt: number;
  patients: VerifiedPatient[];
  searches: number;
}

const posInt = (name: string, d: number, env: NodeJS.ProcessEnv) => {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return d;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : d;
};
export const maxVerifiedPatients = (env: NodeJS.ProcessEnv = process.env) => posInt('DRAWBRIDGE_CALL_MAX_VERIFIED_PATIENTS', 2, env);
export const maxSearches = (env: NodeJS.ProcessEnv = process.env) => posInt('DRAWBRIDGE_CALL_MAX_SEARCHES', 5, env);
export const bindingTtlMs = (env: NodeJS.ProcessEnv = process.env) => posInt('DRAWBRIDGE_CALL_BINDING_TTL_MIN', 120, env) * 60_000;

const MAX_CALLS = 20_000;

/** Call ID as used for the binding: a plain opaque token, else '' (treated as missing). */
export function normalizeCallId(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
  return /^[A-Za-z0-9._:\-]{1,128}$/.test(s) ? s : '';
}

const idOf = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

export class CallBindings {
  private calls = new Map<string, CallState>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private state(callId: string, create: boolean): CallState | undefined {
    const t = this.now();
    let s = this.calls.get(callId);
    if (s && t - s.createdAt > bindingTtlMs()) {
      this.calls.delete(callId);
      s = undefined;
    }
    if (!s && create) {
      s = { createdAt: t, patients: [], searches: 0 };
      this.calls.set(callId, s);
      if (this.calls.size > MAX_CALLS) this.prune();
    }
    return s;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, s] of this.calls) if (t - s.createdAt > bindingTtlMs()) this.calls.delete(k);
    while (this.calls.size > MAX_CALLS) this.calls.delete(this.calls.keys().next().value as string);
  }

  /** Patients verified on this call (copies). */
  verified(callId: string): VerifiedPatient[] {
    return (this.state(callId, false)?.patients || []).map((p) => ({ ...p }));
  }

  /** Count one identity search; false when the call is over DRAWBRIDGE_CALL_MAX_SEARCHES. */
  noteSearch(callId: string): { allowed: boolean; count: number } {
    const s = this.state(callId, true)!;
    s.searches++;
    return { allowed: s.searches <= maxSearches(), count: s.searches };
  }

  /** Would binding this patient need a new slot, and is one left? */
  hasRoom(callId: string): boolean {
    return (this.state(callId, false)?.patients.length || 0) < maxVerifiedPatients();
  }

  private find(s: CallState | undefined, ids: { pm?: string; chart?: string; fhir?: string }): VerifiedPatient | undefined {
    return s?.patients.find((p) => (ids.pm && p.pm === ids.pm) || (ids.chart && p.chart === ids.chart) || (ids.fhir && p.fhir === ids.fhir));
  }

  /** Bind a verified patient to the call. 'limit' when the call already holds the maximum number of patients. */
  bind(callId: string, ids: { pm?: unknown; chart?: unknown; fhir?: unknown }, via: string): 'bound' | 'already' | 'limit' | 'invalid' {
    const clean = { pm: idOf(ids.pm) || undefined, chart: idOf(ids.chart) || undefined, fhir: idOf(ids.fhir) || undefined };
    if (!clean.pm && !clean.chart && !clean.fhir) return 'invalid';
    const s = this.state(callId, true)!;
    const existing = this.find(s, clean);
    if (existing) {
      if (clean.pm) existing.pm = clean.pm;
      if (clean.chart) existing.chart = clean.chart;
      if (clean.fhir) existing.fhir = clean.fhir;
      existing.verifiedAt = this.now();
      return 'already';
    }
    if (s.patients.length >= maxVerifiedPatients()) return 'limit';
    s.patients.push({ ...clean, verifiedAt: this.now(), via });
    return 'bound';
  }

  /**
   * The ID to use for `id` in `system` when it belongs to a patient verified on this call: the same ID, or (PM and
   * chart only) the same patient's ID in the other system. undefined when it is nobody verified on this call.
   */
  resolve(callId: string, system: IdSystem, id: unknown): string | undefined {
    const v = idOf(id);
    if (!v) return undefined;
    const patients = this.state(callId, false)?.patients || [];
    if (patients.some((p) => p[system] === v)) return v;
    if (system === 'fhir') return undefined;
    const other: IdSystem = system === 'pm' ? 'chart' : 'pm';
    const hits = patients.filter((p) => p[other] === v && p[system]);
    return hits.length === 1 ? hits[0][system] : undefined;
  }

  /** Is `id` any verified patient's ID on this call (any system)? */
  isAnyBound(callId: string, id: unknown): boolean {
    const v = idOf(id);
    return !!v && (this.state(callId, false)?.patients || []).some((p) => p.pm === v || p.chart === v || p.fhir === v);
  }

  forget(callId: string): void {
    this.calls.delete(callId);
  }

  clear(): void {
    this.calls.clear();
  }

  get size(): number {
    return this.calls.size;
  }
}

/** The process-wide store (one per server process). */
export const callBindings = new CallBindings();

// ── Tool rules ────────────────────────────────────────────────────────────────

type SystemOf = IdSystem | ((args: any) => IdSystem);

interface Rule {
  /** Patient ID parameters that must name a patient verified on this call. */
  ids?: Array<{ param: string; system: SystemOf; optional?: boolean }>;
  /** Identity search: counted toward the search cap; binds on one exact match. */
  search?: 'unity' | 'fhir_verify' | 'fhir_search' | 'unity_mrn';
  /** Takes an appointment ID: runs only with a verified patientId (filled in when the call verified exactly one). */
  appointment?: SystemOf;
  /** unity_save_patient: new patient allowed (binds), an existing patientId must be verified. */
  register?: boolean;
  /** drawbridge_save_call_record: an unverified patient is saved as unverified. */
  callRecord?: boolean;
  /** Never on patient calls (no way to check who the record belongs to). */
  deny?: boolean;
  /** No patient data (lookups, line mode, messages as the caller stated them). */
  open?: boolean;
}

const PM: Rule = { ids: [{ param: 'patientId', system: 'pm' }] };
const CHART: Rule = { ids: [{ param: 'patientId', system: 'chart' }] };
const FHIR: Rule = { ids: [{ param: 'patientId', system: 'fhir' }] };
const OPEN: Rule = { open: true };

export const RULES: Record<string, Rule> = {
  // Unity server: identity
  unity_search_patients: { search: 'unity' },
  unity_get_patient_by_mrn: { search: 'unity_mrn' },
  unity_get_patient: { ids: [{ param: 'patientId', system: (a) => (String(a?.target || '').toUpperCase() === 'PM' ? 'pm' : 'chart') }] },
  unity_save_patient: { register: true },
  unity_update_demographics: PM,
  // Veradigm® PM
  unity_get_patient_appointments: PM,
  unity_get_open_slots: { ids: [{ param: 'patientId', system: 'pm', optional: true }] },
  unity_save_appointment: PM,
  unity_get_appointment_details: { appointment: 'pm' },
  unity_cancel_appointment: { appointment: 'pm' },
  unity_confirm_appointment: { appointment: 'pm' },
  unity_get_account_balance: PM,
  unity_get_insurance_policy: PM,
  unity_get_patient_recalls: PM,
  drawbridge_previsit_check: PM,
  drawbridge_outreach_context: { ids: [{ param: 'verifiedPatientId', system: 'pm', optional: true }] },
  // Veradigm® EHR
  unity_get_patient_problems: CHART,
  unity_get_patient_medications: CHART,
  unity_get_patient_allergies: CHART,
  unity_get_patient_diagnosis: CHART,
  unity_get_recent_results: CHART,
  unity_create_staff_task: CHART,
  // Drawbridge records
  drawbridge_save_call_record: { callRecord: true },
  drawbridge_take_message: OPEN,
  drawbridge_get_call_mode: OPEN,
  drawbridge_outreach_result: OPEN,
  // Lookups without patient data
  unity_get_cancellation_reasons: OPEN,
  unity_get_appointment_types: OPEN,
  unity_get_providers: OPEN,
  unity_get_location_hours: OPEN,
  drawbridge_find_openings: OPEN,
  // Staff-only tools (refused on the patient line before this gate unless DRAWBRIDGE_AGENT_STAFF_TOOLS=on)
  unity_get_day_schedule: OPEN,
  unity_get_changed_appointments: OPEN,
  drawbridge_get_huddle_brief: OPEN,

  // FHIR server
  verify_patient_identity: { search: 'fhir_verify' },
  search_patient: { search: 'fhir_search' },
  get_patient_details: FHIR,
  get_patient_medications: FHIR,
  get_medication_requests: FHIR,
  check_refill_status: FHIR,
  get_medication_statements: FHIR,
  get_patient_conditions: FHIR,
  get_allergies: FHIR,
  get_recent_observations: FHIR,
  get_patient_procedures: FHIR,
  get_patient_coverage: FHIR,
  get_upcoming_appointments: FHIR,
  find_patient_next_appointment: FHIR,
  get_appointments_by_date_range: FHIR,
  create_appointment: FHIR,
  get_appointment_details: { deny: true },
  check_appointment_status: { deny: true },
  search_providers: OPEN,
  get_provider_details: OPEN,
  search_locations: OPEN,
  get_location_details: OPEN,
};

/** Argument names that point at a patient record (used for tools without a rule: fail closed). */
const PATIENT_PARAMS = ['patientId', 'chartPatientId', 'verifiedPatientId', 'patient', 'appointmentId', 'mrn'];

// ── Refusals ─────────────────────────────────────────────────────────────────

export interface GateFailure {
  success: false;
  error_code: 'NOT_VERIFIED' | 'VERIFIED_LIMIT' | 'SEARCH_LIMIT' | 'CALL_ID_MISSING' | 'PATIENT_ID_REQUIRED';
  retryable: false;
  tool: string;
  message: string;
}

const MESSAGES: Record<GateFailure['error_code'], string> = {
  NOT_VERIFIED: 'NOT_VERIFIED: verify the caller (full name + date of birth) before using this patient\'s record.',
  VERIFIED_LIMIT: 'This call has already verified the most patients allowed; no other record can be opened on this call.',
  SEARCH_LIMIT: 'Too many identity searches on this call; no more lookups (possible enumeration).',
  CALL_ID_MISSING: 'No call ID: patient records cannot be opened on this request.',
  PATIENT_ID_REQUIRED: 'More than one patient is verified on this call: pass the patientId of the one this visit belongs to.',
};

const EVENTS = {
  NOT_VERIFIED: 'agent_not_verified',
  VERIFIED_LIMIT: 'agent_verified_limit',
  SEARCH_LIMIT: 'agent_search_limit',
  CALL_ID_MISSING: 'agent_no_call_id',
  PATIENT_ID_REQUIRED: 'agent_not_verified',
} as const;

export interface GateContext {
  server: AuditServer;
  callId?: unknown;
  channel?: string;
}

function refuse(code: GateFailure['error_code'], tool: string, args: any, ctx: GateContext, patientId?: unknown, detail?: string, audit = true): GateFailure {
  const callId = normalizeCallId(ctx.callId);
  if (audit) {
    auditToolCall({ server: ctx.server, tool, args, patientId, callId, success: false, errorCode: code, latencyMs: 0, channel: ctx.channel || 'agent' });
  }
  // Two verified patients and no patientId is an agent slip, not a security event.
  if (code !== 'PATIENT_ID_REQUIRED') securityEvent(EVENTS[code], {
    server: ctx.server,
    channel: ctx.channel || 'agent',
    code: detail || code,
    object: tool,
    callId,
    patientId: typeof patientId === 'string' || typeof patientId === 'number' ? String(patientId) : undefined,
  });
  return { success: false, error_code: code, retryable: false, tool, message: MESSAGES[code] };
}

const filled = (v: unknown) => (typeof v === 'string' ? v.trim() !== '' : typeof v === 'number');
const sys = (s: SystemOf, args: any): IdSystem => (typeof s === 'function' ? s(args) : s);

export type GateDecision = { ok: true; args: any } | { ok: false; failure: GateFailure };

/**
 * Before an agent tool runs: refuse it, or return the arguments to run it with (a verified patient's ID mapped into
 * the tool's system; an after-hours record about an unverified patient cut to the message). Never throws.
 */
export function beforeAgentTool(name: string, rawArgs: any, ctx: GateContext, store: CallBindings = callBindings): GateDecision {
  const args = rawArgs && typeof rawArgs === 'object' ? { ...rawArgs } : {};
  const rule = RULES[name];
  if (rule?.open) return { ok: true, args };
  const callId = normalizeCallId(ctx.callId);

  if (!rule) {
    // A tool this table does not know: anything that names a patient needs a verified one (fail closed).
    const named = PATIENT_PARAMS.filter((p) => filled(args[p]));
    if (named.length === 0) return { ok: true, args };
    if (!callId) return { ok: false, failure: refuse('CALL_ID_MISSING', name, args, ctx) };
    for (const p of named) {
      if (p === 'appointmentId' || p === 'mrn') {
        if (!named.some((q) => q !== 'appointmentId' && q !== 'mrn')) return { ok: false, failure: refuse('NOT_VERIFIED', name, args, ctx, undefined, 'UNKNOWN_TOOL') };
        continue;
      }
      if (!store.isAnyBound(callId, args[p])) return { ok: false, failure: refuse('NOT_VERIFIED', name, args, ctx, args[p], 'UNKNOWN_TOOL') };
    }
    return { ok: true, args };
  }

  if (rule.deny) return { ok: false, failure: refuse('NOT_VERIFIED', name, args, ctx, undefined, 'NOT_ON_PATIENT_CALLS') };

  if (rule.callRecord) {
    // Keep the caller's message; drop the patient and chart items unless that patient is verified on this call.
    if (!args.verified) return { ok: true, args };
    const system: IdSystem = args.patientSystem === 'veradigm_ehr' ? 'chart' : 'pm';
    const okPatient = callId && (filled(args.patientId) ? store.resolve(callId, system, args.patientId) !== undefined : store.verified(callId).length > 0);
    if (okPatient) return { ok: true, args };
    refuse('NOT_VERIFIED', name, args, ctx, args.patientId, 'CALL_RECORD_SAVED_UNVERIFIED', false);
    const kept: any = { verified: false, reason: args.reason, urgency: args.urgency, callerPhone: args.callerPhone };
    return { ok: true, args: kept };
  }

  // Only optional patient parameters, none given (open times without a patient, outreach context before verification).
  if (rule.ids && rule.ids.every((c) => c.optional && !filled(args[c.param]))) return { ok: true, args };

  if (!callId) return { ok: false, failure: refuse('CALL_ID_MISSING', name, args, ctx, args.patientId) };

  if (rule.search) {
    const n = store.noteSearch(callId);
    if (!n.allowed) return { ok: false, failure: refuse('SEARCH_LIMIT', name, args, ctx, undefined, 'POSSIBLE_ENUMERATION') };
    return { ok: true, args };
  }

  if (rule.register) {
    if (filled(args.patientId)) {
      const id = store.resolve(callId, 'pm', args.patientId);
      if (!id) return { ok: false, failure: refuse('NOT_VERIFIED', name, args, ctx, args.patientId) };
      args.patientId = id;
      return { ok: true, args };
    }
    if (!store.hasRoom(callId)) return { ok: false, failure: refuse('VERIFIED_LIMIT', name, args, ctx) };
    return { ok: true, args };
  }

  if (rule.appointment) {
    const system = sys(rule.appointment, args);
    if (!filled(args.patientId)) {
      const ids = store.verified(callId).map((p) => p[system]).filter(Boolean) as string[];
      if (ids.length === 0) return { ok: false, failure: refuse('NOT_VERIFIED', name, args, ctx) };
      if (ids.length > 1) return { ok: false, failure: refuse('PATIENT_ID_REQUIRED', name, args, ctx) };
      args.patientId = ids[0];
      return { ok: true, args };
    }
    const id = store.resolve(callId, system, args.patientId);
    if (!id) return { ok: false, failure: refuse('NOT_VERIFIED', name, args, ctx, args.patientId) };
    args.patientId = id;
    return { ok: true, args };
  }

  for (const c of rule.ids || []) {
    if (!filled(args[c.param])) {
      if (c.optional) continue;
      return { ok: false, failure: refuse('NOT_VERIFIED', name, args, ctx) };
    }
    const id = store.resolve(callId, sys(c.system, args), args[c.param]);
    if (!id) return { ok: false, failure: refuse('NOT_VERIFIED', name, args, ctx, args[c.param]) };
    args[c.param] = id;
  }
  return { ok: true, args };
}

const PARTIAL = {
  success: true,
  withheld: true,
  verified: false,
  message:
    'Not verified: no record details are given from a partial search. Ask the caller for first name, last name and date of birth, ' +
    'then search again with all three. Do not read any name back.',
};
const SEVERAL = {
  success: true,
  withheld: true,
  verified: false,
  message:
    'Not verified: more than one record matches that name and date of birth, so nothing can be shared by phone. ' +
    'Offer to transfer the caller to staff or take a message (drawbridge_take_message).',
};
const FHIR_SEARCH = {
  success: true,
  withheld: true,
  verified: false,
  message: 'Search results are not given on patient calls. Verify with verify_patient_identity (first name, last name and date of birth).',
};

/**
 * After an agent tool ran (result already cut to the minimum necessary): bind a verified patient to the call, and
 * keep identifiers away from the agent when the search did not verify anyone. Never throws.
 */
export function afterAgentTool(name: string, args: any, result: any, ctx: GateContext, store: CallBindings = callBindings): any {
  try {
    const rule = RULES[name];
    if (!rule || (!rule.search && !rule.register)) return result;
    if (!result || typeof result !== 'object' || result.success === false) return result;
    const callId = normalizeCallId(ctx.callId);
    if (!callId) return result;
    const a = args || {};

    if (rule.register) {
      if (!filled(a.patientId) && filled(result.patientId)) {
        const b = store.bind(callId, { pm: result.patientId }, name);
        if (b === 'limit') return refuse('VERIFIED_LIMIT', name, a, ctx, undefined, 'REGISTERED_NOT_BOUND', false);
      }
      return result;
    }

    if (rule.search === 'fhir_search') return result.patients?.length ? FHIR_SEARCH : result;

    if (rule.search === 'fhir_verify') {
      if (result.verified !== true || !result.patient || !filled(result.patient.id)) return result;
      if (!filled(a.firstName) || !filled(a.lastName) || !filled(a.birthDate)) return PARTIAL;
      const b = store.bind(callId, { fhir: result.patient.id }, name);
      return b === 'limit' ? refuse('VERIFIED_LIMIT', name, a, ctx, result.patient.id, undefined, false) : result;
    }

    if (rule.search === 'unity_mrn') {
      const p = result.patient;
      if (!p || typeof p !== 'object') return result;
      const system: IdSystem = String(a.target || '').toUpperCase() === 'PM' ? 'pm' : 'chart';
      const id = p.id ?? p.patientId;
      if (store.resolve(callId, system, id) !== undefined) return result;
      return refuse('NOT_VERIFIED', name, a, ctx, id, 'MRN_LOOKUP', false);
    }

    // unity_search_patients
    if (result.withheld || !Array.isArray(result.patients)) return result;
    if (result.patients.length === 0) return result;
    if (!filled(a.firstName) || !filled(a.lastName) || !filled(a.dateOfBirth)) return PARTIAL;
    if (result.patients.length > 1) return SEVERAL;
    const p = result.patients[0] || {};
    const b = store.bind(callId, { pm: p.patientId, chart: p.chartPatientId }, name);
    if (b === 'invalid') return SEVERAL;
    if (b === 'limit') return refuse('VERIFIED_LIMIT', name, a, ctx, p.patientId || p.chartPatientId, undefined, false);
    return result;
  } catch {
    // Fail closed: nothing from the record.
    return { success: false, error_code: 'NOT_VERIFIED', retryable: false, tool: name, message: MESSAGES.NOT_VERIFIED };
  }
}

/** The whole gate around one agent tool call: refuse, or run with the checked arguments and bind / withhold after. */
export async function withCallBinding(
  name: string,
  args: any,
  ctx: GateContext,
  run: (args: any) => Promise<any>,
  store: CallBindings = callBindings
): Promise<any> {
  const d = beforeAgentTool(name, args, ctx, store);
  if (!d.ok) return d.failure;
  const result = await run(d.args);
  return afterAgentTool(name, d.args, result, ctx, store);
}
