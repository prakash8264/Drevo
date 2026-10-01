import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { getActiveOrganization } from "@/lib/org";
import { getClerk } from "@/lib/clerk";

export const runtime = "nodejs";

const DeleteSchema = z.object({ memberId: z.string().min(1) });

// Remove a member (OWNER/ADMIN), or leave the org yourself (any role).
// Rules: the sole OWNER cannot be removed and cannot leave.
// Clerk-first: the Clerk membership is deleted first and the Prisma row only
// afterwards, so the two systems cannot diverge (the membership webhook also
// repairs Prisma if this request dies halfway).
export async function DELETE(request: NextRequest) {
  const active = await getActiveOrganization();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "Invalid JSON" }, { status: 400 });
  }
  const parsed = DeleteSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ message: "memberId required" }, { status: 400 });

  const target = await db.organizationMember.findFirst({
    where: { id: parsed.data.memberId, organizationId: active.organization.id },
    select: { id: true, role: true, userId: true, user: { select: { clerkId: true } } },
  });
  if (!target)
    return NextResponse.json({ message: "Member not found" }, { status: 404 });

  const isSelf = target.userId === active.userId;
  if (!isSelf && active.role !== "OWNER" && active.role !== "ADMIN") {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 });
  }
  // ADMINs cannot remove OWNERs.
  if (!isSelf && active.role === "ADMIN" && target.role === "OWNER") {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 });
  }

  if (target.role === "OWNER") {
    const owners = await db.organizationMember.count({
      where: { organizationId: active.organization.id, role: "OWNER" },
    });
    if (owners <= 1) {
      return NextResponse.json(
        {
          message: isSelf
            ? "Transfer ownership first — you are the only OWNER."
            : "That member is the only OWNER — promote someone first.",
        },
        { status: 409 }
      );
    }
  }

  try {
    const clerk = await getClerk();
    await db.$transaction(async (tx) => {
      const [org] = await tx.$queryRaw<{ clerkOrgId: string | null }[]>`SELECT "clerkOrgId" FROM "Organization" WHERE "id" = ${active.organization.id} FOR UPDATE`;
      const caller = await tx.organizationMember.findUnique({ where: { id: active.membership.id } });
      const fresh = await tx.organizationMember.findUnique({ where: { id: target.id } });
      if (!caller || !fresh || (!isSelf && (caller.role === "MEMBER" || (caller.role === "ADMIN" && fresh.role === "OWNER")))) throw new Error("Member permissions changed");
      if (fresh.role === "OWNER" && await tx.organizationMember.count({ where: { organizationId: active.organization.id, role: "OWNER" } }) <= 1) throw new Error("The sole OWNER cannot leave or be removed");
      if (org?.clerkOrgId) {
        if (!isSelf) {
          const currentCaller = await clerk.organizations.getOrganizationMembershipList({ organizationId: org.clerkOrgId, userId: [active.clerkId], limit: 1 });
          if (!currentCaller.data.some((m) => m.publicUserData?.userId === active.clerkId && m.role === "org:admin")) throw new Error("Clerk administrator access is required");
        }
        try { await clerk.organizations.deleteOrganizationMembership({ organizationId: org.clerkOrgId, userId: target.user.clerkId }); }
        catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
      }
      await tx.organizationMember.deleteMany({ where: { id: target.id, organizationId: active.organization.id } });
      const next = await tx.organizationMember.findFirst({ where: { userId: target.userId }, orderBy: { createdAt: "asc" }, select: { organizationId: true } });
      await tx.user.updateMany({ where: { id: target.userId, activeOrganizationId: active.organization.id }, data: { activeOrganizationId: next?.organizationId ?? null } });
    }, { timeout: 20000 });
  } catch (error) {
    console.error("[orgs/members/remove] Clerk-first removal failed:", error);
    return NextResponse.json({ message: "Could not remove the member. Please reload and retry." }, { status: 503 });
  }

  return NextResponse.json({ ok: true, selfRemoved: isSelf });
}
