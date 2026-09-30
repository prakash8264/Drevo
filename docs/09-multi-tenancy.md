# 09 — Multi-Tenancy (organizations)

Org-based multi-tenancy. `Organization` owns workspaces, shared credits,
and plan. `User` is identity + per-user GitHub token only.

## Models

- `Organization { id, name, slug?, plan (free|starter|pro), credits }`
- `OrganizationMember { organizationId, userId, role: OWNER|ADMIN|MEMBER }`
  (`@@unique([organizationId, userId])`)
- `User { clerkId, activeOrganizationId?, memberships, createdWorkspaces }`
  (no `credits`/`plan` — dropped in contract migration)
- `Workspace { organizationId!, createdById! }`
  (legacy `userId` dropped in contract migration)

## Rules

1. All members see/open/edit/AI on every org workspace. No project-level ACLs.
2. Only OWNER/ADMIN create (enforced in `gen-ai-code` create branch) or
   delete (`deleteProject` server action). 403 otherwise.
3. Credits are `Organization.credits`, success-only deduct, guarded by
   `updateMany({ where: { id, credits: { gte: 1 } } })` so concurrent spends
   can't overspend (see `scripts/test-credit-concurrency.ts`).
4. Workspace routes authorize via `workspace.organizationId` + membership
   (`findFirst({ id, organizationId: { in: myOrgIds } })`), never bare
   `findUnique({ id })`. Create/list use the active org.
5. `User.activeOrganizationId` persists the switcher selection; always
   re-validated against `OrganizationMember`. Switch via
   `GET /api/orgs` + `POST /api/orgs/switch`.
6. GitHub OAuth stays per-user; MEMBERs push with their own token.
7. Member management: list/add-by-email/role/remove under
   `/api/orgs/members/*`; removals and self-leave ask for confirmation
   first; sole-OWNER demote/remove blocked (409);
   no self role-changes; ADMINs can't touch OWNERs.
    Clerk sends organization invitation emails for new and existing users.
    Create orgs from the switcher's New organization row
    (`POST /api/orgs/create`, caller becomes local OWNER and Clerk admin via
    `createdBy`). Select only after Clerk setup succeeds; preserve the saved
    organization but return 503 if setup fails, so selecting it can retry setup.
8. Delete org: OWNER-only, others-removed-first (409 otherwise), cascade
   wipes workspaces/versions, active pointers repaired.
9. Billing: organization plan is source of truth. Clerk owns organization
   checkout; app checkout requires OWNER and matching Clerk/app organization
   context. User-plan slugs are not used for organization plan badges.

## Scripts

- `scripts/backfill-orgs.ts` — post-contract verifier (no-op).
- `scripts/verify-orgs.ts` — integrity harness (membership, OWNER,
  workspace linkage, isolation spot-check).
- `scripts/test-credit-concurrency.ts` — atomic-guard proof.
- `scripts/replay-webhooks.ts` — Svix-signed local replay of every handled
  event type (needs `npm run dev`).
- `scripts/reconcile-clerk-*.ts` — Clerk↔Prisma reconciliation (dry-run/apply).

## Webhook lessons

- `svix@2.x verify()` returns `undefined` on success (v1 returned the
  payload in the original integration). Use the parsed body after verifying
  the original raw request body, without JSON re-serialization.
  Getting this wrong 500s every event (74% error rate seen in production).
- Production builds use webpack (`next build --webpack`): Vercel's Turbopack
  build shim broke `next/font/google` resolution
  (`@vercel/turbopack-next/internal/font/google/font` import-map failure),
  failing deploys while local Turbopack builds passed. Dev stays on Turbopack.

## Migrations

- `..._add_organizations_expand` — nullable org cols + tables.
- `20260928120000_contract_remove_user_ownership` — required cols,
  dropped `User.credits/plan`, `Workspace.userId` (manual dir: `migrate dev`
  refuses non-TTY shells, SQL via `migrate diff --from-config-datasource`).
- `20260928130000_org_clerk_id` — `Organization.clerkOrgId @unique` (nullable).

## Clerk B-variant wiring

- `lib/clerk.ts` — role maps (`org:admin`↔OWNER/ADMIN, `org:member`↔MEMBER),
  plan map with free fallback, upgrade-only top-up.
- Backfill: `scripts/backfill-clerk-orgs.ts` (no slug — dashboard slugs toggle
  is off; `organization_slugs_disabled` otherwise).
- New signups auto-create their Clerk org in `ensurePersonalOrganization`
  (Prisma-first, Clerk-second, with `createdBy` to add the actual user as admin).
- All app-created Clerk orgs carry private `drevoOrganizationId` metadata;
  `organization.created` links only that exact Prisma row, without guessing
  another unlinked organization of the creator.
