// Shared error classification + payloads for the improve route.
// Pure functions (no request state) so they stay unit-testable. The credit
// rule they encode: quota/overload failures are always free; only kept work
// (partial saves) deducts.

export function getQuotaRetryAfter(message: string): number | null {
  const m = message.match(/retry in ([\d.]+)s/i);
  if (m) {
    const secs = Math.ceil(parseFloat(m[1]));
    return Number.isFinite(secs) ? secs : null;
  }
  return null;
}

// Retry-After response header (seconds), e.g. Atria's per-minute RPM caps
// publish exact waits here while the body carries none. Capped at 10 min to
// bound toast durations and any future wait logic. Header names vary by
// provider/SDK layer, so both casings are checked.
export function getRetryAfterHeader(err: unknown): number | null {
  const headers = (err as { responseHeaders?: unknown })?.responseHeaders;
  if (!headers || typeof headers !== "object") return null;
  const raw =
    (headers as Record<string, unknown>)["retry-after"] ??
    (headers as Record<string, unknown>)["Retry-After"];
  const secs =
    typeof raw === "string"
      ? parseInt(raw, 10)
      : typeof raw === "number"
        ? Math.ceil(raw)
        : NaN;
  return Number.isFinite(secs) && secs >= 0 ? Math.min(secs, 600) : null;
}

// Collects searchable text from an error and its nested causes, including
// AI SDK aggregate shapes (AI_RetryError.errors[], .lastError) and numeric
// statuses. A Qwen 429 arrived wrapped exactly this way — flat message
// matching alone could not see it.
export function collectErrorText(err: unknown, depth = 0): string {
  if (depth > 3 || err === null || err === undefined) return "";
  if (typeof err === "string") return err;
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(err.message);
  } else {
    try {
      parts.push(JSON.stringify(err).slice(0, 2000));
    } catch {
      // non-serializable — fall through to structural fields below
    }
  }
  const rec = err as {
    cause?: unknown;
    errors?: unknown;
    lastError?: unknown;
    statusCode?: unknown;
    status?: unknown;
  };
  if (typeof rec.statusCode === "number")
    parts.push(`statusCode ${rec.statusCode}`);
  if (typeof rec.status === "number") parts.push(`status ${rec.status}`);
  if (rec.cause !== undefined)
    parts.push(collectErrorText(rec.cause, depth + 1));
  if (Array.isArray(rec.errors))
    for (const e of rec.errors.slice(0, 5))
      parts.push(collectErrorText(e, depth + 1));
  if (rec.lastError !== undefined)
    parts.push(collectErrorText(rec.lastError, depth + 1));
  return parts.join(" ");
}

export function isQuotaError(err: unknown): boolean {
  // AI SDK v7 surfaces provider failures as typed errors (e.g. AI_APICallError
  // carries statusCode). Check that first, then fall back to deep text
  // matching. Covers Gemini (429) and OpenRouter (429 rate-limit, 402
  // account-credit) shapes.
  const statusCode = (err as { statusCode?: number })?.statusCode;
  if (statusCode === 429 || statusCode === 402) return true;
  return /quota|exceed.*current quota|generate_content_free_tier|rate.limit|rate_limit|429|resource exhausted|insufficient credits|over credit|credit limit/i.test(
    collectErrorText(err)
  );
}

export function quotaErrorPayload(
  err: unknown,
  providerLabel = "Gemini",
  retryAfterHint: number | null = null
): Record<string, unknown> {
  const raw = err instanceof Error ? err.message : "Quota exceeded";
  // Body countdown first ("retry in Xs"), then an explicit hint (e.g. a
  // Retry-After header captured at the throw site), then the error's own
  // response headers as a last resort.
  const retryAfter =
    getQuotaRetryAfter(raw) ?? retryAfterHint ?? getRetryAfterHeader(err);
  // Qwen runs on a shared free pool: point at the escape hatch.
  const switchHint =
    providerLabel === "Qwen" ? " You can switch to Gemini and keep working." : "";
  return {
    message: retryAfter
      ? `${providerLabel} rate limit hit. Please retry in ~${retryAfter}s. No credits were deducted.${switchHint}`
      : `${providerLabel} rate limit hit. Please wait a bit and try again. No credits were deducted.${switchHint}`,
    code: "QUOTA_EXCEEDED",
    ...(retryAfter !== null ? { retryAfter } : {}),
  };
}

// Same distinction as gen-ai-code: 503 UNAVAILABLE means the model is
// saturated, not that quota ran out. AI SDK v7 errors carry statusCode, so
// check that alongside the message text (incl. OpenRouter's no-endpoints /
// gateway phrasings). Free, like quota.
export function isOverloadedError(err: unknown): boolean {
  const status =
    (err as { status?: number })?.status ??
    (err as { statusCode?: number })?.statusCode;
  // 503 = shed load; 500 = gateway failure (notably Zen answering the wrong
  // endpoint or an unhealthy backing model). Both retry the same way and
  // stay free — neither implies anything about the request itself.
  if (status === 503 || status === 500) return true;
  return /unavailable|overloaded|high demand|try again later|capacity|503|no endpoints|temporarily unavailable|bad gateway|gateway timeout|internal server error/i.test(
    collectErrorText(err)
  );
}

export function overloadErrorPayload(
  providerLabel = "The AI model"
): Record<string, unknown> {
  return {
    message:
      `${providerLabel} is experiencing high demand right now. Please wait a bit and try again. No credits were deducted.`,
    code: "MODEL_OVERLOADED",
  };
}

export class MaxIterationsError extends Error {
  // Why the run ended without completion: exhausted step budget ("steps"),
  // a mid-stream rate-limit error part ("quota"), or a mid-stream overload
  // error part ("overload"). The catch below words the partial note honestly
  // from this instead of always blaming the step budget. `detail` carries
  // the raw stream-error text for quota payloads (retry countdowns);
  // `retryAfter` carries a Retry-After header value when one was present.
  reason: "steps" | "quota" | "overload";
  detail?: string;
  retryAfter?: number | null;
  constructor(
    reason: "steps" | "quota" | "overload" = "steps",
    detail?: string,
    retryAfter?: number | null
  ) {
    super("Agent runtime exceeded maxIterations");
    this.name = "MaxIterationsError";
    this.reason = reason;
    this.detail = detail;
    this.retryAfter = retryAfter;
  }
}

// Best-effort text out of a captured stream error part (v7 shape
// {type: "error", error} where error may be a string, Error, or object).
export function streamErrorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e ?? "").slice(0, 500);
  } catch {
    return "";
  }
}
