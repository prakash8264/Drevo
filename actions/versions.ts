"use server";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { db } from "@/lib/prisma";
import type { FileData } from "@/types/workspace";
import type { VersionDetail, VersionSummary } from "@/types/version";
import { requireId } from "@/lib/validation";
import { pruneVersionsBestEffort } from "@/lib/versions";

export type { VersionDetail, VersionSummary } from "@/types/version";

// "use server" modules may only export async functions, so this stays private.
const MAX_VERSIONS_PER_WORKSPACE = 20;

function toSummary(v: {
  id: string;
  summary: string | null;
  fileData: unknown;
  createdAt: Date;
}): VersionSummary {
  const files =
    typeof v.fileData === "object" &&
    v.fileData !== null &&
    "files" in v.fileData &&
    typeof (v.fileData as Record<string, unknown>).files === "object"
      ? Object.keys(
          (v.fileData as Record<string, Record<string, unknown>>).files ?? {}
        ).length
      : 0;
  return {
    id: v.id,
    summary: v.summary,
    fileCount: files,
    createdAt: v.createdAt,
  };
}

async function getUserOrgIds(clerkId: string): Promise<string[]> {
  const user = await db.user.findUnique({
    where: { clerkId },
    select: { memberships: { select: { organizationId: true } } },
  });
  if (!user || user.memberships.length === 0) redirect("/");
  return user.memberships.map((m) => m.organizationId);
}

async function assertOrgAccess(workspaceId: string, orgIds: string[]) {
  const workspace = await db.workspace.findFirst({
    where: { id: workspaceId, organizationId: { in: orgIds } },
    select: { id: true },
  });
  if (!workspace) redirect("/");
}

// ─── List versions (newest first, no file payloads) ───────────────────────────

export async function getVersions(
  workspaceId: string
): Promise<VersionSummary[]> {
  requireId(workspaceId, "workspace ID");
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect("/");

  const orgIds = await getUserOrgIds(clerkId);
  await assertOrgAccess(workspaceId, orgIds);

  const versions = await db.workspaceVersion.findMany({
    where: { workspaceId, workspace: { organization: { members: { some: { user: { clerkId } } } } } },
    select: { id: true, summary: true, fileData: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: MAX_VERSIONS_PER_WORKSPACE,
  });

  return versions.map(toSummary);
}

// ─── Restore a version (free, undoable) ───────────────────────────────────────
// Snapshots the current fileData as a new version first, so restoring is
// itself reversible. No credit is deducted — no AI work happens here.

export async function restoreVersion(
  workspaceId: string,
  versionId: string,
  expectedRevision: number
): Promise<VersionDetail & { revision: number }> {
  requireId(workspaceId, "workspace ID");
  requireId(versionId, "version ID");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Invalid workspace revision");
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect("/");

  const orgIds = await getUserOrgIds(clerkId);
  await assertOrgAccess(workspaceId, orgIds);

  const version = await db.workspaceVersion.findUnique({ where: { id: versionId, workspaceId } });
  if (!version) redirect("/");
  const restoredFileData = version.fileData as unknown as FileData;
  await db.$transaction(async (tx) => {
    const workspace = await tx.workspace.findFirst({
      where: { id: workspaceId, organizationId: { in: orgIds }, revision: expectedRevision },
      select: { fileData: true },
    });
    if (!workspace) throw new Error("Workspace changed. Reload before restoring.");
    const updated = await tx.workspace.updateMany({
      where: { id: workspaceId, revision: expectedRevision, organization: { members: { some: { user: { clerkId } } } } },
      data: { fileData: restoredFileData as never, revision: { increment: 1 } },
    });
    if (!updated.count) throw new Error("Workspace changed. Reload before restoring.");
    if (workspace.fileData) await tx.workspaceVersion.create({
      data: { workspaceId, fileData: workspace.fileData as never, summary: "Before restore" },
    });
  });
  await pruneVersionsBestEffort(workspaceId);
  return { ...toSummary(version), fileData: restoredFileData, revision: expectedRevision + 1 };
}
