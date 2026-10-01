// Tests actual history/actions/save source and SQL with no live DB or providers.
/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { resolve } = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const crypto = require("node:crypto");
const diff = require("diff");
const { PGlite } = require("@electric-sql/pglite");
const plain = (value) => JSON.parse(JSON.stringify(value));
function load(file, dependencies) {
  const code = ts.transpileModule(readFileSync(resolve(__dirname, "..", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = { exports: {}, Buffer, Date, Error, AbortSignal, console: { error() {} },
    require(name) { if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`); return dependencies[name]; } };
  vm.runInNewContext(code, context, { filename: file });
  return context.exports;
}
const validation = load("lib/validation.ts", {});
const codec = load("lib/version-data.ts", { "node:crypto": crypto, diff, zod: require("zod"), "@/lib/validation": validation });
const largeCode = Array.from({ length: 240 }, (_, i) => `const item${i} = "日本語 🌿 line ${i}";`).join("\n") + "\n";
const app = { files: { "/App.js": { code: largeCode } }, dependencies: { react: "19" }, title: "Fixture" };
const edited = (i) => ({ ...app, files: { "/App.js": { code: largeCode.replace("line 100", `revision ${i}`) } } });

test("text deltas reconstruct Unicode/code exactly and ignore JSON object key order", () => {
  const target = edited(1), payload = codec.buildVersionPayload(target, { fileData: app, chainDepth: 0 });
  assert.equal(payload.kind, "delta");
  assert.equal(payload.delta.files["/App.js"].op, "patch");
  assert.equal(payload.fileData, null);
  assert.ok(Buffer.byteLength(JSON.stringify(payload.delta)) < Buffer.byteLength(JSON.stringify(target)) / 4);
  assert.deepEqual(plain(codec.applyVersionDelta(app, payload.delta, payload.contentHash)), target);
  assert.equal(codec.versionHash(app), codec.versionHash({ title: app.title, dependencies: app.dependencies, files: app.files }));
  assert.notEqual(codec.versionHash(app), codec.versionHash(edited(2)));
});

test("deltas preserve additions, deletions, empty files, dependencies, absent titles and extra legacy metadata", () => {
  const before = { ...app, files: { ...app.files, "/old.js": { code: "old" }, "/empty.txt": { code: "" } }, custom: ["legacy", { z: 1, a: 2 }] };
  const after = { files: { ...edited(3).files, "/new.js": { code: "new" }, "/empty.txt": { code: "" } }, dependencies: {}, custom: ["legacy", { a: 2, z: 1 }] };
  const payload = codec.buildVersionPayload(after, { fileData: before, chainDepth: 0 });
  assert.equal(payload.kind, "delta");
  assert.equal(payload.delta.files["/old.js"].op, "delete");
  assert.equal(payload.delta.files["/new.js"].op, "replace");
  assert.deepEqual(plain(codec.applyVersionDelta(before, payload.delta, payload.contentHash)), after);
  assert.deepEqual(before.files["/old.js"], { code: "old" }); // reconstruction never mutates its base
  const metadataChange = { ...after, files: { ...after.files, "/App.js": { ...after.files["/App.js"], hidden: true } } };
  const replacement = codec.buildVersionPayload(metadataChange, { fileData: after, chainDepth: 0 });
  // A full replacement or whole-project checkpoint preserves file metadata.
  assert.deepEqual(plain(replacement.kind === "snapshot" ? replacement.fileData : codec.applyVersionDelta(after, replacement.delta, replacement.contentHash)), metadataChange);
});

test("LF, CRLF, final newline changes, blank files and repeated text round-trip", () => {
  const cases = [largeCode.trimEnd(), largeCode.replace(/\n/g, "\r\n"), largeCode + "\n", "", "one line 🌿", largeCode.replace("line 10", "🌱\r\nextra")];
  for (const code of cases) {
    const before = { files: { "/App.js": { code: largeCode }, "/untouched.txt": { code: largeCode } } };
    const after = { files: { "/App.js": { code }, "/untouched.txt": { code: largeCode } } };
    const payload = codec.buildVersionPayload(after, { fileData: before, chainDepth: 0 });
    assert.deepEqual(plain(payload.kind === "snapshot" ? payload.fileData : codec.applyVersionDelta(before, payload.delta, payload.contentHash)), after);
  }
});

test("small projects, large rewrites, legacy shapes and diff budget exhaustion fall back safely", () => {
  const tiny = { files: { "/App.js": { code: "x" } }, dependencies: {} };
  assert.equal(codec.buildVersionPayload(tiny, { fileData: app, chainDepth: 0 }).kind, "snapshot");
  assert.equal(codec.buildVersionPayload(edited(1), { fileData: app, chainDepth: 4 }).kind, "snapshot");
  assert.equal(codec.buildVersionPayload(app).kind, "snapshot");
  const legacy = { files: { "/App.js": { code: "x", hidden: true } }, oldMetadata: { nested: [1, 2] } };
  assert.deepEqual(plain(codec.buildVersionPayload(legacy).fileData), legacy);
  const budgetCodec = load("lib/version-data.ts", { "node:crypto": crypto, diff: { ...diff, createPatch: () => undefined }, zod: require("zod"), "@/lib/validation": validation });
  const fallback = budgetCodec.buildVersionPayload(edited(1), { fileData: app, chainDepth: 0 });
  assert.deepEqual(plain(fallback.kind === "snapshot" ? fallback.fileData : codec.applyVersionDelta(app, fallback.delta, fallback.contentHash)), edited(1));
});

test("wrong bases, malformed text, missing files, unsafe paths and wrong result hashes fail closed", () => {
  const payload = codec.buildVersionPayload(edited(1), { fileData: app, chainDepth: 0 });
  assert.throws(() => codec.applyVersionDelta(edited(2), payload.delta, payload.contentHash), /base checksum/);
  assert.throws(() => codec.applyVersionDelta(app, payload.delta, "0".repeat(64)), /result checksum/);
  const bad = plain(payload.delta);
  bad.files["/App.js"].patch = bad.files["/App.js"].patch.replace("-const item100", "-const missing100");
  assert.throws(() => codec.applyVersionDelta(app, bad, payload.contentHash), /cannot be applied|checksum/);
  for (const changes of [{ "/missing.js": { op: "patch", patch: "bad" } }, { "/missing.js": { op: "delete" } }, { "/../secret": { op: "replace", value: { code: "x" } } }]) {
    assert.throws(() => codec.applyVersionDelta(app, { ...payload.delta, files: changes }, payload.contentHash));
  }
});

// Minimal Prisma-shaped adapter: actual SQL enforces migration constraints and
// atomic rollback; source functions retain their normal transaction boundaries.
function client(pg) {
  const first = async (sql, args) => (await pg.query(sql, args)).rows[0] ?? null;
  const json = (value) => value === null ? null : JSON.stringify(value);
  const workspaceWhere = (where) => {
    const args = [where.id], terms = ['w."id" = $1'];
    if (where.organizationId?.in) { args.push(where.organizationId.in); terms.push(`w."organizationId" = ANY($${args.length}::text[])`); }
    else if (where.organizationId) { args.push(where.organizationId); terms.push(`w."organizationId" = $${args.length}`); }
    if (where.revision !== undefined) { args.push(where.revision); terms.push(`w."revision" = $${args.length}`); }
    const clerkId = where.organization?.members?.some?.user?.clerkId;
    if (clerkId) {
      args.push(clerkId);
      terms.push(`EXISTS (SELECT 1 FROM "OrganizationMember" m JOIN "User" u ON u."id" = m."userId" WHERE m."organizationId" = w."organizationId" AND u."clerkId" = $${args.length})`);
    }
    return { sql: terms.join(" AND "), args };
  };
  return {
    $queryRaw: (strings, ...args) => pg.query(strings.reduce((sql, part, i) => sql + (i ? `$${i}` : "") + part, ""), args).then((r) => r.rows),
    user: { findUnique: async ({ where }) => {
      const user = await first('SELECT * FROM "User" WHERE "clerkId" = $1', [where.clerkId]);
      return user && { ...user, memberships: (await pg.query('SELECT * FROM "OrganizationMember" WHERE "userId" = $1', [user.id])).rows };
    } },
    organizationMember: { findUnique: ({ where }) => {
      const key = where.organizationId_userId;
      return first('SELECT * FROM "OrganizationMember" WHERE "organizationId" = $1 AND "userId" = $2', [key.organizationId, key.userId]);
    } },
    organization: {
      findUniqueOrThrow: ({ where }) => first('SELECT * FROM "Organization" WHERE "id" = $1', [where.id]),
      updateMany: async ({ where, data }) => ({ count: (await pg.query('UPDATE "Organization" SET "credits" = "credits" - $2 WHERE "id" = $1 AND "credits" >= $3 RETURNING "id"', [where.id, data.credits.decrement, where.credits.gte])).rows.length }),
    },
    workspace: {
      findUnique: ({ where }) => first('SELECT * FROM "Workspace" WHERE "id" = $1', [where.id]),
      findFirst: ({ where }) => { const match = workspaceWhere(where); return first(`SELECT w.* FROM "Workspace" w WHERE ${match.sql}`, match.args); },
      updateMany: async ({ where, data }) => {
        const match = workspaceWhere(where), args = [...match.args, json(data.fileData), data.revision.increment];
        const sets = [`"fileData" = $${args.length - 1}::jsonb`, `"revision" = "revision" + $${args.length}`];
        if (data.messages) { args.push(json(data.messages)); sets.push(`"messages" = $${args.length}::jsonb`); }
        return { count: (await pg.query(`UPDATE "Workspace" w SET ${sets.join(", ")} WHERE ${match.sql} RETURNING "id"`, args)).rows.length };
      },
    },
    workspaceVersion: {
      findUnique: ({ where }) => first('SELECT * FROM "WorkspaceVersion" WHERE "id" = $1 AND "workspaceId" = $2', [where.id, where.workspaceId]),
      findFirst: ({ where }) => first('SELECT * FROM "WorkspaceVersion" WHERE "workspaceId" = $1 ORDER BY "createdAt" DESC, "id" DESC LIMIT 1', [where.workspaceId]),
      findMany: async ({ where, take }) => (await pg.query(`SELECT * FROM "WorkspaceVersion" WHERE "workspaceId" = $1 ORDER BY "createdAt" DESC, "id" DESC${take ? ` LIMIT ${take}` : ""}`, [where.workspaceId])).rows,
      create: async ({ data }) => {
        const record = { id: crypto.randomUUID(), ...data }, keys = Object.keys(record);
        // Keep timestamp parameters explicit, matching Prisma's UTC handling.
        const values = keys.map((key) => ["fileData", "delta"].includes(key) ? json(record[key]) : record[key] instanceof Date ? record[key].toISOString() : record[key]);
        return first(`INSERT INTO "WorkspaceVersion" (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`, values);
      },
      update: ({ where, data }) => {
        const keys = Object.keys(data), values = keys.map((key) => ["fileData", "delta"].includes(key) ? json(data[key]) : data[key]);
        return first(`UPDATE "WorkspaceVersion" SET ${keys.map((key, i) => `"${key}" = $${i + 1}`).join(", ")} WHERE "id" = $${values.length + 1} AND "workspaceId" = $${values.length + 2} RETURNING *`, [...values, where.id, where.workspaceId]);
      },
      deleteMany: async ({ where }) => ({ count: (await pg.query('DELETE FROM "WorkspaceVersion" WHERE "workspaceId" = $1 AND "id" = ANY($2::text[]) RETURNING "id"', [where.workspaceId, where.id.in])).rows.length }),
    },
  };
}

test("migration, bounded history, pruning, restores and AI saves use actual PostgreSQL transactions", async (t) => {
  const pg = new PGlite();
  try {
    await pg.exec("SET TIME ZONE 'UTC'");
    const root = resolve(__dirname, "../prisma/migrations"), latest = "20261001130000_text_patch_version_history";
    for (const name of readdirSync(root).filter((name) => /^\d/.test(name) && name < latest).sort()) await pg.exec(readFileSync(resolve(root, name, "migration.sql"), "utf8"));
    await pg.exec(`
      INSERT INTO "User" ("id", "clerkId", "name", "email", "updatedAt") VALUES ('u', 'user_fixture', 'Fixture', 'fixture@example.com', NOW());
      INSERT INTO "Organization" ("id", "name", "credits", "updatedAt") VALUES ('o', 'Fixture', 399, NOW()), ('other', 'Other org', 7, NOW());
      INSERT INTO "OrganizationMember" ("id", "organizationId", "userId", "role") VALUES ('m', 'o', 'u', 'MEMBER');
      INSERT INTO "Workspace" ("id", "organizationId", "createdById", "updatedAt") VALUES ('w', 'o', 'u', NOW()), ('other-w', 'other', 'u', NOW());
    `);
    const legacy = { files: { "/App.js": { code: largeCode, hidden: false } }, custom: "preserve" };
    await pg.query('INSERT INTO "WorkspaceVersion" ("id", "workspaceId", "fileData", "summary") VALUES (\'legacy\', \'w\', $1::jsonb, \'Existing history\')', [JSON.stringify(legacy)]);
    await pg.query('UPDATE "Workspace" SET "fileData" = $1::jsonb WHERE "id" = \'w\'', [JSON.stringify(app)]);
    await pg.exec(readFileSync(resolve(root, latest, "migration.sql"), "utf8"));
    const db = { ...client(pg), $transaction: (fn) => pg.transaction((sql) => fn(client(sql))) };
    const history = load("lib/versions.ts", { "@/lib/prisma": { db }, "@/lib/generated/prisma/client": { Prisma: { DbNull: null } }, "@/lib/validation": validation, "@/lib/version-data": codec });
    const actions = load("actions/versions.ts", { "@clerk/nextjs/server": { auth: async () => ({ userId: "user_fixture" }) }, "next/navigation": { redirect() { throw new Error("Unauthorized"); } }, "@/lib/prisma": { db }, "@/lib/validation": validation, "@/lib/versions": history });
    const saver = load("lib/workspace-save.ts", { "@/lib/prisma": { db }, "@/lib/constants": { CREDIT_COST_PER_GENERATION: 1 }, "@/lib/versions": history, "@/lib/ai-request": { validateApp: (data) => data } });
    const read = (id, workspaceId = "w") => db.$transaction(async (tx) => { await history.lockWorkspaceHistory(tx, workspaceId); return history.readVersionFileData(tx, workspaceId, id); });

    await t.test("additive migration preserves legacy JSON, IDs, counts, balances and hashless restore", async () => {
      const row = await db.workspaceVersion.findUnique({ where: { id: "legacy", workspaceId: "w" } });
      assert.equal(row.kind, "snapshot"); assert.equal(row.chainDepth, 0); assert.equal(row.contentHash, null); assert.equal(row.fileCount, 1);
      assert.deepEqual(row.fileData, legacy);
      assert.deepEqual(plain(await read("legacy")), legacy);
      assert.equal((await db.organization.findUniqueOrThrow({ where: { id: "o" } })).credits, 399);
      assert.deepEqual((await actions.getVersions("w")).map((v) => v.fileCount), [1]);
      const restored = await actions.restoreVersion("w", "legacy", 0);
      assert.deepEqual(plain(restored.fileData), legacy);
      const undo = await db.workspaceVersion.findFirst({ where: { workspaceId: "w" } });
      assert.notEqual(undo.id, "legacy");
      assert.deepEqual(plain((await actions.restoreVersion("w", undo.id, restored.revision)).fileData), app);
      await assert.rejects(actions.restoreVersion("other-w", "legacy", 0), /Unauthorized/);
      await assert.rejects(read("legacy", "other-w"), /missing/);
    });

    const expected = new Map();
    await t.test("five-record checkpoint cadence and repeated prune preserve exact retained content", async () => {
      await pg.exec('DELETE FROM "WorkspaceVersion" WHERE "workspaceId" = \'w\'');
      for (let i = 0; i < 33; i++) {
        const target = edited(i);
        const row = await db.$transaction((tx) => history.createWorkspaceVersion(tx, "w", target, `Before ${i}`));
        expected.set(row.id, target);
        if (i < 20) assert.equal(row.chainDepth, i % 5);
        await history.pruneVersions("w");
        const rows = await db.workspaceVersion.findMany({ where: { workspaceId: "w" } });
        assert.equal(rows.length, Math.min(i + 1, 20));
        assert.equal(rows.at(-1).kind, "snapshot");
        for (const retained of rows) assert.deepEqual(plain(await read(retained.id)), expected.get(retained.id));
      }
      assert.equal((await actions.getVersions("w")).length, 20);
    });

    await t.test("FK rejects cross-workspace chains and deleting a required base", async () => {
      const rows = await db.workspaceVersion.findMany({ where: { workspaceId: "w" } });
      const delta = rows.find((v) => v.kind === "delta");
      await assert.rejects(pg.query('DELETE FROM "WorkspaceVersion" WHERE "id" = $1', [delta.baseVersionId]), /foreign key/);
      await assert.rejects(pg.query('INSERT INTO "WorkspaceVersion" ("id", "workspaceId", "kind", "delta", "contentHash", "chainDepth", "baseVersionId") VALUES (\'cross\', \'other-w\', \'delta\', $1::jsonb, $2, 1, $3)', [JSON.stringify(delta.delta), delta.contentHash, delta.baseVersionId]), /foreign key/);
      await assert.rejects(pg.exec('INSERT INTO "WorkspaceVersion" ("id", "workspaceId", "kind") VALUES (\'invalid\', \'w\', \'delta\')'), /check constraint/);
    });

    await t.test("restores are free, undoable, revision-checked and cannot cross projects", async () => {
      const rows = await db.workspaceVersion.findMany({ where: { workspaceId: "w" } }), selected = rows.find((v) => v.kind === "delta");
      const current = await db.workspace.findUnique({ where: { id: "w" } });
      const restored = await actions.restoreVersion("w", selected.id, current.revision);
      assert.deepEqual(plain(restored.fileData), expected.get(selected.id));
      assert.equal(restored.revision, current.revision + 1);
      const undo = await db.workspaceVersion.findFirst({ where: { workspaceId: "w" } });
      assert.equal(undo.summary, "Before restore");
      assert.deepEqual(plain(await read(undo.id)), app);
      const undone = await actions.restoreVersion("w", undo.id, restored.revision);
      assert.deepEqual(plain(undone.fileData), app);
      await assert.rejects(actions.restoreVersion("w", undo.id, restored.revision), /Workspace changed/);
      assert.equal((await db.organization.findUniqueOrThrow({ where: { id: "o" } })).credits, 399);
      await assert.rejects(actions.restoreVersion("w", "not-a-version", undone.revision), /Unauthorized/);
    });

    await t.test("checksum damage prevents restore and rolls back files, revision and history", async () => {
      const selected = (await db.workspaceVersion.findMany({ where: { workspaceId: "w" } })).find((v) => v.kind === "delta");
      await pg.query('UPDATE "WorkspaceVersion" SET "contentHash" = $2 WHERE "id" = $1', [selected.id, "0".repeat(64)]);
      const before = await db.workspace.findUnique({ where: { id: "w" } });
      await assert.rejects(actions.restoreVersion("w", selected.id, before.revision), /checksum/);
      assert.deepEqual(await db.workspace.findUnique({ where: { id: "w" } }), before);
      assert.equal((await db.workspaceVersion.findMany({ where: { workspaceId: "w" } })).length, 20);
      await pg.query('UPDATE "WorkspaceVersion" SET "contentHash" = $2 WHERE "id" = $1', [selected.id, selected.contentHash]);
    });

    await t.test("concurrent stale AI saves commit once and snapshot DB truth with one credit", async () => {
      const before = await db.workspace.findUnique({ where: { id: "w" } });
      const args = { workspaceId: "w", revision: before.revision, orgId: "o", userId: "u", fileData: edited(99), messages: [{ role: "user", content: "edit" }], summary: "AI edit", signal: new AbortController().signal };
      const outcomes = await Promise.allSettled([saver.saveAiWorkspace(args), saver.saveAiWorkspace(args)]);
      assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
      const latest = await db.workspaceVersion.findFirst({ where: { workspaceId: "w" } });
      assert.deepEqual(plain(await read(latest.id)), before.fileData);
      assert.equal((await db.workspace.findUnique({ where: { id: "w" } })).revision, before.revision + 1);
      assert.equal((await db.organization.findUniqueOrThrow({ where: { id: "o" } })).credits, 398);
      await pg.exec('UPDATE "Organization" SET "credits" = 0 WHERE "id" = \'o\'');
      const saved = await db.workspace.findUnique({ where: { id: "w" } });
      const historyBefore = await db.workspaceVersion.findMany({ where: { workspaceId: "w" } });
      await assert.rejects(saver.saveAiWorkspace({ ...args, revision: saved.revision }), /Insufficient credits/);
      assert.deepEqual(await db.workspace.findUnique({ where: { id: "w" } }), saved);
      assert.deepEqual(await db.workspaceVersion.findMany({ where: { workspaceId: "w" } }), historyBefore);
    });

    await t.test("missing/cyclic/unsupported chains fail and failed pruning deletes nothing", async () => {
      const rows = await db.workspaceVersion.findMany({ where: { workspaceId: "w" } });
      const latest = rows[0];
      const brokenTx = { workspaceVersion: { findUnique: async () => null } };
      await assert.rejects(history.readVersionFileData(brokenTx, "w", "missing"), /missing/);
      await assert.rejects(history.readVersionFileData({ workspaceVersion: { findUnique: async () => ({ ...latest, kind: "delta", baseVersionId: latest.id, chainDepth: 1 }) } }, "w", latest.id), /chain/);
      await assert.rejects(history.readVersionFileData({ workspaceVersion: { findUnique: async () => ({ ...latest, formatVersion: 99 }) } }, "w", latest.id), /Unsupported/);
      let overflow;
      for (let i = 0; i < 5; i++) {
        await db.$transaction((tx) => history.createWorkspaceVersion(tx, "w", edited(110 + i), "Overflow"));
        overflow = await db.workspaceVersion.findMany({ where: { workspaceId: "w" } });
        if (overflow[19].kind === "delta") break;
      }
      const boundary = overflow[19];
      assert.equal(boundary.kind, "delta");
      await pg.query('UPDATE "WorkspaceVersion" SET "contentHash" = $2 WHERE "id" = $1', [boundary.id, "0".repeat(64)]);
      await assert.rejects(history.pruneVersions("w"), /checksum/);
      await history.pruneVersionsBestEffort("w");
      assert.equal((await db.workspaceVersion.findMany({ where: { workspaceId: "w" } })).length, overflow.length);
      await pg.query('UPDATE "WorkspaceVersion" SET "contentHash" = $2 WHERE "id" = $1', [boundary.id, boundary.contentHash]);
      await history.pruneVersions("w");
    });

    await t.test("project and organization deletion cascade through complete patch chains", async () => {
      await db.$transaction((tx) => history.createWorkspaceVersion(tx, "other-w", app, "Other checkpoint"));
      await db.$transaction((tx) => history.createWorkspaceVersion(tx, "other-w", edited(1), "Other delta"));
      assert.equal((await db.workspaceVersion.findMany({ where: { workspaceId: "other-w" } })).length, 2);
      await history.pruneVersions("w");
      assert.equal((await db.workspaceVersion.findMany({ where: { workspaceId: "other-w" } })).length, 2);
      await pg.exec('DELETE FROM "Workspace" WHERE "id" = \'other-w\'');
      assert.equal((await db.workspaceVersion.findMany({ where: { workspaceId: "other-w" } })).length, 0);
      await pg.exec('DELETE FROM "Organization" WHERE "id" = \'o\'');
      assert.equal((await pg.query('SELECT * FROM "WorkspaceVersion"')).rows.length, 0);
    });
  } finally { await pg.close(); }
});
