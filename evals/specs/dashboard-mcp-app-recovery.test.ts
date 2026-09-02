import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { OpenworkServerError, type OpenworkMcpAppResource } from "../../apps/app/src/app/lib/openwork-server";
import { resolveDashboardMcpApp } from "../../apps/app/src/react-app/domains/dashboard/dashboard-mcp-app-resolution";

const app: OpenworkMcpAppResource = {
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
};

test("dashboard MCP App discovery recovers without repeating the launch tool", async ({ evidence }) => {
  let resolutionAttempts = 0;
  let launchCalls = 0;
  const waits: number[] = [];
  const endpoint = {
    workspaceId: "workspace-1",
    client: {
      resolveMcpApp: async () => {
        resolutionAttempts += 1;
        if (resolutionAttempts < 3) {
          throw new OpenworkServerError(503, "mcp_unreachable", "connection still loading");
        }
        return { app };
      },
      callMcpAppTool: async () => {
        launchCalls += 1;
      },
    },
  };

  const resolved = await resolveDashboardMcpApp({
    endpoints: [endpoint],
    projectedToolName: "budget_allocator_get_budget_data",
    wait: async (delayMs) => { waits.push(delayMs); },
  });

  expect(resolved).toEqual({ endpoint, app });
  expect(resolutionAttempts).toBe(3);
  expect(waits).toEqual([1_000, 3_000]);
  expect(launchCalls).toBe(0);
  evidence.recordAssertionEvidence(
    "Dashboard MCP App discovery retries temporary connection failures without repeating the app tool",
    `resolutionAttempts=${resolutionAttempts}; waits=${waits.join(",")}; launchCalls=${launchCalls}`,
    resolutionAttempts === 3 && waits.join(",") === "1000,3000" && launchCalls === 0,
  );
});
