import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getClerk, toPrismaRole } from "@/lib/clerk";
import { db } from "@/lib/prisma";

export const runtime = "nodejs";

const Schema = z.object({ clerkOrgId: z.string().regex(/^org_[a-zA-Z0-9]+$/).max(100) });

// Completes an already accepted Clerk invitation. Never creates Clerk
// memberships or authorizes access from a client-supplied organization ID.
export async function POST(request: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ message: "Sign in to accept the invitation." }, { status: 401 });

  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "A valid Clerk organization ID is required." }, { status: 400 });
  const { clerkOrgId } = parsed.data;

  try {
    const clerk = await getClerk();
    const memberships = await clerk.organizations.getOrganizationMembershipList({
      organizationId: clerkOrgId, userId: [clerkId], limit: 1,
    });
    const membership = memberships.data.find((member) =>
      member.publicUserData?.userId === clerkId && member.organization.id === clerkOrgId
    );
    if (!membership) {
      return NextResponse.json({ message: "Clerk has not confirmed your membership in this organization. Sign in with the invited email address, or ask the inviter to check whether the invitation is still pending or has expired." }, { status: 403 });
    }

    const org = await db.organization.findUnique({ where: { clerkOrgId }, select: { id: true } });
    if (!org) return NextResponse.json({ message: "This organization is not linked to Drevo. Ask the organization owner to contact support." }, { status: 409 });

    const clerkUser = await clerk.users.getUser(clerkId);
    const email = clerkUser.emailAddresses.find((address) => address.id === clerkUser.primaryEmailAddressId)?.emailAddress;
    if (!email) return NextResponse.json({ message: "A primary email address is required to join this organization." }, { status: 409 });
    const role = toPrismaRole(membership.role);

    await db.$transaction(async (tx) => {
      const user = await tx.user.upsert({
        where: { clerkId }, update: {},
        create: {
          clerkId, email,
          name: [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" "),
          imageUrl: clerkUser.imageUrl ?? "",
        },
      });
      const mirrored = await tx.organizationMember.upsert({
        where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
        update: {},
        create: { organizationId: org.id, userId: user.id, role },
      });
      // OWNER is a local distinction within Clerk's org:admin role.
      if (mirrored.role !== "OWNER" && mirrored.role !== role) {
        await tx.organizationMember.update({ where: { id: mirrored.id }, data: { role } });
      }
      await tx.user.update({ where: { id: user.id }, data: { activeOrganizationId: org.id } });
    });

    return NextResponse.json({ ok: true, clerkOrgId });
  } catch (error) {
    console.error("[orgs/invitations/complete] membership verification or sync failed:", error);
    return NextResponse.json({ message: "Could not verify and sync your organization membership. Please try again." }, { status: 503 });
  }
}
