/**
 * Voice-friendly response formatter
 *
 * Converts long tool JSON into short, speakable text so the AI can reply
 * in one go without truncating or asking the user to repeat.
 *
 * Use when client sends: x-response-format: brief or x-voice-response: true
 */

const DEFAULT_MAX_LENGTH = 520;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3).trim() + "...";
}

function patientLine(p: {
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  mrn?: string;
  patientId?: string;
  chartPatientId?: string;
}): string {
  const name = [p.firstName, p.lastName].filter(Boolean).join(" ") || "Unknown";
  const dob = p.dateOfBirth ? `, DOB ${p.dateOfBirth}` : "";
  const mrn = p.mrn ? ` (MRN ${p.mrn})` : "";
  // IDs are for the agent's next tool calls; they are not read to the caller.
  const ids = [
    p.patientId ? `patientId ${p.patientId}` : "",
    p.chartPatientId ? `chartPatientId ${p.chartPatientId}` : "",
  ].filter(Boolean);
  return `${name}${dob}${mrn}${ids.length ? ` [${ids.join(", ")}]` : ""}`;
}

function slotLine(s: {
  date?: string;
  time?: string;
  duration?: number;
  providerName?: string;
  providerId?: string;
  locationId?: string;
  departmentId?: string;
}): string {
  // The IDs go back into unity_save_appointment for the slot the caller picks; never read aloud.
  const ids = [
    s.providerId ? `providerId ${s.providerId}` : "",
    s.locationId ? `locationId ${s.locationId}` : "",
    s.departmentId ? `departmentId ${s.departmentId}` : "",
  ].filter(Boolean);
  return (
    `${s.date || "?"} at ${s.time || "?"}` +
    (s.duration ? `, ${s.duration} min` : "") +
    (s.providerName ? ` with ${s.providerName}` : "") +
    (ids.length ? ` [${ids.join(", ")}]` : "")
  );
}

/** Visit type names, compact: at most 4, then "+N more". */
function typeList(names: string[]): string {
  return names.slice(0, 4).join(", ") + (names.length > 4 ? ` +${names.length - 4} more` : "");
}

/** A successful lookup that found nothing: unmistakably not an error (v6 read "No appointments found." as a failure). */
function successEmpty(what: string): string {
  return `SUCCESS: ${what} This is a real answer, not an error.`;
}

function appointmentLine(a: {
  id?: string;
  date?: string;
  time?: string;
  patientId?: string;
  status?: string;
  providerName?: string;
  appointmentType?: string;
}): string {
  return (
    `${a.date || "?"} ${a.time || "?"}` +
    (a.providerName ? ` with ${a.providerName}` : "") +
    (a.appointmentType ? ` (${a.appointmentType})` : "") +
    (a.status ? `, ${a.status}` : "") +
    // The ID is for the agent's next tool call (cancel/details); it is not read to the caller.
    (a.id ? ` [appointmentId ${a.id}]` : "")
  );
}

const GATE_TEXT: Record<string, string> = {
  NOT_VERIFIED:
    "This record is not verified on this call. Verify the caller first: first name, last name and date of birth with unity_search_patients (backup chart tools: verify_patient_identity), " +
    "then use only the IDs that search returned. Act only for the verified caller (or a family member verified the same way). Never guess an ID.",
  PATIENT_ID_REQUIRED: "Two patients are verified on this call: pass the patientId of the one this visit belongs to.",
  VERIFIED_LIMIT:
    'This call has already verified the most people allowed. Say "I can only help with the records we have already verified on this call." For anyone else, offer a transfer or a message.',
  SEARCH_LIMIT:
    'Too many identity searches on this call. Say "I\'m not able to look up any more records on this call." Offer a transfer or a message (drawbridge_take_message). Do not search again.',
  CALL_ID_MISSING: "Patient records can't be opened on this line. Offer a transfer or a message (drawbridge_take_message).",
};

/**
 * Text the agent gets when a tool failed. It must never sound like an empty result
 * (CLAUDE.md rule 5) and never carries raw error text to be read to a caller.
 */
export function failureText(r: { error_code?: string; retryable?: boolean; agent_text?: string }): string {
  if (r.error_code === "APPOINTMENT_TYPE_NOT_ALLOWED") {
    // Not a system problem: the time takes other visit types. agent_text is Drawbridge's own wording.
    return (
      "NOT BOOKED (APPOINTMENT_TYPE_NOT_ALLOWED; the booking system worked, nothing was saved; not an error to apologize for). " +
      (r.agent_text || "That time does not allow that visit type. Ask the caller which visit type fits, or offer other times.")
    );
  }
  if (r.error_code === "RECORDS_UNAVAILABLE") {
    return (
      "TOOL_ERROR (RECORDS_UNAVAILABLE, retryable=no). The clinic's records system is down right now; nothing was looked up or changed. " +
      `Say: "I'm sorry, I can't reach our records system right now." Then offer to take a message (drawbridge_take_message) or transfer. ` +
      "Do not call other record tools on this call."
    );
  }
  // Per-call verification binding (src/platform/call-binding.ts): refusals the agent must handle, not outages.
  const gate = GATE_TEXT[r.error_code || ""];
  if (gate) return `TOOL_ERROR (${r.error_code}, retryable=no). Nothing was looked up or changed. ${gate}`;
  return (
    `TOOL_ERROR (${r.error_code || "UNKNOWN"}, retryable=${r.retryable ? "yes" : "no"}). ` +
    `The lookup FAILED; this is NOT an empty result. Do not say there is nothing on file. ` +
    `Say: "I'm having trouble pulling that up right now." ` +
    (r.retryable ? "You may retry once, then " : "Then ") +
    `offer to transfer the caller or take a message for staff. Do not switch to other tools to work around it.`
  );
}

