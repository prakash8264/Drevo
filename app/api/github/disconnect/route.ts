import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/prisma";

export async function DELETE() {
  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });

  await db.user.update({
    where: { clerkId },
    data: {
      githubAccessToken: null,
      githubUsername: null,
      githubUserId: null,
      githubConnectedAt: null,
    },
  });

  // Already-pushed repos on GitHub are untouched; this only revokes future pushes.
  return NextResponse.json({ ok: true });
}
