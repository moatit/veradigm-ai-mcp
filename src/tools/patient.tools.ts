import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { FHIRService } from '../services/fhir.service';
import { FHIRParser, ParsedPatient } from '../utils/fhir-parser';
import { ErrorHandler, FHIRMCPError } from '../utils/error-handler';

export class PatientTools {
  constructor(private fhirService: FHIRService) {}

  /**
   * Search for patients by various criteria
   */
  async searchPatient(args: {
    name?: string;
    firstName?: string;
    lastName?: string;
    birthDate?: string;
    gender?: string;
    phone?: string;
    email?: string;
    mrn?: string;
    limit?: number;
  }): Promise<{
    patients: ParsedPatient[];
    total: number;
    hasMore: boolean;
  }> {
    try {
      const searchParams: Record<string, string> = {};
      
      if (args.name) {
        searchParams.name = args.name;
      } else {
        if (args.firstName) searchParams.given = args.firstName;
        if (args.lastName) searchParams.family = args.lastName;
      }
      
      if (args.birthDate) searchParams.birthdate = args.birthDate;
      if (args.gender) searchParams.gender = args.gender;
      if (args.phone) searchParams.telecom = args.phone;
      if (args.email) searchParams.telecom = args.email;
      if (args.mrn) searchParams.identifier = args.mrn;

      const result = await this.fhirService.search('Patient', searchParams, args.limit || 20);
      const patients = result.resources.map(patient => FHIRParser.parsePatient(patient));

      return {
        patients,
        total: result.total,
        hasMore: result.hasMore
      };
    } catch (error) {
      throw ErrorHandler.handleUnknownError(error);
    }
  }

  /**
   * Get detailed patient information by ID
   */
  async getPatientDetails(args: { patientId: string }): Promise<ParsedPatient> {
    try {
      if (!args.patientId) {
        throw ErrorHandler.createValidationError('Patient ID is required');
      }

      const patient = await this.fhirService.getResource('Patient', args.patientId);
      return FHIRParser.parsePatient(patient);
    } catch (error) {
      if (error instanceof FHIRMCPError) {
        throw error;
      }
      throw ErrorHandler.handleUnknownError(error);
    }
  }

  /**
   * Verify patient identity by matching provided information
   */
  async verifyPatientIdentity(args: {
    firstName?: string;
    lastName?: string;
    birthDate?: string;
    phone?: string;
    email?: string;
    mrn?: string;
  }): Promise<{
    verified: boolean;
    patient?: ParsedPatient;
    matchScore?: number;
    suggestions?: ParsedPatient[];
  }> {
    try {
      if (!args.firstName && !args.lastName && !args.birthDate && !args.phone && !args.email && !args.mrn) {
        throw ErrorHandler.createValidationError('At least one search criterion is required');
      }

      // Search for potential matches
      const searchResult = await this.searchPatient({
        firstName: args.firstName,
        lastName: args.lastName,
        birthDate: args.birthDate,
        phone: args.phone,
        email: args.email,
        mrn: args.mrn,
        limit: 10
      });

      if (searchResult.patients.length === 0) {
        return {
          verified: false,
          suggestions: []
        };
      }

      // Calculate match score for the first result
      const bestMatch = searchResult.patients[0];
      const matchScore = this.calculateMatchScore(bestMatch, args);

      return {
        verified: matchScore >= 0.8, // 80% match threshold
        patient: bestMatch,
        matchScore,
        suggestions: searchResult.patients.slice(1, 5) // Top 4 additional suggestions
      };
    } catch (error) {
      throw ErrorHandler.handleUnknownError(error);
    }
  }

  /**
   * Calculate match score between patient and search criteria
   */
  private calculateMatchScore(patient: ParsedPatient, criteria: {
    firstName?: string;
    lastName?: string;
    birthDate?: string;
    phone?: string;
    email?: string;
    mrn?: string;
  }): number {
    let score = 0;
    let totalChecks = 0;

    // Name matching
    if (criteria.firstName && patient.firstName) {
      totalChecks++;
      if (patient.firstName.toLowerCase() === criteria.firstName.toLowerCase()) {
        score += 1;
      } else if (patient.firstName.toLowerCase().includes(criteria.firstName.toLowerCase())) {
        score += 0.8;
      }
    }

    if (criteria.lastName && patient.lastName) {
      totalChecks++;
      if (patient.lastName.toLowerCase() === criteria.lastName.toLowerCase()) {
        score += 1;
      } else if (patient.lastName.toLowerCase().includes(criteria.lastName.toLowerCase())) {
        score += 0.8;
      }
    }

    // Birth date matching
    if (criteria.birthDate && patient.birthDate) {
      totalChecks++;
      if (patient.birthDate === criteria.birthDate) {
        score += 1;
      }
    }

    // Phone matching
    if (criteria.phone && patient.phone) {
      totalChecks++;
      const normalizedCriteriaPhone = criteria.phone.replace(/\D/g, '');
      const normalizedPatientPhone = patient.phone.replace(/\D/g, '');
      if (normalizedPatientPhone === normalizedCriteriaPhone) {
        score += 1;
      }
    }

    // Email matching
    if (criteria.email && patient.email) {
      totalChecks++;
      if (patient.email.toLowerCase() === criteria.email.toLowerCase()) {
        score += 1;
      }
    }

    // MRN matching
    if (criteria.mrn && patient.mrn) {
      totalChecks++;
      if (patient.mrn === criteria.mrn) {
        score += 1;
      }
    }

    return totalChecks > 0 ? score / totalChecks : 0;
  }

  /**
   * Get MCP tool definitions for patient operations
   */
  getTools(): Tool[] {
    return [
      {
        name: 'search_patient',
        description: 'Search for patients by name, birth date, phone, email, or MRN',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Full name to search for'
            },
            firstName: {
              type: 'string',
              description: 'First name to search for'
            },
            lastName: {
              type: 'string',
              description: 'Last name to search for'
            },
            birthDate: {
              type: 'string',
              description: 'Birth date in YYYY-MM-DD format'
            },
            gender: {
              type: 'string',
              enum: ['male', 'female', 'other', 'unknown'],
              description: 'Gender to filter by'
            },
            phone: {
              type: 'string',
              description: 'Phone number to search for'
            },
            email: {
              type: 'string',
              description: 'Email address to search for'
            },
            mrn: {
              type: 'string',
              description: 'Medical Record Number to search for'
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results to return (default: 20)',
              default: 20
            }
          }
        }
      },
      {
        name: 'get_patient_details',
        description: 'Get detailed information for a specific patient by ID',
        inputSchema: {
          type: 'object',
          properties: {
            patientId: {
              type: 'string',
              description: 'FHIR Patient resource ID'
            }
          },
          required: ['patientId']
        }
      },
      {
        name: 'verify_patient_identity',
        description: 'Verify patient identity by matching provided information against patient records',
        inputSchema: {
          type: 'object',
          properties: {
            firstName: {
              type: 'string',
              description: 'Patient first name'
            },
            lastName: {
              type: 'string',
              description: 'Patient last name'
            },
            birthDate: {
              type: 'string',
              description: 'Patient birth date in YYYY-MM-DD format'
            },
            phone: {
              type: 'string',
              description: 'Patient phone number'
            },
            email: {
              type: 'string',
              description: 'Patient email address'
            },
            mrn: {
              type: 'string',
              description: 'Patient Medical Record Number'
            }
          }
        }
      }
    ];
  }
}




