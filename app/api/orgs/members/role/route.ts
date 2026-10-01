import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { getActiveOrganization } from "@/lib/org";
import { getClerk, toClerkRole } from "@/lib/clerk";

export const runtime = "nodejs";

const PatchSchema = z.object({
  memberId: z.string().min(1),
  role: z.enum(["ADMIN", "MEMBER"]),
});

// OWNER/ADMIN changes ADMIN/MEMBER roles. Ownership transfer is not exposed.
// Never demote an OWNER; nobody changes their own role.
export async function PATCH(request: NextRequest) {
  const active = await getActiveOrganization();
  if (active.role !== "OWNER" && active.role !== "ADMIN") {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "Invalid JSON" }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ message: "memberId + role required" }, { status: 400 });

  const target = await db.organizationMember.findFirst({
    where: { id: parsed.data.memberId, organizationId: active.organization.id },
    select: { id: true, role: true, userId: true, user: { select: { clerkId: true } } },
  });
  if (!target)
    return NextResponse.json({ message: "Member not found" }, { status: 404 });
  if (target.userId === active.userId) {
    return NextResponse.json(
      { message: "You cannot change your own role." },
      { status: 403 }
    );
  }
  // ADMINs cannot touch OWNERs.
  if (active.role === "ADMIN" && target.role === "OWNER") {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 });
  }

  // Ownership transfer is not supported by this ADMIN/MEMBER-only endpoint.
  if (target.role === "OWNER") {
    return NextResponse.json({ message: "OWNER roles cannot be changed by this endpoint." }, { status: 409 });
  }

  try {
    const clerk = await getClerk();
    await db.$transaction(async (tx) => {
      const [org] = await tx.$queryRaw<{ clerkOrgId: string | null }[]>`SELECT "clerkOrgId" FROM "Organization" WHERE "id" = ${active.organization.id} FOR UPDATE`;
      if (!org?.clerkOrgId) throw new Error("Organization is not linked to Clerk.");
      const caller = await tx.organizationMember.findUnique({ where: { id: active.membership.id } });
      const fresh = await tx.organizationMember.findUnique({ where: { id: target.id } });
      if (!caller || !["OWNER", "ADMIN"].includes(caller.role) || !fresh || fresh.role === "OWNER") throw new Error("Member permissions changed. Reload and try again.");
      const currentCaller = await clerk.organizations.getOrganizationMembershipList({ organizationId: org.clerkOrgId, userId: [active.clerkId], limit: 1 });
      if (!currentCaller.data.some((m) => m.publicUserData?.userId === active.clerkId && m.role === "org:admin")) throw new Error("Clerk administrator access is required");
      await clerk.organizations.updateOrganizationMembership({ organizationId: org.clerkOrgId, userId: target.user.clerkId, role: toClerkRole(parsed.data.role) });
      await tx.organizationMember.update({ where: { id: target.id }, data: { role: parsed.data.role } });
    }, { timeout: 20000 });
  } catch (error) {
    console.error("[orgs/members/role] Clerk-first role change failed:", error);
    return NextResponse.json({ message: "Could not update the member role. Please retry." }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}
