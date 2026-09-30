import { db } from "@/lib/prisma";
import { getClerk, toDrevoPlan, toppedUpCredits } from "@/lib/clerk";
import type { Plan } from "@/types/plans";

export interface SubscriptionEventData {
  payer?: { organization_id?: string } | null;
  organization_id?: string;
  organization?: { id?: string } | null;
}

/**
 * Payer org id across Clerk subscription payload shapes. Clerk has sent
 * payer.organization_id historically, but organization_id / organization.id
 * appear depending on event version — check all three instead of silently
 * skipping the sync when the first shape is absent.
 */
export function subscriptionOrgId(
  data: SubscriptionEventData | null | undefined
): string | null {
  if (!data) return null;
  return (
    data.payer?.organization_id ??
    (typeof data.organization_id === "string" ? data.organization_id : null) ??
    data.organization?.id ??
    null
  );
}

export interface PlanSyncResult {
  plan: Plan;
  credits: number;
  updated: boolean;
}

/**
 * Mirror the Clerk org subscription into Prisma (plan + upgrade-only top-up).
 * Shared by the webhook sink and the manual /api/orgs/billing/sync fallback.
 * Returns null when the Clerk org has no linked Prisma organization.
 */
export async function syncOrgPlan(
  clerkOrgId: string
): Promise<PlanSyncResult | null> {
  const clerk = await getClerk();
  let slug: string | null = null;
  try {
    const sub = await clerk.billing.getOrganizationBillingSubscription(clerkOrgId);
    const item =
      sub.subscriptionItems?.find((i) => i.status === "active") ??
      sub.subscriptionItems?.[0];
    slug = item?.plan?.slug ?? null;
  } catch {
    // No subscription (free / canceled) -> free plan, no top-up.
    slug = null;
  }
  const plan = toDrevoPlan(slug);
  const org = await db.organization.findUnique({
    where: { clerkOrgId },
    select: { id: true, plan: true, credits: true },
  });
  if (!org) {
    console.warn(
      `[billing] plan sync for unlinked clerk org ${clerkOrgId} (slug: ${slug ?? "none"}) — skipped`
    );
    return null;
  }
  if (org.plan === plan)
    return { plan, credits: org.credits, updated: false };
  const credits = toppedUpCredits(org.plan, plan, org.credits);
  await db.organization.update({
    where: { id: org.id },
    data: { plan, credits },
  });
  console.log(
    `[billing] org ${org.id} plan ${org.plan} -> ${plan} (slug: ${slug ?? "none"}), credits ${org.credits} -> ${credits}`
  );
  return { plan, credits, updated: true };
}
