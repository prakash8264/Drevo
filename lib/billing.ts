import { db } from "@/lib/prisma";
import { getClerk, toDrevoPlan } from "@/lib/clerk";
import { PLANS } from "@/lib/constants";
import type { Plan } from "@/types/plans";

export interface SubscriptionEventData {
  payer?: { organization_id?: string } | null;
  organization_id?: string;
  organization?: { id?: string } | null;
}

export function subscriptionOrgId(data: SubscriptionEventData | null | undefined): string | null {
  const id = data?.payer?.organization_id ?? data?.organization_id ?? data?.organization?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export interface PlanSyncResult { plan: Plan; credits: number; updated: boolean }
export interface PaidPeriod {
  plan?: { slug?: string } | null;
  plan_period?: string;
  period_start?: number;
  confirmedAt?: number;
}

/** An active, non-trial Clerk monthly period is the allocation authority.
 * Read under the org lock so concurrent syncs cannot apply stale snapshots.
 * Every grant and increment commits together; cancellation never claws back.
 */
export async function syncOrgPlan(clerkOrgId: string, paidPeriods: PaidPeriod[] = []): Promise<PlanSyncResult | null> {
  const clerk = await getClerk();
  return db.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Organization" WHERE "clerkOrgId" = ${clerkOrgId} FOR UPDATE`;
    if (!locked) return null;
    const org = await tx.organization.findUniqueOrThrow({ where: { id: locked.id } });
    // Do NOT reinterpret provider 404/429/5xx as Free. Only a successful
    // authoritative subscription read may change the mirrored plan.
    const sub = await clerk.billing.getOrganizationBillingSubscription(clerkOrgId);
    const now = Date.now();
    const rank = { free: 0, starter: 1, pro: 2 };
    const eligible = sub.subscriptionItems.filter((i) =>
      ["active", "past_due", "canceled"].includes(i.status) &&
      i.periodStart <= now && (i.periodEnd === null || i.periodEnd > now)
    );
    const item = eligible.sort((a, b) =>
      rank[toDrevoPlan(b.plan?.slug)] - rank[toDrevoPlan(a.plan?.slug)] || b.periodStart - a.periodStart
    )[0];
    const plan = toDrevoPlan(item?.plan?.slug);
    let allocation = 0;
    // Only the verified paymentAttempt.paid webhook passes historical periods.
    // This also recovers a delayed renewal after a newer period/cancellation.
    const periods = paidPeriods.slice(0, 100).filter((period) => period.plan_period === "month" &&
      Number.isSafeInteger(period.period_start) && period.period_start! > 0 && period.period_start! <= now &&
      Number.isSafeInteger(period.confirmedAt) && period.confirmedAt! > 0 && period.confirmedAt! <= now + 60000
    ).map((period) => ({ plan: toDrevoPlan(period.plan?.slug), start: period.period_start!, confirmedAt: period.confirmedAt }));
    if (item && plan !== "free" && item.status === "active" && item.isFreeTrial === false &&
        item.planPeriod === "month" && Number.isSafeInteger(item.periodStart) && item.periodStart > 0) {
      periods.push({ plan, start: item.periodStart, confirmedAt: undefined });
    }
    for (const period of periods) {
      if (period.plan === "free") continue;
      // Org-scoped, independent of subscription item replacement/payment retries.
      const key = `${period.plan}:${period.start}`;
      // Old paid balances already include the current historical period.
      // Seed a zero-value receipt rather than awarding it for a second time.
      const historical = period.confirmedAt !== undefined
        ? period.confirmedAt <= org.billingBaselineAt.getTime()
        : period.plan === org.billingBaselinePlan && period.start <= org.billingBaselineAt.getTime();
      const inserted = await tx.organizationCreditGrant.createMany({
        data: [{ organizationId: org.id, key, credits: historical ? 0 : PLANS[period.plan].credits }],
        skipDuplicates: true,
      });
      if (inserted.count && !historical) allocation += PLANS[period.plan].credits;
    }
    const updated = org.plan !== plan || allocation > 0;
    const result = updated ? await tx.organization.update({
      where: { id: org.id }, data: { plan, ...(allocation ? { credits: { increment: allocation } } : {}) },
      select: { credits: true },
    }) : org;
    return { plan, credits: result.credits, updated };
  }, { timeout: 20000 });
}
