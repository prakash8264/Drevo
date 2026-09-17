import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getGithubContext, githubErrorResponse, GithubRouteError } from "@/lib/github-server";
import { parseRepoFullName } from "@/lib/github";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });

  const fullName = (request.nextUrl.searchParams.get("repo") ?? "").trim();
  const parsed = parseRepoFullName(fullName);
  if (!parsed) return NextResponse.json({ message: "Invalid repository." }, { status: 400 });

  try {
    const { username, octokit } = await getGithubContext(clerkId);
    // Picker scope is "my repos only" — enforce it server-side.
    if (parsed.owner.toLowerCase() !== username.toLowerCase()) {
      throw new GithubRouteError("You can only push to your own repositories.", 403);
    }

    try {
      const { data } = await octokit.rest.repos.listBranches({
        owner: parsed.owner,
        repo: parsed.repo,
        per_page: 100,
      });
      return NextResponse.json({ branches: data.map((b) => ({ name: b.name })) });
    } catch (err) {
      if ((err as { status?: number })?.status === 404) {
        return NextResponse.json(
          { message: "Repository not found or no access." },
          { status: 404 }
        );
      }
      throw err;
    }
  } catch (err) {
    return githubErrorResponse(err);
  }
}
