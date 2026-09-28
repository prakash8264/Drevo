import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET() {
  const { userId: clerkId } = await auth();
  if (!clerkId)
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });

  const user = await db.user.findUnique({
    where: { clerkId },
    select: {
      activeOrganizationId: true,
      memberships: {
        select: {
          role: true,
          organization: {
            select: { id: true, name: true, plan: true, credits: true, clerkOrgId: true },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!user)
    return NextResponse.json({ message: "User not found" }, { status: 404 });

  return NextResponse.json({
    activeOrganizationId: user.activeOrganizationId,
    orgs: user.memberships.map((m) => ({
      id: m.organization.id,
      name: m.organization.name,
      plan: m.organization.plan,
      credits: m.organization.credits,
      role: m.role,
      clerkOrgId: m.organization.clerkOrgId,
    })),
  });
}
