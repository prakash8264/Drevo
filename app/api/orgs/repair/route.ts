import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { getClerk } from "@/lib/clerk";

export const runtime = "nodejs";

const Schema = z.object({ organizationId: z.string().min(1).max(100) });

// Targeted recovery for legacy orgs created without createdBy. Never restore
// a membership in a populated Clerk org: Clerk removals remain authoritative.
export async function POST(request: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "Organization ID required." }, { status: 400 });

  const owner = await db.organizationMember.findFirst({
    where: { organizationId: parsed.data.organizationId, role: "OWNER", user: { clerkId } },
    select: { organization: { select: { id: true, name: true, clerkOrgId: true } } },
  });
  if (!owner) return NextResponse.json({ message: "Only the organization owner can repair Clerk setup." }, { status: 403 });

  try {
    const clerk = await getClerk();
    const org = owner.organization;
    let clerkOrgId = org.clerkOrgId;
    if (!clerkOrgId) {
      // Recover a counterpart whose creation succeeded but DB linking failed.
      let offset = 0;
      for (;;) {
        const page = await clerk.organizations.getOrganizationList({ limit: 100, offset });
        const existing = page.data.find((item) => item.privateMetadata?.drevoOrganizationId === org.id);
        if (existing) { clerkOrgId = existing.id; break; }
        if (page.data.length < 100) break;
        offset += 100;
      }
      if (!clerkOrgId) {
        const created = await clerk.organizations.createOrganization({
          name: org.name, createdBy: clerkId,
          privateMetadata: { drevoOrganizationId: org.id },
        });
        clerkOrgId = created.id;
      }
      await db.organization.update({ where: { id: org.id }, data: { clerkOrgId } });
    }

    const ownMembership = () => clerk.organizations.getOrganizationMembershipList({
      organizationId: clerkOrgId!, userId: [clerkId], limit: 1,
    });
    const isOwnerMember = (list: Awaited<ReturnType<typeof ownMembership>>) => list.data.some(
      (member) => member.publicUserData?.userId === clerkId && member.organization.id === clerkOrgId
    );
    if (!isOwnerMember(await ownMembership())) {
      const members = await clerk.organizations.getOrganizationMembershipList({ organizationId: clerkOrgId, limit: 1 });
      if (members.totalCount > 0 || members.data.length > 0) {
        return NextResponse.json({ message: "This Clerk organization already has members. Ask its administrator to restore your access." }, { status: 409 });
      }
      try {
        await clerk.organizations.createOrganizationMembership({ organizationId: clerkOrgId, userId: clerkId, role: "org:admin" });
      } catch (error) {
        // Concurrent repair may already have added this exact user.
        if (!isOwnerMember(await ownMembership())) throw error;
      }
    }
    return NextResponse.json({ ok: true, clerkOrgId });
  } catch (error) {
    console.error("[orgs/repair] Clerk setup repair failed:", error);
    return NextResponse.json({ message: "Could not repair Clerk organization access. Please try again." }, { status: 503 });
  }
}
