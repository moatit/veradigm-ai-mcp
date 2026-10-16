/**
 * The phone agent's tool list as registered in Retell (v7): compact descriptions and only the parameters
 * the agent needs, so prompt + tools stay near 4k tokens (v6 sent about 8k: Retell bills a token
 * surcharge above that and time to first token grows with every token). The full descriptions stay on
 * the tools themselves for MCP clients and staff screens.
 *
 * `filler` is the static line Retell speaks the moment the tool starts (speak_during_execution with
 * execution_message_type static_text: no extra LLM pass); null = silent (bookkeeping tools). Write tools
 * only run after the caller's clear yes, so their filler can say "now".
 *
 * Every tool keeps its name, URL and behaviour; nothing is dropped from the agent (the FHIR tools stay,
 * gated by the prompt's {{fhir_tools}} switch).
 */
export interface CompactTool {
  server: 'unity' | 'fhir';
  d: string;
  /** Parameters to keep: name -> short description ('' = none). Order kept. */
  p: Record<string, string>;
  filler: string | null;
}

const LOOKUP = 'One moment while I pull that up.';

export const AGENT_TOOLS: Record<string, CompactTool> = {
  drawbridge_get_call_mode: { server: 'unity', d: 'Line mode, only when the prompt does not give it.', p: {}, filler: null },
  drawbridge_save_call_record: {
    server: 'unity',
    d: 'After-hours: save the call for the on-call notebook before it ends. Chart items only if verified.',
    p: {
      verified: '',
      patientSystem: '',
      patientId: '',
      patientName: '',
      dob: 'MM/DD/YYYY',
      reason: "Caller's words",
      urgency: '',
      callerPhone: '',
      medications: '',
      allergies: '',
      problems: '',
      latestObservations: '',
      nextAppointment: '',
      staffTaskId: '',
    },
    filler: null,
  },
  drawbridge_take_message: {
    server: 'unity',
    d: 'Message for staff when a staff task is not possible: records unavailable, caller not verified, or transfer not possible. Read back, get a yes first.',
    p: { callerName: 'As the caller said it', dateOfBirth: 'MM/DD/YYYY', callbackPhone: '', message: "Caller's words", urgency: '' },
    filler: 'Okay, saving your message now.',
  },
  drawbridge_previsit_check: {
    server: 'unity',
    d: "Verified caller's next-visit checklist (time, insurance, balance, what to bring). Read its message.",
    p: { patientId: '' },
    filler: LOOKUP,
  },
  unity_search_patients: {
    server: 'unity',
    d: 'Verify identity: first name, last name and date of birth. Returns patientId, chartPatientId and, for one verified match, upcoming visits.',
    p: { firstName: '', lastName: '', dateOfBirth: 'MM/DD/YYYY' },
    filler: LOOKUP,
  },
  unity_get_patient: { server: 'unity', d: 'Patient record by patientId.', p: { patientId: '' }, filler: LOOKUP },
  unity_get_patient_appointments: {
    server: 'unity',
    d: 'Upcoming visits, soonest first.',
    p: { patientId: '', startDate: 'MM/DD/YYYY', endDate: 'MM/DD/YYYY' },
    filler: LOOKUP,
  },
  unity_get_appointment_details: { server: 'unity', d: 'One visit.', p: { appointmentId: '', patientId: '' }, filler: LOOKUP },
  unity_get_open_slots: {
    server: 'unity',
    d: "Open times, with the visit types a time allows. With patientId and no providerId: the patient's usual provider.",
    p: { startDate: 'MM/DD/YYYY', endDate: 'MM/DD/YYYY', patientId: '', providerId: 'ID or last name', partOfDay: '', appointmentType: 'Visit type, if known' },
    filler: 'Let me check the schedule.',
  },
  unity_get_appointment_types: { server: 'unity', d: 'Visit types.', p: {}, filler: LOOKUP },
  unity_save_appointment: {
    server: 'unity',
    d: 'Book an offered slot after the caller says yes. Pass providerId, locationId, departmentId from that slot.',
    p: {
      patientId: '',
      appointmentDate: 'MM/DD/YYYY',
      appointmentTime: 'HH:MM 24h',
      duration: 'Minutes',
      providerId: '',
      locationId: '',
      departmentId: '',
      appointmentType: 'A visit type the slot allows',
      reasonForVisit: '',
    },
    filler: 'Okay, booking that now.',
  },
  unity_get_cancellation_reasons: { server: 'unity', d: 'Cancellation reasons; call before cancelling.', p: {}, filler: null },
  unity_cancel_appointment: {
    server: 'unity',
    d: 'Cancel a visit after the caller says yes.',
    p: { appointmentId: '', patientId: '', cancellationReason: 'From the reasons list' },
    filler: 'Okay, cancelling that now.',
  },
  unity_confirm_appointment: {
    server: 'unity',
    d: 'Confirm a visit after the caller says yes.',
    p: { appointmentId: '', patientId: '' },
    filler: 'Okay, confirming that now.',
  },
  unity_get_account_balance: { server: 'unity', d: 'Balance due.', p: { patientId: '' }, filler: LOOKUP },
  unity_get_insurance_policy: { server: 'unity', d: 'Insurance on file.', p: { patientId: '' }, filler: LOOKUP },
  unity_create_staff_task: {
    server: 'unity',
    d: 'Message to staff (refill request, callback, after-hours message, question). Read back, get a yes first.',
    p: { patientId: 'chartPatientId', reason: '', message: "Caller's words", urgency: '', callbackPhone: '' },
    filler: 'Okay, sending that to our staff now.',
  },
  unity_get_patient_allergies: { server: 'unity', d: 'Allergies.', p: { patientId: 'chartPatientId' }, filler: LOOKUP },
  unity_get_patient_problems: { server: 'unity', d: 'Conditions.', p: { patientId: 'chartPatientId' }, filler: LOOKUP },
  unity_get_patient_medications: { server: 'unity', d: 'Medications.', p: { patientId: 'chartPatientId' }, filler: LOOKUP },
  unity_get_recent_results: { server: 'unity', d: 'Recent results and vitals. Read as recorded, never interpret.', p: { patientId: 'chartPatientId' }, filler: LOOKUP },
  unity_get_location_hours: { server: 'unity', d: 'Clinic address, phone and hours.', p: {}, filler: LOOKUP },
  verify_patient_identity: { server: 'fhir', d: 'Backup chart lookup. Only when fhir_tools is ON.', p: { firstName: '', lastName: '', birthDate: 'YYYY-MM-DD' }, filler: LOOKUP },
  get_patient_medications: { server: 'fhir', d: 'Backup: medications. Only when fhir_tools is ON.', p: { patientId: '' }, filler: LOOKUP },
  get_allergies: { server: 'fhir', d: 'Backup: allergies. Only when fhir_tools is ON.', p: { patientId: '' }, filler: LOOKUP },
  check_refill_status: { server: 'fhir', d: 'Backup: refill status. Only when fhir_tools is ON.', p: { patientId: '', medicationName: '' }, filler: LOOKUP },
  get_patient_conditions: { server: 'fhir', d: 'Backup: conditions. Only when fhir_tools is ON.', p: { patientId: '' }, filler: LOOKUP },
  get_recent_observations: { server: 'fhir', d: 'Backup: results and vitals. Only when fhir_tools is ON.', p: { patientId: '' }, filler: LOOKUP },
};

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, any>; required?: string[] };
}

