/**
 * FHIR tools that are NOT in the production set (docs/handover/01_DEMO_BUILD_SPEC.md §3):
 * Veradigm's FHIR API is read only and has no Appointment or MedicationStatement resource.
 * Appointments go through Veradigm PM (Unity server). Set FHIR_ENABLE_APPOINTMENT_TOOLS=true
 * only for local experiments.
 */
export const DISABLED_FHIR_TOOLS: ReadonlySet<string> = new Set(
  process.env.FHIR_ENABLE_APPOINTMENT_TOOLS === 'true'
    ? []
    : [
        'create_appointment',
        'get_upcoming_appointments',
        'get_appointment_details',
        'check_appointment_status',
        'find_patient_next_appointment',
        'get_appointments_by_date_range',
        'get_medication_statements',
      ]
);

export function disabledToolMessage(name: string): string {
  return `Tool ${name} is disabled: Veradigm's FHIR API has no such resource. Use the Veradigm PM (unity_) tools.`;
}
