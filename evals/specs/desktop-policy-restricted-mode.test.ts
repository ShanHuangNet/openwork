import { expect } from "vitest";
import { test } from "@openwork/testkit";
import {
  applyRestrictedDesktopPolicy,
  calculateEffectiveDesktopPolicy,
  desktopPolicyDefaults,
  desktopPolicyDefinitions,
  isRestrictedDesktopPolicyValue,
  restrictedDesktopPolicyValue,
} from "../../packages/types/src/den/desktop-policies";
import {
  SETTINGS_TAB_WITHOUT_CONTROL,
  checkDesktopAppRestriction,
  desktopRestrictionNotice,
  isSettingsTabAllowed,
  type DesktopAppRestrictionChecker,
} from "../../apps/app/src/app/cloud/desktop-app-restrictions";
import { SETTINGS_TAB_VALUES } from "../../apps/app/src/app/types";
import { libraryAddAction } from "../../apps/app/src/react-app/domains/settings/library";

const unrestricted: DesktopAppRestrictionChecker = () => false;
const restricted: DesktopAppRestrictionChecker = ({ restriction }) =>
  checkDesktopAppRestriction({ config: restrictedDesktopPolicyValue, restriction });

test("a Restricted desktop policy hides settings and local extension add flows while organization-approved work keeps working", ({ evidence }) => {
  // Claim 1: the Restricted editor mode locks every governed capability.
  const lockedKeys = desktopPolicyDefinitions
    .filter((definition) => definition.restrictedValue !== null)
    .map((definition) => definition.id);
  for (const key of lockedKeys) {
    expect(restrictedDesktopPolicyValue[key]).toBe(false);
  }
  expect(restrictedDesktopPolicyValue.showWelcomePage).toBe(true);
  expect(
    applyRestrictedDesktopPolicy({ ...desktopPolicyDefaults, showWelcomePage: false }).showWelcomePage,
  ).toBe(false);
  evidence.recordAssertionEvidence(
    "Restricted turns off every governed capability and leaves the welcome page preference editable",
    `${lockedKeys.join(", ")} are locked to false; showWelcomePage keeps the admin's choice in both modes.`,
    true,
  );

  // Claim 2: the Den editor derives the mode from stored booleans.
  expect(isRestrictedDesktopPolicyValue(restrictedDesktopPolicyValue)).toBe(true);
  expect(isRestrictedDesktopPolicyValue({ ...restrictedDesktopPolicyValue, showWelcomePage: false })).toBe(true);
  expect(isRestrictedDesktopPolicyValue(desktopPolicyDefaults)).toBe(false);
  expect(isRestrictedDesktopPolicyValue({ ...restrictedDesktopPolicyValue, allowManageExtensions: true })).toBe(false);
  evidence.recordAssertionEvidence(
    "The Den editor reopens a saved all-locked policy as Restricted without a new schema field",
    "OpenWork defaults or a single granted capability reopen as Custom.",
    true,
  );

  // Claim 3: the effective policy stays a union of grants.
  const locked = calculateEffectiveDesktopPolicy({
    orgPolicyCount: 1,
    defaultPolicy: restrictedDesktopPolicyValue,
    assignedPolicies: [],
  });
  for (const key of lockedKeys) {
    expect(locked[key]).toBe(false);
  }
  expect(locked.showWelcomePage).toBe(true);
  const unlockedForTeam = calculateEffectiveDesktopPolicy({
    orgPolicyCount: 2,
    defaultPolicy: restrictedDesktopPolicyValue,
    assignedPolicies: [{ allowManageExtensions: true }],
  });
  expect(unlockedForTeam.allowManageExtensions).toBe(true);
  expect(unlockedForTeam.allowControlSettings).toBe(false);
  const restrictedTargetOnly = calculateEffectiveDesktopPolicy({
    orgPolicyCount: 2,
    defaultPolicy: desktopPolicyDefaults,
    assignedPolicies: [restrictedDesktopPolicyValue],
  });
  expect(restrictedTargetOnly.allowControlSettings).toBe(true);
  evidence.recordAssertionEvidence(
    "Restricted on the default policy locks members down until an assigned policy grants more",
    "Every governed capability resolves to false; one assigned grant reopens only that capability; Restricted on a targeted policy alone grants nothing.",
    true,
  );

  // Claim 4: blocked settings control leaves only the Cloud account surface.
  for (const tab of SETTINGS_TAB_VALUES) {
    expect(isSettingsTabAllowed({ tab, checkRestriction: unrestricted })).toBe(true);
  }
  const allowed = SETTINGS_TAB_VALUES.filter((tab) => isSettingsTabAllowed({ tab, checkRestriction: restricted }));
  expect(allowed).toEqual(["cloud-account", "memory"]);
  expect(allowed).toContain(SETTINGS_TAB_WITHOUT_CONTROL);
  for (const tab of ["general", "ai", "preferences", "permissions", "extensions", "advanced", "appearance", "updates", "recovery", "debug"] as const) {
    expect(isSettingsTabAllowed({ tab, checkRestriction: restricted })).toBe(false);
  }
  expect(desktopRestrictionNotice("allowControlSettings")).toBe(
    "Your organization administrator has disabled changing desktop app settings.",
  );
  evidence.recordAssertionEvidence(
    "allowControlSettings=false hides desktop settings but keeps the account page",
    `All ${SETTINGS_TAB_VALUES.length} tabs stay reachable without a policy; under Restricted only cloud-account and memory pass the gate, and every other tab is redirected to the Cloud account tab that carries the catalog notice.`,
    true,
  );

  // Claim 5: blocked extension management removes local add flows only.
  const signedInRestricted = { cloudSignedIn: true, allowManageExtensions: false };
  expect(libraryAddAction("workspace-mcp", signedInRestricted)).toBeNull();
  expect(libraryAddAction("mcp", signedInRestricted)).toEqual({ type: "den-modal", kind: "mcp" });
  expect(libraryAddAction("skill", signedInRestricted)).toEqual({ type: "den-modal", kind: "skill" });
  expect(libraryAddAction("workspace-mcp", { cloudSignedIn: true, allowManageExtensions: true })).toEqual({ type: "workspace-mcp" });
  expect(desktopRestrictionNotice("allowManageExtensions")).toBe(
    "Your organization administrator has disabled local extension management.",
  );
  evidence.recordAssertionEvidence(
    "allowManageExtensions=false removes the local add flows and explains why",
    "The workspace MCP add flow disappears while Cloud skill and organization MCP authoring stay available; the Library notice reuses the catalog copy.",
    true,
  );
});
