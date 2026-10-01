# 02 — Architecture

Last reviewed: **2026-10-01**. See [10](./10-audit-findings-and-fixes.md) for why
the authorization, credit, and persistence safeguards were added.

## System boundaries

```text
Browser: React hooks + Clerk/theme providers + Sandpack
  -> Next.js server components, server actions, and API routes
     -> Clerk: identity, organization membership, subscriptions/checkout
     -> Prisma/PostgreSQL: application data and shared credit balances
     -> Gemini/NVIDIA GLM/Atria: AI generation and editing
     -> GitHub: user's repositories through their encrypted OAuth token
     -> Supabase Storage: uploaded reference images
Clerk -> signed Svix webhook -> current provider state -> Prisma mirror
```

The organization architecture is the **B-variant**: Clerk owns provider identity,
membership, and billing; Prisma mirrors membership/plan and owns application
data. It is not a custom Stripe or Razorpay checkout implementation.

## Ownership and authorization

- `Organization` owns projects, plan, balance, and credit-grant receipts.
- `User` owns identity, selected organization, trial-allocation marker, and
  GitHub credentials. `createdById` is attribution, not exclusive project access.
- `OrganizationMember` authorizes project access and spending. All members can
  read/edit; OWNER/ADMIN can create/delete projects and manage members. Only
  OWNER can use the app's subscription controls or delete an organization.
- Existing-project operations use the **project's organization**. New-project
  creation/listing use the validated active organization.
- Server actions remain public entry points; they validate IDs and authorize
  independently of page/middleware checks.
- Clerk membership/plan mirrors are reconciled by webhooks, invitation
  completion, or explicit sync, not by a provider read on every page render.
  A mirror can lag; provider-level enforcement is a separate boundary.

## Folder structure

| Path | Responsibility |
|---|---|
| `app/layout.tsx` | Fonts, theme wrapper, header, toaster, metadata |
| `app/(auth)/` | Sign-in, sign-up, targeted invitation acceptance |
| `app/(main)/workspace/page.tsx` | Authorized workspace/context loading |
| `app/(main)/projects/page.tsx` | Active-organization project listing |
| `app/api/gen-ai-code/` | Gemini full-project generation |
| `app/api/improve/` | Agent orchestration, tools, prompts, providers, retries, finalization |
| `app/api/orgs/` | Selection, creation, repair, invitations, roles, removal, deletion, billing sync/preflight |
| `app/api/webhooks/clerk/` | Signed provider-event handling |
| `app/api/github/` | OAuth, status, repo/branch lists, server-side pushes |
| `actions/` | Project/workspace/version server actions |
| `components/` | Chat, preview, organization/billing UI, theme-aware Clerk wrapper |
| `lib/` | Database, authorization, billing, validation, AI guards/save, export, GitHub, credit events |
| `types/` | Workspace, message, file, project, plan, version contracts |
| `prisma/` | Schema and migration history |
| `scripts/` | Isolated tests plus operational utilities with different safety profiles |
| `proxy.ts` | Clerk middleware, protected-page routing, global Arcjet checks |

Detailed file descriptions: [03-files-reference.md](./03-files-reference.md).

## Data models

The authoritative schema is [`prisma/schema.prisma`](../prisma/schema.prisma).

| Model | Important fields / constraints |
|---|---|
| `User` | Unique `clerkId`/email; nullable `activeOrganizationId` FK (`SetNull` on org deletion); `trialCreditsGrantedAt`; encrypted GitHub token/profile |
| `Organization` | Nullable unique `clerkOrgId`; `plan`; `credits` default **0**; `billingBaselineAt` and `billingBaselinePlan` |
| `OrganizationMember` | Unique `(organizationId, userId)`; role OWNER/ADMIN/MEMBER |
| `Workspace` | Required `organizationId` and `createdById`; JSON messages/file data; integer `revision` default 0 |
| `WorkspaceVersion` | Project-scoped checkpoint/text delta, immutable same-project base ID, hashes, depth/file count, summary; cascade on project deletion |
| `OrganizationCreditGrant` | Unique `(organizationId, key)` receipt; allowance increment and receipt commit together |
| `GithubPushTarget` | Unique `(workspaceId, userId, repoFullName, branch)`; pushed paths and last-success metadata |
| `AiRunLease` | Unique key, random ownership token, expiry; cross-instance AI concurrency guard |

`Workspace` still has legacy global GitHub columns. They are preserved for data
compatibility, but current push deletion history and returned link metadata use
`GithubPushTarget`, not those legacy columns.

```ts
type Message = { role: "user" | "assistant"; content: string; imageUrl?: string };
type FileData = {
  files: Record<string, { code: string }>;
  dependencies: Record<string, string>;
  title?: string;
};
```

## Persistence and concurrency

`lib/workspace-save.ts` is the shared AI commit path. It validates project shape,
checks cancellation, locks the organization row, rechecks membership and the
expected workspace revision, updates files/messages, snapshots **database**
pre-edit files, and deducts one shared credit with `credits >= cost`. All database
effects roll back together on failure. It returns credits/revision from inside
the transaction. Version pruning is post-commit and best-effort.

