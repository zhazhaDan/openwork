/** @jsxImportSource react */
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Download, ExternalLink, FileText, Loader2, X } from "lucide-react";

import type { OpenworkServerClient } from "../../../../app/lib/openwork-server";
import { openDesktopPath } from "../../../../app/lib/desktop";
import { Button } from "@/components/ui/button";
import { MarkdownBlock } from "../surface/markdown";
import { cn } from "@/lib/utils";
import type { OpenTarget } from "./open-target";

const ArtifactTextEditor = lazy(() =>
  import("./artifact-text-editor").then((module) => ({ default: module.ArtifactTextEditor })),
);
const ArtifactSpreadsheetEditor = lazy(() =>
  import("./artifact-spreadsheet-editor").then((module) => ({ default: module.ArtifactSpreadsheetEditor })),
);

type ArtifactPanelProps = {
  client: OpenworkServerClient;
  workspaceId: string;
  workspaceRoot: string;
  isRemoteWorkspace?: boolean;
  target: OpenTarget;
  targets?: OpenTarget[];
  onSelectTarget?: (target: OpenTarget) => void;
  onClose: () => void;
};

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "text"; content: string; updatedAt: number | null }
  | { status: "binary"; url: string; data: ArrayBuffer; contentType: string | null; updatedAt: number | null };

