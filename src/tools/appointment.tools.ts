import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { FHIRService } from '../services/fhir.service';
import { FHIRParser, ParsedAppointment } from '../utils/fhir-parser';
import { ErrorHandler, FHIRMCPError } from '../utils/error-handler';

export class AppointmentTools {
  constructor(private fhirService: FHIRService) {}

  /**
   * Get upcoming appointments for a patient
   */
  async getUpcomingAppointments(args: {
    patientId: string;
    startDate?: string;
    endDate?: string;
    status?: string;
    limit?: number;
  }): Promise<{
    appointments: ParsedAppointment[];
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

      if (args.startDate) {
        searchParams.date = `ge${args.startDate}`;
      }
      if (args.endDate) {
        searchParams.date = searchParams.date ? `${searchParams.date}&le${args.endDate}` : `le${args.endDate}`;
      }
      if (args.status) {
        searchParams.status = args.status;
      }

      const result = await this.fhirService.search('Appointment', searchParams, args.limit || 20);
      const appointments = result.resources.map(appointment => FHIRParser.parseAppointment(appointment));

      return {
        appointments,
        total: result.total,
        hasMore: result.hasMore
      };
    } catch (error) {
      throw ErrorHandler.handleUnknownError(error);
    }
  }

  /**
   * Get details for a specific appointment
   */
  async getAppointmentDetails(args: { appointmentId: string }): Promise<ParsedAppointment> {
    try {
      if (!args.appointmentId) {
        throw ErrorHandler.createValidationError('Appointment ID is required');
      }

      const appointment = await this.fhirService.getResource('Appointment', args.appointmentId);
      return FHIRParser.parseAppointment(appointment);
    } catch (error) {
      if (error instanceof FHIRMCPError) {
        throw error;
      }
      throw ErrorHandler.handleUnknownError(error);
    }
  }

  /**
   * Check the status of a specific appointment
   */
  async checkAppointmentStatus(args: { appointmentId: string }): Promise<{
    appointmentId: string;
    status: string;
    start: string;
    end: string;
    patientName?: string;
    practitionerName?: string;
    locationName?: string;
    description?: string;
  }> {
    try {
      const appointment = await this.getAppointmentDetails(args);
      
      return {
        appointmentId: appointment.id,
        status: appointment.status,
        start: appointment.start,
        end: appointment.end,
        patientName: appointment.patientName,
        practitionerName: appointment.practitionerName,
        locationName: appointment.locationName,
        description: appointment.description
      };
    } catch (error) {
      throw ErrorHandler.handleUnknownError(error);
    }
  }

  /**
   * Find the next scheduled appointment for a patient
   */
  async findPatientNextAppointment(args: { patientId: string }): Promise<{
    appointment?: ParsedAppointment;
    found: boolean;
  }> {
    try {
      if (!args.patientId) {
        throw ErrorHandler.createValidationError('Patient ID is required');
      }

      // Get appointments starting from today
      const today = new Date().toISOString().split('T')[0];
      const result = await this.getUpcomingAppointments({
        patientId: args.patientId,
        startDate: today,
        status: 'booked', // Only get confirmed appointments
        limit: 1
      });

      return {
        appointment: result.appointments[0],
        found: result.appointments.length > 0
      };
    } catch (error) {
      throw ErrorHandler.handleUnknownError(error);
    }
  }

  /**
   * Get appointments for a specific date range
   */
  async getAppointmentsByDateRange(args: {
    startDate: string;
    endDate: string;
    practitionerId?: string;
    locationId?: string;
    status?: string;
    limit?: number;
  }): Promise<{
    appointments: ParsedAppointment[];
    total: number;
    hasMore: boolean;
  }> {
    try {
      const searchParams: Record<string, string> = {
        date: `ge${args.startDate}&le${args.endDate}`
      };

      if (args.practitionerId) {
        searchParams.practitioner = args.practitionerId;
      }
      if (args.locationId) {
        searchParams.location = args.locationId;
      }
      if (args.status) {
        searchParams.status = args.status;
      }

      const result = await this.fhirService.search('Appointment', searchParams, args.limit || 50);
      const appointments = result.resources.map(appointment => FHIRParser.parseAppointment(appointment));

      return {
        appointments,
        total: result.total,
        hasMore: result.hasMore
      };
    } catch (error) {
      throw ErrorHandler.handleUnknownError(error);
    }
  }

  /**
   * Get MCP tool definitions for appointment operations
   */
  getTools(): Tool[] {
    return [
      {
        name: 'get_upcoming_appointments',
        description: 'Get upcoming appointments for a patient within a date range',
        inputSchema: {
          type: 'object',
          properties: {
            patientId: {
              type: 'string',
              description: 'FHIR Patient resource ID'
            },
            startDate: {
              type: 'string',
              description: 'Start date in YYYY-MM-DD format (defaults to today)'
            },
            endDate: {
              type: 'string',
              description: 'End date in YYYY-MM-DD format'
            },
            status: {
              type: 'string',
              enum: ['proposed', 'pending', 'booked', 'arrived', 'fulfilled', 'cancelled', 'noshow', 'entered-in-error', 'checked-in', 'waitlist'],
              description: 'Appointment status to filter by'
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
        name: 'get_appointment_details',
        description: 'Get detailed information for a specific appointment',
        inputSchema: {
          type: 'object',
          properties: {
            appointmentId: {
              type: 'string',
              description: 'FHIR Appointment resource ID'
            }
          },
          required: ['appointmentId']
        }
      },
      {
        name: 'check_appointment_status',
        description: 'Check the current status of a specific appointment',
        inputSchema: {
          type: 'object',
          properties: {
            appointmentId: {
              type: 'string',
              description: 'FHIR Appointment resource ID'
            }
          },
          required: ['appointmentId']
        }
      },
      {
        name: 'find_patient_next_appointment',
        description: 'Find the next scheduled appointment for a patient',
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
        name: 'get_appointments_by_date_range',
        description: 'Get appointments within a specific date range, optionally filtered by practitioner or location',
        inputSchema: {
          type: 'object',
          properties: {
            startDate: {
              type: 'string',
              description: 'Start date in YYYY-MM-DD format'
            },
            endDate: {
              type: 'string',
              description: 'End date in YYYY-MM-DD format'
            },
            practitionerId: {
              type: 'string',
              description: 'FHIR Practitioner resource ID to filter by'
            },
            locationId: {
              type: 'string',
              description: 'FHIR Location resource ID to filter by'
            },
            status: {
              type: 'string',
              enum: ['proposed', 'pending', 'booked', 'arrived', 'fulfilled', 'cancelled', 'noshow', 'entered-in-error', 'checked-in', 'waitlist'],
              description: 'Appointment status to filter by'
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results to return (default: 50)',
              default: 50
            }
          },
          required: ['startDate', 'endDate']
        }
      }
    ];
  }
}




