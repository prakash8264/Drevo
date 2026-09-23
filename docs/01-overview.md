# 01 — Overview

## What this project is

**Drevo** is a prompt-to-website builder:

1. User types a prompt like `Build a kanban board with drag and drop` (optionally attaches a screenshot).
2. AI generates a complete React + Tailwind app (multiple files + npm dependencies) as JSON.
3. The app renders instantly in a live browser preview (Sandpack) with a code viewer.
4. User keeps chatting to iterate — follow-up prompts (and **Fix with AI**) go through the agent as patch edits for all plans, with a Gemini/Qwen toggle for the edit model — or clicks **Fix with AI** when the preview throws.
5. User can save workspaces, browse `/projects`, and download any app as a ZIP — or push it straight to GitHub (new repo, existing repo, or one-click Update).
6. Credit counts update instantly in the header and chat via optimistic updates (rollback on failure), no refresh needed.

## Features

- Instant generation (Gemini 3.5 Flash, JSON mode).
- Live preview, no install/build step (Sandpack).
- Full source viewer + in-preview file explorer.
- Smart packages: AI picks deps, server validates against npm registry.
- AI error recovery: preview runtime error -> one-click fix.
- Image-aware prompts: Supabase Storage public URL passed to Gemini.
- Credits + plans (Free 10 / Starter 50 / Pro 150), Clerk Billing checkout, realtime optimistic credit display.
- Workspaces persisted (messages + fileData JSON), version history (20 snapshots, free undoable restore).
- GitHub integration: OAuth connect, push to new/existing repo, one-click Update, divergence-safe (never force push).
- Single export source of truth: `buildProjectFiles()` feeds both ZIP download and GitHub push.

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16.3.4 (Turbopack), React 19.2.8 |
| Auth/Billing | `@clerk/nextjs@7`, `@clerk/themes` (dark), `CheckoutButton` experimental |
| AI generate | `@google/genai`, model `gemini-3.5-flash`, `generateContentStream`, `responseMimeType: application/json`, `thinkingConfig.includeThoughts` |
| AI edit (2nd+ prompt) | `ai@7` `streamText` tool loop, tools `update_file` + `add_dependency` + `done_improving`, all plans. Edit model toggle: Gemini 3.5 Flash (default) or Qwen 3.8 27B via OpenRouter (`@openrouter/ai-sdk-provider`, free). Both pinned exact (`ai 7.0.109` + `google 3.0.125` + `openrouter 3.1.0`): ai@7 core accepts model-spec v2/v3 only — floating any of the three reintroduces spec mismatches (see 06 #12). |
| Preview/Code | `@codesandbox/sandpack-react`, `@codesandbox/sandpack-themes` (dracula), template `react`, CDN `tailwindcss` |
| DB | Prisma 7 + `@prisma/adapter-pg`, Postgres via Supabase pooler, custom output `lib/generated/prisma` |
| Images | `@supabase/supabase-js`, bucket `workspace-images` |
| Security | `@arcjet/next` shield + detectBot (proxy) + tokenBucket/prompt-injection (route client, partly disabled) |
| Styling/UI | Tailwind 4, shadcn/ui, `next-themes`, `lucide-react`, `sonner`, `react-markdown`, `react-spinners`, `motion` |
| Export | `jszip`, shared `lib/export-project.ts` builder |
| GitHub | `octokit`, OAuth App (`repo read:user`), AES-256-GCM token storage |
| Validation | `zod` (agent tool schemas) |

## High-level mental model

```
Prompt (page.tsx / ChatPanel)
  -> POST /api/gen-ai-code (Gemini JSON stream, SSE: status/done/error)
  -> WorkspaceClient state {messages, fileData, credits}
  -> CodePanel SandpackProvider (preview + code)
  -> Iterate via ChatPanel: 1st prompt POST /api/gen-ai-code, follow-ups POST /api/improve (AI SDK agent, patch-only)
  -> Persisted in Prisma Workspace (+20 version snapshots), gated by credits/plan
  -> Export via buildProjectFiles(): ZIP download or GitHub push (new/existing/Update)
```

See [05-workflows](./05-workflows.md) for every flow with diagrams,
[07-github-integration](./07-github-integration.md) for GitHub in depth,
[08-ai-agent-deep-dive](./08-ai-agent-deep-dive.md) for the agent in depth.
