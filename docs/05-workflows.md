# 05 — Workflows (how it works end-to-end)

## Flow A — First generation (prompt -> preview + code)

```mermaid
flowchart TD
  U[User types prompt on /] --> R{isSignedIn?}
  R-- no --> S[SignInButton modal]
  R-- yes --> W[router.push /workspace?prompt=...]
  W --> P[workspace/page.tsx: getWorkspaceUser + getWorkspaceById]
  P --> C[WorkspaceClient + ChatPanel auto onGenerate initialPrompt]
  C --> G[POST /api/gen-ai-code SSE]
  G --> GM[Gemini stream: thought->status, text->JSON]
  GM --> V[validateDependencies via npm]
  V --> DB[(Prisma: workspace upsert + credit -1)]
  DB --> SSE2[SSE done: workspaceId, fileData, credits]
  SSE2 --> SP[CodePanel SandpackProvider: Preview + Code]
```

How preview works: `CodePanel` builds `files = fileData.files ?? PLACEHOLDER_FILES`, `dependencies = BASE + AI`, `key = sorted paths`. `SandpackProvider template=react` compiles in browser. Content updates go via `sandpack.updateFile(path,code)` diff — no remount unless path set changes. Tailwind via CDN external resource, recompile delayed 500ms.

How code view works: same provider, `SandpackFileExplorer` + `SandpackCodeEditor readOnly` tabs. `keepMounted` both tabs.

## Flow B — Iterate via chat (first prompt only, no files yet)

Same as A: `buildContents` includes history (trimmed `first+last8`). No `fileData` exists yet, so AI returns **all** files. Workspace `create` stores messages + fileData. After this, follow-ups use Flow C.

## Flow C — Follow-up chat via Agent (all plans, hybrid)

```mermaid
flowchart TD
  B[2nd+ chat prompt, screenshot, or Fix with AI] --> A[POST /api/improve: Cline Agent maxIterations 12]
  A --> T1[update_file tool -> SSE file_patch]
  A --> T3[add_dependency tool -> npm validated]
  A --> T2[done_improving tool -> completesRun]
  T2 --> DB[(Save messages + fileData + credit -1)]
  DB --> UI[Apply fileData at once + summary replaces thinking]
```

Routing lives in `WorkspaceClient`: no workspace/files yet -> Flow A/B (one-shot JSON); otherwise -> this flow. No separate Improve button. Patches apply at `done` to avoid Sandpack remounts mid-stream. If the step budget runs out after files changed, completed updates are kept (partial `done`, 1 credit, "ask to continue"); if nothing changed, a free friendly error is sent.

## Flow D — Preview error -> Fix with AI

`SandpackInner listen(show-error|compile)` -> `previewError` banner (preview tab only) -> `Fix with AI` -> `handleFixError(error)` -> agent patch path (Flow C) when files exist, else generation.

## Flow E — Projects / persistence

`/projects` -> `getUserProjects` -> cards with `firstPrompt`, `messageCount`, `updatedAt` time-ago. Click -> `/workspace?id=` -> `getWorkspaceById` loads messages + fileData into `WorkspaceClient` initial state. Delete -> `deleteProject` + revalidate.

## Flow F — Auth / billing / credits

`proxy.ts` redirects anon from `/workspace|/projects` to sign-in. `Header checkUser()` creates (10 free credits) or syncs plan delta on upgrade. `PricingModal`/`page.tsx` pricing -> `CheckoutButton planId` -> Clerk checkout drawer -> Stripe. Both AI routes 402 gate no-credits (1 credit each, all plans). Credits only decremented inside success transaction.

## Flow G — Export ZIP

`handleExportZip`: zips `buildProjectFiles()` output (package.json react 18 + deps, public/index.html + tailwind CDN, `src/<path>` files, `src/index.js` StrictMode mount, README, `.gitignore`, `.env.example`), downloads `exportZipName(appTitle)`. Same map the GitHub push sends — the two cannot drift.

## Flow H — GitHub connect (OAuth)

