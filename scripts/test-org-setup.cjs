// No live DB/Clerk writes. Run: node scripts/test-org-setup.cjs
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function load(file, dependencies, globals = {}) {
  const code = ts.transpileModule(readFileSync(resolve(__dirname, "..", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const context = { exports: {}, Error, console: { error() {} }, ...globals, require(name) {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  } };
  vm.runInNewContext(code, context, { filename: file });
  return context.exports;
}

const request = (body) => new Request("https://example.com/api/orgs/fixture", { method: "POST", body: JSON.stringify(body) });
const plain = (value) => JSON.parse(JSON.stringify(value));

function repairRoute({ userId = "user_owner", role = "OWNER", linked = true, member = false, populated = false, unavailable = false, recovered = false, race = false } = {}) {
  const calls = [], updates = [];
  let isMember = member;
  const organizations = {
    async getOrganizationList() {
      calls.push("list-orgs");
      return { data: recovered ? [{ id: "org_target", privateMetadata: { drevoOrganizationId: "db_org" } }] : [] };
    },
    async createOrganization(args) {
      calls.push("create-org");
      assert.equal(args.createdBy, "user_owner");
      assert.equal(args.privateMetadata.drevoOrganizationId, "db_org");
      isMember = true; // createdBy automatically adds the creator as admin.
      return { id: "org_target" };
    },
    async getOrganizationMembershipList(args) {
      assert.equal(args.organizationId, "org_target");
      if (args.userId) {
        calls.push("own-membership");
        assert.deepEqual(plain(args.userId), ["user_owner"]);
        return { data: isMember ? [{ publicUserData: { userId: "user_owner" }, organization: { id: "org_target" } }] : [], totalCount: isMember ? 1 : 0 };
      }
      calls.push("all-memberships");
      return { data: populated ? [{ publicUserData: { userId: "user_other" } }] : [], totalCount: populated ? 1 : 0 };
    },
    async createOrganizationMembership(args) {
      calls.push("add-owner");
      assert.deepEqual(plain(args), { organizationId: "org_target", userId: "user_owner", role: "org:admin" });
      isMember = true;
      if (race) throw new Error("Membership already exists");
    },
  };
  const route = load("app/api/orgs/repair/route.ts", {
    "next/server": { NextResponse: Response }, zod: require("zod"),
    "@clerk/nextjs/server": { auth: async () => ({ userId }) },
    "@/lib/prisma": { db: {
      organizationMember: { async findFirst(args) {
        calls.push("local-owner");
        assert.equal(args.where.user.clerkId, userId);
        assert.equal(args.where.role, "OWNER");
        return role === "OWNER" && args.where.organizationId === "db_org"
          ? { organization: { id: "db_org", name: "Drevo", clerkOrgId: linked ? "org_target" : null } } : null;
      } },
      organization: { async update(args) { updates.push(plain(args)); } },
    } },
    "@/lib/clerk": { async getClerk() {
      if (unavailable) throw new Error("Clerk unavailable");
      return { organizations };
    } },
  });
  return { calls, updates, run: (body = { organizationId: "db_org" }) => route.POST(request(body)) };
}

test("repair requires authentication, a valid target, and verified local OWNER", async () => {
  const signedOut = repairRoute({ userId: null });
  assert.equal((await signedOut.run()).status, 401);
  assert.deepEqual(signedOut.calls, []);
  for (const body of [{}, { organizationId: "" }]) {
    const malformed = repairRoute();
    assert.equal((await malformed.run(body)).status, 400);
    assert.deepEqual(malformed.calls, []);
  }
  for (const role of ["ADMIN", "MEMBER"]) {
    const denied = repairRoute({ role });
    assert.equal((await denied.run()).status, 403);
    assert.deepEqual(denied.calls, ["local-owner"]);
  }
  const wrongTarget = repairRoute();
  assert.equal((await wrongTarget.run({ organizationId: "another_org" })).status, 403);
  assert.deepEqual(wrongTarget.updates, []);
});

test("empty legacy org gains its OWNER in Clerk without touching credits, plan, or active pointer", async () => {
  for (const race of [false, true]) {
    const fixture = repairRoute({ race });
    const response = await fixture.run();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, clerkOrgId: "org_target" });
    assert.equal(fixture.calls.filter((call) => call === "add-owner").length, 1);
    assert.deepEqual(fixture.updates, []);
  }
});

test("repair is a no-op for an existing member and cannot restore access in a populated org", async () => {
  const alreadyMember = repairRoute({ member: true });
  assert.equal((await alreadyMember.run()).status, 200);
  assert.deepEqual(alreadyMember.calls, ["local-owner", "own-membership"]);
  const populated = repairRoute({ populated: true });
  assert.equal((await populated.run()).status, 409);
  assert.equal(populated.calls.includes("add-owner"), false);
  assert.deepEqual(populated.updates, []);
  const unavailable = repairRoute({ unavailable: true });
  assert.equal((await unavailable.run()).status, 503);
  assert.deepEqual(unavailable.updates, []);
});

test("unlinked org creates an admin-owned counterpart or recovers its exact existing counterpart", async () => {
  for (const recovered of [false, true]) {
    const fixture = repairRoute({ linked: false, recovered });
    assert.equal((await fixture.run()).status, 200);
    assert.equal(fixture.calls.includes("create-org"), !recovered);
    assert.deepEqual(fixture.updates, [{ where: { id: "db_org" }, data: { clerkOrgId: "org_target" } }]);
  }
});

function checkoutRoute({ userId = "user_owner", role = "OWNER", sessionOrgId = "org_target", linkedOrgId = "org_target" } = {}) {
  const route = load("app/api/orgs/billing/checkout/route.ts", {
    "next/server": { NextResponse: Response }, zod: require("zod"),
    "@clerk/nextjs/server": { auth: async () => ({ userId, orgId: sessionOrgId }) },
    "@/lib/org": { getActiveOrganization: async () => ({ role, organization: { id: "db_org" } }) },
    "@/lib/prisma": { db: { organization: { async findUnique(args) {
      assert.equal(args.where.id, "db_org");
      return { clerkOrgId: linkedOrgId };
    } } } },
  });
  return (body = { clerkOrgId: "org_target" }) => route.POST(request(body));
}

test("checkout preflight fails closed for unsigned users, non-owners, missing links, and org drift", async () => {
  assert.equal((await checkoutRoute({ userId: null })()).status, 401);
  for (const role of ["ADMIN", "MEMBER"]) assert.equal((await checkoutRoute({ role })()).status, 403);
  for (const options of [{ linkedOrgId: null }, { sessionOrgId: null }, { sessionOrgId: "org_gupta" }]) {
    assert.equal((await checkoutRoute(options)()).status, 409);
  }
  assert.equal((await checkoutRoute()({ clerkOrgId: "org_gupta" })).status, 409);
  assert.equal((await checkoutRoute()({})).status, 409);
  const response = await checkoutRoute()();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, clerkOrgId: "org_target" });
});

