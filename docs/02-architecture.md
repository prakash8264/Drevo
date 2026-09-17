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
    github/
      connect/route.ts          OAuth start (state cookie -> github.com)
      callback/route.ts         OAuth callback (token exchange -> store)
      status/route.ts           {connected, username} (boolean only)
      disconnect/route.ts       Clear stored GitHub token
      repos/route.ts            Own repos list (search)
      branches/route.ts         Branch list (owner-enforced)
      push/route.ts             Push create|existing (never force push)
actions/
  workspace.ts                  getWorkspaceUser, getWorkspaceById
  projects.ts                   getUserProjects, deleteProject
  versions.ts                   getVersions, restoreVersion, pruneVersions
components/
  WorkspaceClient.tsx           Orchestrator: generate/improve/stop, SSE parsing, realtime credits, GitHub state
  ChatPanel.tsx                 Chat UI + image upload + credits badge
  CodePanel.tsx                 Sandpack preview/code + Update button + export zip + GitHub dialog + error banner
  GithubPushDialog.tsx          Connect + new/existing push tabs + retry + last-push status
  Header.tsx                    Nav + LogoMark + HeaderCredits island
  HeaderCredits.tsx             Client credit pill (listens to credits bus)
  LogoMark.tsx                  Zap logo mark (sm/md)
  PricingModal.tsx              Billing modal + CheckoutButton
  ProjectCard.tsx               Projects grid
  DeleteProjectModal.tsx, MobileBlocker.tsx,
  theme-provider.tsx, reusables.tsx, ui/*, animate-ui/*
lib/
  constants.ts                  PLANS, CREDIT_COST, PRICING_PLANS (cplan_* IDs)
  data.ts                       SUGGESTIONS, FEATURES, STEPS, PLACEHOLDERS
  checkUser.ts                  Clerk->DB sync, plan/credit delta logic
  prisma.ts                     Prisma singleton
  arcjet.ts                     Route-level rate-limit + prompt-injection client (invocation currently commented out)
  utils.ts                      cn()
  export-project.ts             buildProjectFiles* (ZIP + GitHub source of truth), .gitignore/.env.example
  github.ts                     Token crypto, repo/branch validators, OAuth URL helpers
  github-server.ts              getGithubContext, GithubRouteError, githubErrorResponse
  github-push-client.ts         pushToGithub, listGithubRepos, listGithubBranches
  credits-bus.ts                emitCredits/subscribeCredits (realtime credit sync)
types/
  workspace.ts                  Message, FileData, StatusStep, WorkspaceData, WorkspaceUser (+github fields)
  project.ts, plans.ts, version.ts
prisma/
  schema.prisma                 User + Workspace + WorkspaceVersion models
  migrations/                   …_create_models, …_add_github_push, …_add_github_pushed_files
proxy.ts                        Clerk + Arcjet middleware, protects /workspace /projects
public/
  favicon.svg                   Zap mark favicon (replaced logo.svg/logo-short.png)
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
  // GitHub (token encrypted, never sent to client)
  githubAccessToken String?
  githubUsername    String?
  githubUserId      String?
  githubConnectedAt DateTime?
  workspaces Workspace[]
}
model Workspace {
  id        String @id @default(cuid())
  title     String?
  userId    String
  user      User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  messages  Json   @default("[]")   // Message[]
  fileData  Json?                   // FileData
  // GitHub link state
  githubRepoUrl      String?
  githubRepoFullName String?
  githubBranch       String?         // defaults to "main" on push
  lastPushedAt       DateTime?
  githubPushedFiles  Json?           // string[] paths from last push (deletions)
  versions  WorkspaceVersion[]
  @@index([userId])
}
model WorkspaceVersion {
  id          String    @id @default(cuid())
  workspaceId String
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  fileData    Json
  summary     String?
  createdAt   DateTime  @default(now())
  @@index([workspaceId])
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
GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_REDIRECT_URI (OAuth App; callback must match)
GITHUB_TOKEN_ENCRYPTION_KEY (AES-256-GCM key for stored GitHub tokens)
```

## Realtime credits model

`Header` is a server component (credits read once via `checkUser()`), so
the pill is a client island: `HeaderCredits initial={credits}` subscribes
to `lib/credits-bus.ts` (`CustomEvent "drevo:credits"`). `WorkspaceClient`
emits on every change: optimistic −1 on submit, authoritative
`creditsRemaining` at SSE `done`, +1 refund on 402/403/429, stream errors,
aborts, quota/invalid-JSON. Billing stays server-side (DB transaction is
the truth); the bus is display-only.

## Runtime

- `runtime = nodejs`, `maxDuration = 300` on both AI routes.
- SSE via `ReadableStream`: `data: {type,...}\n\n`, headers `text/event-stream, no-cache, keep-alive`.
- Safe-SSE pattern: `closed` flag + `safeEnqueue/safeClose` + `request.signal abort` listener (prevents `Controller is already closed`).
