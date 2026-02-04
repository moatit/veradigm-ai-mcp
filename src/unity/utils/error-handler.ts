/**
 * Unity MCP Error Types
 */
export type UnityErrorCode = 
  | 'VALIDATION_ERROR'
  | 'AUTH_ERROR'
  | 'API_ERROR'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'SERVER_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT_ERROR'
  | 'UNKNOWN_ERROR';

/**
 * Unity MCP Error
 */
export class UnityMCPError extends Error {
  code: UnityErrorCode;
  details?: any;
  timestamp: string;
  action?: string;

  constructor(message: string, code: UnityErrorCode, details?: any, action?: string) {
    super(message);
    this.name = 'UnityMCPError';
    this.code = code;
    this.details = details;
    this.timestamp = new Date().toISOString();
    this.action = action;
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      details: this.details,
      action: this.action,
      timestamp: this.timestamp
    };
  }
}

/**
 * Error Handler Utility for Unity MCP Server
 */
export class UnityErrorHandler {
  /**
   * Create a validation error
   */
  static createValidationError(message: string, details?: any): UnityMCPError {
    return new UnityMCPError(message, 'VALIDATION_ERROR', details);
  }

  /**
   * Create an authentication error
   */
  static createAuthError(message: string, details?: any): UnityMCPError {
    return new UnityMCPError(message, 'AUTH_ERROR', details);
  }

  /**
   * Create an API error
   */
  static createAPIError(message: string, action?: string, details?: any): UnityMCPError {
    return new UnityMCPError(message, 'API_ERROR', details, action);
  }

  /**
   * Create a not found error
   */
  static createNotFoundError(message: string, details?: any): UnityMCPError {
    return new UnityMCPError(message, 'NOT_FOUND', details);
  }

  /**
   * Handle unknown errors and convert to UnityMCPError
   */
  static handleUnknownError(error: any, action?: string): UnityMCPError {
    if (error instanceof UnityMCPError) {
      return error;
    }

    // Check for common error types
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return new UnityMCPError(
        'Unable to connect to Unity server',
        'NETWORK_ERROR',
        { originalError: error.message },
        action
      );
    }

    if (error.code === 'ETIMEDOUT' || error.code === 'TIMEOUT') {
      return new UnityMCPError(
        'Unity request timed out',
        'TIMEOUT_ERROR',
        { originalError: error.message },
        action
      );
    }

    // Handle axios errors
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;
      
      switch (status) {
        case 401:
          return new UnityMCPError(
            'Authentication failed',
            'AUTH_ERROR',
            data,
            action
          );
        case 403:
          return new UnityMCPError(
            'Access forbidden',
            'FORBIDDEN',
            data,
            action
          );
        case 404:
          return new UnityMCPError(
            'Resource not found',
            'NOT_FOUND',
            data,
            action
          );
        case 500:
          return new UnityMCPError(
            data?.Error || 'Server error',
            'SERVER_ERROR',
            data,
            action
          );
        default:
          return new UnityMCPError(
            `API error (${status})`,
            'API_ERROR',
            data,
            action
          );
      }
    }

    // Generic error
    return new UnityMCPError(
      error.message || 'Unknown error occurred',
      'UNKNOWN_ERROR',
      { originalError: String(error) },
      action
    );
  }

  /**
   * Log error with context
   */
  static logError(error: UnityMCPError, context?: string): void {
    const logPrefix = context ? `[Unity ${context}]` : '[Unity]';
    
    console.error(`${logPrefix} Error: ${error.code}`);
    console.error(`${logPrefix} Message: ${error.message}`);
    
    if (error.action) {
      console.error(`${logPrefix} Action: ${error.action}`);
    }
    
    if (error.details) {
      console.error(`${logPrefix} Details:`, JSON.stringify(error.details, null, 2));
    }
  }
}

