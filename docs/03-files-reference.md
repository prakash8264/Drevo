# 03 — Files Reference

Last reviewed: **2026-10-01**. This is a responsibility map, not a line-number
index. Contracts are in [04](./04-functions-reference.md); causes of security
changes are in [10](./10-audit-findings-and-fixes.md).

## Pages and layout

| File | Responsibility |
|---|---|
| `app/layout.tsx` | DM Sans/Lora, metadata, favicon, theme wrapper, header, toaster |
| `app/page.tsx` | Prompt landing page, feature/pricing sections, guarded organization checkout |
| `app/(auth)/layout.tsx` | Centered auth-page container |
| `app/(auth)/sign-in/[[...sign-in]]/page.tsx`, `sign-up/.../page.tsx` | Clerk prebuilt auth forms |
| `app/(auth)/accept-invitation/[[...accept-invitation]]/page.tsx` | Targeted invitation/authentication flow; named invitation selection for untargeted links |
| `app/(main)/layout.tsx` | Offset for fixed header |
| `app/(main)/workspace/page.tsx` | `getWorkspaceUser(id)` plus authorized project loading; component key includes org/project/revision |
| `app/(main)/projects/page.tsx` | Active-org project cards and empty state |
| `proxy.ts` | Clerk middleware, protected-page redirects, invitation-ticket forwarding, global Arcjet checks; signed-webhook exemption |

## AI routes and modules

| File | Responsibility |
|---|---|
| `app/api/gen-ai-code/route.ts` | Gemini full JSON generation, thought statuses, overload retries/fallback, validated output, shared transactional save |
| `app/api/improve/route.ts` | Request/context guards, model resolution, shared rate/lease protection, agent orchestration, no-op/partial/error classification |
| `app/api/improve/agent-tools.ts` | Safe `update_file`, bounded `add_dependency`, `done_improving` tools |
| `app/api/improve/agent-prompts.ts` | Bounded history, file context, instructions, URL-text image references |
| `app/api/improve/agent-run.ts` | AI SDK tool loop, captured stream errors, fresh state per overload retry, abort-aware backoff |
| `app/api/improve/agent-finish.ts` | Dependency validation, changed-path calculation, finalization through `saveAiWorkspace` |
| `app/api/improve/errors.ts` | Nested provider-error matching, retry hints, quota/overload payloads, `MaxIterationsError` |
| `app/api/improve/models/index.ts` | Model allowlist and configuration-error responses |
| `app/api/improve/models/gemini.ts` | Gemini provider and default model |
| `app/api/improve/models/qwen.ts` | OpenRouter Qwen provider |
| `app/api/improve/models/atria.ts` | Text-only Atria Chat Completions provider |
| `app/api/models/qwen-budget/route.ts` | Server-only OpenRouter quota lookup; display data, not credit authority |

## Organization and webhook routes

| Path under `app/api/` | Responsibility |
|---|---|
| `orgs/route.ts` | Membership-based organization list and selected organization |
| `orgs/switch/route.ts` | Validate target membership and persist selected org |
| `orgs/create/route.ts` | Zero-credit additional organization, local OWNER, Clerk creator/metadata, visible provisioning errors |
| `orgs/repair/route.ts` | Targeted OWNER-only counterpart recovery / empty legacy-org repair; no billing transfer |
| `orgs/members/route.ts` | List members of validated active org |
| `orgs/members/add/route.ts` | Clerk invitation email, caller verification, authoritative self-healing for existing provider membership |
| `orgs/members/role/route.ts` | Clerk-first ADMIN/MEMBER changes; owner/self-role protections |
| `orgs/members/remove/route.ts` | Clerk-first removal/self-leave; sole-owner checks and active-pointer repair |
| `orgs/invitations/complete/route.ts` | Verify current Clerk membership, mirror, select accepted org |
| `orgs/sync/route.ts` | OWNER/ADMIN-requested authoritative membership sync, including removals/roles |
| `orgs/delete/route.ts` | OWNER-only; provider member/billing checks, Clerk-first deletion, local cascade/pointer repair |
| `orgs/billing/checkout/route.ts` | OWNER preflight; require matching Prisma/client/session Clerk organizations |
| `orgs/billing/sync/route.ts` | Manual authoritative plan/grant sync fallback |
| `webhooks/clerk/route.ts` | Raw-body Svix verification; billing/membership/lifecycle reconciliation |

## GitHub routes

All tokens are user-owned and stay server-side. See [07](./07-github-integration.md).

| Path under `app/api/github/` | Responsibility |
|---|---|
| `connect/route.ts` | OAuth redirect and httpOnly state/workspace cookies |
| `callback/route.ts` | State check, token exchange, account fetch, encrypted credential storage |
| `status/route.ts` | Connection boolean/username only |
| `disconnect/route.ts` | Clear saved credentials; do not delete remote repos |
| `repos/route.ts` | Connected user's own-repository picker |
| `branches/route.ts` | Validated own-repository branch list |
| `push/route.ts` | Saved DB files → shared export → non-forced push; exact-target deletion history; post-push tracking warning |

## Server actions

| File | Responsibility |
|---|---|
| `actions/workspace.ts` | Workspace-scoped role/credits/context; membership-authorized files/revision; current user's last push target |
| `actions/projects.ts` | Active-org listing, strict ID plus OWNER/ADMIN-scoped project deletion |
| `actions/versions.ts` | Authorized history listing and revision-checked free restore; **does not export pruning** |
| `types/workspace.ts`, `types/project.ts`, `types/plans.ts`, `types/version.ts` | Shared serializable contracts |