- `POST /api/webhooks/clerk` (svix, `CLERK_WEBHOOK_SECRET`): subscription.*
  → plan + top-up via shared `syncOrgPlan` in `lib/billing.ts`; the payer
  org id is resolved across payload shapes (`payer.organization_id`,
  `organization_id`, `organization.id`) and every skip path logs, so missed
  syncs are visible instead of silent; membership created/invitation accepted
  → upsert (new-only, never demotes OWNER); membership deleted → remove +
  pointer repair; organization.created → link creator's unlinked org.
- Manual plan fallback: `POST /api/orgs/billing/sync` reuses `syncOrgPlan`
  for the active org (Sync plan button in the pricing modal) — heals missed
  or lagging subscription events without touching Clerk state.
- Invites: members dialog → `POST /api/orgs/members/add` →
  `createOrganizationInvitation` (Clerk emails, absolute `redirectUrl` derived
  from request origin or `NEXT_PUBLIC_APP_URL` +
  `/accept-invitation?organization_id=<clerkOrgId>`).
- The acceptance page lets Clerk's prebuilt components own authentication,
  preserving the target org on return. It accepts only a matching pending
  invitation; older links without a target show named invitations to choose
  from. There is no timed redirect and failed acceptance stays visible.
- `POST /api/orgs/invitations/complete` verifies the authenticated user's
  membership with Clerk, transactionally upserts the Prisma mirror (preserving
  OWNER), and selects that org. The client sets the Clerk active org before
  reloading `/projects`. Webhook timing does not gate access after acceptance.
- Empty organizations remain valid selections. User sync and webhook replays
  must not switch away merely because an org has no projects.
- Run `node scripts/test-organization-invitation.cjs` for isolated acceptance,
  authorization, and raw-body webhook regressions (no live users or DB writes).
- Removal: Clerk-first (`deleteOrganizationMembership`), Prisma after,
  webhook self-heals half-failures.
- Checkout: both buttons `for="organization"` (bills active Clerk org);
  `OrgSwitcher` moves Clerk active org + Prisma pointer together via
  `setActive`. Both pricing surfaces use `OrganizationCheckoutButton`, which
  calls `POST /api/orgs/billing/checkout` before opening Clerk's drawer. The
  preflight checks authenticated OWNER, persistent app selection, session
  org ID, and client org ID; the client re-checks Clerk after awaiting it.
  This gates app checkout, not direct access to Clerk billing outside the app.
- Failed activation for a local OWNER invokes `POST /api/orgs/repair` once.
  It may provision an unlinked counterpart or add the verified OWNER as
  `org:admin` to a zero-member legacy Clerk org. It never restores a removed
  member in a populated org, changes plans/credits, or moves subscriptions.
  Failed repair/activation rolls back the app pointer and shows an error;
  creation must not show a success toast after failed activation. Selecting
  the already-highlighted org also activates Clerk when the contexts differ.
- Org plans: Starter org plan `cplan_3K2DXlsyW4SPI7QFY7WGnwgTvxe`
  (dashboard Key `starterorg`, $20/mo, 50 credits), Pro org plan
  `cplan_3K2J6Vgaiww60XSxqKHGcSwGvGa` (dashboard Key `proorg`, 150 credits).
  `toDrevoPlan` maps the Clerk slugs `starterorg`/`proorg` → Drevo plans;
  the header passes the synced `Organization.plan` into the pricing modal so
  the Active badge does not depend on user-plan `has()` checks.
- Billing access: only the org OWNER sees paid checkout buttons (header,
  landing, and modal fallback via `/api/orgs/members` role). Fallback roles are
  reloaded on Clerk org changes, and checkout authorization is checked again
  server-side. ADMIN/MEMBER get a disabled Owner-only button. Free stays the
  default with no checkout.

## Organization switching performance

- `checkUser` uses the session identity and one Prisma read for established users.
  Clerk profile fetching and personal-org provisioning are only needed for new
  users or repairing missing context. Membership reconciliation runs through
  invitation completion, webhooks, or explicit Sync, not every page render.
- The header passes its membership list directly to the switcher, avoiding an
  extra `/api/orgs` request. Active-org resolution is cached within each server
  render only, never across users or requests.
- Switching requires one membership lookup (including the Clerk org ID) and
  one active-pointer update. Clerk `setActive` refreshes the Next.js route;
  the switcher must not trigger a second refresh on success.
- Run `node scripts/test-org-switch.cjs` for query-budget, authorization and
  failed-activation rollback checks.
- Run `node scripts/test-org-setup.cjs` for creator membership, empty-org
  repair, creation failure handling, and checkout mismatch prevention.
  Fixtures are isolated: no live DB writes, memberships, or purchases.
