import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { getActiveOrganization } from "@/lib/org";

export const runtime = "nodejs";

const PatchSchema = z.object({
  memberId: z.string().min(1),
  role: z.enum(["ADMIN", "MEMBER"]),
});

// OWNER/ADMIN changes a member's role (OWNER transfer via promotion happens
// implicitly: promoting a second OWNER first, then the old OWNER steps down).
// Rules: never demote/remove the sole OWNER; nobody changes their own role.
export async function PATCH(request: NextRequest) {
  const active = await getActiveOrganization();
  if (active.role !== "OWNER" && active.role !== "ADMIN") {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "Invalid JSON" }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ message: "memberId + role required" }, { status: 400 });

  const target = await db.organizationMember.findFirst({
    where: { id: parsed.data.memberId, organizationId: active.organization.id },
    select: { id: true, role: true, userId: true },
  });
  if (!target)
    return NextResponse.json({ message: "Member not found" }, { status: 404 });
  if (target.userId === active.userId) {
    return NextResponse.json(
      { message: "You cannot change your own role." },
      { status: 403 }
    );
  }
  // ADMINs cannot touch OWNERs.
  if (active.role === "ADMIN" && target.role === "OWNER") {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 });
  }
  if (target.role === parsed.data.role) {
    return NextResponse.json({ ok: true });
  }

  // Demoting an OWNER: refuse when they are the last one.
  if (target.role === "OWNER") {
    const owners = await db.organizationMember.count({
      where: { organizationId: active.organization.id, role: "OWNER" },
    });
    if (owners <= 1) {
      return NextResponse.json(
        { message: "Promote another OWNER first — an organization must keep one." },
        { status: 409 }
      );
    }
  }

  await db.organizationMember.update({
    where: { id: target.id },
    data: { role: parsed.data.role },
  });
  return NextResponse.json({ ok: true });
}