Current `Workspace.fileData` remains full JSONB. Historical pre-edit files use
checkpoints or text deltas, with at most four patches after a checkpoint. Pruning
promotes boundary records before deleting bases. See [11](./11-text-patch-version-history.md)
for reconstruction, format, and coordinated rollout requirements.

The revision protects against stale writes; the AI lease prevents duplicate
in-flight provider work per user/existing workspace. Neither is a global client
store. A late cancellation or lost response **after commit** cannot undo a
successful database write; the UI refreshes server truth when completion is
unconfirmed.

## Billing and credits

- `checkUser()` loads/provisions identity and organization context. It does not
  synchronize subscriptions or calculate credit top-ups.
- `syncOrgPlan()` reads Clerk under the organization lock and mirrors the
  current eligible plan. Provider failures propagate instead of meaning Free.
- Eligible active non-trial monthly paid periods receive an additive allowance;
  verified paid-payment events can supply delayed historical periods. Unique
  plan/period receipts prevent repeated delivery from repeating a grant.
- Existing paid-plan baselines prevent re-awarding the pre-release period.
  Cancellation/downgrade preserves the balance; annual allowances are not enabled.
- Trial credits are allocated once per user during initial personal-org
  provisioning. Additional organizations receive no new trial allocation.
- Checkout uses Clerk's organization flow behind an OWNER/context preflight.
  Clerk's own billing permissions still need separate verification because
  OWNER and ADMIN both map to `org:admin`.

Full policy and event lifecycle: [09-multi-tenancy.md](./09-multi-tenancy.md).

## Client state management

The application does not currently use Zustand or Redux.

| State | Owner |
|---|---|
| Messages, files, model choice, status, credits display | `WorkspaceClient` React state |
| Latest values for async callbacks, expected revision, cancellation | React refs / `AbortController` |
| Authentication and client organization context | Clerk provider |
| Theme and matching Clerk appearance | `next-themes` and `ThemedClerkProvider` |
| Editor/compiler/preview | Sandpack provider |
| Navbar credit notifications | Organization-scoped `CustomEvent` bus |
| Persistent balance, roles, files, revisions | Server/database, not client state |

`emitCredits(credits, orgId)` and `subscribeCredits(orgId, callback)` only
coordinate display for the same organization. Fresh server props and SSE `done`
reconcile optimistic values. The bus is not a reservation or spending API, and
does not broadcast other users' spends in real time.

Local state is appropriate while workspace state is owned by one component
tree. A small shared store could replace the credit bus later if sharing becomes
hard to maintain, but is not required for correctness or server authorization.

## Environment

Keep server secrets out of `NEXT_PUBLIC_*` variables and out of documentation.

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Matching Clerk instance; identity/organization APIs |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | Auth routes, typically `/sign-in`, `/sign-up` |
| `CLERK_WEBHOOK_SECRET` | Svix signature verification for `/api/webhooks/clerk` |
| `DATABASE_URL` | Runtime PostgreSQL connection through `PrismaPg` |
| `DIRECT_URL` | Prisma CLI datasource in `prisma7.config.ts`; intended migration DB |
| `GEMINI_API_KEY` | Initial generation and Gemini edits |
| `GEMINI_FALLBACK_MODEL` | Optional Gemini overload fallback; empty disables |
| `NVIDIA_API_KEY` | Optional GLM-5.3-Flash editing directly through NVIDIA API Catalog; server-only |
| `ATRIA_API_KEY` | Optional Atria editing |
| `ARCJET_KEY` | Global and AI-route protection |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser image upload; bucket policies must enforce authorization |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub OAuth app |
| `GITHUB_REDIRECT_URI` | Exact registered callback, `/api/github/callback` |
| `GITHUB_TOKEN_ENCRYPTION_KEY` | Server-side encryption of stored OAuth tokens |
| `NEXT_PUBLIC_APP_URL` | Optional public origin for invitation redirect URLs |

Public Supabase credentials identify the project; they do not authorize an
organization path by themselves. The current AI prompts carry image URLs as
text; actual multimodal input remains deferred.

## Runtime and delivery

- Both AI routes use Node.js, a 300-second route budget, SSE, and a combined
  request/disconnect/290-second timeout signal. AI leases expire after six minutes.
- Editing stops model work at 240 seconds (including retries), leaving 50 seconds
  for validation, atomic saving, history cleanup, and the response. Completed
  valid tool updates can be saved as an explicit partial result; Stop/navigation
  still cancel saving. A hard deadline emits `AI_TIMEOUT` instead of silent EOF.
- Global Arcjet shield/bot checks skip loopback development hosts and the exact
  signed Clerk webhook endpoint. The webhook still verifies the original body.
- Both AI routes use shared user-based rate/prompt protection, including no-ops.
- Production: `next build --webpack`; development: `next dev`.
- A build, schema check, or mock regression does not prove a real provider
  purchase, renewal, storage policy, or production rollout.
