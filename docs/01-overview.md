# 01 — Overview

## What this project is

**Forge** is a prompt-to-website builder:

1. User types a prompt like `Build a kanban board with drag and drop` (optionally attaches a screenshot).
2. AI generates a complete React + Tailwind app (multiple files + npm dependencies) as JSON.
3. The app renders instantly in a live browser preview (Sandpack) with a code viewer.
4. User keeps chatting to iterate — follow-up prompts (and **Fix with AI**) go through the agent as patch edits for all plans — or clicks **Fix with AI** when the preview throws.
5. User can save workspaces, browse `/projects`, and download any app as a ZIP.

## Features

- Instant generation (Gemini 3.5 Flash, JSON mode).
- Live preview, no install/build step (Sandpack).
- Full source viewer + in-preview file explorer.
- Smart packages: AI picks deps, server validates against npm registry.
- AI error recovery: preview runtime error -> one-click fix.
- Image-aware prompts: Supabase Storage public URL passed to Gemini.
- Credits + plans (Free 10 / Starter 50 / Pro 150), Clerk Billing checkout.
- Workspaces persisted (messages + fileData JSON).

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16.3.4 (Turbopack), React 19.2.8 |
| Auth/Billing | `@clerk/nextjs@7`, `@clerk/themes` (dark), `CheckoutButton` experimental |
| AI generate | `@google/genai`, model `gemini-3.5-flash`, `generateContentStream`, `responseMimeType: application/json`, `thinkingConfig.includeThoughts` |
| AI edit (2nd+ prompt) | `@cline/sdk` `Agent({providerId: gemini, maxIterations: 5})`, tools `update_file` + `add_dependency` + `done_improving`, all plans |
| Preview/Code | `@codesandbox/sandpack-react`, `@codesandbox/sandpack-themes` (dracula), template `react`, CDN `tailwindcss` |
| DB | Prisma 7 + `@prisma/adapter-pg`, Postgres via Supabase pooler, custom output `lib/generated/prisma` |
| Images | `@supabase/supabase-js`, bucket `workspace-images` |
| Security | `@arcjet/next` shield + detectBot (proxy) + tokenBucket/prompt-injection (route client, partly disabled) |
| Styling/UI | Tailwind 4, shadcn/ui, `next-themes`, `lucide-react`, `sonner`, `react-markdown`, `react-spinners`, `motion` |
| Export | `jszip` |
| Validation | `zod` (Cline tool schemas) |

## High-level mental model

```
Prompt (page.tsx / ChatPanel)
  -> POST /api/gen-ai-code (Gemini JSON stream, SSE: status/done/error)
  -> WorkspaceClient state {messages, fileData, credits}
  -> CodePanel SandpackProvider (preview + code)
  -> Iterate via ChatPanel: 1st prompt POST /api/gen-ai-code, follow-ups POST /api/improve (Cline agent, patch-only)
  -> Persisted in Prisma Workspace, gated by credits/plan
```
