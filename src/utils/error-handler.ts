export interface ErrorDetails {
  code: string;
  message: string;
  details?: any;
  timestamp: string;
}

export class FHIRMCPError extends Error {
  public readonly code: string;
  public readonly details?: any;
  public readonly timestamp: string;

  constructor(code: string, message: string, details?: any) {
    super(message);
    this.name = 'FHIRMCPError';
    this.code = code;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }

  toJSON(): ErrorDetails {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      timestamp: this.timestamp
    };
  }
}

export class ErrorHandler {
  /**
   * Create a standardized error for authentication failures
   */
  static createAuthError(message: string, details?: any): FHIRMCPError {
    return new FHIRMCPError('AUTH_ERROR', message, details);
  }

  /**
   * Create a standardized error for FHIR API failures
   */
  static createFHIRError(message: string, details?: any): FHIRMCPError {
    return new FHIRMCPError('FHIR_ERROR', message, details);
  }

  /**
   * Create a standardized error for validation failures
   */
  static createValidationError(message: string, details?: any): FHIRMCPError {
    return new FHIRMCPError('VALIDATION_ERROR', message, details);
  }

  /**
   * Create a standardized error for resource not found
   */
  static createNotFoundError(resourceType: string, id?: string): FHIRMCPError {
    const message = id 
      ? `${resourceType} with ID '${id}' not found`
      : `${resourceType} not found`;
    return new FHIRMCPError('NOT_FOUND', message, { resourceType, id });
  }

  /**
   * Create a standardized error for rate limiting
   */
  static createRateLimitError(retryAfter?: number): FHIRMCPError {
    const message = 'Rate limit exceeded. Please try again later.';
    const details = retryAfter ? { retryAfter } : undefined;
    return new FHIRMCPError('RATE_LIMIT', message, details);
  }

  /**
   * Create a standardized error for network issues
   */
  static createNetworkError(message: string, details?: any): FHIRMCPError {
    return new FHIRMCPError('NETWORK_ERROR', message, details);
  }

  /**
   * Handle and wrap unknown errors
   */
  static handleUnknownError(error: any): FHIRMCPError {
    if (error instanceof FHIRMCPError) {
      return error;
    }

    const message = error?.message || 'An unknown error occurred';
    const details = {
      originalError: error?.toString(),
      stack: error?.stack
    };

    return new FHIRMCPError('UNKNOWN_ERROR', message, details);
  }

  /**
   * Log error with appropriate level
   */
  static logError(error: FHIRMCPError, context?: string): void {
    const logMessage = context 
      ? `[${context}] ${error.code}: ${error.message}`
      : `${error.code}: ${error.message}`;

    if (error.code === 'AUTH_ERROR' || error.code === 'FHIR_ERROR') {
      console.error(logMessage, error.details);
    } else {
      console.warn(logMessage, error.details);
    }
  }

  /**
   * Check if error is retryable
   */
  static isRetryableError(error: FHIRMCPError): boolean {
    const retryableCodes = ['NETWORK_ERROR', 'RATE_LIMIT', 'FHIR_ERROR'];
    return retryableCodes.includes(error.code);
  }

  /**
   * Get retry delay for retryable errors
   */
  static getRetryDelay(error: FHIRMCPError): number {
    switch (error.code) {
      case 'RATE_LIMIT':
        return error.details?.retryAfter || 60; // Default 1 minute
      case 'NETWORK_ERROR':
        return 5; // 5 seconds
      case 'FHIR_ERROR':
        return 2; // 2 seconds
      default:
        return 0;
    }
  }
}

