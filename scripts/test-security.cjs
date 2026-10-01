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
test("generation route validates output, propagates cancellation and reports deadlines without contradicting completed saves", async () => {
  for (const scenario of ["valid", "empty", "disconnect", "deadline", "late-deadline"]) {
    let saved = 0, released = 0, modelSignal;
    const deadline = new AbortController();
    const timeoutReason = new DOMException("Fixture deadline", "TimeoutError");
    const db = { user: { findUnique: async () => ({ id: "u", activeOrganizationId: "o", memberships: [{ role: "OWNER", organization: { id: "o", credits: 2 } }] }) },
      organization: { findUnique: async () => ({ id: "o", credits: 2 }) },
      $transaction: (fn) => fn({ $queryRaw: async () => [{ key: "user:u" }] }), aiRunLease: { deleteMany: async () => { released++; if (scenario === "late-deadline") deadline.abort(timeoutReason); } },
    };
    const route = load("app/api/gen-ai-code/route.ts", {
      "@clerk/nextjs/server": { auth: async () => ({ userId: "user_fixture" }) }, "next/server": {},
      "@/lib/prisma": { db }, "@/lib/constants": { CREDIT_COST_PER_GENERATION: 1 }, "@/lib/ai-request": aiModule(db),
      "@/lib/workspace-save": { saveAiWorkspace: async () => { saved++; return { workspaceId: "new_w", revision: 0, creditsRemaining: 1 }; } },
      "@google/genai": { GoogleGenAI: class { constructor() { this.models = { generateContentStream: async ({ config }) => {
        modelSignal = config.abortSignal;
        if (scenario === "deadline") { deadline.abort(timeoutReason); throw timeoutReason; }
        if (scenario === "disconnect") return new Promise((_, reject) => modelSignal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }));
        return (async function* () { yield { candidates: [{ content: { parts: [{ text: JSON.stringify({ ...app, files: scenario === "empty" ? {} : app.files, assistantMessage: "Done", title: "Test app" }) }] } }] }; })();
      } }; } } },
    }, { process: { env: {} }, AbortSignal: { any: (signals) => AbortSignal.any(signals), timeout: (ms) => ms === 290000 ? deadline.signal : AbortSignal.timeout(ms) } });
    const result = await route.POST(new Request("https://example.com/generate", { method: "POST", body: JSON.stringify({ workspaceId: null, orgId: "o", messages: [{ role: "user", content: "Build an app" }], fileData: null }) }));
    assert.equal(result.status, 200);
    if (scenario === "disconnect") { await result.body.cancel(); await new Promise(setImmediate); assert.equal(modelSignal.aborted, true); }
    else {
      const text = await result.text();
      assert.match(text, scenario === "valid" || scenario === "late-deadline" ? /"type":"done"/ : /"type":"error"/);
      if (scenario === "deadline") assert.match(text, /"code":"AI_TIMEOUT"/);
      if (scenario === "late-deadline") assert.doesNotMatch(text, /"type":"error"/);
    }
    assert.equal(saved, scenario === "valid" || scenario === "late-deadline" ? 1 : 0); assert.equal(released, 1);
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
  assert.equal(ai.ImproveRequestSchema.safeParse({ workspaceId: "w", revision: 0, userRequest: "change", fileData: app, model: "glm" }).success, true);
  assert.equal(ai.ImproveRequestSchema.safeParse({ workspaceId: "w", revision: 0, userRequest: "change", fileData: app, model: "nemotron" }).success, false);
  assert.equal(ai.ImproveRequestSchema.safeParse({ workspaceId: "w", revision: 0, userRequest: "change", fileData: app, model: "qwen" }).success, false);
  assert.equal(clerkLib.toDrevoPlan("notaproplan"), "free");
});

