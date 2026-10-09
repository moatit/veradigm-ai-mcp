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
 * Defaults marked "verify" are what the Feb 13 code sent and are NOT in Veradigm's PM/EHR
 * API references; the reference name is in the comment. Switch them once
 * `npm run verify:sandbox` shows which name the sandbox accepts (docs/handover/02_REPO_AUDIT.md §3).
 */
function action(key: string, fallback: string): string {
  return process.env[`UNITY_ACTION_${key}`] || fallback;
}

/**
 * Unity Action Categories
 * Organized by functionality for easy reference
 */
export const UnityActions = {
  // Admin Actions
  Admin: {
    ECHO: action('ECHO', 'Echo'),
    GET_SERVER_INFO: action('GET_SERVER_INFO', 'GetServerInfo'),
    LAST_LOG: action('LAST_LOG', 'LastLogs')
  },

  // Authentication Actions
  Auth: {
    GET_USER_AUTHENTICATION: action('GET_USER_AUTHENTICATION', 'GetUserAuthentication'),
    GET_TOKEN_VALIDATION: action('GET_TOKEN_VALIDATION', 'GetTokenValidation')
  },

  // Patient/Demographic Actions
  Patient: {
    GET_PATIENT: action('GET_PATIENT', 'GetPatient'),
    GET_PATIENT_BY_MRN: action('GET_PATIENT_BY_MRN', 'GetPatientByMRN'),
    GET_PATIENT_FULL: action('GET_PATIENT_FULL', 'GetPatientFull'),
    SEARCH_PATIENTS: action('SEARCH_PATIENTS', 'SearchPatients'),
    SAVE_PATIENT: action('SAVE_PATIENT', 'SavePatient'),
    // PM has no UpdateDemographics action; demographic changes are SavePatient (Kanhaiya, main 0a4e3c4).
    UPDATE_DEMOGRAPHICS: action('UPDATE_DEMOGRAPHICS', 'SavePatient'),
    GET_CHANGED_PATIENTS: action('GET_CHANGED_PATIENTS', 'GetChangedPatients')
  },

  // Appointment/Scheduling Actions (Veradigm PM)
  Scheduling: {
    GET_SCHEDULE: action('GET_SCHEDULE', 'GetSchedule'),
    // Sandbox Oct 9: GetScheduleByPatientID returns one patient's full history (filter future here).
    // Never GetSchedule with a PatientID: it ignores the patient and returns everyone's visits for the day.
    GET_APPOINTMENTS: action('GET_APPOINTMENTS', 'GetScheduleByPatientID'),
    GET_APPOINTMENT_BY_ID: action('GET_APPOINTMENT_BY_ID', 'GetAppointmentById'),
    SAVE_APPOINTMENT: action('SAVE_APPOINTMENT', 'SaveAppointment'),
    // Cancellation is a status change: SetAppointmentStatus(appointmentId, 'X', reason) (Kanhaiya, main 0a4e3c4; not yet run on the sandbox).
    CANCEL_APPOINTMENT: action('CANCEL_APPOINTMENT', 'SetAppointmentStatus'),
    SET_APPOINTMENT_STATUS: action('SET_APPOINTMENT_STATUS', 'SetAppointmentStatus'),
    // Sandbox Oct 9: GetAvailableSchedule(resource ABBREVIATION, start, end) returns one row per day with
    // 5-minute bitmaps (see decodeAvailability). GetOpenSlots is not licensed; a numeric resource ID returns 0 rows.
    GET_OPEN_SLOTS: action('GET_OPEN_SLOTS', 'GetAvailableSchedule'),
    BOOK_APPOINTMENT: action('BOOK_APPOINTMENT', 'BookAppointment'), // unused; reference: SaveAppointment
    GET_CANCELLATION_REASONS: action('GET_CANCELLATION_REASONS', 'GetAppointmentCancellationReasons'),
    GET_CONFIRMATION_RESULTS: action('GET_CONFIRMATION_RESULTS', 'GetAppointmentConfirmationResults'),
    GET_APPOINTMENT_TYPES: action('GET_APPOINTMENT_TYPES', 'GetAppointmentTypes'),
    GET_APPOINTMENTS_BY_CHANGE: action('GET_APPOINTMENTS_BY_CHANGE', 'GetAppointmentsByChangeDTTM'),
    GET_RECALLS: action('GET_RECALLS', 'GetRecalls'),
    GET_RECALL_TYPES: action('GET_RECALL_TYPES', 'GetRecallTypes'),
    GET_FIRST_AVAILABLE: action('GET_FIRST_AVAILABLE', 'GetFirstAvailableAppointments'),
    GET_AVAILABLE_SCHEDULE: action('GET_AVAILABLE_SCHEDULE', 'GetAvailableSchedule'),
    GET_RESOURCES: action('GET_RESOURCES', 'GetResources'),
    GET_SCHEDULING_LOCATIONS: action('GET_SCHEDULING_LOCATIONS', 'GetSchedulingLocations'),
    GET_SCHEDULING_DEPARTMENTS: action('GET_SCHEDULING_DEPARTMENTS', 'GetSchedulingDepartments')
  },

  // Billing Actions (Veradigm PM)
  Billing: {
    GET_ACCOUNT_BALANCE: action('GET_ACCOUNT_BALANCE', 'GetPatientAccountBalance'),
    GET_PATIENT_POLICY: action('GET_PATIENT_POLICY', 'GetPatientPolicy')
  },

  // Encounter Actions (not in the Veradigm references; not used by any tool)
  Encounter: {
    GET_ENCOUNTER: action('GET_ENCOUNTER', 'GetEncounter'),
    GET_ENCOUNTER_LIST: action('GET_ENCOUNTER_LIST', 'GetEncounterList'),
    SAVE_SIMPLE_ENCOUNTER: action('SAVE_SIMPLE_ENCOUNTER', 'SaveSimpleEncounter'),
    GET_ENCOUNTER_SUMMARY: action('GET_ENCOUNTER_SUMMARY', 'GetEncounterSummary')
  },

  // Clinical Actions (Veradigm EHR, read only)
  Clinical: {
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

  // Practice info (Veradigm EHR)
  Practice: {
    GET_LOCATION: action('GET_LOCATION', 'GetLocation'),
    GET_PATIENT_DEMOGRAPHICS: action('GET_PATIENT_DEMOGRAPHICS', 'GetPatientDemographics')
  },

  // Provider Actions
  Provider: {
    GET_PROVIDER: action('GET_PROVIDER', 'GetProvider'),
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

