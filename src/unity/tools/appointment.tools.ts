import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { UnityService, UnityMagicResponse } from '../services/unity.service';
import { UnityErrorHandler, UnityMCPError } from '../utils/error-handler';
import { UnityActions } from '../config/unity-endpoints';

/**
 * Appointment Data Structure for Save/Update operations
 */
export interface AppointmentData {
  patientId: string;
  appointmentDate: string; // Format: MM/DD/YYYY
  appointmentTime: string; // Format: HH:MM (24-hour)
  duration: number; // Duration in minutes
  providerId?: string;
  locationId?: string;
  appointmentType?: string;
  reasonForVisit?: string;
  notes?: string;
}

/**
 * Appointment Cancellation Data
 */
export interface AppointmentCancelData {
  appointmentId: string;
  patientId: string;
  cancellationReason?: string;
}

/**
 * Parsed Appointment Result
 */
export interface ParsedAppointment {
  id: string;
  patientId: string;
  date: string;
  time: string;
  duration: number;
  status: string;
  providerId?: string;
  providerName?: string;
  locationId?: string;
  locationName?: string;
  appointmentType?: string;
  reasonForVisit?: string;
  notes?: string;
}

/**
 * Unity Appointment Tools
 * 
 * Provides MCP tools for appointment write operations via Unity API:
 * - SaveAppointment: Create or update appointments
 * - CancelAppointment: Cancel appointments
 * - GetOpenSlots: Find available appointment slots
 */
export class UnityAppointmentTools {
  constructor(private unityService: UnityService) {}

  /**
   * Save (create or update) an appointment
   */
  async saveAppointment(args: AppointmentData): Promise<{
    success: boolean;
    appointmentId?: string;
    message: string;
    appointment?: ParsedAppointment;
  }> {
    try {
      // Validate required fields
      if (!args.patientId) {
        throw UnityErrorHandler.createValidationError('Patient ID is required');
      }
      if (!args.appointmentDate) {
        throw UnityErrorHandler.createValidationError('Appointment date is required');
      }
      if (!args.appointmentTime) {
        throw UnityErrorHandler.createValidationError('Appointment time is required');
      }
      if (!args.duration || args.duration <= 0) {
        throw UnityErrorHandler.createValidationError('Valid duration is required');
      }

      // Build appointment XML for Unity SaveAppointment action
      const appointmentXml = this.buildAppointmentXml(args);

      console.error(`[Unity Appointment] Saving appointment for patient ${args.patientId}`);
      console.error(`[Unity Appointment] Date: ${args.appointmentDate} Time: ${args.appointmentTime}`);

      // Execute SaveAppointment action
      // Parameter1: Appointment XML
      // Parameter2: Optional flags
      const response = await this.unityService.executeAction<any>(
        UnityActions.Scheduling.SAVE_APPOINTMENT,
        {
          Parameter1: appointmentXml,
          Parameter2: '' // Additional options if needed
        },
        args.patientId,
        'PM' // Appointments typically go to Practice Management
      );

      if (!response.success) {
        throw UnityErrorHandler.createAPIError(
          response.error || 'Failed to save appointment',
          'SaveAppointment'
        );
      }

      // Parse the response to get appointment ID and details
      const appointmentId = this.extractAppointmentId(response.data);
      const appointment = this.parseAppointmentResponse(response.data, args);

      return {
        success: true,
        appointmentId,
        message: 'Appointment saved successfully',
        appointment
      };
    } catch (error) {
      if (error instanceof UnityMCPError) {
        throw error;
      }
      throw UnityErrorHandler.handleUnknownError(error, 'SaveAppointment');
    }
  }

  /**
   * Cancel an existing appointment
   */
  async cancelAppointment(args: AppointmentCancelData): Promise<{
    success: boolean;
    message: string;
    appointmentId: string;
    cancellationReason?: string;
  }> {
    try {
      // Validate required fields
      if (!args.appointmentId) {
        throw UnityErrorHandler.createValidationError('Appointment ID is required');
      }
      if (!args.patientId) {
        throw UnityErrorHandler.createValidationError('Patient ID is required');
      }

      console.error(`[Unity Appointment] Cancelling appointment ${args.appointmentId}`);

      // Execute CancelAppointment action
      // Parameter1: Appointment ID
      // Parameter2: Cancellation reason
      const response = await this.unityService.executeAction<any>(
        UnityActions.Scheduling.CANCEL_APPOINTMENT,
        {
          Parameter1: args.appointmentId,
          Parameter2: args.cancellationReason || 'Cancelled via API'
        },
        args.patientId,
        'PM'
      );

      if (!response.success) {
        throw UnityErrorHandler.createAPIError(
          response.error || 'Failed to cancel appointment',
          'CancelAppointment'
        );
      }

      return {
        success: true,
        message: 'Appointment cancelled successfully',
        appointmentId: args.appointmentId,
        cancellationReason: args.cancellationReason
      };
    } catch (error) {
      if (error instanceof UnityMCPError) {
        throw error;
      }
      throw UnityErrorHandler.handleUnknownError(error, 'CancelAppointment');
    }
  }

