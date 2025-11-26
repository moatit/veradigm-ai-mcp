import { FHIRResource } from '../services/fhir.service';

export interface ParsedPatient {
  id: string;
  name: string;
  firstName?: string;
  lastName?: string;
  birthDate?: string;
  gender?: string;
  phone?: string;
  email?: string;
  address?: string;
  mrn?: string;
  active: boolean;
}

export interface ParsedAppointment {
  id: string;
  patientId: string;
  patientName?: string;
  practitionerId?: string;
  practitionerName?: string;
  locationId?: string;
  locationName?: string;
  start: string;
  end: string;
  status: string;
  description?: string;
  serviceType?: string;
}

export interface ParsedMedication {
  id: string;
  patientId: string;
  medicationName: string;
  status: string;
  intent: string;
  authoredOn?: string;
  dosage?: string;
  instructions?: string;
  prescriberId?: string;
  prescriberName?: string;
}

export interface ParsedPractitioner {
  id: string;
  name: string;
  firstName?: string;
  lastName?: string;
  specialty?: string[];
  phone?: string;
  email?: string;
  active: boolean;
}

export interface ParsedCondition {
  id: string;
  patientId: string;
  code: string;
  display: string;
  status: string;
  onsetDate?: string;
  recordedDate?: string;
  severity?: string;
}

export class FHIRParser {
  /**
   * Parse FHIR Patient resource
   */
  static parsePatient(patient: FHIRResource): ParsedPatient {
    const name = patient.name?.[0];
    const telecom = patient.telecom || [];
    const identifier = patient.identifier || [];
    
    const phone = telecom.find(t => t.system === 'phone')?.value;
    const email = telecom.find(t => t.system === 'email')?.value;
    const mrn = identifier.find(i => i.type?.coding?.[0]?.code === 'MR')?.value;
    
    const address = patient.address?.[0];
    const addressString = address ? 
      `${address.line?.join(', ')}, ${address.city}, ${address.state} ${address.postalCode}` : undefined;

    return {
      id: patient.id,
      name: name ? `${name.given?.join(' ')} ${name.family}`.trim() : 'Unknown',
      firstName: name?.given?.[0],
      lastName: name?.family,
      birthDate: patient.birthDate,
      gender: patient.gender,
      phone,
      email,
      address: addressString,
      mrn,
      active: patient.active !== false
    };
  }

  /**
   * Parse FHIR Appointment resource
   */
  static parseAppointment(appointment: FHIRResource): ParsedAppointment {
    const participant = appointment.participant || [];
    const patient = participant.find(p => p.actor?.reference?.includes('Patient'));
    const practitioner = participant.find(p => p.actor?.reference?.includes('Practitioner'));
    const location = participant.find(p => p.actor?.reference?.includes('Location'));

    return {
      id: appointment.id,
      patientId: patient?.actor?.reference?.split('/')[1] || '',
      patientName: patient?.actor?.display,
      practitionerId: practitioner?.actor?.reference?.split('/')[1],
      practitionerName: practitioner?.actor?.display,
      locationId: location?.actor?.reference?.split('/')[1],
      locationName: location?.actor?.display,
      start: appointment.start,
      end: appointment.end,
      status: appointment.status,
      description: appointment.description,
      serviceType: appointment.serviceType?.[0]?.coding?.[0]?.display
    };
  }

  /**
   * Parse FHIR MedicationRequest resource
   */
  static parseMedicationRequest(medicationRequest: FHIRResource): ParsedMedication {
    const medication = medicationRequest.medicationCodeableConcept || medicationRequest.medicationReference;
    const requester = medicationRequest.requester;
    const dosage = medicationRequest.dosageInstruction?.[0];

    return {
      id: medicationRequest.id,
      patientId: medicationRequest.subject?.reference?.split('/')[1] || '',
      medicationName: medication?.coding?.[0]?.display || medication?.display || 'Unknown',
      status: medicationRequest.status,
      intent: medicationRequest.intent,
      authoredOn: medicationRequest.authoredOn,
      dosage: dosage?.text || dosage?.doseAndRate?.[0]?.doseQuantity?.text,
      instructions: medicationRequest.note?.[0]?.text,
      prescriberId: requester?.reference?.split('/')[1],
      prescriberName: requester?.display
    };
  }

  /**
   * Parse FHIR Practitioner resource
   */
  static parsePractitioner(practitioner: FHIRResource): ParsedPractitioner {
    const name = practitioner.name?.[0];
    const telecom = practitioner.telecom || [];
    const qualification = practitioner.qualification || [];
    
    const phone = telecom.find(t => t.system === 'phone')?.value;
    const email = telecom.find(t => t.system === 'email')?.value;
    const specialty = qualification
      .map(q => q.code?.coding?.[0]?.display)
      .filter(Boolean);

    return {
      id: practitioner.id,
      name: name ? `${name.given?.join(' ')} ${name.family}`.trim() : 'Unknown',
      firstName: name?.given?.[0],
      lastName: name?.family,
      specialty,
      phone,
      email,
      active: practitioner.active !== false
    };
  }

  /**
   * Parse FHIR Condition resource
   */
  static parseCondition(condition: FHIRResource): ParsedCondition {
    const code = condition.code?.coding?.[0];
    const severity = condition.severity?.coding?.[0]?.display;

    return {
      id: condition.id,
      patientId: condition.subject?.reference?.split('/')[1] || '',
      code: code?.code || '',
      display: code?.display || '',
      status: condition.clinicalStatus?.coding?.[0]?.code || '',
      onsetDate: condition.onsetDateTime || condition.onsetPeriod?.start,
      recordedDate: condition.recordedDate,
      severity
    };
  }

  /**
   * Parse FHIR AllergyIntolerance resource
   */
  static parseAllergy(allergy: FHIRResource): {
    id: string;
    patientId: string;
    substance: string;
    status: string;
    category: string[];
    severity?: string;
    onsetDate?: string;
  } {
    const substance = allergy.code?.coding?.[0];
    const category = allergy.category || [];

    return {
      id: allergy.id,
      patientId: allergy.patient?.reference?.split('/')[1] || '',
      substance: substance?.display || '',
      status: allergy.clinicalStatus?.coding?.[0]?.code || '',
      category: category.map(c => c.toString()),
      severity: allergy.severity?.coding?.[0]?.display,
      onsetDate: allergy.onsetDateTime
    };
  }

  /**
   * Format date for display
   */
  static formatDate(dateString?: string): string {
    if (!dateString) return '';
    
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
    } catch {
      return dateString;
    }
  }

  /**
   * Format datetime for display
   */
  static formatDateTime(dateTimeString?: string): string {
    if (!dateTimeString) return '';
    
    try {
      const date = new Date(dateTimeString);
      return date.toLocaleString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      });
    } catch {
      return dateTimeString;
    }
  }
}

