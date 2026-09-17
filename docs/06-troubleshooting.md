# 06 — Troubleshooting (errors seen + fixes applied)

## 1. `Module not found: Can't resolve '@clerk/themes'` — `app/layout.tsx:6`
Cause: `import {dark} from "@clerk/themes"` but package not in `package.json`.
Fix: `npm install @clerk/themes` (now `^2.4.57`).

## 2. `The default export is not a React Component in /sign-in/[[...sign-in]]/layout`
Cause: `app/(auth)/layout.tsx` contained `"use server"` + `getWorkspaceUser/getWorkspaceById` with no default export (duplicate of `actions/workspace.ts`). Next treats it as layout for all `(auth)` routes.
Fix: replaced with `AuthLayout({children})` centered container. Kept `actions/workspace.ts` as source of truth.

## 3. Missing `date-fns`, `@google/genai` build errors
`ProjectCard.tsx` needs `date-fns`, `gen-ai-code/route.ts` needs `@google/genai`.
Fix: `npm install @google/genai date-fns`. Build now passes.

## 4. `Plan not found (plan_not_found)` on Upgrade
Clerk Billing checkout with `cplan_*` IDs from tutorial that don't exist in your Clerk app/env (`pk_test`).
Fix: create Starter/Pro plans in Clerk Dashboard (same app/env), copy real `cplan_*` into `lib/constants.ts:40,55`, ensure `has({plan})` slugs match, connect Stripe test gateway.

## 5. `POST /api/improve` quota + `Controller is already closed`
- Quota: `generativelanguage...generate_content_free_tier_requests limit 20, model gemini-3.5-flash`. `improve` uses up to 12 iterations per click.
- Stream crash: unsafe `controller.enqueue/close` double-close + abort-during-stream.
Fixes applied:
- `safeEnqueue/safeClose` + `closed` flag + `request.signal abort` in both routes; removed early `close()` before `return`.
- `isQuotaError/quotaErrorPayload` -> friendly `error{code:QUOTA_EXCEEDED,retryAfter}`; no credit deduction on failure.
- `maxIterations 8 -> 5 -> 12` (final: 12 turns, early stop via `done_improving`).
- `WorkspaceClient` split JSON-parse vs event handling (inner catch was swallowing error events), quota toasts 8–15s.
Left for you (ops): enable Gemini billing / switch model / monitor at `ai.dev/rate-limit`.

## 6. GitHub push creates empty repo — `409 "Git Repository is empty."`
`[github/push] failed: HttpError ... POST .../git/blobs → 409`, dialog sat
without a toast (request ran ~21 s through retries). Cause: the git-database
blob endpoint rejects repos with zero commits, and our flow did
blobs → tree → commit → ref. Fix: seed the initial commit via the Contents
API (`PUT contents README.md`, which creates the branch), then blobs/tree/
commit/ref-update. Stage-specific server logs (`seed commit failed` vs
`file upload failed`) plus `REPO_CREATED_PUSH_FAILED` + URL in the response
so the dialog links the created repo instead of going silent.

## 7. `Export Github doesn't exist in target module` (lucide-react)
Installed `lucide-react` removed brand icons — no `Github` export. Fix:
inline `GithubMark` SVG component in `GithubPushDialog.tsx` (same for the
`Zap` logo: `LogoMark` uses the non-brand `Zap` icon, which exists).

## 8. `the name BASE_DEPENDENCIES is defined multiple times` (CodePanel)
Happened mid-refactor: the shared-builder import landed while the local
const still existed (dev-server Turbopack surfaced the intermediate save).
Fix: local const deleted; `CodePanel` imports `BASE_DEPENDENCIES` from
`lib/export-project.ts`. Restart `npm run dev` to clear stale overlay.

## 9. Chat-width hydration mismatch (`github=connected` return)
`ChatPanel` reads `localStorage drevo:chat-width` in a `useState`
initializer, so SSR (`320px`) differs from client (e.g. `537px`). Cosmetic
warning only; no action taken.

## 10. GitHub OAuth setup pitfalls
- `redirect_uri mismatch` on authorize → `GITHUB_REDIRECT_URI` must equal
  the app's callback URL character-for-character (scheme included).
- Empty `GITHUB_CLIENT_ID/SECRET` → connect returns 500 "not configured".
- Keep **"Expire user access tokens" unchecked** — Drevo stores the access
  token as-is with no refresh flow; expiring tokens break pushes.
- `POST /user/repos is deprecated` (Octokit warning, sunset Mar 2028) —
  safe to ignore.
- Retrying a failed create-push with the same name → our 409 "already
  exists": delete the empty repo, or use retry-into-repo / existing tab.
