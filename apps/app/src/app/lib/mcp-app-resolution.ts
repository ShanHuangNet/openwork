import { OpenworkServerError } from "./openwork-server"

const TRANSIENT_MCP_APP_RESOLUTION_CODES = new Set(["server_unavailable", "mcp_unreachable"])

/** Backoff between automatic resolution attempts for transient failures. */
export const MCP_APP_RESOLUTION_RETRY_DELAYS_MS = [1_000, 3_000]

/**
 * Returns the delay before the next automatic resolution attempt, or null when
 * the failure is deterministic or the retry budget is exhausted.
 */
export function mcpAppResolutionRetryDelayMs(cause: unknown, attemptIndex: number): number | null {
  if (!(cause instanceof OpenworkServerError) || !TRANSIENT_MCP_APP_RESOLUTION_CODES.has(cause.code)) return null
  return MCP_APP_RESOLUTION_RETRY_DELAYS_MS[attemptIndex] ?? null
}