function absoluteWorkspacePath(root: string, path: string) {
  const cleanRoot = root.trim().replace(/[/\\]+$/, "");
  const cleanPath = path.trim().replace(/^\.\//, "");
  return cleanRoot ? `${cleanRoot}/${cleanPath}` : cleanPath;
}

function ArtifactTargetIcon({ target, className = "size-3.5" }: { target: OpenTarget; className?: string }) {
  if (target.preview === "sheet") {
    return (
      <span className={cn("inline-flex min-w-5 shrink-0 items-center justify-center rounded-[4px] border border-emerald-500/30 bg-emerald-500/10 px-0.5 text-[7px] font-bold leading-none text-emerald-700", className)}>
        XLS
      </span>
    );
  }
  if (target.preview === "markdown") {
    return (
      <span className={cn("inline-flex shrink-0 items-center justify-center rounded-[4px] border border-primary/25 bg-primary/10 font-bold leading-none text-primary", className, "text-[7px]")}>
        MD
      </span>
    );
  }
  return <FileText className={cn(className, "shrink-0 text-primary")} />;
}

export function ArtifactPanel({ client, workspaceId, workspaceRoot, isRemoteWorkspace = false, target, targets = [], onSelectTarget, onClose }: ArtifactPanelProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const canReadAsText = ["markdown", "text", "sheet", "html"].includes(target.preview) && !/\.(xlsx|xls|ods)$/i.test(target.value);
  const canEditText = target.kind === "file" && canReadAsText;
  const isDirectTextEdit = canEditText && target.preview === "markdown";
  const externalPath = useMemo(() => target.kind === "file" ? absoluteWorkspacePath(workspaceRoot, target.value) : target.value, [target.kind, target.value, workspaceRoot]);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ status: "loading" });
    setEditing(false);
    setDraft("");
    setSaveMessage(null);

    async function load() {
      try {
        if (target.kind === "url") {
          setState({ status: "error", message: "URLs open in browser tabs." });
          return;
        }
        if (target.exists === false) {
          setState({ status: "error", message: "File not found in this workspace." });
          return;
        }
        if (canReadAsText) {
          const result = await client.readWorkspaceFile(workspaceId, target.value);
          if (!cancelled) {
            setState({ status: "text", content: result.content, updatedAt: result.updatedAt ?? null });
            setDraft(result.content);
          }
          return;
        }
        const result = await client.downloadWorkspaceFile(workspaceId, target.value);
        objectUrl = URL.createObjectURL(new Blob([result.data], { type: result.contentType ?? "application/octet-stream" }));
        if (!cancelled) setState({ status: "binary", url: objectUrl, data: result.data, contentType: result.contentType, updatedAt: target.updatedAt ?? null });
      } catch (error) {
        if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : "Failed to load artifact" });
      }
    }

    void load();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [canReadAsText, client, target, workspaceId]);

  const download = async () => {
    if (target.kind === "url") return;
      const result = await client.downloadWorkspaceFile(workspaceId, target.value);
      const url = URL.createObjectURL(new Blob([result.data], { type: result.contentType ?? "application/octet-stream" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = target.name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const openExternal = async () => {
    if (target.kind === "url") window.open(target.value, "_blank", "noopener,noreferrer");
    else if (!isRemoteWorkspace) {
      void openDesktopPath(externalPath);
    } else {
      await download();
    }
  };

  const save = async () => {
    if (!canEditText || state.status !== "text") return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const result = await client.writeWorkspaceFile(workspaceId, {
        path: target.value,
        content: draft,
        baseUpdatedAt: state.updatedAt,
      });
      setState({ status: "text", content: draft, updatedAt: result.updatedAt ?? null });
      setEditing(false);
      setSaveMessage("Saved");
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const saveTextContent = async (content: string) => {
    if (target.kind !== "file") return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const baseUpdatedAt = state.status === "text" ? state.updatedAt : target.updatedAt ?? null;
      const result = await client.writeWorkspaceFile(workspaceId, { path: target.value, content, baseUpdatedAt });
      setState({ status: "text", content, updatedAt: result.updatedAt ?? null });
      setDraft(content);
      setSaveMessage("Saved");
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : "Save failed");
      throw error;
    } finally {
      setSaving(false);
    }
  };

  const saveBinaryContent = async (data: ArrayBuffer) => {
    if (target.kind !== "file") return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const baseUpdatedAt = state.status === "binary" ? state.updatedAt : target.updatedAt ?? null;
      const result = await client.writeWorkspaceBinaryFile(workspaceId, { path: target.value, data, baseUpdatedAt });
      const url = URL.createObjectURL(new Blob([data], { type: state.status === "binary" ? state.contentType ?? "application/octet-stream" : "application/octet-stream" }));
      setState({ status: "binary", url, data, contentType: state.status === "binary" ? state.contentType : null, updatedAt: result.updatedAt ?? null });
      setSaveMessage("Saved");
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : "Save failed");
      throw error;
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground">
            <ArtifactTargetIcon target={target} className="size-4" />
            <span className="truncate">{target.name}</span>
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {target.value}{target.exists === false ? " · missing" : target.size ? ` · ${target.size} bytes` : ""}
          </div>
        </div>
        {canEditText && state.status === "text" ? (
          editing || isDirectTextEdit ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => { setDraft(state.content); setEditing(false); }} disabled={saving}>Discard</Button>
              <Button variant="default" size="sm" onClick={() => void save()} disabled={saving || draft === state.content}>{saving ? "Saving" : "Save"}</Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>Edit</Button>
          )
        ) : null}
        {target.kind === "file" ? (
          <Button variant="ghost" size="icon-sm" onClick={() => void download()} aria-label="Download artifact" title="Download artifact">
            <Download />
          </Button>
        ) : null}
        <Button variant="ghost" size="icon-sm" onClick={() => void openExternal()} aria-label={isRemoteWorkspace ? "Download artifact" : "Open externally"} title={isRemoteWorkspace ? "Download artifact" : "Open externally"}>
          <ExternalLink />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close artifact" title="Close artifact">
          <X />
        </Button>
      </div>
      {targets.length > 0 ? (
        <div className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
          {targets.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cn(
                "flex max-w-44 shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-left text-[11px] transition-colors",
                item.id === target.id
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
                item.exists === false && "opacity-60",
              )}
              title={`${item.value}${item.exists === false ? " (missing)" : ""}`}
              onClick={() => onSelectTarget?.(item)}
            >
              <ArtifactTargetIcon target={item} />
              <span className="truncate">{item.name}{item.exists === false ? " · missing" : ""}</span>
            </button>
          ))}
        </div>
      ) : null}
      {saveMessage ? <div className="shrink-0 border-b border-border px-3 py-1 text-[11px] text-muted-foreground">{saveMessage}</div> : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        {state.status === "loading" ? (
          <div className="flex h-full items-center justify-center text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>
        ) : state.status === "error" ? (
          <div className="p-4 text-sm text-muted-foreground">{state.message}</div>
        ) : state.status === "text" && (editing || isDirectTextEdit) ? (
          <Suspense fallback={<div className="flex h-full items-center justify-center text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>}>
            <ArtifactTextEditor value={draft} language={target.preview === "markdown" ? "markdown" : "text"} onChange={setDraft} />
          </Suspense>
        ) : target.preview === "markdown" && state.status === "text" ? (
          <div className="h-full overflow-auto p-4"><MarkdownBlock text={state.content} /></div>
        ) : target.preview === "sheet" ? (
          <Suspense fallback={<div className="flex h-full items-center justify-center text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>}>
            <ArtifactSpreadsheetEditor
              name={target.name}
              text={state.status === "text" ? state.content : undefined}
              data={state.status === "binary" ? state.data : undefined}
              saving={saving}
              onSaveText={saveTextContent}
              onSaveBinary={saveBinaryContent}
            />
          </Suspense>
        ) : target.preview === "html" && state.status === "text" ? (
          <iframe srcDoc={state.content} title={target.name} className="h-full w-full border-0" sandbox="allow-scripts allow-same-origin" />
        ) : target.preview === "image" && state.status === "binary" ? (
          <div className="flex h-full items-center justify-center overflow-auto bg-muted/30 p-3"><img src={state.url} alt={target.name} className="max-h-full max-w-full object-contain" /></div>
        ) : state.status === "binary" && (target.preview === "pdf" || target.preview === "html") ? (
          <iframe src={state.url} title={target.name} className="h-full w-full border-0" sandbox="allow-scripts allow-same-origin" />
        ) : state.status === "text" ? (
          <pre className="h-full overflow-auto p-4 text-xs leading-5 text-foreground whitespace-pre-wrap">{state.content}</pre>
        ) : (
          <div className="p-4 text-sm text-muted-foreground">Preview unavailable. Open externally to view this file.</div>
        )}
      </div>
    </div>
  );
}
