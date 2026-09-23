# 03 — Files reference (which file does what)

## `app/layout.tsx`
Root layout. Loads `DM_Sans` + `Lora` fonts, `globals.css`, wraps in
`ClerkProvider appearance={{theme: dark}}` (`@clerk/themes`), renders
`Header`, `ThemeProvider`, `Toaster`. Metadata title
`Drevo — Dream it. Develop it.`, favicon `/favicon.svg`.

## `app/page.tsx` (client landing)
Hero with `HoleBackground`, rotating `PLACEHOLDERS`, prompt textarea
(auto-resize to 200px), suggestion chips, Generate button. If signed in →
`router.push(/workspace?prompt=)`, else `SignInButton modal`. Below:
browser mockup, `FEATURES` grid, `STEPS` timeline, `PRICING_PLANS` grid
with `CheckoutButton`, CTA + footer (footer logo = `LogoMark`).

## `app/(auth)/layout.tsx`
`AuthLayout({children})` → centered flex container with `pt-16`. Only
purpose is to center Clerk forms.

## `app/(auth)/sign-in/[[...sign-in]]/page.tsx`, `sign-up/.../page.tsx`
Thin wrappers returning `<SignIn/>` / `<SignUp/>`. Catch-all `[[...]]`
lets Clerk handle sub-routes.

## `app/(main)/layout.tsx`
`layout({children}) => <div mt-16>{children}</div>`. Offsets fixed
`Header h-16`.

## `app/(main)/workspace/page.tsx`
Server. Reads `searchParams {prompt?, id?}`, calls `getWorkspaceUser()`,
optional `getWorkspaceById(id, user.id)`, renders
`WorkspaceClient{initialPrompt, workspace, userCredits, userId,
githubConnected, githubUsername}`.

## `app/(main)/projects/page.tsx`
Server. `auth()` guard → `getUserProjects()` → header + `EmptyState`
(no projects) or `ProjectCard` grid.

## `app/api/gen-ai-code/route.ts`
One-shot generation API (Gemini JSON mode). Full detail in
[04-functions-reference](./04-functions-reference.md) and
[08-ai-agent-deep-dive](./08-ai-agent-deep-dive.md): guards (401/400/404/
402), `generateContentStream` with thoughts → `status` events,
JSON parse → npm validation → Prisma transaction
(workspace upsert + optional version snapshot + credit decrement) →
`done`. Arcjet invocation currently commented out.

## `app/api/improve/route.ts`
Agentic edit API for follow-up prompts (all plans). AI SDK v7 `streamText`
(`google("gemini-3.5-flash")` or OpenRouter `qwen/qwen3.8-27b:free` per the
chat toggle, `isStepCount(12)` + `hasToolCall`) with `update_file` /
`add_dependency` / `done_improving` tools; streams
`thinking/file_patch/done/error`; `finishRun()` saves messages + fileData
+ snapshot + 1 credit; partial-save path when the iteration budget runs
out after files changed. Full detail in 04 + 08.

## `app/api/github/connect/route.ts`
OAuth start. Clerk guard → random `state` + optional `workspaceId` in
httpOnly cookies → 302 to `github.com/login/oauth/authorize`
(`repo read:user`). 500 when the OAuth App env is missing.

## `app/api/github/callback/route.ts`
OAuth callback. Validates `state` (`?github=error` redirect on mismatch),
exchanges `code` for a token, fetches the GitHub user, stores the
**encrypted** token + username on `User`, redirects to
`/workspace?id=…&github=connected`.

## `app/api/github/status/route.ts`
Returns `{connected: boolean, username}` — boolean only, token never
selected. Used by the dialog after OAuth return.

## `app/api/github/disconnect/route.ts`
`DELETE` nulls the four GitHub columns on `User`. Pushed repos untouched.

## `app/api/github/repos/route.ts`
Lists the user's **own** repos (`affiliation=owner`, pushed-desc, 2×100
pages) with server-side substring `search` → repo cards data. No orgs.

## `app/api/github/branches/route.ts`
`?repo=owner/name` → `{branches: [{name}]}` (100 cap). Enforces
owner == connected username; 404 maps to not-found/no-access.

