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
   `/api/orgs/members/*`; sole-OWNER demote/remove blocked (409);
   no self role-changes; ADMINs can't touch OWNERs.
   True email invites for non-users (Clerk invitations) deferred.
8. Delete org: OWNER-only, others-removed-first (409 otherwise), cascade
   wipes workspaces/versions, active pointers repaired.
9. Billing: org plan is source of truth; Clerk `has({plan})` /
   `CheckoutButton` retained display-only until org checkout lands.

## Scripts

- `scripts/backfill-orgs.ts` — post-contract verifier (no-op).
- `scripts/verify-orgs.ts` — integrity harness (membership, OWNER,
  workspace linkage, isolation spot-check).
- `scripts/test-credit-concurrency.ts` — atomic-guard proof.

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
  (Prisma-first, Clerk-second, backfill/webhook heal failures).
- `POST /api/webhooks/clerk` (svix, `CLERK_WEBHOOK_SECRET`): subscription.*
  → plan + top-up; membership created/invitation accepted → upsert (new-only,
  never demotes OWNER); membership deleted → remove + pointer repair;
  organization.created → link creator's unlinked org.
- Invites: members dialog → `POST /api/orgs/members/add` →
  `createOrganizationInvitation` (Clerk emails, absolute `redirectUrl` derived
  from request origin + `/workspace` — a bare path 404s on clerk.accounts.dev).
- Removal: Clerk-first (`deleteOrganizationMembership`), Prisma after,
  webhook self-heals half-failures.
- Checkout: both buttons `for="organization"` (bills active Clerk org);
  `OrgSwitcher` moves Clerk active org + Prisma pointer together via
  `setActive`.
