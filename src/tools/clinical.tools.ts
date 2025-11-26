import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { FHIRService } from '../services/fhir.service';
import { FHIRParser, ParsedCondition } from '../utils/fhir-parser';
import { ErrorHandler, FHIRMCPError } from '../utils/error-handler';

export class ClinicalTools {
  constructor(private fhirService: FHIRService) {}

  /**
   * Get patient conditions/diagnoses
   */
  async getPatientConditions(args: {
    patientId: string;
    status?: string;
    category?: string;
    limit?: number;
  }): Promise<{
    conditions: ParsedCondition[];
    total: number;
    hasMore: boolean;
  }> {
    try {
      if (!args.patientId) {
        throw ErrorHandler.createValidationError('Patient ID is required');
      }

      const searchParams: Record<string, string> = {
        patient: args.patientId
      };

      if (args.status) {
        searchParams['clinical-status'] = args.status;
      }
      if (args.category) {
        searchParams.category = args.category;
      }

      const result = await this.fhirService.search('Condition', searchParams, args.limit || 20);
      const conditions = result.resources.map(condition => FHIRParser.parseCondition(condition));

      return {
        conditions,
        total: result.total,
        hasMore: result.hasMore
      };
    } catch (error) {
      throw ErrorHandler.handleUnknownError(error);
    }
  }

  /**
   * Get patient allergies
   */
  async getAllergies(args: {
    patientId: string;
    status?: string;
    category?: string;
    limit?: number;
  }): Promise<{
    allergies: Array<{
      id: string;
      patientId: string;
      substance: string;
      status: string;
      category: string[];
      severity?: string;
      onsetDate?: string;
    }>;
    total: number;
    hasMore: boolean;
  }> {
    try {
      if (!args.patientId) {
        throw ErrorHandler.createValidationError('Patient ID is required');
      }

      const searchParams: Record<string, string> = {
        patient: args.patientId
      };

      if (args.status) {
        searchParams['clinical-status'] = args.status;
      }
      if (args.category) {
        searchParams.category = args.category;
      }

      const result = await this.fhirService.search('AllergyIntolerance', searchParams, args.limit || 20);
      const allergies = result.resources.map(allergy => FHIRParser.parseAllergy(allergy));

      return {
        allergies,
        total: result.total,
        hasMore: result.hasMore
      };
    } catch (error) {
      throw ErrorHandler.handleUnknownError(error);
    }
  }

  /**
   * Get recent observations (vitals, lab results, etc.)
   */
  async getRecentObservations(args: {
    patientId: string;
    category?: string;
    code?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
  }): Promise<{
    observations: Array<{
      id: string;
      patientId: string;
      code: string;
      display: string;
      value?: string;
      unit?: string;
      status: string;
      effectiveDateTime?: string;
      category?: string;
    }>;
    total: number;
    hasMore: boolean;
  }> {
    try {
      if (!args.patientId) {
        throw ErrorHandler.createValidationError('Patient ID is required');
      }

      const searchParams: Record<string, string> = {
        patient: args.patientId
      };

      if (args.category) {
        searchParams.category = args.category;
      }
      if (args.code) {
        searchParams.code = args.code;
      }
      if (args.dateFrom) {
        searchParams.date = `ge${args.dateFrom}`;
      }
      if (args.dateTo) {
        searchParams.date = searchParams.date ? `${searchParams.date}&le${args.dateTo}` : `le${args.dateTo}`;
      }

      const result = await this.fhirService.search('Observation', searchParams, args.limit || 20);
      
      const observations = result.resources.map(observation => {
        const code = observation.code?.coding?.[0];
        const valueQuantity = observation.valueQuantity;
        const valueString = observation.valueString;
        const value = valueQuantity ? `${valueQuantity.value} ${valueQuantity.unit || ''}`.trim() : valueString;

        return {
          id: observation.id,
          patientId: observation.subject?.reference?.split('/')[1] || '',
          code: code?.code || '',
          display: code?.display || '',
          value,
          unit: valueQuantity?.unit,
          status: observation.status,
          effectiveDateTime: observation.effectiveDateTime,
          category: observation.category?.[0]?.coding?.[0]?.display
        };
      });

      return {
        observations,
        total: result.total,
        hasMore: result.hasMore
      };
    } catch (error) {
      throw ErrorHandler.handleUnknownError(error);
    }
  }

  /**
   * Get patient procedures
   */
  async getPatientProcedures(args: {
    patientId: string;
    status?: string;
    category?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
  }): Promise<{
    procedures: Array<{
      id: string;
      patientId: string;
      code: string;
      display: string;
      status: string;
      performedDateTime?: string;
      performedPeriod?: {
        start?: string;
        end?: string;
      };
      category?: string;
      reason?: string;
    }>;
    total: number;
    hasMore: boolean;
  }> {
    try {
      if (!args.patientId) {
        throw ErrorHandler.createValidationError('Patient ID is required');
      }

      const searchParams: Record<string, string> = {
        patient: args.patientId
      };

      if (args.status) {
        searchParams.status = args.status;
      }
      if (args.category) {
        searchParams.category = args.category;
      }
      if (args.dateFrom) {
        searchParams.date = `ge${args.dateFrom}`;
      }
      if (args.dateTo) {
        searchParams.date = searchParams.date ? `${searchParams.date}&le${args.dateTo}` : `le${args.dateTo}`;
      }

      const result = await this.fhirService.search('Procedure', searchParams, args.limit || 20);
      
      const procedures = result.resources.map(procedure => {
        const code = procedure.code?.coding?.[0];
        const reason = procedure.reasonCode?.[0]?.coding?.[0]?.display;

        return {
          id: procedure.id,
          patientId: procedure.subject?.reference?.split('/')[1] || '',
          code: code?.code || '',
          display: code?.display || '',
          status: procedure.status,
          performedDateTime: procedure.performedDateTime,
          performedPeriod: {
            start: procedure.performedPeriod?.start,
            end: procedure.performedPeriod?.end
          },
          category: procedure.category?.coding?.[0]?.display,
          reason
        };
      });

      return {
        procedures,
        total: result.total,
        hasMore: result.hasMore
      };
    } catch (error) {
      throw ErrorHandler.handleUnknownError(error);
    }
  }

