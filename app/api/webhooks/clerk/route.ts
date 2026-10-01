import { NextRequest, NextResponse } from "next/server";
import { Webhook } from "svix";
import { db } from "@/lib/prisma";
import { getClerk } from "@/lib/clerk";
import { subscriptionOrgId, syncOrgPlan, type PaidPeriod } from "@/lib/billing";
import { syncClerkMemberships } from "@/lib/membership-sync";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ message: "CLERK_WEBHOOK_SECRET is not configured." }, { status: 500 });
  const id = request.headers.get("svix-id"), timestamp = request.headers.get("svix-timestamp"), signature = request.headers.get("svix-signature");
  if (!id || !timestamp || !signature) return NextResponse.json({ message: "Missing svix headers." }, { status: 400 });
  const body = await request.text();
  let evt;
  try {
    new Webhook(secret).verify(body, { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signature });
    evt = JSON.parse(body) as {
      type: string;
      data: { id?: string; status?: string; paid_at?: number; updated_at?: number; subscription_items?: PaidPeriod[]; organization?: { id?: string }; organization_id?: string; payer?: { organization_id?: string }; public_user_data?: { user_id?: string }; user_id?: string; email_address?: string; private_metadata?: { drevoOrganizationId?: string } };
    };
  } catch {
    return NextResponse.json({ message: "Invalid signature or payload." }, { status: 400 });
  }
  try {
    const data = evt.data;
    if (evt.type.startsWith("subscription.") || evt.type.startsWith("subscriptionItem.") || evt.type === "paymentAttempt.paid") {
      const clerkOrgId = subscriptionOrgId(data);
      const confirmedAt = data.paid_at ?? data.updated_at;
      const paidPeriods = evt.type === "paymentAttempt.paid" && data.status === "paid" && Number.isSafeInteger(confirmedAt) && Array.isArray(data.subscription_items)
        ? data.subscription_items.map((item) => ({ plan: item.plan, plan_period: item.plan_period, period_start: item.period_start, confirmedAt })) : [];
      if (clerkOrgId) await syncOrgPlan(clerkOrgId, paidPeriods);
      else console.warn(`[webhooks/clerk] ${evt.type} without a payer org — skipped`);
    } else if (evt.type === "organization.created") {
      const localId = data.private_metadata?.drevoOrganizationId;
      if (typeof localId === "string" && typeof data.id === "string") {
        // Exact provisioning metadata only; never guess a creator's other org.
        await db.organization.updateMany({ where: { id: localId, clerkOrgId: null }, data: { clerkOrgId: data.id } });
      }
    } else if (evt.type.startsWith("organizationMembership.") || evt.type === "organizationInvitation.accepted") {
      const clerkOrgId = data.organization?.id ?? data.organization_id;
      let clerkUserId = data.public_user_data?.user_id ?? data.user_id;
      if (!clerkUserId && data.email_address) {
        const user = await db.user.findUnique({ where: { email: data.email_address.toLowerCase() }, select: { clerkId: true } });
        clerkUserId = user?.clerkId;
      }
      if (clerkOrgId && clerkUserId) await syncClerkMemberships(clerkOrgId, clerkUserId);
    } else if (evt.type === "organization.deleted" && data.id) {
      // Verify the current provider state before cascading a delayed event.
      const clerk = await getClerk();
      try { await clerk.organizations.getOrganization({ organizationId: data.id }); }
      catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
        await db.organization.deleteMany({ where: { clerkOrgId: data.id } });
      }
    }
  } catch (error) {
    console.error("[webhooks/clerk] handler failed:", error);
    return NextResponse.json({ message: "Handler failed." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
