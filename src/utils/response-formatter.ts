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
}): string {
  const name = [p.firstName, p.lastName].filter(Boolean).join(" ") || "Unknown";
  const dob = p.dateOfBirth ? `, DOB ${p.dateOfBirth}` : "";
  const mrn = p.mrn ? ` (MRN ${p.mrn})` : "";
  return `${name}${dob}${mrn}`;
}

function slotLine(s: {
  date?: string;
  time?: string;
  duration?: number;
}): string {
  return (
    `${s.date || "?"} at ${s.time || "?"}` +
    (s.duration ? `, ${s.duration} min` : "")
  );
}

function appointmentLine(a: {
  date?: string;
  time?: string;
  patientId?: string;
  status?: string;
}): string {
  return (
    `${a.date || "?"} ${a.time || "?"}` + (a.status ? `, ${a.status}` : "")
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
  if (result == null) return "No result.";
  const r = result as Record<string, unknown>;

  // Error-like
  if (typeof r.message === "string" && (r.success === false || r.error)) {
    return truncate(r.message, maxLength);
  }

  // Unity: search_patients / unity_search_patients → patients array + total
  if (Array.isArray(r.patients) && typeof r.total === "number") {
    const n = r.total;
    if (n === 0) return (r.message as string) || "No patients found.";
    const list = (
      r.patients as Array<{
        firstName?: string;
        lastName?: string;
        dateOfBirth?: string;
        mrn?: string;
      }>
    )
      .slice(0, 5)
      .map(patientLine);
    const andMore = n > 5 ? ` and ${n - 5} more` : "";
    return truncate(
      `Found ${n} patient(s): ${list.join("; ")}${andMore}.`,
      maxLength,
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
    if (n === 0) return "No open slots in that range.";
    const list = (
      r.slots as Array<{ date?: string; time?: string; duration?: number }>
    )
      .slice(0, 5)
      .map(slotLine);
    const andMore = n > 5 ? ` and ${n - 5} more` : "";
    return truncate(
      `Found ${n} slot(s): ${list.join("; ")}${andMore}.`,
      maxLength,
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
    if (n === 0) return "No appointments found.";
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
