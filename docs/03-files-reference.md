# 03 — Files reference (which file does what)

## `app/layout.tsx`
Root layout. Loads `DM_Sans` + `Lora` fonts, `globals.css`, wraps in `ClerkProvider appearance={{theme: dark}}` (`@clerk/themes`), renders `Header`, `ThemeProvider`, `Toaster`. Metadata title `Drevo � Dream it. Develop it.`.

## `app/page.tsx` (client landing)
Hero with `HoleBackground`, rotating `PLACEHOLDERS`, prompt textarea (auto-resize to 200px), suggestion chips, Generate button. If signed in -> `router.push(/workspace?prompt=)`, else `SignInButton modal`. Below: browser mockup, `FEATURES` grid, `STEPS` timeline, `PRICING_PLANS` grid with `CheckoutButton`, CTA + footer.

## `app/(auth)/layout.tsx`
`AuthLayout({children})` -> centered flex container with `pt-16`. Only purpose is to center Clerk forms. (Previously a duplicated server-actions file with no default export — caused `default export is not a React Component`.)

## `app/(auth)/sign-in/[[...sign-in]]/page.tsx`, `sign-up/.../page.tsx`
Thin wrappers returning `<SignIn/>` / `<SignUp/>`. Catch-all `[[...]]` lets Clerk handle sub-routes.

## `app/(main)/layout.tsx`
`layout({children}) => <div mt-16>{children}</div>`. Offsets fixed `Header h-16`.

## `app/(main)/workspace/page.tsx`
Server. Reads `searchParams {prompt?, id?}`, calls `getWorkspaceUser()`, optional `getWorkspaceById(id,user.id)`, renders `WorkspaceClient{initialPrompt, workspace, userCredits, userId}`.

## `app/(main)/projects/page.tsx`
Server. `auth()` guard -> `getUserProjects()` -> header + `EmptyState` (no projects) or `ProjectCard` grid.

## `app/api/gen-ai-code/route.ts`
Generation API. See functions doc. Uses `GoogleGenAI`, `SYSTEM_PROMPT` (strict JSON shape), `buildContents`, `validateDependencies`, SSE `status/done/error`, Prisma transaction (workspace upsert + credit decrement).

## `app/api/improve/route.ts`
Agentic edit API for follow-up chat prompts (all plans). Uses Cline `Agent` + `update_file` / `add_dependency` / `done_improving` tools, streams `thinking/file_patch/done/error`, saves `messages + FileData` + decrements credit only on success.

## `actions/workspace.ts`
`getWorkspaceUser()`, `getWorkspaceById()`. Server-only DB reads with `redirect("/")` guards.

## `actions/projects.ts`
`getUserProjects()` maps workspaces to `{id,title,firstPrompt (first user msg slice 120),createdAt,updatedAt,messageCount}`. `deleteProject()` via `deleteMany({id,userId})` + `revalidatePath("/projects")`.

## `components/WorkspaceClient.tsx`
Client orchestrator. Holds `workspaceId, messages, fileData, credits, isGenerating/isImproving, statusLog`, `AbortController` refs + `messages/workspaceId/fileData` refs to avoid stale closures. Hybrid routing: no workspace/files yet -> `handleGenerate` (one-shot JSON); otherwise -> `handleImprove` (agent patch). Exposes `onGenerate/onFixError/handleStop` to children. Also owns version history (`versions`, `refreshVersions`, `handleRestoreVersion` via `actions/versions`), `handleRegenerate` (re-run last user msg, `appendUser:false`) + `handleEditMessage` (truncate + resubmit), resizable chat (`chatWidth` 240–560px, `localStorage drevo:chat-width`, pointer-drag divider), `focusMode` toggle.

## `components/ChatPanel.tsx`
Left panel (resizable width, default 320px). Props: messages, isGenerating/isImproving, statusLog, credits, initialPrompt, onGenerate/onRegenerate/onEditMessage/onStop. Features: auto-resize textarea, auto-scroll, auto-submit `initialPrompt` once, Supabase image upload (`workspace-images`), credit badge via `PricingModal`, markdown rendering (`ReactMarkdown`), live `thinking` bubble during improve, no-credits upgrade banner. Chat tools: copy buttons (assistant bubbles), Regenerate last response (1 credit), edit-and-resend user messages (truncate + re-run through hybrid router).

## `components/CodePanel.tsx`
Right panel. Outer `CodePanel` creates `SandpackProvider key=filePathKey (paths only, not contents)` with `template=react`, `dracula`, `files ?? PLACEHOLDER_FILES`, `dependencies=BASE+AI`, `externalResources tailwind CDN`, `recompileMode delayed 500ms`, plus `device` state (desktop/mobile). Inner `SandpackInner` (inside provider, uses `useSandpack()`): pushes diffs via `sandpack.updateFile` (no remount), listens for `show-error/compile/success` -> `previewError` banner, tabs Preview/Code (`SandpackPreview`, `FileExplorer`, `CodeEditor readOnly`). Progress: full overlay only for first-gen (`!fileData`); slim top status bar for edits on existing apps (non-blocking). Version history dropdown (clock, count badge, time-ago + file count + Restore, free + undoable, Esc to close). Device toggle (desktop / mobile-390px centered wrapper). Focus-mode button (hide chat). `handleExportZip` (JSZip package.json + index.html + src/* + index.js + README), `Fix with AI` button -> `onFixError` (agent patch when files exist).

## `actions/versions.ts` + `types/version.ts` + `WorkspaceVersion` model
Version history backend. `WorkspaceVersion { id, workspaceId cascade, fileData Json, summary?, createdAt }`, cap 20 per workspace (`pruneVersions`). `getVersions` (ownership-checked, newest-first summaries with file counts, no payloads), `restoreVersion` (snapshots current as "Before restore" first so restore is undoable, free, no credits). Both AI routes snapshot pre-run `fileData` on success.

## `components/Header.tsx` (async server)
Calls `checkUser()`, renders fixed nav: logo, Projects link (signed-in), credits pill (PricingModal), `UserButton` / `SignInButton`s.

## `components/PricingModal.tsx`
Billing modal. Computes `activePlanKey` via `has({plan})`, renders `PRICING_PLANS` cards, CTA logic: active->disabled, free->sign-in/default, paid+signed-in->`CheckoutButton`.

## `components/ProjectCard.tsx`, `DeleteProjectModal.tsx`, `MobileBlocker.tsx`, `reusables.tsx`, `theme-provider.tsx`, `ui/*`
Project grid + time-ago (`date-fns`), delete confirm, mobile-only blocker (`md:hidden` counterpart to workspace `hidden md:flex`), shared titles/headings, next-themes provider, shadcn primitives.

## `lib/constants.ts`, `lib/data.ts`, `lib/checkUser.ts`, `lib/prisma.ts`, `lib/arcjet.ts`, `lib/utils.ts`
Constants/pricing, landing copy, Clerk->DB sync, Prisma singleton, Arcjet client, `cn()` class merger. See functions doc.

## `proxy.ts`, `next.config.ts`, `prisma/schema.prisma`
Middleware (Arcjet shield/bot + Clerk protected routes), Next config (`serverExternalPackages` for Cline), DB schema. See architecture doc.
