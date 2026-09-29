import { currentUser } from "@clerk/nextjs/server";
import { db } from "./prisma";
import { ensurePersonalOrganization } from "./org";

// Organization is the source of truth for plan/credits.
// This syncs Clerk identity → DB user and guarantees a personal org;
// it never writes plan/credits (deprecated User columns stay untouched
// until the contract migration). Clerk Billing `has({plan})` is NOT
// consulted — see PricingModal deprecation note.

export const checkUser = async () => {
  const user = await currentUser();
  if (!user) return null;

  try {
    const existing = await db.user.findUnique({
      where: { clerkId: user.id },
    });

    let dbUserId = existing ? existing.id : "";
    if (existing) {
      await ensurePersonalOrganization(existing.id);
      dbUserId = existing.id;
    } else {
      // New user — create identity row, then personal org (OWNER).
      const created = await db.user.create({
        data: {
          clerkId: user.id,
          name: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(),
          email: user.emailAddresses[0].emailAddress,
          imageUrl: user.imageUrl ?? "",
        },
      });
      await ensurePersonalOrganization(created.id);
      dbUserId = created.id;
    }

    // Self-healing: sync any Clerk organization memberships the user belongs to
    try {
      const { getClerk, toPrismaRole } = await import("./clerk");
      const clerk = await getClerk();
      const clerkMemberships = await clerk.users.getOrganizationMembershipList({
        userId: user.id,
        limit: 100,
      });

      for (const cm of clerkMemberships.data) {
        const org = await db.organization.findUnique({
          where: { clerkOrgId: cm.organization.id },
          select: { id: true },
        });
        if (!org) continue;

        const member = await db.organizationMember.findUnique({
          where: {
            organizationId_userId: {
              organizationId: org.id,
              userId: dbUserId,
            },
          },
        });
        if (!member) {
          await db.organizationMember.create({
            data: {
              organizationId: org.id,
              userId: dbUserId,
              role: toPrismaRole(cm.role),
            },
          });
        }
      }
    } catch (e) {
      console.warn("[checkUser] clerk membership sync non-fatal warning:", e);
    }

    // Auto-switch to joined organization if current active org has 0 workspaces
    const refreshed = await db.user.findUnique({
      where: { id: dbUserId },
      select: {
        activeOrganizationId: true,
        memberships: {
          select: { organizationId: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (refreshed && refreshed.memberships.length > 1 && refreshed.activeOrganizationId) {
      const activeWorkspaces = await db.workspace.count({
        where: { organizationId: refreshed.activeOrganizationId },
      });
      if (activeWorkspaces === 0) {
        const targetOrg = refreshed.memberships.find(
          (m) => m.organizationId !== refreshed.activeOrganizationId
        );
        if (targetOrg) {
          await db.user.update({
            where: { id: dbUserId },
            data: { activeOrganizationId: targetOrg.organizationId },
          });
        }
      }
    }

    return await db.user.findUnique({ where: { clerkId: user.id } });
  } catch (error) {
    console.error("checkUser error:", error);
    return null;
  }
};