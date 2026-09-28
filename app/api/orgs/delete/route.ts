import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { getActiveOrganization } from "@/lib/org";

export const runtime = "nodejs";

const Schema = z.object({ organizationId: z.string().min(1) });

// OWNER-only. Destroys the org with all its workspaces/versions (FK cascade)
// and memberships. Members keep their accounts; their active pointers repair
// to another org or null. Cannot delete your only org while it still has
// other members — remove them first.
export async function DELETE(request: NextRequest) {
  const active = await getActiveOrganization();
  if (active.role !== "OWNER") {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "Invalid JSON" }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ message: "organizationId required" }, { status: 400 });

  const membership = await db.organizationMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId: parsed.data.organizationId,
        userId: active.userId,
      },
    },
    select: { role: true },
  });
  if (!membership || membership.role !== "OWNER") {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 });
  }

  const others = await db.organizationMember.count({
    where: {
      organizationId: parsed.data.organizationId,
      userId: { not: active.userId },
    },
  });
  if (others > 0) {
    return NextResponse.json(
      { message: "Remove all other members first." },
      { status: 409 }
    );
  }

  await db.organization.delete({ where: { id: parsed.data.organizationId } });

  // Repair my active pointer to another org (or null → recreated on next load).
  const next = await db.organizationMember.findFirst({
    where: { userId: active.userId },
    select: { organizationId: true },
    orderBy: { createdAt: "asc" },
  });
  await db.user.update({
    where: { id: active.userId },
    data: { activeOrganizationId: next?.organizationId ?? null },
  });

  return NextResponse.json({ ok: true });
}
