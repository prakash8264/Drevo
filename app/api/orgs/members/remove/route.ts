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

  // Clerk-first: if Clerk fails we abort before touching Prisma (clean).
  // If Prisma fails after a Clerk success, the membership-deleted webhook
  // self-heals by removing the Prisma row + repairing the pointer.
  const org = await db.organization.findUnique({
    where: { id: active.organization.id },
    select: { clerkOrgId: true },
  });
  if (org?.clerkOrgId) {
    try {
      const clerk = await getClerk();
      await clerk.organizations.deleteOrganizationMembership({
        organizationId: org.clerkOrgId,
        userId: target.user.clerkId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Clerk removal failed.";
      return NextResponse.json({ message: msg }, { status: 502 });
    }
  }

  await db.organizationMember.delete({ where: { id: target.id } });

  // Repair active pointer if the removed user had this org active.
  await db.user.updateMany({
    where: { id: target.userId, activeOrganizationId: active.organization.id },
    data: { activeOrganizationId: null },
  });

  return NextResponse.json({ ok: true, selfRemoved: isSelf });
}
