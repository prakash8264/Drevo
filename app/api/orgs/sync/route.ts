import { NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { getActiveOrganization } from "@/lib/org";
import { getClerk, toPrismaRole } from "@/lib/clerk";

export const runtime = "nodejs";

/**
 * On-demand Clerk -> Prisma membership sync for the active org.
 * Same rules as the membership webhook (new memberships only — never rewrites
 * an existing Prisma role), callable from the members dialog. Makes
 * "did the invite land?" self-healing without waiting on webhook timing.
 */
export async function POST() {
  const active = await getActiveOrganization();

  const org = await db.organization.findUnique({
    where: { id: active.organization.id },
    select: { id: true, clerkOrgId: true },
  });
  if (!org?.clerkOrgId) {
    return NextResponse.json(
      { message: "Organization is not linked to Clerk yet." },
      { status: 409 }
    );
  }

  const clerk = await getClerk();
  const list = await clerk.organizations.getOrganizationMembershipList({
    organizationId: org.clerkOrgId,
    limit: 100,
  });

  let added = 0;
  let already = 0;
  for (const m of list.data) {
    const clerkUserId = m.publicUserData?.userId;
    if (!clerkUserId) continue;

    let user = await db.user.findUnique({
      where: { clerkId: clerkUserId },
      select: { id: true, activeOrganizationId: true },
    });
    if (!user) {
      const identifier = m.publicUserData?.identifier ?? "";
      const email = identifier.includes("@") ? identifier : `${clerkUserId}@unknown.local`;
      const name =
        [m.publicUserData?.firstName, m.publicUserData?.lastName]
          .filter(Boolean)
          .join(" ");
      user = await db.user.create({
        data: {
          clerkId: clerkUserId,
          name,
          email,
          imageUrl: m.publicUserData?.imageUrl ?? "",
          activeOrganizationId: org.id,
        },
        select: { id: true, activeOrganizationId: true },
      });
      const { ensurePersonalOrganization } = await import("@/lib/org");
      await ensurePersonalOrganization(user.id);
      user = (await db.user.findUnique({
        where: { id: user.id },
        select: { id: true, activeOrganizationId: true },
      }))!;
    }

    const present = await db.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId: org.id, userId: user.id },
      },
      select: { id: true },
    });
    if (present) {
      already++;
      continue;
    }
    await db.organizationMember.create({
      data: {
        organizationId: org.id,
        userId: user.id,
        role: toPrismaRole(m.role),
      },
    });
    added++;
    let shouldSwitch = !user.activeOrganizationId;
    if (!shouldSwitch && user.activeOrganizationId !== org.id && user.activeOrganizationId !== null) {
      const count = await db.workspace.count({
        where: { organizationId: user.activeOrganizationId },
      });
      if (count === 0) {
        shouldSwitch = true;
      }
    }
    if (shouldSwitch) {
      await db.user.update({
        where: { id: user.id },
        data: { activeOrganizationId: org.id },
      });
    }
  }

  return NextResponse.json({ ok: true, added, already, total: list.data.length });
}
