import { expect } from "vitest";
import { control, createAndSelectWorkspace, evalIn, seedSessions, waitFor } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "chat working and command activity use quiet shimmer without spinners"
  : "chat loading shimmer skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

test.skipIf(!enabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  await using app = await desktop({ name: "chat-loading-shimmer" });
  await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-chat-loading-shimmer-${Date.now()}`,
  });
  await seedSessions(app, ["Shimmer proof"]);
  await waitFor(
    app,
    `window.__openworkControl.listActions().some((action) => action.id === "eval.chat_loading.seed" && !action.disabled)`,
    { timeoutMs: 30_000, label: "chat loading proof control ready" },
  );
  await control(app, "eval.chat_loading.seed");
  await waitFor(app, `Boolean(document.querySelector('[data-loading-message="working"] .ow-text-shimmer'))`, {
    timeoutMs: 15_000,
    label: "main Working shimmer",
  });
  const working = await evalIn(app, `(() => {
    const row = document.querySelector('[data-loading-message="working"]');
    return {
      text: row instanceof HTMLElement ? row.innerText.trim() : "",
      hasSpinner: Boolean(row?.querySelector('.animate-spin')),
      hasShimmer: Boolean(row?.querySelector('.ow-text-shimmer')),
    };
  })()`);
  expect(working).toMatchObject({ hasSpinner: false, hasShimmer: true });
  if (!working || typeof working !== "object" || !("text" in working) || typeof working.text !== "string") {
    throw new Error(`Working row was not readable: ${JSON.stringify(working)}`);
  }
  expect(working.text).toContain("Working");
  evidence.recordAssertionEvidence(
    "The main chat Working state uses shimmer instead of a circular spinner",
    `The live row remained readable as “${working.text}” and contained no animate-spin indicator.`,
    true,
  );

  // The sweep animates `background-position`, which Chromium paints on the
  // main thread. Sample the animated value once per frame for a second: a
  // smooth sweep changes on (almost) every frame, a stepped one changes on a
  // bounded number of them while still visibly moving.
  const cadence = await evalIn(app, `(async () => {
    const shimmer = document.querySelector('[data-loading-message="working"] .ow-text-shimmer');
    if (!(shimmer instanceof HTMLElement)) return null;
    const positions = new Set();
    let sampledFrames = 0;
    const startedAt = performance.now();
    await new Promise((resolve) => {
      const sample = (now) => {
        positions.add(getComputedStyle(shimmer).backgroundPosition);
        sampledFrames += 1;
        if (now - startedAt >= 1000) resolve(undefined);
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    return {
      animationName: getComputedStyle(shimmer).animationName,
      sampledFrames,
      distinctPositions: positions.size,
    };
  })()`, { awaitPromise: true, timeoutMs: 15_000 });
  if (
    !cadence
    || typeof cadence !== "object"
    || !("animationName" in cadence)
    || !("sampledFrames" in cadence)
    || !("distinctPositions" in cadence)
    || typeof cadence.animationName !== "string"
    || typeof cadence.sampledFrames !== "number"
    || typeof cadence.distinctPositions !== "number"
  ) {
    throw new Error(`Shimmer cadence was not readable: ${JSON.stringify(cadence)}`);
  }
  expect(cadence.animationName).toBe("ow-text-shimmer");
  expect(cadence.sampledFrames).toBeGreaterThanOrEqual(30);
  expect(cadence.distinctPositions).toBeGreaterThanOrEqual(2);
  expect(cadence.distinctPositions).toBeLessThanOrEqual(24);
  expect(cadence.distinctPositions).toBeLessThan(cadence.sampledFrames * 0.6);
  evidence.recordAssertionEvidence(
    "The Working shimmer keeps sweeping but repaints on a bounded cadence instead of every frame",
    `Over ${cadence.sampledFrames} sampled frames the animated position took ${cadence.distinctPositions} distinct values while “${cadence.animationName}” stayed active.`,
    true,
  );

  // The macOS shell blurs the vibrancy backdrop once, on the session pane.
  // Nothing scrolls beneath the pane header or behind the transcript surface,
  // so any further backdrop filter on the way down to the Working row is an
  // invisible extra full-pane blur pass per repaint.
  const composition = await evalIn(app, `(() => {
    const pane = document.querySelector('main[data-session-pane]');
    const row = document.querySelector('[data-loading-message="working"]');
    const header = pane?.querySelector('header');
    if (!(pane instanceof HTMLElement) || !(row instanceof HTMLElement) || !(header instanceof HTMLElement)) return null;
    const filterOf = (element) => getComputedStyle(element).backdropFilter;
    const nestedFilters = [];
    for (let node = row.parentElement; node && node !== pane; node = node.parentElement) {
      const filter = filterOf(node);
      if (filter !== "none") nestedFilters.push(node.tagName.toLowerCase() + ": " + filter);
    }
    return {
      isMac: document.documentElement.classList.contains("openwork-platform-mac"),
      paneFilter: filterOf(pane),
      headerFilter: filterOf(header),
      nestedFilters,
    };
  })()`);
  if (
    !composition
    || typeof composition !== "object"
    || !("isMac" in composition)
    || !("paneFilter" in composition)
    || !("headerFilter" in composition)
    || !("nestedFilters" in composition)
    || typeof composition.isMac !== "boolean"
    || typeof composition.paneFilter !== "string"
    || typeof composition.headerFilter !== "string"
    || !Array.isArray(composition.nestedFilters)
  ) {
    throw new Error(`Pane composition was not readable: ${JSON.stringify(composition)}`);
  }
  expect(composition.headerFilter).toBe("none");
  expect(composition.nestedFilters).toEqual([]);
  if (composition.isMac) expect(composition.paneFilter).toContain("blur(");
  else expect(composition.paneFilter).toBe("none");
  evidence.recordAssertionEvidence(
    "The session pane is the only backdrop-filter surface above the transcript",
    `Pane backdrop-filter “${composition.paneFilter}” (macOS shell: ${composition.isMac}); header “${composition.headerFilter}”; no filtered ancestors between the Working row and the pane.`,
    true,
  );

  await control(app, "eval.session_lifecycle.seed_unfinished_tools", { lifecycle: "active" });
  await waitFor(app, `Boolean(document.querySelector('[data-tool-aggregate-now] .ow-text-shimmer'))`, {
    timeoutMs: 15_000,
    label: "aggregate Now shimmer",
  });
  const aggregate = await evalIn(app, `(() => {
    const row = document.querySelector('[data-tool-aggregate-now]');
    const summary = [...document.querySelectorAll('[data-tool-aggregate] > button')]
      .find((button) => (button.textContent ?? "").includes("Running command"));
    return {
      text: row instanceof HTMLElement ? row.innerText.replace(/\\s+/g, " ").trim() : "",
      hasSpinner: Boolean(row?.querySelector('.animate-spin')),
      hasShimmer: Boolean(row?.querySelector('.ow-text-shimmer')),
      singularSummary: summary instanceof HTMLElement ? summary.innerText.replace(/\\s+/g, " ").trim() : "",
    };
  })()`);
  expect(aggregate).toMatchObject({ hasSpinner: false, hasShimmer: true });
  if (!aggregate || typeof aggregate !== "object" || !("text" in aggregate) || typeof aggregate.text !== "string") {
    throw new Error(`Aggregate activity row was not readable: ${JSON.stringify(aggregate)}`);
  }
  // #4134 dropped the "Now:" prefix: the whole current action shimmers instead.
  expect(aggregate.text).not.toContain("Now:");
  expect(aggregate.text).toContain("Reading brief.md");
  if (!("singularSummary" in aggregate) || typeof aggregate.singularSummary !== "string") {
    throw new Error(`Aggregate summary was not readable: ${JSON.stringify(aggregate)}`);
  }
  expect(aggregate.singularSummary).toContain("Running command");
  expect(aggregate.singularSummary).not.toContain("Running 1 command");
  evidence.recordAssertionEvidence(
    "The aggregate activity row names the current step with shimmer instead of a circular spinner",
    `The live aggregate row remained readable as “${aggregate.text}” and contained no animate-spin indicator.`,
    true,
  );

  const expanded = await evalIn(app, `(() => {
    const trigger = document.querySelector('[data-tool-aggregate] > button');
    if (!(trigger instanceof HTMLButtonElement)) return false;
    trigger.click();
    return true;
  })()`);
  expect(expanded).toBe(true);
  await waitFor(app, `Boolean(document.querySelector('[data-tool-aggregate-command]'))`, {
    timeoutMs: 15_000,
    label: "expanded aggregate command block",
  });
  const command = await evalIn(app, `(() => {
    const block = document.querySelector('[data-tool-aggregate-command]');
    const aggregate = block?.closest('[data-tool-aggregate]');
    return {
      text: block instanceof HTMLElement ? block.innerText.replace(/\\s+/g, " ").trim() : "",
      commandSummaryCount: aggregate instanceof HTMLElement
        ? (aggregate.innerText.match(/(?:Ran|Running) command/g) ?? []).length
        : 0,
    };
  })()`);
  expect(command).toMatchObject({ commandSummaryCount: 1 });
  if (!command || typeof command !== "object" || !("text" in command) || typeof command.text !== "string") {
    throw new Error(`Expanded command block was not readable: ${JSON.stringify(command)}`);
  }
  expect(command.text).toContain("$");
  expect(command.text).toContain("git status --short --branch");
  evidence.recordAssertionEvidence(
    "Expanded command history uses a readable rounded shell block",
    "The live expanded aggregate rendered the command with a shell prompt inside its dedicated command block.",
    true,
  );
});