## Components

| File | Responsibility |
|---|---|
| `components/WorkspaceClient.tsx` | Local workspace state/refs; SSE handling, revisions, optimistic credits, cancellation, restore/regenerate/edit/fix orchestration |
| `components/ChatPanel.tsx` | Prompt/message UI, model toggle, upload to `workspace-images` using org/project path, copy/regenerate/edit/Stop |
| `components/CodePanel.tsx` | Sandpack provider/preview/source, runtime error display, ZIP, versions, device/focus controls, quick GitHub update |
| `components/GithubPushDialog.tsx` | Connect, new/existing repo forms, safe retry feedback, tracking-failure warning |
| `components/Header.tsx` | Server-read active org, transparent fixed nav, theme/user/org/member controls |
| `components/HeaderCredits.tsx` | Client credit island; adopt server balance, subscribe to matching org only |
| `components/OrgSwitcher.tsx` | Coordinate Prisma selection and Clerk `setActive`; repair/rollback on failure |
| `components/MembersDialog.tsx` | Organization members, invitation, role/removal, explicit Sync |
| `components/PricingModal.tsx` | Organization plan cards, role-aware checkout and manual billing sync |
| `components/OrganizationCheckoutButton.tsx` | Guard preflight before opening Clerk checkout; recheck client context after awaiting |
| `components/theme-provider.tsx` | `next-themes` plus theme-aware Clerk provider |
| `components/ThemeToggle.tsx` | Theme switching |
| `components/ProjectCard.tsx`, `DeleteProjectModal.tsx` | Project navigation/time-ago and confirmed deletion |
| `components/MobileBlocker.tsx` | Current desktop-editor limitation |
| `components/LogoMark.tsx`, `reusables.tsx`, `ui/` | Branding and shared UI primitives |
| `components/animate-ui/components/backgrounds/hole.tsx` | Landing animation; existing repository-lint debt |

## Shared helpers

| File | Responsibility |
|---|---|
| `lib/prisma.ts` | `PrismaPg` runtime singleton; generated client |
| `lib/checkUser.ts` | Request-local user/context loader; established users need one DB read, no billing sync |
| `lib/org.ts` | Active-org/membership/role helpers; serialized personal-org provisioning and one-time trial allocation |
| `lib/clerk.ts` | Clerk client, role mapping, exact supported plan-slug mapping |
| `lib/membership-sync.ts` | Current Clerk list → mirrored roles/members/removals under org lock; optional invitation activation |
| `lib/billing.ts` | Payer extraction, eligible-item selection, baseline protection, deduplicated additive monthly grants |
| `lib/validation.ts` | Runtime ID validation and safe project/export path validation |
| `lib/ai-request.ts` | Zod request/output schemas, limits, Arcjet screening, expiring distributed AI leases, safe error text |
| `lib/workspace-save.ts` | Shared atomic revision/snapshot/credit commit for both AI routes |
| `lib/versions.ts` | Internal locked history writes/reconstruction; dependency-safe, non-fatal post-commit pruning |
| `lib/version-data.ts` | Canonical hashes, bounded text diffs, exact patch verification, checkpoint fallback |
| `lib/credits-bus.ts` | Organization-scoped, display-only credit events |
| `lib/export-project.ts` | Safe shared file map for ZIP/GitHub, base deps, scaffold, filename |
| `lib/github.ts` | OAuth helpers, AES-256-GCM, repo/branch parsing/validation |
| `lib/github-server.ts` | Server-only connected-user context for listing endpoints and error mapping |
| `lib/github-push-client.ts` | Shared push/list client contracts including `trackingSaved` |
| `lib/constants.ts`, `lib/data.ts` | Credit/pricing constants and landing copy |
| `lib/utils.ts` | Class-name merging |

## Schema, checks, and operations

| File/path | Responsibility |
|---|---|
| `prisma/schema.prisma` | Organization ownership, revisions, grant receipts, exact GitHub targets, AI leases |
| `prisma/migrations/` | Ordered SQL migrations; October security migration is additive |
| `prisma7.config.ts` | Prisma CLI schema/migrations plus `DIRECT_URL` |
| `package.json`, `package-lock.json` | Pinned AI pairing, webpack build/test scripts, patched dependency resolutions/overrides |
| `scripts/test-org-{switch,setup,billing}.cjs` | Isolated org selection, provisioning/checkout, billing/webhook regressions |
| `scripts/test-organization-invitation.cjs` | Isolated targeted invitation/authorization/raw-body verification tests |
| `scripts/test-security.cjs` | Actual-source mock regressions for action IDs, saving, cancellation, grants, roles, GitHub, deletion, credit events |
| `scripts/test-security-database.cjs` | In-memory PostgreSQL migration/data/constraint/rollback/lease/revision checks |
| `scripts/test-version-history.cjs` | Codec exactness and actual-source migration/history/restore/save/retention tests on in-memory PostgreSQL |
| `scripts/reconcile-clerk-apply.ts` | Explicit `--apply` only, Clerk → Prisma, linked orgs only; never recreate revoked provider membership |
| Other backfill/replay/integrity scripts | Operational utilities, not part of the isolated suite; review before execution |

Never assume that a script named `test` or `verify` is read-only. See
[09](./09-multi-tenancy.md#scripts-and-operational-safety) before running legacy
utilities against configured credentials.
