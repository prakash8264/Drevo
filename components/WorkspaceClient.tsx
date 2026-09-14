// WorkspaceClient.tsx
"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { ChatPanel } from "./ChatPanel";
import { CodePanel } from "./CodePanel";
import { MobileBlocker } from "./MobileBlocker";
import { MIN_CREDITS_TO_GENERATE } from "@/lib/constants";
import { toast } from "sonner";
import type {
  Message,
  FileData,
  StatusStep,
  WorkspaceData,
} from "@/types/workspace";

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
  const [isGenerating, setIsGenerating] = useState(false);
  const [statusLog, setStatusLog] = useState<StatusStep[]>([]);
  const [isImproving, setIsImproving] = useState(false);

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

  const handleGenerate = useCallback(
    async (prompt: string, imageUrl?: string) => {
      if (isGenerating) return;
      if (credits < MIN_CREDITS_TO_GENERATE) return;

      const userMessage: Message = {
        role: "user",
        content: prompt,
        ...(imageUrl ? { imageUrl } : {}),
      };

      const currentMessages = messagesRef.current;
      const currentWorkspaceId = workspaceIdRef.current;

      setMessages((prev) => [...prev, userMessage]);
      setIsGenerating(true);
      setStatusLog([{ label: "Thinking…", status: "running" }]);

      // Create a fresh AbortController for this request
      const abortController = new AbortController();
      generateAbortRef.current = abortController;

      try {
        const conversationHistory = [...currentMessages, userMessage];

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
          return;
        }
        if (res.status === 429) {
          toast.error("Too many requests. Please slow down.");
          setMessages((prev) => prev.slice(0, -1));
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
              if (typeof event.creditsRemaining === "number")
                setCredits(event.creditsRemaining);
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
        if (err instanceof Error && err.name === "AbortError") {
          setMessages((prev) => prev.slice(0, -1));
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
        setMessages((prev) => prev.slice(0, -1));
      } finally {
        generateAbortRef.current = null;
        setIsGenerating(false);
        setStatusLog([]);
      }
    },
    // fileData intentionally omitted — read via fileDataRef
    [credits, isGenerating, userId]
  );

  // Hybrid edit path — 2nd+ chat prompt, screenshot re-send, Fix-with-AI.
  // First prompt (no workspace/fileData yet) still uses handleGenerate.
  const handleImprove = useCallback(
    async (userRequest: string, imageUrl?: string) => {
      if (isGenerating || isImproving) return;
      if (credits < MIN_CREDITS_TO_GENERATE) return;
      if (!workspaceIdRef.current) return;

      // Read fileData from ref — never stale, never causes recreating this fn
      const currentFileData = fileDataRef.current;
      if (!currentFileData) return;

      const userMessage: Message = {
        role: "user",
        content: userRequest,
        ...(imageUrl ? { imageUrl } : {}),
      };
      const conversationHistory = [...messagesRef.current, userMessage];

      setIsImproving(true);

      setMessages((prev) => [
        ...prev,
        userMessage,
        { role: "assistant", content: "" }, // placeholder, updated live
      ]);

      // Create a fresh AbortController for this request
      const abortController = new AbortController();
      improveAbortRef.current = abortController;

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
          setMessages((prev) => prev.slice(0, -2));
          return;
        }
        if (res.status === 402) {
          toast.error("Not enough credits.");
          setMessages((prev) => prev.slice(0, -2));
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
              if (typeof event.creditsRemaining === "number")
                setCredits(event.creditsRemaining);
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
        // User-initiated stop — silently roll back the user + placeholder messages
        if (err instanceof Error && err.name === "AbortError") {
          setMessages((prev) => prev.slice(0, -2));
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
        setMessages((prev) => prev.slice(0, -2));
      } finally {
        improveAbortRef.current = null;
        setIsImproving(false);
      }
    },
    // fileData intentionally omitted — read via fileDataRef above
    [credits, isGenerating, isImproving, userId]
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
        <ChatPanel
          isImproving={isImproving}
          messages={messages}
          isGenerating={isGenerating}
          statusLog={statusLog}
          credits={credits}
          initialPrompt={initialPrompt}
          onGenerate={onGenerate}
          onStop={handleStop}
          userId={userId}
          workspaceId={workspaceId}
          appTitle={fileData?.title ?? workspace?.title ?? null}
        />
        <div className="w-px shrink-0 bg-white/6" />
        <CodePanel
          fileData={fileData}
          isGenerating={isGenerating}
          statusLog={statusLog}
          onFixError={handleFixError}
          appTitle={fileData?.title ?? workspace?.title ?? null}
          isImproving={isImproving}
        />
      </div>
    </>
  );
}