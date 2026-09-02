import { describe, expect, test } from "bun:test"

import { OpenworkServerError, type OpenworkMcpAppResource } from "../src/app/lib/openwork-server"
import { resolveDashboardMcpApp } from "../src/react-app/domains/dashboard/dashboard-mcp-app-resolution"

const APP: OpenworkMcpAppResource = {
  serverName: "budget-allocator",
  toolName: "get-budget-data",
  resourceUri: "ui://budget-allocator/mcp-app.html",
  html: "<!doctype html><html><body>Budget allocator</body></html>",
  csp: {
    connectDomains: [],
    resourceDomains: [],
    frameDomains: [],
    baseUriDomains: [],
  },
  prefersBorder: true,
}

describe("dashboard MCP App resolution", () => {
  test("recovers after transient discovery failures without invoking the app tool", async () => {
    let resolutionAttempts = 0
    let launchCalls = 0
    const waits: number[] = []
    const endpoint = {
      workspaceId: "workspace-1",
      client: {
        resolveMcpApp: async () => {
          resolutionAttempts += 1
          if (resolutionAttempts < 3) {
            throw new OpenworkServerError(503, "mcp_unreachable", "connection still loading")
          }
          return { app: APP }
        },
        callMcpAppTool: async () => {
          launchCalls += 1
        },
      },
    }

    const resolved = await resolveDashboardMcpApp({
      endpoints: [endpoint],
      projectedToolName: "budget_allocator_get_budget_data",
      wait: async (delayMs) => { waits.push(delayMs) },
    })

    expect(resolved).toEqual({ endpoint, app: APP })
    expect(resolutionAttempts).toBe(3)
    expect(waits).toEqual([1_000, 3_000])
    expect(launchCalls).toBe(0)
  })

  test("does not retry deterministic resource failures", async () => {
    let resolutionAttempts = 0
    let waitCalls = 0
    const failure = new OpenworkServerError(422, "tool_resource_mismatch", "resource moved")

    const resolving = resolveDashboardMcpApp({
      endpoints: [{
        workspaceId: "workspace-1",
        client: {
          resolveMcpApp: async () => {
            resolutionAttempts += 1
            throw failure
          },
        },
      }],
      projectedToolName: "budget_allocator_get_budget_data",
      wait: async () => { waitCalls += 1 },
    })

    await expect(resolving).rejects.toBe(failure)
    expect(resolutionAttempts).toBe(1)
    expect(waitCalls).toBe(0)
  })

  test("uses the next connected workspace before spending retry budget", async () => {
    let firstAttempts = 0
    let secondAttempts = 0
    const first = {
      workspaceId: "workspace-1",
      client: {
        resolveMcpApp: async () => {
          firstAttempts += 1
          throw new OpenworkServerError(503, "server_unavailable", "starting")
        },
      },
    }
    const second = {
      workspaceId: "workspace-2",
      client: {
        resolveMcpApp: async () => {
          secondAttempts += 1
          return { app: APP }
        },
      },
    }

    const resolved = await resolveDashboardMcpApp({
      endpoints: [first, second],
      projectedToolName: "budget_allocator_get_budget_data",
      wait: async () => { throw new Error("fallback resolution must not wait") },
    })

    expect(resolved).toEqual({ endpoint: second, app: APP })
    expect(firstAttempts).toBe(1)
    expect(secondAttempts).toBe(1)
  })
})
