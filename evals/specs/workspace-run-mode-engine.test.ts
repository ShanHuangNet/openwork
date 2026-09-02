import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { needs, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";
import constants from "../../constants.json" with { type: "json" };
import { validateEffectiveEngineSnapshot } from "../../apps/server/src/agent-context-engine-inspection.js";
import { attributeRule, selectGoverningAgent, winningRule } from "../../apps/server/src/effective-permissions.js";
import { readJsoncFile } from "../../apps/server/src/jsonc.js";
import { runModeFromPermissionBlock, setWorkspaceRunMode } from "../../apps/server/src/workspace-permission-rules.js";

/**
 * The run mode picker writes the workspace file's catch-all ("*") the way an
 * OpenCode user would. This boots the pinned engine with a user global file
 * and a workspace file, switches modes through the same function the route
 * uses, and reads the engine's evaluated decisions back: approve asks, run
 * everything allows, default returns to the engine's own posture, narrower
 * rules in the file are untouched — and, because the workspace file is the
 * engine's last-read layer, the workspace catch-all also overrides the global
 * file's rules, exactly as for any OpenCode project config. That last point
 * is recorded as its own claim so the behaviour is stated, not implied.
 */

const requirements: TestNeeds = { commands: ["opencode"] };
const missingRequirements = unmetNeeds(requirements, process.env);
const skipSuffix = missingRequirements.length > 0 ? ` skipped — needs: ${missingRequirements.join(", ")}` : "";
const AUTH = "Basic " + Buffer.from("probe:probe").toString("base64");
const emptyConfig: Record<string, unknown> = {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("Failed to allocate a free port"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const graceful = await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_500))]);
  if (!graceful) {
    child.kill("SIGKILL");
    await exited;
  }
}

interface Engine {
  version: string;
  workspace: string;
  home: string;
  /** Rebuild the instance so the workspace file is re-read, then return the governing agent's ruleset. */
  reloadRules: () => Promise<Array<{ permission: string; pattern: string; action: "allow" | "ask" | "deny" }>>;
  [Symbol.asyncDispose]: () => Promise<void>;
}

