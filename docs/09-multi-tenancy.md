# 09 — Multi-Tenancy, Membership, and Billing

Last reviewed: **2026-10-01**. Organization data is local; identity/membership/
billing authority is Clerk. This is the **B-variant** architecture, not separate
custom payment checkout. Root causes and regression evidence: [10](./10-audit-findings-and-fixes.md).

## Ownership and models

| Model | Ownership / purpose |
|---|---|
| `Organization` | Name/Clerk link, plan, shared balance, billing baseline; owns projects and grant receipts |
| `OrganizationMember` | Unique local user/org membership with OWNER/ADMIN/MEMBER role |
| `User` | Clerk identity, persisted selection, one-time trial marker, encrypted personal GitHub credentials; no plan/credits columns |
| `Workspace` | Required org and creator attribution, files/history/messages, revision |
| `OrganizationCreditGrant` | Unique receipt per org/plan/period; prevents duplicate allowance |
| `GithubPushTarget` | Push history scoped to project/member/repository/branch |

Leaving/removal does not change project ownership or delete projects created by
that person. Membership, not `createdById`, determines current project access.

## Role matrix

| Operation | OWNER | ADMIN | MEMBER |
|---|---|---|---|
| View/edit org projects, use AI/shared credits | Yes | Yes | Yes |
| Export/push a project with own GitHub account | Yes | Yes | Yes |
| Create/delete org projects | Yes | Yes | No |
| List members | Yes | Yes | Yes |
| Invite/change ADMIN or MEMBER/remove non-owner | Yes | Yes | No |
| Explicit full membership Sync | Yes | Yes | No |
| Leave organization | Unless sole OWNER | Yes | Yes |
| App subscription checkout controls | Yes | No | No |
| Delete organization | With lifecycle checks | No | No |

No self-role changes; ADMIN cannot change/remove OWNER. The ADMIN/MEMBER role
endpoint does not implement ownership transfer. The sole OWNER cannot leave or
be removed through the app. Current external Clerk changes can revoke/demote even
an OWNER; sync must not resurrect access just to preserve a local owner invariant.

`toClerkRole`: local OWNER/ADMIN → `org:admin`, MEMBER → `org:member`.
Inbound admin → ADMIN, except an **existing OWNER** stays OWNER while the current
provider role is still admin. There is no automatic "first admin becomes OWNER"
in authoritative reconciliation.

## Selection and fast switching

- `User.activeOrganizationId` stores selection, but is validated against local
  membership every use; it is not an authorization grant.
- Existing user `checkUser()` uses a one-DB-read fast path. It does not fetch a
  provider subscription or re-list provider membership every page load.
- Header passes its organization list to the switcher without an extra list fetch.
- `/api/orgs/switch` checks membership, persists pointer, and returns Clerk link.
  Client `setActive` coordinates provider context; avoid redundant route refreshes.
- Failed activation/repair stays visible and rolls back selection. Selecting an
  already-highlighted org still activates Clerk if contexts drift.
- Conditional pointer repairs cannot overwrite a newer explicit switch.
- Empty orgs are valid selections. Project count never chooses a subscription.
- Opening an existing workspace loads **its org** role/balance, even if the
  navbar selection differs. Credit events are org-scoped to avoid leaking this
  display update to another organization's navbar.

## Creation and legacy repair

`ensurePersonalOrganization` locks the user row and rechecks membership before
creating the initial personal organization. The same transaction claims
`trialCreditsGrantedAt`, creates org/local OWNER, and selects it. A first eligible
user receives 10 credits; the marker survives later organization deletion.
Joining an existing organization does not add trial credits to that org; the
allocation happens only through eligible initial personal-org provisioning.

Additional organizations created through `/api/orgs/create` receive **zero**
credits. Clerk provisioning uses the actual creator's Clerk user ID as `createdBy`
and private `drevoOrganizationId` metadata. Failure preserves local data but
does not report successful provider setup/activation.

The OWNER-only repair endpoint:

