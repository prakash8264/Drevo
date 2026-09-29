"use server";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { db } from "@/lib/prisma";
import { ensurePersonalOrganization } from "@/lib/org";
import type { WorkspaceUser, WorkspaceData } from "@/types/workspace";

export type { WorkspaceUser, WorkspaceData } from "@/types/workspace";

// ─── Get the current authenticated user + active org ─────────────────────────

export async function getWorkspaceUser(): Promise<WorkspaceUser> {
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
    return getWorkspaceUser();
  }

  let pick = user.memberships.find(
    (m) => m.organization.id === user.activeOrganizationId
  );
  if (!pick) {
    pick = user.memberships[0];
    await db.user
      .update({
        where: { id: user.id },
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
  workspaceId: string,
  _userId?: string
): Promise<WorkspaceData> {
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
