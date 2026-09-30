import { NextRequest, NextResponse } from "next/server";
import { Webhook } from "svix";
import { db } from "@/lib/prisma";
import { getClerk, toPrismaRole } from "@/lib/clerk";
import { subscriptionOrgId, syncOrgPlan } from "@/lib/billing";

export const runtime = "nodejs";

/**
 * Clerk webhook sink (B-variant sync layer).
 *   subscription.*                  -> Organization.plan + upgrade-only credit top-up
 *   organizationMembership.created   -> upsert User + Prisma membership (new only;
 *                                      never changes an existing Prisma role)
 *   organizationInvitation.accepted  -> same as membership.created (idempotent)
 *   organizationMembership.deleted   -> delete Prisma membership + repair pointer
 *
 * Requires CLERK_WEBHOOK_SECRET (Dashboard -> Webhooks -> endpoint secret).
 * Verify: npx tsc --noEmit && npm run build.
 */

async function upsertMembership(clerkOrgId: string, clerkUserId: string, clerkRole: string) {
  const org = await db.organization.findUnique({
    where: { clerkOrgId },
    select: { id: true, name: true },
  });
  if (!org) {
    console.warn(`[webhooks/clerk] membership for unlinked clerk org ${clerkOrgId} — skipped`);
    return;
  }

  let user = await db.user.findUnique({
    where: { clerkId: clerkUserId },
    select: { id: true, activeOrganizationId: true },
  });
  if (!user) {
    const clerk = await getClerk();
    const cu = await clerk.users.getUser(clerkUserId);
    const email = cu.emailAddresses.find((e) => e.id === cu.primaryEmailAddressId)
      ?.emailAddress ?? cu.emailAddresses[0]?.emailAddress ?? "";
    user = await db.user.create({
      data: {
        clerkId: clerkUserId,
        name: `${cu.firstName ?? ""} ${cu.lastName ?? ""}`.trim(),
        email,
        imageUrl: cu.imageUrl ?? "",
        activeOrganizationId: org.id,
      },
      select: { id: true, activeOrganizationId: true },
    });
    const { ensurePersonalOrganization } = await import("@/lib/org");
    await ensurePersonalOrganization(user.id);
    user = await db.user.findUnique({
      where: { id: user.id },
      select: { id: true, activeOrganizationId: true },
    });
  }
  if (!user) return;

  // New memberships only — never rewrite an existing Prisma role
  // (a Prisma OWNER is org:admin in Clerk and must not be demoted by sync).
  const existing = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
    select: { id: true },
  });
  if (!existing) {
    await db.organizationMember.create({
      data: { organizationId: org.id, userId: user.id, role: toPrismaRole(clerkRole) },
    });
  }
  // Delayed/replayed webhooks must not override an explicit org selection.
  if (!user.activeOrganizationId) {
    await db.user.update({
      where: { id: user.id },
      data: { activeOrganizationId: org.id },
    });
  }
}

async function deleteMembership(clerkOrgId: string, clerkUserId: string) {
  const org = await db.organization.findUnique({
    where: { clerkOrgId },
    select: { id: true },
  });
  const user = await db.user.findUnique({
    where: { clerkId: clerkUserId },
    select: { id: true },
  });
  if (!org || !user) {
    console.warn(
      `[webhooks/clerk] membership.deleted skipped (org known: ${Boolean(org)}, user known: ${Boolean(user)})`
    );
    return;
  }
  await db.organizationMember.deleteMany({
    where: { organizationId: org.id, userId: user.id },
  });
  const next = await db.organizationMember.findFirst({
    where: { userId: user.id },
    select: { organizationId: true },
    orderBy: { createdAt: "asc" },
  });
  await db.user.update({
    where: { id: user.id },
    data: { activeOrganizationId: next?.organizationId ?? null },
  });
}

