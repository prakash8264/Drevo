import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { getActiveOrganization } from "@/lib/org";
import { db } from "@/lib/prisma";

export const runtime = "nodejs";

const Schema = z.object({ clerkOrgId: z.string().regex(/^org_[a-zA-Z0-9]+$/).max(100) });

// Authorization/preflight only. Clerk still owns and opens the checkout.
export async function POST(request: NextRequest) {
  const { userId, orgId } = await auth();
  if (!userId) return NextResponse.json({ message: "Sign in before upgrading." }, { status: 401 });
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "Activate the selected organization before upgrading." }, { status: 409 });

  const active = await getActiveOrganization();
  if (active.role !== "OWNER") {
    return NextResponse.json({ message: "Only the organization owner can change the plan." }, { status: 403 });
  }
  const org = await db.organization.findUnique({ where: { id: active.organization.id }, select: { clerkOrgId: true } });
  if (!org?.clerkOrgId || org.clerkOrgId !== orgId || org.clerkOrgId !== parsed.data.clerkOrgId) {
    return NextResponse.json({ message: "Checkout blocked: Clerk and Drevo have different active organizations. Select the organization again in the switcher before upgrading." }, { status: 409 });
  }
  return NextResponse.json({ ok: true, clerkOrgId: org.clerkOrgId });
}
