// Real PostgreSQL semantics in memory; never reads .env or opens a network DB.
/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { resolve } = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

test("additive migration preserves balances/history and enforces grants, leases, revisions and target isolation", async () => {
  const db = new PGlite();
  try {
    const root = resolve(__dirname, "../prisma/migrations");
    const latest = "20261001090000_security_billing_persistence";
    for (const name of readdirSync(root).filter((name) => /^\d/.test(name) && name < latest).sort()) {
      await db.exec(readFileSync(resolve(root, name, "migration.sql"), "utf8"));
    }
    await db.exec(`
      INSERT INTO "User" ("id", "clerkId", "name", "email", "updatedAt") VALUES ('u', 'user_fixture', 'Fixture', 'fixture@example.com', NOW());
      INSERT INTO "Organization" ("id", "name", "plan", "credits", "updatedAt") VALUES ('o', 'Gupta balance fixture', 'pro', 399, NOW());
      INSERT INTO "OrganizationMember" ("id", "organizationId", "userId", "role") VALUES ('m', 'o', 'u', 'OWNER');
      UPDATE "User" SET "activeOrganizationId" = 'o' WHERE "id" = 'u';
      INSERT INTO "Workspace" ("id", "organizationId", "createdById", "fileData", "updatedAt") VALUES ('w', 'o', 'u', '{"files":{"/App.js":{"code":"old code"}}}', NOW());
      INSERT INTO "WorkspaceVersion" ("id", "workspaceId", "fileData", "summary") VALUES ('v', 'w', '{"files":{"/App.js":{"code":"older code"}}}', 'Existing history');
    `);
    await db.exec(readFileSync(resolve(root, latest, "migration.sql"), "utf8"));
    const org = (await db.query(`SELECT "credits", "plan", "billingBaselinePlan" FROM "Organization" WHERE "id" = 'o'`)).rows[0];
    assert.deepEqual(org, { credits: 399, plan: "pro", billingBaselinePlan: "pro" });
    assert.ok((await db.query(`SELECT "trialCreditsGrantedAt" FROM "User" WHERE "id" = 'u'`)).rows[0].trialCreditsGrantedAt);
    assert.equal((await db.query(`SELECT "summary" FROM "WorkspaceVersion" WHERE "id" = 'v'`)).rows[0].summary, "Existing history");
    await db.exec(`INSERT INTO "Organization" ("id", "name", "updatedAt") VALUES ('new', 'Additional org', NOW())`);
    assert.equal((await db.query(`SELECT "credits" FROM "Organization" WHERE "id" = 'new'`)).rows[0].credits, 0);
    assert.equal((await db.query(`SELECT "revision" FROM "Workspace" WHERE "id" = 'w'`)).rows[0].revision, 0);

    const grant = async () => db.transaction(async (tx) => {
      const inserted = await tx.query(`INSERT INTO "OrganizationCreditGrant" ("id", "organizationId", "key", "credits") VALUES ('g', 'o', 'sub:pro:period', 150) ON CONFLICT ("organizationId", "key") DO NOTHING RETURNING "id"`);
      if (inserted.rows.length) await tx.exec(`UPDATE "Organization" SET "credits" = "credits" + 150 WHERE "id" = 'o'`);
    });
    await Promise.all([grant(), grant(), grant()]);
    await db.exec(`UPDATE "Organization" SET "credits" = "credits" - 1 WHERE "id" = 'o' AND "credits" >= 1`);
    assert.equal((await db.query(`SELECT "credits" FROM "Organization" WHERE "id" = 'o'`)).rows[0].credits, 548);
    await db.exec(`UPDATE "Organization" SET "credits" = 1 WHERE "id" = 'new'`);
    const spend = () => db.query(`UPDATE "Organization" SET "credits" = "credits" - 1 WHERE "id" = 'new' AND "credits" >= 1 RETURNING "credits"`);
    const spends = await Promise.all([spend(), spend()]);
    assert.equal(spends.reduce((count, result) => count + result.rows.length, 0), 1);
    assert.equal((await db.query(`SELECT "credits" FROM "Organization" WHERE "id" = 'new'`)).rows[0].credits, 0);
    await assert.rejects(db.transaction(async (tx) => {
      await tx.exec(`UPDATE "Organization" SET "credits" = "credits" - 1 WHERE "id" = 'o'`);
      await tx.exec(`UPDATE "Workspace" SET "revision" = "revision" + 1 WHERE "id" = 'w'`);
      throw new Error("Abort before commit");
    }), /Abort before commit/);
    assert.equal((await db.query(`SELECT "credits" FROM "Organization" WHERE "id" = 'o'`)).rows[0].credits, 548);
    const cas = () => db.query(`UPDATE "Workspace" SET "revision" = "revision" + 1 WHERE "id" = 'w' AND "revision" = 0 RETURNING "id"`);
    assert.equal((await cas()).rows.length, 1);
    assert.equal((await cas()).rows.length, 0);

    const claim = (token) => db.query(`INSERT INTO "AiRunLease" ("key", "token", "expiresAt") VALUES ('user:u', $1, CURRENT_TIMESTAMP + INTERVAL '6 minutes') ON CONFLICT ("key") DO UPDATE SET "token" = EXCLUDED."token", "expiresAt" = EXCLUDED."expiresAt" WHERE "AiRunLease"."expiresAt" <= CURRENT_TIMESTAMP RETURNING "key"`, [token]);
    assert.equal((await claim("first")).rows.length, 1);
    assert.equal((await claim("second")).rows.length, 0);
    await db.exec(`UPDATE "AiRunLease" SET "expiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'`);
    assert.equal((await claim("second")).rows.length, 1);
    await db.exec(`DELETE FROM "AiRunLease" WHERE "token" = 'first'`);
    assert.equal((await db.query(`SELECT "token" FROM "AiRunLease"`)).rows[0].token, "second");

    await db.exec(`INSERT INTO "GithubPushTarget" ("id", "workspaceId", "userId", "repoFullName", "branch", "repoUrl", "pushedFiles") VALUES
      ('t1', 'w', 'u', 'owner/a', 'main', 'https://github.com/owner/a', '["src/A.js"]'),
      ('t2', 'w', 'u', 'owner/b', 'main', 'https://github.com/owner/b', '[]'),
      ('t3', 'w', 'other', 'owner/a', 'main', 'https://github.com/owner/a', '[]'),
      ('t4', 'w', 'u', 'owner/a', 'develop', 'https://github.com/owner/a', '[]')`);
    assert.equal((await db.query(`SELECT count(*)::int AS count FROM "GithubPushTarget"`)).rows[0].count, 4);
    await db.exec(`DELETE FROM "Organization" WHERE "id" = 'o'`);
    assert.equal((await db.query(`SELECT "activeOrganizationId" FROM "User" WHERE "id" = 'u'`)).rows[0].activeOrganizationId, null);
    assert.equal((await db.query(`SELECT count(*)::int AS count FROM "WorkspaceVersion"`)).rows[0].count, 0);
    assert.equal((await db.query(`SELECT count(*)::int AS count FROM "GithubPushTarget"`)).rows[0].count, 0);
    assert.ok((await db.query(`SELECT "trialCreditsGrantedAt" FROM "User" WHERE "id" = 'u'`)).rows[0].trialCreditsGrantedAt);
  } finally { await db.close(); }
});
