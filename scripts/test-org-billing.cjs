// No network/DB: subscription payload extraction, plan mirroring, and the
// manual billing-sync endpoint (fallback for missed/lagging webhooks).
// Run: node scripts/test-org-billing.cjs
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { Webhook } = require("svix");

function load(file, dependencies, globals = {}) {
  const code = ts.transpileModule(readFileSync(resolve(__dirname, "..", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const context = {
    exports: {}, Error, URLSearchParams,
    console: { error() {}, warn() {}, log() {} },
    ...globals,
    require(name) {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  };
  vm.runInNewContext(code, context, { filename: file });
  return context.exports;
}

// Objects built inside the VM share structure but not prototypes with this
// realm, so normalize cross-realm values before deep comparison.
const plain = (value) => JSON.parse(JSON.stringify(value));
const clerkLib = load("lib/clerk.ts", {
  "@clerk/nextjs/server": { clerkClient() { throw new Error("Unexpected Clerk network call"); } },
  "./constants": { PLANS: { free: { credits: 10 }, starter: { credits: 50 }, pro: { credits: 150 } } },
  "@/types/plans": {},
});

const clerkBilling = (slug) => async () => ({
  billing: {
    getOrganizationBillingSubscription: async (organizationId) => {
      assert.equal(organizationId, "org_x");
      return { id: "sub_fixture", subscriptionItems: [{ status: "active", plan: { slug }, periodStart: Date.now() - 1000, periodEnd: Date.now() + 86400000, planPeriod: "month", isFreeTrial: false }] };
    },
  },
});
const throwingBilling = async () => ({
  billing: {
    getOrganizationBillingSubscription: async () => { throw new Error("no subscription"); },
  },
});

function makeDb({ linked = true, org = { id: "db_org", plan: "free", credits: 10 }, mirrorMissing = false } = {}) {
  const updates = [];
  org = { ...org, billingBaselineAt: new Date(), billingBaselinePlan: org.plan };
  const grants = new Set();
  const db = {
    $queryRaw: async () => mirrorMissing ? [] : [{ id: org.id }],
    organization: {
      findUnique: async (args) => {
        const sel = Object.keys(args.select || {});
        if (sel.length === 1 && sel[0] === "clerkOrgId") return linked ? { clerkOrgId: "org_x" } : null;
        return mirrorMissing ? null : org;
      },
      findUniqueOrThrow: async () => org,
      update: async (args) => { updates.push(args); org.plan = args.data.plan; org.credits += args.data.credits?.increment ?? 0; return org; },
    },
    organizationCreditGrant: { createMany: async ({ data }) => {
      if (grants.has(data[0].key)) return { count: 0 };
      grants.add(data[0].key); return { count: 1 };
    } },
    organizationMember: { findUnique: async () => null },
    user: { findUnique: async () => null },
  };
  db.$transaction = (fn) => fn(db);
  return { db, updates, grants };
}

function billingModule(db, getClerk) {
  return load("lib/billing.ts", {
    "@/lib/prisma": { db },
    "@/lib/clerk": { getClerk, toDrevoPlan: clerkLib.toDrevoPlan },
    "@/lib/constants": { PLANS: { free: { credits: 10 }, starter: { credits: 50 }, pro: { credits: 150 } } },
  });
}

const { subscriptionOrgId } = billingModule(makeDb().db, throwingBilling);

test("subscription org id resolves across payload shapes, payer first", () => {
  assert.equal(subscriptionOrgId({ payer: { organization_id: "org_a" }, organization_id: "org_b", organization: { id: "org_c" } }), "org_a");
  assert.equal(subscriptionOrgId({ organization_id: "org_b", organization: { id: "org_c" } }), "org_b");
  assert.equal(subscriptionOrgId({ organization: { id: "org_c" } }), "org_c");
  assert.equal(subscriptionOrgId({}), null);
  assert.equal(subscriptionOrgId(null), null);
  assert.equal(subscriptionOrgId(undefined), null);
});

test("first paid period adds its full allowance while preserving trial credits", async () => {
  const { db, updates } = makeDb();
  const { syncOrgPlan } = billingModule(db, clerkBilling("proorg"));
  assert.deepEqual(plain(await syncOrgPlan("org_x")), { plan: "pro", credits: 160, updated: true });
  assert.equal(updates.length, 1);
  assert.deepEqual(plain(updates[0].data), { plan: "pro", credits: { increment: 150 } });
});

test("plan sync is a no-op when the plan already matches", async () => {
  const { db, updates } = makeDb({ org: { id: "db_org", plan: "pro", credits: 150 } });
  const { syncOrgPlan } = billingModule(db, clerkBilling("proorg"));
  assert.deepEqual(plain(await syncOrgPlan("org_x")), { plan: "pro", credits: 150, updated: false });
  assert.equal(updates.length, 0);
});

test("plan sync returns null for unlinked orgs without writing", async () => {
  const { db, updates } = makeDb({ mirrorMissing: true });
  const { syncOrgPlan } = billingModule(db, clerkBilling("proorg"));
  assert.equal(await syncOrgPlan("org_x"), null);
  assert.equal(updates.length, 0);
});

test("provider failure preserves the plan/balance and asks for a retry", async () => {
  const { db, updates } = makeDb();
  const { syncOrgPlan } = billingModule(db, throwingBilling);
  await assert.rejects(syncOrgPlan("org_x"), /no subscription/);
  assert.equal(updates.length, 0);
});

function syncRoute({ linked = true, mirrorMissing = false } = {}) {
  const { db, updates } = makeDb({ linked, mirrorMissing });
  const billing = billingModule(db, clerkBilling("proorg"));
  const route = load("app/api/orgs/billing/sync/route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/prisma": { db },
    "@/lib/org": { getActiveOrganization: async () => ({ organization: { id: "db_org" } }) },
    "@/lib/billing": billing,
  });
  return { updates, run: () => route.POST() };
}

test("manual sync rejects unlinked orgs and applies the Clerk plan otherwise", async () => {
  const unlinked = syncRoute({ linked: false });
  assert.equal((await unlinked.run()).status, 409);
  assert.equal(unlinked.updates.length, 0);

  const missing = syncRoute({ mirrorMissing: true });
  assert.equal((await missing.run()).status, 404);

  const ok = syncRoute();
  const res = await ok.run();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, plan: "pro", credits: 160, updated: true });
});

test("webhook subscription.created with organization_id shape (no payer) still syncs", async () => {
  const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
  const { db, updates } = makeDb();
  const billing = billingModule(db, clerkBilling("proorg"));
  const route = load("app/api/webhooks/clerk/route.ts", {
    "next/server": { NextResponse: Response },
    svix: { Webhook },
    "@/lib/prisma": { db },
    "@/lib/clerk": { getClerk: clerkBilling("proorg"), toPrismaRole: () => "MEMBER" },
    "@/lib/billing": billing,
    "@/lib/membership-sync": {},
  }, { process: { env: { CLERK_WEBHOOK_SECRET: secret } } });

  const body = JSON.stringify({ type: "subscription.created", data: { organization_id: "org_x" } });
  const timestamp = new Date();
  const headers = {
    "svix-id": "msg_fixture", "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": new Webhook(secret).sign("msg_fixture", timestamp, body),
  };
  const res = await route.POST(new Request("https://example.com/api/webhooks/clerk", { method: "POST", headers, body }));
  assert.equal(res.status, 200);
  assert.equal(updates.length, 1);
  assert.deepEqual(plain(updates[0].data), { plan: "pro", credits: { increment: 150 } });
});

test("webhook subscription event without any org id is a logged skip, not a failure", async () => {
  const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
  const { db, updates } = makeDb();
  const billing = billingModule(db, clerkBilling("proorg"));
  const route = load("app/api/webhooks/clerk/route.ts", {
    "next/server": { NextResponse: Response },
    svix: { Webhook },
    "@/lib/prisma": { db },
    "@/lib/clerk": { getClerk: clerkBilling("proorg"), toPrismaRole: () => "MEMBER" },
    "@/lib/billing": billing,
    "@/lib/membership-sync": {},
  }, { process: { env: { CLERK_WEBHOOK_SECRET: secret } } });

  const body = JSON.stringify({ type: "subscription.updated", data: {} });
  const timestamp = new Date();
  const headers = {
    "svix-id": "msg_fixture", "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": new Webhook(secret).sign("msg_fixture", timestamp, body),
  };
  const res = await route.POST(new Request("https://example.com/api/webhooks/clerk", { method: "POST", headers, body }));
  assert.equal(res.status, 200);
  assert.equal(updates.length, 0);
});

test("organization.created links the exact metadata row, not another unlinked org of the creator", async () => {
  const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
  const updates = [];
  const route = load("app/api/webhooks/clerk/route.ts", {
    "next/server": { NextResponse: Response }, svix: { Webhook },
    "@/lib/prisma": { db: {
      organization: { async updateMany(args) { updates.push(plain(args)); } },
      user: { findUnique() { throw new Error("Must not guess another org from the creator's memberships"); } },
    } },
    "@/lib/clerk": {}, "@/lib/billing": {}, "@/lib/membership-sync": {},
  }, { process: { env: { CLERK_WEBHOOK_SECRET: secret } } });
  const body = JSON.stringify({ type: "organization.created", data: {
    id: "org_new", created_by: "user_owner", private_metadata: { drevoOrganizationId: "db_new" },
  } });
  const timestamp = new Date();
  const headers = {
    "svix-id": "msg_fixture", "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": new Webhook(secret).sign("msg_fixture", timestamp, body),
  };
  const response = await route.POST(new Request("https://example.com/api/webhooks/clerk", { method: "POST", headers, body }));
  assert.equal(response.status, 200);
  assert.deepEqual(updates, [{ where: { id: "db_new", clerkOrgId: null }, data: { clerkOrgId: "org_new" } }]);
});