/**
 * Retell-facing definitions built from the code's own schemas (types, enums, item types kept) with the
 * compact descriptions above. Throws if a listed tool or parameter does not exist in the code, so the
 * agent can never be registered with a parameter the server does not take.
 */
export function compactAgentTools(defs: { unity: ToolDef[]; fhir: ToolDef[] }) {
  const out: Array<{ name: string; server: 'unity' | 'fhir'; description: string; parameters: any; filler: string | null }> = [];
  for (const [name, spec] of Object.entries(AGENT_TOOLS)) {
    const def = defs[spec.server].find((t) => t.name === name);
    if (!def) throw new Error(`agent tool ${name} is not defined on the ${spec.server} server`);
    const props = def.inputSchema?.properties || {};
    const properties: Record<string, any> = {};
    for (const [p, desc] of Object.entries(spec.p)) {
      const src = props[p];
      if (!src) throw new Error(`agent tool ${name}: parameter ${p} does not exist`);
      const { description: _d, ...rest } = src;
      properties[p] = desc ? { ...rest, description: desc } : rest;
    }
    const required = (def.inputSchema?.required || []).filter((r) => r in properties);
    for (const r of def.inputSchema?.required || []) {
      if (!(r in properties)) throw new Error(`agent tool ${name}: required parameter ${r} was dropped`);
    }
    out.push({ name, server: spec.server, description: spec.d, parameters: { type: 'object', properties, required }, filler: spec.filler });
  }
  return out;
}
