import { NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { getActiveOrganization } from "@/lib/org";

export const runtime = "nodejs";

// Any org member can list membership (read-only foundation for member UI).
// Invites / role changes / removals are a later phase.
export async function GET() {
  const active = await getActiveOrganization();

  const members = await db.organizationMember.findMany({
    where: { organizationId: active.organization.id },
    select: {
      id: true,
      role: true,
      createdAt: true,
      user: { select: { id: true, name: true, email: true, imageUrl: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({
    organizationId: active.organization.id,
    role: active.role,
    members: members.map((m) => ({
      id: m.id,
      role: m.role,
      createdAt: m.createdAt,
      user: m.user,
      isSelf: m.user.id === active.userId,
    })),
  });
}
