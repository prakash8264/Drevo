import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { db } from "@/lib/prisma";
import { CREDIT_COST_PER_GENERATION } from "@/lib/constants";
import type { EditModelId } from "@/types/workspace";
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
import { ImproveRequestSchema, readAiBody, protectAi, acquireAiLease, aiErrorMessage, AI_TIMEOUT_RESPONSE } from "@/lib/ai-request";

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

  const disconnected = new AbortController();
  const signal = AbortSignal.any([request.signal, disconnected.signal, AbortSignal.timeout(290000)]);
  // Stop provider work at four minutes, reserving 50s for validation, the
  // guarded save (15s), history cleanup (15s), and a final SSE response.
  // User/disconnect/hard aborts still cancel persistence through `signal`.
  const modelSignal = AbortSignal.any([signal, AbortSignal.timeout(240000)]);
  const body = await readAiBody(request).catch(() => null);
  const input = ImproveRequestSchema.safeParse(body);
  if (!input.success) return Response.json({ message: "Invalid improvement request" }, { status: 400 });
  const {
    workspaceId,
    revision,
    userRequest,
    imageUrl,
    messages,
    fileData,
    model: requestedModel,
  } = input.data;
  const denied = await protectAi(request, body, clerkId, userRequest);
  if (denied) return denied;

  // Validation rejects unknown models; an omitted model defaults to Gemini.
  const editModel: EditModelId =
    requestedModel === "glm" || requestedModel === "atria"
      ? requestedModel
      : "gemini";

  if (!workspaceId || !userRequest?.trim() || !fileData?.files) {
    return Response.json(
      { message: "workspaceId, userRequest and fileData are required" },
      { status: 400 }
    );
  }

  // ── Auth + org credit check (same 1 credit as generation, all plans) ────

  const dbUser = await db.user.findUnique({
    where: { clerkId },
    select: {
      id: true,
      memberships: {
        select: { role: true, organization: { select: { id: true, credits: true } } },
      },
    },
  });

  if (!dbUser || dbUser.memberships.length === 0)
    return Response.json({ message: "User not found" }, { status: 404 });

  const wsOrg = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { organizationId: true, revision: true },
  });
  if (!wsOrg?.organizationId)
    return Response.json({ message: "Workspace not found" }, { status: 404 });
  const membership = dbUser.memberships.find(
    (m) => m.organization.id === wsOrg.organizationId
  );
  if (!membership)
    return Response.json({ message: "Workspace not found" }, { status: 404 });
  if (wsOrg.revision !== revision) return Response.json({ message: "Workspace changed. Reload before retrying." }, { status: 409 });

  const orgId = wsOrg.organizationId;
  const internalUserId = dbUser.id;

  const orgCreditsRow = await db.organization.findUnique({
    where: { id: orgId },
    select: { credits: true },
  });
  const orgCredits = orgCreditsRow?.credits ?? 0;

  if (orgCredits < CREDIT_COST_PER_GENERATION)
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
  let release: () => Promise<void>;
  try { release = await acquireAiLease(internalUserId, workspaceId); }
  catch (error) { return Response.json({ message: error instanceof Error ? error.message : "AI request unavailable" }, { status: 409 }); }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let completed = false;
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

      const onAbort = () => {
        if (signal.reason?.name === "TimeoutError" && !completed) {
          console.warn(`[improve:${selected.label}] request deadline reached`);
          safeEnqueue(sseEvent("error", AI_TIMEOUT_RESPONSE));
        }
        safeClose();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();

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
        revision,
        orgId,
        userId: internalUserId,
        signal,
        userRequest,
        imageUrl,
        messages,
        baseFileData: fileData,
        getState: () => ({
          files: patchedFiles,
          dependencies: patchedDependencies,
        }),
        enqueueDone: (payload) => {
          safeEnqueue(sseEvent("done", payload));
          completed = true;
        },
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
            abortSignal: modelSignal,
            resetRunState,
            shouldStop: () => closed || signal.aborted,
            enqueue: (type, payload) => safeEnqueue(sseEvent(type, payload)),
          });
        } catch (primaryErr) {
          const fallback = process.env.GEMINI_FALLBACK_MODEL?.trim();
          if (
            editModel === "gemini" &&
            fallback &&
            (isOverloadedError(primaryErr) || (primaryErr instanceof MaxIterationsError && primaryErr.reason === "overload")) &&
            !closed &&
            !signal.aborted
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
              abortSignal: modelSignal,
              resetRunState,
              shouldStop: () => closed || signal.aborted,
              enqueue: (type, payload) =>
                safeEnqueue(sseEvent(type, payload)),
            });
          } else {
            throw primaryErr;
          }
        }
        // null = aborted mid-run; the controller is already dead, just exit.
        if (run === null) return;
        signal.throwIfAborted();
        const { steps, finalText, streamError } = run;
        if (streamError !== null && isQuotaError(streamError)) {
          throw new MaxIterationsError("quota", streamErrorText(streamError), getRetryAfterHeader(streamError));
        }

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
          const currentOrg = await db.organization.findUnique({ where: { id: orgId }, select: { credits: true } });
          safeEnqueue(
            sseEvent("done", {
              fileData,
              summary: noOpSummary,
              partial: false,
              revision,
              creditsRemaining: currentOrg?.credits ?? orgCredits,
            })
          );
          completed = true;
          return;
        }

        await finishRun(finalSummary || finalText || "Done.", false);
      } catch (err) {
        console.error(`[improve:${selected.label}] error:`, err);
        if (err instanceof Error && err.message.endsWith("No credits were deducted.")) {
          safeEnqueue(sseEvent("error", { message: aiErrorMessage(err) }));
        } else if (isQuotaError(err)) {
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
          // Run ended without completion (including the model deadline).
          // If the agent already completed file updates, keep them (partial
          // save, 1 credit deducted like a normal run) so the user can ask
          // to continue instead of starting
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
                    : err.reason === "timeout"
                      ? `I applied part of your request before ${providerShort} reached the time limit. `
                      : "I applied part of your request before running out of steps. ";
              const partialNote =
                rateLimitLead +
                `Updated: ${updatedList}. ` +
                "Ask me to continue with the rest. If the preview shows errors, that's expected mid-overhaul — ask me to continue or use Fix with AI." +
                (finalSummary ? `\n\nProgress so far: ${finalSummary}` : "");
              if (err.reason === "timeout") {
                safeEnqueue(sseEvent("thinking", { text: "\n\nTime limit reached. Saving completed file updates…" }));
              }
              await finishRun(partialNote, true);
            } catch (saveErr) {
              console.error("[improve] partial save failed:", saveErr);
              safeEnqueue(
                sseEvent("error", {
                  message:
                    aiErrorMessage(saveErr),
                  code: err.reason === "timeout" ? "AI_TIMEOUT" : "MAX_ITERATIONS",
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
          } else if (err.reason === "timeout") {
            safeEnqueue(sseEvent("error", {
              message: `${providerShort} took too long to finish this edit. Try a smaller request (one section at a time). No credits were deducted.`,
              code: "AI_TIMEOUT",
            }));
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
                aiErrorMessage(err),
            })
          );
        }
      } finally {
        await release();
        signal.removeEventListener("abort", onAbort);
        safeClose();
      }
    },
    cancel() { disconnected.abort(); },
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