  /**
   * Get patient coverage/insurance information
   */
  async getPatientCoverage(args: {
    patientId: string;
    status?: string;
    limit?: number;
  }): Promise<{
    coverage: Array<{
      id: string;
      patientId: string;
      status: string;
      type?: string;
      subscriberId?: string;
      payor?: string;
      period?: {
        start?: string;
        end?: string;
      };
    }>;
    total: number;
    hasMore: boolean;
  }> {
    try {
      if (!args.patientId) {
        throw ErrorHandler.createValidationError('Patient ID is required');
      }

      const searchParams: Record<string, string> = {
        beneficiary: args.patientId
      };

      if (args.status) {
        searchParams.status = args.status;
      }

      const result = await this.fhirService.search('Coverage', searchParams, args.limit || 10);
      
      const coverage = result.resources.map(coverage => ({
        id: coverage.id,
        patientId: coverage.beneficiary?.reference?.split('/')[1] || '',
        status: coverage.status,
        type: coverage.type?.coding?.[0]?.display,
        subscriberId: coverage.subscriberId,
        payor: coverage.payor?.[0]?.display,
        period: {
          start: coverage.period?.start,
          end: coverage.period?.end
        }
      }));

      return {
        coverage,
        total: result.total,
        hasMore: result.hasMore
      };
    } catch (error) {
      throw ErrorHandler.handleUnknownError(error);
    }
  }

  /**
   * Get MCP tool definitions for clinical operations
   */
  getTools(): Tool[] {
    return [
      {
        name: 'get_patient_conditions',
        description: 'Get patient conditions/diagnoses',
        inputSchema: {
          type: 'object',
          properties: {
            patientId: {
              type: 'string',
              description: 'FHIR Patient resource ID'
            },
            status: {
              type: 'string',
              enum: ['active', 'recurrence', 'relapse', 'inactive', 'remission', 'resolved'],
              description: 'Clinical status to filter by'
            },
            category: {
              type: 'string',
              description: 'Condition category to filter by'
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results to return (default: 20)',
              default: 20
            }
          },
          required: ['patientId']
        }
      },
      {
        name: 'get_allergies',
        description: 'Get patient allergies and intolerances',
        inputSchema: {
          type: 'object',
          properties: {
            patientId: {
              type: 'string',
              description: 'FHIR Patient resource ID'
            },
            status: {
              type: 'string',
              enum: ['active', 'inactive', 'resolved'],
              description: 'Allergy status to filter by'
            },
            category: {
              type: 'string',
              enum: ['food', 'medication', 'environment', 'biologic'],
              description: 'Allergy category to filter by'
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results to return (default: 20)',
              default: 20
            }
          },
          required: ['patientId']
        }
      },
      {
        name: 'get_recent_observations',
        description: 'Get recent observations (vitals, lab results, etc.) for a patient',
        inputSchema: {
          type: 'object',
          properties: {
            patientId: {
              type: 'string',
              description: 'FHIR Patient resource ID'
            },
            category: {
              type: 'string',
              enum: ['vital-signs', 'laboratory', 'imaging', 'survey', 'social-history'],
              description: 'Observation category to filter by'
            },
            code: {
              type: 'string',
              description: 'Specific observation code to filter by'
            },
            dateFrom: {
              type: 'string',
              description: 'Start date in YYYY-MM-DD format'
            },
            dateTo: {
              type: 'string',
              description: 'End date in YYYY-MM-DD format'
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results to return (default: 20)',
              default: 20
            }
          },
          required: ['patientId']
        }
      },
      {
        name: 'get_patient_procedures',
        description: 'Get patient procedures',
        inputSchema: {
          type: 'object',
          properties: {
            patientId: {
              type: 'string',
              description: 'FHIR Patient resource ID'
            },
            status: {
              type: 'string',
              enum: ['preparation', 'in-progress', 'not-done', 'on-hold', 'stopped', 'completed', 'entered-in-error', 'unknown'],
              description: 'Procedure status to filter by'
            },
            category: {
              type: 'string',
              description: 'Procedure category to filter by'
            },
            dateFrom: {
              type: 'string',
              description: 'Start date in YYYY-MM-DD format'
            },
            dateTo: {
              type: 'string',
              description: 'End date in YYYY-MM-DD format'
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results to return (default: 20)',
              default: 20
            }
          },
          required: ['patientId']
        }
      },
      {
        name: 'get_patient_coverage',
        description: 'Get patient insurance coverage information',
        inputSchema: {
          type: 'object',
          properties: {
            patientId: {
              type: 'string',
              description: 'FHIR Patient resource ID'
            },
            status: {
              type: 'string',
              enum: ['active', 'cancelled', 'draft', 'entered-in-error'],
              description: 'Coverage status to filter by'
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results to return (default: 10)',
              default: 10
            }
          },
          required: ['patientId']
        }
      }
    ];
  }
}




