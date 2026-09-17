import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getGithubContext, githubErrorResponse } from "@/lib/github-server";

export const runtime = "nodejs";

const PER_PAGE = 100;
const MAX_PAGES = 2;

export async function GET(request: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });

  const search = (request.nextUrl.searchParams.get("search") ?? "").trim().toLowerCase();

  try {
    const { octokit } = await getGithubContext(clerkId);

    // Own repos only, most recently pushed first.
    const all: {
      fullName: string;
      name: string;
      private: boolean;
      defaultBranch: string;
      updatedAt: string | null;
      url: string;
    }[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data } = await octokit.rest.repos.listForAuthenticatedUser({
        affiliation: "owner",
        sort: "pushed",
        direction: "desc",
        per_page: PER_PAGE,
        page,
      });
      for (const r of data) {
        if (search && !r.full_name.toLowerCase().includes(search)) continue;
        all.push({
          fullName: r.full_name,
          name: r.name,
          private: r.private,
          defaultBranch: r.default_branch ?? "main",
          updatedAt: r.pushed_at ?? r.updated_at ?? null,
          url: r.html_url,
        });
      }
      if (data.length < PER_PAGE) break;
    }

    return NextResponse.json({ repos: all });
  } catch (err) {
    return githubErrorResponse(err);
  }
}
