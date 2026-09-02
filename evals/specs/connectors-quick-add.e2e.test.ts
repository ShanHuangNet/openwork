import { expect } from "vitest";
import { evalIn, waitFor } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import { screenshot, validate } from "@openwork/test-evidence";
import { chrome } from "@openwork/hosts";
import { mcpMock, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `connectors quick add skipped — needs: ${missingRequirements.join(", ")}`
  : "an admin lands on popular connectors, resolves a pasted MCP URL, and finds the new connection under Configured";

const smartBarSelector = '[data-testid="connector-smart-bar"]';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function replaceSmartBarText(browser: Surface, value: string): Promise<void> {
  await waitFor(browser, `Boolean(document.querySelector(${JSON.stringify(smartBarSelector)}))`, {
    timeoutMs: 30_000,
    label: "connector smart bar input",
  });
  const replaced = await evalIn(browser, `(() => {
    const input = document.querySelector(${JSON.stringify(smartBarSelector)});
    if (!(input instanceof HTMLInputElement)) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) return null;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input.value;
  })()`);
  expect(replaced).toBe(value);
  await waitFor(browser, `document.querySelector(${JSON.stringify(smartBarSelector)})?.value === ${JSON.stringify(value)}`, {
    timeoutMs: 10_000,
    label: `connector smart bar value ${JSON.stringify(value)}`,
  });
}

test(title, async ({ evidence, place }) => {
  needs(requirements);
  await using den = await server({
    place,
    org: {
      name: `Connectors Quick Add Eval ${Date.now()}`,
      admin: { name: "Sarah" },
    },
    mocks: { connector: mcpMock() },
  });
  const connector = den.mocks.connector;

  await using browser = await chrome({
    name: "connectors-quick-add",
    startUrl: den.ref.webUrl,
    headless: true,
    host: place.host(),
  });
  await browser.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(browser, `location.href.startsWith(${JSON.stringify(den.ref.webUrl)}) && document.readyState === "complete"`, {
    timeoutMs: 60_000,
    label: "Den Web origin before admin auth token handoff",
  });
  const tokenStored = await evalIn(browser, `(() => {
    localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(den.admin.token)});
    return localStorage.getItem("openwork:web:auth-token") === ${JSON.stringify(den.admin.token)};
  })()`);
  expect(tokenStored).toBe(true);

  await navigate(browser.client, `${den.ref.webUrl}/dashboard/mcp-connections`);
  await waitFor(browser, `(() => {
    const popularRows = document.querySelectorAll('[data-testid="popular-connectors"] [data-testid^="connector-row-"]');
    return location.pathname === "/dashboard/mcp-connections"
      && Boolean(document.querySelector('[data-testid="connector-smart-bar"]'))
      && Boolean(document.querySelector('[data-testid="connector-catalog"]'))
      && Boolean(document.querySelector('[data-testid="configured-connectors-link"]'))
      && popularRows.length === 6
      && Boolean(document.querySelector('[data-testid="connector-add-github"]'))
      && document.querySelector('[data-testid="connector-catalog-more"]') instanceof HTMLButtonElement
      && !document.querySelector('[data-testid="more-connectors"]');
  })()`, {
    timeoutMs: 60_000,
    label: "connector catalog: smart bar, Configured link, six popular rows, collapsed More",
  });

  const smartBarPresent = await evalIn(browser, `Boolean(document.querySelector('[data-testid="connector-smart-bar"]'))`);
  const standaloneAddMcpMissing = await evalIn(browser, `![...document.querySelectorAll("button, a")]
    .some((entry) => (entry.textContent ?? "").trim() === "Add MCP")`);
  expect(smartBarPresent).toBe(true);
  expect(standaloneAddMcpMissing).toBe(true);
  evidence.recordAssertionEvidence(
    "Connectors opens with one smart search-or-paste bar and no standalone Add MCP action",
    `Smart bar present: ${String(smartBarPresent)}; standalone Add MCP absent: ${String(standaloneAddMcpMissing)}.`,
    smartBarPresent === true && standaloneAddMcpMissing === true,
  );

  const popularOrder = await evalIn(browser, `[...document.querySelectorAll('[data-testid="popular-connectors"] [data-testid^="connector-row-"]')]
    .map((row) => row.getAttribute("data-testid").replace("connector-row-", ""))`);
  const configuredListBeforeAdd = await evalIn(browser, `(() => {
    const strip = document.querySelector('[data-testid="configured-connector-strip"]');
    return {
      present: Boolean(strip),
      rows: document.querySelectorAll('[data-testid^="mcp-connection-row-"]').length,
      links: strip ? strip.querySelectorAll('a[href*="connectionId="]').length : -1,
    };
  })()`);
  expect(popularOrder).toEqual(["gmail", "github", "google-drive", "google-calendar", "notion", "slack"]);
  expect(configuredListBeforeAdd).toEqual({ present: true, rows: 0, links: 0 });
  evidence.recordAssertionEvidence(
    "Popular lists Gmail, GitHub, Google Drive, Google Calendar, Notion, and Slack ahead of the configured list, which lives on its own page",
    `Popular order: ${JSON.stringify(popularOrder)}; configured strip state: ${JSON.stringify(configuredListBeforeAdd)}.`,
    Array.isArray(popularOrder) && popularOrder.length === 6,
  );

  const expandedMore = await evalIn(browser, `(() => {
    const more = document.querySelector('[data-testid="connector-catalog-more"]');
    if (!(more instanceof HTMLButtonElement) || !(more.textContent ?? "").includes("See Outlook Email, Granola, and more")) return false;
    more.click();
    return true;
  })()`);
  expect(expandedMore).toBe(true);
  await waitFor(browser, `(() => {
    const more = document.querySelector('[data-testid="more-connectors"]');
    return Boolean(more)
      && Boolean(more.querySelector('[data-testid="connector-row-microsoft-365"]'))
      && more.querySelectorAll('[data-testid^="connector-row-"]').length === 9
      && Boolean(document.querySelector('[data-testid="connector-add-context7"]'))
      && Boolean(document.querySelector('[data-testid="connector-add-exa"]'))
      && !document.querySelector('[data-testid="connector-catalog-more"]');
  })()`, {
    timeoutMs: 20_000,
    label: "More connectors: Microsoft 365 plus the eight remaining curated MCP presets",
  });
  const moreRows = await evalIn(browser, `[...document.querySelectorAll('[data-testid="more-connectors"] [data-testid^="connector-row-"]')]
    .map((row) => row.getAttribute("data-testid").replace("connector-row-", ""))`);
  expect(moreRows).toEqual(["microsoft-365", "linear", "stripe", "sentry", "granola", "polar", "exa", "render", "context7"]);
  evidence.recordAssertionEvidence(
    "See Outlook Email, Granola, and more reveals Microsoft 365 and every curated MCP preset not already in Popular",
    `More rows: ${JSON.stringify(moreRows)}.`,
    Array.isArray(moreRows) && moreRows.length === 9,
  );
  // Context7's Instant mechanism is covered without clicking it here: doing so
  // would contact the real mcp.context7.com rather than this spec's witness.

  await sleep(500);
  {
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      "The Connectors page shows one smart search-or-paste bar with a round plus button beside it",
      "A Configured heading with a chevron sits above a Popular section of two-column rows with icons, names, descriptions, and plus buttons",
      "Rows include Gmail, GitHub, Google Drive, Google Calendar, Notion, and Slack",
      "A More connectors section lists Microsoft 365 and additional MCP servers",
      "No standalone Add MCP button or error banner is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  await replaceSmartBarText(browser, "sla");
  await waitFor(browser, `(() => {
    const rows = document.querySelectorAll('[data-testid^="connector-row-"]');
    return rows.length === 1
      && Boolean(document.querySelector('[data-testid="connector-row-slack"]'))
      && !document.querySelector('[data-testid="connector-row-notion"]')
      && !document.querySelector('[data-testid="configured-connector-strip"]');
  })()`, {
    timeoutMs: 20_000,
    label: "live Slack-only catalog filter with Notion and the Configured strip absent",
  });
  const slackOnly = await evalIn(browser, `document.querySelectorAll('[data-testid^="connector-row-"]').length === 1
    && Boolean(document.querySelector('[data-testid="connector-row-slack"]'))`);
  const notionAbsent = await evalIn(browser, `!document.querySelector('[data-testid="connector-row-notion"]')`);
  expect(slackOnly).toBe(true);
  expect(notionAbsent).toBe(true);
  evidence.recordAssertionEvidence(
    "Typing sla narrows the catalog to Slack and removes Notion",
    `Slack was the only row: ${String(slackOnly)}; Notion absent: ${String(notionAbsent)}.`,
    slackOnly === true && notionAbsent === true,
  );

  await replaceSmartBarText(browser, "");
  await waitFor(browser, `document.querySelectorAll('[data-testid="popular-connectors"] [data-testid^="connector-row-"]').length === 6
    && Boolean(document.querySelector('[data-testid="configured-connector-strip"]'))`, {
    timeoutMs: 20_000,
    label: "full popular list and Configured strip after clearing the smart bar",
  });

  const witnessStartedAt = new Date().toISOString();
  await replaceSmartBarText(browser, connector.mcpUrl);
  await waitFor(browser, `(() => {
    const card = document.querySelector('[data-testid="smart-bar-result-card"]');
    const submit = document.querySelector('[data-testid="smart-bar-submit"]');
    const text = card?.textContent ?? "";
    return Boolean(card)
      && text.includes("OAuth sign-in")
      && text.includes("Ready to add")
      && text.includes("Options")
      && text.includes("Add connection")
      && submit instanceof HTMLButtonElement
      && !submit.disabled;
  })()`, {
    timeoutMs: 60_000,
    label: "inline ready-to-add result for the mock MCP URL",
  });
  const inlineReady = await evalIn(browser, `(() => {
    const card = document.querySelector('[data-testid="smart-bar-result-card"]');
    const submit = document.querySelector('[data-testid="smart-bar-submit"]');
    return (card?.textContent ?? "").includes("Ready to add")
      && submit instanceof HTMLButtonElement
      && !submit.disabled;
  })()`);
  expect(inlineReady).toBe(true);
  evidence.recordAssertionEvidence(
    "The pasted mock MCP URL resolves inline as ready to add",
    "The result card showed OAuth sign-in, Ready to add, Options, and an enabled Add connection action.",
    inlineReady === true,
  );

  await sleep(500);
  {
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      "An inline card directly below the smart bar shows the resolved mock MCP server",
      "The card shows OAuth sign-in and Ready to add pills with Options and Add connection actions",
      "The connector catalog rows remain visible below the inline result instead of being replaced by a modal",
      "No error banner or modal covers the page",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  const submitted = await evalIn(browser, `(() => {
    const button = document.querySelector('[data-testid="smart-bar-submit"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  expect(submitted).toBe(true);
  await waitFor(browser, `(() => {
    const strip = document.querySelector('[data-testid="configured-connector-strip"]');
    const notice = [...document.querySelectorAll('[role="status"]')]
      .find((entry) => (entry.textContent ?? "").includes("added for everyone"));
    return Boolean(strip && notice)
      && strip.querySelectorAll('a[href*="connectionId="]').length === 1
      && document.querySelectorAll('[data-testid="popular-connectors"] [data-testid^="connector-row-"]').length === 6
      && document.querySelectorAll('[data-testid^="mcp-connection-row-"]').length === 0;
  })()`, {
    timeoutMs: 60_000,
    label: "success notice, one Configured strip icon, unchanged popular rows, and no inline connection list",
  });

  const configuredHref = await evalIn(browser, `document.querySelector('[data-testid="configured-connector-strip"] a[href*="connectionId="]')?.getAttribute("href") ?? ""`);
  const popularAfterAdd = await evalIn(browser, `document.querySelectorAll('[data-testid="popular-connectors"] [data-testid^="connector-row-"]').length`);
  expect(typeof configuredHref).toBe("string");
  expect(configuredHref).toMatch(/^\/dashboard\/mcp-connections\/configured\?connectionId=/);
  expect(popularAfterAdd).toBe(6);
  // This mock connection uses a custom URL, so no popular row should flip to
  // its options menu. Configured/options row mechanics have focused Bun
  // coverage; this app spec scopes the frame to the strip plus the popular list.
  evidence.recordAssertionEvidence(
    "Add connection puts the new connection in the Configured strip without disturbing the popular rows",
    `Configured strip link: ${String(configuredHref)}; popular rows: ${String(popularAfterAdd)}.`,
    typeof configuredHref === "string"
      && configuredHref.startsWith("/dashboard/mcp-connections/configured?connectionId=")
      && popularAfterAdd === 6,
  );

  await navigate(browser.client, `${den.ref.webUrl}${String(configuredHref)}`);
  await waitFor(browser, `(() => {
    const row = [...document.querySelectorAll('[data-testid^="mcp-connection-row-"]')]
      .find((entry) => (entry.textContent ?? "").includes(${JSON.stringify(connector.mcpUrl)}));
    return location.pathname === "/dashboard/mcp-connections/configured"
      && Boolean(row)
      && Boolean(document.querySelector('[data-testid="configured-add-connector"]'))
      && !document.querySelector('[data-testid="connector-catalog"]');
  })()`, {
    timeoutMs: 60_000,
    label: "configured page with the created mock connection row and no catalog",
  });
  const createdRowTestId = await evalIn(browser, `([...document.querySelectorAll('[data-testid^="mcp-connection-row-"]')]
    .find((entry) => (entry.textContent ?? "").includes(${JSON.stringify(connector.mcpUrl)})))
    ?.getAttribute("data-testid") ?? ""`);
  const chatActionPresent = await evalIn(browser, `(() => {
    const row = [...document.querySelectorAll('[data-testid^="mcp-connection-row-"]')]
      .find((entry) => (entry.textContent ?? "").includes(${JSON.stringify(connector.mcpUrl)}));
    const more = row?.querySelector('[data-testid^="mcp-connection-more-"]');
    if (!(more instanceof HTMLButtonElement)) return false;
    more.click();
    const chat = row?.querySelector('[data-testid^="chat-mcp-connection-"]');
    return chat instanceof HTMLAnchorElement && chat.getAttribute("href")?.startsWith("openwork://chat?") === true;
  })()`);
  expect(createdRowTestId).toMatch(/^mcp-connection-row-/);
  expect(chatActionPresent).toBe(true);
  evidence.recordAssertionEvidence(
    "The Configured page owns the connection row, offers Add connector, and its menu carries a Chat deep link into the desktop app",
    `Created row test id: ${String(createdRowTestId)}; Chat deep link present: ${String(chatActionPresent)}.`,
    typeof createdRowTestId === "string"
      && createdRowTestId.startsWith("mcp-connection-row-")
      && chatActionPresent === true,
  );

  await sleep(500);
  {
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      "A Configured connectors page lists the newly added MCP connection as a row",
      "An Add connector button sits above the list",
      "An open row menu shows Chat, Edit, View tools, and Remove",
      "No catalog of popular connectors is on this page",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  const handshakes = await connector.handshakes({
    sinceIso: witnessStartedAt,
    atLeast: 1,
    timeoutMs: 60_000,
  });
  const requests = await connector.requests();
  const discoveryRequests = requests.filter((request) => (
    request.at >= witnessStartedAt
    && request.method === "POST"
    && request.path === "/mcp"
  ));
  const toolCalls = await connector.toolCalls({ sinceIso: witnessStartedAt });
  expect(handshakes.length).toBeGreaterThanOrEqual(1);
  expect(discoveryRequests.length).toBeGreaterThanOrEqual(1);
  expect(toolCalls).toHaveLength(0);
  evidence.recordAssertionEvidence(
    "Smart-bar resolution reached the mock connector for MCP discovery",
    `Initialize handshakes: ${handshakes.length}; POST /mcp requests: ${discoveryRequests.length}.`,
    handshakes.length >= 1 && discoveryRequests.length >= 1,
  );
  evidence.recordAssertionEvidence(
    "Quick add did not execute any connector tool",
    `MCP tools/call requests since URL resolution began: ${JSON.stringify(toolCalls)}.`,
    toolCalls.length === 0,
  );
});
