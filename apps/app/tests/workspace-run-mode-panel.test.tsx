import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { t } from "../src/i18n";
import type { OpenworkServerCapabilities } from "../src/app/lib/openwork-server";
import { WorkspaceRunModePanel, runModePreview } from "../src/react-app/domains/settings/panels/workspace-run-mode-panel";

const writable: OpenworkServerCapabilities = {
  skills: { read: true, write: true, source: "openwork" },
  plugins: { read: true, write: true },
  mcp: { read: true, write: true },
  commands: { read: true, write: true },
  config: { read: true, write: true },
};

describe("workspace run mode panel", () => {
  test("previews exactly what each mode writes, in OpenCode's own syntax", () => {
    expect(runModePreview("approve")).toBe('"permission": { "*": "ask" }');
    expect(runModePreview("run-everything")).toBe('"permission": { "*": "allow" }');
    expect(runModePreview("default")).toContain('no "*" entry');
  });

  test("names the section and describes the current mode honestly before any write", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceRunModePanel
        openworkServerClient={null}
        openworkServerStatus="connected"
        openworkServerCapabilities={writable}
        runtimeWorkspaceId="ws_1"
        onModeChanged={() => undefined}
      />,
    );
    expect(markup).toContain(t("context_panel.run_mode"));
    // Nothing is offered for writing until the file has been read, and no preview is shown.
    expect(markup).not.toContain(t("context_panel.run_mode_apply"));
    // The run-everything description states the outside-folder consequence plainly.
    expect(t("context_panel.run_mode_run_everything_desc")).toContain("outside authorized folders");
  });

  test("explains when the file cannot be changed", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceRunModePanel
        openworkServerClient={null}
        openworkServerStatus="disconnected"
        openworkServerCapabilities={null}
        runtimeWorkspaceId={null}
        onModeChanged={() => undefined}
      />,
    );
    expect(markup).toContain("Connect to a writable OpenWork server workspace to change the run mode");
  });
});