  /**
   * Get open appointment slots
   */
  async getOpenSlots(args: {
    providerId?: string;
    locationId?: string;
    startDate: string;
    endDate: string;
    appointmentType?: string;
    duration?: number;
  }): Promise<{
    slots: Array<{
      date: string;
      time: string;
      duration: number;
      providerId?: string;
      locationId?: string;
    }>;
    total: number;
  }> {
    try {
      if (!args.startDate || !args.endDate) {
        throw UnityErrorHandler.createValidationError('Start date and end date are required');
      }

      console.error(`[Unity Appointment] Getting open slots from ${args.startDate} to ${args.endDate}`);

      // Build criteria for slot search
      const criteria = this.buildSlotSearchCriteria(args);

      const response = await this.unityService.executeAction<any>(
        UnityActions.Scheduling.GET_OPEN_SLOTS,
        {
          Parameter1: criteria,
          Parameter2: args.providerId || '',
          Parameter3: args.locationId || ''
        },
        '',
        'PM'
      );

      if (!response.success) {
        return { slots: [], total: 0 };
      }

      const slots = this.parseOpenSlots(response.data);

      return {
        slots,
        total: slots.length
      };
    } catch (error) {
      if (error instanceof UnityMCPError) {
        throw error;
      }
      throw UnityErrorHandler.handleUnknownError(error, 'GetOpenSlots');
    }
  }

  /**
   * Get appointments for a patient
   */
  async getPatientAppointments(args: {
    patientId: string;
    startDate?: string;
    endDate?: string;
    status?: string;
  }): Promise<{
    appointments: ParsedAppointment[];
    total: number;
  }> {
    try {
      if (!args.patientId) {
        throw UnityErrorHandler.createValidationError('Patient ID is required');
      }

      console.error(`[Unity Appointment] Getting appointments for patient ${args.patientId}`);

      // Build date range parameter
      let dateRange = '';
      if (args.startDate && args.endDate) {
        dateRange = `${args.startDate}|${args.endDate}`;
      }

      const response = await this.unityService.executeAction<any>(
        UnityActions.Scheduling.GET_APPOINTMENTS,
        {
          Parameter1: dateRange,
          Parameter2: args.status || ''
        },
        args.patientId,
        'PM'
      );

      if (!response.success) {
        return { appointments: [], total: 0 };
      }

      const appointments = this.parseAppointmentsList(response.data);

      return {
        appointments,
        total: appointments.length
      };
    } catch (error) {
      if (error instanceof UnityMCPError) {
        throw error;
      }
      throw UnityErrorHandler.handleUnknownError(error, 'GetAppointments');
    }
  }

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Build appointment XML for SaveAppointment
   */
  private buildAppointmentXml(data: AppointmentData): string {
    let xml = '<appointment>';
    
    xml += `<PatientID>${this.escapeXml(data.patientId)}</PatientID>`;
    xml += `<AppointmentDate>${this.escapeXml(data.appointmentDate)}</AppointmentDate>`;
    xml += `<AppointmentTime>${this.escapeXml(data.appointmentTime)}</AppointmentTime>`;
    xml += `<Duration>${data.duration}</Duration>`;
    
    if (data.providerId) {
      xml += `<ProviderID>${this.escapeXml(data.providerId)}</ProviderID>`;
    }
    if (data.locationId) {
      xml += `<LocationID>${this.escapeXml(data.locationId)}</LocationID>`;
    }
    if (data.appointmentType) {
      xml += `<AppointmentType>${this.escapeXml(data.appointmentType)}</AppointmentType>`;
    }
    if (data.reasonForVisit) {
      xml += `<ReasonForVisit>${this.escapeXml(data.reasonForVisit)}</ReasonForVisit>`;
    }
    if (data.notes) {
      xml += `<Notes>${this.escapeXml(data.notes)}</Notes>`;
    }
    
    xml += '</appointment>';
    return xml;
  }

  /**
   * Build slot search criteria
   */
  private buildSlotSearchCriteria(args: {
    startDate: string;
    endDate: string;
    appointmentType?: string;
    duration?: number;
  }): string {
    let xml = '<criteria>';
    xml += `<StartDate>${this.escapeXml(args.startDate)}</StartDate>`;
    xml += `<EndDate>${this.escapeXml(args.endDate)}</EndDate>`;
    
    if (args.appointmentType) {
      xml += `<AppointmentType>${this.escapeXml(args.appointmentType)}</AppointmentType>`;
    }
    if (args.duration) {
      xml += `<Duration>${args.duration}</Duration>`;
    }
    
    xml += '</criteria>';
    return xml;
  }

  /**
   * Extract appointment ID from response
   */
  private extractAppointmentId(data: any): string {
    if (!data) return '';
    
    // Try common response field names
    return data.AppointmentID || 
           data.appointmentid || 
           data.ID || 
           data.id || 
           '';
  }

