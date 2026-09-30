import { NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { getActiveOrganization } from "@/lib/org";
import { syncOrgPlan } from "@/lib/billing";

export const runtime = "nodejs";

/**
 * Manual plan sync for the active org — fallback when subscription webhooks
 * lag or were missed (e.g. local testing, where Clerk cannot deliver).
 * Reuses the webhook's syncOrgPlan, so it reads Clerk truth and can only
 * mirror plan state, never invent it.
 */
export async function POST() {
  const active = await getActiveOrganization();

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

  try {
    const result = await syncOrgPlan(org.clerkOrgId);
    if (!result) {
      return NextResponse.json(
        { message: "Organization is not linked to Drevo." },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[orgs/billing/sync] plan sync failed:", err);
    return NextResponse.json(
      { message: "Could not sync the plan. Please try again." },
      { status: 503 }
    );
  }
}
