import { db } from "@/lib/prisma";
import { Prisma } from "@/lib/generated/prisma/client";
import { requireId } from "@/lib/validation";
import { applyVersionDelta, buildVersionPayload, MAX_PATCH_DEPTH, VERSION_FORMAT, versionHash } from "@/lib/version-data";

export const MAX_VERSIONS_PER_WORKSPACE = 20;
const newestFirst = [{ createdAt: "desc" }, { id: "desc" }] as const;

// All history writers/pruners follow the same org -> workspace lock order.
// The lock covers reconstruction as well, preventing concurrent base pruning.
export async function lockWorkspaceHistory(tx: Prisma.TransactionClient, workspaceId: string) {
  requireId(workspaceId, "workspace ID");
  await tx.$queryRaw`
    SELECT o."id" FROM "Organization" o JOIN "Workspace" w ON w."organizationId" = o."id"
    WHERE w."id" = ${workspaceId} FOR UPDATE OF o
  `;
  await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${workspaceId} FOR UPDATE`;
}

// Internal only: callers must authorize and hold lockWorkspaceHistory in a tx.
export async function readVersionFileData(tx: Prisma.TransactionClient, workspaceId: string, versionId: string): Promise<unknown> {
  requireId(workspaceId, "workspace ID");
  requireId(versionId, "version ID");
  const visited = new Set<string>();
  async function read(id: string): Promise<{ fileData: unknown; chainDepth: number }> {
    if (visited.has(id) || visited.size > MAX_PATCH_DEPTH) throw new Error("Invalid version chain");
    visited.add(id);
    const row = await tx.workspaceVersion.findUnique({ where: { id, workspaceId } });
    if (!row) throw new Error("Version base is missing");
    if (row.formatVersion !== VERSION_FORMAT) throw new Error("Unsupported version format");
    let fileData: unknown;
    if (row.kind === "snapshot" && row.chainDepth === 0 && !row.baseVersionId && row.fileData !== null) {
      fileData = row.fileData;
      // Old snapshots have no hash; new/promoted checkpoints always do.
      if (row.contentHash && versionHash(fileData) !== row.contentHash) throw new Error("Version snapshot checksum mismatch");
    } else if (row.kind === "delta" && row.baseVersionId && row.contentHash && row.chainDepth >= 1 && row.chainDepth <= MAX_PATCH_DEPTH) {
      const base = await read(row.baseVersionId);
      if (row.chainDepth !== base.chainDepth + 1) throw new Error("Invalid version chain depth");
      fileData = applyVersionDelta(base.fileData, row.delta, row.contentHash);
    } else throw new Error("Invalid version storage");
    return { fileData, chainDepth: row.chainDepth };
  }
  return (await read(versionId)).fileData;
}

// Preserve the existing semantics: history describes the DB state BEFORE an
// edit/restore, not a new duplicate of the current Workspace.fileData.
export async function createWorkspaceVersion(tx: Prisma.TransactionClient, workspaceId: string, fileData: unknown, summary: string) {
  await lockWorkspaceHistory(tx, workspaceId);
  const previous = await tx.workspaceVersion.findFirst({ where: { workspaceId }, orderBy: [...newestFirst] });
  const base = previous && previous.chainDepth < MAX_PATCH_DEPTH
    ? { fileData: await readVersionFileData(tx, workspaceId, previous.id), chainDepth: previous.chainDepth } : undefined;
  const payload = buildVersionPayload(fileData, base);
  return tx.workspaceVersion.create({
    data: {
      workspaceId, summary: summary.slice(0, 120), kind: payload.kind,
      fileData: payload.kind === "snapshot" ? payload.fileData as Prisma.InputJsonValue : Prisma.DbNull,
      delta: payload.delta ? payload.delta as Prisma.InputJsonValue : Prisma.DbNull,
      contentHash: payload.contentHash, fileCount: payload.fileCount, chainDepth: payload.chainDepth,
      formatVersion: payload.formatVersion, baseVersionId: payload.kind === "delta" ? previous!.id : null,
      // Strict ordering even for multiple commits within one millisecond.
      createdAt: new Date(Math.max(Date.now(), (previous?.createdAt.getTime() ?? 0) + 1)),
    },
  });
}

export async function pruneVersions(workspaceId: string): Promise<void> {
  requireId(workspaceId, "workspace ID");
  await db.$transaction(async (tx) => {
    await lockWorkspaceHistory(tx, workspaceId);
    const rows = await tx.workspaceVersion.findMany({
      where: { workspaceId }, orderBy: [...newestFirst],
      select: { id: true, kind: true, baseVersionId: true, chainDepth: true },
    });
    if (rows.length <= MAX_VERSIONS_PER_WORKSPACE) return;
    const retained = rows.slice(0, MAX_VERSIONS_PER_WORKSPACE).reverse();
    const depths = new Map<string, number>();
    for (const row of retained) {
      if (row.kind === "snapshot") depths.set(row.id, 0);
      else if (row.baseVersionId && depths.has(row.baseVersionId)) {
        const chainDepth = depths.get(row.baseVersionId)! + 1;
        if (chainDepth > MAX_PATCH_DEPTH) throw new Error("Invalid retained version chain");
        if (chainDepth !== row.chainDepth) await tx.workspaceVersion.update({ where: { id: row.id, workspaceId }, data: { chainDepth } });
        depths.set(row.id, chainDepth);
      } else {
        // Materialize before deleting any required base; keep the public ID.
        const fileData = await readVersionFileData(tx, workspaceId, row.id);
        await tx.workspaceVersion.update({
          where: { id: row.id, workspaceId },
          data: { kind: "snapshot", fileData: fileData as Prisma.InputJsonValue, delta: Prisma.DbNull,
            baseVersionId: null, chainDepth: 0, contentHash: versionHash(fileData) },
        });
        depths.set(row.id, 0);
      }
    }
    await tx.workspaceVersion.deleteMany({
      where: { workspaceId, id: { in: rows.slice(MAX_VERSIONS_PER_WORKSPACE).map((v) => v.id) } },
    });
  }, { timeout: 15000 });
}

export async function pruneVersionsBestEffort(workspaceId: string): Promise<void> {
  try { await pruneVersions(workspaceId); }
  catch (error) { console.error("[versions] post-commit pruning failed:", error); }
}
