import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { Octokit } from "octokit";
import { db } from "@/lib/prisma";
import {
  GITHUB_OAUTH_STATE_COOKIE,
  GITHUB_WORKSPACE_COOKIE,
  encryptToken,
  getGithubRedirectUri,
} from "@/lib/github";

const isProd = process.env.NODE_ENV === "production";

function appBaseUrl(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-host");
  const host = forwarded ?? request.headers.get("host") ?? "localhost:3000";
  const proto = request.headers.get("x-forwarded-proto") ?? (isProd ? "https" : "http");
  return `${proto}://${host}`;
}

function failRedirect(request: NextRequest, workspaceId: string | null, error: string) {
  const base = appBaseUrl(request);
  const target = workspaceId ? `/workspace?id=${workspaceId}&github=error` : "/projects?github=error";
  const res = NextResponse.redirect(`${base}${target}`);
  res.cookies.delete(GITHUB_OAUTH_STATE_COOKIE);
  res.cookies.delete(GITHUB_WORKSPACE_COOKIE);
  console.error(`[github/callback] ${error}`);
  return res;
}

export async function GET(request: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });

  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const expectedState = request.cookies.get(GITHUB_OAUTH_STATE_COOKIE)?.value;
  const workspaceId = request.cookies.get(GITHUB_WORKSPACE_COOKIE)?.value ?? null;

  if (!code || !state || !expectedState || state !== expectedState) {
    return failRedirect(request, workspaceId, "Invalid or missing OAuth state.");
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return failRedirect(request, workspaceId, "GitHub OAuth App is not configured.");
  }

  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: getGithubRedirectUri(),
      }),
    });
    if (!tokenRes.ok) throw new Error(`Token exchange failed (${tokenRes.status}).`);
    const tokenJson = (await tokenRes.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!tokenJson.access_token) {
      throw new Error(tokenJson.error_description ?? tokenJson.error ?? "No access token returned.");
    }

    const octokit = new Octokit({ auth: tokenJson.access_token });
    const { data: ghUser } = await octokit.rest.users.getAuthenticated();

    await db.user.update({
      where: { clerkId },
      data: {
        githubAccessToken: encryptToken(tokenJson.access_token),
        githubUsername: ghUser.login,
        githubUserId: String(ghUser.id),
        githubConnectedAt: new Date(),
      },
    });

    const base = appBaseUrl(request);
    const target = workspaceId ? `/workspace?id=${workspaceId}&github=connected` : "/projects?github=connected";
    const res = NextResponse.redirect(`${base}${target}`);
    res.cookies.delete(GITHUB_OAUTH_STATE_COOKIE);
    res.cookies.delete(GITHUB_WORKSPACE_COOKIE);
    return res;
  } catch (err) {
    return failRedirect(request, workspaceId, err instanceof Error ? err.message : String(err));
  }
}
