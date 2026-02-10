import axios from 'axios'
import dotenv from 'dotenv'

// Ensure env is loaded when this module is used (e.g. by Unity server before its config)
dotenv.config()

interface LogEntry {
  channel: string
  toolName: string
  requestTime: Date
  responseTime: number
  status: 'SUCCESS' | 'ERROR'
  errorMessage?: string
  metadata?: Record<string, any>
}

/**
 * Admin Portal Logger Middleware
 * 
 * This middleware sends call logs to the Veradigm Admin Portal
 * for monitoring and analytics.
 * 
 * Configuration:
 * - ADMIN_PORTAL_URL: URL of the admin portal API (e.g., http://localhost:3000)
 * - ADMIN_API_KEY: API key obtained from the admin portal client settings
 * - CHANNEL: The channel identifier (RETELL, APP, WEB, API)
 */
export class AdminLogger {
  private adminUrl: string
  private apiKey: string
  private channel: string
  private enabled: boolean

  constructor() {
    this.adminUrl = process.env.ADMIN_PORTAL_URL || ''
    this.apiKey = process.env.ADMIN_API_KEY || ''
    this.channel = process.env.MCP_CHANNEL || 'API'
    this.enabled = !!this.adminUrl

    if (this.enabled) {
      console.log(`[AdminLogger] Enabled - Logging to ${this.adminUrl}`)
    } else {
      console.log('[AdminLogger] Disabled - Missing ADMIN_PORTAL_URL')
    }
  }

  /**
   * Log a tool call to the admin portal.
   * Use clientApiKey (from request x-api-key) so logs are attributed to the right client.
   * Use server key (ADMIN_API_KEY) only when no client key (e.g. stdio).
   */
  async logToolCall(
    entry: Omit<LogEntry, 'channel'>,
    overrideChannel?: string,
    clientApiKey?: string
  ): Promise<void> {
    if (!this.enabled) return

    const keyToSend = clientApiKey || this.apiKey
    if (!keyToSend) return

    try {
      await axios.post(
        `${this.adminUrl}/api/logs`,
        {
          channel: overrideChannel || this.channel,
          ...entry,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': keyToSend,
          },
          timeout: 5000, // 5 second timeout to not block main process
        }
      )
    } catch (error: any) {
      // Don't fail the main process if logging fails
      const status = error?.response?.status
      const msg = error?.response?.data?.error || error?.message
      if (status === 401) {
        console.error('[AdminLogger] Log rejected (401 Invalid API key). Ensure ADMIN_API_KEY in .env matches an active Client API key in the admin panel.')
      } else {
        console.error('[AdminLogger] Failed to send log:', msg || error)
      }
    }
  }

  /**
   * Get default channel
   */
  getDefaultChannel(): string {
    return this.channel
  }

  /**
   * Create a wrapper function for tool handlers that automatically logs calls
   */
  wrapToolHandler<T extends (...args: any[]) => Promise<any>>(
    toolName: string,
    handler: T
  ): T {
    return (async (...args: any[]) => {
      const requestTime = new Date()
      const startTime = Date.now()

      try {
        const result = await handler(...args)
        const responseTime = Date.now() - startTime

        // Log successful call
        this.logToolCall({
          toolName,
          requestTime,
          responseTime,
          status: 'SUCCESS',
          metadata: { argsCount: args.length },
        })

        return result
      } catch (error) {
        const responseTime = Date.now() - startTime

        // Log failed call
        this.logToolCall({
          toolName,
          requestTime,
          responseTime,
          status: 'ERROR',
          errorMessage: error instanceof Error ? error.message : String(error),
        })

        throw error
      }
    }) as T
  }
}

// Singleton instance
export const adminLogger = new AdminLogger()

/**
 * Example usage in MCP server:
 * 
 * import { adminLogger } from './middleware/admin-logger'
 * 
 * // Option 1: Manual logging
 * const startTime = Date.now()
 * try {
 *   const result = await someToolFunction(args)
 *   adminLogger.logToolCall({
 *     toolName: 'some_tool',
 *     requestTime: new Date(startTime),
 *     responseTime: Date.now() - startTime,
 *     status: 'SUCCESS',
 *   })
 *   return result
 * } catch (error) {
 *   adminLogger.logToolCall({
 *     toolName: 'some_tool',
 *     requestTime: new Date(startTime),
 *     responseTime: Date.now() - startTime,
 *     status: 'ERROR',
 *     errorMessage: error.message,
 *   })
 *   throw error
 * }
 * 
 * // Option 2: Wrapper function
 * const wrappedHandler = adminLogger.wrapToolHandler('some_tool', someToolFunction)
 * const result = await wrappedHandler(args)
 */
