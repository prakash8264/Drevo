// Org integrity verification (backs Cases 1, 8-partial, 10 + owner lifecycle).
// Checks: every user has ≥1 membership; every workspace has org + creator;
// every org has ≥1 OWNER; active pointers valid. Read-only.
// Run with: npx tsx scripts/verify-orgs.ts
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../lib/generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const db = new PrismaClient({ adapter });

let failed = false;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
};

async function main() {
  const users = await db.user.findMany({
    select: {
      id: true,
      email: true,
      activeOrganizationId: true,
      memberships: { select: { organizationId: true } },
    },
  });
  check("every user has ≥1 membership", users.every((u) => u.memberships.length > 0),
    `${users.filter((u) => u.memberships.length === 0).length} without org`);

  for (const u of users) {
    if (!u.activeOrganizationId) continue;
    const valid = u.memberships.some((m) => m.organizationId === u.activeOrganizationId);
    if (!valid) {
      check(`active pointer valid (${u.email})`, false, u.activeOrganizationId);
    }
  }
  console.log("PASS  active pointers valid (no mismatches logged above)");

  const orgs = await db.organization.findMany({
    select: {
      id: true,
      name: true,
      members: { select: { role: true } },
      _count: { select: { workspaces: true } },
    },
  });
  const ownerless = orgs.filter((o) => !o.members.some((m) => m.role === "OWNER"));
  check("every org has ≥1 OWNER", ownerless.length === 0,
    ownerless.length ? ownerless.map((o) => o.name).join(", ") : `${orgs.length} orgs ok`);

  const workspaces = await db.workspace.findMany({
    select: { id: true, title: true, organizationId: true, createdById: true },
  });
  check("every workspace has organizationId", workspaces.every((w) => !!w.organizationId));
  check("every workspace has createdById", workspaces.every((w) => !!w.createdById));

  const orgIds = new Set(orgs.map((o) => o.id));
  const userIds = new Set(users.map((u) => u.id));
  check("workspace orgs all exist", workspaces.every((w) => orgIds.has(w.organizationId)));
  check("workspace creators all exist", workspaces.every((w) => userIds.has(w.createdById)));

  // Isolation spot-check: each workspace's creator must be a member of its org.
  const memberships = await db.organizationMember.findMany({
    select: { organizationId: true, userId: true },
  });
  const memberSet = new Set(memberships.map((m) => `${m.organizationId}:${m.userId}`));
  const isolated = workspaces.filter((w) => !memberSet.has(`${w.organizationId}:${w.createdById}`));
  check("workspace creators are members of owning org", isolated.length === 0,
    isolated.length ? isolated.map((w) => w.title ?? w.id).join(", ") : "all consistent");

  console.log(
    `\nsummary: ${users.length} users, ${orgs.length} orgs, ${workspaces.length} workspaces`
  );
  if (failed) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
