import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { getActiveOrganization } from "@/lib/org";
import { getClerk, toDrevoPlan } from "@/lib/clerk";

export const runtime = "nodejs";

const Schema = z.object({ organizationId: z.string().min(1) });

// OWNER-only. Destroys the org with all its workspaces/versions (FK cascade)
// and memberships. Members keep their accounts; their active pointers repair
// to another org or null. Cannot delete your only org while it still has
// other members — remove them first.
export async function DELETE(request: NextRequest) {
  const active = await getActiveOrganization();
  if (active.role !== "OWNER") {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "Invalid JSON" }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ message: "organizationId required" }, { status: 400 });

  const membership = await db.organizationMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId: parsed.data.organizationId,
        userId: active.userId,
      },
    },
    select: { role: true },
  });
  if (!membership || membership.role !== "OWNER") {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 });
  }

  const others = await db.organizationMember.count({
    where: {
      organizationId: parsed.data.organizationId,
      userId: { not: active.userId },
    },
  });
  if (others > 0) {
    return NextResponse.json(
      { message: "Remove all other members first." },
      { status: 409 }
    );
  }

  try {
    await db.$transaction(async (tx) => {
      const [org] = await tx.$queryRaw<{ clerkOrgId: string | null }[]>`SELECT "clerkOrgId" FROM "Organization" WHERE "id" = ${parsed.data.organizationId} FOR UPDATE`;
      if (!org) return;
      const caller = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: parsed.data.organizationId, userId: active.userId } } });
      if (caller?.role !== "OWNER") throw Object.assign(new Error("Owner access changed. Reload before deleting."), { status: 403 });
      if (await tx.organizationMember.count({ where: { organizationId: parsed.data.organizationId, userId: { not: active.userId } } })) throw Object.assign(new Error("Remove all other members first."), { status: 409 });
      if (org.clerkOrgId) {
        const clerk = await getClerk();
        let exists = true;
        try { await clerk.organizations.getOrganization({ organizationId: org.clerkOrgId }); }
        catch (error) { if ((error as { status?: number }).status !== 404) throw error; exists = false; }
        if (exists) {
          const members = await clerk.organizations.getOrganizationMembershipList({ organizationId: org.clerkOrgId, limit: 2 });
          if (members.totalCount > 1 || members.data.length > 1) throw Object.assign(new Error("Remove all other Clerk members first."), { status: 409 });
          if (!members.data.some((m) => m.publicUserData?.userId === active.clerkId && m.role === "org:admin")) throw Object.assign(new Error("Current Clerk owner access is required."), { status: 403 });
          const subscription = await clerk.billing.getOrganizationBillingSubscription(org.clerkOrgId);
          if (subscription.subscriptionItems.some((item) => toDrevoPlan(item.plan?.slug) !== "free" && !["ended", "expired", "abandoned"].includes(item.status))) {
            throw Object.assign(new Error("Cancel the paid subscription and wait for its billing period to end before deleting this organization."), { status: 409 });
          }
          await clerk.organizations.deleteOrganization(org.clerkOrgId);
        }
      }
      await tx.organization.deleteMany({ where: { id: parsed.data.organizationId } });
      const next = await tx.organizationMember.findFirst({ where: { userId: active.userId }, select: { organizationId: true }, orderBy: { createdAt: "asc" } });
      await tx.user.updateMany({
        where: { id: active.userId, OR: [{ activeOrganizationId: parsed.data.organizationId }, { activeOrganizationId: null }] },
        data: { activeOrganizationId: next?.organizationId ?? null },
      });
    }, { timeout: 20000 });
  } catch (error) {
    console.error("[orgs/delete] provider-first deletion failed:", error);
    const status = (error as { status?: number }).status;
    return NextResponse.json({ message: status === 409 || status === 403 ? (error as Error).message : "Could not confirm billing and delete the Clerk organization. No local data was deleted." }, { status: status === 409 || status === 403 ? status : 503 });
  }

  return NextResponse.json({ ok: true });
}
