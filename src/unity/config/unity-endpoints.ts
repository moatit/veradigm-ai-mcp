import { unityConfig } from './environment';

/**
 * Unity API Endpoint Configuration
 * 
 * Unity provides three main JSON endpoints:
 * 1. GetToken - Obtain security token
 * 2. MagicJson - Execute Unity actions
 * 3. RetireToken - Invalidate security token
 */
export interface UnityEndpoints {
  // Base endpoint URL
  baseUrl: string;
  
  // JSON API endpoints
  getToken: string;
  magicJson: string;
  retireToken: string;
  
  // Ubiquity IDs for different systems
  ubiquityIdPM: string;
  ubiquityIdEHR: string;
}

/**
 * Get Unity endpoints configuration
 */
function getUnityEndpoints(): UnityEndpoints {
  const baseUrl = unityConfig.ubiquityEndpoint;
  
  // Convert base URL to JSON endpoints
  // e.g., https://server/UnityService.svc -> https://server/UnityService.svc/json/GetToken
  const jsonBase = baseUrl.endsWith('/') ? `${baseUrl}json` : `${baseUrl}/json`;
  
  return {
    baseUrl,
    getToken: `${jsonBase}/GetToken`,
    magicJson: `${jsonBase}/MagicJson`,
    retireToken: `${jsonBase}/RetireToken`,
    ubiquityIdPM: unityConfig.ubiquityIdPM,
    ubiquityIdEHR: unityConfig.ubiquityIdEHR
  };
}

export const unityEndpoints = getUnityEndpoints();

/**
 * Resolve a Unity action name. Every name can be overridden per environment/client with
 * UNITY_ACTION_<KEY> (e.g. UNITY_ACTION_GET_APPOINTMENTS=GetScheduleByPatientID) so a
 * product difference between Veradigm environments is a config change, not a code change.
 *
 * Only actions the app calls are listed here (plus the documented GetTokenValidation);
 * docs/drawbridge/UNITY_ACTIONS_FOR_CERTIFICATION.md is the certified list.
 * Adding an action means updating that list (Veradigm recertification).
 */
function action(key: string, fallback: string): string {
  return process.env[`UNITY_ACTION_${key}`] || fallback;
}

/**
 * Unity Action Categories
 * Organized by functionality for easy reference
 */