export async function POST(request: NextRequest) {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { message: "CLERK_WEBHOOK_SECRET is not configured." },
      { status: 500 }
    );
  }

  const svixId = request.headers.get("svix-id");
  const svixTimestamp = request.headers.get("svix-timestamp");
  const svixSignature = request.headers.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ message: "Missing svix headers." }, { status: 400 });
  }

  const body = await request.text();
  // Signatures cover the original bytes, not a re-serialized JSON object.
  try {
    const wh = new Webhook(secret);
    wh.verify(body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    });
  } catch {
    return NextResponse.json({ message: "Invalid signature." }, { status: 400 });
  }
  let evt: { type: string; data: Record<string, unknown> };
  try {
    evt = JSON.parse(body);
  } catch {
    return NextResponse.json({ message: "Invalid JSON." }, { status: 400 });
  }

  try {
    const data = evt.data as {
      id?: string;
      created_by?: string;
      payer?: { organization_id?: string };
      organization?: { id?: string };
      organization_id?: string;
      email_address?: string;
      public_user_data?: { user_id?: string };
      user_id?: string;
      role?: string;
      private_metadata?: { drevoOrganizationId?: string };
    };

    switch (evt.type) {
      case "subscription.created":
      case "subscription.updated":
      case "subscription.active":
      case "subscription.pastDue": {
        // Payload shape varies by event version (payer.organization_id vs
        // organization_id vs organization.id) — a miss here used to skip the
        // sync silently, so log the outcome either way.
        const clerkOrgId = subscriptionOrgId(data);
        if (clerkOrgId) {
          await syncOrgPlan(clerkOrgId);
        } else {
          console.warn(
            `[webhooks/clerk] ${evt.type} without a payer org id — skipped`,
            JSON.stringify(data).slice(0, 500)
          );
        }
        break;
      }
      case "organization.created": {
        // Auto-link: a Clerk org created outside our code (e.g. dashboard
        // auto-create toggle) attaches to its creator's unlinked personal org.
        const clerkOrgId = typeof data.id === "string" ? data.id : null;
        const createdBy = typeof data.created_by === "string" ? data.created_by : null;
        const localId = data.private_metadata?.drevoOrganizationId;
        if (clerkOrgId && typeof localId === "string") {
          // App-created orgs identify the exact row. Never attach a delayed
          // event to a different unlinked org belonging to the same creator.
          await db.organization.updateMany({ where: { id: localId, clerkOrgId: null }, data: { clerkOrgId } });
          break;
        }
        if (clerkOrgId && createdBy) {
          if (await db.organization.findUnique({ where: { clerkOrgId }, select: { id: true } })) break;
          const creator = await db.user.findUnique({
            where: { clerkId: createdBy },
            select: {
              id: true,
              memberships: {
                where: { role: "OWNER" },
                select: {
                  organizationId: true,
                  organization: { select: { id: true, clerkOrgId: true } },
                },
                orderBy: { createdAt: "asc" },
              },
            },
          });
          const unlinked = creator?.memberships.find(
            (m) => !m.organization.clerkOrgId
          );
          if (unlinked) {
            await db.organization.update({
              where: { id: unlinked.organization.id },
              data: { clerkOrgId },
            });
          }
        }
        break;
      }
      case "organizationMembership.created":
      case "organizationInvitation.accepted": {
        const clerkOrgId =
          data.organization?.id ??
          (typeof data.organization_id === "string" ? data.organization_id : undefined);
        let clerkUserId = data.public_user_data?.user_id ?? data.user_id;
        if (!clerkUserId && typeof data.email_address === "string") {
          const userByEmail = await db.user.findUnique({
            where: { email: data.email_address.toLowerCase() },
            select: { clerkId: true },
          });
          if (userByEmail) clerkUserId = userByEmail.clerkId;
        }
        const role = typeof data.role === "string" ? data.role : "org:member";
        if (clerkOrgId && clerkUserId) {
          await upsertMembership(clerkOrgId, clerkUserId, role);
        }
        break;
      }
      case "organizationMembership.deleted": {
        const clerkOrgId = data.organization?.id;
        const clerkUserId = data.public_user_data?.user_id ?? data.user_id;
        if (clerkOrgId && clerkUserId) {
          await deleteMembership(clerkOrgId, clerkUserId);
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error("[webhooks/clerk] handler failed:", err);
    return NextResponse.json({ message: "Handler failed." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
