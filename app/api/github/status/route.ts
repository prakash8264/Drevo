import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/prisma";

export async function GET() {
  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });

  const user = await db.user.findUnique({
    where: { clerkId },
    select: { githubAccessToken: true, githubUsername: true },
  });
  if (!user) return NextResponse.json({ message: "User not found." }, { status: 404 });

  // Boolean only. The token itself never leaves the server.
  return NextResponse.json({
    connected: Boolean(user.githubAccessToken),
    username: user.githubUsername,
  });
}