```mermaid
flowchart TD
  B[GitHub button → dialog] --> NC{connected?}
  NC-- no --> C[Connect with GitHub → GET /api/github/connect]
  C --> G[github.com authorize: repo + read:user]
  G --> CB[GET /api/github/callback: state check → token exchange → GET /user]
  CB --> DB[(Store encrypted token + username)]
  DB --> W[302 /workspace?github=connected → dialog auto-opens]
  W --> S[GET /api/github/status refreshes state]
```

Full navigation (not `router.push`) because the endpoint 302-redirects to
`github.com`. Token encrypted (AES-256-GCM) at rest, never sent to the
browser. Disconnect nulls the columns; pushed repos are untouched.
Deep dive: [07](./07-github-integration.md).

## Flow I — Push to GitHub (create new repo)

```mermaid
flowchart TD
  D[Dialog: name + Private/Public + message] --> P[POST /api/github/push mode create]
  P --> V[Guards + buildProjectFilesFromFileData from DB]
  V --> R[POST /user/repos auto_init false]
  R --> S[PUT contents README.md on main — seeds first commit]
  S --> H[GET ref must equal seed]
  H --> B[POST git/blobs → trees base HEAD → commit parents HEAD]
  B --> U[PATCH ref non-forced → save link + pushedFiles]
  U --> G[Green box + View on GitHub]
```

Why the seed step: the git-database blob endpoint answers `409 "Git
Repository is empty."` on zero-commit repos. Ref moves last and
non-forced, so history is never partially updated. Name collision (422) →
409 "already exists". Failures after creation return
`REPO_CREATED_PUSH_FAILED` + URL → amber box with repo link and
retry-into-repo.

## Flow J — Push to existing repo + one-click Update

```mermaid
flowchart TD
  E[Existing tab: search → pick repo → branch dropdown → push] --> O{owner == you?}
  O-- no --> F[403]
  O-- yes --> BR{branch exists?}
  BR-- no --> NB[Create from default HEAD, or seed if repo empty]
  BR-- yes --> HB[Read HEAD]
  NB --> HB
  HB --> EQ{tree identical + no deletions?}
  EQ-- yes --> NC[unchanged: true, no commit]
  EQ-- no --> C[Overlay tree + deletions → commit → non-forced ref move]
  C --> DV{moved underneath?}
  DV-- yes --> D409[409 BRANCH_DIVERGED, nothing overwritten]
  DV-- no --> OK[Saved + pushedFiles snapshot]
```

Unrelated repo files survive via `base_tree`; Drevo-removed files are
deleted via the `githubPushedFiles` snapshot. The toolbar **Update**
button runs the same path against the linked repo with
`"Update from Drevo"` (disabled while busy / no files). Deep dive: 07.

## Flow K — Realtime credits (optimistic)

```mermaid
flowchart TD
  S[Submit prompt] --> O[credits -1 instantly in header + chat, bus emit]
  O --> R{SSE result?}
  R-- done --> A[Authoritative creditsRemaining applied]
  R-- 402/403/429/error/abort/quota --> RB[Refund +1, bus emit]
```

Billing truth stays the DB transaction; the bus (`credits-bus`) is
display-only. Server Header never re-renders client-side — the
`HeaderCredits` island bridges the gap.

## SSE event contract

- `status {message}` — thinking label / Validating / Saving.
- `thinking {text}` (improve only) — agent reasoning deltas.
- `file_patch {path, code, reason}` (improve only).
- `done {workspaceId?, fileData, creditsRemaining, assistantMessage?|summary?, partial?}`.
- `done {…, unchanged: true}` (GitHub push only) — no commit needed.
- `error {message, code?: QUOTA_EXCEEDED | MAX_ITERATIONS, retryAfter?}` — never deducts credits.
- Push error codes: `GITHUB_NOT_CONNECTED | GITHUB_TOKEN_INVALID` (401),
  `REPO_CREATED_PUSH_FAILED` (500 + repoUrl), `BRANCH_DIVERGED` (409).
