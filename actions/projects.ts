"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/prisma";
import { getActiveOrganization } from "@/lib/org";
import type { ProjectSummary } from "@/types/project";
import { requireId } from "@/lib/validation";

export type { ProjectSummary } from "@/types/project";

// ─── Get all workspaces for the active organization ──────────────────────────

export async function getUserProjects(): Promise<ProjectSummary[]> {
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect("/");

  const active = await getActiveOrganization();

  const workspaces = await db.workspace.findMany({
    where: { organizationId: active.organization.id },
    select: {
      id: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      messages: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  return workspaces.map((w) => {
    const msgs = Array.isArray(w.messages) ? w.messages : [];
    const firstUserMsg = msgs.find(
      (m): m is { role: string; content: string } =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).role === "user"
    );

    return {
      id: w.id,
      title: w.title,
      firstPrompt: firstUserMsg?.content?.slice(0, 120) ?? null,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
      messageCount: Array.isArray(w.messages) ? w.messages.length : 0,
    };
  });
}

// ─── Delete a workspace (OWNER/ADMIN only, org-scoped) ───────────────────────

export async function deleteProject(workspaceId: string): Promise<void> {
  requireId(workspaceId, "workspace ID");
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect("/");

  const active = await getActiveOrganization();
  if (active.role !== "OWNER" && active.role !== "ADMIN") {
    throw Object.assign(new Error("Forbidden"), { status: 403 });
  }

  await db.workspace.deleteMany({
    where: { id: workspaceId, organizationId: active.organization.id, organization: { members: { some: { userId: active.userId, role: { in: ["OWNER", "ADMIN"] } } } } },
  });

  revalidatePath("/projects");
}
