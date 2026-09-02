import { mcpAppResolutionRetryDelayMs } from "@/app/lib/mcp-app-resolution"
import type {
  OpenworkMcpAppLaunchReference,
  OpenworkMcpAppResource,
  OpenworkServerClient,
} from "@/app/lib/openwork-server"

/** A workspace MCP runtime a dashboard tile may launch through. */
export type DashboardLaunchEndpoint = {
  client: OpenworkServerClient
  workspaceId: string
}

type McpAppResolutionEndpoint = {
  client: Pick<OpenworkServerClient, "resolveMcpApp">
  workspaceId: string
}

type ResolveDashboardMcpAppOptions<TEndpoint extends McpAppResolutionEndpoint> = {
  endpoints: TEndpoint[]
  projectedToolName: string
  launch?: OpenworkMcpAppLaunchReference
  wait?: (delayMs: number) => Promise<void>
}

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

/**
 * Resolves dashboard app HTML across connected workspaces, retrying only
 * temporary discovery failures. This function never calls the app's tool.
 */
export async function resolveDashboardMcpApp<TEndpoint extends McpAppResolutionEndpoint>({
  endpoints,
  projectedToolName,
  launch,
  wait = waitForRetry,
}: ResolveDashboardMcpAppOptions<TEndpoint>): Promise<{ endpoint: TEndpoint; app: OpenworkMcpAppResource } | null> {
  let attemptIndex = 0
  while (true) {
    let resolveFailure: unknown = null
    for (const endpoint of endpoints) {
      try {
        const { app } = await endpoint.client.resolveMcpApp(endpoint.workspaceId, projectedToolName, launch)
        if (app) return { endpoint, app }
      } catch (cause) {
        resolveFailure ??= cause
      }
    }
    if (!resolveFailure) return null
    const retryDelayMs = mcpAppResolutionRetryDelayMs(resolveFailure, attemptIndex)
    if (retryDelayMs === null) throw resolveFailure
    await wait(retryDelayMs)
    attemptIndex += 1
  }
}
