import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { getActiveOrganization } from "@/lib/org";
import { getClerk, toClerkRole } from "@/lib/clerk";
import { syncClerkMemberships } from "@/lib/membership-sync";

export const runtime = "nodejs";

const AddSchema = z.object({
  email: z.string().email().max(320),
  // OWNER is a local distinction and cannot be granted by an invitation.
  role: z.enum(["ADMIN", "MEMBER"]).optional().default("MEMBER"),
});

function clerkDetail(err: unknown): string {
  const errors = (err as { errors?: { code?: string; message?: string; longMessage?: string }[] })?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    return first.longMessage || first.message || first.code || "Invite failed.";
  }
  return err instanceof Error ? err.message : "Invite failed.";
}

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
  const email = parsed.data.email.toLowerCase();

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
    where: { email },
    select: { id: true, clerkId: true },
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
    if (existing) {
      try { await syncClerkMemberships(org.clerkOrgId, targetUser.clerkId); }
      catch { return NextResponse.json({ message: "Could not verify current membership. Please retry." }, { status: 503 }); }
      if (await db.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: active.organization.id, userId: targetUser.id } } })) {
        return NextResponse.json({ message: "Already a member." }, { status: 409 });
      }
    }
  }

  const clerk = await getClerk();

  // Clerk-side pre-checks: a pending invite or an existing Clerk membership
  // (diverged from Prisma) both make createOrganizationInvitation 400.
  try {
    const [invites, members, caller] = await Promise.all([
      clerk.organizations.getOrganizationInvitationList({
        organizationId: org.clerkOrgId,
        status: ["pending"],
        limit: 100,
      }),
      clerk.organizations.getOrganizationMembershipList({
        organizationId: org.clerkOrgId,
        limit: 100,
      }),
      clerk.organizations.getOrganizationMembershipList({ organizationId: org.clerkOrgId, userId: [active.clerkId], limit: 1 }),
    ]);
    if (!caller.data.some((m) => m.publicUserData?.userId === active.clerkId && m.role === "org:admin")) {
      return NextResponse.json({ message: "Current Clerk administrator access is required." }, { status: 403 });
    }
    if (invites.data.some((i) => i.emailAddress.toLowerCase() === email)) {
      return NextResponse.json(
        { message: "An invitation is already pending for this email." },
        { status: 409 }
      );
    }
    const clerkMember = members.data.find(
      (m) => m.publicUserData?.identifier?.toLowerCase() === email
    );
    if (clerkMember?.publicUserData?.userId) {
      // Re-read current provider truth under the same lock as every other writer.
      await syncClerkMemberships(org.clerkOrgId, clerkMember.publicUserData.userId);
      return NextResponse.json(
        { message: "Already a member of this organization (membership synced)." },
        { status: 409 }
      );
    }
  } catch (err) {
    console.error("[orgs/members/add] clerk pre-check failed:", err);
    return NextResponse.json({ message: "Could not verify Clerk membership and invitations. Please retry." }, { status: 503 });
  }

  try {
    // Redirect to /accept-invitation so Clerk tickets can be consumed properly
    // and the user is redirected to /projects with the organization active.
    const origin =
      process.env.NEXT_PUBLIC_APP_URL?.trim() ||
      new URL(request.url).origin;
    await clerk.organizations.createOrganizationInvitation({
      organizationId: org.clerkOrgId,
      emailAddress: email,
      role: toClerkRole(parsed.data.role),
      inviterUserId: active.clerkId,
      redirectUrl: `${origin}/accept-invitation?organization_id=${encodeURIComponent(org.clerkOrgId)}`,
    });
  } catch (err) {
    console.error("[orgs/members/add] clerk invite failed:", JSON.stringify((err as { errors?: unknown })?.errors ?? err));
    const status = (err as { status?: number })?.status ?? 500;
    return NextResponse.json(
      { message: clerkDetail(err), source: "clerk" },
      { status: status >= 400 && status < 600 ? status : 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
