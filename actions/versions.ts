"use server";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { db } from "@/lib/prisma";
import type { FileData } from "@/types/workspace";
import type { VersionDetail, VersionSummary } from "@/types/version";

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

async function getInternalUserId(clerkId: string): Promise<string> {
  const user = await db.user.findUnique({
    where: { clerkId },
    select: { id: true },
  });
  if (!user) redirect("/");
  return user.id;
}

async function assertOwnership(
  workspaceId: string,
  userId: string
): Promise<void> {
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId, userId },
    select: { id: true },
  });
  if (!workspace) redirect("/");
}

// ─── List versions (newest first, no file payloads) ───────────────────────────

export async function getVersions(
  workspaceId: string
): Promise<VersionSummary[]> {
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect("/");

  const userId = await getInternalUserId(clerkId);
  await assertOwnership(workspaceId, userId);

  const versions = await db.workspaceVersion.findMany({
    where: { workspaceId },
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
  versionId: string
): Promise<VersionDetail> {
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect("/");

  const userId = await getInternalUserId(clerkId);
  await assertOwnership(workspaceId, userId);

  const [workspace, version] = await Promise.all([
    db.workspace.findUnique({
      where: { id: workspaceId, userId },
      select: { fileData: true },
    }),
    db.workspaceVersion.findUnique({
      where: { id: versionId, workspaceId },
    }),
  ]);
  if (!workspace || !version) redirect("/");

  const restoredFileData = version.fileData as unknown as FileData;

  await db.$transaction([
    // Snapshot current state so this restore can be undone
    ...(workspace.fileData
      ? [
          db.workspaceVersion.create({
            data: {
              workspaceId,
              fileData: workspace.fileData as never,
              summary: "Before restore",
            },
          }),
        ]
      : []),
    db.workspace.update({
      where: { id: workspaceId, userId },
      data: { fileData: restoredFileData as never },
    }),
  ]);

  await pruneVersions(workspaceId);

  return {
    ...toSummary(version),
    fileData: restoredFileData,
  };
}

// ─── Shared helpers (also used by the AI routes) ─────────────────────────────

export async function pruneVersions(workspaceId: string): Promise<void> {
  const overflow = await db.workspaceVersion.findMany({
    where: { workspaceId },
    select: { id: true },
    orderBy: { createdAt: "desc" },
    skip: MAX_VERSIONS_PER_WORKSPACE,
  });
  if (overflow.length > 0) {
    await db.workspaceVersion.deleteMany({
      where: { id: { in: overflow.map((v) => v.id) } },
    });
  }
}