test("GLM resolver uses NVIDIA's exact model, endpoint and key; never falls back to the old OpenRouter key", () => {
  const calls = [];
  const env = { NVIDIA_API_KEY: "  fixture-nvidia-key  ", OPENROUTER_API_KEY: "old-unused-key" };
  const glm = load("app/api/improve/models/glm.ts", { "@ai-sdk/openai-compatible": {
    createOpenAICompatible: (settings) => (modelId) => { calls.push({ ...settings, modelId }); return { modelId }; },
  } }, { process: { env } });
  const modelId = "z-ai/glm-5.3-flash";
  const models = load("app/api/improve/models/index.ts", {
    "./glm": glm, "./gemini": { resolveGeminiModel: () => ({ short: "Gemini" }) }, "./atria": { resolveAtriaModel: () => ({ short: "Atria" }) },
  });
  const selected = models.resolveImproveModel("glm");
  assert.equal(selected.short, "GLM");
  assert.equal(selected.model.modelId, modelId);
  assert.match(selected.label, /GLM-5.3-Flash.*NVIDIA/);
  assert.equal(calls[0].apiKey, "fixture-nvidia-key");
  assert.equal(calls[0].baseURL, "https://integrate.api.nvidia.com/v1");
  assert.equal(calls[0].name, "NVIDIA");
  assert.equal(calls[0].modelId, modelId);
  const body = { model: modelId, tools: [{ type: "function" }], stream: true };
  assert.deepEqual(plain(calls[0].transformRequestBody(body)), { ...body, max_tokens: 16384, reasoning_effort: "low", chat_template_kwargs: { clear_thinking: true } });
  assert.equal(calls[0].transformRequestBody({ ...body, max_tokens: 512 }).max_tokens, 512);
  assert.equal(body.max_tokens, undefined); // adapter does not mutate SDK state
  assert.equal(models.resolveImproveModel("gemini").short, "Gemini");
  assert.equal(models.resolveImproveModel("atria").short, "Atria");
  for (const key of [undefined, "", "  "]) {
    env.NVIDIA_API_KEY = key;
    assert.throws(() => models.resolveImproveModel("glm"), /GLM_NOT_CONFIGURED/);
  }
  assert.equal(calls.length, 1);
  const response = models.notConfiguredResponse("glm");
  assert.equal(response.code, "GLM_NOT_CONFIGURED");
  assert.match(response.message, /GLM-5.3-Flash.*NVIDIA_API_KEY/);
  const errors = load("app/api/improve/errors.ts");
  const quota = errors.quotaErrorPayload({ statusCode: 429 }, selected.short);
  assert.match(quota.message, /GLM rate limit.*switch to Gemini/);
});

test("improve route honors GLM selection without charging for a missing key, rejected key or no-op", async () => {
  for (const scenario of ["missing-key", "rejected-key", "no-op"]) {
    const missingKey = scenario === "missing-key";
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
        resolveImproveModel: (selection) => { selections.push(selection); if (missingKey) throw new Error("GLM_NOT_CONFIGURED"); return { short: "GLM", label: "GLM-5.3-Flash (NVIDIA)", model: {} }; },
        notConfiguredResponse: () => ({ code: "GLM_NOT_CONFIGURED", message: "Add NVIDIA_API_KEY to enable GLM-5.3-Flash." }),
      },
      "./agent-tools": { createImproveTools: () => ({}) },
      "./agent-prompts": load("app/api/improve/agent-prompts.ts"),
      "./agent-finish": { createFinishRun: () => async () => saved++, diffPaths: () => [] },
      "./agent-run": { runAgentWithRetries: async () => { runs++; if (scenario === "rejected-key") throw Object.assign(new Error("Invalid API key: fixture-private-key"), { statusCode: 401 }); return { steps: [{ toolCalls: [{ toolName: "done_improving" }] }], finalText: "NO_OP: No changes needed.", streamError: null }; } },
    }, { process: { env: {} } });
    const response = await route.POST(new Request("https://example.com/api/improve", { method: "POST", body: JSON.stringify({ workspaceId: "w", revision: 0, userRequest: "Explain this app without changing it", fileData: app, model: "glm" }) }));
    assert.deepEqual(selections, ["glm"]);
    assert.equal(response.status, missingKey ? 400 : 200);
    if (missingKey) assert.equal((await response.json()).code, "GLM_NOT_CONFIGURED");
    else if (scenario === "rejected-key") {
      const text = await response.text();
      assert.match(text, /"type":"error".*No credits were deducted/);
      assert.doesNotMatch(text, /fixture-private-key/);
    }
    else assert.match(await response.text(), /"type":"done".*"creditsRemaining":2/);
    assert.equal(runs, missingKey ? 0 : 1); assert.equal(released, missingKey ? 0 : 1); assert.equal(saved, 0);
  }
});