/**
 * Build a short, voice-friendly summary of a tool result.
 * Used when the client (e.g. voice AI) sends x-response-format: brief.
 */
export function toVoiceSummary(
  toolName: string,
  result: unknown,
  maxLength: number = DEFAULT_MAX_LENGTH,
): string {
  if (result == null) return failureText({ error_code: "NO_RESULT" });
  const r = result as Record<string, unknown>;

  // Structured tool failure (Veradigm call failed): never an empty-sounding answer.
  if (r.success === false && typeof r.error_code === "string") {
    return failureText(r as { error_code: string; retryable?: boolean; agent_text?: string });
  }

  // Withheld (redacted) data: never "none on file" (spec §4 rule 6).
  if (r.redacted === true) {
    return (
      "RESTRICTED: part of this record is restricted and cannot be shared by phone. " +
      'Do not say there is nothing on file. Say: "I\'m not able to share that by phone," and offer a transfer.'
    );
  }

  // Genuine negative answer from a successful call (e.g. "No patient found with MRN ...")
  if (typeof r.message === "string" && r.success === false) {
    return truncate(r.message, maxLength);
  }
  if (r.error) {
    return failureText({ error_code: String(r.error) });
  }

  // Cancellation reasons / appointment types (lookup lists)
  const lookup = (r.reasons || r.appointmentTypes) as
    | Array<{ id?: string; description?: string }>
    | undefined;
  if (Array.isArray(lookup)) {
    if (lookup.length === 0) return successEmpty("the list is empty.");
    return truncate(
      `Options: ${lookup.map((x) => `${x.description || x.id}${x.id && x.description ? ` [id ${x.id}]` : ""}`).join("; ")}.`,
      maxLength * 2,
    );
  }

  // Single appointment
  if (r.appointment && typeof r.appointment === "object" && !Array.isArray(r.appointments)) {
    return truncate(`Appointment: ${appointmentLine(r.appointment as any)}.`, maxLength);
  }

  // Recent results and vitals (Unity EHR)
  if (Array.isArray(r.results) && r.success === true) {
    const arr = r.results as Array<{ name?: string; value?: string; date?: string }>;
    if (arr.length === 0) return successEmpty("no results on file.");
    const lines = arr.slice(0, 8).map((x) => `${x.name}${x.value ? `: ${x.value}` : ""}${x.date ? ` (${x.date})` : ""}`);
    const more = arr.length > 8 ? ` and ${arr.length - 8} more` : "";
    return truncate(`Recent results on file: ${lines.join("; ")}${more}.`, maxLength);
  }

  // Clinical lists (Unity EHR): problems / medications / allergies / diagnoses
  for (const key of ["medications", "allergies", "problems", "diagnoses"]) {
    const arr = r[key];
    if (Array.isArray(arr) && r.success === true) {
      if (arr.length === 0) return successEmpty(`no ${key} on file.`);
      const names = (arr as Array<Record<string, string>>)
        .slice(0, 8)
        .map((x) => x.name || x.allergen || x.description || x.code || "?");
      const more = arr.length > 8 ? ` and ${arr.length - 8} more` : "";
      return truncate(`${key[0].toUpperCase()}${key.slice(1)} on file: ${names.join("; ")}${more}.`, maxLength);
    }
  }

  // Unity: search_patients / unity_search_patients → patients array + total
  if (Array.isArray(r.patients) && typeof r.total === "number") {
    const n = r.total;
    if (n === 0) {
      return `NO MATCH (the search worked; not an error): ${(r.message as string) || "No patient matched."} ` +
        "Ask the caller to spell their name letter by letter and search again with exactly those letters.";
    }
    const list = (
      r.patients as Array<{
        firstName?: string;
        lastName?: string;
        dateOfBirth?: string;
        mrn?: string;
        patientId?: string;
        chartPatientId?: string;
      }>
    )
      .slice(0, 5)
      .map(patientLine);
    const andMore = n > 5 ? ` and ${n - 5} more` : "";
    const note = typeof r.note === "string" && r.note ? ` ${r.note}` : "";
    // Upcoming visits of the one verified match (agent-edge.ts attachUpcomingVisits).
    let visits = "";
    if (Array.isArray(r.upcomingVisits)) {
      const v = r.upcomingVisits as Array<Record<string, string>>;
      const total = typeof r.upcomingTotal === "number" ? r.upcomingTotal : v.length;
      visits = v.length
        ? ` Upcoming visits (${total}, soonest first): ${v.map((a) => appointmentLine(a)).join("; ")}.`
        : " Upcoming visits: SUCCESS, none scheduled (a real answer, not an error).";
    }
    return truncate(
      `Found ${n} patient(s): ${list.join("; ")}${andMore}.${note}${visits}`,
      visits ? maxLength * 2 : maxLength,
    );
  }

  // Unity: single patient (get_patient, get_patient_by_mrn)
  if (r.patient && typeof r.patient === "object") {
    const p = r.patient as {
      firstName?: string;
      lastName?: string;
      dateOfBirth?: string;
      mrn?: string;
    };
    const line = patientLine(p);
    return truncate(`Patient: ${line}.`, maxLength);
  }

  // Unity: open slots
  if (Array.isArray(r.slots) && typeof r.total === "number") {
    const n = r.total;
    if (n === 0) return successEmpty("no open times in that range. Offer to look at other dates.");
    const shown = (r.slots as Array<Parameters<typeof slotLine>[0] & { appointmentTypes?: string[] }>).slice(0, 5);
    // Visit types a block allows: once when every listed time has the same list, else per time.
    const typeKey = (s: { appointmentTypes?: string[] }) => (s.appointmentTypes || []).join("|");
    const sameTypes = shown.every((s) => typeKey(s) === typeKey(shown[0]));
    const list = shown.map((s) => slotLine(s) + (!sameTypes && s.appointmentTypes?.length ? ` (types: ${typeList(s.appointmentTypes)})` : ""));
    const andMore = n > 5 ? ` and ${n - 5} more` : "";
    const types = sameTypes && shown[0]?.appointmentTypes?.length ? ` These times only allow: ${typeList(shown[0].appointmentTypes)}.` : "";
    const typed = shown.some((s) => s.appointmentTypes?.length)
      ? " Pass an appointmentType the picked time allows; ask the caller if unsure."
      : "";
    return truncate(
      `Found ${n} slot(s): ${list.join("; ")}${andMore}.${types} When booking, pass the providerId, locationId and departmentId of the slot the caller picked.${typed}`,
      maxLength * 2,
    );
  }

  // Unity: appointments list (get_patient_appointments, etc.)
  if (Array.isArray(r.appointments)) {
    const arr = r.appointments as Array<{
      date?: string;
      time?: string;
      status?: string;
    }>;
    const n = arr.length;
    if (n === 0) return successEmpty("this patient has no upcoming appointments.");
    const list = arr.slice(0, 5).map(appointmentLine);
    const andMore = n > 5 ? ` and ${n - 5} more` : "";
    return truncate(
      `Found ${n} appointment(s): ${list.join("; ")}${andMore}.`,
      maxLength,
    );
  }

  // Success + message (save_patient, save_appointment, cancel_appointment, etc.)
  if (r.success === true && typeof r.message === "string") {
    const extra: string[] = [];
    if (r.patientId) extra.push(`Patient ID: ${r.patientId}`);
    if (r.appointmentId) extra.push(`Appointment ID: ${r.appointmentId}`);
    const out = extra.length ? `${r.message} ${extra.join(", ")}.` : r.message;
    return truncate(out, maxLength);
  }

  // FHIR-style: entry array (search results)
  if (Array.isArray(r.entry)) {
    const n = r.entry.length;
    if (n === 0) return "No results found.";
    const resources = (
      r.entry as Array<{
        resource?: {
          resourceType?: string;
          id?: string;
          name?: Array<{ given?: string[]; family?: string }>;
        };
      }>
    )
      .slice(0, 5)
      .map((e) => {
        const res = e.resource;
        if (!res) return "?";
        if (res.resourceType === "Patient" && res.name?.[0]) {
          const n0 = res.name[0];
          const name = [...(n0.given || []), n0.family]
            .filter(Boolean)
            .join(" ");
          return name || res.id || "?";
        }
        return res.id || res.resourceType || "?";
      });
    const andMore = n > 5 ? ` and ${n - 5} more` : "";
    return truncate(
      `Found ${n} result(s): ${resources.join(", ")}${andMore}.`,
      maxLength,
    );
  }

  // Generic array
  if (Array.isArray(result)) {
    const n = result.length;
    if (n === 0) return "No items.";
    const head = result
      .slice(0, 3)
      .map((x) =>
        typeof x === "object" && x && "name" in x
          ? String((x as { name: string }).name)
          : String(x),
      );
    const andMore = n > 3 ? ` and ${n - 3} more` : "";
    return truncate(
      `Found ${n} item(s): ${head.join(", ")}${andMore}.`,
      maxLength,
    );
  }

  // Object with message
  if (typeof r.message === "string") return truncate(r.message, maxLength);

  // Fallback: one-line summary
  const str = JSON.stringify(result);
  return truncate(str, maxLength);
}
