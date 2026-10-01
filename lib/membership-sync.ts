import { db } from "@/lib/prisma";
import { getClerk, toPrismaRole } from "@/lib/clerk";
import { requireId } from "@/lib/validation";

/** Re-read Clerk truth, not an event's possibly stale role/membership payload.
 * The org row lock serializes reads and mirrors with local role/removal writes.
 * Provider failures roll back; they never become an empty membership list.
 */
export async function syncClerkMemberships(clerkOrgId: string, clerkUserId?: string, activate = false) {
  requireId(clerkOrgId, "Clerk organization ID");
  if (clerkUserId !== undefined) requireId(clerkUserId, "Clerk user ID");
  const clerk = await getClerk();
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Organization" WHERE "clerkOrgId" = ${clerkOrgId} FOR UPDATE
    `;
    const org = locked[0];
    if (!org) return null;
    const current = [];
    for (let offset = 0; ; offset += 100) {
      const page = await clerk.organizations.getOrganizationMembershipList({
        organizationId: clerkOrgId, limit: 100, offset,
        ...(clerkUserId ? { userId: [clerkUserId] } : {}),
      });
      current.push(...page.data);
      if (page.data.length < 100) break;
    }
    const retained: string[] = [];
    let added = 0;
    let updated = 0;
    for (const member of current) {
      const id = member.publicUserData?.userId;
      if (!id || member.organization.id !== clerkOrgId || (clerkUserId && id !== clerkUserId)) continue;
      let user = await tx.user.findUnique({ where: { clerkId: id }, select: { id: true } });
      if (!user) {
        const cu = await clerk.users.getUser(id);
        const email = cu.emailAddresses.find((e) => e.id === cu.primaryEmailAddressId)?.emailAddress;
        if (!email) throw new Error("Clerk member has no primary email");
        user = await tx.user.upsert({
          where: { clerkId: id }, update: {},
          create: { clerkId: id, email, name: [cu.firstName, cu.lastName].filter(Boolean).join(" "), imageUrl: cu.imageUrl ?? "" },
          select: { id: true },
        });
      }
      retained.push(user.id);
      const existing = await tx.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
      });
      // OWNER remains a local distinction only while Clerk grants admin access.
      const role = existing?.role === "OWNER" && member.role === "org:admin" ? "OWNER" : toPrismaRole(member.role);
      await tx.organizationMember.upsert({
        where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
        create: { organizationId: org.id, userId: user.id, role }, update: { role },
      });
      if (!existing) added++;
      else if (existing.role !== role) updated++;
      await tx.user.updateMany({
        where: { id: user.id, ...(activate ? {} : { activeOrganizationId: null }) },
        data: { activeOrganizationId: org.id },
      });
    }
    const removed = await tx.organizationMember.findMany({
      where: { organizationId: org.id, userId: { notIn: retained }, ...(clerkUserId ? { user: { clerkId: clerkUserId } } : {}) },
      select: { id: true, userId: true },
    });
    if (removed.length) {
      await tx.organizationMember.deleteMany({ where: { id: { in: removed.map((m) => m.id) }, organizationId: org.id } });
      for (const member of removed) {
        const next = await tx.organizationMember.findFirst({ where: { userId: member.userId }, orderBy: { createdAt: "asc" }, select: { organizationId: true } });
        await tx.user.updateMany({
          where: { id: member.userId, activeOrganizationId: org.id }, data: { activeOrganizationId: next?.organizationId ?? null },
        });
      }
    }
    return { added, updated, removed: removed.length, total: retained.length, organizationId: org.id };
  }, { timeout: 30000 });
}
