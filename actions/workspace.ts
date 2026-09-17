"use server";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { db } from "@/lib/prisma";
import type { WorkspaceUser, WorkspaceData } from "@/types/workspace";

export type { WorkspaceUser, WorkspaceData } from "@/types/workspace";

// ─── Get the current authenticated user ──────────────────────────────────────

export async function getWorkspaceUser(): Promise<WorkspaceUser> {
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect("/");

  const user = await db.user.findUnique({
    where: { clerkId },
    select: {
      id: true,
      credits: true,
      plan: true,
      githubAccessToken: true,
      githubUsername: true,
    },
  });

  if (!user) redirect("/");

  return {
    id: user.id,
    credits: user.credits,
    plan: user.plan,
    githubConnected: Boolean(user.githubAccessToken),
    githubUsername: user.githubUsername,
  };
}

// ─── Get a workspace by id (must belong to the current user) ─────────────────

export async function getWorkspaceById(
  workspaceId: string,
  userId: string
): Promise<WorkspaceData> {
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId, userId },
    select: {
      id: true,
      title: true,
      messages: true,
      fileData: true,
      githubRepoUrl: true,
      githubRepoFullName: true,
      githubBranch: true,
      lastPushedAt: true,
    },
  });

  if (!workspace) redirect("/");

  return {
    ...workspace,
    lastPushedAt: workspace.lastPushedAt?.toISOString() ?? null,
  };
}