// No network/DB access: verifies request cost, authorization and switch failure handling.
// Run: node scripts/test-org-switch.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function load(file, dependencies, globals = {}) {
  const code = ts.transpileModule(readFileSync(resolve(__dirname, "..", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const context = { exports: {}, Error, console, ...globals, require(name) {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  } };
  vm.runInNewContext(code, context, { filename: file });
  return context.exports;
}

test("existing user header takes one DB read and zero Clerk Backend calls", async () => {
  let reads = 0;
  const user = { id: "db_user", activeOrganizationId: "org_db", memberships: [{ organization: { id: "org_db" } }] };
  const { checkUser } = load("lib/checkUser.ts", {
    react: { cache: (fn) => fn },
    "@clerk/nextjs/server": { auth: async () => ({ userId: "user_fixture" }), currentUser() { throw new Error("Unexpected Clerk network call"); } },
    "./prisma": { db: { user: { async findUnique() { reads++; return user; } } } },
    "./org": { ensurePersonalOrganization() { throw new Error("Unexpected provisioning"); } },
  });
  assert.equal(await checkUser(), user);
  assert.equal(reads, 1);
});

test("stale active pointer is repaired instead of taking the fast path", async () => {
  let reads = 0, repairs = 0;
  const { checkUser } = load("lib/checkUser.ts", {
    react: { cache: (fn) => fn },
    "@clerk/nextjs/server": { auth: async () => ({ userId: "user_fixture" }) },
    "./prisma": { db: { user: { async findUnique() {
      reads++; return { id: "db_user", activeOrganizationId: reads === 1 ? "stale" : "org_db", memberships: [{ organization: { id: "org_db" } }] };
    } } } },
    "./org": { async ensurePersonalOrganization(id) { assert.equal(id, "db_user"); repairs++; } },
  });
  assert.equal((await checkUser()).activeOrganizationId, "org_db");
  assert.equal(repairs, 1);
});

test("switch endpoint uses two DB calls and rejects non-members without writing", async () => {
  for (const allowed of [true, false]) {
    let reads = 0, writes = 0;
    const { POST } = load("app/api/orgs/switch/route.ts", {
      "next/server": { NextResponse: Response }, zod: require("zod"),
      "@clerk/nextjs/server": { auth: async () => ({ userId: "user_fixture" }) },
      "@/lib/prisma": { db: {
        organizationMember: { async findFirst(args) {
          reads++;
          assert.equal(args.where.user.clerkId, "user_fixture");
          assert.equal(args.where.organizationId, "db_target");
          return allowed ? { userId: "db_user", organization: { clerkOrgId: "org_target" } } : null;
        } },
        user: { async update(args) {
          writes++;
          assert.equal(args.where.id, "db_user");
          assert.equal(args.data.activeOrganizationId, "db_target");
        } },
      } },
    });
    const response = await POST(new Request("https://example.com/api/orgs/switch", {
      method: "POST", body: JSON.stringify({ organizationId: "db_target" }),
    }));
    assert.equal(response.status, allowed ? 200 : 404);
    assert.equal(reads, 1);
    assert.equal(writes, allowed ? 1 : 0);
  }
});

async function switchClient({ current = false, activationFails = false, denied = false, pathname = "/projects" } = {}) {
  const calls = [], tasks = [], errors = [];
  let stateIndex = 0;
  const jsx = (type, props) => ({ type, props });
  const { OrgSwitcher } = load("components/OrgSwitcher.tsx", {
    react: {
      useRef: (current) => ({ current }),
      useState: (initial) => [stateIndex++ === 0 ? true : initial, () => {}],
      useTransition: () => [false, (fn) => tasks.push(fn())],
    },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "next/navigation": { usePathname: () => pathname, useRouter: () => ({ refresh: () => calls.push("refresh"), push: (url) => calls.push(url) }) },
    "@clerk/nextjs": { useClerk: () => ({ async setActive({ organization }) {
      calls.push(organization);
      if (activationFails) throw new Error("Activation failed");
      // @clerk/nextjs's onAfterSetActive hook refreshes the route itself.
      calls.push("clerk-refresh");
    } }) },
    "lucide-react": { ChevronsUpDown: "Chevron", Check: "Check", Loader2: "Loader", Plus: "Plus" },
    sonner: { toast: { error: (message) => errors.push(message) } },
  }, { async fetch(_url, options) {
    calls.push(JSON.parse(options.body).organizationId);
    return Response.json({ clerkOrgId: "org_target", message: "Forbidden" }, { status: denied ? 403 : 200 });
  } });
  const tree = OrgSwitcher({ activeOrganizationId: "db_current", orgs: [
    { id: "db_current", name: "Current", clerkOrgId: "org_current" },
    { id: "db_target", name: "Target", clerkOrgId: "org_target" },
  ] });
  const dropdown = tree.props.children[1].props.children;
  // Dropdown holds the org list plus the New-organization footer: flatten and
  // keep only the org buttons (the footer container has no onClick itself).
  const flat = (Array.isArray(dropdown) ? dropdown.flat(Infinity) : [dropdown]);
  const orgButtons = flat.filter((node) => node?.props && typeof node.props.onClick === "function");
  orgButtons[current ? 0 : 1].props.onClick();
  await Promise.all(tasks);
  return { calls, errors };
}

test("same-org selection makes no requests; successful switch activates before refresh", async () => {
  assert.deepEqual((await switchClient({ current: true })).calls, []);
  assert.deepEqual((await switchClient()).calls, ["db_target", "org_target", "clerk-refresh"]);
  assert.deepEqual((await switchClient({ pathname: "/workspace" })).calls, ["db_target", "org_target", "clerk-refresh", "/projects"]);
});

test("failed activation rolls back the app pointer, and forbidden switch never activates Clerk", async () => {
  const failed = await switchClient({ activationFails: true });
  assert.deepEqual(failed.calls, ["db_target", "org_target", "db_current"]);
  assert.ok(failed.errors.includes("Activation failed"));
  const denied = await switchClient({ denied: true });
  assert.deepEqual(denied.calls, ["db_target"]);
  assert.ok(denied.errors.includes("Forbidden"));
});

test("header controls have distinct sibling keys across organization switches", async () => {
  let activeOrganizationId = "org_first";
  const jsx = (type, props, key) => ({ type, props, key });
  const { default: Header } = load("components/Header.tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "next/link": { default: "Link" },
    "@clerk/nextjs": { UserButton: "UserButton", SignInButton: "SignInButton", Show: "Show" },
    "lucide-react": { ArrowRight: "ArrowRight" },
    "@/components/ui/button": { Button: "Button" },
    "@/components/LogoMark": { LogoMark: "LogoMark" },
    "@/components/HeaderCredits": { HeaderCredits: "HeaderCredits" },
    "@/components/OrgSwitcher": { OrgSwitcher: "OrgSwitcher" },
    "@/components/MembersDialog": { MembersDialog: "MembersDialog" },
    "@/components/ThemeToggle": { ThemeToggle: "ThemeToggle" },
    "@/lib/checkUser": { checkUser: async () => ({
      activeOrganizationId,
      memberships: [{ role: "OWNER", organization: { id: activeOrganizationId, name: "Fixture", credits: 10 } }],
    }) },
  });
  for (const id of ["org_first", "org_second", "org_first"]) {
    activeOrganizationId = id;
    const tree = await Header();
    const controls = tree.props.children.props.children[1].props.children[1].props.children;
    const keys = controls.filter((child) => child?.key != null).map((child) => child.key);
    assert.equal(new Set(keys).size, keys.length, "Sibling keys must be unique");
    assert.equal(controls.filter((child) => child.type === "MembersDialog").length, 1);
  }
});

function createRoute({ userId = "user_fixture", clerkFails = false } = {}) {
  const writes = [], updates = [];
  let createdName = null;
  const route = load("app/api/orgs/create/route.ts", {
    "next/server": { NextResponse: Response }, zod: require("zod"),
    "@clerk/nextjs/server": { auth: async () => ({ userId }) },
    "@/lib/prisma": { db: {
      user: { findUnique: async () => userId ? { id: "db_user" } : null },
      organization: { async update(args) { updates.push(args); } },
      $transaction: (fn) => fn({
        organization: { async create(args) { createdName = args.data.name; writes.push(["org", args.data]); return { id: "db_org" }; } },
        organizationMember: { async create(args) { writes.push(["member", args.data]); } },
        user: { async update(args) { writes.push(["active", args.data]); } },
      }),
    } },
    "@/lib/constants": { PLANS: { free: { credits: 10 } } },
    "@/lib/clerk": { getClerk: async () => ({ organizations: { async createOrganization({ name }) {
      if (clerkFails) throw new Error("Clerk unavailable");
      assert.equal(name, createdName);
      return { id: "org_target" };
    } } }) },
  });
  return {
    writes, updates,
    run: (body) => route.POST(new Request("https://example.com/api/orgs/create", {
      method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
    })),
  };
}

test("create org rejects unsigned and invalid names without writing", async () => {
  const signedOut = createRoute({ userId: null });
  assert.equal((await signedOut.run({ name: "Acme" })).status, 401);
  assert.equal(signedOut.writes.length, 0);
  for (const body of [{}, { name: "" }, { name: "   " }, { name: "x".repeat(61) }, "not json"]) {
    const fixture = createRoute();
    assert.equal((await fixture.run(body)).status, 400);
    assert.equal(fixture.writes.length, 0);
  }
});

test("create org makes the caller OWNER, selects it, and links the Clerk org", async () => {
  const fixture = createRoute();
  const response = await fixture.run({ name: "  Acme  " });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, organizationId: "db_org", clerkOrgId: "org_target" });
  assert.deepEqual(fixture.writes.map(([kind]) => kind), ["org", "member", "active"]);
  assert.equal(fixture.writes[1][1].role, "OWNER");
  assert.equal(fixture.writes[2][1].activeOrganizationId, "db_org");
  assert.equal(fixture.updates.length, 1);
  assert.equal(fixture.updates[0].data.clerkOrgId, "org_target");
});

test("create org still succeeds when the Clerk counterpart fails (links later)", async () => {
  const fixture = createRoute({ clerkFails: true });
  const response = await fixture.run({ name: "Acme" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, organizationId: "db_org", clerkOrgId: null });
  assert.equal(fixture.updates.length, 0);
});
