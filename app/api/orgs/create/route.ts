import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { PLANS } from "@/lib/constants";

export const runtime = "nodejs";

const Schema = z.object({ name: z.string().trim().min(1).max(60) });

// Create a new organization owned by the caller. Prisma-first, Clerk-second
// (same pattern as personal-org provisioning in lib/org.ts): if the Clerk
// create fails we keep the Prisma org unlinked and it heals later via
// backfill/webhook — invites/checkout 409 clearly until linked.
export async function POST(request: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId)
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });

  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { message: "Organization name is required (1–60 characters)." },
      { status: 400 }
    );

  const user = await db.user.findUnique({
    where: { clerkId },
    select: { id: true },
  });
  if (!user)
    return NextResponse.json({ message: "User not found" }, { status: 404 });

  let organizationId: string | null = null;
  await db.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: { name: parsed.data.name, plan: "free", credits: PLANS.free.credits },
    });
    await tx.organizationMember.create({
      data: { organizationId: org.id, userId: user.id, role: "OWNER" },
    });
    await tx.user.update({
      where: { id: user.id },
      data: { activeOrganizationId: org.id },
    });
    organizationId = org.id;
  });
  if (!organizationId)
    return NextResponse.json(
      { message: "Could not create organization." },
      { status: 500 }
    );

  let clerkOrgId: string | null = null;
  try {
    const { getClerk } = await import("@/lib/clerk");
    const clerk = await getClerk();
    const created = await clerk.organizations.createOrganization({
      name: parsed.data.name,
    });
    clerkOrgId = created.id;
    await db.organization.update({
      where: { id: organizationId },
      data: { clerkOrgId },
    });
  } catch (err) {
    console.error(
      "[orgs/create] Clerk org auto-create failed (will backfill later):",
      err
    );
  }

  return NextResponse.json({ ok: true, organizationId, clerkOrgId });
}
