import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { db } from "@/lib/prisma";
import { CREDIT_COST_PER_GENERATION } from "@/lib/constants";
import type { FileData, Message, EditModelId } from "@/types/workspace";
import {
  getRetryAfterHeader,
  isOverloadedError,
  isQuotaError,
  MaxIterationsError,
  overloadErrorPayload,
  quotaErrorPayload,
  streamErrorText,
} from "./errors";
import {
  notConfiguredResponse,
  resolveGeminiModel,
  resolveImproveModel,
  type ResolvedImproveModel,
} from "./models";
import { createImproveTools } from "./agent-tools";
import {
  buildAgentInput,
  buildAgentInstructions,
  buildFileContext,
} from "./agent-prompts";
import { createFinishRun, diffPaths } from "./agent-finish";
import { runAgentWithRetries } from "./agent-run";

// ─── SSE helper ───────────────────────────────────────────────────────────────
// Kept local: three lines, used by every enqueue site below.

function sseEvent(type: string, payload: object): string {
  return `data: ${JSON.stringify({ type, ...payload })}\n\n`;
}

// ─── Route ────────────────────────────────────────────────────────────────────
// Orchestration only: guards → model resolution → tool/prompt/finish wiring
// → retried agent run → outcome classification → error mapping. The agent
// engine lives in agent-run.ts, tools in agent-tools.ts, prompts in
// agent-prompts.ts, persistence in agent-finish.ts, error taxonomy in
// errors.ts, and providers in models/.

