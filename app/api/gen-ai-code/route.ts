import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { db } from "@/lib/prisma";
import { CREDIT_COST_PER_GENERATION } from "@/lib/constants";
import type { Message, FileData } from "@/types/workspace";
import { GenerateRequestSchema, GeneratedOutputSchema, readAiBody, protectAi, acquireAiLease, aiErrorMessage, validateApp } from "@/lib/ai-request";
import { saveAiWorkspace } from "@/lib/workspace-save";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

// ─── SSE helper ───────────────────────────────────────────────────────────────

function sseEvent(type: string, payload: unknown): string {
  return `data: ${JSON.stringify({ type, ...(payload as object) })}\n\n`;
}

// ─── Quota helpers ────────────────────────────────────────────────────────────
// Detect Gemini free-tier / rate-limit errors so we can send a friendly SSE
// error (with retryAfter) instead of leaking raw Google text.

function getQuotaRetryAfter(message: string): number | null {
  const m = message.match(/retry in ([\d.]+)s/i);
  if (m) {
    const secs = Math.ceil(parseFloat(m[1]));
    return Number.isFinite(secs) ? secs : null;
  }
  return null;
}

function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /quota|exceed.*current quota|generate_content_free_tier|rate.limit|rate_limit|429|resource exhausted/i.test(
    msg
  );
}

function quotaErrorPayload(err: unknown): Record<string, unknown> {
  const raw = err instanceof Error ? err.message : "Quota exceeded";
  const retryAfter = getQuotaRetryAfter(raw);
  return {
    message: retryAfter
      ? `Gemini free-tier limit hit. Please retry in ~${retryAfter}s. Consider upgrading your Gemini plan for higher limits.`
      : "Gemini free-tier limit hit. Please wait a bit and try again. Consider upgrading your Gemini plan for higher limits.",
    code: "QUOTA_EXCEEDED",
    ...(retryAfter !== null ? { retryAfter } : {}),
  };
}

// ─── Model-overload detection ─────────────────────────────────────────────────
// Distinct from quota: Google answers 503 UNAVAILABLE ("high demand") when the
// model itself is saturated. Same handling otherwise — friendly retriable
// error, no credit deducted (thrown before the DB transaction either way).
// The ApiError in the log carries status: 503 plus the UNAVAILABLE body.

function isOverloadedError(err: unknown): boolean {
  const status =
    (err as { status?: number })?.status ??
    (err as { statusCode?: number })?.statusCode;
  if (status === 503) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /unavailable|overloaded|high demand|try again later|capacity|\b503\b/i.test(
    msg
  );
}

function overloadErrorPayload(): Record<string, unknown> {
  return {
    message:
      "The AI model is experiencing high demand right now. Please wait a bit and try again — no credits were deducted.",
    code: "MODEL_OVERLOADED",
  };
}

// ─── Extract short label from a Gemini thought chunk ─────────────────────────
// Gemini thoughts often start with a bold heading like **Verify Config**
// We extract that. If no bold heading, take the first sentence only.

function extractThoughtLabel(text: string): string | null {
  // Try to grab **bold heading** at the start
  const boldMatch = text.match(/\*\*([^*]{4,60})\*\*/);
  if (boldMatch) return boldMatch[1].trim();

  // Fall back to first sentence (up to first . or \n), capped at 60 chars
  const sentence = text.split(/[.\n]/)[0].trim();
  if (sentence.length >= 8 && sentence.length <= 80) return sentence;

  return null;
}

// ─── npm validation ───────────────────────────────────────────────────────────

async function validateDependencies(
  deps: Record<string, string>
): Promise<Record<string, string>> {
  const valid: Record<string, string> = {};
  await Promise.all(
    Object.entries(deps).map(async ([pkg, version]) => {
      try {
        const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
          signal: AbortSignal.timeout(1500),
        });
        if (res.ok) valid[pkg] = version;
      } catch {
        // silently skip hallucinated packages
      }
    })
  );
  return valid;
}

