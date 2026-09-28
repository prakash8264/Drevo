import arcjet, { detectBot, shield } from "@arcjet/next";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isProtectedRoute = createRouteMatcher([
  "/workspace(.*)",
  "/projects(.*)",
]);

// ─── Global Arcjet client ─────────────────────────────────────────────────────
// Runs on every request. Looser than the route-level client — allows search
// engines and link previews so the landing page gets indexed and
// Slack/Twitter unfurls work.

const aj = arcjet({
  key: process.env.ARCJET_KEY!,
  rules: [
    shield({ mode: "LIVE" }),
    detectBot({
      mode: "LIVE",
      allow: ["CATEGORY:SEARCH_ENGINE", "CATEGORY:PREVIEW"],
    }),
  ],
});

export default clerkMiddleware(async (auth, req) => {
  // Local development (npm run dev) serves from a loopback host whose client
  // IP is 127.0.0.1. Arcjet has no reputation data for loopback IPs and
  // denies these requests, so localhost gets {"error":"Forbidden"} while the
  // same request with a public IP passes. Skip Arcjet for loopback hosts
  // only — Clerk auth below still applies, and every non-localhost host
  // (staging, production) always goes through Arcjet.
  const host = req.headers.get("host") ?? "";
  const isLocalhost =
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1") ||
    host.startsWith("[::1]");

  if (!isLocalhost) {
    const decision = await aj.protect(req);
    if (decision.isDenied()) {
      console.warn(
        "[proxy] Arcjet denied request:",
        decision.conclusion,
        JSON.stringify(decision.reason)
      );
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // Clerk auth guard — redirect unauthenticated users away from /workspace
  const { userId } = await auth();

  if (!userId && isProtectedRoute(req)) {
    const { redirectToSignIn } = await auth();
    return redirectToSignIn();
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};