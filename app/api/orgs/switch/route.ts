import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { db } from "@/lib/prisma";

export const runtime = "nodejs";

const Schema = z.object({ organizationId: z.string().min(1) });

export async function POST(request: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId)
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "Invalid JSON" }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ message: "organizationId required" }, { status: 400 });

  // Never trust client org id: verify membership first.
  const membership = await db.organizationMember.findFirst({
    where: {
      organizationId: parsed.data.organizationId,
      user: { clerkId },
    },
    select: { userId: true, organization: { select: { clerkOrgId: true } } },
  });
  if (!membership)
    return NextResponse.json({ message: "Organization not found" }, { status: 404 });

  await db.user.update({
    where: { id: membership.userId },
    data: { activeOrganizationId: parsed.data.organizationId },
  });

  // Clerk active org must move together with the Prisma pointer, otherwise
  // for="organization" checkout bills the wrong org. The client applies this
  // via setActive({ organization }).
  return NextResponse.json({ ok: true, clerkOrgId: membership.organization.clerkOrgId });
}
