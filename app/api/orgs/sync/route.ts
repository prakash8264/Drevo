import { NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { getActiveOrganization } from "@/lib/org";
import { syncClerkMemberships } from "@/lib/membership-sync";

export const runtime = "nodejs";

export async function POST() {
  const active = await getActiveOrganization();
  if (active.role !== "OWNER" && active.role !== "ADMIN") return NextResponse.json({ message: "Forbidden" }, { status: 403 });
  const org = await db.organization.findUnique({ where: { id: active.organization.id }, select: { clerkOrgId: true } });
  if (!org?.clerkOrgId) return NextResponse.json({ message: "Organization is not linked to Clerk yet." }, { status: 409 });
  try {
    const result = await syncClerkMemberships(org.clerkOrgId);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[orgs/sync] authoritative sync failed:", error);
    return NextResponse.json({ message: "Could not sync memberships. Please retry." }, { status: 503 });
  }
}
