import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { getActiveOrganization } from "@/lib/org";
import { getClerk, toClerkRole } from "@/lib/clerk";

export const runtime = "nodejs";

const AddSchema = z.object({
  email: z.string().email().max(320),
  // Drevo role for the invitee. OWNER cannot be granted by invite:
  // promote to OWNER afterwards from the members dialog instead.
  role: z.enum(["ADMIN", "MEMBER"]).optional().default("MEMBER"),
});

// OWNER/ADMIN invites via Clerk Organization Invitations — Clerk sends the
// email. Works for new and existing users alike (Clerk matches by email on
// accept). Prisma membership is created by the membership webhook, never here,
// so there is exactly one membership writer.
export async function POST(request: NextRequest) {
  const active = await getActiveOrganization();
  if (active.role !== "OWNER" && active.role !== "ADMIN") {
    return NextResponse.json({ message: "Forbidden: your role in this organization is MEMBER.", source: "prisma" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "Invalid JSON" }, { status: 400 });
  }
  const parsed = AddSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ message: "Valid email required" }, { status: 400 });

  const org = await db.organization.findUnique({
    where: { id: active.organization.id },
    select: { clerkOrgId: true },
  });
  if (!org?.clerkOrgId) {
    return NextResponse.json(
      { message: "Organization is not linked to Clerk yet." },
      { status: 409 }
    );
  }

  // Already a member (either system)? Don't send a pointless invite.
  const targetUser = await db.user.findUnique({
    where: { email: parsed.data.email.toLowerCase() },
    select: { id: true },
  });
  if (targetUser) {
    const existing = await db.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: active.organization.id,
          userId: targetUser.id,
        },
      },
      select: { id: true },
    });
    if (existing)
      return NextResponse.json({ message: "Already a member." }, { status: 409 });
  }

  try {
    const clerk = await getClerk();
    await clerk.organizations.createOrganizationInvitation({
      organizationId: org.clerkOrgId,
      emailAddress: parsed.data.email.toLowerCase(),
      role: toClerkRole(parsed.data.role),
      inviterUserId: active.clerkId,
      redirectUrl: "/workspace",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invite failed.";
    const status = (err as { status?: number })?.status ?? 500;
    return NextResponse.json(
      { message: msg, source: "clerk" },
      { status: status >= 400 && status < 600 ? status : 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
