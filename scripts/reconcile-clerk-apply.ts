// One-way reconciliation apply (idempotent, safe to re-run):
//  A. Unlinked Clerk orgs -> create Prisma org + mirror memberships
//     (first org:admin becomes OWNER when no OWNER exists, else org:admin -> ADMIN).
//  B. Prisma members missing in linked Clerk orgs -> add them
//     (OWNER/ADMIN -> org:admin, MEMBER -> org:member).
// Run with: npx tsx scripts/reconcile-clerk-apply.ts
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../lib/generated/prisma/client.js";
import { createClerkClient } from "@clerk/backend";
import { PLANS } from "../lib/constants.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const db = new PrismaClient({ adapter });

async function ensureUser(
  clerk: ReturnType<typeof createClerkClient>,
  clerkUserId: string,
  fallbackOrgId: string
) {
  let user = await db.user.findUnique({
    where: { clerkId: clerkUserId },
    select: { id: true, activeOrganizationId: true },
  });
  if (user) return user;
  const cu = await clerk.users.getUser(clerkUserId);
  const email =
    cu.emailAddresses.find((e) => e.id === cu.primaryEmailAddressId)?.emailAddress ??
    cu.emailAddresses[0]?.emailAddress ?? `${clerkUserId}@unknown.local`;
  user = await db.user.create({
    data: {
      clerkId: clerkUserId,
      name: `${cu.firstName ?? ""} ${cu.lastName ?? ""}`.trim(),
      email,
      imageUrl: cu.imageUrl ?? "",
      activeOrganizationId: fallbackOrgId,
    },
    select: { id: true, activeOrganizationId: true },
  });
  return user;
}

async function main() {
  const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  let createdOrgs = 0;
  let createdMemberships = 0;
  let addedToClerk = 0;

  // ---- A. Clerk -> Prisma ----
  let offset = 0;
  for (;;) {
    const page = await clerk.organizations.getOrganizationList({ limit: 100, offset });
    for (const co of page.data) {
      let org = await db.organization.findUnique({
        where: { clerkOrgId: co.id },
        select: { id: true },
      });
      if (!org) {
        org = await db.organization.create({
          data: {
            name: co.name,
            plan: "free",
            credits: PLANS.free.credits,
            clerkOrgId: co.id,
          },
          select: { id: true },
        });
        createdOrgs++;
        console.log(`created prisma org "${co.name}" -> ${co.id}`);
      }
      const memberships = await clerk.organizations.getOrganizationMembershipList({
        organizationId: co.id,
        limit: 100,
      });
      // Decide OWNER: existing Prisma OWNER wins; else first org:admin.
      const existing = await db.organizationMember.findMany({
        where: { organizationId: org.id },
        select: { userId: true, role: true },
      });
      const hasOwner = existing.some((m) => m.role === "OWNER");
      let ownerAssigned = hasOwner;
      for (const m of memberships.data) {
        const clerkUserId = m.publicUserData?.userId;
        if (!clerkUserId) continue;
        const user = await ensureUser(clerk, clerkUserId, org.id);
        const present = await db.organizationMember.findUnique({
          where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
          select: { id: true },
        });
        if (present) continue;
        let role: "OWNER" | "ADMIN" | "MEMBER" =
          m.role === "org:admin" ? "ADMIN" : "MEMBER";
        if (m.role === "org:admin" && !ownerAssigned) {
          role = "OWNER";
          ownerAssigned = true;
        }
        await db.organizationMember.create({
          data: { organizationId: org.id, userId: user.id, role },
        });
        createdMemberships++;
        console.log(`  + ${m.publicUserData?.identifier ?? clerkUserId} as ${role}`);
        if (!user.activeOrganizationId) {
          await db.user.update({
            where: { id: user.id },
            data: { activeOrganizationId: org.id },
          });
        }
      }
    }
    if (page.data.length < 100) break;
    offset += 100;
  }

  // ---- B. Prisma -> Clerk ----
  const prismaOrgs = await db.organization.findMany({
    where: { clerkOrgId: { not: null } },
    select: {
      id: true,
      name: true,
      clerkOrgId: true,
      members: {
        select: { role: true, user: { select: { clerkId: true } } },
      },
    },
  });
  for (const po of prismaOrgs) {
    const clerkMembers = await clerk.organizations.getOrganizationMembershipList({
      organizationId: po.clerkOrgId!,
      limit: 100,
    });
    const present = new Set(clerkMembers.data.map((m) => m.publicUserData?.userId));
    for (const pm of po.members) {
      if (present.has(pm.user.clerkId)) continue;
      await clerk.organizations.createOrganizationMembership({
        organizationId: po.clerkOrgId!,
        userId: pm.user.clerkId,
        role: pm.role === "MEMBER" ? "org:member" : "org:admin",
      });
      addedToClerk++;
      console.log(`  clerk+ ${po.name}: ${pm.user.clerkId} as ${pm.role}`);
    }
  }

  console.log(`\ndone: orgs=${createdOrgs} memberships=${createdMemberships} addedToClerk=${addedToClerk}`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exitCode = 1;
});
