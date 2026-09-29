// Post-contract verification: all users have orgs.
// (Expand-phase backfill is complete; legacy userId/credits/plan columns are
// dropped.) Run with: npx tsx scripts/backfill-orgs.ts
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../lib/generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const db = new PrismaClient({ adapter });

async function main() {
  const users = await db.user.count();
  const usersWithoutOrg = await db.user.count({
    where: { memberships: { none: {} } },
  });
  const workspaces = await db.workspace.count();
  const orgs = await db.organization.count();
  console.log(
    `users: ${users}, without org: ${usersWithoutOrg}, workspaces: ${workspaces}, orgs: ${orgs}`
  );
  if (usersWithoutOrg > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
