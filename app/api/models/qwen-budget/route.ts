import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

// Free-model daily budget for the Qwen toggle, read server-side so the
// OpenRouter key never reaches the browser. Shape confirmed live against
// GET /api/v1/key: { data: { limit, limit_remaining, ... } }.
// Cached ~60s in-module so checking the budget never meaningfully spends it.
interface BudgetCache {
  at: number;
  payload: { configured: boolean; remaining: number | null; limit: number | null };
}

let cache: BudgetCache | null = null;
const CACHE_MS = 60_000;

export async function GET() {
  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });

  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) return NextResponse.json({ configured: false });

  if (cache && Date.now() - cache.at < CACHE_MS) {
    return NextResponse.json(cache.payload);
  }

  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`key endpoint ${res.status}`);
    const data = (await res.json()) as {
      data?: { limit?: number | null; limit_remaining?: number | null };
    };
    const payload = {
      configured: true,
      remaining:
        typeof data?.data?.limit_remaining === "number"
          ? data.data.limit_remaining
          : null,
      limit:
        typeof data?.data?.limit === "number" ? data.data.limit : null,
    };
    cache = { at: Date.now(), payload };
    return NextResponse.json(payload);
  } catch (err) {
    console.error("[models/qwen-budget] failed:", err);
    // Fail open with unknown numbers rather than breaking the chat UI.
    return NextResponse.json({ configured: true, remaining: null, limit: null });
  }
}
