# 02 — Architecture

## Folder structure

```
app/
  layout.tsx                    Root layout (fonts, ClerkProvider dark, Header, Toaster)
  page.tsx                      Landing page (hero prompt -> /workspace)
  globals.css
  (auth)/
    layout.tsx                  AuthLayout: centers SignIn/SignUp
    sign-in/[[...sign-in]]/page.tsx   <SignIn/>
    sign-up/[[...sign-up]]/page.tsx   <SignUp/>
  (main)/
    layout.tsx                  <div mt-16> offset for fixed Header
    workspace/page.tsx          Loads user + workspace -> WorkspaceClient
    projects/page.tsx           Lists projects
  api/
    gen-ai-code/route.ts        Generation API (Gemini)
    improve/route.ts            Agentic improve API (Cline)
actions/
  workspace.ts                  getWorkspaceUser, getWorkspaceById
  projects.ts                   getUserProjects, deleteProject
components/
  WorkspaceClient.tsx           Orchestrator: generate/improve/stop, SSE parsing
  ChatPanel.tsx                 Chat UI + image upload + credits badge
  CodePanel.tsx                 Sandpack preview/code + improve input + export zip + error banner
  Header.tsx                    Nav + credits + UserButton
  PricingModal.tsx              Billing modal + CheckoutButton
  ProjectCard.tsx               Projects grid
  DeleteProjectModal.tsx, MobileBlocker.tsx, PricingModal.tsx,
  theme-provider.tsx, reusables.tsx, ui/*, animate-ui/*
lib/
  constants.ts                  PLANS, CREDIT_COST, PRICING_PLANS (cplan_* IDs)
  data.ts                       SUGGESTIONS, FEATURES, STEPS, PLACEHOLDERS
  checkUser.ts                  Clerk->DB sync, plan/credit delta logic
  prisma.ts                     Prisma singleton
  arcjet.ts                     Route-level rate-limit + prompt-injection client
  utils.ts                      cn()
types/
  workspace.ts                  Message, FileData, StatusStep, WorkspaceData, WorkspaceUser
  project.ts, plans.ts
prisma/schema.prisma            User + Workspace models
proxy.ts                        Clerk + Arcjet middleware, protects /workspace /projects
```

## Data models (Prisma)

```prisma
model User {
  id        String @id @default(cuid())
  clerkId   String @unique
  name      String
  email     String @unique
  imageUrl  String @default("")
  credits   Int    @default(10)
  plan      String @default("free")
  workspaces Workspace[]
}
model Workspace {
  id        String @id @default(cuid())
  title     String?
  userId    String
  user      User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  messages  Json   @default("[]")   // Message[]
  fileData  Json?                   // FileData
  @@index([userId])
}
```

`Message = {role: user|assistant, content: string, imageUrl?: string}`
`FileData = {files: Record<path,{code:string}>, dependencies: Record<pkg,version>, title?: string}`

## Auth / billing model

- Clerk is source of truth for identity (`clerkId`) and plan (`has({plan: pro|starter})`).
- DB mirrors `plan + credits` via `checkUser()` on page loads (upgrade-only delta, `updateMany` race guard).
- `CREDIT_COST_PER_GENERATION = 1`, `MIN_CREDITS_TO_GENERATE = 1`.
- Both AI routes require credits (402 otherwise, 1 credit each, all plans). No Pro gate on agent edits.
- Checkout uses `CheckoutButton planId={cplan_*} planPeriod="month"`. Plan IDs must exist in the same Clerk app/env (test vs live) or API returns `plan_not_found`.

## Env

```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in, SIGN_UP_URL=/sign-up
DATABASE_URL (pooler 6543), DIRECT_URL (5432)
ARCJET_KEY, GEMINI_API_KEY
NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY
```

## Runtime

- `runtime = nodejs`, `maxDuration = 300` on both AI routes.
- SSE via `ReadableStream`: `data: {type,...}\n\n`, headers `text/event-stream, no-cache, keep-alive`.
- Safe-SSE pattern: `closed` flag + `safeEnqueue/safeClose` + `request.signal abort` listener (prevents `Controller is already closed`).