1. Requires verified membership in the exact local target.
2. Recovers an existing counterpart by exact private metadata before creating one.
3. May add the verified local OWNER to a zero-member legacy Clerk counterpart.
4. Refuses to recreate removed membership in a **populated** Clerk org.
5. Never moves subscriptions or changes/transfers balances.

This is targeted recovery, not a globally race-proof provisioning system.
Concurrent repair/backfill and partial failures remain an operational caution.

## Invitations and authoritative reconciliation

Clerk sends invitation email; there is no separate mail provider. Invite roles
are ADMIN/MEMBER. The manager's current provider admin access is verified.

Acceptance preserves the requested org through Clerk auth, accepts only a
matching pending invitation, and shows named choices for older untargeted links.
No timed redirect hides acceptance failures. Completion verifies **current**
Clerk membership, mirrors it, and selects that org before client activation.

`syncClerkMemberships` is shared by membership/invitation webhooks, completion,
explicit Sync, and invite self-healing. It locks the local org row, paginates
current provider members, updates roles, removes absent members in scope, and
conditionally repairs invalid selection. A provider failure rolls back instead
of being interpreted as an empty list. Ordinary background sync does not replace
another valid selected org; explicit completion requests activation.

Role/removal mutations are **Clerk-first**, then Prisma under the same org lock.
There is no distributed transaction across the two services: a provider success
followed by local failure needs a later webhook/explicit reconciliation. Delayed
events re-read current provider truth rather than restoring their old access.

## Credit policy and billing lifecycle

| Plan | Allocation | Purchase configuration |
|---|---|---|
| Free | 10-credit trial once per user in initial personal org; not monthly | No checkout |
| Starter | Add 50 per confirmed eligible monthly paid period | App price $20/month; configured Clerk org plan |
| Pro | Add 150 per confirmed eligible monthly paid period | App price $29/month; configured Clerk org plan |

App plan IDs/slugs live in `lib/constants.ts` and must match the intended Clerk
instance. `starterorg`/`proorg` map to Starter/Pro; exact supported aliases are
accepted, arbitrary substring matches are not. Actual checkout price comes
from provider configuration.

`syncOrgPlan` locks the organization, fetches subscription state, and selects
eligible active/past-due/canceled items whose period has started and not ended,
preferring the recognized higher tier and newer period. Future/ended entries
are not the fallback. Eligibility for **displayed access** is separate from
eligibility for a **new credit grant**.

Grant rules:

- Active, non-trial, monthly paid item with a valid period start; or eligible
  historical period from a verified `paymentAttempt.paid` event.
- Unique receipt key `${plan}:${periodStart}` within the organization.
- Insert receipt and increment balance in the same transaction. Duplicate
  receipt → no increment. Never overwrite balance from an old read.
- `billingBaselineAt`/`billingBaselinePlan` prevent duplicate pre-release awards;
  historical receipts are recorded with zero credits where appropriate.
- Unused balance rolls over. Cancellation/downgrade changes mirrored plan, not
  balance. It is **not** a monthly balance reset or clawback.
- Annual allocations are not implemented for these monthly-only app plans.
- Clerk 404/429/5xx is a retryable sync failure, **not** proof of Free.

Both AI routes spend one shared credit in a guarded transaction only when valid
work is saved. A saved partial edit can cost one credit; a no-op is free.
Project/version writes, revision increment, and deduction roll back together.
Balance returned to the client comes from inside the transaction.

## Checkout boundary

`OrganizationCheckoutButton` calls `/api/orgs/billing/checkout` before opening
Clerk organization checkout (`for="organization"`). Server preflight requires
local OWNER and agreement among persistent Prisma selection, linked Clerk org,
session org, and client org. Client context is rechecked after awaiting.

`PricingModal` prefers mirrored org plan and explicitly scoped `org:...` claims
as a display fallback. The landing page's remaining unscoped display fallback
is documented as deferred; server checkout authorization is separate.

**Provider-level OWNER-only billing is not established by the app gate.** Clerk's
default `org:admin` represents both OWNER and ADMIN. Verify/configure Clerk's own
billing permissions or design a distinct provider owner role before making that
guarantee. This update did not change provider roles/configuration.

