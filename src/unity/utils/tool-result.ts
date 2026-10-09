import { UnityMCPError, UnityErrorHandler } from './error-handler';

/**
 * Structured failure returned to the voice agent instead of an empty list.
 *
 * Rule (CLAUDE.md #5): a tool must never answer "none found" when the Veradigm call failed.
 * The agent prompt maps success:false to "I'm having trouble pulling that up right now."
 */
export interface ToolFailure {
  success: false;
  error_code: string;
  retryable: boolean;
  tool: string;
  message: string;
}

const RETRYABLE = new Set(['NETWORK_ERROR', 'TIMEOUT_ERROR', 'SERVER_ERROR', 'AUTH_ERROR']);

export function toToolFailure(error: unknown, tool: string): ToolFailure {
  const e: UnityMCPError =
    error instanceof UnityMCPError ? error : UnityErrorHandler.handleUnknownError(error, tool);
  return {
    success: false,
    error_code: e.code,
    retryable: RETRYABLE.has(e.code),
    tool,
    // Internal detail for logs only; never read to the caller.
    message: e.message,
  };
}

export function isToolFailure(r: unknown): r is ToolFailure {
  return !!r && typeof r === 'object' && (r as any).success === false && typeof (r as any).error_code === 'string';
}
