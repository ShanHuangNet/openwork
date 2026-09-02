/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { t } from "@/i18n";
import type {
  OpenworkServerCapabilities,
  OpenworkServerClient,
  OpenworkServerStatus,
  OpenworkWorkspaceRunMode,
  OpenworkWorkspaceRunModeResponse,
} from "../../../../app/lib/openwork-server";
import { safeStringify } from "../../../../app/utils";
import { SettingsNotice } from "../settings-section";
import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
} from "../settings-layout";

const MODES: readonly OpenworkWorkspaceRunMode[] = ["default", "approve", "run-everything"];

const MODE_LABEL_KEYS = {
  default: "context_panel.run_mode_default",
  approve: "context_panel.run_mode_approve",
  "run-everything": "context_panel.run_mode_run_everything",
} as const satisfies Record<OpenworkWorkspaceRunMode, string>;

const MODE_DESC_KEYS = {
  default: "context_panel.run_mode_default_desc",
  approve: "context_panel.run_mode_approve_desc",
  "run-everything": "context_panel.run_mode_run_everything_desc",
} as const satisfies Record<OpenworkWorkspaceRunMode, string>;

function isMode(value: unknown): value is OpenworkWorkspaceRunMode {
  return value === "default" || value === "approve" || value === "run-everything";
}

/** The exact permission fragment a mode writes, as it will appear in the file. */
export function runModePreview(mode: OpenworkWorkspaceRunMode): string {
  if (mode === "approve") return '"permission": { "*": "ask" }';
  if (mode === "run-everything") return '"permission": { "*": "allow" }';
  return '"permission": { }  // no "*" entry';
}

export type WorkspaceRunModePanelProps = {
  openworkServerClient: OpenworkServerClient | null;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerCapabilities: OpenworkServerCapabilities | null;
  runtimeWorkspaceId: string | null;
  refreshToken?: number;
  onModeChanged: () => void;
};

export function WorkspaceRunModePanel(props: WorkspaceRunModePanelProps) {
  const [current, setCurrent] = useState<OpenworkWorkspaceRunModeResponse | null>(null);
  const [pending, setPending] = useState<OpenworkWorkspaceRunMode | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const serverReady = props.openworkServerStatus === "connected" && Boolean(props.runtimeWorkspaceId);
  const canRead = serverReady && (props.openworkServerCapabilities?.config?.read ?? false);
  const canWrite = serverReady && (props.openworkServerCapabilities?.config?.write ?? false);
  const blocked = current?.catchAll === "deny";

  useEffect(() => {
    const client = props.openworkServerClient;
    const workspaceId = props.runtimeWorkspaceId;
    if (!client || !workspaceId || !canRead) {
      setCurrent(null);
      setPending(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const next = await client.getWorkspaceRunMode(workspaceId);
        if (!cancelled) setCurrent(next);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : safeStringify(loadError));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canRead, props.openworkServerClient, props.runtimeWorkspaceId, props.refreshToken]);

  const apply = useCallback(async () => {
    const client = props.openworkServerClient;
    const workspaceId = props.runtimeWorkspaceId;
    if (!client || !workspaceId || !canWrite || !pending) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const result = await client.setWorkspaceRunMode(workspaceId, pending);
      setCurrent(result);
      setPending(null);
      setStatus(result.refresh === "deferred" ? t("context_panel.run_mode_saved_deferred") : t("context_panel.run_mode_saved"));
      props.onModeChanged();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : safeStringify(saveError));
    } finally {
      setSaving(false);
    }
  }, [canWrite, pending, props.onModeChanged, props.openworkServerClient, props.runtimeWorkspaceId]);

  const items = useMemo(() => MODES.map((value) => ({ value, label: t(MODE_LABEL_KEYS[value]) })), []);
  const shown = pending ?? current?.mode ?? "default";

  return (
    <LayoutSectionItem className="gap-6">
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>{t("context_panel.run_mode")}</LayoutSectionItemTitle>
        <LayoutSectionItemDescription>
          {t("context_panel.run_mode_desc")} {blocked ? t("context_panel.run_mode_blocked_desc") : t(MODE_DESC_KEYS[shown])}
        </LayoutSectionItemDescription>
        <LayoutSectionItemHeaderActions>
          <div className="w-52 max-w-full">
            <Select
              value={blocked ? "default" : shown}
              items={items}
              onValueChange={(value) => {
                if (!isMode(value)) return;
                setStatus(null);
                setError(null);
                setPending(value === current?.mode ? null : value);
              }}
              disabled={!canWrite || saving || blocked || !current}
            >
              <SelectTrigger className="w-full" aria-label={t("context_panel.run_mode_label")}>
                <SelectValue placeholder={blocked ? t("context_panel.run_mode_blocked") : t("context_panel.run_mode_default")} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {items.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader>

      {!canRead ? (
        <SettingsNotice>{t("context_panel.run_mode_unavailable")}</SettingsNotice>
      ) : pending && current ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-dls-border px-4 py-3" data-run-mode-preview={pending}>
          <span className="text-xs text-muted-foreground">
            {t("context_panel.run_mode_preview", undefined, { path: current.path })}
          </span>
          <pre className="overflow-auto rounded-lg bg-dls-hover/45 px-3 py-2 font-mono text-xs text-dls-text">{runModePreview(pending)}</pre>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setPending(null)} disabled={saving}>
              {t("context_panel.run_mode_cancel")}
            </Button>
            <Button size="sm" onClick={() => void apply()} disabled={saving || !canWrite}>
              {t("context_panel.run_mode_apply")}
            </Button>
          </div>
        </div>
      ) : null}
      {status ? <SettingsNotice>{status}</SettingsNotice> : null}
      {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
    </LayoutSectionItem>
  );
}
