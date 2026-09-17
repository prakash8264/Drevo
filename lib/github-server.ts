import { Octokit } from "octokit";
import { db } from "@/lib/prisma";
import { decryptToken } from "@/lib/github";

export class GithubRouteError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface GithubContext {
  userId: string;
  username: string;
  octokit: Octokit;
}

/**
 * Shared server helper: load the Drevo user, verify GitHub is connected,
 * decrypt the token and build an authed Octokit client.
 * The token never leaves the server.
 */
export async function getGithubContext(clerkId: string): Promise<GithubContext> {
  const user = await db.user.findUnique({
    where: { clerkId },
    select: { id: true, githubAccessToken: true, githubUsername: true },
  });
  if (!user) throw new GithubRouteError("User not found.", 404);
  if (!user.githubAccessToken || !user.githubUsername) {
    throw new GithubRouteError(
      "GitHub is not connected. Connect your account first.",
      401,
      "GITHUB_NOT_CONNECTED"
    );
  }
  let token: string;
  try {
    token = decryptToken(user.githubAccessToken);
  } catch {
    throw new GithubRouteError(
      "Stored GitHub credentials are unreadable. Disconnect and reconnect GitHub.",
      401,
      "GITHUB_TOKEN_INVALID"
    );
  }
  return { userId: user.id, username: user.githubUsername, octokit: new Octokit({ auth: token }) };
}

export function githubErrorResponse(err: unknown) {
  if (err instanceof GithubRouteError) {
    return Response.json(
      { message: err.message, ...(err.code ? { code: err.code } : {}) },
      { status: err.status }
    );
  }
  const status = (err as { status?: number })?.status;
  if (status === 401 || status === 403) {
    return Response.json(
      {
        message: "GitHub rejected the request. Reconnect your GitHub account and try again.",
        code: "GITHUB_TOKEN_INVALID",
      },
      { status: 401 }
    );
  }
  console.error("[github] request failed:", err);
  return Response.json({ message: "GitHub request failed. Please try again." }, { status: 500 });
}