## `app/api/github/push/route.ts`
Push engine, `mode: create|existing`. Shared preamble (auth, Zod,
ownership-checked workspace load, `buildProjectFilesFromFileData()`,
300-file / 8 MB caps, token decrypt). Create: `POST /user/repos` →
Contents-API README seed (empty repos reject git-db blobs) → blobs →
tree on HEAD → commit on HEAD → non-forced ref move. Existing:
owner-enforced, branch resolve/create, empty-repo seed, overlay tree with
deletions from `githubPushedFiles`, identical-content early-out
(`unchanged: true`), non-forced update with 422 → `BRANCH_DIVERGED`.
Error codes: `GITHUB_NOT_CONNECTED`, `GITHUB_TOKEN_INVALID`,
`REPO_CREATED_PUSH_FAILED`, `BRANCH_DIVERGED`. No credit deduction.
Full algorithm in [07](./07-github-integration.md).

## `actions/workspace.ts`
`getWorkspaceUser()` — `auth()` → DB user
(`id/credits/plan` + GitHub token presence/username, mapped to
`githubConnected: boolean`) else `redirect("/")`.
`getWorkspaceById(id, userId)` — ownership-checked workspace incl. GitHub
link fields (dates ISO-stringified) else redirect.

## `actions/projects.ts`
`getUserProjects()` maps workspaces to `{id, title, firstPrompt (first
user msg slice 120), createdAt, updatedAt, messageCount}`.
`deleteProject()` via `deleteMany({id, userId})` + `revalidatePath`.

## `actions/versions.ts` + `types/version.ts` + `WorkspaceVersion` model
Version history backend. Cap 20 per workspace (`pruneVersions`).
`getVersions` (ownership-checked, newest-first summaries with file
counts, no payloads). `restoreVersion` snapshots current as
`"Before restore"` first so restore is undoable — free, no credits.
Both AI routes snapshot pre-run `fileData` on success.

## `components/WorkspaceClient.tsx`
Client orchestrator. Holds `workspaceId, messages, fileData, credits,
isGenerating/isImproving, statusLog`, `AbortController` refs +
`messages/workspaceId/fileData/credits` refs against stale closures.
Hybrid routing: no workspace/files → `handleGenerate` (one-shot JSON);
otherwise → `handleImprove` (agent patch). Children get
`onGenerate/onFixError/handleStop`. Version history (`refreshVersions`,
`handleRestoreVersion`), `handleRegenerate` (re-run last user msg,
`appendUser: false`, 1 credit), `handleEditMessage` (truncate + resubmit),
resizable chat (240–560px, `localStorage drevo:chat-width`), `focusMode`.
Realtime credits: `applyCredits/decrementOptimistic/refundOptimistic/
applyAuthoritative` + `creditsRef`, emitting every change on
`credits-bus`. GitHub link state (`githubConnected/username/lastPush`)
passed to `CodePanel`.

## `components/ChatPanel.tsx`
Left panel (resizable, default 320px). Auto-submits `initialPrompt` once,
auto-resize textarea (Enter → `handleSubmit`), auto-scroll, Supabase image
upload (`workspace-images`, `userId/workspaceId|new/timestamp.ext`)
with preview thumbnail, credit badge via `PricingModal`, markdown
rendering, live `thinking` bubble during improve, no-credits banner, copy
buttons, Regenerate (1 credit), edit-and-resend (truncate + re-run),
assistant avatar = `LogoMark sm`.

