import { clerkClient } from "@clerk/nextjs/server";
import type { Plan } from "@/types/plans";

/**
 * B-variant Clerk glue. Clerk owns identity/membership/billing;
 * Prisma mirrors membership + owns app data (workspaces, AI credits).
 *
 * Role mapping (Clerk default roles only — no custom roles):
 *   outbound  OWNER | ADMIN -> "org:admin",  MEMBER -> "org:member"
 *   inbound   "org:admin" -> ADMIN (new memberships only),
 *             "org:member" -> MEMBER (new memberships only).
 * Inbound sync preserves OWNER only when the current Clerk role is org:admin.
 * Clerk role changes/removals otherwise remain authoritative.
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
// Clerk slugs are the dashboard "Key" (e.g. starterorg for the Starter org
// plan), not the display Name, so accept both forms here.
export function toDrevoPlan(slug: string | null | undefined): Plan {
  if (!slug) return "free";
  const key = slug.trim().toLowerCase();
  if (key === "starterorg" || key === "starter_org" || key === "starter-org")
    return "starter";
  if (key === "proorg" || key === "pro_org" || key === "pro-org")
    return "pro";
  if (VALID_PLANS.has(key)) return key as Plan;
  return "free";
}

export async function getClerk() {
  return clerkClient();
}
