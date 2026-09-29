// Read-only reconciliation dry-run: compares Clerk orgs/memberships against
// Prisma orgs/memberships and prints what an apply run would create.
// Run with: npx tsx scripts/reconcile-clerk-dryrun.ts
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../lib/generated/prisma/client.js";
import { createClerkClient } from "@clerk/backend";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const db = new PrismaClient({ adapter });

async function main() {
  const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

  const clerkOrgs: { id: string; name: string }[] = [];
  let offset = 0;
  for (;;) {
    const page = await clerk.organizations.getOrganizationList({ limit: 100, offset });
    for (const o of page.data) clerkOrgs.push({ id: o.id, name: o.name });
    if (page.data.length < 100) break;
    offset += 100;
  }

  const prismaOrgs = await db.organization.findMany({
    select: {
      id: true,
      name: true,
      clerkOrgId: true,
      members: { select: { role: true, user: { select: { clerkId: true } } } },
    },
  });
  const byClerkId = new Map(prismaOrgs.map((o) => [o.clerkOrgId, o]));

  console.log(`clerk orgs: ${clerkOrgs.length}, prisma orgs: ${prismaOrgs.length}`);
  for (const co of clerkOrgs) {
    const match = byClerkId.get(co.id);
    const memberships = await clerk.organizations.getOrganizationMembershipList({
      organizationId: co.id,
      limit: 100,
    });
    console.log(`\n[clerk] ${co.name} (${co.id}) -> prisma: ${match ? `"${match.name}"` : "NONE"}`);
    for (const m of memberships.data) {
      const clerkUserId = m.publicUserData?.userId;
      const inPrisma = match?.members.some((x) => x.user.clerkId === clerkUserId);
      console.log(
        `   member ${m.publicUserData?.identifier ?? clerkUserId} role=${m.role} -> prisma: ${inPrisma ? "present" : "WOULD CREATE"}`
      );
    }
    if (!match) console.log("   -> WOULD CREATE prisma org + memberships");
  }

  // Reverse direction: prisma members missing from clerk orgs.
  console.log("\n--- reverse: prisma members missing in clerk ---");
  for (const po of prismaOrgs) {
    if (!po.clerkOrgId) {
      console.log(`[prisma] "${po.name}" unlinked -> app invites/switcher-checkout 409 until linked`);
      continue;
    }
    const clerkMembers = await clerk.organizations.getOrganizationMembershipList({
      organizationId: po.clerkOrgId,
      limit: 100,
    });
    const clerkIds = new Set(clerkMembers.data.map((m) => m.publicUserData?.userId));
    for (const pm of po.members) {
      if (!clerkIds.has(pm.user.clerkId)) {
        console.log(
          `   [prisma] "${po.name}": ${pm.user.clerkId} (${pm.role}) -> WOULD ADD to clerk as ${pm.role === "MEMBER" ? "org:member" : "org:admin"}`
        );
      }
    }
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exitCode = 1;
});
