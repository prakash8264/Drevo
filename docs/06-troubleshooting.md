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
- Quota: `generativelanguage...generate_content_free_tier_requests limit 20, model gemini-3.5-flash`. `improve` uses up to 5 iterations per click.
- Stream crash: unsafe `controller.enqueue/close` double-close + abort-during-stream.
Fixes applied:
- `safeEnqueue/safeClose` + `closed` flag + `request.signal abort` in both routes; removed early `close()` before `return`.
- `isQuotaError/quotaErrorPayload` -> friendly `error{code:QUOTA_EXCEEDED,retryAfter}`; no credit deduction on failure.
- `maxIterations 8 -> 5`.
- `WorkspaceClient` split JSON-parse vs event handling (inner catch was swallowing error events), quota toasts 8–15s.
Left for you (ops): enable Gemini billing / switch model / monitor at `ai.dev/rate-limit`.
