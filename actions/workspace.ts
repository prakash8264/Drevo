"use server";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { db } from "@/lib/prisma";
import { ensurePersonalOrganization } from "@/lib/org";
import type { WorkspaceUser, WorkspaceData } from "@/types/workspace";
import { requireId } from "@/lib/validation";

export type { WorkspaceUser, WorkspaceData } from "@/types/workspace";

// ─── Get the current authenticated user + active org ─────────────────────────

export async function getWorkspaceUser(workspaceId?: string): Promise<WorkspaceUser> {
  if (workspaceId !== undefined) requireId(workspaceId, "workspace ID");
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect("/");

  const user = await db.user.findUnique({
    where: { clerkId },
    select: {
      id: true,
      activeOrganizationId: true,
      githubAccessToken: true,
      githubUsername: true,
      memberships: {
        select: {
          role: true,
          organization: {
            select: { id: true, name: true, plan: true, credits: true },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!user) redirect("/");

  if (user.memberships.length === 0) {
    await ensurePersonalOrganization(user.id);
    return getWorkspaceUser(workspaceId);
  }

  const target = workspaceId ? await db.workspace.findUnique({
    where: { id: workspaceId }, select: { organizationId: true },
  }) : null;
  if (workspaceId && !target) redirect("/");
  let pick = user.memberships.find((m) =>
    m.organization.id === (target?.organizationId ?? user.activeOrganizationId)
  );
  if (workspaceId && !pick) redirect("/");
  if (!pick) {
    pick = user.memberships[0];
    await db.user
      .updateMany({
        where: { id: user.id, activeOrganizationId: user.activeOrganizationId },
        data: { activeOrganizationId: pick.organization.id },
      })
      .catch(() => {});
  }

  return {
    id: user.id,
    orgId: pick.organization.id,
    orgName: pick.organization.name,
    credits: pick.organization.credits,
    plan: pick.organization.plan,
    role: pick.role,
    githubConnected: Boolean(user.githubAccessToken),
    githubUsername: user.githubUsername,
  };
}

// ─── Get a workspace by id (must belong to an org the user belongs to) ──────

export async function getWorkspaceById(
  workspaceId: string
): Promise<WorkspaceData> {
  requireId(workspaceId, "workspace ID");
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect("/");

  const user = await db.user.findUnique({
    where: { clerkId },
    select: {
      id: true,
      memberships: { select: { organizationId: true } },
    },
  });
  if (!user || user.memberships.length === 0) redirect("/");

  const orgIds = user.memberships.map((m) => m.organizationId);
  const workspace = await db.workspace.findFirst({
    where: { id: workspaceId, organizationId: { in: orgIds } },
    select: {
      id: true,
      title: true,
      revision: true,
      messages: true,
      fileData: true,
      githubRepoUrl: true,
      githubRepoFullName: true,
      githubBranch: true,
      lastPushedAt: true,
    },
  });

  if (!workspace) redirect("/");
  const target = await db.githubPushTarget.findFirst({ where: { workspaceId, userId: user.id }, orderBy: { lastPushedAt: "desc" } });

  return {
    ...workspace,
    githubRepoUrl: target?.repoUrl ?? null,
    githubRepoFullName: target?.repoFullName ?? null,
    githubBranch: target?.branch ?? null,
    lastPushedAt: target?.lastPushedAt.toISOString() ?? null,
  };
}
