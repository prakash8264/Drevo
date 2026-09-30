import { auth, currentUser } from "@clerk/nextjs/server";
import { cache } from "react";
import { db } from "./prisma";
import { ensurePersonalOrganization } from "./org";

const memberships = {
  select: {
    role: true,
    organization: { select: { id: true, name: true, credits: true, plan: true, clerkOrgId: true } },
  },
  orderBy: { createdAt: "asc" as const },
};

// Request-local memoization only. Existing users need one DB read and no Clerk
// Backend API calls. Invitations, webhooks and explicit Sync own reconciliation.
export const checkUser = cache(async () => {
  const { userId: clerkId } = await auth();
  if (!clerkId) return null;

  try {
    const existing = await db.user.findUnique({
      where: { clerkId }, include: { memberships },
    });
    if (existing?.memberships.some((member) => member.organization.id === existing.activeOrganizationId)) {
      return existing;
    }

    let dbUserId = existing?.id;
    if (!dbUserId) {
      const user = await currentUser();
      if (!user) return null;
      const email = user.emailAddresses.find((address) => address.id === user.primaryEmailAddressId)?.emailAddress;
      if (!email) throw new Error("A primary email address is required");
      const created = await db.user.upsert({
        where: { clerkId }, update: {},
        create: {
          clerkId, email,
          name: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(),
          imageUrl: user.imageUrl ?? "",
        },
      });
      dbUserId = created.id;
    }
    await ensurePersonalOrganization(dbUserId);
    return await db.user.findUnique({ where: { clerkId }, include: { memberships } });
  } catch (error) {
    console.error("checkUser error:", error);
    return null;
  }
});
