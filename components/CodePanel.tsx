// CodePanel.tsx
/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import { useEffect, useRef, useState } from "react";
import {
  SandpackProvider,
  SandpackLayout,
  SandpackCodeEditor,
  SandpackPreview,
  SandpackFileExplorer,
  useSandpack,
} from "@codesandbox/sandpack-react";
import {
  Eye,
  Code2,
  Download,
  AlertTriangle,
  Bot,
  Loader2,
  History,
  Maximize2,
  Minimize2,
  Monitor,
  Smartphone,
  X,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { RingLoader } from "react-spinners";
import JSZip from "jszip";
import {
  BASE_DEPENDENCIES,
  buildProjectFiles,
  exportZipName,
} from "@/lib/export-project";
import { GithubPushDialog, type LastPush } from "@/components/GithubPushDialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import type { FileData, StatusStep } from "@/types/workspace";
import type { VersionSummary } from "@/types/version";

// ─── Placeholder ──────────────────────────────────────────────────────────────

const PLACEHOLDER_FILES = {
  "/App.js": {
    code: `export default function App() {
  return (
    <div style={{
      minHeight: "100vh",
      background: "#0a0a0a",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "system-ui, sans-serif",
    }}>
      <div style={{ textAlign: "center", color: "rgba(255,255,255,0.3)" }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>⚡</div>
        <p style={{ fontSize: 14 }}>Your app will appear here</p>
      </div>
    </div>
  );
}`,
  },
};

// ─── Types ────────────────────────────────────────────────────────────────────

type ActiveTab = "preview" | "code";

type PreviewDevice = "desktop" | "mobile";

interface CodePanelProps {
  fileData: FileData | null;
  isGenerating: boolean;
  statusLog: StatusStep[];
  onFixError: (error: string) => Promise<void>;
  appTitle: string | null;
  isImproving: boolean;
  versions: VersionSummary[];
  versionsLoading: boolean;
  onRestoreVersion: (versionId: string) => Promise<void>;
  focusMode: boolean;
  onToggleFocusMode: () => void;
  workspaceId: string | null;
  githubConnected: boolean;
  githubUsername: string | null;
  lastPush: LastPush | null;
  onPushed: (push: LastPush) => void;
  onGithubConnectionChange: (connected: boolean, username: string | null) => void;
}

// ─── SandpackInner ────────────────────────────────────────────────────────────
// Lives inside SandpackProvider so it can call useSandpack().
// Receives fileData as a prop and uses updateFile() to push code changes
// into the live Sandpack instance without remounting the provider.

function SandpackInner({
  isGenerating,
  statusLog,
  activeTab,
  setActiveTab,
  onFixError,
  fileData,
  appTitle,
  isImproving,
  versions,
  versionsLoading,
  onRestoreVersion,
  focusMode,
  onToggleFocusMode,
  device,
  setDevice,
  workspaceId,
  githubConnected,
  githubUsername,
  lastPush,
  onPushed,
  onGithubConnectionChange,
}: {
  isGenerating: boolean;
  statusLog: StatusStep[];
  activeTab: ActiveTab;
  setActiveTab: (t: ActiveTab) => void;
  onFixError: (error: string) => Promise<void>;
  fileData: FileData | null;
  appTitle: string | null;
  isImproving: boolean;
  versions: VersionSummary[];
  versionsLoading: boolean;
  onRestoreVersion: (versionId: string) => Promise<void>;
  focusMode: boolean;
  onToggleFocusMode: () => void;
  device: PreviewDevice;
  setDevice: (d: PreviewDevice) => void;
  workspaceId: string | null;
  githubConnected: boolean;
  githubUsername: string | null;
  lastPush: LastPush | null;
  onPushed: (push: LastPush) => void;
  onGithubConnectionChange: (connected: boolean, username: string | null) => void;
}) {
  const { sandpack, listen } = useSandpack();
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const isBusy = isGenerating || isImproving;

  // Push file content updates into Sandpack without remounting.
  // This runs whenever fileData changes (e.g. after improve completes).
  // SandpackProvider key only changes when the file path set changes,
  // so this is the safe way to update existing file contents.
  const prevFilesRef = useRef<Record<string, { code: string }>>({});
  useEffect(() => {
    if (!fileData?.files) return;
    const prev = prevFilesRef.current;
    for (const [path, { code }] of Object.entries(fileData.files)) {
      if (prev[path]?.code !== code) {
        sandpack.updateFile(path, code);
      }
    }
    prevFilesRef.current = fileData.files;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileData?.files]);

  // Listen for Sandpack runtime errors
  useEffect(() => {
    unsubscribeRef.current = listen((msg) => {
      if (
        msg.type === "action" &&
        "action" in msg &&
        msg.action === "show-error"
      ) {
        const errMsg =
          "message" in msg && typeof msg.message === "string"
            ? msg.message
            : "An error occurred in the preview.";
        setPreviewError(errMsg);
        return;
      }
      if (msg.type === "compile") {
        const errMsg =
          "message" in msg && typeof msg.message === "string"
            ? msg.message
            : "Compile error in preview.";
        setPreviewError(errMsg);
        return;
      }
      if (msg.type === "success") {
        setPreviewError(null);
      }
    });
    return () => unsubscribeRef.current?.();
  }, [listen]);

  useEffect(() => {
    if (isGenerating) setPreviewError(null);
  }, [isGenerating]);

  // Close version history on Escape
  useEffect(() => {
    if (!showHistory) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowHistory(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showHistory]);

  // ── Export to ZIP ──────────────────────────────────────────────────────────
  // File map comes from the shared buildProjectFiles() builder so the ZIP
  // download and the GitHub push can never drift apart.
  const handleExportZip = async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const filesToZip =
        Object.keys(sandpack.files).length > 0
          ? sandpack.files
          : fileData?.files ?? {};

      const projectFiles = buildProjectFiles({
        files: filesToZip as Record<string, { code: string }>,
        dependencies: fileData?.dependencies ?? {},
        title: appTitle ?? fileData?.title ?? null,
      });

      const zip = new JSZip();
      for (const [zipPath, content] of Object.entries(projectFiles)) {
        zip.file(zipPath, content);
      }

      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = exportZipName(appTitle);
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export failed:", err);
    } finally {
      setIsExporting(false);
    }
  };

  const currentStepLabel =
    statusLog[statusLog.length - 1]?.label ?? "Generating…";

  return (
    <Tabs
      value={activeTab}
      onValueChange={(v) => setActiveTab(v as ActiveTab)}
      className="flex h-full flex-col gap-0"
    >
      {/* Tabs + Actions bar */}
      <div className="flex items-center justify-between border-b border-white/6 px-2">
        <TabsList
          variant="line"
          className="h-auto gap-0 rounded-none bg-transparent p-0"
        >
          <TabsTrigger className="border-b-2 pt-2" value="code">
            <Code2 className="h-3.5 w-3.5" />
            Code
          </TabsTrigger>
          <TabsTrigger className="border-b-2 pt-2" value="preview">
            <Eye className="h-3.5 w-3.5" />
            Preview
          </TabsTrigger>
        </TabsList>

        <div className="flex items-center gap-1.5">
          {/* ── Version history ── */}
          <div className="relative">
            <button
              onClick={() => setShowHistory((v) => !v)}
              title="Version history"
              className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-white/60 transition-colors hover:bg-white/6 hover:text-white/90"
            >
              <History className="h-3.5 w-3.5" />
              {versions.length > 0 && (
                <span className="rounded-sm bg-white/10 px-1 text-[10px] leading-4">
                  {versions.length}
                </span>
              )}
            </button>

            {showHistory && (
              <div className="absolute right-0 top-8 z-30 w-72 overflow-hidden rounded-xl border border-white/10 bg-[#111111] shadow-2xl shadow-black/60">
                <div className="flex items-center justify-between border-b border-white/6 px-3 py-2">
                  <p className="text-xs font-semibold text-white/70">
                    Version history
                  </p>
                  <button
                    onClick={() => setShowHistory(false)}
                    className="rounded p-0.5 text-white/30 hover:bg-white/10 hover:text-white/60"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="max-h-80 overflow-y-auto p-1.5">
                  {versionsLoading ? (
                    <p className="px-2.5 py-4 text-center text-xs text-white/30">
                      Loading…
                    </p>
                  ) : versions.length === 0 ? (
                    <p className="px-2.5 py-4 text-center text-xs text-white/30">
                      No versions yet. Each AI edit saves one here.
                    </p>
                  ) : (
                    versions.map((v) => (
                      <div
                        key={v.id}
                        className="rounded-lg px-2.5 py-2 hover:bg-white/5"
                      >
                        <p className="line-clamp-2 text-xs leading-relaxed text-white/75">
                          {v.summary ?? "Untitled version"}
                        </p>
                        <div className="mt-1 flex items-center justify-between">
                          <span className="text-[11px] text-white/30">
                            {formatDistanceToNow(new Date(v.createdAt), {
                              addSuffix: true,
                            })}{" "}
                            · {v.fileCount} file
                            {v.fileCount === 1 ? "" : "s"}
                          </span>
                          <button
                            disabled={isBusy || restoringId !== null}
                            onClick={async () => {
                              setRestoringId(v.id);
                              await onRestoreVersion(v.id);
                              setRestoringId(null);
                              setShowHistory(false);
                            }}
                            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-violet-300 hover:bg-violet-500/15 disabled:opacity-40"
                          >
                            {restoringId === v.id && (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            )}
                            Restore
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <p className="border-t border-white/6 px-3 py-2 text-[10px] text-white/25">
                  Restoring is free and reversible.
                </p>
              </div>
            )}
          </div>

          {/* ── Device toggle ── */}
          <div className="flex items-center rounded-md border border-white/10 p-0.5">
            <button
              onClick={() => setDevice("desktop")}
              title="Desktop preview"
              className={`rounded p-1 transition-colors ${device === "desktop" ? "bg-white/10 text-white/80" : "text-white/30 hover:text-white/60"}`}
            >
              <Monitor className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setDevice("mobile")}
              title="Mobile preview"
              className={`rounded p-1 transition-colors ${device === "mobile" ? "bg-white/10 text-white/80" : "text-white/30 hover:text-white/60"}`}
            >
              <Smartphone className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* ── Focus mode ── */}
          <button
            onClick={onToggleFocusMode}
            title={focusMode ? "Show chat" : "Focus preview"}
            className="rounded-md p-1.5 text-white/60 transition-colors hover:bg-white/6 hover:text-white/90"
          >
            {focusMode ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </button>

          <Button
            variant="ghost"
            onClick={handleExportZip}
            disabled={isExporting || !fileData}
          >
            {isExporting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            Download
          </Button>

          <GithubPushDialog
            workspaceId={workspaceId}
            appTitle={appTitle}
            fileDataPresent={Boolean(fileData)}
            disabled={isBusy}
            githubConnected={githubConnected}
            githubUsername={githubUsername}
            lastPush={lastPush}
            onPushed={onPushed}
            onConnectionChange={onGithubConnectionChange}
          />
        </div>
      </div>

      {/* Content area */}
      <div className="relative flex-1 overflow-hidden h-full">
        {(isGenerating || isImproving) && !fileData && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-6 bg-[#0a0a0a]/85 backdrop-blur-sm">
            <RingLoader color="#a78bfa" size={64} speedMultiplier={0.8} />
            <div className="flex flex-col items-center gap-1.5">
              <p className="text-sm font-medium text-white/60">
                {isImproving ? "Applying agent edits…" : currentStepLabel}
              </p>
              <p className="text-xs text-white/20">
                This usually takes 10–20 seconds
              </p>
            </div>
          </div>
        )}

        {/* Slim non-blocking status bar — edits on an existing app */}
        {(isGenerating || isImproving) && fileData && (
          <div className="absolute inset-x-0 top-0 z-20 flex items-center gap-2 border-b border-violet-500/20 bg-[#0a0a0a]/90 px-3 py-1.5 backdrop-blur-sm">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-400" />
            <p className="text-xs text-white/60">
              {isImproving ? "Applying agent edits…" : currentStepLabel}
            </p>
          </div>
        )}

        <SandpackLayout
          style={{
            height: "100vh",
            border: "none",
            borderRadius: 0,
            background: "transparent",
          }}
        >
          <TabsContent
            value="preview"
            keepMounted
            className="mt-0 h-full w-full"
          >
            <div
              className={
                device === "mobile"
                  ? "mx-auto h-full w-full max-w-[390px] border-x border-white/10"
                  : "h-full w-full"
              }
            >
              <SandpackPreview
                style={{ height: "89%" }}
                showOpenInCodeSandbox={false}
              />
            </div>
          </TabsContent>

          <TabsContent
            value="code"
            keepMounted
            className="mt-0 flex h-full w-full"
          >
            <SandpackFileExplorer
              style={{
                height: "90%",
                width: "180px",
                borderRight: "0.5px solid rgba(255,255,255,0.08)",
              }}
            />
            <SandpackCodeEditor
              style={{ height: "90%", flex: 1 }}
              showTabs
              showLineNumbers
              showInlineErrors
              closableTabs
              readOnly
            />
          </TabsContent>
        </SandpackLayout>
      </div>

      {/* Preview error banner — Fix with AI routes via agent patch when files exist */}
      {previewError &&
        !isGenerating &&
        !isImproving &&
        activeTab === "preview" && (
          <div className="absolute inset-x-0 -bottom-3 z-20 border-t border-red-500/20 bg-red-950/99 p-4 pb-6">
            <div className="flex items-center gap-2.5">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400/70" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-red-400/80">
                  Preview error
                </p>
                <p className="break-all text-[11px] text-red-300/50">
                  {previewError}
                </p>
              </div>
              <Button
                onClick={() => onFixError(previewError)}
                variant="destructive"
              >
                <Bot className="h-3 w-3" />
                Fix with AI
              </Button>
            </div>
          </div>
        )}
    </Tabs>
  );
}

// ─── CodePanel (outer) ────────────────────────────────────────────────────────

export function CodePanel({
  fileData,
  isGenerating,
  statusLog,
  onFixError,
  appTitle,
  isImproving,
  versions,
  versionsLoading,
  onRestoreVersion,
  focusMode,
  onToggleFocusMode,
  workspaceId,
  githubConnected,
  githubUsername,
  lastPush,
  onPushed,
  onGithubConnectionChange,
}: CodePanelProps) {
  const [activeTab, setActiveTab] = useState<ActiveTab>("preview");
  const [device, setDevice] = useState<PreviewDevice>("desktop");

  useEffect(() => {
    if (fileData) setActiveTab("preview");
  }, [fileData]);

  const files = fileData?.files ?? PLACEHOLDER_FILES;
  const dependencies = {
    ...BASE_DEPENDENCIES,
    ...(fileData?.dependencies ?? {}),
  };

  // Key only on file path set — NOT on file contents.
  // Content changes go through sandpack.updateFile() inside SandpackInner.
  // This prevents Sandpack from remounting when only code changes.
  const filePathKey = Object.keys(files).sort().join("|");

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <SandpackProvider
        key={filePathKey}
        template="react"
        theme="dark"
        files={files}
        customSetup={{ dependencies }}
        options={{
          externalResources: ["https://cdn.tailwindcss.com"],
          recompileMode: "delayed",
          recompileDelay: 500,
        }}
      >
        <SandpackInner
          isGenerating={isGenerating}
          statusLog={statusLog}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          onFixError={onFixError}
          fileData={fileData}
          appTitle={appTitle}
          isImproving={isImproving}
          versions={versions}
          versionsLoading={versionsLoading}
          onRestoreVersion={onRestoreVersion}
          focusMode={focusMode}
          onToggleFocusMode={onToggleFocusMode}
          device={device}
          setDevice={setDevice}
          workspaceId={workspaceId}
          githubConnected={githubConnected}
          githubUsername={githubUsername}
          lastPush={lastPush}
          onPushed={onPushed}
          onGithubConnectionChange={onGithubConnectionChange}
        />
      </SandpackProvider>
    </div>
  );
}