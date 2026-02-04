import axios, { AxiosResponse } from 'axios';
import { unityConfig } from '../config/environment';
import { unityEndpoints, UnityTargetSystem } from '../config/unity-endpoints';
import { UnityAuthService } from './unity-auth.service';

/**
 * Unity Magic Request Parameters
 */
export interface UnityMagicRequest {
  Action: string;
  AppUserID?: string;
  Appname?: string;
  PatientID?: string;
  Token?: string;
  Parameter1?: string;
  Parameter2?: string;
  Parameter3?: string;
  Parameter4?: string;
  Parameter5?: string;
  Parameter6?: string;
  Data?: string; // Base64 encoded binary data
}

/**
 * Unity Magic Response
 */
export interface UnityMagicResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  rawResponse?: any;
}

/**
 * Unity API Error
 */
export class UnityAPIError extends Error {
  code: string;
  details?: any;
  timestamp: string;

  constructor(message: string, code: string, details?: any) {
    super(message);
    this.name = 'UnityAPIError';
    this.code = code;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }
}

/**
 * Unity Service
 * 
 * Wrapper for Unity MagicJson API calls.
 * Handles authentication, request formatting, and response parsing.
 */
export class UnityService {
  private authService: UnityAuthService;
  private currentTarget: UnityTargetSystem = 'EHR';

  constructor(authService: UnityAuthService) {
    this.authService = authService;
  }

  /**
   * Set the target system for subsequent calls
   */
  setTarget(target: UnityTargetSystem): void {
    this.currentTarget = target;
  }

  /**
   * Get the current target system
   */
  getTarget(): UnityTargetSystem {
    return this.currentTarget;
  }

  /**
   * Execute a Unity Magic action
   * 
   * @param action - The Unity action name (e.g., 'SaveAppointment')
   * @param params - Action-specific parameters
   * @param patientId - Optional patient ID
   * @param target - Target system (PM or EHR), defaults to current target
   */
  async executeAction<T = any>(
    action: string,
    params: {
      Parameter1?: string;
      Parameter2?: string;
      Parameter3?: string;
      Parameter4?: string;
      Parameter5?: string;
      Parameter6?: string;
      Data?: string;
    } = {},
    patientId: string = '',
    target?: UnityTargetSystem
  ): Promise<UnityMagicResponse<T>> {
    const targetSystem = target || this.currentTarget;
    
    try {
      // Get authenticated session
      const { token } = await this.authService.getAuthenticatedSession(targetSystem);
      
      // Build the Magic request
      // Note: Data field must always be present (even if empty string) for MagicJson to work
      const request: UnityMagicRequest = {
        Action: action,
        Appname: unityConfig.appName,
        AppUserID: unityConfig.ehrUsername,
        PatientID: patientId,
        Token: token,
        Parameter1: params.Parameter1 || '',
        Parameter2: params.Parameter2 || '',
        Parameter3: params.Parameter3 || '',
        Parameter4: params.Parameter4 || '',
        Parameter5: params.Parameter5 || '',
        Parameter6: params.Parameter6 || '',
        Data: params.Data || '' // Required field - must be present
      };

      console.error(`[Unity Service] Executing action: ${action}`);
      console.error(`[Unity Service] Target: ${targetSystem}, PatientID: ${patientId || 'N/A'}`);

      // Execute the request
      const response = await this.sendMagicRequest(request);
      
      return this.parseResponse<T>(response);
    } catch (error) {
      console.error(`[Unity Service] Action ${action} failed:`, error);
      throw this.handleError(error, action);
    }
  }

  /**
   * Send a Magic request to Unity
   */
  private async sendMagicRequest(request: UnityMagicRequest): Promise<any> {
    const response: AxiosResponse = await axios.post(
      unityEndpoints.magicJson,
      request,
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 30000 // 30 second timeout
      }
    );