test("checkout trigger opens only after successful preflight and re-checks Clerk after awaiting", async () => {
  for (const scenario of ["ok", "denied", "switched", "network"]) {
    const calls = [], errors = [];
    const clerk = { organization: { id: "org_target" } };
    const jsx = (type, props) => ({ type, props });
    const { OrganizationCheckoutButton } = load("components/OrganizationCheckoutButton.tsx", {
      react: { useState: (value) => [value, () => {}], useRef: (value) => ({ current: value === null ? { click: () => calls.push("open-clerk") } : value }) },
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "@clerk/nextjs": { useAuth: () => ({ orgId: "org_target" }), useClerk: () => clerk },
      "@clerk/nextjs/experimental": { CheckoutButton: "ClerkCheckoutButton" },
      "@/components/ui/button": { Button: "Button" },
      sonner: { toast: { error: (message) => errors.push(message) } },
    }, { async fetch(url, options) {
      assert.equal(url, "/api/orgs/billing/checkout");
      assert.deepEqual(JSON.parse(options.body), { clerkOrgId: "org_target" });
      calls.push("preflight");
      if (scenario === "network") throw new Error("Network unavailable");
      if (scenario === "switched") clerk.organization.id = "org_gupta";
      return Response.json({ clerkOrgId: "org_target", message: "Mismatch" }, { status: scenario === "denied" ? 409 : 200 });
    } });
    const tree = OrganizationCheckoutButton({ planId: "pro_plan", children: "Upgrade" });
    await tree.props.children[0].props.onClick();
    assert.deepEqual(calls, scenario === "ok" ? ["preflight", "open-clerk"] : ["preflight"]);
    assert.equal(errors.length, scenario === "ok" ? 0 : 1);
    assert.equal(tree.props.children[1].props.for, "organization");
  }
});

