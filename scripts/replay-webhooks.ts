// Replays realistic Clerk webhook payloads against a local dev server to find
// which event type crashes /api/webhooks/clerk.
// Run with: npx tsx scripts/replay-webhooks.ts  (requires `npm run dev`)
import "dotenv/config";
import crypto from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../lib/generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const db = new PrismaClient({ adapter });

function sign(secret: string, msgId: string, ts: number, payload: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = crypto
    .createHmac("sha256", key)
    .update(`${msgId}.${ts}.${payload}`)
    .digest("base64");
  return `v1,${sig}`;
}

async function send(type: string, data: Record<string, unknown>) {
  const secret = process.env.CLERK_WEBHOOK_SECRET!;
  const msgId = `msg_replay_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const ts = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ type, object: "event", data });
  const res = await fetch("http://localhost:3000/api/webhooks/clerk", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "svix-id": msgId,
      "svix-timestamp": String(ts),
      "svix-signature": sign(secret, msgId, ts, payload),
    },
    body: payload,
  });
  const text = await res.text();
  console.log(`${res.status}  ${type}  -> ${text.slice(0, 200)}`);
}

async function main() {
  const user = await db.user.findFirst({
    select: { clerkId: true, email: true },
  });
  const org = await db.organization.findFirst({
    where: { clerkOrgId: { not: null } },
    select: { clerkOrgId: true, name: true },
  });
  if (!user || !org?.clerkOrgId) throw new Error("need a user + linked org in DB");
  console.log(`using user ${user.clerkId}, org ${org.clerkOrgId}`);

  await send("email.created", { id: "email_x", object: "email" });
  await send("organization.created", {
    id: "org_replay123",
    object: "organization",
    name: "Replay Org",
    slug: "replay-org",
    created_by: user.clerkId,
    created_at: Date.now(),
    updated_at: Date.now(),
  });
  await send("organizationMembership.created", {
    id: "orgmem_replay",
    object: "organization_membership",
    role: "org:member",
    organization: { id: org.clerkOrgId, object: "organization", name: org.name },
    public_user_data: { user_id: user.clerkId, identifier: user.email },
  });
  await send("organizationInvitation.accepted", {
    id: "orginv_replay",
    object: "organization_invitation",
    status: "accepted",
    user_id: user.clerkId,
    email_address: user.email,
    role: "org:member",
    organization_id: org.clerkOrgId,
  });
  await send("organizationMembership.deleted", {
    id: "orgmem_replay",
    object: "organization_membership",
    role: "org:member",
    // Fake org on purpose: the handler must warn-skip without touching real rows.
    organization: { id: "org_fake000000000000000000000", object: "organization", name: "Fake" },
    public_user_data: { user_id: user.clerkId, identifier: user.email },
  });
  await send("subscription.created", {
    id: "sub_replay",
    object: "commerce_subscription",
    status: "active",
    payer_id: "payer_x",
    // Fake org on purpose: unknown orgs return before any write.
    payer: { organization_id: "org_fake000000000000000000000" },
    items: [],
  });
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
