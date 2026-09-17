import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  GITHUB_OAUTH_STATE_COOKIE,
  GITHUB_WORKSPACE_COOKIE,
  buildAuthorizeUrl,
  newOAuthState,
} from "@/lib/github";

const isProd = process.env.NODE_ENV === "production";

export async function GET(request: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });

  let authorizeUrl: string;
  try {
    const state = newOAuthState();
    authorizeUrl = buildAuthorizeUrl(state);

    const res = NextResponse.redirect(authorizeUrl);
    res.cookies.set(GITHUB_OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });

    const workspaceId = request.nextUrl.searchParams.get("workspaceId");
    if (workspaceId) {
      res.cookies.set(GITHUB_WORKSPACE_COOKIE, workspaceId, {
        httpOnly: true,
        secure: isProd,
        sameSite: "lax",
        path: "/",
        maxAge: 600,
      });
    }
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : "GitHub is not configured.";
    return NextResponse.json({ message }, { status: 500 });
  }
}