async function bootEngine(workspaceFile: string, globalFile = "{}"): Promise<Engine> {
  const root = await mkdtemp(join(tmpdir(), "openwork-workspace-rules-engine-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const xdg = join(root, "xdg");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(home, { recursive: true }), mkdir(join(xdg, "config", "opencode"), { recursive: true })]);
  await writeFile(join(workspace, "opencode.json"), workspaceFile, "utf8");
  await writeFile(join(xdg, "config", "opencode", "opencode.json"), globalFile, "utf8");
  const port = await freePort();
  const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: workspace,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCODE_SERVER_USERNAME: "probe",
      OPENCODE_SERVER_PASSWORD: "probe",
      OPENCODE_TEST_HOME: home,
      XDG_CONFIG_HOME: join(xdg, "config"),
      XDG_DATA_HOME: join(xdg, "data"),
      XDG_CACHE_HOME: join(xdg, "cache"),
      XDG_STATE_HOME: join(xdg, "state"),
      OPENCODE_CLIENT: "openwork-test",
    },
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  const dispose = async () => {
    await stop(child);
    await rm(root, { recursive: true, force: true });
  };
  const request = async (method: string, path: string): Promise<unknown> => {
    const url = new URL(path, baseUrl);
    url.searchParams.set("directory", workspace);
    const response = await fetch(url.toString(), { method, headers: { Authorization: AUTH }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  const deadline = Date.now() + 45_000;
  let version = "";
  while (Date.now() < deadline && !version) {
    if (child.exitCode !== null) break;
    try {
      const health = await request("GET", "/global/health");
      if (isRecord(health) && health.healthy === true && typeof health.version === "string") version = health.version;
    } catch {
      // not up yet
    }
    if (!version) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!version) {
    await dispose();
    throw new Error(`opencode serve never became healthy: ${stderr.slice(0, 800)}`);
  }
  const reloadRules = async () => {
    await request("POST", "/instance/dispose");
    const [config, agents] = await Promise.all([request("GET", "/config"), request("GET", "/agent")]);
    const snapshot = validateEffectiveEngineSnapshot({ config, agents });
    if (!snapshot) throw new Error("engine snapshot did not validate");
    const agent = selectGoverningAgent(snapshot.agents, snapshot.defaultAgent);
    if (!agent) throw new Error("no governing agent");
    return agent.permission;
  };
  return { version, workspace, home, reloadRules, [Symbol.asyncDispose]: dispose };
}

test.skipIf(missingRequirements.length > 0)(
  `the workspace run mode is the file's catch-all and the engine reads it as the last word${skipSuffix}`,
  async ({ evidence }) => {
    needs(requirements);
    // The user's global file denies destructive shell commands and allows one
    // narrower command; the workspace file starts with a hand-written rule.
    await using engine = await bootEngine(`{
  // hand-written
  "$schema": "https://opencode.ai/config.json",
  "permission": { "edit": { "docs/*": "allow" } }
}
`, JSON.stringify({ permission: { bash: { "rm *": "deny" } } }));
    expect(engine.version).toBe(constants.opencodeVersion.replace(/^v/, ""));
    const file = () => readJsoncFile(join(engine.workspace, "opencode.json"), emptyConfig, { allowInvalid: true }).then((result) => result.data.permission);
    const decide = (rules: Awaited<ReturnType<Engine["reloadRules"]>>, permission: string, pattern: string) => winningRule(rules, permission, pattern)?.action ?? "ask";

    // Default: the engine's own posture plus the global deny.
    const defaults = await engine.reloadRules();
    expect(runModeFromPermissionBlock(await file()).mode).toBe("default");
    expect(decide(defaults, "bash", "ls -la")).toBe("allow");
    expect(decide(defaults, "bash", "rm -rf build")).toBe("deny");
    expect(decide(defaults, "edit", "src/index.ts")).toBe("allow");

    // Approve each step: "*": "ask" — everything asks except the file's narrower allow.
    expect(await setWorkspaceRunMode(engine.workspace, "approve")).toBe(true);
    const approve = await engine.reloadRules();
    expect(decide(approve, "bash", "ls -la")).toBe("ask");
    expect(decide(approve, "edit", "src/index.ts")).toBe("ask");
    expect(decide(approve, "edit", "docs/readme.md")).toBe("allow");
    expect(decide(approve, "acme_mcp_tool", "*")).toBe("ask");
    const approveRule = winningRule(approve, "bash", "ls -la");
    expect(approveRule ? attributeRule(approveRule, { global: undefined, openwork: undefined, workspace: await file() }, engine.home) : null).toBe("workspace");
    evidence.recordAssertionEvidence(
      "Approve each step writes the workspace catch-all to ask and the engine asks for every tool except the file's narrower allow",
      `bash/edit/MCP → ask, edit docs/* → allow; the winning rule is attributed to the workspace file.`,
      true,
    );

    // Run everything: "*": "allow". Stated plainly: the workspace catch-all is
    // read after the global file, so the global "rm *" deny is overridden —
    // OpenCode's own precedence for any project config.
    expect(await setWorkspaceRunMode(engine.workspace, "run-everything")).toBe(true);
    const everything = await engine.reloadRules();
    expect(decide(everything, "bash", "ls -la")).toBe("allow");
    expect(decide(everything, "edit", "src/index.ts")).toBe("allow");
    expect(decide(everything, "acme_mcp_tool", "*")).toBe("allow");
    // Plain OpenCode semantics: a catch-all allow also covers the engine's
    // outside-folder and doom-loop asks, because the workspace's "*" is merged
    // after the layers that define those rules. The picker says so.
    const outside = decide(everything, "external_directory", "/elsewhere/report.md");
    const doomLoop = decide(everything, "doom_loop", "*");
    expect(outside).toBe("allow");
    expect(doomLoop).toBe("allow");
    const rmDecision = decide(everything, "bash", "rm -rf build");
    expect(rmDecision).toBe("allow");
    evidence.recordAssertionEvidence(
      "Run everything writes the workspace catch-all to allow and, as OpenCode's own \"permission\": \"allow\" does, also stops the outside-folder and doom-loop asks",
      `bash/edit/MCP → allow; external_directory outside grants → ${outside}; doom_loop → ${doomLoop}. The mode description states this.`,
      true,
    );
    evidence.recordAssertionEvidence(
      "A workspace catch-all overrides the global opencode.json, as OpenCode's own precedence dictates",
      `Global {bash: {"rm *": deny}} with workspace "*": allow → bash "rm -rf build" = ${rmDecision}. The workspace file is the engine's last-read layer; the picker's description says so.`,
      true,
    );

    // Back to default: the catch-all is removed, the hand-written rule and comment remain.
    expect(await setWorkspaceRunMode(engine.workspace, "default")).toBe(true);
    const restored = await engine.reloadRules();
    expect(decide(restored, "bash", "rm -rf build")).toBe("deny");
    expect(decide(restored, "edit", "docs/readme.md")).toBe("allow");
    expect(runModeFromPermissionBlock(await file()).mode).toBe("default");
    expect(await readFile(join(engine.workspace, "opencode.json"), "utf8")).toContain("// hand-written");
  },
);