## `components/CodePanel.tsx`
Right panel. Outer `CodePanel` creates `SandpackProvider key=filePathKey
(paths only)` with `template=react`, `files ?? PLACEHOLDER_FILES`,
`dependencies = BASE_DEPENDENCIES + AI`, Tailwind CDN,
`recompileMode delayed 500ms`, `device` state. Inner `SandpackInner`
(pushes diffs via `sandpack.updateFile`, no remount; `show-error/compile`
→ `previewError` banner + `Fix with AI`; Preview/Code tabs
`keepMounted`; first-gen overlay vs slim edit status bar; version-history
dropdown; device toggle; focus-mode button; `handleExportZip` zipping
`buildProjectFiles()`; `GithubPushDialog`; one-click `Update` button
(`handleQuickUpdate` → existing-mode push to linked repo) when `lastPush`
exists.

## `components/GithubPushDialog.tsx`
Connect + push dialog. Auto-opens on `?github=connected`, strips the param,
refreshes status. Tabs: **New** (name + Private/Public + message →
`handlePush`) / **Existing** (debounced search → repo list → branch
dropdown → `handlePushExisting`). Shared `applyResult()` handles every
server code; amber `failedRepo` box links created-but-incomplete repos with
`retryInCreatedRepo()`; green box shows last push. `GithubMark` inline SVG
(the lucide brand export doesn't exist). `DialogTrigger render=` follows
the Base-UI pattern.

## `components/Header.tsx` (async server)
Calls `checkUser()`, renders fixed nav: `LogoMark`, Projects link
(signed-in), `<HeaderCredits initial={user.credits}/>` (was inline pill +
now-removed unused imports), `UserButton` / `SignInButton`s.

## `components/HeaderCredits.tsx` (client island)
`useState(initial)` + render-time adopt on `initial` change (no
set-state-in-effect) + `subscribeCredits` listener. Renders the Zap credit
pill inside `PricingModal`.

## `components/LogoMark.tsx`
Zap logo mark (`lucide Zap`, `fill=currentColor`) in a
`border-white/10 bg-white/10` box, `size sm (h-6) | md (h-8)`. Used as
main + short logo (header, footer, chat avatars).

## `components/PricingModal.tsx`
Billing modal. `activePlanKey` via `has({plan})`, `PRICING_PLANS` cards,
CTA: active → disabled, free → sign-in/default, paid + signed-in →
`CheckoutButton`. Doubles as the click target for credit pills.

## `components/ProjectCard.tsx`, `DeleteProjectModal.tsx`, `MobileBlocker.tsx`, `reusables.tsx`, `theme-provider.tsx`, `ui/*`
Project grid + time-ago (`date-fns`), delete confirm, mobile-only blocker
(`md:hidden` counterpart to workspace `hidden md:flex`), shared
titles/headings, next-themes provider, shadcn/Base-UI primitives.

## `lib/constants.ts`, `lib/data.ts`
`PLANS` (Free 10 / Starter 50 / Pro 150), `CREDIT_COST_PER_GENERATION = 1`,
`MIN_CREDITS_TO_GENERATE = 1`, `PRICING_PLANS` (`cplan_*` IDs — must exist
in the same Clerk app/env or checkout returns `plan_not_found`); landing
copy (`SUGGESTIONS/FEATURES/STEPS/PLACEHOLDERS`).

## `lib/checkUser.ts`
Clerk → DB sync. `getCurrentPlan()` via `has({plan: pro|starter})`;
existing + plan change → upgrade-only delta via
`updateMany({clerkId, plan: old})` race guard; else existing; new →
`create({credits: PLANS.free.credits, plan: free})`.

## `lib/prisma.ts`, `lib/utils.ts`
Prisma singleton (`PrismaPg` adapter, `DATABASE_URL`, dev global cache,
custom output `lib/generated/prisma`); `cn()` class merger.

## `lib/arcjet.ts`
Route-level client: per-`userId` token bucket (5/60s) + prompt-injection
detection (LIVE). Note: invocation in `gen-ai-code` is currently commented
out; `sensitiveInfo` import is unused (rule commented).

## `lib/export-project.ts`
Shared export builder: `buildProjectFiles()` / `buildProjectFilesFromFileData()`
(package.json CRA 5 + merged deps, index.html, `src/*`, `src/index.js`,
README, `.gitignore`, `.env.example`), `exportZipName()`,
`BASE_DEPENDENCIES`, `GITIGNORE_CONTENT`, `ENV_EXAMPLE_CONTENT`.
Feeds ZIP + GitHub push so they cannot drift.

## `lib/github.ts`
AES-256-GCM `encryptToken/decryptToken` (SHA-256-normalized key,
`iv|tag|ciphertext` base64), `validateRepoName`, `validateBranchName`,
`parseRepoFullName`, OAuth constants + `getGithubClientId/
getGithubRedirectUri/buildAuthorizeUrl/newOAuthState`.

## `lib/github-server.ts`
Server-only: `GithubRouteError(status, code)`, `getGithubContext(clerkId)`
→ `{userId, username, octokit}` (token never leaves), `githubErrorResponse()`
maps auth errors → `GITHUB_TOKEN_INVALID`, else 500.

## `lib/github-push-client.ts`
Client API wrapper: `pushToGithub()` (uniform ok/error incl. `unchanged`),
`listGithubRepos(search)`, `listGithubBranches(fullName)`. Used by the
dialog and the Update button identically.

## `lib/credits-bus.ts`
`emitCredits(n)` / `subscribeCredits(cb)` over
`CustomEvent("drevo:credits")`. Display-only sync between
`WorkspaceClient` and `HeaderCredits`.

## `proxy.ts`, `next.config.ts`, `prisma/*`, `public/favicon.svg`
Middleware (Arcjet shield/bot LIVE + Clerk guard redirecting anon from
`/workspace|/projects`); Next config; schema + migrations
(`create_models`, `add_github_push`, `add_github_pushed_files`); Zap-mark
SVG favicon (replaced `logo.svg`/`logo-short.png`).