test("personal workspace provisioning also makes its actual Clerk user the creator", async () => {
  const calls = [];
  const { ensurePersonalOrganization } = load("lib/org.ts", {
    "@clerk/nextjs/server": { auth: async () => ({}) }, react: { cache: (fn) => fn },
    "next/navigation": { redirect() { throw new Error("Unexpected redirect"); } },
    "@/lib/constants": { PLANS: { free: { credits: 10 } } },
    "@/lib/validation": { requireId() {} },
    "@/lib/prisma": { db: {
      user: { findUnique: async () => ({ id: "db_user", clerkId: "user_owner", name: "Gupta", memberships: [], activeOrganizationId: null }) },
      $transaction: (fn) => fn({
        $queryRaw: async () => [],
        organizationMember: { findFirst: async () => null, create: async () => {} },
        organization: { create: async () => ({ id: "db_org" }) }, user: { update: async () => {}, updateMany: async () => ({ count: 1 }) },
      }),
      organization: { update: async (args) => calls.push(plain(args)) },
    } },
    "./clerk": { getClerk: async () => ({ organizations: { async createOrganization(args) {
      assert.equal(args.createdBy, "user_owner");
      assert.equal(args.privateMetadata.drevoOrganizationId, "db_org");
      return { id: "org_target" };
    } } }) },
  });
  await ensurePersonalOrganization("db_user");
  assert.deepEqual(calls, [{ where: { id: "db_org" }, data: { clerkOrgId: "org_target" } }]);
});

test("creation activation errors are visible, roll back selection, and never claim success", async () => {
  for (const fails of [false, true]) {
    const calls = [], errors = [], successes = [];
    const states = [true, "", true, "Acme", false];
    const jsx = (type, props) => ({ type, props });
    const clerk = { organization: { id: "org_current" }, async setActive({ organization }) {
      calls.push("activate");
      if (fails) throw new Error("Activation failed");
      clerk.organization = { id: organization };
    } };
    const { OrgSwitcher } = load("components/OrgSwitcher.tsx", {
      react: { useState: () => [states.shift(), () => {}], useRef: (value) => ({ current: value }), useTransition: () => [false, () => {}] },
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "@clerk/nextjs": { useClerk: () => clerk },
      "next/navigation": { usePathname: () => "/projects", useRouter: () => ({ refresh: () => calls.push("refresh") }) },
      "lucide-react": { ChevronsUpDown: "Chevron", Check: "Check", Loader2: "Loader", Plus: "Plus" },
      sonner: { toast: { error: (message) => errors.push(message), success: (message) => successes.push(message) } },
    }, { async fetch(url, options) {
      calls.push(url);
      if (url === "/api/orgs/repair") return Response.json({ message: "Repair failed" }, { status: 503 });
      if (url === "/api/orgs/switch") assert.equal(JSON.parse(options.body).organizationId, "db_current");
      return Response.json({ organizationId: "db_org", clerkOrgId: "org_target" });
    } });
    const tree = OrgSwitcher({ activeOrganizationId: "db_current", orgs: [{ id: "db_current", name: "Current", clerkOrgId: "org_current", role: "OWNER" }] });
    const footer = tree.props.children[1].props.children[1];
    const createButton = footer.props.children.props.children[1].props.children[1];
    await createButton.props.onClick();
    assert.equal(successes.length, fails ? 0 : 1);
    assert.equal(errors.length, fails ? 1 : 0);
    assert.deepEqual(calls, fails
      ? ["/api/orgs/create", "activate", "/api/orgs/repair", "/api/orgs/switch", "refresh"]
      : ["/api/orgs/create", "activate"]);
  }
});
