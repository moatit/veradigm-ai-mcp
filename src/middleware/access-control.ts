import axios from 'axios'
import { Request, Response, NextFunction } from 'express'

interface ClientAccess {
  id: string
  name: string
  fhirAccess: boolean
  unityAccess: boolean
  isActive: boolean
}

interface ValidationResponse {
  valid: boolean
  client?: ClientAccess
  error?: string
}

// Cache client access info to avoid hitting Admin Portal on every request
const accessCache = new Map<string, { client: ClientAccess; expiresAt: number }>()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

/**
 * Access Control Middleware
 * 
 * Validates client API key and checks access permissions.
 * 
 * Headers required:
 * - x-api-key: Client's API key from Admin Portal
 * 
 * Optional headers:
 * - x-mcp-channel: Channel identifier (RETELL, APP, WEB, API)
 */
export class AccessControl {
  private adminUrl: string
  private enabled: boolean
  private bypassApiKey: string

  constructor() {
    this.adminUrl = process.env.ADMIN_PORTAL_URL || ''
    this.enabled = !!this.adminUrl
    this.bypassApiKey = '' // No bypass - every request must use a client key with correct permissions

    if (this.enabled) {
      console.log(`[AccessControl] Enabled - Validating against ${this.adminUrl}`)
    } else {
      console.log('[AccessControl] Disabled - No ADMIN_PORTAL_URL configured')
    }
  }

  /**
   * Validate client API key and get access permissions
   */
  async validateClient(apiKey: string): Promise<ValidationResponse> {
    // Check cache first
    const cached = accessCache.get(apiKey)
    if (cached && cached.expiresAt > Date.now()) {
      return { valid: true, client: cached.client }
    }

    try {
      const response = await axios.post(
        `${this.adminUrl}/api/clients/validate`,
        { apiKey },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 5000,
        }
      )

      if (response.data.valid && response.data.client) {
        // Cache the result
        accessCache.set(apiKey, {
          client: response.data.client,
          expiresAt: Date.now() + CACHE_TTL,
        })
        return response.data
      }

      return { valid: false, error: response.data.error || 'Invalid API key' }
    } catch (error: any) {
      console.error('[AccessControl] Validation failed:', error.message)
      // If Admin Portal is down, allow requests (fail-open for now)
      // In production, you might want to fail-closed
      return { valid: true, client: undefined }
    }
  }

  /**
   * Check if client has FHIR access
   */
  hasFhirAccess(client?: ClientAccess): boolean {
    if (!client) return true // Allow if no client info (fail-open)
    return client.fhirAccess && client.isActive
  }

  /**
   * Check if client has Unity access
   */
  hasUnityAccess(client?: ClientAccess): boolean {
    if (!client) return true // Allow if no client info (fail-open)
    return client.unityAccess && client.isActive
  }

  /**
   * Express middleware for FHIR endpoints
   */
  requireFhirAccess() {
    return async (req: Request, res: Response, next: NextFunction) => {
      if (!this.enabled) {
        return next()
      }

      const apiKey = req.headers['x-api-key'] as string

      if (!apiKey) {
        return res.status(401).json({
          error: 'API key required',
          message: 'Please provide x-api-key header',
        })
      }

      const validation = await this.validateClient(apiKey)

      if (!validation.valid) {
        return res.status(401).json({
          error: 'Invalid API key',
          message: validation.error,
        })
      }

      if (!this.hasFhirAccess(validation.client)) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'This client does not have FHIR access',
        })
      }

      // Attach client info to request for later use
      (req as any).clientInfo = validation.client
      next()
    }
  }

  /**
   * Express middleware for Unity endpoints
   */
  requireUnityAccess() {
    return async (req: Request, res: Response, next: NextFunction) => {
      if (!this.enabled) {
        return next()
      }

      const apiKey = req.headers['x-api-key'] as string

      if (!apiKey) {
        return res.status(401).json({
          error: 'API key required',
          message: 'Please provide x-api-key header',
        })
      }

      const validation = await this.validateClient(apiKey)

      if (!validation.valid) {
        return res.status(401).json({
          error: 'Invalid API key',
          message: validation.error,
        })
      }

      if (!this.hasUnityAccess(validation.client)) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'This client does not have Unity access',
        })
      }

      // Attach client info to request for later use
      (req as any).clientInfo = validation.client
      next()
    }
  }

  /**
   * Clear cache (useful for testing)
   */
  clearCache() {
    accessCache.clear()
  }
}

// Singleton instance
export const accessControl = new AccessControl()

/**
 * Tool categorization for access control
 */
export const FHIR_TOOLS = [
  'search_patient',
  'get_patient_details',
  'verify_patient_identity',
  'get_upcoming_appointments',
  'get_appointment_details',
  'check_appointment_status',
  'find_patient_next_appointment',
  'get_appointments_by_date_range',
  'get_patient_medications',
  'get_medication_requests',
  'check_refill_status',
  'get_medication_statements',
  'search_providers',
  'get_provider_details',
  'search_locations',
  'get_location_details',
  'get_patient_conditions',
  'get_allergies',
  'get_recent_observations',
  'get_patient_procedures',
  'get_patient_coverage',
]

export const UNITY_TOOLS = [
  'create_appointment',
  // Add more Unity write operations here
]

/**
 * Check if a tool requires FHIR access
 */
export function requiresFhirAccess(toolName: string): boolean {
  return FHIR_TOOLS.includes(toolName)
}

/**
 * Check if a tool requires Unity access
 */
export function requiresUnityAccess(toolName: string): boolean {
  return UNITY_TOOLS.includes(toolName)
}
