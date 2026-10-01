// Actual source with isolated dependencies. No live Clerk, provider, DB or GitHub calls.
/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { Webhook } = require("svix");
const plain = (value) => JSON.parse(JSON.stringify(value));
function load(file, dependencies = {}, globals = {}) {
  const code = ts.transpileModule(readFileSync(resolve(__dirname, "..", file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const context = { exports: {}, Error, Response, Request, AbortSignal, AbortController, ReadableStream, TextEncoder, Buffer, Date, setTimeout, clearTimeout, console: { error() {}, warn() {}, log() {} }, ...globals,
    require(name) { if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`); return dependencies[name]; } };
  vm.runInNewContext(code, context, { filename: file });
  return context.exports;
}
const validation = load("lib/validation.ts");
const versionData = load("lib/version-data.ts", { "node:crypto": require("node:crypto"), diff: require("diff"), zod: require("zod"), "@/lib/validation": validation });
function versionModule(db) {
  return load("lib/versions.ts", { "@/lib/validation": validation, "@/lib/prisma": { db }, "@/lib/generated/prisma/client": { Prisma: { DbNull: null } }, "@/lib/version-data": versionData });
}
const plans = { free: { credits: 10 }, starter: { credits: 50 }, pro: { credits: 150 } };
const clerkLib = load("lib/clerk.ts", { "@clerk/nextjs/server": {}, "./constants": { PLANS: plans } });

test("public actions reject omitted/empty/object IDs before touching Prisma; pruning is internal", async () => {
  const db = new Proxy({}, { get() { throw new Error("Unexpected database access"); } });
  const deps = { "@clerk/nextjs/server": { auth: async () => ({ userId: "user_fixture" }) }, "next/navigation": { redirect() { throw new Error("Unauthorized"); } }, "@/lib/prisma": { db }, "@/lib/validation": validation };
  const versions = load("actions/versions.ts", { ...deps, "@/lib/versions": {} });
  const projects = load("actions/projects.ts", { ...deps, "next/cache": {}, "@/lib/org": {} });
  const workspace = load("actions/workspace.ts", { ...deps, "@/lib/org": {} });
  assert.equal(versions.pruneVersions, undefined);
  for (const id of [undefined, null, "", " ", {}, []]) {
    await assert.rejects(versions.getVersions(id), /Invalid workspace ID/);
    await assert.rejects(projects.deleteProject(id), /Invalid workspace ID/);
    await assert.rejects(workspace.getWorkspaceById(id), /Invalid workspace ID/);
    await assert.rejects(versions.restoreVersion(id, "v", 0), /Invalid workspace ID/);
  }
  await assert.rejects(versions.restoreVersion("w", undefined, 0), /Invalid version ID/);
});

test("signed-out users and non-admin members cannot read or delete projects via actions", async () => {
  const db = new Proxy({}, { get() { throw new Error("Unexpected database access"); } });
  const deps = { "@clerk/nextjs/server": { auth: async () => ({ userId: null }) }, "next/navigation": { redirect() { throw new Error("Unauthorized"); } }, "@/lib/prisma": { db }, "@/lib/validation": validation };
  const versions = load("actions/versions.ts", { ...deps, "@/lib/versions": {} });
  await assert.rejects(versions.getVersions("w"), /Unauthorized/);
  await assert.rejects(versions.restoreVersion("w", "v", 0), /Unauthorized/);
  const projects = load("actions/projects.ts", { ...deps, "@clerk/nextjs/server": { auth: async () => ({ userId: "user_fixture" }) }, "next/cache": {}, "@/lib/org": { getActiveOrganization: async () => ({ role: "MEMBER" }) } });
  await assert.rejects(projects.deleteProject("w"), /Forbidden/);
});

test("pruning filters both reads and deletes by exact workspace and cleanup failures stay non-fatal", async () => {
  const calls = [];
  const tx = { $queryRaw: async () => [], workspaceVersion: {
    async findMany(args) { calls.push(plain(args)); return Array.from({ length: 21 }, (_, i) => ({ id: `v${i}`, kind: "snapshot" })); },
    async deleteMany(args) { calls.push(plain(args)); },
  } };
  const versions = versionModule({ $transaction: (fn) => fn(tx) });
  await assert.rejects(versions.pruneVersions(undefined), /Invalid/);
  await versions.pruneVersions("w");
  assert.equal(calls[0].where.workspaceId, "w");
  assert.equal(calls[1].where.workspaceId, "w");
  assert.deepEqual(calls[1].where.id.in, ["v20"]);
  const failure = versionModule({ $transaction: async () => { throw new Error("DB cleanup down"); } });
  await failure.pruneVersionsBestEffort("w");
});

function aiModule(db = {}) {
  return load("lib/ai-request.ts", { zod: require("zod"), "@/lib/validation": validation, "@/lib/arcjet": { aj: { protect: async () => ({ isDenied: () => false }) } }, "@/lib/prisma": { db }, "node:crypto": require("node:crypto") });
}
const app = { files: { "/App.js": { code: "export default function App() { return null }" } }, dependencies: {} };
test("generation route validates actual model output before save, propagates cancellation, and releases its lease", async () => {
  for (const scenario of ["valid", "empty", "disconnect"]) {
    let saved = 0, released = 0, modelSignal;
    const db = { user: { findUnique: async () => ({ id: "u", activeOrganizationId: "o", memberships: [{ role: "OWNER", organization: { id: "o", credits: 2 } }] }) },
      organization: { findUnique: async () => ({ id: "o", credits: 2 }) },
      $transaction: (fn) => fn({ $queryRaw: async () => [{ key: "user:u" }] }), aiRunLease: { deleteMany: async () => released++ },
    };
    const route = load("app/api/gen-ai-code/route.ts", {
      "@clerk/nextjs/server": { auth: async () => ({ userId: "user_fixture" }) }, "next/server": {},
      "@/lib/prisma": { db }, "@/lib/constants": { CREDIT_COST_PER_GENERATION: 1 }, "@/lib/ai-request": aiModule(db),
      "@/lib/workspace-save": { saveAiWorkspace: async () => { saved++; return { workspaceId: "new_w", revision: 0, creditsRemaining: 1 }; } },
      "@google/genai": { GoogleGenAI: class { constructor() { this.models = { generateContentStream: async ({ config }) => {
        modelSignal = config.abortSignal;
        if (scenario === "disconnect") return new Promise((_, reject) => modelSignal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }));
        return (async function* () { yield { candidates: [{ content: { parts: [{ text: JSON.stringify({ ...app, files: scenario === "empty" ? {} : app.files, assistantMessage: "Done", title: "Test app" }) }] } }] }; })();
      } }; } } },
    }, { process: { env: {} } });
    const result = await route.POST(new Request("https://example.com/generate", { method: "POST", body: JSON.stringify({ workspaceId: null, orgId: "o", messages: [{ role: "user", content: "Build an app" }], fileData: null }) }));
    assert.equal(result.status, 200);
    if (scenario === "disconnect") { await result.body.cancel(); await new Promise(setImmediate); assert.equal(modelSignal.aborted, true); }
    else { const text = await result.text(); assert.match(text, scenario === "valid" ? /"type":"done"/ : /"type":"error"/); }
    assert.equal(saved, scenario === "valid" ? 1 : 0); assert.equal(released, 1);
  }
});
test("AI inputs/outputs reject empty files, invalid code types, unsafe paths and missing revisions", () => {
  const ai = aiModule();
  for (const bad of [{ files: {}, dependencies: {} }, { files: { "/App.js": { code: 1 } }, dependencies: {} }, { ...app, files: { ...app.files, "/../secret.js": { code: "x" } } }, { files: { "/App.js": { code: "" } }, dependencies: {} }]) assert.throws(() => ai.validateApp(bad), /invalid project/);
  for (const path of ["/../x", "/a/../../x", "/.git/config", "/a\\b", "/a//b", "/C:/x"]) assert.equal(validation.isSafeFilePath(path), false);
  const base = { workspaceId: "w", orgId: "o", messages: [{ role: "user", content: "change" }], fileData: app };
  assert.equal(ai.GenerateRequestSchema.safeParse(base).success, false);
  assert.equal(ai.GenerateRequestSchema.safeParse({ ...base, revision: 0 }).success, true);
  assert.equal(ai.ImproveRequestSchema.safeParse({ workspaceId: "w", revision: 0, userRequest: "change", fileData: app, model: "untrusted-provider" }).success, false);
  assert.equal(ai.ImproveRequestSchema.safeParse({ workspaceId: "w", revision: 0, userRequest: "change", fileData: app, model: "nemotron" }).success, true);
  assert.equal(ai.ImproveRequestSchema.safeParse({ workspaceId: "w", revision: 0, userRequest: "change", fileData: app, model: "qwen" }).success, false);
  assert.equal(clerkLib.toDrevoPlan("notaproplan"), "free");
});

test("Nemotron resolver uses the exact free model with the server OpenRouter key and fails closed without it", () => {
  const calls = [];
  const env = { OPENROUTER_API_KEY: "  fixture-openrouter-key  " };
  const nemotron = load("app/api/improve/models/nemotron.ts", { "@openrouter/ai-sdk-provider": {
    createOpenRouter: ({ apiKey }) => (modelId) => { calls.push({ apiKey, modelId }); return { modelId }; },
  } }, { process: { env } });
  const modelId = "nvidia/nemotron-3-ultra-550b-a55b:free";
  const models = load("app/api/improve/models/index.ts", {
    "./nemotron": nemotron, "./gemini": { resolveGeminiModel: () => ({ short: "Gemini" }) }, "./atria": { resolveAtriaModel: () => ({ short: "Atria" }) },
  });
  const selected = models.resolveImproveModel("nemotron");
  assert.equal(selected.short, "Nemotron");
  assert.equal(selected.model.modelId, modelId);
  assert.match(selected.label, /Nemotron/);
  assert.deepEqual(calls, [{ apiKey: "fixture-openrouter-key", modelId }]);
  assert.equal(models.resolveImproveModel("gemini").short, "Gemini");
  assert.equal(models.resolveImproveModel("atria").short, "Atria");
  for (const key of [undefined, "", "  "]) {
    env.OPENROUTER_API_KEY = key;
    assert.throws(() => models.resolveImproveModel("nemotron"), /NEMOTRON_NOT_CONFIGURED/);
  }
  assert.equal(calls.length, 1);
  const response = models.notConfiguredResponse("nemotron");
  assert.equal(response.code, "NEMOTRON_NOT_CONFIGURED");
  assert.match(response.message, /Nemotron.*OpenRouter/);
  const errors = load("app/api/improve/errors.ts");
  const quota = errors.quotaErrorPayload({ statusCode: 429 }, selected.short);
  assert.match(quota.message, /Nemotron rate limit.*switch to Gemini/);
});

test("improve route honors Nemotron selection without charging for a missing key or no-op", async () => {
  for (const missingKey of [true, false]) {
    const selections = [];
    let runs = 0, saved = 0, released = 0;
    const db = {
      user: { findUnique: async () => ({ id: "u", memberships: [{ role: "MEMBER", organization: { id: "o", credits: 2 } }] }) },
      workspace: { findUnique: async () => ({ organizationId: "o", revision: 0 }) },
      organization: { findUnique: async () => ({ credits: 2 }) },
    };
    const ai = aiModule(db);
    const route = load("app/api/improve/route.ts", {
      "@clerk/nextjs/server": { auth: async () => ({ userId: "user_fixture" }) }, "next/server": {},
      "@/lib/prisma": { db }, "@/lib/constants": { CREDIT_COST_PER_GENERATION: 1 },
      "@/lib/ai-request": { ...ai, acquireAiLease: async () => async () => released++ },
      "./errors": load("app/api/improve/errors.ts"),
      "./models": {
        resolveImproveModel: (selection) => { selections.push(selection); if (missingKey) throw new Error("NEMOTRON_NOT_CONFIGURED"); return { short: "Nemotron", label: "Nemotron", model: {} }; },
        notConfiguredResponse: () => ({ code: "NEMOTRON_NOT_CONFIGURED", message: "Add an OpenRouter key to enable Nemotron." }),
      },
      "./agent-tools": { createImproveTools: () => ({}) },
      "./agent-prompts": load("app/api/improve/agent-prompts.ts"),
      "./agent-finish": { createFinishRun: () => async () => saved++, diffPaths: () => [] },
      "./agent-run": { runAgentWithRetries: async () => { runs++; return { steps: [{ toolCalls: [{ toolName: "done_improving" }] }], finalText: "NO_OP: No changes needed.", streamError: null }; } },
    }, { process: { env: {} } });
    const response = await route.POST(new Request("https://example.com/api/improve", { method: "POST", body: JSON.stringify({ workspaceId: "w", revision: 0, userRequest: "Explain this app without changing it", fileData: app, model: "nemotron" }) }));
    assert.deepEqual(selections, ["nemotron"]);
    assert.equal(response.status, missingKey ? 400 : 200);
    if (missingKey) assert.equal((await response.json()).code, "NEMOTRON_NOT_CONFIGURED");
    else assert.match(await response.text(), /"type":"done".*"creditsRemaining":2/);
    assert.equal(runs, missingKey ? 0 : 1); assert.equal(released, missingKey ? 0 : 1); assert.equal(saved, 0);
  }
});

test("Nemotron runs update and completion tools through the actual AI SDK with mocked OpenRouter SSE", async () => {
  const ai = await import("ai");
  const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
  const requests = [];
  const updatedCode = "export default function App() { return 'Updated by Nemotron'; }";
  const nemotron = load("app/api/improve/models/nemotron.ts", { "@openrouter/ai-sdk-provider": {
    createOpenRouter: (settings) => createOpenRouter({ ...settings, fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      assert.equal(body.model, "nvidia/nemotron-3-ultra-550b-a55b:free");
      assert.equal(body.tool_choice, "required");
      const first = requests.length === 1;
      const args = first ? { path: "/App.js", code: updatedCode, reason: "Update heading" } : { summary: "Updated heading." };
      const chunk = { id: "fixture-completion", object: "chat.completion.chunk", created: 1, model: body.model,
        choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: first ? "update_file" : "done_improving", arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    } }),
  } }, { process: { env: { OPENROUTER_API_KEY: "fixture-not-a-real-key" } } });
  const state = { files: plain(app.files), dependencies: {}, setSummary: (value) => { state.summary = value; } };
  const factory = load("app/api/improve/agent-tools.ts", { ai, zod: require("zod"), "@/lib/validation": validation });
  const errors = load("app/api/improve/errors.ts");
  const engine = load("app/api/improve/agent-run.ts", { ai, "./errors": errors });
  const selected = nemotron.resolveNemotronModel();
  const result = await engine.runAgentWithRetries({ model: selected.model, modelLabel: selected.label,
    instructions: "Update the heading, then call done_improving.", input: "Change the heading.",
    tools: factory.createImproveTools(state, () => {}), abortSignal: new AbortController().signal,
    resetRunState() {}, shouldStop: () => false, enqueue() {},
  });
  assert.equal(requests.length, 2);
  assert.equal(state.files["/App.js"].code, updatedCode);
  assert.equal(state.summary, "Updated heading.");
  assert.ok(result.steps.some((step) => step.toolCalls.some((call) => call.toolName === "done_improving")));
  assert.equal(result.streamError, null);
});

test("OpenRouter budget stays authenticated/server-only and returns spending limits rather than request counts", async () => {
  for (const scenario of ["signed-out", "missing-key", "success", "provider-failure"]) {
    let calls = 0;
    const route = load("app/api/models/openrouter-budget/route.ts", {
      "next/server": { NextResponse: Response },
      "@clerk/nextjs/server": { auth: async () => ({ userId: scenario === "signed-out" ? null : "user_fixture" }) },
    }, { process: { env: { OPENROUTER_API_KEY: scenario === "missing-key" ? "" : " fixture-key " } }, fetch: async (url, options) => {
      calls++;
      assert.equal(url, "https://openrouter.ai/api/v1/key");
      assert.equal(options.headers.Authorization, "Bearer fixture-key");
      return scenario === "provider-failure" ? new Response("Unauthorized", { status: 401 }) : Response.json({ data: { limit: 5, limit_remaining: 4.25 } });
    } });
    const response = await route.GET();
    assert.equal(response.status, scenario === "signed-out" ? 401 : 200);
    const payload = await response.json();
    assert.equal(JSON.stringify(payload).includes("fixture-key"), false);
    if (scenario === "success") {
      assert.deepEqual(payload, { configured: true, remaining: 4.25, limit: 5 });
      await route.GET();
      assert.equal(calls, 1); // cache avoids extra provider reads
    } else if (scenario === "provider-failure") assert.deepEqual(payload, { configured: true, remaining: null, limit: null });
    else assert.equal(calls, 0);
  }
});

test("chat selector displays Nemotron and labels OpenRouter's USD budget without daily-quota claims", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const empty = () => null;
  const { ChatPanel } = load("components/ChatPanel.tsx", {
    react: React, "react/jsx-runtime": require("react/jsx-runtime"), "@clerk/nextjs": { useUser: () => ({ user: null }) },
    "lucide-react": new Proxy({}, { get: () => empty }), "@/lib/utils": { cn: (...args) => args.filter(Boolean).join(" ") },
    sonner: { toast: {} }, "react-markdown": { default: empty }, "@/components/ui/button": { Button: empty },
    "@/components/PricingModal": { PricingModal: ({ children }) => children }, "@supabase/supabase-js": { createClient: () => ({}) },
    "./reusables": { BrandTitle: ({ children }) => children }, "@/components/LogoMark": { LogoMark: empty },
  }, { process: { env: {} } });
  const props = { messages: [], statusLog: [], credits: 2, workspaceId: "w", orgId: "o", appTitle: "Fixture", editModel: "nemotron", isGenerating: false, isImproving: false };
  for (const budget of [null, { configured: false }, { configured: true, remaining: null }, { configured: true, remaining: 0, limit: 5 }]) {
    const html = renderToStaticMarkup(React.createElement(ChatPanel, { ...props, openRouterBudget: budget }));
    assert.match(html, /NVIDIA: Nemotron 3 Ultra via OpenRouter \(free\)/);
    assert.match(html, />Nemotron<\/button>/);
    assert.doesNotMatch(html, /Qwen|left today|resets UTC midnight/);
    if (budget?.remaining === 0) assert.match(html, /OpenRouter key budget: \$0\.00 remaining/);
    if (budget?.configured === false) assert.match(html, /Add an OpenRouter key to enable Nemotron/);
  }
});

function saveFixture({ credits = 2, revision = 0, cleanupFails = false, member = true, loseRace = false, abortAtCharge = false } = {}) {
  const signal = new AbortController();
  let state = { credits, revision, fileData: { ...app, files: { "/App.js": { code: "export default function Old() { return null }" } } }, snapshots: [] };
  const db = { $transaction: async (fn) => {
    const before = structuredClone(state);
    const tx = {
      $queryRaw: async () => [{ id: "o" }],
      organizationMember: { findUnique: async () => member ? { role: "MEMBER" } : null },
      workspace: {
        findUnique: async () => ({ organizationId: "o", revision: state.revision, fileData: state.fileData }),
        updateMany: async ({ where, data }) => {
          if (loseRace || where.revision !== state.revision) return { count: 0 };
          state.revision++; state.fileData = data.fileData; return { count: 1 };
        },
      },
      workspaceVersion: {
        findFirst: async () => null,
        create: async ({ data }) => state.snapshots.push(data.fileData),
        findMany: async () => { if (cleanupFails) throw new Error("Pruning down"); return []; },
      },
      organization: {
        updateMany: async () => { if (abortAtCharge) signal.abort(); if (state.credits < 1) return { count: 0 }; state.credits--; return { count: 1 }; },
        findUniqueOrThrow: async () => ({ credits: state.credits }),
      },
    };
    try { return await fn(tx); } catch (error) { state = before; throw error; }
  } };
  const cleanup = versionModule(db);
  const saver = load("lib/workspace-save.ts", { "@/lib/prisma": { db }, "@/lib/constants": { CREDIT_COST_PER_GENERATION: 1 }, "@/lib/versions": cleanup, "@/lib/ai-request": aiModule() });
  const args = { workspaceId: "w", revision: 0, orgId: "o", userId: "u", fileData: app, messages: [{ role: "user", content: "change" }], summary: "Change", signal: signal.signal };
  return { save: (override = {}) => saver.saveAiWorkspace({ ...args, ...override }), state: () => state, signal };
}
test("AI save snapshots DB truth, returns transactional credits/revision, and ignores post-commit pruning failure", async () => {
  const fixture = saveFixture({ cleanupFails: true });
  const result = await fixture.save();
  assert.deepEqual(plain(result), { workspaceId: "w", revision: 1, creditsRemaining: 1 });
  assert.match(fixture.state().snapshots[0].files["/App.js"].code, /Old/);
  assert.equal(fixture.state().credits, 1);
});
test("stale/racing edits, revocation, no credits and cancellation roll back workspace, history and charge", async () => {
  for (const opts of [{ revision: 1 }, { loseRace: true }, { member: false }, { credits: 0 }, { abortAtCharge: true }]) {
    const fixture = saveFixture(opts), before = structuredClone(fixture.state());
    await assert.rejects(fixture.save());
    assert.deepEqual(fixture.state(), before);
  }
  const aborted = saveFixture(); aborted.signal.abort();
  await assert.rejects(aborted.save());
  assert.equal(aborted.state().credits, 2);
  const empty = saveFixture(); await assert.rejects(empty.save({ fileData: { files: {}, dependencies: {} } }), /invalid project/);
  assert.equal(empty.state().credits, 2);
});

test("cancellation during dependency validation never enters the save path", async () => {
  const controller = new AbortController();
  let saved = false, done = false;
  const finish = load("app/api/improve/agent-finish.ts", {
    "@/lib/workspace-save": { saveAiWorkspace: async () => { saved = true; } }, "@/lib/ai-request": aiModule(),
  }, { fetch: async () => { controller.abort(); return { ok: true }; } });
  const run = finish.createFinishRun({ workspaceId: "w", revision: 0, orgId: "o", userId: "u", signal: controller.signal, userRequest: "change", baseFileData: app,
    getState: () => ({ ...app, dependencies: { axios: "latest" } }), enqueueDone: () => { done = true; } });
  await assert.rejects(run("Done", false));
  assert.equal(saved, false); assert.equal(done, false);
});

test("billing allowances are additive/idempotent, renew without a plan change, and preserve cancellation balances", async () => {
  let period = Date.now() - 1000, status = "active";
  const state = { id: "o", plan: "free", credits: 10, billingBaselineAt: new Date(0), billingBaselinePlan: "free" };
  const receipts = new Set();
  const db = {
    $queryRaw: async () => [{ id: "o" }],
    organization: {
      findUniqueOrThrow: async () => state,
      update: async ({ data }) => { state.credits += data.credits?.increment ?? 0; state.plan = data.plan; return state; },
    },
    organizationCreditGrant: { createMany: async ({ data }) => { if (receipts.has(data[0].key)) return { count: 0 }; receipts.add(data[0].key); return { count: 1 }; } },
  };
  let tail = Promise.resolve();
  db.$transaction = (fn) => { const result = tail.then(() => fn(db)); tail = result.catch(() => {}); return result; };
  const billing = load("lib/billing.ts", { "@/lib/prisma": { db }, "@/lib/constants": { PLANS: plans }, "@/lib/clerk": {
    ...clerkLib, getClerk: async () => ({ billing: { getOrganizationBillingSubscription: async () => ({ id: "sub", subscriptionItems: [
      { status: "active", plan: { slug: "free" }, periodStart: 1, periodEnd: null },
      { status, plan: { slug: "proorg" }, periodStart: period, periodEnd: Date.now() + 86400000, planPeriod: "month", isFreeTrial: false },
      { status: "upcoming", plan: { slug: "starterorg" }, periodStart: Date.now() + 86400000 },
    ] }) } }),
  } });
  await Promise.all([billing.syncOrgPlan("org"), billing.syncOrgPlan("org"), billing.syncOrgPlan("org")]);
  assert.equal(state.credits, 160); assert.equal(state.plan, "pro");
  state.credits--; period += 500;
  await billing.syncOrgPlan("org"); assert.equal(state.credits, 309);
  status = "ended"; await billing.syncOrgPlan("org");
  assert.equal(state.plan, "free"); assert.equal(state.credits, 309);
  status = "active"; await billing.syncOrgPlan("org"); assert.equal(state.credits, 309);
  status = "ended";
  const delayed = [{ plan: { slug: "starterorg" }, plan_period: "month", period_start: period - 200, confirmedAt: Date.now() - 500 }];
  await billing.syncOrgPlan("org", delayed); await billing.syncOrgPlan("org", delayed);
  assert.equal(state.credits, 359); assert.equal(state.plan, "free");
});

test("temporary Clerk 429 never downgrades Pro or duplicates Gupta's accepted historical balance", async () => {
  const state = { id: "o", plan: "pro", credits: 399, billingBaselineAt: new Date(), billingBaselinePlan: "pro" };
  let fails = true, increments = 0;
  const keys = new Set();
  const tx = { $queryRaw: async () => [{ id: "o" }], organization: {
    findUniqueOrThrow: async () => state, update: async ({ data }) => { increments++; state.credits += data.credits?.increment ?? 0; state.plan = data.plan; return state; },
  }, organizationCreditGrant: { createMany: async ({ data }) => { if (keys.has(data[0].key)) return { count: 0 }; keys.add(data[0].key); return { count: 1 }; } } };
  const billing = load("lib/billing.ts", { "@/lib/prisma": { db: { $transaction: (fn) => fn(tx) } }, "@/lib/constants": { PLANS: plans }, "@/lib/clerk": {
    ...clerkLib, getClerk: async () => ({ billing: { getOrganizationBillingSubscription: async () => {
      if (fails) throw Object.assign(new Error("Clerk rate limit"), { status: 429 });
      return { subscriptionItems: [{ status: "active", plan: { slug: "proorg" }, planPeriod: "month", isFreeTrial: false, periodStart: state.billingBaselineAt.getTime() - 5000, periodEnd: Date.now() + 86400000 }] };
    } } }),
  } });
  await assert.rejects(billing.syncOrgPlan("org"), /rate limit/);
  assert.equal(state.plan, "pro"); assert.equal(state.credits, 399);
  fails = false; await billing.syncOrgPlan("org"); await billing.syncOrgPlan("org");
  assert.equal(state.credits, 399); assert.equal(increments, 0);
  await billing.syncOrgPlan("org", [{ plan: { slug: "starterorg" }, plan_period: "month", period_start: Date.now() - 10000, confirmedAt: state.billingBaselineAt.getTime() - 5000 }]);
  assert.equal(state.credits, 399);
});

test("personal organization creation is serialized and deleting it cannot regenerate trial credits", async () => {
  let membership = null, trialUsed = false, creates = 0, clerkCreates = 0;
  const allocations = [];
  const tx = { $queryRaw: async () => [],
    organizationMember: { findFirst: async () => membership, create: async ({ data }) => { membership = data; } },
    user: { updateMany: async () => { if (trialUsed) return { count: 0 }; trialUsed = true; return { count: 1 }; }, update: async () => {} },
    organization: { create: async ({ data }) => { allocations.push(data.credits); return { id: `o${++creates}` }; } },
  };
  let tail = Promise.resolve();
  const db = { user: { findUnique: async () => ({ id: "u", clerkId: "user_u", name: "Fixture", activeOrganizationId: null, memberships: [] }) },
    organization: { update: async () => {} },
    $transaction: (fn) => { const result = tail.then(() => fn(tx)); tail = result.catch(() => {}); return result; },
  };
  const org = load("lib/org.ts", { "@clerk/nextjs/server": {}, react: { cache: (fn) => fn }, "next/navigation": {}, "@/lib/prisma": { db }, "@/lib/constants": { PLANS: plans }, "@/lib/validation": validation,
    "./clerk": { getClerk: async () => ({ organizations: { createOrganization: async () => ({ id: `org_${++clerkCreates}` }) } }) },
  });
  await Promise.all([org.ensurePersonalOrganization("u"), org.ensurePersonalOrganization("u")]);
  assert.equal(creates, 1); assert.equal(clerkCreates, 1); assert.deepEqual(allocations, [10]);
  membership = null; await org.ensurePersonalOrganization("u");
  assert.deepEqual(allocations, [10, 0]);
});

test("AI SDK 503 error parts retry with a fresh patch state instead of bypassing the retry loop", async () => {
  let attempts = 0, resets = 0;
  const errors = load("app/api/improve/errors.ts");
  const engine = load("app/api/improve/agent-run.ts", { "./errors": errors, ai: {
    stepCountIs: () => {}, hasToolCall: () => {}, streamText: () => {
      attempts++;
      return { fullStream: (async function* () { if (attempts < 3) yield { type: "error", error: { statusCode: 503, message: "overloaded" } }; })(), steps: Promise.resolve([{ toolCalls: [{ toolName: "done_improving" }] }]), text: Promise.resolve("Done") };
    },
  } }, { setTimeout: (fn) => { queueMicrotask(fn); return 1; }, clearTimeout() {} });
  const result = await engine.runAgentWithRetries({ model: {}, modelLabel: "fixture", instructions: "", input: "", tools: {}, abortSignal: new AbortController().signal, resetRunState: () => resets++, shouldStop: () => false, enqueue() {} });
  assert.equal(attempts, 3); assert.equal(resets, 3); assert.equal(result.finalText, "Done");
});

test("GitHub deletes only paths tracked for the exact member/repository/branch and remote success survives tracking failure", async () => {
  for (const scenario of ["new-target", "known-target", "other-member", "other-branch", "tracking-fails", "rate-limited"]) {
    const trees = [], targetQueries = [];
    const userId = scenario === "other-member" ? "u2" : "u";
    const branch = scenario === "other-branch" ? "develop" : "main";
    const remote = { rest: {
      repos: { get: async () => { if (scenario === "rate-limited") throw Object.assign(new Error("API rate limit exceeded"), { status: 403 }); return { data: { html_url: "https://github.com/owner/b", default_branch: "main" } }; } },
      git: { getRef: async () => ({ data: { object: { sha: "head" } } }), getCommit: async () => ({ data: { tree: { sha: "tree" } } }),
        createBlob: async () => ({ data: { sha: "new" } }), getTree: async () => ({ data: { tree: [] } }),
        createTree: async ({ tree }) => { trees.push(plain(tree)); return { data: { sha: "new-tree" } }; }, createCommit: async () => ({ data: { sha: "commit" } }), updateRef: async ({ force }) => assert.equal(force, false),
      },
    } };
    const db = { user: { findUnique: async () => ({ id: userId, githubAccessToken: "encrypted", githubUsername: "owner", memberships: [{ organizationId: "o" }] }) },
      workspace: { findUnique: async () => ({ id: "w", organizationId: "o", fileData: app, githubPushedFiles: ["src/from-A.js"] }) },
      githubPushTarget: { findUnique: async (args) => { targetQueries.push(plain(args)); return scenario === "known-target" ? { pushedFiles: ["src/from-B.js"] } : null; }, upsert: async () => { if (scenario === "tracking-fails") throw new Error("DB down after push"); } },
    };
    const route = load("app/api/github/push/route.ts", { "@clerk/nextjs/server": { auth: async () => ({ userId: "user_fixture" }) }, "next/server": { NextResponse: Response }, zod: require("zod"), "@/lib/prisma": { db }, octokit: { Octokit: class { constructor() { return remote; } } },
      "@/lib/export-project": { buildProjectFilesFromFileData: () => ({ "src/App.js": "new code" }) },
      "@/lib/github": { decryptToken: () => "fixture", validateBranchName: () => null, validateRepoName: () => null, parseRepoFullName: () => ({ owner: "owner", repo: "b" }) },
    });
    const res = await route.POST(new Request("https://example.com/push", { method: "POST", body: JSON.stringify({ workspaceId: "w", mode: "existing", repoFullName: "Owner/B", branch }) }));
    assert.equal(res.status, scenario === "rate-limited" ? 429 : 200);
    assert.deepEqual(targetQueries[0].where.workspaceId_userId_repoFullName_branch, { workspaceId: "w", userId, repoFullName: "owner/b", branch });
    if (scenario !== "rate-limited") {
      const deleted = trees.flat().filter((entry) => entry.sha === null).map((entry) => entry.path);
      assert.deepEqual(deleted, scenario === "known-target" ? ["src/from-B.js"] : []);
      assert.equal((await res.json()).trackingSaved, scenario !== "tracking-fails");
    }
  }
});

test("organization deletion fails closed on paid billing/provider errors and deletes Clerk before local data", async () => {
  for (const scenario of ["paid", "provider-error", "delete-error", "free", "already-gone"]) {
    const calls = [];
    const members = { findUnique: async () => ({ role: "OWNER" }), count: async () => 0, findFirst: async () => null };
    const tx = { $queryRaw: async () => [{ clerkOrgId: "org_o" }], organizationMember: members, organization: { deleteMany: async () => calls.push("local-delete") } };
    const db = { organizationMember: members, $transaction: (fn) => fn(tx), user: { updateMany: async () => calls.push("pointer") } };
    tx.user = db.user;
    const route = load("app/api/orgs/delete/route.ts", { "next/server": { NextResponse: Response }, zod: require("zod"), "@/lib/prisma": { db }, "@/lib/org": { getActiveOrganization: async () => ({ role: "OWNER", userId: "u", clerkId: "user_u", organization: { id: "o" } }) }, "@/lib/clerk": {
      ...clerkLib, getClerk: async () => ({ organizations: {
        getOrganization: async () => { if (scenario === "provider-error") throw Object.assign(new Error("Unavailable"), { status: 429 }); if (scenario === "already-gone") throw Object.assign(new Error("Not found"), { status: 404 }); },
        getOrganizationMembershipList: async () => ({ totalCount: 1, data: [{ role: "org:admin", publicUserData: { userId: "user_u" } }] }),
        deleteOrganization: async () => { calls.push("clerk-delete"); if (scenario === "delete-error") throw new Error("Clerk failed"); },
      }, billing: { getOrganizationBillingSubscription: async () => { calls.push("billing-read"); return { subscriptionItems: scenario === "paid" ? [{ status: "active", plan: { slug: "proorg" } }] : [] }; } } }),
    } });
    const res = await route.DELETE(new Request("https://example.com/org", { method: "DELETE", body: JSON.stringify({ organizationId: "o" }) }));
    assert.equal(res.status, scenario === "paid" ? 409 : ["provider-error", "delete-error"].includes(scenario) ? 503 : 200);
    if (scenario === "free") assert.deepEqual(calls, ["billing-read", "clerk-delete", "local-delete", "pointer"]);
    if (["paid", "provider-error", "delete-error"].includes(scenario)) assert.equal(calls.includes("local-delete"), false);
    if (scenario === "already-gone") assert.deepEqual(calls, ["local-delete", "pointer"]);
  }
});

function membershipFixture() {
  let upstream = [], fail = false;
  const users = new Map([["user_u", { id: "u", activeOrganizationId: "other" }]]);
  const members = new Map([["u", { id: "m", userId: "u", role: "ADMIN" }]]);
  const tx = {
    $queryRaw: async () => [{ id: "o" }],
    user: { findUnique: async ({ where }) => users.get(where.clerkId), updateMany: async ({ where, data }) => { const u = users.get("user_u"); if (u.id === where.id && (where.activeOrganizationId === undefined || u.activeOrganizationId === where.activeOrganizationId)) Object.assign(u, data); } },
    organizationMember: {
      findUnique: async ({ where }) => members.get(where.organizationId_userId.userId),
      upsert: async ({ where, create, update }) => { const id = where.organizationId_userId.userId; members.set(id, members.has(id) ? { ...members.get(id), ...update } : { id: "m", ...create }); },
      findMany: async ({ where }) => [...members.values()].filter((m) => !where.userId.notIn.includes(m.userId)),
      deleteMany: async () => members.clear(), findFirst: async () => ({ organizationId: "other" }),
    },
  };
  const sync = load("lib/membership-sync.ts", { "@/lib/validation": validation, "@/lib/prisma": { db: { $transaction: (fn) => fn(tx) } }, "@/lib/clerk": {
    ...clerkLib, getClerk: async () => ({ organizations: { getOrganizationMembershipList: async () => { if (fail) throw new Error("Clerk unavailable"); return { data: upstream }; } } }),
  } });
  return { sync: (activate = false) => sync.syncClerkMemberships("org_o", "user_u", activate), users, members,
    set: (role) => { upstream = role ? [{ role, organization: { id: "org_o" }, publicUserData: { userId: "user_u" } }] : []; }, fail: () => { fail = true; }, module: sync };
}
test("authoritative membership sync updates roles, removes revoked users, ignores stale event roles and preserves other active selections", async () => {
  const f = membershipFixture(); f.set("org:member"); await f.sync();
  assert.equal(f.members.get("u").role, "MEMBER"); assert.equal(f.users.get("user_u").activeOrganizationId, "other");
  f.set(null); await f.sync(); await f.sync(); assert.equal(f.members.size, 0);
  f.set("org:member"); await f.sync(true); assert.equal(f.members.size, 1); assert.equal(f.users.get("user_u").activeOrganizationId, "o");
  f.set(null); await f.sync(); assert.equal(f.users.get("user_u").activeOrganizationId, "other");
  f.members.set("u", { id: "m", userId: "u", role: "OWNER" }); f.set("org:admin"); await f.sync(); assert.equal(f.members.get("u").role, "OWNER");
  f.set("org:member"); await f.sync(); assert.equal(f.members.get("u").role, "MEMBER");
  f.fail(); await assert.rejects(f.sync(), /Clerk unavailable/); assert.equal(f.members.size, 1);
});

test("delayed membership-created and updated webhooks use current Clerk truth, not their old ADMIN payload", async () => {
  const f = membershipFixture(); f.set(null);
  const secret = `whsec_${Buffer.alloc(32, 3).toString("base64")}`;
  const route = load("app/api/webhooks/clerk/route.ts", { "next/server": { NextResponse: Response }, svix: { Webhook }, "@/lib/prisma": {}, "@/lib/clerk": {}, "@/lib/billing": {}, "@/lib/membership-sync": f.module }, { process: { env: { CLERK_WEBHOOK_SECRET: secret } } });
  for (const type of ["organizationMembership.created", "organizationMembership.updated", "organizationMembership.deleted"]) {
    const body = JSON.stringify({ type, data: { role: "org:admin", organization: { id: "org_o" }, public_user_data: { user_id: "user_u" } } });
    const now = new Date(), id = "msg_test";
    const res = await route.POST(new Request("https://example.com/webhook", { method: "POST", body, headers: { "svix-id": id, "svix-timestamp": String(Math.floor(now.getTime()/1000)), "svix-signature": new Webhook(secret).sign(id, now, body) } }));
    assert.equal(res.status, 200); assert.equal(f.members.size, 0);
  }
});

test("role changes call Clerk before Prisma and never change local role on provider failure", async () => {
  for (const fails of [false, true]) {
    const calls = [];
    const db = { organizationMember: { findFirst: async () => ({ id: "target", userId: "u2", role: "ADMIN", user: { clerkId: "user_target" } }) } };
    db.$transaction = (fn) => fn({
      $queryRaw: async () => [{ clerkOrgId: "org_o" }],
      organizationMember: { findUnique: async ({ where }) => ({ role: where.id === "caller" ? "OWNER" : "ADMIN" }), update: async () => calls.push("prisma") },
    });
    const route = load("app/api/orgs/members/role/route.ts", { "next/server": { NextResponse: Response }, zod: require("zod"), "@/lib/prisma": { db }, "@/lib/org": { getActiveOrganization: async () => ({ role: "OWNER", clerkId: "user_owner", userId: "u", membership: { id: "caller" }, organization: { id: "o" } }) }, "@/lib/clerk": {
      ...clerkLib, getClerk: async () => ({ organizations: { getOrganizationMembershipList: async () => ({ data: [{ role: "org:admin", publicUserData: { userId: "user_owner" } }] }), updateOrganizationMembership: async ({ role }) => { assert.equal(role, "org:member"); calls.push("clerk"); if (fails) throw new Error("Unavailable"); } } }),
    } });
    const res = await route.PATCH(new Request("https://example.com/role", { method: "PATCH", body: JSON.stringify({ memberId: "target", role: "MEMBER" }) }));
    assert.equal(res.status, fails ? 503 : 200); assert.deepEqual(calls, fails ? ["clerk"] : ["clerk", "prisma"]);
  }
});

test("invitation self-healing uses the authoritative sync helper rather than a stale direct membership upsert", async () => {
  let synced = 0, invited = 0;
  const route = load("app/api/orgs/members/add/route.ts", { "next/server": { NextResponse: Response }, zod: require("zod"),
    "@/lib/org": { getActiveOrganization: async () => ({ role: "OWNER", clerkId: "user_owner", organization: { id: "o" } }) },
    "@/lib/prisma": { db: { organization: { findUnique: async () => ({ clerkOrgId: "org_o" }) }, user: { findUnique: async () => null }, organizationMember: { upsert() { throw new Error("Must not mirror a stale snapshot directly"); } } } },
    "@/lib/membership-sync": { syncClerkMemberships: async (org, user) => { assert.equal(org, "org_o"); assert.equal(user, "user_target"); synced++; } },
    "@/lib/clerk": { ...clerkLib, getClerk: async () => ({ organizations: {
      getOrganizationInvitationList: async () => ({ data: [] }), getOrganizationMembershipList: async ({ userId }) => ({ data: userId
        ? [{ role: "org:admin", publicUserData: { userId: "user_owner" } }]
        : [{ role: "org:admin", publicUserData: { userId: "user_target", identifier: "target@example.com" } }] }),
      createOrganizationInvitation: async () => invited++,
    } }) },
  });
  const response = await route.POST(new Request("https://example.com/invite", { method: "POST", body: JSON.stringify({ email: "target@example.com" }) }));
  assert.equal(response.status, 409); assert.equal(synced, 1); assert.equal(invited, 0);
});

test("shared credit events update only the owning organization", () => {
  const window = new EventTarget();
  const bus = load("lib/credits-bus.ts", {}, { window, CustomEvent });
  const updates = [];
  const unsubscribe = bus.subscribeCredits("o1", (credits) => updates.push(credits));
  bus.emitCredits(9, "o2"); bus.emitCredits(8, "o1"); unsubscribe(); bus.emitCredits(7, "o1");
  assert.deepEqual(updates, [8]);
});

test("late active-pointer repair cannot overwrite a newer explicit organization switch", async () => {
  let selected = "new-choice";
  const org = load("lib/org.ts", {
    "@clerk/nextjs/server": { auth: async () => ({ userId: "user_u" }) }, react: { cache: (fn) => fn }, "next/navigation": {}, "@/lib/constants": { PLANS: plans }, "@/lib/validation": validation,
    "@/lib/prisma": { db: { user: {
      findUnique: async () => ({ id: "u", activeOrganizationId: "stale", memberships: [{ id: "m", role: "OWNER", organization: { id: "fallback", name: "Fallback", plan: "free", credits: 0 } }] }),
      updateMany: async ({ where, data }) => { assert.equal(where.activeOrganizationId, "stale"); if (selected === where.activeOrganizationId) selected = data.activeOrganizationId; return { count: 0 }; },
    } } },
  });
  await org.getActiveOrganization();
  assert.equal(selected, "new-choice");
});
