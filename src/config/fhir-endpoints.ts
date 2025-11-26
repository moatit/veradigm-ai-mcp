import { config } from './environment';

export interface FHIREndpoint {
  baseUrl: string;
  patient: string;
  appointment: string;
  medicationRequest: string;
  medicationStatement: string;
  practitioner: string;
  location: string;
  organization: string;
  observation: string;
  condition: string;
  procedure: string;
  allergyIntolerance: string;
  coverage: string;
}

export const fhirEndpoints: FHIREndpoint = {
  baseUrl: config.fhirBaseUrl,
  patient: `${config.fhirBaseUrl}/Patient`,
  appointment: `${config.fhirBaseUrl}/Appointment`,
  medicationRequest: `${config.fhirBaseUrl}/MedicationRequest`,
  medicationStatement: `${config.fhirBaseUrl}/MedicationStatement`,
  practitioner: `${config.fhirBaseUrl}/Practitioner`,
  location: `${config.fhirBaseUrl}/Location`,
  organization: `${config.fhirBaseUrl}/Organization`,
  observation: `${config.fhirBaseUrl}/Observation`,
  condition: `${config.fhirBaseUrl}/Condition`,
  procedure: `${config.fhirBaseUrl}/Procedure`,
  allergyIntolerance: `${config.fhirBaseUrl}/AllergyIntolerance`,
  coverage: `${config.fhirBaseUrl}/Coverage`
};

export const fhirSearchParams = {
  patient: {
    name: 'name',
    family: 'family',
    given: 'given',
    birthdate: 'birthdate',
    gender: 'gender',
    phone: 'telecom',
    email: 'telecom',
    identifier: 'identifier',
    mrn: 'identifier'
  },
  appointment: {
    patient: 'patient',
    date: 'date',
    status: 'status',
    practitioner: 'practitioner',
    location: 'location'
  },
  medicationRequest: {
    patient: 'patient',
    status: 'status',
    medication: 'medication',
    intent: 'intent'
  },
  practitioner: {
    name: 'name',
    family: 'family',
    given: 'given',
    identifier: 'identifier',
    specialty: 'specialty'
  }
};

