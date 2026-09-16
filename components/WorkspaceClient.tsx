// WorkspaceClient.tsx
"use client";

import {
  useState,
  useCallback,
  useRef,
  useEffect,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ChatPanel } from "./ChatPanel";
import { CodePanel } from "./CodePanel";
import { MobileBlocker } from "./MobileBlocker";
import { MIN_CREDITS_TO_GENERATE } from "@/lib/constants";
import { emitCredits } from "@/lib/credits-bus";
import { getVersions, restoreVersion } from "@/actions/versions";
import { toast } from "sonner";
import type {
  Message,
  FileData,
  StatusStep,
  WorkspaceData,
} from "@/types/workspace";
import type { VersionSummary } from "@/types/version";

export type {
  MessageRole,
  Message,
  FileData,
  StatusStep,
} from "@/types/workspace";

interface WorkspaceClientProps {
  initialPrompt: string | null;
  workspace: WorkspaceData | null;
  userCredits: number;
  userId: string;
  githubConnected: boolean;
  githubUsername: string | null;
}

function parseMessages(raw: unknown): Message[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (m): m is Message =>
      typeof m === "object" && m !== null && "role" in m && "content" in m
  );
}

function parseFileData(raw: unknown): FileData | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  if (!f.files || !f.dependencies) return null;
  return raw as FileData;
}