## Webhooks

Endpoint: `/api/webhooks/clerk`; secret: `CLERK_WEBHOOK_SECRET`.

| Event | Handling |
|---|---|
| `subscription.*`, `subscriptionItem.*` | Current authoritative plan/grant sync |
| `paymentAttempt.paid` | Current sync plus valid delayed paid-period data from signed payload |
| `organizationMembership.created/updated/deleted` | Re-read provider membership; never trust event ordering/old role alone |
| `organizationInvitation.accepted` | Current membership reconciliation when user/org can be resolved |
| `organization.created` | Link exact private local ID only |
| `organization.deleted` | Verify current provider 404 before local cascade |

Svix v2 `verify()` validates the original raw request text and returns no parsed
payload. Parse **after** verification. Global bot checks exempt this exact path;
unsigned/invalid deliveries still fail. Processing errors return 5xx for retries.
Unextractable payer IDs are logged/skipped; inspect provider payloads in test
delivery rather than assuming a grant was processed.

## Organization deletion

The app requires local OWNER and no other local/provider members. For linked
orgs, verify current provider access and a successfully read resolved subscription;
active/unresolved paid items block deletion. Cancel and wait for the billing
period to end. Delete Clerk org first, then local org in the guarded flow.
A confirmed provider-org 404 permits idempotent local cleanup.

Org deletion cascades its projects/versions/grants/push targets. User accounts
remain, and pointers become null or switch to another membership. It intentionally
deletes that organization's balance/data; cancellation/downgrade preservation
does **not** promise preservation after an explicit destructive org deletion.

## Migrations and rollout

| Migration | Purpose |
|---|---|
| `20260928084948_add_organizations_expand` | Organization/member tables and nullable ownership transition fields |
| `20260928120000_contract_remove_user_ownership` | Required project org/creator, remove user plan/credits and legacy project user ownership |
| `20260928130000_org_clerk_id` | Nullable unique provider link |
| `20261001090000_security_billing_persistence` | Trial marker, zero default, paid baseline, revisions, grants, target history, leases |
| `20261001130000_text_patch_version_history` | Legacy-preserving checkpoint/delta fields, counts, same-workspace base FK and storage constraints; see [11](./11-text-patch-version-history.md) |

The October migration preserves accumulated balances/history; it does not reset
or transfer accepted credits. Existing users are marked trial-allocated. Legacy
global GitHub history is not assigned to a guessed member/target; exact-target
tracking starts with the next successful push.

Back up, review target/environment, apply pending migrations using
`npx prisma migrate deploy` with intended `DIRECT_URL`, then deploy compatible
code. Avoid old/new application writers racing during the credit-policy cutover.
Do not reset, `db push` over the history, or replay real payments for testing.
Live application/migration/provider status was not verified in this doc update.

## Scripts and operational safety

**Isolated suite:** `npm test` runs seven CJS test files without `.env` or network
provider/production DB writes. It includes in-memory PostgreSQL preservation,
unique-grant, rollback, revision, target, lease, and patch-history checks.

**Operational utilities are different:**

| Script | Caution |
|---|---|
| `reconcile-clerk-apply.ts` | Requires explicit `--apply`; linked orgs only, Clerk → Prisma; changes local access, never recreates provider memberships |
| `reconcile-clerk-dryrun.ts` | Review-only report; inspect source/assumptions before relying on results |
| `backfill-clerk-orgs.ts` | Creates real provider orgs/links; do not assume safe under partial failures or concurrent runs |
| `replay-webhooks.ts` | Uses configured signing credentials and real identifiers; localhost target does not make effects safe |
| `test-credit-concurrency.ts` | Creates/deletes a real temporary organization; not in isolated `npm test` |
| `verify-orgs.ts` | Read-oriented integrity report with known false-positive/false-PASS assumptions; not sole proof of correctness |
| `backfill-orgs.ts` | Legacy post-contract verifier; inspect before use |

Never casually run these against live credentials. Back up and use explicit test
users/orgs if an operational apply is separately approved.
