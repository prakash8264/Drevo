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

## 15. Qwen 429 masked by `ReferenceError: Cannot access 'streamError' before initialization`
Two stacked failures: OpenRouter throttled the free shared pool
(`limit_source: upstream_provider_shared_pool` — transient, retry succeeded
minutes later), and our catch crashed reading `streamError` declared *after*
the throwing `streamText()` call (TDZ), killing the retry loop on attempt 1
with a generic toast for a quota event. Fixes: hoist `streamError`/`sawChunks`
above the `try`; `maxRetries: 0` so our envelope is the sole retry authority
(SDK-internal retries silently tripled requests per attempt); deep
`collectErrorText` matching across `errors[]`/`lastError`/cause. Pool limits
remain (OpenRouter suggests BYOK provider keys to accumulate own limits).

## 14. Qwen toggle answers "not configured" / odd provider errors
Cause: `OPENROUTER_API_KEY` empty (toggle's Qwen path returns a clean free
`QWEN_NOT_CONFIGURED` 400 by design), or OpenRouter-side shapes (402
account-credit, `no endpoints`, gateway errors) mapped into the existing
quota/overload paths. Fix: add an OpenRouter key (free models cost $0 but
still require one); check the terminal `[improve:<label>]` attempt lines to
see which provider failed and how.

## 16. Spark integration hazards (Responses-only, stall watch, rotation)
- Wrong endpoint looks like an outage: Zen answers `/chat/completions`
  for Muse models with a generic 500 — the provider must target
  `https://opencode.ai/zen/v1/responses` via the `.responses()` interface.
  And the base URL must be `…/zen/v1` (not `…/zen/v1/responses`): the
  provider appends path `/responses` itself, doubling it otherwise.
- Reported text→tool chain stalls on free Muse models: the Spark battery
  leads with a multi-file batched edit — if it stalls, Spark ships
  disabled with findings, everything else still lands.
- Free Zen availability is time-limited and rotates without notice;
  unknown/rotated models hit the kill-switch (clean free error prompting a
  switch), never a crash. Dynamic unpublished quotas behave like the Qwen
  pool (see #15).

## 13. Partial note blames "steps" when quota/overload killed the run
Cause: mid-stream `error` parts were ignored, so any death without
`done_improving` classified as budget exhaustion — right path (kept work, 1
credit) but wrong story. Also note the free-tier daily cap surfacing here:
`GenerateRequestsPerDayPerProjectPerModel-FreeTier` = 20/day, and every
attempt (including overload retries) burns units; `RetryInfo` countdowns can
mislead on daily caps (UTC-midnight reset).

## 12. `AI_UnsupportedModelVersionError: Unsupported model version v4` on every improve call
Fix: capture `error` parts into `streamError`; `MaxIterationsError(reason,
detail?)` carries `steps|quota|overload`; partial notes and free errors name
the true cause (quota countdown parsed from detail when present).
Cause: dependency drift — top-level `ai` had floated to 6.0.280 while
`@ai-sdk/google` floated to 4.0.67 (v4-spec models), plus orphaned
`node_modules/@cline` remnants (incl. a nested `ai@7`) left behind by an
incomplete `npm uninstall`. A v4-spec model object handed to a v2-only core
throws before any network call, so all 2nd+ prompts failed deterministically.
Fix: fully remove `@cline/*` (verify `node_modules/@cline` gone from disk
and lockfile), pin exact `ai 7.0.109` + `@ai-sdk/google 3.0.125` in
`package.json` (JSON allows no comments — the pairing rule lives here), and
re-verify with `tsc` (the model-assignability error is the gate) + `build`.
Prevention: never float these two majors independently; check
`node -e` versions after any install touching AI deps.

## 11. `{"error":"Forbidden"}` on `localhost:3000`, nothing else renders
Cause: `proxy.ts` ran Arcjet (`shield` + `detectBot`, LIVE) on every request.
Arcjet has no reputation data for the loopback client IP (`127.0.0.1`), so it
denies localhost requests while the same request with a public IP passes
(verified: browser-UA curl → 403, identical request + `X-Forwarded-For:
8.8.8.8` → 200). Pure local-dev issue — production behind Vercel always sees
real public IPs.
Fix: `proxy.ts` skips the Arcjet check when the request host is loopback
(`localhost`, `127.0.0.1`, `[::1]`) — Clerk auth still applies, and every
non-localhost host always goes through Arcjet. Denials now also log
`[proxy] Arcjet denied request:` with reason for future diagnosis.

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