export function WorkspaceClient({
  initialPrompt,
  workspace,
  userCredits,
  userId,
  githubConnected: initialGithubConnected,
  githubUsername: initialGithubUsername,
}: WorkspaceClientProps) {
  const [workspaceId, setWorkspaceId] = useState<string | null>(
    workspace?.id ?? null
  );
  const [messages, setMessages] = useState<Message[]>(
    parseMessages(workspace?.messages)
  );
  const [fileData, setFileData] = useState<FileData | null>(
    parseFileData(workspace?.fileData)
  );
  const [credits, setCredits] = useState(userCredits);
  const creditsRef = useRef(userCredits);
  useEffect(() => {
    creditsRef.current = credits;
  }, [credits]);

  const applyCredits = useCallback((next: number) => {
    creditsRef.current = next;
    setCredits(next);
    emitCredits(next);
  }, []);

  const decrementOptimistic = useCallback(() => {
    applyCredits(creditsRef.current - 1);
  }, [applyCredits]);

  const refundOptimistic = useCallback(() => {
    applyCredits(creditsRef.current + 1);
  }, [applyCredits]);

  const applyAuthoritative = useCallback(
    (next: number | undefined, fallback: number) => {
      applyCredits(typeof next === "number" ? next : fallback);
    },
    [applyCredits]
  );
  const [isGenerating, setIsGenerating] = useState(false);  const [statusLog, setStatusLog] = useState<StatusStep[]>([]);
  const [isImproving, setIsImproving] = useState(false);
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [githubConnected, setGithubConnected] = useState(initialGithubConnected);
  const [githubUsername, setGithubUsername] = useState<string | null>(initialGithubUsername);
  const [lastPush, setLastPush] = useState<{
    repoUrl: string;
    fullName: string;
    branch: string;
    pushedAt: string;
  } | null>(() =>
    workspace?.githubRepoUrl
      ? {
          repoUrl: workspace.githubRepoUrl,
          fullName: workspace.githubRepoFullName ?? workspace.githubRepoUrl,
          branch: workspace.githubBranch ?? "main",
          pushedAt: workspace.lastPushedAt ?? "",
        }
      : null
  );
  const [focusMode, setFocusMode] = useState(false);
  const [chatWidth, setChatWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 320;
    const saved = Number(window.localStorage.getItem("drevo:chat-width"));
    if (!Number.isFinite(saved)) return 320;
    return Math.min(560, Math.max(240, saved));
  });

  // AbortController refs — used to cancel in-flight streams
  const generateAbortRef = useRef<AbortController | null>(null);
  const improveAbortRef = useRef<AbortController | null>(null);

  // Refs to avoid stale closures in callbacks
  const messagesRef = useRef<Message[]>(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const workspaceIdRef = useRef<string | null>(workspaceId);
  useEffect(() => {
    workspaceIdRef.current = workspaceId;
  }, [workspaceId]);

  // fileData ref — so handleImprove never closes over stale fileData
  // even as file_patch events stream in
  const fileDataRef = useRef<FileData | null>(fileData);
  useEffect(() => {
    fileDataRef.current = fileData;
  }, [fileData]);

  // Resizable chat panel — drag the divider, width persists to localStorage
  const chatWidthRef = useRef(chatWidth);
  useEffect(() => {
    chatWidthRef.current = chatWidth;
    try {
      window.localStorage.setItem("drevo:chat-width", String(chatWidth));
    } catch {
      // private mode etc. — layout still works, just won't persist
    }
  }, [chatWidth]);
  const resizingRef = useRef<{ startX: number; startW: number } | null>(null);
  const handleDividerPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      resizingRef.current = { startX: e.clientX, startW: chatWidthRef.current };
    },
    []
  );
  const handleDividerPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const r = resizingRef.current;
      if (!r) return;
      setChatWidth(Math.min(560, Math.max(240, r.startW + e.clientX - r.startX)));
    },
    []
  );
  const handleDividerPointerUp = useCallback(() => {
    resizingRef.current = null;
  }, []);

  // Version history — refreshed after every successful run + restore.
  // Read id from ref so stable callbacks never close over a stale one.
  const refreshVersions = useCallback(async () => {
    const id = workspaceIdRef.current;
    if (!id) {
      setVersions([]);
      return;
    }
    setVersionsLoading(true);
    try {
      setVersions(await getVersions(id));
    } catch {
      // silent — history is a nice-to-have, never block the workspace
    } finally {
      setVersionsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshVersions();
  }, [workspaceId, refreshVersions]);

  const handleRestoreVersion = useCallback(
    async (versionId: string) => {
      const id = workspaceIdRef.current;
      if (!id || isGenerating || isImproving) return;
      try {
        const detail = await restoreVersion(id, versionId);
        setFileData(detail.fileData);
        refreshVersions();
        toast.success("Version restored. Continue chatting to iterate.");
      } catch {
        toast.error("Restore failed. Please try again.");
      }
    },
    [isGenerating, isImproving, refreshVersions]
  );

  const pushStep = (label: string) => {
    setStatusLog((prev) => [
      ...prev.map((s, i) =>
        i === prev.length - 1 ? { ...s, status: "done" as const } : s
      ),
      { label, status: "running" as const },
    ]);
  };

  const completeSteps = () => {
    setStatusLog((prev) =>
      prev.map((s, i) =>
        i === prev.length - 1 ? { ...s, status: "done" as const } : s
      )
    );
  };

  // opts.history + appendUser:false powers regenerate / edit-resubmit:
  // history already ends with the user message, so nothing is appended
  // and rollback removes nothing on failure.
  interface RunOpts {
    history?: Message[];
    appendUser?: boolean;
  }

  const handleGenerate = useCallback(
    async (prompt: string, imageUrl?: string, opts?: RunOpts) => {
      if (isGenerating) return;
      if (credits < MIN_CREDITS_TO_GENERATE) return;

      const userMessage: Message = {
        role: "user",
        content: prompt,
        ...(imageUrl ? { imageUrl } : {}),
      };

      const appendUser = opts?.appendUser !== false;
      const baseMessages = opts?.history ?? messagesRef.current;
      const currentWorkspaceId = workspaceIdRef.current;

      if (appendUser) setMessages((prev) => [...prev, userMessage]);
      setIsGenerating(true);
      setStatusLog([{ label: "Thinking…", status: "running" }]);
      // Optimistic -1 so header + chat counts drop on Enter.
      // Authoritative value from SSE "done" reconciles it; failures refund below.
      let charged = false;
      decrementOptimistic();
      charged = true;

      // Create a fresh AbortController for this request
      const abortController = new AbortController();
      generateAbortRef.current = abortController;

      try {
        const conversationHistory = appendUser
          ? [...baseMessages, userMessage]
          : baseMessages;

        const res = await fetch("/api/gen-ai-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: abortController.signal,
          body: JSON.stringify({
            workspaceId: currentWorkspaceId,
            userId,
            messages: conversationHistory,
            fileData: fileDataRef.current,
          }),
        });

        if (res.status === 402) {
          setMessages((prev) => prev.slice(0, -1));
          if (charged) {
            refundOptimistic();
            charged = false;
          }
          return;
        }
        if (res.status === 429) {
          toast.error("Too many requests. Please slow down.");
          setMessages((prev) => prev.slice(0, -1));
          if (charged) {
            refundOptimistic();
            charged = false;
          }
          return;
        }
        if (!res.ok || !res.body) throw new Error("Generation failed");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            let event: {
              type: string;
              message?: string;
              code?: string;
              retryAfter?: number;
              workspaceId?: string;
              fileData?: FileData;
              creditsRemaining?: number;
              assistantMessage?: string;
            };
            try {
              event = JSON.parse(line.slice(6));
            } catch {
              // skip malformed SSE lines
              continue;
            }
            if (event.type === "status") {
              pushStep(event.message ?? "Working…");
            } else if (event.type === "done") {
              completeSteps();
              setWorkspaceId(event.workspaceId ?? null);
              if (event.fileData) setFileData(event.fileData);
              applyAuthoritative(
                event.creditsRemaining,
                creditsRef.current
              );
              charged = false;
              setMessages((prev) => [
                ...prev,
                { role: "assistant", content: event.assistantMessage ?? "" },
              ]);
              if (event.workspaceId) {
                window.history.replaceState(
                  null,
                  "",
                  `/workspace?id=${event.workspaceId}`
                );
              }
              // New snapshot was saved server-side — reload history list
              refreshVersions();
            } else if (event.type === "error") {
              const quotaMsg =
                event.code === "QUOTA_EXCEEDED"
                  ? event.message ??
                    "Gemini free-tier limit hit. Please wait and retry."
                  : event.message ?? "Generation failed";
              const err = new Error(quotaMsg) as Error & {
                code?: string;
                retryAfter?: number;
              };
              err.code = event.code;
              err.retryAfter = event.retryAfter;
              throw err;
            }
          }
        }
      } catch (err) {
        // User-initiated stop — silently roll back the user message
        // (only when this run appended one — regenerate keeps history)
        if (err instanceof Error && err.name === "AbortError") {
          if (appendUser) setMessages((prev) => prev.slice(0, -1));
          if (charged) {
            refundOptimistic();
            charged = false;
          }
          return;
        }
        console.error(err);
        const code = (err as Error & { code?: string })?.code;
        const retryAfter = (err as Error & { retryAfter?: number })?.retryAfter;
        toast.error(
          err instanceof Error ? err.message : "Something went wrong.",
          {
            duration:
              code === "QUOTA_EXCEEDED"
                ? Math.min(
                    15000,
                    Math.max(8000, (retryAfter ?? 50) * 1000)
                  )
                : 5000,
          }
        );
        if (appendUser) setMessages((prev) => prev.slice(0, -1));
        // No deduction on failure/quota - refund the optimistic -1.
        if (charged) {
          refundOptimistic();
          charged = false;
        }
      } finally {
        generateAbortRef.current = null;
        setIsGenerating(false);
        setStatusLog([]);
      }
    },
    // fileData intentionally omitted — read via fileDataRef
    [
      credits,
      isGenerating,
      userId,
      refreshVersions,
      decrementOptimistic,
      refundOptimistic,
      applyAuthoritative,
    ]
  );

  // Hybrid edit path — 2nd+ chat prompt, screenshot re-send, Fix-with-AI.
  // First prompt (no workspace/fileData yet) still uses handleGenerate.
  const handleImprove = useCallback(
    async (userRequest: string, imageUrl?: string, opts?: RunOpts) => {
      if (isGenerating || isImproving) return;
      if (credits < MIN_CREDITS_TO_GENERATE) return;
      if (!workspaceIdRef.current) return;

      // Read fileData from ref — never stale, never causes recreating this fn
      const currentFileData = fileDataRef.current;
      if (!currentFileData) return;

      const appendUser = opts?.appendUser !== false;
      // Roll back what this run added: user + placeholder normally,
      // placeholder only on regenerate / edit-resubmit.
      const rollbackCount = appendUser ? 2 : 1;
      const userMessage: Message = {
        role: "user",
        content: userRequest,
        ...(imageUrl ? { imageUrl } : {}),
      };
      const baseMessages = opts?.history ?? messagesRef.current;
      const conversationHistory = appendUser
        ? [...baseMessages, userMessage]
        : baseMessages;

      setIsImproving(true);

      if (appendUser) {
        setMessages((prev) => [
          ...prev,
          userMessage,
          { role: "assistant", content: "" }, // placeholder, updated live
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "" }, // placeholder, updated live
        ]);
      }

      // Create a fresh AbortController for this request
      const abortController = new AbortController();
      improveAbortRef.current = abortController;
      // Optimistic -1 so header + chat counts drop on Enter (reconciled at done).
      let charged = false;
      decrementOptimistic();
      charged = true;

      try {
        const res = await fetch("/api/improve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: abortController.signal,
          body: JSON.stringify({
            userId,
            workspaceId: workspaceIdRef.current,
            userRequest,
            ...(imageUrl ? { imageUrl } : {}),
            messages: conversationHistory,
            fileData: currentFileData,
          }),
        });

        if (res.status === 403) {
          toast.error("Something went wrong. Please try again.");
          setMessages((prev) => prev.slice(0, -rollbackCount));
          if (charged) {
            refundOptimistic();
            charged = false;
          }
          return;
        }
        if (res.status === 402) {
          toast.error("Not enough credits.");
          setMessages((prev) => prev.slice(0, -rollbackCount));
          if (charged) {
            refundOptimistic();
            charged = false;
          }
          return;
        }
        if (!res.ok || !res.body) throw new Error("Improve failed");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let accumulatedThinking = "";

        // Accumulate patches locally — only apply to state at done.
        // Applying on every file_patch event would update fileData state,
        // which feeds into SandpackProvider and can cause remounts mid-stream.
        const localPatches: Record<string, { code: string }> = {};

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            let event: {
              type: string;
              text?: string;
              path?: string;
              code?: string;
              fileData?: FileData;
              summary?: string;
              partial?: boolean;
              creditsRemaining?: number;
              message?: string;
              retryAfter?: number;
            };
            try {
              event = JSON.parse(line.slice(6));
            } catch {
              // skip malformed SSE lines
              continue;
            }

            if (event.type === "thinking") {
              // Stream agent reasoning into the placeholder assistant message
              accumulatedThinking += event.text ?? "";
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: accumulatedThinking,
                };
                return updated;
              });
            } else if (event.type === "file_patch") {
              // Accumulate locally — don't touch state yet
              if (event.path) localPatches[event.path] = { code: event.code as unknown as string };
            } else if (event.type === "done") {
              // Apply all patches at once now that the stream is complete
              if (event.fileData) setFileData(event.fileData);
              applyAuthoritative(event.creditsRemaining, creditsRef.current);
              charged = false;
              // Replace thinking text with clean summary
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: event.summary ?? "Done.",
                };
                return updated;
              });
              // Budget ran out mid-overhaul but completed files were kept —
              // make sure the user notices they can ask to continue.
              if (event.partial) {
                toast.info(
                  "Partially applied — ask to continue with the rest.",
                  { duration: 8000 }
                );
              }
              // New snapshot was saved server-side — reload history list
              refreshVersions();
            } else if (event.type === "error") {
              const quotaMsg =
                event.code === "QUOTA_EXCEEDED"
                  ? event.message ??
                    "Gemini free-tier limit hit. Please wait and retry. No credits were deducted."
                  : event.message ?? "Improve failed";
              const err = new Error(quotaMsg) as Error & {
                code?: string;
                retryAfter?: number;
              };
              err.code = event.code;
              err.retryAfter = event.retryAfter;
              throw err;
            }
          }
        }
      } catch (err) {
        // User-initiated stop — silently roll back what this run added
        if (err instanceof Error && err.name === "AbortError") {
          setMessages((prev) => prev.slice(0, -rollbackCount));
          if (charged) {
            refundOptimistic();
            charged = false;
          }
          return;
        }
        const code = (err as Error & { code?: string })?.code;
        const retryAfter = (err as Error & { retryAfter?: number })?.retryAfter;
        toast.error(err instanceof Error ? err.message : "Improve failed.", {
          duration:
            code === "QUOTA_EXCEEDED"
              ? Math.min(15000, Math.max(8000, (retryAfter ?? 50) * 1000))
              : code === "MAX_ITERATIONS"
                ? 8000
                : 5000,
        });
        setMessages((prev) => prev.slice(0, -rollbackCount));
        // No deduction on failure/quota - refund the optimistic -1.
        if (charged) {
          refundOptimistic();
          charged = false;
        }
      } finally {
        improveAbortRef.current = null;
        setIsImproving(false);
      }
    },
    // fileData intentionally omitted — read via fileDataRef above
    [
      credits,
      isGenerating,
      isImproving,
      userId,
      refreshVersions,
      decrementOptimistic,
      refundOptimistic,
      applyAuthoritative,
    ]
  );

  // Regenerate the last exchange: drop trailing assistant message(s) and
  // re-run the last user message through the hybrid router. Costs 1 credit
  // like a normal run (the new run appends a fresh assistant response).
  const handleRegenerate = useCallback(() => {
    if (isGenerating || isImproving) return;
    if (credits < MIN_CREDITS_TO_GENERATE) return;
    const current = messagesRef.current;
    let lastUserIdx = -1;
    for (let i = current.length - 1; i >= 0; i--) {
      if (current[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return;
    const lastUser = current[lastUserIdx];
    if (!lastUser.content.trim()) return;
    const trimmed = current.slice(0, lastUserIdx + 1);
    setMessages(trimmed);
    const runOpts = { history: trimmed, appendUser: false } as const;
    if (workspaceIdRef.current && fileDataRef.current) {
      return handleImprove(lastUser.content, lastUser.imageUrl, runOpts);
    }
    return handleGenerate(lastUser.content, lastUser.imageUrl, runOpts);
  }, [credits, isGenerating, isImproving, handleGenerate, handleImprove]);

  // Edit-and-resubmit: rewrite a user message, drop everything after it,
  // and re-run. Same routing + credit behavior as a fresh prompt.
  const handleEditMessage = useCallback(
    (index: number, content: string) => {
      if (isGenerating || isImproving) return;
      if (credits < MIN_CREDITS_TO_GENERATE) return;
      const trimmedContent = content.trim();
      if (!trimmedContent) return;
      const current = messagesRef.current;
      const msg = current[index];
      if (!msg || msg.role !== "user") return;
      const updated: Message = { ...msg, content: trimmedContent };
      const trimmed = [...current.slice(0, index), updated];
      setMessages(trimmed);
      const runOpts = { history: trimmed, appendUser: false } as const;
      if (workspaceIdRef.current && fileDataRef.current) {
        return handleImprove(trimmedContent, updated.imageUrl, runOpts);
      }
      return handleGenerate(trimmedContent, updated.imageUrl, runOpts);
    },
    [credits, isGenerating, isImproving, handleGenerate, handleImprove]
  );

  // Cancel whichever stream is currently in-flight
  const handleStop = useCallback(() => {
    generateAbortRef.current?.abort();
    improveAbortRef.current?.abort();
  }, []);

  // Fix-with-AI goes through the agent when files exist (patch is safer
  // than full regen for error fixes), else falls back to generation.
  const handleFixError = useCallback(
    (error: string) => {
      const prompt = `There is an error in the preview:\n\n\`\`\`\n${error}\n\`\`\`\n\nPlease fix it.`;
      if (workspaceIdRef.current && fileDataRef.current) {
        return handleImprove(prompt);
      }
      return handleGenerate(prompt);
    },
    [handleGenerate, handleImprove]
  );

  // Hybrid routing: first prompt (no workspace/files yet) -> fast one-shot
  // generation; every follow-up -> agent patch path. ChatPanel just calls
  // whatever handler is current — it re-renders after workspaceId/fileData
  // are set by the first generation's done event.
  const onGenerate =
    workspaceId && fileData ? handleImprove : handleGenerate;

  return (
    <>
      {/* Mobile blocker — visible only on small screens */}
      <div className="md:hidden">
        <MobileBlocker />
      </div>

      {/* Workspace — visible only on md+ screens */}
      <div className="hidden md:flex h-[calc(100vh-3.5rem)] overflow-hidden bg-[#0a0a0a]">
        {!focusMode && (
          <ChatPanel
            isImproving={isImproving}
            messages={messages}
            isGenerating={isGenerating}
            statusLog={statusLog}
            credits={credits}
            initialPrompt={initialPrompt}
            onGenerate={onGenerate}
            onRegenerate={handleRegenerate}
            onEditMessage={handleEditMessage}
            onStop={handleStop}
            userId={userId}
            workspaceId={workspaceId}
            appTitle={fileData?.title ?? workspace?.title ?? null}
            width={chatWidth}
          />
        )}
        {!focusMode && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chat panel"
            title="Drag to resize"
            onPointerDown={handleDividerPointerDown}
            onPointerMove={handleDividerPointerMove}
            onPointerUp={handleDividerPointerUp}
            className="w-1.5 shrink-0 cursor-col-resize bg-white/6 transition-colors hover:bg-violet-500/40 active:bg-violet-500/60 touch-none"
          />
        )}
        <CodePanel
          fileData={fileData}
          isGenerating={isGenerating}
          statusLog={statusLog}
          onFixError={handleFixError}
          appTitle={fileData?.title ?? workspace?.title ?? null}
          isImproving={isImproving}
          versions={versions}
          versionsLoading={versionsLoading}
          onRestoreVersion={handleRestoreVersion}
          focusMode={focusMode}
          onToggleFocusMode={() => setFocusMode((v) => !v)}
          workspaceId={workspaceId}
          githubConnected={githubConnected}
          githubUsername={githubUsername}
          lastPush={lastPush}
          onPushed={setLastPush}
          onGithubConnectionChange={(connected, username) => {
            setGithubConnected(connected);
            setGithubUsername(username);
          }}
        />
      </div>
    </>
  );
}