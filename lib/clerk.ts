import { clerkClient } from "@clerk/nextjs/server";
import { PLANS } from "./constants";
import type { Plan } from "@/types/plans";

/**
 * B-variant Clerk glue. Clerk owns identity/membership/billing;
 * Prisma mirrors membership + owns app data (workspaces, AI credits).
 *
 * Role mapping (Clerk default roles only — no custom roles):
 *   outbound  OWNER | ADMIN -> "org:admin",  MEMBER -> "org:member"
 *   inbound   "org:admin" -> ADMIN (new memberships only),
 *             "org:member" -> MEMBER (new memberships only).
 * Inbound sync NEVER changes an existing Prisma role, so a Prisma OWNER
 * (stored as org:admin in Clerk) is never demoted by sync.
 */

export type ClerkOrgRole = "org:admin" | "org:member";

export function toClerkRole(role: "OWNER" | "ADMIN" | "MEMBER"): ClerkOrgRole {
  return role === "MEMBER" ? "org:member" : "org:admin";
}

export function toPrismaRole(role: string): "ADMIN" | "MEMBER" {
  return role === "org:admin" ? "ADMIN" : "MEMBER";
}

const VALID_PLANS = new Set<string>(["free", "starter", "pro"]);

/** Map a Clerk plan slug to a Drevo plan; unknown slugs fall back to free. */
export function toDrevoPlan(slug: string | null | undefined): Plan {
  if (slug && VALID_PLANS.has(slug)) return slug as Plan;
  return "free";
}

/** Upgrade-only credit top-up, mirroring the old checkUser delta policy. */
export function toppedUpCredits(currentPlan: string, newPlan: Plan, currentCredits: number): number {
  const delta =
    PLANS[newPlan].credits - (PLANS[currentPlan as Plan]?.credits ?? 0);
  return delta > 0 ? currentCredits + delta : currentCredits;
}

export async function getClerk() {
  return clerkClient();
}
