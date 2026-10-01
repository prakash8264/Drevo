import { auth } from "@clerk/nextjs/server";
import { cache } from "react";
import { redirect } from "next/navigation";
import { db } from "@/lib/prisma";
import { PLANS } from "@/lib/constants";
import type { OrganizationRole } from "@/lib/generated/prisma/client";
import { requireId } from "@/lib/validation";

export type { OrganizationRole };

export interface ActiveOrg {
  userId: string;
  clerkId: string;
  organization: { id: string; name: string; plan: string; credits: number };
  membership: { id: string; role: OrganizationRole };
  role: OrganizationRole;
}

function personalOrgName(userName: string | null): string {
  const base = (userName ?? "").trim().split(" ")[0];
  return base ? `${base}'s Workspace` : "My Workspace";
}

/**
 * Ensure the user has at least one org. Idempotent under concurrency:
 * re-checks inside the transaction and recovers from P2002 races by re-reading.
 */
export async function ensurePersonalOrganization(userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      clerkId: true,
      name: true,
      activeOrganizationId: true,
      memberships: {
        select: { id: true, organizationId: true, role: true },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
    },
  });
  if (!user) throw new Error("User not found");

  // Already has a valid active org → done.
  if (user.activeOrganizationId) {
    const m = await db.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: user.activeOrganizationId,
          userId,
        },
      },
      select: { id: true },
    });
    if (m) return;
  }
  // Has any membership → repair active pointer, no new org.
  if (user.memberships.length > 0) {
    await db.user.updateMany({
      where: { id: userId, activeOrganizationId: user.activeOrganizationId },
      data: { activeOrganizationId: user.memberships[0].organizationId },
    });
    return;
  }

  // Create personal org + its Clerk counterpart (B-variant 1:1 link).
  // The Clerk create runs outside the Prisma transaction (no distributed tx):
  // if it fails we keep the Prisma org and link later (backfill script or
  // organization.created webhook) — invites/checkout 409 clearly until linked.
  let prismaOrgId: string | null = null;
  try {
    await db.$transaction(async (tx) => {
      // User-row lock: two first requests cannot create two personal orgs.
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      const again = await tx.organizationMember.findFirst({
        where: { userId },
        select: { id: true },
      });
      if (again) return;
      const trial = await tx.user.updateMany({
        where: { id: userId, trialCreditsGrantedAt: null },
        data: { trialCreditsGrantedAt: new Date() },
      });
      const org = await tx.organization.create({
        data: {
          name: personalOrgName(user.name),
          plan: "free",
          credits: trial.count ? PLANS.free.credits : 0,
        },
      });
      await tx.organizationMember.create({
        data: { organizationId: org.id, userId, role: "OWNER" },
      });
      await tx.user.update({
        where: { id: userId },
        data: { activeOrganizationId: org.id },
      });
      prismaOrgId = org.id;
    });
  } catch (err) {
    // P2002 = concurrent request won the race → repair pointer from winner.
    const code = (err as { code?: string })?.code;
    if (code !== "P2002") throw err;
    const winner = await db.organizationMember.findFirst({
      where: { userId },
      select: { organizationId: true },
      orderBy: { createdAt: "asc" },
    });
    if (winner) {
      await db.user.updateMany({
        where: { id: userId, activeOrganizationId: user.activeOrganizationId },
        data: { activeOrganizationId: winner.organizationId },
      });
    }
  }

  if (prismaOrgId) {
    try {
      const { getClerk } = await import("./clerk");
      const clerk = await getClerk();
      const created = await clerk.organizations.createOrganization({
        name: personalOrgName(user.name),
        createdBy: user.clerkId,
        privateMetadata: { drevoOrganizationId: prismaOrgId },
      });
      await db.organization.update({
        where: { id: prismaOrgId },
        data: { clerkOrgId: created.id },
      });
    } catch (err) {
      console.error("[org] Clerk org auto-create failed (will backfill later):", err);
    }
  }
}

/** Resolve the caller's active org; repairs stale pointers. Redirects if none. */
export const getActiveOrganization = cache(async (): Promise<ActiveOrg> => {
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect("/");

  const user = await db.user.findUnique({
    where: { clerkId },
    select: {
      id: true,
      activeOrganizationId: true,
      memberships: {
        select: {
          id: true,
          role: true,
          organization: {
            select: { id: true, name: true, plan: true, credits: true },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!user || user.memberships.length === 0) redirect("/");

  let pick = user.memberships.find(
    (m) => m.organization.id === user.activeOrganizationId
  );
  if (!pick) {
    pick = user.memberships[0];
    // Best-effort repair; never blocks the request.
    db.user
      .updateMany({
        where: { id: user.id, activeOrganizationId: user.activeOrganizationId },
        data: { activeOrganizationId: pick.organization.id },
      })
      .catch(() => {});
  }

  return {
    userId: user.id,
    clerkId,
    organization: pick.organization,
    membership: { id: pick.id, role: pick.role },
    role: pick.role,
  };
});

/** Membership of the caller in the org that owns a workspace. Null if none. */
export async function getMembershipForOrganization(organizationId: string) {
  requireId(organizationId, "organization ID");
  const { userId: clerkId } = await auth();
  if (!clerkId) return null;
  const user = await db.user.findUnique({
    where: { clerkId },
    select: { id: true },
  });
  if (!user) return null;
  return db.organizationMember.findUnique({
    where: {
      organizationId_userId: { organizationId, userId: user.id },
    },
    select: { id: true, role: true, organizationId: true, userId: true },
  });
}

export async function requireOrganizationMember(
  organizationId: string
): Promise<ActiveOrg> {
  requireId(organizationId, "organization ID");
  const active = await getActiveOrganization();
  // Active-org fast path; otherwise check membership in the target org
  // (workspace routes authorize via workspace org, not active org).
  if (active.organization.id === organizationId) return active;
  const m = await getMembershipForOrganization(organizationId);
  if (!m) redirect("/");
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true, plan: true, credits: true },
  });
  if (!org) redirect("/");
  const { userId: clerkId } = await auth();
  return {
    userId: m.userId,
    clerkId: clerkId!,
    organization: org,
    membership: { id: m.id, role: m.role },
    role: m.role,
  };
}

export async function requireOrganizationRole(
  organizationId: string,
  roles: OrganizationRole[]
): Promise<ActiveOrg> {
  const ctx = await requireOrganizationMember(organizationId);
  if (!roles.includes(ctx.role)) {
    // API routes map this to 403; server actions/pages map to redirect.
    throw Object.assign(new Error("Forbidden"), { status: 403 });
  }
  return ctx;
}

/** Sole-OWNER guard for the future leave/delete-member flow (no UI yet). */
export async function ensureOrgHasOwner(organizationId: string) {
  const owners = await db.organizationMember.count({
    where: { organizationId, role: "OWNER" },
  });
  if (owners < 1) throw new Error("Organization must have at least one OWNER");
}
