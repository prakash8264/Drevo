"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useUser } from "@clerk/nextjs";
import {
  ArrowUp,
  Paperclip,
  Loader2,
  X,
  Sparkles,
  Wand2,
  Square,
  Copy,
  Pencil,
  RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { Button } from "@/components/ui/button";
import { PricingModal } from "@/components/PricingModal";
import type { Message, StatusStep, EditModelId } from "@/types/workspace";
import { createClient } from "@supabase/supabase-js";
import { BrandTitle } from "./reusables";
import { LogoMark } from "@/components/LogoMark";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

interface ChatPanelProps {
  messages: Message[];
  isGenerating: boolean;
  isImproving: boolean;
  statusLog: StatusStep[];
  credits: number;
  initialPrompt: string | null;
  onGenerate: (prompt: string, imageUrl?: string, model?: EditModelId) => Promise<void>;
  onRegenerate: () => void;
  onEditMessage: (index: number, content: string) => void;
  onStop: () => void;
  orgId: string;
  workspaceId: string | null;
  appTitle: string | null;
  width?: number;
  // Edit-model toggle (follow-up prompts only — first generation is Gemini).
  editModel: EditModelId;
  onEditModelChange: (model: EditModelId) => void;
  // OpenRouter account spending budget (display-only, refreshed by the parent).
  openRouterBudget: {
    configured: boolean;
    remaining: number | null;
    limit: number | null;
  } | null;
}

export function ChatPanel({
  messages,
  isGenerating,
  isImproving,
  statusLog,
  credits,
  initialPrompt,
  onGenerate,
  onRegenerate,
  onEditMessage,
  onStop,
  orgId,
  workspaceId,
  appTitle,
  width,
  editModel,
  onEditModelChange,
  openRouterBudget,
}: ChatPanelProps) {
  const { user } = useUser();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [input, setInput] = useState("");
  const [pendingImageUrl, setPendingImageUrl] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const hasAutoSubmittedRef = useRef(false);
  const noCredits = credits <= 0;
  const isBusy = isGenerating || isImproving;

  const handleCopy = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      toast.success("Copied to clipboard.");
    } catch {
      toast.error("Copy failed. Please try again.");
    }
  };

  const handleEditSave = (index: number) => {
    if (!editDraft.trim() || isBusy) return;
    onEditMessage(index, editDraft);
    setEditingIndex(null);
    setEditDraft("");
  };

  // The last message is the live-streaming assistant placeholder during improve
  const lastMsg = messages[messages.length - 1];
  const isStreamingAssistant = isImproving && lastMsg?.role === "assistant";

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [input]);

  // Auto-scroll on new messages or streaming updates
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, isGenerating, isImproving]);

  useEffect(() => {
    if (!initialPrompt || hasAutoSubmittedRef.current || messages.length > 0)
      return;
    hasAutoSubmittedRef.current = true;
    onGenerate(initialPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = async () => {
    const trimmed = input.trim();
    if (!trimmed || isGenerating || isImproving || noCredits) return;
    setInput("");
    setPendingImageUrl(null);
    // Toggle selection travels along; the router ignores it on the
    // first-prompt generation path (always Gemini) and uses it on edits.
    await onGenerate(trimmed, pendingImageUrl ?? undefined, editModel);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    setIsUploading(true);
    try {
      const ext = file.name.split(".").pop();
      const path = `${orgId}/${workspaceId ?? "new"}/${Date.now()}.${ext}`;
      const { error } = await supabase.storage
        .from("workspace-images")
        .upload(path, file, { upsert: true });
      if (error) throw error;
      const { data } = supabase.storage
        .from("workspace-images")
        .getPublicUrl(path);
      setPendingImageUrl(data.publicUrl);
    } catch {
      // silent
    } finally {
      setIsUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const canSubmit =
    input.trim().length > 0 && !isGenerating && !isImproving && !noCredits;

  return (
    <div
      className="flex h-full shrink-0 flex-col bg-card"
      style={{ width: width ?? 320 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-2 py-3">
        <BrandTitle>{appTitle}</BrandTitle>
        <PricingModal reason={noCredits ? "credits" : "upgrade"}>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] transition-colors",
              noCredits
                ? "bg-red-500/15 text-red-400/80 hover:bg-red-500/25"
                : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            {noCredits
              ? "No credits · Upgrade"
              : `${credits} credit${credits !== 1 ? "s" : ""}`}
          </span>
        </PricingModal>
      </div>

      {/* Messages */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto px-3 py-4 [&::-webkit-scrollbar]:hidden"
      >
        {messages.length === 0 && !isGenerating && (
          <div className="flex h-full items-center justify-center">
            <p className="text-center text-xs text-muted-foreground">
              Describe what you want to build…
            </p>
          </div>
        )}

        <div className="space-y-4">
          {messages.map((msg, i) => {
            const isLast = i === messages.length - 1;
            // This is the live-streaming assistant bubble during improve
            const isLiveStream = isLast && isStreamingAssistant;

            return (
              <div key={i}>
                {msg.role === "user" ? (
                  <div className="group flex items-start justify-end gap-2">
                    <div className="max-w-[85%] space-y-1.5">
                      {msg.imageUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={msg.imageUrl}
                          alt="uploaded"
                          className="max-h-40 w-full rounded-lg object-cover"
                        />
                      )}
                      {editingIndex === i ? (
                        <div className="rounded-2xl rounded-br-sm border border-violet-500/30 bg-muted p-2">
                          <textarea
                            autoFocus
                            value={editDraft}
                            onChange={(e) => setEditDraft(e.target.value)}
                            rows={3}
                            className="w-full resize-none bg-transparent px-1.5 py-1 text-[13px] leading-relaxed text-foreground focus:outline-none"
                          />
                          <div className="flex justify-end gap-1.5 px-1 pb-1">
                            <button
                              onClick={() => {
                                setEditingIndex(null);
                                setEditDraft("");
                              }}
                              className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => handleEditSave(i)}
                              disabled={!editDraft.trim() || isBusy}
                              className="rounded-md bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
                            >
                              Resend
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-2xl rounded-br-sm bg-muted px-3.5 py-2.5">
                          <p className="text-[13px] leading-relaxed text-foreground wrap-break-word">
                            {msg.content}
                          </p>
                        </div>
                      )}
                      {!isBusy && editingIndex !== i && (
                        <div className="flex justify-end opacity-0 transition-opacity group-hover:opacity-100">
                          <button
                            title="Edit and resend"
                            onClick={() => {
                              setEditingIndex(i);
                              setEditDraft(msg.content);
                            }}
                            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            <Pencil className="h-3 w-3" />
                            Edit
                          </button>
                        </div>
                      )}
                    </div>
                    {user?.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={user.imageUrl}
                        alt={user.fullName ?? "You"}
                        className="mt-0.5 h-6 w-6 shrink-0 rounded-full"
                      />
                    ) : (
                      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
                        {user?.firstName?.[0] ?? "U"}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="group flex items-start gap-2">
                    <LogoMark size="sm" className="mt-0.5" />
                    <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm bg-muted/50 px-3.5 py-2.5">
                      {isLiveStream && !msg.content ? (
                        // Empty placeholder — show thinking indicator
                        <div className="flex items-center gap-2">
                          <Wand2 className="h-3 w-3 shrink-0 text-violet-400/60 animate-pulse" />
                          <span className="text-[12px] text-muted-foreground animate-pulse">
                            Thinking…
                          </span>
                        </div>
                      ) : isLiveStream && msg.content ? (
                        // Streaming thinking text — show raw (not markdown)
                        // with a blinking cursor at the end
                        <div>
                          <div className="mb-1.5 flex items-center gap-1.5">
                            <Wand2 className="h-3 w-3 shrink-0 text-violet-400/60" />
                            <span className="text-[10px] font-medium uppercase tracking-wider text-violet-400/50">
                              Reasoning
                            </span>
                          </div>
                          <p className="text-[12px] leading-relaxed text-muted-foreground wrap-break-word">
                            {msg.content}
                            <span className="ml-0.5 inline-block h-3 w-0.5 animate-[blink_1s_ease-in-out_infinite] bg-violet-400/60 align-middle" />
                          </p>
                        </div>
                      ) : (
                        // Normal completed assistant message
                        <div className="prose prose-sm dark:prose-invert max-w-none wrap-break-word text-[13px] leading-relaxed text-foreground/80 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-violet-500 [&_code]:text-xs [&_code]:break-all [&_li]:my-0.5 [&_p]:my-1 [&_pre]:overflow-x-auto! [&_pre]:whitespace-pre-wrap! [&_ul]:my-1">
                          <ReactMarkdown>{msg.content}</ReactMarkdown>
                        </div>
                      )}
                      {!isLiveStream && msg.content && !isBusy && (
                        <div className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                          <button
                            title="Copy response"
                            onClick={() => handleCopy(msg.content)}
                            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            <Copy className="h-3 w-3" />
                            Copy
                          </button>
                          {isLast && (
                            <button
                              title="Regenerate response (1 credit)"
                              disabled={noCredits}
                              onClick={onRegenerate}
                              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                            >
                              <RotateCcw className="h-3 w-3" />
                              Regenerate
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Live status steps — only shown during normal generation */}
          {isGenerating && (
            <div className="flex items-start gap-2">
              <LogoMark size="sm" className="mt-0.5" />
              <div className="rounded-2xl rounded-tl-sm bg-muted/50 px-3.5 py-3">
                <div className="space-y-2">
                  {statusLog.map((step, i) => (
                    <div key={i} className="flex items-center gap-2.5">
                      <div className="flex h-4 w-4 shrink-0 items-center justify-center">
                        {step.status === "running" ? (
                          <Loader2 className="h-3 w-3 animate-spin text-violet-400/80" />
                        ) : (
                          <svg
                            className="h-3 w-3 text-muted-foreground"
                            viewBox="0 0 12 12"
                            fill="none"
                          >
                            <path
                              d="M2 6l3 3 5-5"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </div>
                      <span
                        className={cn(
                          "text-[12px] transition-colors duration-300",
                          step.status === "running"
                            ? "text-foreground"
                            : "text-muted-foreground"
                        )}
                      >
                        {step.label}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* No-credits upgrade banner */}
      {noCredits && (
        <div className="mx-3 mb-2 rounded-xl border border-red-500/15 bg-red-950/40 px-4 py-3">
          <p className="mb-2 text-[12px] font-medium text-red-400/80">
            You&apos;ve used all your credits
          </p>
          <PricingModal reason="credits">
            <span className="inline-flex h-8 items-center gap-1.5 rounded-full text-xs active:scale-95 cursor-pointer bg-primary text-primary-foreground px-3">
              <Sparkles className="h-3 w-3" />
              Upgrade plan
            </span>
          </PricingModal>
        </div>
      )}

      {/* Input */}
      <div className="border-t border-border p-3">
        {pendingImageUrl && (
          <div className="relative mb-2 w-fit">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={pendingImageUrl}
              alt="pending upload"
              className="h-16 w-16 rounded-lg object-cover"
            />
            <button
              onClick={() => setPendingImageUrl(null)}
              className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/80 text-white/60 hover:text-white"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
        )}

        <div
          className={cn(
            "rounded-xl border bg-muted/40 transition-colors",
            isGenerating || isImproving
              ? "border-border"
              : noCredits
              ? "border-border opacity-60"
              : "border-border hover:border-ring"
          )}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isGenerating || isImproving || noCredits}
            placeholder={
              noCredits
                ? "Upgrade to keep building…"
                : isImproving
                ? "Applying agent edits…"
                : isGenerating
                ? "Generating…"
                : "Ask AI to modify…"
            }
            rows={1}
            className="w-full resize-none bg-transparent px-3.5 pb-2 pt-3 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none"
            style={{ maxHeight: 160 }}
          />

          <div className="flex items-center justify-between px-2 pb-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => fileRef.current?.click()}
              disabled={isGenerating || isImproving || isUploading || noCredits}
              className="h-7 w-7 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              {isUploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Paperclip className="h-3.5 w-3.5" />
              )}
            </Button>

            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileChange}
            />

            {/* Edit-model toggle — follow-up prompts only. Shown once the
                workspace exists (first generation is always Gemini). */}
            {workspaceId && (
              <div className="flex flex-col items-center gap-1">
                <div
                  className="flex items-center rounded-md border border-border p-0.5"
                  title="Model used for follow-up edits"
                >
                  {(["gemini", "nemotron", "atria"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => onEditModelChange(m)}
                      disabled={isGenerating || isImproving}
                      title={
                        m === "gemini"
                          ? "Gemini 3.5 Flash (default)"
                          : m === "nemotron"
                            ? "NVIDIA: Nemotron 3 Ultra via OpenRouter (free)"
                            : "Atria Dawn Preview via ATRIA ASI"
                      }
                      className={`rounded px-1.5 py-1 text-[10px] font-medium capitalize transition-colors disabled:opacity-40 ${
                        editModel === m
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {m === "gemini" ? "Gemini" : m === "nemotron" ? "Nemotron" : "Atria"}
                    </button>
                  ))}
                </div>
                {editModel === "atria" && (
                  <span
                    className="max-w-44 text-center text-[10px] leading-snug text-muted-foreground"
                    title="Atria-Dawn-Preview accepts text only: attached screenshots travel as URL text the model cannot view"
                  >
                    Text-only model — screenshots are sent as links it can&apos;t view.
                  </span>
                )}
                {editModel === "nemotron" && (
                  <span
                    className="max-w-52 text-center text-[10px] text-muted-foreground"
                    title="Account-wide spending budget in USD, not a daily free-model request allowance. OpenRouter free-model limits still apply."
                  >
                    {openRouterBudget === null
                      ? "Checking OpenRouter budget…"
                      : !openRouterBudget.configured
                        ? "Add an OpenRouter key to enable Nemotron."
                        : openRouterBudget.remaining === null
                          ? "Nemotron free — OpenRouter limits apply."
                          : `OpenRouter key budget: $${openRouterBudget.remaining.toFixed(2)} remaining.`}
                  </span>
                )}
              </div>
            )}

            {/* Stop button — shown while generating or improving */}
            {isGenerating || isImproving ? (
              <Button
                size="icon"
                onClick={onStop}
                className="h-7 w-7 rounded-lg bg-muted text-muted-foreground hover:bg-accent hover:text-foreground active:scale-95 transition-all"
              >
                <Square className="h-3 w-3 fill-current" />
              </Button>
            ) : (
              <Button
                size="icon"
                onClick={handleSubmit}
                disabled={!canSubmit}
                className={cn(
                  "h-7 w-7 rounded-lg transition-all",
                  canSubmit
                    ? "bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95"
                    : "bg-muted text-muted-foreground shadow-none"
                )}
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
          {isGenerating || isImproving
            ? "Click ■ to stop generation"
            : "⏎ to send · Shift+⏎ for new line"}
        </p>
      </div>
    </div>
  );
}
