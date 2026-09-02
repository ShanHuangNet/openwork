import { expect } from "vitest";
import { clickButton, currentHash, denFetch, evalIn, go, waitFor, waitUntilTextStable } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import { screenshot, validate } from "@openwork/test-evidence";
import { chrome } from "@openwork/hosts";
import { app, eventually, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";
import {
  desktopPolicyDefinitions,
  restrictedDesktopPolicyValue,
} from "../../packages/types/src/den/desktop-policies";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `desktop policy Restricted mode skipped — needs: ${missingRequirements.join(", ")}`
  : "an admin switches the default desktop policy to Restricted and a member's desktop hides settings and local extension add flows";

const lockedKeys = desktopPolicyDefinitions
  .filter((definition) => definition.restrictedValue !== null)
  .map((definition) => definition.id);
const editableKeys = desktopPolicyDefinitions
  .filter((definition) => definition.restrictedValue === null)
  .map((definition) => definition.id);

type EditorState = {
  mode: string | null;
  checkboxes: Array<{ key: string; checked: boolean; disabled: boolean }>;
  lockedNotes: number;
};

type SettingsNav = {
  hash: string;
  groups: string[];
  hub: boolean;
  banner: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function parseEditorState(value: unknown): EditorState {
  if (
    !isRecord(value)
    || (value.mode !== null && typeof value.mode !== "string")
    || !Array.isArray(value.checkboxes)
    || typeof value.lockedNotes !== "number"
  ) {
    throw new Error(`Policy editor state had an unexpected shape: ${JSON.stringify(value)}`);
  }
  const checkboxes = value.checkboxes.map((entry) => {
    if (!isRecord(entry) || typeof entry.key !== "string" || typeof entry.checked !== "boolean" || typeof entry.disabled !== "boolean") {
      throw new Error(`Policy checkbox state had an unexpected shape: ${JSON.stringify(entry)}`);
    }
    return { key: entry.key, checked: entry.checked, disabled: entry.disabled };
  });
  return { mode: typeof value.mode === "string" ? value.mode : null, checkboxes, lockedNotes: value.lockedNotes };
}

function parseSettingsNav(value: unknown): SettingsNav {
  if (
    !isRecord(value)
    || typeof value.hash !== "string"
    || !Array.isArray(value.groups)
    || !value.groups.every((group) => typeof group === "string")
    || typeof value.hub !== "boolean"
    || typeof value.banner !== "boolean"
  ) {
    throw new Error(`Settings navigation state had an unexpected shape: ${JSON.stringify(value)}`);
  }
  return { hash: value.hash, groups: value.groups, hub: value.hub, banner: value.banner };
}

const readEditor = `(() => {
  const selected = document.querySelector('input[name="desktop-policy-mode"]:checked');
  return {
    mode: selected ? selected.value : null,
    checkboxes: [...document.querySelectorAll('input[data-desktop-policy-key]')].map((input) => ({
      key: input.getAttribute('data-desktop-policy-key') ?? '',
      checked: input.checked,
      disabled: input.disabled,
    })),
    lockedNotes: [...document.querySelectorAll('span')]
      .filter((element) => (element.textContent ?? '').trim() === 'Locked by Restricted mode.').length,
  };
})()`;

const readSettingsNav = `(() => ({
  hash: window.location.hash,
  groups: [...document.querySelectorAll('[data-sidebar="group-label"]')]
    .map((element) => (element.textContent ?? '').trim())
    .filter(Boolean),
  hub: [...document.querySelectorAll('[data-sidebar="menu-button"]')]
    .some((element) => (element.textContent ?? '').trim() === 'Settings'),
  banner: Boolean(document.querySelector('[data-testid="desktop-policy-banner"]')),
}))()`;

async function defaultPolicy(admin: DenSession): Promise<Record<string, unknown>> {
  const result = await denFetch(admin, "/v1/desktop-policies", {
    headers: { authorization: `Bearer ${admin.token}` },
  });
  const policies = isRecord(result.body) ? records(result.body.desktopPolicies) : [];
  const policy = policies.find((entry) => entry.isDefault === true);
  if (!result.response.ok || !policy || typeof policy.id !== "string") {
    throw new Error(`Reading the default desktop policy failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return policy;
}

test(title, async ({ evidence, place }) => {
  needs(requirements);
  await using den = await server({
    place,
    org: {
      name: `Restricted Policy ${Date.now()}`,
      admin: { name: "Sarah" },
      members: { jordan: { name: "Jordan Eval" } },
    },
  });
  if (!den.members.jordan) throw new Error("server() did not provision the jordan member session");
  const policyBefore = await defaultPolicy(den.admin);
  const policyId = String(policyBefore.id);

  // Phase 1 — the member's desktop before any restriction: the settings hub
  // and every settings group are reachable, and the Library carries no
  // extension-management notice. (The generic "Organization policies active"
  // banner is not a discriminator here: it already reacts to unrelated
  // organization flags such as Dashboards or Automations being off.)
  await using member = await app({ den, as: "jordan", place });
  const settingsPath = `/workspace/${member.workspaceId}/settings/general`;
  const libraryPath = `/workspace/${member.workspaceId}/extensions`;
  await go(member, settingsPath);
  const navBefore = parseSettingsNav(await eventually(() => evalIn(member, readSettingsNav), {
    within: 60_000,
    label: "unrestricted settings navigation",
    until: (value) => isRecord(value) && Array.isArray(value.groups) && value.groups.length >= 3,
  }));
  expect(navBefore.hash).toContain("/settings/general");
  expect(navBefore.groups).toEqual(["Workspace", "Global", "Cloud"]);
  expect(navBefore.hub).toBe(true);
  {
    const shot = await screenshot(member);
    const seen = await validate(shot, [
      "A settings page with a left navigation that lists Workspace, Global, and Cloud groups",
      "The main area shows settings cards such as Preferences, Permissions, or AI Providers",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
  evidence.recordAssertionEvidence(
    "Before the policy change the member reaches the full settings surface",
    `hash=${navBefore.hash}; groups=${JSON.stringify(navBefore.groups)}; hub=${navBefore.hub}`,
    navBefore.groups.length === 3 && navBefore.hub,
  );

  await go(member, libraryPath);
  await waitFor(member, `window.location.hash.includes("/extensions") && document.body.innerText.includes("Library")`, {
    timeoutMs: 90_000,
    label: "unrestricted Library surface",
  });
  const libraryNoticeBefore = await evalIn(member, `Boolean(document.querySelector('[data-testid="manage-extensions-policy-notice"]'))`);
  expect(libraryNoticeBefore).toBe(false);
  {
    const shot = await screenshot(member);
    const seen = await validate(shot, [
      "The Library is open with extension cards and no notice about disabled extension management",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
  evidence.recordAssertionEvidence(
    "Before the policy change the Library carries no extension-management restriction",
    `hash=${await currentHash(member)}; manageExtensionsNotice=${String(libraryNoticeBefore)}`,
    libraryNoticeBefore === false,
  );

  // Phase 2 — the admin switches the default policy to Restricted in Den Web.
  // The admin browser runs on the runner against the Den's public URLs; only
  // Den and the member's desktop are placed. Web security is off for this
  // browser only: Daytona preview proxies duplicate CORS headers on actual
  // responses, which a browser rejects, and the claims here are about the
  // policy editor, not the transport.
  await using browser = await chrome({
    name: "den-desktop-policy-editor",
    startUrl: den.ref.webUrl,
    headless: true,
    webSecurity: false,
  });
  await browser.client.send("Emulation.setDeviceMetricsOverride", {
    // Tall enough that the whole capability list, through the editable
    // Welcome Page row, stays inside the frame the vision judge sees.
    width: 1440,
    height: 2100,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await navigate(browser.client, den.ref.webUrl);
  await waitFor(browser, `location.href.startsWith(${JSON.stringify(den.ref.webUrl)}) && document.readyState === "complete"`, {
    timeoutMs: 60_000,
    label: "Den Web origin before the admin auth token handoff",
  });
  const adminTokenStored = await evalIn(browser, `(() => {
    localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(den.admin.token)});
    return localStorage.getItem("openwork:web:auth-token") === ${JSON.stringify(den.admin.token)};
  })()`);
  expect(adminTokenStored).toBe(true);
  const editorUrl = `${den.ref.webUrl}/dashboard/desktop-policies/${encodeURIComponent(policyId)}`;
  await navigate(browser.client, editorUrl);
  const editorLoaded = `Boolean(document.querySelector('input[name="desktop-policy-mode"]'))
    && document.querySelectorAll('input[data-desktop-policy-key]').length === ${desktopPolicyDefinitions.length}`;
  await waitFor(browser, editorLoaded, { timeoutMs: 90_000, label: "default desktop policy editor with the mode selector" });

  const customState = parseEditorState(await evalIn(browser, readEditor));
  expect(customState.mode).toBe("custom");
  expect(customState.checkboxes.every((checkbox) => !checkbox.disabled)).toBe(true);
  expect(customState.lockedNotes).toBe(0);
  {
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      "A Policy mode selector with Custom and Restricted options appears above the capability list",
      "Custom is selected and the capability checkboxes are enabled",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
  evidence.recordAssertionEvidence(
    "The existing editor flow is unchanged: the default policy opens in Custom mode with every capability editable",
    `mode=${customState.mode}; disabled=${customState.checkboxes.filter((checkbox) => checkbox.disabled).length}; lockedNotes=${customState.lockedNotes}`,
    customState.mode === "custom" && customState.checkboxes.every((checkbox) => !checkbox.disabled),
  );

  await evalIn(browser, `(() => {
    const radio = document.querySelector('input[name="desktop-policy-mode"][value="restricted"]');
    radio.click();
    return true;
  })()`);
  await waitFor(browser, `document.querySelector('input[name="desktop-policy-mode"]:checked')?.value === "restricted"`, {
    timeoutMs: 30_000,
    label: "Restricted mode selected",
  });
  const restrictedState = parseEditorState(await evalIn(browser, readEditor));
  const lockedBoxes = restrictedState.checkboxes.filter((checkbox) => lockedKeys.includes(checkbox.key));
  const editableBoxes = restrictedState.checkboxes.filter((checkbox) => editableKeys.includes(checkbox.key));
  expect(restrictedState.mode).toBe("restricted");
  expect(lockedBoxes).toHaveLength(lockedKeys.length);
  expect(lockedBoxes.every((checkbox) => !checkbox.checked && checkbox.disabled)).toBe(true);
  expect(editableBoxes).toHaveLength(editableKeys.length);
  expect(editableBoxes.every((checkbox) => !checkbox.disabled)).toBe(true);
  expect(restrictedState.lockedNotes).toBe(lockedKeys.length);
  {
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      "Restricted is the selected policy mode",
      "The seven cards from Custom providers through Alpha updates each show an unchecked checkbox and a Locked by Restricted mode note",
      "The Welcome Page card shows a checked checkbox and no Locked by Restricted mode note",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
  evidence.recordAssertionEvidence(
    "Restricted locks every governed capability in the editor and leaves the welcome page editable",
    `locked=${JSON.stringify(lockedBoxes.map((checkbox) => checkbox.key))}; editable=${JSON.stringify(editableBoxes.map((checkbox) => checkbox.key))}`,
    lockedBoxes.every((checkbox) => !checkbox.checked && checkbox.disabled) && editableBoxes.every((checkbox) => !checkbox.disabled),
  );

  await clickButton(browser, "Save changes");
  await waitFor(browser, `!location.pathname.includes(${JSON.stringify(policyId)}) && location.pathname.endsWith("/desktop-policies")
    && Boolean(document.querySelector('[data-testid="desktop-policy-restricted-badge"]'))`, {
    timeoutMs: 60_000,
    label: "saved policy returns to the desktop policies list with a Restricted badge",
  });
  {
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      "A desktop policies table lists the default policy with both a Default badge and a Restricted badge next to its name",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
  const policyAfter = await defaultPolicy(den.admin);
  const savedValue = isRecord(policyAfter.policy) ? policyAfter.policy : {};
  for (const key of lockedKeys) {
    expect(savedValue[key]).toBe(restrictedDesktopPolicyValue[key]);
  }
  expect(savedValue.showWelcomePage).toBe(true);

  await navigate(browser.client, editorUrl);
  await waitFor(browser, `${editorLoaded} && document.querySelector('input[name="desktop-policy-mode"]:checked')?.value === "restricted"`, {
    timeoutMs: 90_000,
    label: "reopened policy derives Restricted from its saved values",
  });
  const reopenedState = parseEditorState(await evalIn(browser, readEditor));
  expect(reopenedState.mode).toBe("restricted");
  expect(reopenedState.lockedNotes).toBe(lockedKeys.length);
  await evalIn(browser, `(() => {
    document.querySelector('input[name="desktop-policy-mode"][value="custom"]').click();
    return true;
  })()`);
  await waitFor(browser, `document.querySelector('input[name="desktop-policy-mode"]:checked')?.value === "custom"`, {
    timeoutMs: 30_000,
    label: "Custom mode reselected",
  });
  const unlockedState = parseEditorState(await evalIn(browser, readEditor));
  expect(unlockedState.checkboxes.every((checkbox) => !checkbox.disabled)).toBe(true);
  expect(unlockedState.checkboxes.filter((checkbox) => lockedKeys.includes(checkbox.key)).every((checkbox) => !checkbox.checked)).toBe(true);
  evidence.recordAssertionEvidence(
    "Saving stores plain booleans, the editor reopens in Restricted, and Custom unlocks the checkboxes without changing values",
    `saved=${JSON.stringify(lockedKeys.map((key) => [key, savedValue[key]]))}; reopenedMode=${reopenedState.mode}; unlockedDisabled=${unlockedState.checkboxes.filter((checkbox) => checkbox.disabled).length}`,
    reopenedState.mode === "restricted" && unlockedState.checkboxes.every((checkbox) => !checkbox.disabled),
  );

  // Phase 3 — the member's desktop refreshes its organization config. The
  // desktop re-reads the effective policy on the Den settings-changed event,
  // which is the same path a reload, an account refresh, or an organization
  // switch drives; the hourly refresh is the level-based safety net.
  await go(member, settingsPath);
  await evalIn(member, `(() => { window.dispatchEvent(new Event("openwork-den-settings-changed")); return true; })()`);
  const navAfter = parseSettingsNav(await eventually(() => evalIn(member, readSettingsNav), {
    within: 90_000,
    label: "restricted settings navigation redirected to the Cloud account tab",
    until: (value) => isRecord(value) && typeof value.hash === "string" && value.hash.includes("/settings/cloud-account") && value.banner === true,
  }));
  expect(navAfter.hash).toContain("/settings/cloud-account");
  expect(navAfter.groups).toEqual(["Cloud"]);
  expect(navAfter.hub).toBe(false);
  expect(navAfter.banner).toBe(true);
  {
    const shot = await screenshot(member);
    const seen = await validate(shot, [
      "The settings navigation shows only a Cloud group and no Workspace or Global group",
      "An Organization policies active notice is visible on the account page",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
  evidence.recordAssertionEvidence(
    "Under the Restricted default policy the settings surface collapses to the Cloud account page",
    `hash=${navAfter.hash}; groups=${JSON.stringify(navAfter.groups)}; hub=${navAfter.hub}; banner=${navAfter.banner}`,
    navAfter.hash.includes("/settings/cloud-account") && navAfter.groups.join(",") === "Cloud" && !navAfter.hub && navAfter.banner,
  );

  await go(member, `/workspace/${member.workspaceId}/settings/appearance`);
  const redirectedHash = await eventually(() => currentHash(member), {
    within: 60_000,
    label: "typed appearance route redirected",
    until: (hash) => hash.includes("/settings/cloud-account"),
  });
  expect(redirectedHash).toContain("/settings/cloud-account");
  evidence.recordAssertionEvidence(
    "A typed route to a hidden settings tab lands on the Cloud account page instead",
    `requested=/settings/appearance; landed=${redirectedHash}`,
    redirectedHash.includes("/settings/cloud-account"),
  );

  await go(member, libraryPath);
  const library = await eventually(() => evalIn(member, `({
    hash: window.location.hash,
    notice: document.querySelector('[data-testid="manage-extensions-policy-notice"]')?.textContent ?? "",
    builtInNotice: document.body.innerText.includes("Built-in OpenWork extensions are disabled by your organization"),
  })`), {
    within: 90_000,
    label: "Library shows the manage-extensions policy notice",
    until: (value) => isRecord(value) && typeof value.notice === "string" && value.notice.length > 0,
  });
  const libraryHash = isRecord(library) && typeof library.hash === "string" ? library.hash : "";
  const libraryNotice = isRecord(library) && typeof library.notice === "string" ? library.notice : "";
  const libraryBuiltInNotice = isRecord(library) && library.builtInNotice === true;
  expect(libraryHash).toContain("/extensions");
  expect(libraryNotice).toContain("disabled local extension management");
  // Restricted also turns off allowBuiltInExtensions, so the Library's
  // existing built-in banner appears alongside the new notice.
  expect(libraryBuiltInNotice).toBe(true);
  // Let the inventory finish loading so the frame shows the settled Library.
  await waitUntilTextStable(member, { quietMs: 3_000, timeoutMs: 45_000 }).catch(() => undefined);
  {
    const shot = await screenshot(member);
    const seen = await validate(shot, [
      "The Library is open and shows a notice that the organization administrator disabled local extension management",
      "A notice says built-in OpenWork extensions are disabled by your organization",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
  evidence.recordAssertionEvidence(
    "The Library stays reachable but local extension and MCP add flows are disabled with the catalog notice",
    `hash=${libraryHash}; notice=${JSON.stringify(libraryNotice)}; builtInNotice=${libraryBuiltInNotice}`,
    libraryHash.includes("/extensions") && libraryNotice.includes("disabled local extension management") && libraryBuiltInNotice,
  );
});