test("GLM runs update and completion tools through the actual AI SDK with mocked NVIDIA SSE", async () => {
  const ai = await import("ai");
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const requests = [];
  const updatedCode = "export default function App() { return 'Updated by GLM'; }";
  const glm = load("app/api/improve/models/glm.ts", { "@ai-sdk/openai-compatible": {
    createOpenAICompatible: (settings) => createOpenAICompatible({ ...settings, fetch: async (url, options) => {
      assert.equal(url, "https://integrate.api.nvidia.com/v1/chat/completions");
      assert.equal(new Headers(options.headers).get("authorization"), "Bearer fixture-not-a-real-key");
      const body = JSON.parse(options.body);
      requests.push(body);
      assert.equal(body.model, "z-ai/glm-5.3-flash");
      assert.equal(body.tool_choice, "required");
      assert.equal(body.max_tokens, 16384);
      assert.equal(body.reasoning_effort, "low");
      assert.deepEqual(body.chat_template_kwargs, { clear_thinking: true });
      const first = requests.length === 1;
      const args = first ? { path: "/App.js", code: updatedCode, reason: "Update heading" } : { summary: "Updated heading." };
      const chunk = { id: "fixture-completion", object: "chat.completion.chunk", created: 1, model: body.model,
        choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: first ? "update_file" : "done_improving", arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    } }),
  } }, { process: { env: { NVIDIA_API_KEY: "fixture-not-a-real-key" } } });
  const state = { files: plain(app.files), dependencies: {}, setSummary: (value) => { state.summary = value; } };
  const factory = load("app/api/improve/agent-tools.ts", { ai, zod: require("zod"), "@/lib/validation": validation });
  const errors = load("app/api/improve/errors.ts");
  const engine = load("app/api/improve/agent-run.ts", { ai, "./errors": errors });
  const selected = glm.resolveGlmModel();
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

test("chat selector displays GLM via NVIDIA without obsolete OpenRouter budget props or quota claims", () => {
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
  const props = { messages: [], statusLog: [], credits: 2, workspaceId: "w", orgId: "o", appTitle: "Fixture", isGenerating: false, isImproving: false };
  for (const editModel of ["gemini", "glm", "atria"]) {
    const html = renderToStaticMarkup(React.createElement(ChatPanel, { ...props, editModel }));
    assert.match(html, /GLM-5.3-Flash via NVIDIA API Catalog/);
    assert.match(html, />GLM-5.3 Flash<\/button>/);
    assert.doesNotMatch(html, /Nemotron|OpenRouter|Qwen|left today|resets UTC midnight/);
    if (editModel === "glm") assert.match(html, /NVIDIA-hosted model — provider limits apply/);
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

test("a GLM model deadline after a completed SDK tool update saves history/files/one credit and sends a partial done", async () => {
  const sdk = await import("ai");
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const modelDeadline = new AbortController(), hardDeadline = new AbortController();
  const timeouts = [];
  const timeoutReason = new DOMException("Fixture model deadline", "TimeoutError");
  const updatedCode = "export default function App() { return 'Saved before the deadline'; }";
  let requests = 0, released = 0;
  const glm = load("app/api/improve/models/glm.ts", { "@ai-sdk/openai-compatible": {
    createOpenAICompatible: (settings) => createOpenAICompatible({ ...settings, fetch: async () => {
      requests++;
      if (requests === 2) { modelDeadline.abort(timeoutReason); throw timeoutReason; }
      const chunk = { id: "fixture-deadline", object: "chat.completion.chunk", created: 1, model: "z-ai/glm-5.3-flash",
        choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "completed_update", type: "function", function: { name: "update_file", arguments: JSON.stringify({ path: "/App.js", code: updatedCode, reason: "Update heading" }) } }] }, finish_reason: "tool_calls" }],
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    } }),
  } }, { process: { env: { NVIDIA_API_KEY: "fixture-not-a-real-key" } } });
  const errors = load("app/api/improve/errors.ts");
  const saver = saveFixture();
  const db = { user: { findUnique: async () => ({ id: "u", memberships: [{ role: "MEMBER", organization: { id: "o", credits: 2 } }] }) },
    workspace: { findUnique: async () => ({ organizationId: "o", revision: 0 }) }, organization: { findUnique: async () => ({ credits: 2 }) } };
  const finish = load("app/api/improve/agent-finish.ts", { "@/lib/workspace-save": { saveAiWorkspace: (args) => { assert.equal(args.signal.aborted, false); return saver.save(args); } }, "@/lib/ai-request": aiModule() });
  const route = load("app/api/improve/route.ts", {
    "@clerk/nextjs/server": { auth: async () => ({ userId: "user_fixture" }) }, "next/server": {}, "@/lib/prisma": { db }, "@/lib/constants": { CREDIT_COST_PER_GENERATION: 1 },
    "@/lib/ai-request": { ...aiModule(), acquireAiLease: async () => async () => { released++; hardDeadline.abort(timeoutReason); } },
    "./models": { resolveImproveModel: () => glm.resolveGlmModel() }, "./errors": errors,
    "./agent-tools": load("app/api/improve/agent-tools.ts", { ai: sdk, zod: require("zod"), "@/lib/validation": validation }),
    "./agent-prompts": load("app/api/improve/agent-prompts.ts"), "./agent-finish": finish,
    "./agent-run": load("app/api/improve/agent-run.ts", { ai: sdk, "./errors": errors }),
  }, { process: { env: {} }, AbortSignal: { any: (signals) => AbortSignal.any(signals), timeout: (ms) => { timeouts.push(ms); return ms === 240000 ? modelDeadline.signal : hardDeadline.signal; } } });
  const response = await route.POST(new Request("https://example.com/api/improve", { method: "POST", body: JSON.stringify({ workspaceId: "w", revision: 0, userRequest: "Update the heading", fileData: app, model: "glm" }) }));
  const text = await response.text();
  const events = text.trim().split("\n\n").map((frame) => JSON.parse(frame.slice(6)));
  assert.deepEqual(timeouts, [290000, 240000]);
  assert.equal(requests, 2); assert.equal(released, 1);
  assert.equal(events.filter((event) => event.type === "file_patch").length, 1);
  assert.equal(events.filter((event) => event.type === "done").length, 1);
  assert.equal(events.filter((event) => event.type === "error").length, 0);
  const done = events.find((event) => event.type === "done");
  assert.equal(done.partial, true); assert.match(done.summary, /GLM reached the time limit/);
  assert.equal(done.fileData.files["/App.js"].code, updatedCode);
  assert.equal(done.revision, 1); assert.equal(done.creditsRemaining, 1);
  assert.equal(saver.state().revision, 1); assert.equal(saver.state().credits, 1);
  assert.equal(saver.state().snapshots.length, 1); assert.match(saver.state().snapshots[0].files["/App.js"].code, /Old/);
});

test("model timeouts never save empty/invalid/stale work or override Stop, disconnect, or the hard request deadline", async () => {
  for (const scenario of ["empty", "invalid", "stale", "stop", "disconnect", "hard-deadline"]) {
    const modelDeadline = new AbortController(), hardDeadline = new AbortController(), client = new AbortController();
    const reason = new DOMException("Fixture deadline", "TimeoutError");
    const saver = saveFixture({ revision: scenario === "stale" ? 1 : 0 });
    const before = structuredClone(saver.state());
    let released = 0;
    const errors = load("app/api/improve/errors.ts");
    const db = { user: { findUnique: async () => ({ id: "u", memberships: [{ role: "MEMBER", organization: { id: "o", credits: 2 } }] }) },
      workspace: { findUnique: async () => ({ organizationId: "o", revision: 0 }) }, organization: { findUnique: async () => ({ credits: 2 }) } };
    const tools = load("app/api/improve/agent-tools.ts", { ai: { tool: (value) => value }, zod: require("zod"), "@/lib/validation": validation });
    const finish = load("app/api/improve/agent-finish.ts", { "@/lib/workspace-save": { saveAiWorkspace: (args) => saver.save(args) }, "@/lib/ai-request": aiModule() });
    const route = load("app/api/improve/route.ts", {
      "@clerk/nextjs/server": { auth: async () => ({ userId: "user_fixture" }) }, "next/server": {}, "@/lib/prisma": { db }, "@/lib/constants": { CREDIT_COST_PER_GENERATION: 1 },
      "@/lib/ai-request": { ...aiModule(), acquireAiLease: async () => async () => released++ }, "./models": { resolveImproveModel: () => ({ short: "GLM", label: "GLM", model: {} }) },
      "./errors": errors, "./agent-tools": tools, "./agent-prompts": load("app/api/improve/agent-prompts.ts"), "./agent-finish": finish,
      "./agent-run": { runAgentWithRetries: async (args) => {
        if (scenario !== "empty") await args.tools.updateFileTool.execute({ path: "/App.js", code: scenario === "invalid" ? "" : "export default function App() { return 'Uncommitted'; }", reason: "Fixture change" });
        if (scenario === "disconnect") { if (!args.abortSignal.aborted) await new Promise((resolve) => args.abortSignal.addEventListener("abort", resolve, { once: true })); return null; }
        modelDeadline.abort(reason);
        if (scenario === "stop") client.abort();
        if (scenario === "hard-deadline") hardDeadline.abort(reason);
        if (args.shouldStop()) return null;
        throw new errors.MaxIterationsError("timeout");
      } },
    }, { process: { env: {} }, AbortSignal: { any: (signals) => AbortSignal.any(signals), timeout: (ms) => ms === 240000 ? modelDeadline.signal : hardDeadline.signal } });
    const response = await route.POST(new Request("https://example.com/api/improve", { method: "POST", signal: client.signal, body: JSON.stringify({ workspaceId: "w", revision: 0, userRequest: "Update the heading", fileData: app, model: "glm" }) }));
    if (scenario === "disconnect") await response.body.cancel();
    else {
      const text = await response.text();
      assert.doesNotMatch(text, /"type":"done"/);
      if (scenario !== "stop") assert.match(text, /"type":"error".*"code":"AI_TIMEOUT"/);
      if (scenario === "empty") assert.match(text, /No credits were deducted/);
      if (scenario === "hard-deadline") { assert.match(text, /Reload to check the saved project/); assert.doesNotMatch(text, /No credits were deducted/); }
    }
    await new Promise(setImmediate);
    assert.equal(released, 1, scenario); assert.deepEqual(saver.state(), before, scenario);
  }
});
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

test("model deadlines stop SDK waits/retries without resetting completed updates; client aborts remain silent", async () => {
  for (const scenario of ["before-call", "stream-end", "stream-throw", "retry-wait", "client-stop"]) {
    const controller = new AbortController();
    const reason = new DOMException("Fixture model deadline", "TimeoutError");
    const errors = load("app/api/improve/errors.ts");
    let calls = 0, resets = 0, stopped = false;
    if (scenario === "before-call") controller.abort(reason);
    const engine = load("app/api/improve/agent-run.ts", { "./errors": errors, ai: {
      stepCountIs() {}, hasToolCall() {}, streamText: () => {
        calls++;
        return { fullStream: (async function* () {
          if (scenario === "retry-wait") { yield { type: "error", error: { statusCode: 503, message: "overloaded" } }; return; }
          yield { type: "tool-call", toolName: "update_file", input: { path: "/App.js" } };
          stopped = scenario === "client-stop";
          controller.abort(reason);
          if (scenario === "stream-throw") throw reason;
        })(), get steps() { if (scenario !== "retry-wait") throw new Error("Must not wait for SDK results after a deadline"); return Promise.resolve([]); }, text: Promise.resolve("") };
      },
    } });
    const run = engine.runAgentWithRetries({ model: {}, modelLabel: "fixture", instructions: "", input: "", tools: {}, abortSignal: controller.signal,
      resetRunState: () => resets++, shouldStop: () => stopped, enqueue: (type) => { if (type === "status") controller.abort(reason); } });
    if (scenario === "client-stop") assert.equal(await run, null);
    else await assert.rejects(run, (error) => error instanceof errors.MaxIterationsError && error.reason === "timeout");
    assert.equal(calls, scenario === "before-call" ? 0 : 1);
    assert.equal(resets, calls);
  }
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
