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

    if (existing) {
      await ensurePersonalOrganization(existing.id);
      return await db.user.findUnique({ where: { clerkId: user.id } });
    }

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
    return await db.user.findUnique({ where: { clerkId: user.id } });
  } catch (error) {
    console.error("checkUser error:", error);
    return null;
  }
};