export async function POST(request: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId)
    return Response.json({ message: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const {
    userId,
    workspaceId,
    userRequest,
    imageUrl,
    messages,
    fileData,
    model: requestedModel,
  } = body as {
    userId: string;
    workspaceId: string;
    userRequest: string; // what the user wants changed (2nd+ chat prompt)
    imageUrl?: string; // optional screenshot / reference image
    messages?: Message[]; // full conversation incl. new user message
    fileData: FileData;
    // Edit-model toggle from the chat panel. Validated to an allowlist
    // below — a raw client model string is never passed to any provider.
    model?: string;
  };

  // Only these edit models exist. Anything else (missing, tampered) falls
  // back to Gemini, which is also the toggle default.
  const editModel: EditModelId =
    requestedModel === "qwen" || requestedModel === "atria"
      ? requestedModel
      : "gemini";

  if (!workspaceId || !userRequest?.trim() || !fileData?.files) {
    return Response.json(
      { message: "workspaceId, userRequest and fileData are required" },
      { status: 400 }
    );
  }

  // ── Auth + credit check (same 1 credit as generation, all plans) ──────────

  const user = await db.user.findUnique({
    where: { id: userId, clerkId },
    select: { id: true, credits: true, plan: true },
  });

  if (!user)
    return Response.json({ message: "User not found" }, { status: 404 });

  if (user.credits < CREDIT_COST_PER_GENERATION)
    return Response.json({ message: "Insufficient credits" }, { status: 402 });

  // ── Build the agent ────────────────────────────────────────────────────────

  // Resolve the toggle-selected edit model up front so a misconfigured
  // path fails fast with a clean 400 — no stream, no credit touch, and the
  // toggle always stays honored (no silent substitution).
  let selected: ResolvedImproveModel;
  try {
    selected = resolveImproveModel(editModel);
  } catch (resolveErr) {
    if (resolveErr instanceof Error && resolveErr.message.endsWith("_NOT_CONFIGURED")) {
      const payload = notConfiguredResponse(editModel);
      return Response.json(
        { message: payload.message, code: payload.code },
        { status: 400 }
      );
    }
    throw resolveErr;
  }
  // Short provider name for user-facing error payloads below.
  const providerShort = selected.short;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const safeClose = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed / cancelled — ignore
        }
      };

      // If the client aborts (Stop button / navigation), stop enqueueing.
      request.signal.addEventListener("abort", safeClose);

      // Accumulate file patches + new deps as the agent calls tools.
      // These exact objects are shared with the tools factory and the
      // finish factory below (mutated in place, never replaced).
      const patchedFiles: Record<string, { code: string }> = {
        ...fileData.files,
      };
      const patchedDependencies: Record<string, string> = {
        ...fileData.dependencies,
      };
      let finalSummary = "";

      const tools = createImproveTools(
        {
          files: patchedFiles,
          dependencies: patchedDependencies,
          setSummary: (s) => {
            finalSummary = s;
          },
        },
        (path, code, reason) =>
          safeEnqueue(sseEvent("file_patch", { path, code, reason }))
      );

      // Serialize current files for context — the agent needs to know
      // exactly what it's working with.
      const fileContext = buildFileContext(fileData.files);
      const agentInstructions = buildAgentInstructions({
        installedDependencies:
          Object.keys(patchedDependencies).join(", ") || "none",
        fileContext,
      });

      // ── Shared finish: validate deps + save messages/fileData + done ──
      // Defined before try so both the success path and the catch
      // (partial save on maxIterations) can use it. Both deduct 1 credit.
      const finishRun = createFinishRun({
        workspaceId,
        userId,
        userRequest,
        imageUrl,
        messages,
        baseFileData: fileData,
        userCredits: user.credits,
        getState: () => ({
          files: patchedFiles,
          dependencies: patchedDependencies,
        }),
        enqueueDone: (payload) => safeEnqueue(sseEvent("done", payload)),
      });

      // Which files actually changed vs what the run started with?
      // (covers edited paths and newly added ones)
      const getChangedPaths = (): string[] =>
        diffPaths(patchedFiles, fileData.files);

      // Fresh accumulation each attempt: a shed stream may have applied
      // partial tool updates (and emitted file_patch events) that must not
      // leak into the next attempt.
      const resetRunState = () => {
        for (const k of Object.keys(patchedFiles)) delete patchedFiles[k];
        Object.assign(patchedFiles, fileData.files);
        for (const k of Object.keys(patchedDependencies))
          delete patchedDependencies[k];
        Object.assign(patchedDependencies, fileData.dependencies);
        finalSummary = "";
      };

      try {
        // ── Agent input: history + image ref + current request ─────────────
        // This is the hybrid edit path — file context is already in the
        // instructions, so here we give conversation + intent.
        safeEnqueue(sseEvent("status", { message: "Agent working…" }));
        const agentInput = buildAgentInput({
          messages,
          imageUrl,
          userRequest,
        });

        // Selected model first (toggle choice, default Gemini). The optional
        // Gemini fallback (GEMINI_FALLBACK_MODEL, empty = disabled) engages
        // only on the Gemini path after its own retries are exhausted on
        // overloads — same instructions, prompt, and tools. No cross-model
        // fallback: the toggle choice is always honored.
        let run: Awaited<ReturnType<typeof runAgentWithRetries>> | null;
        try {
          run = await runAgentWithRetries({
            model: selected.model,
            modelLabel: selected.label,
            instructions: agentInstructions,
            input: agentInput,
            tools,
            abortSignal: request.signal,
            resetRunState,
            shouldStop: () => closed || request.signal.aborted,
            enqueue: (type, payload) => safeEnqueue(sseEvent(type, payload)),
          });
        } catch (primaryErr) {
          const fallback = process.env.GEMINI_FALLBACK_MODEL?.trim();
          if (
            editModel === "gemini" &&
            fallback &&
            isOverloadedError(primaryErr) &&
            !closed &&
            !request.signal.aborted
          ) {
            console.error(
              `[improve] primary exhausted, falling back to ${fallback}`
            );
            safeEnqueue(
              sseEvent("status", {
                message: `Trying fallback model ${fallback}…`,
              })
            );
            const fallbackModel = resolveGeminiModel(fallback);
            run = await runAgentWithRetries({
              model: fallbackModel.model,
              modelLabel: `Gemini fallback (${fallback})`,
              instructions: agentInstructions,
              input: agentInput,
              tools,
              abortSignal: request.signal,
              resetRunState,
              shouldStop: () => closed || request.signal.aborted,
              enqueue: (type, payload) =>
                safeEnqueue(sseEvent(type, payload)),
            });
          } else {
            throw primaryErr;
          }
        }
        // null = aborted mid-run; the controller is already dead, just exit.
        if (run === null) return;
        const { steps, finalText, streamError } = run;

        // ── Classify the outcome ───────────────────────────────────────────
        // The AI SDK loop ends without calling done_improving when the step
        // budget trips, the model ends with text instead of the completion
        // tool, or a mid-stream error part killed the run. Name the true
        // cause: a captured quota/overload error part outranks the generic
        // budget-exhausted case, so the partial note below stays honest.
        const doneCalled = steps.some((step) =>
          (step.toolCalls ?? []).some(
            (call) => call.toolName === "done_improving"
          )
        );
        if (!doneCalled) {
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
          throw new MaxIterationsError();
        }

        // No-op short-circuit: refusals, answers, and chit-chat change no
        // files and cost no credit. The authoritative credits value below
        // corrects the client's optimistic -1 back up.
        const runChangedPaths = getChangedPaths();
        const runDepsChanged =
          JSON.stringify(patchedDependencies) !==
          JSON.stringify(fileData.dependencies);
        if (runChangedPaths.length === 0 && !runDepsChanged) {
          const noOpSummary = finalSummary || finalText || "Done.";
          safeEnqueue(
            sseEvent("done", {
              fileData,
              summary: noOpSummary,
              partial: false,
              creditsRemaining: user.credits,
            })
          );
          return;
        }

        await finishRun(finalSummary || finalText || "Done.", false);
      } catch (err) {
        console.error(`[improve:${selected.label}] error:`, err);
        if (isQuotaError(err)) {
          safeEnqueue(
            sseEvent("error", quotaErrorPayload(err, providerShort))
          );
        } else if (isOverloadedError(err)) {
          safeEnqueue(
            sseEvent(
              "error",
              overloadErrorPayload(
                providerShort === "Gemini" ? "The AI model" : providerShort
              )
            )
          );
        } else if (err instanceof MaxIterationsError) {
          // Run ended without completion. If the agent already completed
          // file updates, keep them (partial save, 1 credit deducted like a
          // normal run) so the user can ask to continue instead of starting
          // over. If nothing changed, fall through to the free friendly
          // error. The note names the true cause from err.reason instead of
          // always blaming the step budget.
          const changedPaths = getChangedPaths();
          const depsChanged =
            JSON.stringify(patchedDependencies) !==
            JSON.stringify(fileData.dependencies);
          const updatedList =
            changedPaths.length > 0
              ? changedPaths.map((p) => `\`${p}\``).join(", ")
              : "dependencies";
          if (changedPaths.length > 0 || depsChanged) {
            try {
              // Cause-honest note; provider-aware for the rate-limit case.
              const rateLimitLead =
                err.reason === "quota"
                  ? `I applied part of your request before hitting ${providerShort}'s rate limit. `
                  : err.reason === "overload"
                    ? `I applied part of your request before ${providerShort === "Gemini" ? "the model" : providerShort} became overloaded. `
                    : "I applied part of your request before running out of steps. ";
              const partialNote =
                rateLimitLead +
                `Updated: ${updatedList}. ` +
                "Ask me to continue with the rest. If the preview shows errors, that's expected mid-overhaul — ask me to continue or use Fix with AI." +
                (finalSummary ? `\n\nProgress so far: ${finalSummary}` : "");
              await finishRun(partialNote, true);
            } catch (saveErr) {
              console.error("[improve] partial save failed:", saveErr);
              safeEnqueue(
                sseEvent("error", {
                  message:
                    "This edit was too large to finish in one go. Try a smaller, more specific request (one section at a time). No credits were deducted.",
                  code: "MAX_ITERATIONS",
                })
              );
            }
          } else if (err.reason === "quota") {
            // Rate limit stopped an empty run: free, with countdown from the
            // captured detail, the throw-site header value, or the error.
            safeEnqueue(
              sseEvent(
                "error",
                quotaErrorPayload(
                  new Error(err.detail || "Quota exceeded"),
                  providerShort,
                  err.retryAfter ?? null
                )
              )
            );
          } else if (err.reason === "overload") {
            safeEnqueue(
              sseEvent(
                "error",
                overloadErrorPayload(
                  providerShort === "Gemini" ? "The AI model" : providerShort
                )
              )
            );
          } else {
            safeEnqueue(
              sseEvent("error", {
                message:
                  "This edit was too large to finish in one go. Try a smaller, more specific request (one section at a time). No credits were deducted.",
                code: "MAX_ITERATIONS",
              })
            );
          }
        } else {
          safeEnqueue(
            sseEvent("error", {
              message:
                err instanceof Error ? err.message : "Something went wrong.",
            })
          );
        }
      } finally {
        safeClose();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export const runtime = "nodejs";
export const maxDuration = 300; // for vercel - 300s on Fluid