  /**
   * Parse appointment response into structured format
   */
  private parseAppointmentResponse(data: any, original: AppointmentData): ParsedAppointment {
    return {
      id: this.extractAppointmentId(data),
      patientId: original.patientId,
      date: original.appointmentDate,
      time: original.appointmentTime,
      duration: original.duration,
      status: data?.Status || 'Scheduled',
      providerId: data?.ProviderID || original.providerId,
      providerName: data?.ProviderName,
      locationId: data?.LocationID || original.locationId,
      locationName: data?.LocationName,
      appointmentType: data?.AppointmentType || original.appointmentType,
      reasonForVisit: data?.ReasonForVisit || original.reasonForVisit,
      notes: data?.Notes || original.notes
    };
  }

  /**
   * Parse list of appointments from response
   */
  private parseAppointmentsList(data: any): ParsedAppointment[] {
    if (!data) return [];
    
    const items = Array.isArray(data) ? data : [data];
    
    return items.map(item => ({
      id: item.AppointmentID || item.ID || '',
      patientId: item.PatientID || '',
      date: item.AppointmentDate || item.Date || '',
      time: item.AppointmentTime || item.Time || '',
      duration: parseInt(item.Duration) || 0,
      status: item.Status || '',
      providerId: item.ProviderID,
      providerName: item.ProviderName,
      locationId: item.LocationID,
      locationName: item.LocationName,
      appointmentType: item.AppointmentType,
      reasonForVisit: item.ReasonForVisit,
      notes: item.Notes
    }));
  }

  /**
   * Parse open slots from response
   */
  private parseOpenSlots(data: any): Array<{
    date: string;
    time: string;
    duration: number;
    providerId?: string;
    locationId?: string;
  }> {
    if (!data) return [];
    
    const items = Array.isArray(data) ? data : [data];
    
    return items.map(item => ({
      date: item.Date || item.SlotDate || '',
      time: item.Time || item.SlotTime || '',
      duration: parseInt(item.Duration) || 30,
      providerId: item.ProviderID,
      locationId: item.LocationID
    }));
  }

  /**
   * Escape XML special characters
   */
  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Get MCP tool definitions for appointment operations
   */
  getTools(): Tool[] {
    return [
      {
        name: 'unity_save_appointment',
        description: 'Create or update an appointment in Veradigm Practice Management via Unity API',
        inputSchema: {
          type: 'object',
          properties: {
            patientId: {
              type: 'string',
              description: 'Patient ID in the Veradigm system'
            },
            appointmentDate: {
              type: 'string',
              description: 'Appointment date in MM/DD/YYYY format'
            },
            appointmentTime: {
              type: 'string',
              description: 'Appointment time in HH:MM format (24-hour)'
            },
            duration: {
              type: 'number',
              description: 'Appointment duration in minutes'
            },
            providerId: {
              type: 'string',
              description: 'Provider/Practitioner ID (optional)'
            },
            locationId: {
              type: 'string',
              description: 'Location/Facility ID (optional)'
            },
            appointmentType: {
              type: 'string',
              description: 'Type of appointment (e.g., "Office Visit", "Follow-up")'
            },
            reasonForVisit: {
              type: 'string',
              description: 'Reason for the appointment'
            },
            notes: {
              type: 'string',
              description: 'Additional notes for the appointment'
            }
          },
          required: ['patientId', 'appointmentDate', 'appointmentTime', 'duration']
        }
      },
      {
        name: 'unity_cancel_appointment',
        description: 'Cancel an existing appointment in Veradigm Practice Management via Unity API',
        inputSchema: {
          type: 'object',
          properties: {
            appointmentId: {
              type: 'string',
              description: 'The appointment ID to cancel'
            },
            patientId: {
              type: 'string',
              description: 'Patient ID associated with the appointment'
            },
            cancellationReason: {
              type: 'string',
              description: 'Reason for cancellation (optional)'
            }
          },
          required: ['appointmentId', 'patientId']
        }
      },
      {
        name: 'unity_get_open_slots',
        description: 'Find available appointment slots in Veradigm Practice Management',
        inputSchema: {
          type: 'object',
          properties: {
            startDate: {
              type: 'string',
              description: 'Start date for slot search in MM/DD/YYYY format'
            },
            endDate: {
              type: 'string',
              description: 'End date for slot search in MM/DD/YYYY format'
            },
            providerId: {
              type: 'string',
              description: 'Filter by provider ID (optional)'
            },
            locationId: {
              type: 'string',
              description: 'Filter by location ID (optional)'
            },
            appointmentType: {
              type: 'string',
              description: 'Filter by appointment type (optional)'
            },
            duration: {
              type: 'number',
              description: 'Required slot duration in minutes (optional)'
            }
          },
          required: ['startDate', 'endDate']
        }
      },
      {
        name: 'unity_get_patient_appointments',
        description: 'Get appointments for a patient from Veradigm Practice Management',
        inputSchema: {
          type: 'object',
          properties: {
            patientId: {
              type: 'string',
              description: 'Patient ID to get appointments for'
            },
            startDate: {
              type: 'string',
              description: 'Start date filter in MM/DD/YYYY format (optional)'
            },
            endDate: {
              type: 'string',
              description: 'End date filter in MM/DD/YYYY format (optional)'
            },
            status: {
              type: 'string',
              description: 'Filter by appointment status (optional)'
            }
          },
          required: ['patientId']
        }
      }
    ];
  }
}

