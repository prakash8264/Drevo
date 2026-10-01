import { db } from "@/lib/prisma";
import { CREDIT_COST_PER_GENERATION } from "@/lib/constants";
import { createWorkspaceVersion, pruneVersionsBestEffort } from "@/lib/versions";
import { validateApp } from "@/lib/ai-request";
import type { FileData, Message } from "@/types/workspace";

export async function saveAiWorkspace(args: {
  workspaceId?: string | null; revision?: number; orgId: string; userId: string;
  fileData: FileData; messages: Message[]; title?: string; summary: string; signal: AbortSignal;
}) {
  const fileData = validateApp(args.fileData);
  args.signal.throwIfAborted();
  const result = await db.$transaction(async (tx) => {
    args.signal.throwIfAborted();
    await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${args.orgId} FOR UPDATE`;
    const member = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: args.orgId, userId: args.userId } } });
    if (!member || (!args.workspaceId && member.role === "MEMBER")) throw new Error("Organization access changed. No credits were deducted.");
    let workspace: { id: string; revision: number };
    if (args.workspaceId) {
      const before = await tx.workspace.findUnique({ where: { id: args.workspaceId }, select: { fileData: true, revision: true, organizationId: true } });
      if (!before || before.organizationId !== args.orgId || before.revision !== args.revision) throw new Error("Workspace changed. Reload before retrying. No credits were deducted.");
      const updated = await tx.workspace.updateMany({
        where: { id: args.workspaceId, organizationId: args.orgId, revision: args.revision },
        data: { fileData: fileData as never, messages: args.messages as never, revision: { increment: 1 } },
      });
      if (!updated.count) throw new Error("Workspace changed. Reload before retrying. No credits were deducted.");
      if (before.fileData) await createWorkspaceVersion(tx, args.workspaceId, before.fileData, args.summary);
      workspace = { id: args.workspaceId, revision: before.revision + 1 };
    } else {
      workspace = await tx.workspace.create({ data: { organizationId: args.orgId, createdById: args.userId, fileData: fileData as never, messages: args.messages as never, title: args.title }, select: { id: true, revision: true } });
    }
    args.signal.throwIfAborted();
    const charged = await tx.organization.updateMany({ where: { id: args.orgId, credits: { gte: CREDIT_COST_PER_GENERATION } }, data: { credits: { decrement: CREDIT_COST_PER_GENERATION } } });
    if (!charged.count) throw new Error("Insufficient credits. No credits were deducted.");
    const org = await tx.organization.findUniqueOrThrow({ where: { id: args.orgId }, select: { credits: true } });
    args.signal.throwIfAborted();
    return { workspaceId: workspace.id, revision: workspace.revision, creditsRemaining: org.credits };
  }, { timeout: 15000 });
  // Only cleanup remains outside the commit; it can never report a failed run.
  await pruneVersionsBestEffort(result.workspaceId);
  return result;
}
