// Isolated regressions: executes the actual TS routes/component with fixture
// Clerk/Prisma dependencies. Never loads .env or connects to external services.
// Run: node scripts/test-organization-invitation.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { Webhook } = require("svix");

function load(file, dependencies, globals = {}, extra = "") {
  const source = readFileSync(resolve(__dirname, "..", file), "utf8") + extra;
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ES2020, esModuleInterop: true,
  } }).outputText;
  const context = {
    exports: {}, Error, URLSearchParams,
    console: { error() {}, warn() {} },
    require(name) {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    ...globals,
  };
  vm.runInNewContext(code, context, { filename: file });
  return context.exports;
}

const target = "org_target";
function invitation(org, accepted, error) {
  return {
    id: `inv_${org}`, publicOrganizationData: { id: org, name: org },
    async accept() { if (error) throw error; accepted.push(org); },
  };
}

async function page({ query = `organization_id=${target}`, signedIn = true,
  pending = [], acceptError, completeStatus = 200, activateError,
  strict = false, pageSize = 100 } = {}) {
  const effects = [], accepted = [], requests = [], activated = [], redirects = [], states = [];
  const items = pending.map((org) => invitation(org, accepted, acceptError));
  const user = signedIn ? {
    primaryEmailAddress: { emailAddress: "fixture@example.com" },
    async getOrganizationInvitations({ initialPage }) {
      return { data: items.slice((initialPage - 1) * pageSize, initialPage * pageSize), total_count: items.length };
    },
  } : null;
  const jsx = (type, props) => ({ type, props });
  const component = load("app/(auth)/accept-invitation/[[...accept-invitation]]/page.tsx", {
    react: {
      Suspense: "Suspense", useEffect: (fn) => effects.push(fn),
      useCallback: (fn) => fn, useRef: (current) => ({ current }),
      useState: (initial) => [initial, (value) => states.push(value)],
    },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "next/navigation": { useSearchParams: () => new URLSearchParams(query) },
    "@clerk/nextjs": {
      SignIn: "SignIn", SignUp: "SignUp", useUser: () => ({ isLoaded: true, user }),
      useClerk: () => ({ signOut() {}, async setActive({ organization }) {
        if (activateError) throw activateError;
        activated.push(organization);
      } }),
    },
    "lucide-react": { Loader2: "Loader2" }, "@/components/ui/button": { Button: "Button" },
  }, {
    async fetch(url, options) {
      requests.push({ url, body: JSON.parse(options.body) });
      return Response.json({ clerkOrgId: target, message: "Membership not confirmed" }, { status: completeStatus });
    },
    window: { location: { replace: (url) => redirects.push(url) } },
    setTimeout() { throw new Error("Invitation flows must not time out into a success redirect"); },
  }, "\nexport { AcceptInvitationContent };");
  const rendered = component.AcceptInvitationContent();
  for (const effect of effects) {
    const cleanup = effect();
    if (strict) { cleanup?.(); effect(); }
  }
  await new Promise(setImmediate);
  return { accepted, requests, activated, redirects, states, rendered };
}

test("signed-out sign-up preserves the target and ticket; never starts acceptance or redirects", async () => {
  const result = await page({ signedIn: false, query: `organization_id=${target}&__clerk_status=sign_up&__clerk_ticket=fixture` });
  assert.equal(result.rendered.type, "SignUp");
  assert.equal(result.rendered.props.forceRedirectUrl, `/accept-invitation?organization_id=${target}`);
  assert.equal(new URL(result.rendered.props.signInUrl, "https://example.com").searchParams.get("__clerk_ticket"), "fixture");
  assert.equal(result.requests.length, 0);
  assert.deepEqual(result.redirects, []);
});

test("accepts only the named org, including on later pages; Strict Mode does not double accept", async () => {
  const result = await page({ pending: ["org_unrelated", target], pageSize: 1, strict: true });
  assert.deepEqual(result.accepted, [target]);
  assert.equal(result.requests.length, 1);
  assert.deepEqual(result.requests[0].body, { clerkOrgId: target });
  assert.deepEqual(result.activated, [target]);
  assert.deepEqual(result.redirects, ["/projects"]);
});

test("acceptance errors stay visible without syncing or redirecting", async () => {
  const result = await page({ pending: [target], acceptError: new Error("Invitation expired") });
  assert.ok(result.states.includes("Invitation expired"));
  assert.equal(result.requests.length, 0);
  assert.deepEqual(result.redirects, []);
});

test("already accepted ticket still requires server verification and org activation", async () => {
  const result = await page({ pending: ["org_unrelated"], query: `organization_id=${target}&__clerk_status=complete` });
  assert.deepEqual(result.accepted, []);
  assert.equal(result.requests.length, 1);
  assert.deepEqual(result.activated, [target]);
  assert.deepEqual(result.redirects, ["/projects"]);
});

