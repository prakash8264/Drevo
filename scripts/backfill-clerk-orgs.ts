// B-variant backfill: create one Clerk Organization per Prisma Organization
// missing clerkOrgId, then store the link. Idempotent — safe to run twice.
// Requires Organizations enabled in the Clerk Dashboard + CLERK_SECRET_KEY.
// Run with: npx tsx scripts/backfill-clerk-orgs.ts
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../lib/generated/prisma/client.js";
import { createClerkClient } from "@clerk/backend";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const db = new PrismaClient({ adapter });

async function main() {
  if (!process.env.CLERK_SECRET_KEY) {
    console.error("CLERK_SECRET_KEY is missing.");
    process.exitCode = 1;
    return;
  }
  const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

  const orgs = await db.organization.findMany({
    where: { clerkOrgId: null },
    select: { id: true, name: true, slug: true },
  });
  console.log(`orgs without clerk link: ${orgs.length}`);
  let linked = 0;
  for (const o of orgs) {
    // No slug: the "Enable organization slugs" dashboard toggle is off.
    const created = await clerk.organizations.createOrganization({
      name: o.name,
    });
    await db.organization.update({
      where: { id: o.id },
      data: { clerkOrgId: created.id },
    });
    console.log(`linked ${o.name} -> ${created.id}`);
    linked++;
  }
  console.log(`linked: ${linked}`);
  const remaining = await db.organization.count({ where: { clerkOrgId: null } });
  console.log(`remaining unlinked: ${remaining}`);
  if (remaining > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e?.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
