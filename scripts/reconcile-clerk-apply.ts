// Explicit apply only: Clerk -> Prisma. Never resurrect revoked Clerk members.
// Run: npx tsx scripts/reconcile-clerk-apply.ts --apply
import "dotenv/config";
import { db } from "../lib/prisma";
import { getClerk } from "../lib/clerk";
import { syncClerkMemberships } from "../lib/membership-sync";

async function main() {
  if (!process.argv.includes("--apply")) throw new Error("Review Clerk state and back up the DB, then pass --apply. This script changes memberships.");
  const clerk = await getClerk();
  for (let offset = 0; ; offset += 100) {
    const page = await clerk.organizations.getOrganizationList({ limit: 100, offset });
    for (const co of page.data) {
      // Only app-linked organizations. Importing arbitrary dashboard orgs or
      // assigning OWNER to the first admin is not a safe automatic repair.
      const org = await db.organization.findUnique({ where: { clerkOrgId: co.id }, select: { id: true } });
      if (!org) { console.log(`Unlinked ${co.id}: skipped; use targeted owner repair.`); continue; }
      const result = await syncClerkMemberships(co.id);
      console.log(co.id, result);
    }
    if (page.data.length < 100) break;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
