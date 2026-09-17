"use client";

export interface PushPayload {
  workspaceId: string;
  mode: "create" | "existing";
  repoName?: string;
  isPrivate?: boolean;
  repoFullName?: string;
  branch?: string;
  commitMessage?: string;
}

export interface PushSuccess {
  repoUrl: string;
  fullName: string;
  branch: string;
  unchanged?: boolean;
}

export interface PushFailure {
  message: string;
  code?: string;
  repoUrl?: string;
  fullName?: string;
}

/**
 * Shared client for POST /api/github/push, used by the dialog and the
 * one-click Update button so both handle every server code identically.
 */
export async function pushToGithub(
  payload: PushPayload
): Promise<{ ok: true; result: PushSuccess } | { ok: false; error: PushFailure }> {
  let res: Response;
  try {
    res = await fetch("/api/github/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, error: { message: "Push to GitHub failed. Check your connection and try again." } };
  }
  const data = (await res.json().catch(() => null)) as {
    repoUrl?: string;
    fullName?: string;
    branch?: string;
    unchanged?: boolean;
    message?: string;
    code?: string;
  } | null;
  if (!res.ok || !data?.repoUrl) {
    return {
      ok: false,
      error: {
        message: data?.message ?? "Push to GitHub failed. Please try again.",
        code: data?.code,
        repoUrl: data?.repoUrl,
        fullName: data?.fullName,
      },
    };
  }
  return {
    ok: true,
    result: {
      repoUrl: data.repoUrl,
      fullName: data.fullName ?? "",
      branch: data.branch ?? "main",
      unchanged: data.unchanged,
    },
  };
}

export interface GithubRepo {
  fullName: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string | null;
  url: string;
}

export async function listGithubRepos(search: string): Promise<GithubRepo[]> {
  const res = await fetch(`/api/github/repos?search=${encodeURIComponent(search)}`);
  if (!res.ok) throw new Error("Could not load repositories.");
  const data = (await res.json()) as { repos?: GithubRepo[] };
  return data.repos ?? [];
}

export async function listGithubBranches(repoFullName: string): Promise<string[]> {
  const res = await fetch(`/api/github/branches?repo=${encodeURIComponent(repoFullName)}`);
  if (!res.ok) throw new Error("Could not load branches.");
  const data = (await res.json()) as { branches?: { name: string }[] };
  return (data.branches ?? []).map((b) => b.name);
}