test("missing membership or failed Clerk activation never redirects", async () => {
  const missing = await page({ completeStatus: 403 });
  assert.ok(missing.states.includes("Membership not confirmed"));
  assert.deepEqual(missing.activated, []);
  assert.deepEqual(missing.redirects, []);
  const failed = await page({ activateError: new Error("Activation failed") });
  assert.ok(failed.states.includes("Activation failed"));
  assert.deepEqual(failed.redirects, []);
});

test("legacy links never guess which pending invitation to accept", async () => {
  const result = await page({ query: "__clerk_status=complete&__clerk_ticket=fixture", pending: ["org_unrelated", target] });
  assert.deepEqual(result.accepted, []);
  assert.equal(result.requests.length, 0);
  assert.deepEqual(result.redirects, []);
  assert.ok(result.states.some((state) => Array.isArray(state) && state.length === 2));
});

function completion({ userId = "user_fixture", memberUserId = userId, memberOrg = target,
  member = true, existingRole, linked = true, clerkFailure = false } = {}) {
  const writes = [], members = new Map(), queries = [];
  if (existingRole) members.set("member", { id: "member", role: existingRole });
  const tx = {
    user: {
      async upsert(args) { writes.push(args); return { id: "db_user" }; },
      async update(args) { writes.push(args); return {}; },
    },
    organizationMember: {
      async upsert(args) {
        writes.push(args);
        if (!members.has("member")) members.set("member", { id: "member", role: args.create.role });
        return members.get("member");
      },
      async update(args) { writes.push(args); Object.assign(members.get("member"), args.data); },
    },
  };
  const route = load("app/api/orgs/invitations/complete/route.ts", {
    "@clerk/nextjs/server": { auth: async () => ({ userId }) },
    "next/server": { NextResponse: Response }, zod: require("zod"),
    "@/lib/clerk": {
      toPrismaRole: (role) => role === "org:admin" ? "ADMIN" : "MEMBER",
      getClerk: async () => ({
        organizations: { async getOrganizationMembershipList(params) {
          queries.push(params);
          if (clerkFailure) throw new Error("Clerk unavailable");
          return { data: member ? [{ publicUserData: { userId: memberUserId }, organization: { id: memberOrg }, role: "org:member" }] : [] };
        } },
        users: { getUser: async () => ({ primaryEmailAddressId: "email", emailAddresses: [{ id: "email", emailAddress: "fixture@example.com" }] }) },
      }),
    },
    "@/lib/prisma": { db: {
      organization: { findUnique: async () => linked ? { id: "db_org" } : null },
      $transaction: (fn) => fn(tx),
    } },
  });
  return {
    writes, members, queries,
    run: (body = { clerkOrgId: target }) => route.POST(new Request("https://example.com/api/orgs/invitations/complete", {
      method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
    })),
  };
}

test("completion rejects unsigned, malformed, non-member and mismatched-user/org requests without writes", async () => {
  for (const [options, body, status] of [
    [{ userId: null }, undefined, 401], [{}, "not json", 400],
    [{}, { clerkOrgId: "invalid" }, 400], [{ member: false }, undefined, 403],
    [{ memberUserId: "user_other" }, undefined, 403], [{ memberOrg: "org_other" }, undefined, 403],
    [{ linked: false }, undefined, 409], [{ clerkFailure: true }, undefined, 503],
  ]) {
    const fixture = completion(options);
    assert.equal((await fixture.run(body)).status, status);
    assert.equal(fixture.writes.length, 0);
  }
});

test("verified membership sync is repeatable, selects exactly the target and preserves OWNER", async () => {
  for (const existingRole of [undefined, "OWNER", "ADMIN"]) {
    const fixture = completion({ existingRole });
    assert.equal((await fixture.run()).status, 200);
    assert.equal((await fixture.run()).status, 200);
    assert.equal(fixture.members.size, 1);
    assert.equal(fixture.members.get("member").role, existingRole === "OWNER" ? "OWNER" : "MEMBER");
    assert.equal(fixture.writes.at(-1).data.activeOrganizationId, "db_org");
    assert.equal(fixture.queries[0].userId[0], "user_fixture");
    assert.equal(fixture.queries[0].organizationId, target);
  }
});

test("webhook verifies the original signed bytes and rejects tampering", async () => {
  const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
  const body = '{\n  "type": "fixture.unhandled",\n  "data": {}\n}';
  const timestamp = new Date();
  const route = load("app/api/webhooks/clerk/route.ts", {
    "next/server": { NextResponse: Response }, svix: { Webhook },
    "@/lib/prisma": { db: new Proxy({}, { get() { throw new Error("Unexpected DB access"); } }) },
    "@/lib/clerk": {},
    "@/lib/billing": { subscriptionOrgId: () => null, syncOrgPlan: async () => null },
  }, { process: { env: { CLERK_WEBHOOK_SECRET: secret } } });
  const headers = {
    "svix-id": "msg_fixture", "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": new Webhook(secret).sign("msg_fixture", timestamp, body),
  };
  const send = (payload) => route.POST(new Request("https://example.com/api/webhooks/clerk", { method: "POST", headers, body: payload }));
  assert.equal((await send(body)).status, 200);
  assert.equal((await send(body + " ")).status, 400);
});