// ─── History trimming ─────────────────────────────────────────────────────────

function trimHistory(messages: Message[]): Message[] {
  if (messages.length <= 10) return messages;
  return [messages[0], ...messages.slice(-8)];
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert React developer. Your job is to generate complete, working React applications based on user prompts.

RULES:
1. Always respond with a valid JSON object — no markdown fences, no extra text.
2. The JSON must match this exact shape:
{
  "assistantMessage": "<brief explanation of what you built/changed>",
  "title": "<short 2-4 word title for the app, e.g. 'Todo List App'>",
  "files": {
    "/App.js": { "code": "<full file content>" },
    "/components/SomeComponent.js": { "code": "<full file content>" }
  },
  "dependencies": {
    "some-package": "latest"
  }
}
3. Use React (functional components + hooks). Do NOT use TypeScript in generated files.
4. Use Tailwind CSS for all styling. Do not use CSS modules or inline styles unless absolutely necessary.
5. The entry point must always be /App.js and must export a default component.
6. All imports must reference files you include in "files" or packages in "dependencies".
7. Do not include react, react-dom, or tailwindcss in "dependencies" — they are always available.
8. When modifying existing code, include ALL files (both changed and unchanged) in "files".
9. Keep code clean, readable, and production-quality.
10. If the user attaches an image, use it as a design reference and match the layout/style as closely as possible.`;

// ─── Gemini contents builder ──────────────────────────────────────────────────

function buildContents(messages: Message[], fileData: FileData | null) {
  const trimmed = trimHistory(messages);

  return trimmed.map((msg, idx) => {
    const role = msg.role === "assistant" ? "model" : "user";

    if (msg.role === "user") {
      const parts: object[] = [];

      let text = msg.content;

      if (msg.imageUrl) {
        text = `[The user has attached an image. Use this URL directly in the generated app where relevant (as img src, background-image, etc.): ${msg.imageUrl}]\n\n${text}`;
      }

      const isLast = idx === trimmed.length - 1;
      if (isLast && fileData) {
        text +=
          "\n\nCurrent project files for context:\n" +
          JSON.stringify(fileData, null, 2);
      }

      parts.push({ text });
      return { role, parts };
    }

    return { role, parts: [{ text: msg.content }] };
  });
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return Response.json({ message: "Unauthorized" }, { status: 401 });
  }

  const disconnected = new AbortController();
  const signal = AbortSignal.any([request.signal, disconnected.signal, AbortSignal.timeout(290000)]);
  const body = await readAiBody(request).catch(() => null);
  const input = GenerateRequestSchema.safeParse(body);
  if (!input.success) return Response.json({ message: "Invalid generation request" }, { status: 400 });
  const { workspaceId, revision, orgId: requestedOrgId, messages, fileData } = input.data;

  // ── Arcjet: per-user rate limit + prompt-injection screen ────────────────
  // Denials are free friendly refusals (no credit, no agent run).
  // detectPromptInjectionMessage requires the actual user text to inspect.

  const lastUserMessage =
    [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const denied = await protectAi(request, body, clerkId, lastUserMessage);
  if (denied) return denied;

  const user = await db.user.findUnique({
    where: { clerkId },
    select: {
      id: true,
      activeOrganizationId: true,
      memberships: {
        select: {
          role: true,
          organization: {
            select: { id: true, credits: true },
          },
        },
      },
    },
  });

  if (!user || user.memberships.length === 0)
    return Response.json({ message: "User not found" }, { status: 404 });

  // Resolve org: update branch → workspace's org + membership check;
  // create branch → active org + OWNER/ADMIN required.
  let orgId: string;
  if (workspaceId) {
    const ws = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, organizationId: true, revision: true },
    });
    if (!ws?.organizationId)
      return Response.json({ message: "Workspace not found" }, { status: 404 });
    const m = user.memberships.find(
      (x) => x.organization.id === ws.organizationId
    );
    if (!m)
      return Response.json({ message: "Workspace not found" }, { status: 404 });
    orgId = ws.organizationId;
    if (ws.revision !== revision) return Response.json({ message: "Workspace changed. Reload before retrying." }, { status: 409 });
  } else {
    const active =
      user.memberships.find(
        (x) => x.organization.id === user.activeOrganizationId
      ) ?? user.memberships[0];
    if (active.role !== "OWNER" && active.role !== "ADMIN") {
      return Response.json(
        { message: "Only admins can create projects.", code: "FORBIDDEN" },
        { status: 403 }
      );
    }
    orgId = active.organization.id;
    if (orgId !== requestedOrgId) return Response.json({ message: "Organization changed. Reload before creating a project." }, { status: 409 });
  }

  const org = await db.organization.findUnique({
    where: { id: orgId },
    select: { id: true, credits: true },
  });
  if (!org)
    return Response.json({ message: "Organization not found" }, { status: 404 });
  if (org.credits < CREDIT_COST_PER_GENERATION) {
    return Response.json({ message: "Insufficient credits" }, { status: 402 });
  }
  const internalUserId = user.id;
  let release: () => Promise<void>;
  try { release = await acquireAiLease(internalUserId, workspaceId); }
  catch (error) { return Response.json({ message: error instanceof Error ? error.message : "AI request unavailable" }, { status: 409 }); }

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
      signal.addEventListener("abort", safeClose, { once: true });

      // Sleep that wakes early on client abort (Stop button / navigation).
      const sleepOrAbort = (ms: number) =>
        new Promise<"slept" | "aborted">((resolve) => {
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
      // 2s, 4s, 8s (capped) + up to 1s jitter.
      const backoffMs = (attempt: number) =>
        Math.min(8000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 1000);

      try {
        const contents = buildContents(messages, fileData ?? null);

        // ── Retried generation ─────────────────────────────────────────
        // Google sheds load with 503 UNAVAILABLE both at call time and
        // mid-stream (structured-output + thinking streams are held open,
        // then cut — the partial JSON is unusable, so every attempt starts
        // from scratch and emits a status so the wait isn't silent). Only
        // overload-shaped errors retry here; quota errors keep their
        // friendly countdown below, and aborts break out immediately.
        const MAX_ATTEMPTS = 3;
        const runStream = async (modelName: string): Promise<string | null> => {
          for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (closed || signal.aborted) return null;
            // Tracks whether any chunk arrived, so the log can tell an
            // at-call rejection apart from a mid-stream shed.
            let sawChunks = false;
            try {
              const geminiStream = await ai.models.generateContentStream({
                model: modelName,
                contents,
                config: {
                  abortSignal: signal,
                  systemInstruction: SYSTEM_PROMPT,
                  temperature: 0.7,
                  responseMimeType: "application/json",
                  thinkingConfig: {
                    includeThoughts: true,
                  },
                },
              });

              let accumulated = ""; // final JSON output
              let lastEmitTime = 0; // throttle thought emissions

              for await (const chunk of geminiStream) {
                if (closed || signal.aborted) break;
                sawChunks = true;
                const parts = chunk.candidates?.[0]?.content?.parts ?? [];

                for (const part of parts) {
                  if (!part.text) continue;

                  if (part.thought) {
                    // Extract just the short label — not the full wall of text
                    const now = Date.now();
                    if (now - lastEmitTime > 600) {
                      const label = extractThoughtLabel(part.text);
                      if (label) {
                        safeEnqueue(sseEvent("status", { message: label }));
                        lastEmitTime = now;
                      }
                    }
                  } else {
                    // Actual JSON output
                    accumulated += part.text;
                  }
                }
              }

              if (closed || signal.aborted) return null;
              return accumulated;
            } catch (streamErr) {
              const last = attempt === MAX_ATTEMPTS;
              console.error(
                `[gen-ai-code] attempt ${attempt}/${MAX_ATTEMPTS} failed (${sawChunks ? "mid-stream" : "at-call"}):`,
                streamErr
              );
              if (closed || signal.aborted) return null;
              if (!isOverloadedError(streamErr) || last) throw streamErr;
              safeEnqueue(
                sseEvent("status", {
                  message: `Model busy — retrying… (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
                })
              );
              if ((await sleepOrAbort(backoffMs(attempt))) === "aborted")
                return null;
            }
          }
          throw new Error("Generation failed");
        };

        // Primary model first. The optional fallback (GEMINI_FALLBACK_MODEL,
        // empty = disabled) engages only after the primary's own retries are
        // exhausted on overloads — same prompts, same JSON contract.
        let accumulated: string | null;
        try {
          accumulated = await runStream("gemini-3.5-flash");
        } catch (primaryErr) {
          const fallback = process.env.GEMINI_FALLBACK_MODEL?.trim();
          if (
            fallback &&
            isOverloadedError(primaryErr) &&
            !closed &&
            !signal.aborted
          ) {
            console.error(
              `[gen-ai-code] primary exhausted, falling back to ${fallback}`
            );
            safeEnqueue(
              sseEvent("status", {
                message: `Trying fallback model ${fallback}…`,
              })
            );
            accumulated = await runStream(fallback);
          } else {
            throw primaryErr;
          }
        }
        // null = aborted mid-run; the controller is already dead, just exit.
        if (accumulated === null) return;

        // ── Parse the complete JSON response ──────────────────────────────────

        let parsed: {
          assistantMessage: string;
          title?: string;
          files: Record<string, { code: string }>;
          dependencies: Record<string, string>;
        };

        try {
          parsed = GeneratedOutputSchema.parse(JSON.parse(accumulated));
        } catch {
          safeEnqueue(
            sseEvent("error", {
              message: "AI returned an invalid project response. Please try again. No credits were deducted.",
            })
          );
          return;
        }

        const {
          assistantMessage,
          title: aiTitle,
          files,
          dependencies,
        } = parsed;

        validateApp({ files, dependencies, title: aiTitle });

        // ── Validate npm packages ──────────────────────────────────────────────

        safeEnqueue(sseEvent("status", { message: "Validating packages…" }));
        const validatedDeps = await validateDependencies(dependencies ?? {});
        const newFileData: FileData = {
          files,
          dependencies: validatedDeps,
          title: aiTitle,
        };
        signal.throwIfAborted();
        if (closed) return;

        // ── Upsert workspace + deduct ORG credit (single guarded transaction) ──
        // updateMany with credits>=cost makes concurrent spends atomic:
        // only one of two parallel runs on a 1-credit balance commits.

        safeEnqueue(sseEvent("status", { message: "Saving…" }));

        const lastUserMessage = messages[messages.length - 1];
        const updatedMessages: Message[] = [
          ...messages,
          { role: "assistant", content: assistantMessage },
        ];

        const saved = await saveAiWorkspace({
          workspaceId, revision, orgId, userId: internalUserId, signal,
          fileData: newFileData, messages: updatedMessages,
          title: aiTitle ?? lastUserMessage.content.slice(0, 80), summary: assistantMessage,
        });

        // ── Emit final result ──────────────────────────────────────────────────

        safeEnqueue(
          sseEvent("done", {
            ...saved,
            assistantMessage,
            fileData: newFileData,
          })
        );
      } catch (err) {
        console.error("[gen-ai-code] stream error:", err);
        if (isQuotaError(err)) {
          safeEnqueue(sseEvent("error", quotaErrorPayload(err)));
        } else if (isOverloadedError(err)) {
          safeEnqueue(sseEvent("error", overloadErrorPayload()));
        } else {
          safeEnqueue(
            sseEvent("error", {
              message: aiErrorMessage(err),
            })
          );
        }
      } finally {
        await release();
        signal.removeEventListener("abort", safeClose);
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
