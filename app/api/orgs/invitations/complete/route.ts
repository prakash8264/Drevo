import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { syncClerkMemberships } from "@/lib/membership-sync";

export const runtime = "nodejs";
const Schema = z.object({ clerkOrgId: z.string().regex(/^org_[a-zA-Z0-9]+$/).max(100) });

export async function POST(request: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ message: "Sign in to accept the invitation." }, { status: 401 });
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "A valid Clerk organization ID is required." }, { status: 400 });
  try {
    const result = await syncClerkMemberships(parsed.data.clerkOrgId, clerkId, true);
    if (!result) return NextResponse.json({ message: "This organization is not linked to Drevo." }, { status: 409 });
    if (!result.total) return NextResponse.json({ message: "Clerk has not confirmed your membership. Check the invited account and invitation status." }, { status: 403 });
    return NextResponse.json({ ok: true, clerkOrgId: parsed.data.clerkOrgId });
  } catch (error) {
    console.error("[orgs/invitations/complete] membership sync failed:", error);
    return NextResponse.json({ message: "Could not verify your membership. Please retry." }, { status: 503 });
  }
}
