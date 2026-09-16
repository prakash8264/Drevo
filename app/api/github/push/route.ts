import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { Octokit } from "octokit";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { buildProjectFilesFromFileData } from "@/lib/export-project";
import { decryptToken, validateRepoName } from "@/lib/github";
import type { FileData } from "@/types/workspace";

export const runtime = "nodejs";
export const maxDuration = 120;

const BRANCH = "main";
const MAX_FILES = 300;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

const PushSchema = z.object({
  workspaceId: z.string().min(1),
  repoName: z.string().min(1).max(100),
  isPrivate: z.boolean(),
  commitMessage: z.string().max(500).optional(),
});

function parseFileData(raw: unknown): FileData | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  if (!f.files || typeof f.files !== "object") return null;
  return raw as FileData;
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export async function POST(request: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = PushSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ message: "workspaceId, repoName and isPrivate are required." }, { status: 400 });
  }
  const { workspaceId, repoName: rawRepoName, isPrivate } = parsed.data;
  const repoName = rawRepoName.trim();
  const nameError = validateRepoName(repoName);
  if (nameError) return NextResponse.json({ message: nameError }, { status: 400 });
  const commitMessage = parsed.data.commitMessage?.trim() || "Initial commit from Drevo";

  // Server loads everything. The browser only sends workspaceId + push config.
  const user = await db.user.findUnique({
    where: { clerkId },
    select: { id: true, githubAccessToken: true },
  });
  if (!user) return NextResponse.json({ message: "User not found." }, { status: 404 });
  if (!user.githubAccessToken) {
    return NextResponse.json(
      { message: "GitHub is not connected. Connect your account first.", code: "GITHUB_NOT_CONNECTED" },
      { status: 401 }
    );
  }

  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId, userId: user.id },
    select: { id: true, title: true, fileData: true },
  });
  if (!workspace) return NextResponse.json({ message: "Workspace not found." }, { status: 404 });

  const fileData = parseFileData(workspace.fileData);
  if (!fileData || Object.keys(fileData.files ?? {}).length === 0) {
    return NextResponse.json(
      { message: "There is no generated code in this workspace yet." },
      { status: 400 }
    );
  }

  const projectFiles = buildProjectFilesFromFileData(fileData, workspace.title);
  const entries = Object.entries(projectFiles);
  if (entries.length > MAX_FILES) {
    return NextResponse.json(
      { message: `Too many files to push (${entries.length}, max ${MAX_FILES}).` },
      { status: 400 }
    );
  }
  const totalBytes = entries.reduce((sum, [, content]) => sum + byteLength(content), 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    return NextResponse.json({ message: "Project is too large to push." }, { status: 400 });
  }

  let token: string;
  try {
    token = decryptToken(user.githubAccessToken);
  } catch {
    return NextResponse.json(
      {
        message: "Stored GitHub credentials are unreadable. Disconnect and reconnect GitHub.",
        code: "GITHUB_TOKEN_INVALID",
      },
      { status: 401 }
    );
  }

  const octokit = new Octokit({ auth: token });

  // Set once the repo exists so failures below can tell the client that the
  // repo was created but the upload did not finish (safe to delete/rename).
  let createdRepo: { owner: string; repo: string; repoUrl: string } | null = null;

  const pushFailedAfterCreate = (message: string, status = 500) =>
    NextResponse.json(
      {
        message,
        code: "REPO_CREATED_PUSH_FAILED",
        repoUrl: createdRepo?.repoUrl,
        fullName: createdRepo ? `${createdRepo.owner}/${createdRepo.repo}` : undefined,
      },
      { status }
    );

  try {
    // 1. Create the repository (fresh namespace, so no divergence is possible).
    let owner: string;
    let repo: string;
    let repoUrl: string;
    try {
      const created = await octokit.rest.repos.createForAuthenticatedUser({
        name: repoName,
        private: isPrivate,
        auto_init: false,
        description: workspace.title ? `Built with Drevo: ${workspace.title}` : "Built with Drevo",
      });
      owner = created.data.owner.login;
      repo = created.data.name;
      repoUrl = created.data.html_url;
      createdRepo = { owner, repo, repoUrl };
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 422) {
        return NextResponse.json(
          { message: `A repository named "${repoName}" already exists on your account. Pick another name.` },
          { status: 409 }
        );
      }
      throw err;
    }

    // 2. Seed the initial commit via the Contents API.
    // The git-database blob endpoint rejects completely empty repos
    // ("Git Repository is empty"), so the first file must go through here.
    // This also creates the main branch.
    const seedPath = "README.md";
    const seedContent = projectFiles[seedPath] ?? `# ${repoName}\n`;
    const remaining = entries.filter(([path]) => path !== seedPath);
    let headSha: string;
    try {
      const seeded = await octokit.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: seedPath,
        message: commitMessage,
        content: Buffer.from(seedContent, "utf8").toString("base64"),
        branch: BRANCH,
      });
      const commitData = seeded.data.commit;
      if (!commitData?.sha) throw new Error("Seed commit returned no SHA.");
      headSha = commitData.sha;
    } catch (err) {
      console.error("[github/push] seed commit failed:", err);
      return pushFailedAfterCreate(
        "Repository was created, but the first upload failed. You can delete the empty repo and try again."
      );
    }

    if (remaining.length > 0) {
      try {
        // Verify nobody moved the branch since we seeded it. Never force push:
        // on divergence we stop instead of overwriting.
        const ref = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${BRANCH}` });
        const remoteHead = ref.data.object.sha;
        if (remoteHead !== headSha) {
          return pushFailedAfterCreate(
            "Repository was created, but the branch changed unexpectedly before the upload finished. Delete the repo and try again."
          );
        }

        // 3. Create blobs for the remaining files.
        const tree: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
        for (const [path, content] of remaining) {
          const blob = await octokit.rest.git.createBlob({
            owner,
            repo,
            content,
            encoding: "utf-8",
          });
          tree.push({ path, mode: "100644", type: "blob", sha: blob.data.sha });
        }

        // 4. Tree on top of HEAD, commit on top of HEAD, then move the ref.
        // The ref update is last and non-forced, so history is never
        // partially updated or overwritten.
        const headCommit = await octokit.rest.git.getCommit({ owner, repo, commit_sha: headSha });
        const createdTree = await octokit.rest.git.createTree({
          owner,
          repo,
          base_tree: headCommit.data.tree.sha,
          tree,
        });
        const commit = await octokit.rest.git.createCommit({
          owner,
          repo,
          message: commitMessage,
          tree: createdTree.data.sha,
          parents: [headSha],
        });
        await octokit.rest.git.updateRef({
          owner,
          repo,
          ref: `heads/${BRANCH}`,
          sha: commit.data.sha,
          force: false,
        });
      } catch (err) {
        console.error("[github/push] file upload failed:", err);
        return pushFailedAfterCreate(
          "Repository was created, but uploading the project files failed. You can delete the repo and try again."
        );
      }
    }

    // Best-effort: make main the default branch.
    try {
      await octokit.rest.repos.update({ owner, repo, default_branch: BRANCH });
    } catch {
      // Non-fatal; the branch and commits already exist.
    }

    const fullName = `${owner}/${repo}`;
    await db.workspace.update({
      where: { id: workspace.id },
      data: {
        githubRepoUrl: repoUrl,
        githubRepoFullName: fullName,
        githubBranch: BRANCH,
        lastPushedAt: new Date(),
      },
    });

    return NextResponse.json({ repoUrl, fullName, branch: BRANCH });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 401 || status === 403) {
      return NextResponse.json(
        {
          message: "GitHub rejected the request. Reconnect your GitHub account and try again.",
          code: "GITHUB_TOKEN_INVALID",
        },
        { status: 401 }
      );
    }
    if (status === 403 && /rate limit/i.test(String((err as Error)?.message ?? ""))) {
      return NextResponse.json(
        { message: "GitHub rate limit hit. Wait a bit and try again." },
        { status: 429 }
      );
    }
    console.error("[github/push] failed:", err);
    if (createdRepo) return pushFailedAfterCreate("Push to GitHub failed. Please try again.");
    return NextResponse.json({ message: "Push to GitHub failed. Please try again." }, { status: 500 });
  }
}
