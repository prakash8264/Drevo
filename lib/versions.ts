import { db } from "@/lib/prisma";
import { requireId } from "@/lib/validation";

// Internal helper, deliberately outside any "use server" action module.
export async function pruneVersions(workspaceId: string): Promise<void> {
  requireId(workspaceId, "workspace ID");
  const overflow = await db.workspaceVersion.findMany({
    where: { workspaceId }, select: { id: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: 20,
  });
  if (overflow.length) {
    await db.workspaceVersion.deleteMany({
      where: { workspaceId, id: { in: overflow.map((v) => v.id) } },
    });
  }
}

export async function pruneVersionsBestEffort(workspaceId: string): Promise<void> {
  try { await pruneVersions(workspaceId); }
  catch (error) { console.error("[versions] post-commit pruning failed:", error); }
}