export const UnityActions = {
  // Admin Actions. GetServerInfo and LastLogs are Veradigm-required (unity-diagnostics.ts).
  // Echo is not a declared action and is never sent (GetServerInfo is the connection check).
  Admin: {
    GET_SERVER_INFO: action('GET_SERVER_INFO', 'GetServerInfo'),
    LAST_LOG: action('LAST_LOG', 'LastLogs')
  },

  // Authentication Actions (GetToken / RetireToken are their own endpoints, above)
  Auth: {
    GET_USER_AUTHENTICATION: action('GET_USER_AUTHENTICATION', 'GetUserAuthentication'),
    // UNUSED, kept on purpose: GetTokenValidation validates a token handed to a *launched* app
    // (Veradigm EHR opens the app with a token). Drawbridge is not launched from Veradigm EHR; it gets
    // its own token with GetToken. See docs/drawbridge/UNITY_ACTIONS_FOR_CERTIFICATION.md.
    GET_TOKEN_VALIDATION: action('GET_TOKEN_VALIDATION', 'GetTokenValidation')
  },

  // Patient/Demographic Actions
  Patient: {
    GET_PATIENT: action('GET_PATIENT', 'GetPatient'),
    GET_PATIENT_BY_MRN: action('GET_PATIENT_BY_MRN', 'GetPatientByMRN'),
    SEARCH_PATIENTS: action('SEARCH_PATIENTS', 'SearchPatients'),
    SAVE_PATIENT: action('SAVE_PATIENT', 'SavePatient'),
    // PM has no UpdateDemographics action; demographic changes are SavePatient (Kanhaiya, main 0a4e3c4).
    UPDATE_DEMOGRAPHICS: action('UPDATE_DEMOGRAPHICS', 'SavePatient')
  },

  // Appointment/Scheduling Actions (Veradigm PM)
  Scheduling: {
    GET_SCHEDULE: action('GET_SCHEDULE', 'GetSchedule'),
    // Sandbox Oct 9: GetScheduleByPatientID returns one patient's full history (filter future here).
    // Never GetSchedule with a PatientID: it ignores the patient and returns everyone's visits for the day.
    GET_APPOINTMENTS: action('GET_APPOINTMENTS', 'GetScheduleByPatientID'),
    GET_APPOINTMENT_BY_ID: action('GET_APPOINTMENT_BY_ID', 'GetAppointmentById'),
    SAVE_APPOINTMENT: action('SAVE_APPOINTMENT', 'SaveAppointment'),
    // Cancellation is a status change (Veradigm PM SetAppointmentStatus spec): Parameter1 appointment ID,
    // Parameter2 status letter (X), Parameter4 update time HHMM, Parameter6 cancellation reason ID.
    CANCEL_APPOINTMENT: action('CANCEL_APPOINTMENT', 'SetAppointmentStatus'),
    SET_APPOINTMENT_STATUS: action('SET_APPOINTMENT_STATUS', 'SetAppointmentStatus'),
    // Sandbox Oct 9: GetAvailableSchedule(resource ABBREVIATION, start, end) returns one row per day with
    // 5-minute bitmaps (see decodeAvailability). GetOpenSlots is not licensed; a numeric resource ID returns 0 rows.
    GET_OPEN_SLOTS: action('GET_OPEN_SLOTS', 'GetAvailableSchedule'),
    GET_CANCELLATION_REASONS: action('GET_CANCELLATION_REASONS', 'GetAppointmentCancellationReasons'),
    // SetAppointmentStatus Parameter5 (confirmation result ID) for unity_confirm_appointment.
    GET_CONFIRMATION_RESULTS: action('GET_CONFIRMATION_RESULTS', 'GetAppointmentConfirmationResults'),
    GET_APPOINTMENT_TYPES: action('GET_APPOINTMENT_TYPES', 'GetAppointmentTypes'),
    GET_APPOINTMENTS_BY_CHANGE: action('GET_APPOINTMENTS_BY_CHANGE', 'GetAppointmentsByChangeDTTM'),
    GET_RECALLS: action('GET_RECALLS', 'GetRecalls'),
    GET_RESOURCES: action('GET_RESOURCES', 'GetResources'),
    // SaveAppointment needs <schedulingLocation>/<schedulingDepartment> abbreviations plus their IDs
    // (Veradigm PM SaveAppointment spec, 10/13/2026). GetAvailableSchedule rows carry the IDs; these
    // lookups (cached 1 h) map ID <-> abbreviation. Sandbox Oct 15: both return rows with
    // Scheduling_Location_ID / Scheduling_Department_ID and Abbreviation.
    GET_SCHEDULING_LOCATIONS: action('GET_SCHEDULING_LOCATIONS', 'GetSchedulingLocations'),
    GET_SCHEDULING_DEPARTMENTS: action('GET_SCHEDULING_DEPARTMENTS', 'GetSchedulingDepartments')
  },

  // Billing Actions (Veradigm PM)
  Billing: {
    GET_ACCOUNT_BALANCE: action('GET_ACCOUNT_BALANCE', 'GetPatientAccountBalance'),
    GET_PATIENT_POLICY: action('GET_PATIENT_POLICY', 'GetPatientPolicy')
  },

  // Clinical Actions (Veradigm EHR, read only)
  Clinical: {
    // Recent results / vitals (getRecentResults) and the section-based reads below.
    GET_CLINICAL_SUMMARY: action('GET_CLINICAL_SUMMARY', 'GetClinicalSummary'),
    // Sandbox Oct 9: GetClinicalSummary with a section name (Parameter1) returns the chart summary rows for
    // medications / allergies / problems. GetProblems returns the full history (250 rows), GetAllergies 0 rows.
    GET_PATIENT_PROBLEMS: action('GET_PATIENT_PROBLEMS', 'GetClinicalSummary'),
    GET_PATIENT_DIAGNOSIS: action('GET_PATIENT_DIAGNOSIS', 'GetPatientDiagnosis'),
    GET_PATIENT_MEDICATIONS: action('GET_PATIENT_MEDICATIONS', 'GetClinicalSummary'), // sandbox Oct 8: GetPatientMedications = not valid for license
    GET_PATIENT_ALLERGIES: action('GET_PATIENT_ALLERGIES', 'GetClinicalSummary') // sandbox Oct 8: GetPatientAllergies = not valid for license
  },

  // Staff tasks (Veradigm EHR). The ONLY EHR write the agent may make.
  Task: {
    SAVE_TASK: action('SAVE_TASK', 'SaveTask')
  },

  // Documents (Veradigm EHR): staff-side fax/document intake add-on only, never the phone agent.
  // GetDocumentType and GetDocuments verified on the sandbox Oct 9 (read). SaveScanDocument is the
  // owner-approved filing write (CLAUDE.md rule 4 exception), verified Oct 11 on synthetic patients;
  // see src/platform/modules/intake/file.ts.
  // Read by the shadow-mode staff filing observer (src/platform/modules/intake/observe.ts), verified
  // read-only on the sandbox: GetDocumentsByDocumentType (PatientID blank; Parameter1 type ID or name,
  // Parameter2 LOINC '', Parameter3/4 start/end MM/DD/YYYY; all patients) and GetDocumentImage
  // (Parameter1 DocumentID, 'Scan', 'PDF', 'N' → base64image).
  Document: {
    GET_DOCUMENT_TYPES: action('GET_DOCUMENT_TYPES', 'GetDocumentType'),
    GET_DOCUMENTS: action('GET_DOCUMENTS', 'GetDocuments'),
    GET_DOCUMENTS_BY_DOCUMENT_TYPE: action('GET_DOCUMENTS_BY_DOCUMENT_TYPE', 'GetDocumentsByDocumentType'),
    GET_DOCUMENT_IMAGE: action('GET_DOCUMENT_IMAGE', 'GetDocumentImage'),
    SAVE_SCAN_DOCUMENT: action('SAVE_SCAN_DOCUMENT', 'SaveScanDocument')
  },

  // Practice info (Veradigm EHR)
  Practice: {
    GET_LOCATION: action('GET_LOCATION', 'GetLocation')
  },

  // Provider Actions (Veradigm EHR)
  Provider: {
    GET_PROVIDERS: action('GET_PROVIDERS', 'GetProviders')
  }
} as const;

/**
 * Target system type for Unity operations
 */
export type UnityTargetSystem = 'PM' | 'EHR';

/**
 * Get the appropriate Ubiquity ID for a target system
 */
export function getUbiquityId(target: UnityTargetSystem): string {
  return target === 'PM' ? unityEndpoints.ubiquityIdPM : unityEndpoints.ubiquityIdEHR;
}

