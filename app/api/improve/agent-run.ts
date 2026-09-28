import { streamText, stepCountIs, hasToolCall } from "ai";
import type { LanguageModel } from "ai";
import type { ImproveTools } from "./agent-tools";
import {
  getRetryAfterHeader,
  isOverloadedError,
  isQuotaError,
  MaxIterationsError,
  streamErrorText,
} from "./errors";

const MAX_ATTEMPTS = 3;

function sleepOrAbort(
  signal: AbortSignal,
  ms: number
): Promise<"slept" | "aborted"> {
  // Sleep that wakes early on client abort (Stop button / navigation).
  return new Promise<"slept" | "aborted">((resolve) => {
    if (signal.aborted) return resolve("aborted");
    const timer = setTimeout(() => resolve("slept"), ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve("aborted");
      },
      { once: true }
    );
  });
}

// 2s, 4s, 8s (capped) + up to 1s jitter.
function backoffMs(attempt: number): number {
  return (
    Math.min(8000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 1000)
  );
}

export interface AgentRunArgs {
  model: LanguageModel;
  modelLabel: string;
  instructions: string;
  input: string;
  tools: ImproveTools;
  abortSignal: AbortSignal;
  // Fresh accumulation each attempt (the route implements this against its
  // locals): a shed stream may have applied partial tool updates (and
  // emitted file_patch events) that must not leak into the next attempt.
  resetRunState: () => void;
  // True when the client went away — stop everything, no further attempts.
  shouldStop: () => boolean;
  enqueue: (type: string, payload: object) => void;
}

// Runs the tool loop with shed-tolerance: Google/OpenRouter 503s and 429s
// arrive at call time and mid-stream. Overload-shaped failures retry (fresh
// buffer each time — partial JSON is unusable); quota failures convert
// straight to honest partial-or-free handling (every attempt burns quota
// units, so quota never retries). Aborts return null immediately.
// Resolves { steps, finalText, streamError } for classification, or null.
// (Return type is inferred so the route's Awaited<ReturnType<…>> keeps
// working without importing AI SDK step internals.)
export async function runAgentWithRetries(args: AgentRunArgs) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    args.resetRunState();
    // Declared BEFORE the try (not beside the loop): the catch below reads
    // both, and anything throwing above their declaration — e.g. streamText()
    // itself — would otherwise crash the catch with a temporal-dead-zone
    // ReferenceError, masking the real error and killing retries on
    // attempt 1. Tracks whether any part arrived (at-call vs mid-stream).
    let sawChunks = false;
    let streamError: unknown = null;
    try {
      // streamText runs the tool loop: each step the model either calls
      // tools (loop continues) or writes text / hits a stopWhen condition
      // (loop ends).
      // - instructions: the system prompt (v7 renamed `system`).
      // - toolChoice "required": the model must use tools every step.
      // - stopWhen: end after 12 steps OR as soon as done_improving runs.
      // - abortSignal: Stop/navigation cancels the model call too.
      // - maxRetries 0: the SDK must NOT retry internally — this envelope
      //   is the sole retry authority (honest logging, user-visible status,
      //   backoff). SDK-internal retries silently multiplied requests
      //   against throttled pools (3 sub-attempts × 3 attempts).
      const result = streamText({
        model: args.model,
        instructions: args.instructions,
        prompt: args.input,
        tools: {
          update_file: args.tools.updateFileTool,
          add_dependency: args.tools.addDependencyTool,
          done_improving: args.tools.doneImprovingTool,
        },
        toolChoice: "required",
        stopWhen: [stepCountIs(12), hasToolCall("done_improving")],
        abortSignal: args.abortSignal,
        maxRetries: 0,
      });

      // Forward the model stream to the chat panel: text deltas become live
      // "thinking" text, tool calls become friendly "Updating …" notices.
      // Tool results need no forwarding — update_file already emitted
      // file_patch inside its execute. Error parts are captured, never
      // silently ignored, so classification names the true cause.
      for await (const part of result.fullStream) {
        if (args.shouldStop()) break;
        sawChunks = true;
        if (part.type === "text-delta" && part.text) {
          args.enqueue("thinking", { text: part.text });
        } else if (part.type === "error") {
          streamError = (part as { error?: unknown }).error ?? part;
        } else if (part.type === "tool-call") {
          if (part.toolName === "update_file") {
            const path =
              (part.input as { path?: string } | undefined)?.path ?? "a file";
            args.enqueue("thinking", { text: `\n\nUpdating \`${path}\`…` });
          } else if (part.toolName === "add_dependency") {
            const pkg =
              (part.input as { package?: string } | undefined)?.package ??
              "a package";
            args.enqueue("thinking", { text: `\n\nAdding \`${pkg}\`…` });
          } else if (part.toolName === "done_improving") {
            args.enqueue("thinking", { text: "\n\nFinalizing changes…" });
          }
        }
      }

      if (args.shouldStop()) return null;
      const steps = await result.steps;
      const finalText = await result.text;
      return { steps, finalText, streamError };
    } catch (streamErr) {
      const last = attempt === MAX_ATTEMPTS;
      console.error(
        `[improve:${args.modelLabel}] attempt ${attempt}/${MAX_ATTEMPTS} failed (${sawChunks ? "mid-stream" : "at-call"}):`,
        streamErr
      );
      if (args.shouldStop()) return null;
      // Transport-level death (e.g. NoOutputGeneratedError) with a captured
      // error part: the stream, not the budget, killed the run — classify
      // honestly instead of retrying blindly or erroring generic.
              if (streamError !== null && isQuotaError(streamError)) {
                throw new MaxIterationsError(
                  "quota",
                  streamErrorText(streamError),
                  getRetryAfterHeader(streamError)
                );
              }
      if (streamError !== null && isOverloadedError(streamError)) {
        throw new MaxIterationsError(
          "overload",
          streamErrorText(streamError)
        );
      }
      if (!isOverloadedError(streamErr) || last) throw streamErr;
      args.enqueue("status", {
        message: `Model busy — retrying… (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
      });
      if (
        (await sleepOrAbort(args.abortSignal, backoffMs(attempt))) ===
        "aborted"
      )
        return null;
    }
  }
  throw new Error("Improve failed");
}