    return response.data;
  }

  /**
   * Parse Unity response
   */
  private parseResponse<T>(data: any): UnityMagicResponse<T> {
    // Check for error in response
    if (data?.Error) {
      return {
        success: false,
        error: data.Error,
        rawResponse: data
      };
    }

    // Check for Magic Error format
    if (typeof data === 'string' && data.includes('Magic Error')) {
      return {
        success: false,
        error: data,
        rawResponse: data
      };
    }

    // Unity often returns data in different formats
    // Try to extract meaningful data
    let parsedData: T | undefined;
    
    if (Array.isArray(data)) {
      // Array response - could be table data
      parsedData = data as unknown as T;
    } else if (data?.Table || data?.Results) {
      // Common Unity response wrappers
      parsedData = (data.Table || data.Results) as T;
    } else if (data?.GetPatientResult ?? data?.getpatientresult) {
      // GetPatient / GetPatientFull often return { GetPatientResult: { PatientID, FirstName, ... } }
      parsedData = (data.GetPatientResult ?? data.getpatientresult) as T;
    } else if (typeof data === 'object') {
      parsedData = data as T;
    }

    return {
      success: true,
      data: parsedData,
      rawResponse: data
    };
  }

  /**
   * Handle and transform errors
   */
  private handleError(error: any, action: string): UnityAPIError {
    if (error instanceof UnityAPIError) {
      return error;
    }

    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const data = error.response?.data;

      switch (status) {
        case 401:
          return new UnityAPIError(
            'Unity authentication failed: Invalid or expired token',
            'AUTH_ERROR',
            data
          );
        case 403:
          return new UnityAPIError(
            'Unity access forbidden: Insufficient permissions',
            'FORBIDDEN',
            data
          );
        case 404:
          return new UnityAPIError(
            `Unity action not found: ${action}`,
            'NOT_FOUND',
            data
          );
        case 500:
          // Parse Unity server error
          const errorMsg = data?.Error || data?.message || 'Internal server error';
          return new UnityAPIError(
            `Unity server error: ${errorMsg}`,
            'SERVER_ERROR',
            data
          );
        default:
          return new UnityAPIError(
            `Unity API error (${status}): ${JSON.stringify(data)}`,
            'API_ERROR',
            data
          );
      }
    }

    return new UnityAPIError(
      error.message || 'Unknown Unity error',
      'UNKNOWN_ERROR',
      error
    );
  }

  // ============================================
  // Convenience methods for common operations
  // ============================================

  /**
   * Test connection using Echo action
   */
  async testConnection(target?: UnityTargetSystem): Promise<boolean> {
    try {
      const response = await this.executeAction('Echo', {
        Parameter1: 'ConnectionTest',
        Parameter2: new Date().toISOString()
      }, '', target);
      
      return response.success;
    } catch {
      return false;
    }
  }

  /**
   * Get server information
   */
  async getServerInfo(target?: UnityTargetSystem): Promise<UnityMagicResponse> {
    return this.executeAction('GetServerInfo', {}, '', target);
  }

  /**
   * Search for patients
   */
  async searchPatients(
    searchCriteria: {
      lastName?: string;
      firstName?: string;
      dob?: string;
      mrn?: string;
    },
    target?: UnityTargetSystem
  ): Promise<UnityMagicResponse> {
    // Build XML search criteria for SearchPatients action
    const xmlCriteria = this.buildPatientSearchXml(searchCriteria);
    
    return this.executeAction('SearchPatients', {
      Parameter1: xmlCriteria
    }, '', target);
  }

  /**
   * Build XML search criteria for patient search
   */
  private buildPatientSearchXml(criteria: {
    lastName?: string;
    firstName?: string;
    dob?: string;
    mrn?: string;
  }): string {
    let xml = '<searchcriteria>';
    
    if (criteria.lastName) {
      xml += `<LastName>${this.escapeXml(criteria.lastName)}</LastName>`;
    }
    if (criteria.firstName) {
      xml += `<FirstName>${this.escapeXml(criteria.firstName)}</FirstName>`;
    }
    if (criteria.dob) {
      xml += `<DOB>${this.escapeXml(criteria.dob)}</DOB>`;
    }
    if (criteria.mrn) {
      xml += `<MRN>${this.escapeXml(criteria.mrn)}</MRN>`;
    }
    
    xml += '</searchcriteria>';
    return xml;
  }

  /**
   * Get patient by ID
   */
  async getPatient(
    patientId: string,
    includePicture: boolean = false,
    target?: UnityTargetSystem
  ): Promise<UnityMagicResponse> {
    return this.executeAction('GetPatient', {
      Parameter1: includePicture ? 'Y' : 'N'
    }, patientId, target);
  }

  /**
   * Get patient full demographics
   */
  async getPatientFull(
    patientId: string,
    mrn?: string,
    target?: UnityTargetSystem
  ): Promise<UnityMagicResponse> {
    return this.executeAction('GetPatientFull', {
      Parameter1: mrn || '',
      Parameter2: '' // Organization
    }, patientId, target);
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
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    try {
      // Retire tokens for both targets
      const targets: UnityTargetSystem[] = ['PM', 'EHR'];
      
      for (const target of targets) {
        if (this.authService.isTokenCached(target)) {
          const token = await this.authService.getSecurityToken(target);
          await this.authService.retireToken(token, target);
        }
      }
    } catch (error) {
      console.error('[Unity Service] Cleanup error:', error);
    }
  }
}

