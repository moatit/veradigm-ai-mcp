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
 * Unity Action Categories
 * Organized by functionality for easy reference
 */
export const UnityActions = {
  // Admin Actions
  Admin: {
    ECHO: 'Echo',
    GET_SERVER_INFO: 'GetServerInfo',
    LAST_LOG: 'LastLog'
  },
  
  // Authentication Actions
  Auth: {
    GET_USER_AUTHENTICATION: 'GetUserAuthentication',
    GET_TOKEN_VALIDATION: 'GetTokenValidation'
  },
  
  // Patient/Demographic Actions
  Patient: {
    GET_PATIENT: 'GetPatient',
    GET_PATIENT_BY_MRN: 'GetPatientByMRN',
    GET_PATIENT_FULL: 'GetPatientFull',
    SEARCH_PATIENTS: 'SearchPatients',
    SAVE_PATIENT: 'SavePatient',
    UPDATE_DEMOGRAPHICS: 'UpdateDemographics',
    GET_CHANGED_PATIENTS: 'GetChangedPatients'
  },
  
  // Appointment/Scheduling Actions
  Scheduling: {
    GET_SCHEDULE: 'GetSchedule',
    GET_APPOINTMENTS: 'GetAppointments',
    SAVE_APPOINTMENT: 'SaveAppointment',
    CANCEL_APPOINTMENT: 'CancelAppointment',
    GET_OPEN_SLOTS: 'GetOpenSlots',
    BOOK_APPOINTMENT: 'BookAppointment'
  },
  
  // Encounter Actions
  Encounter: {
    GET_ENCOUNTER: 'GetEncounter',
    GET_ENCOUNTER_LIST: 'GetEncounterList',
    SAVE_SIMPLE_ENCOUNTER: 'SaveSimpleEncounter',
    GET_ENCOUNTER_SUMMARY: 'GetEncounterSummary'
  },
  
  // Clinical Actions
  Clinical: {
    GET_PATIENT_PROBLEMS: 'GetPatientProblems',
    GET_PATIENT_DIAGNOSIS: 'GetPatientDiagnosis',
    SAVE_DIAGNOSIS: 'SaveDiagnosis',
    GET_PATIENT_MEDICATIONS: 'GetPatientMedications',
    GET_PATIENT_ALLERGIES: 'GetPatientAllergies'
  },
  
  // Document Actions
  Document: {
    GET_DOCUMENTS: 'GetDocuments',
    GET_DOCUMENT_IMAGE: 'GetDocumentImage',
    SAVE_DOCUMENT_IMAGE: 'SaveDocumentImage',
    SAVE_NOTE: 'SaveNote',
    GET_CCDA: 'GetCCDA'
  },
  
  // Order Actions
  Orders: {
    GET_ORDERS: 'GetOrders',
    SAVE_ORDER: 'SaveOrder',
    GET_ORDER_HISTORY: 'GetOrderHistory'
  },
  
  // Provider Actions
  Provider: {
    GET_PROVIDER: 'GetProvider',
    GET_PROVIDERS: 'GetProviders',
    SEARCH_PROVIDERS: 'SearchProviders'
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

