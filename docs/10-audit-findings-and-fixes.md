# 10 — Audit Findings, Root Causes, and Fixes

**Report date:** 2026-10-01  
**Project:** Drevo  
**Scope:** Whole-application audit and the approved critical/high implementation,
plus related reliability fixes and known deferred/provider-dependent findings.

This report explains **what was wrong, why it happened, how it was addressed,
and what evidence supports the fix**. It is not a claim that every possible bug
has been eliminated or that the production service has been upgraded.

## Status and evidence boundaries

- The audit examined 138 tracked files, including 115 code/style/schema/migration
  files and 24 API routes. Findings came from source review, dependency checks,
  and isolated execution of actual source with mocked dependencies.
- Dangerous behavior was reproduced in fixtures, **not** exploited against live
  users, purchases, memberships, repositories, or production data.
- The approved code fixes and additive migration exist in the repository.
  At the end of the fix session, no live migration/deployment was performed.
  Live rollout status was **not checked** during this documentation refresh.
- **Implemented** below means code changed and local regression evidence exists.
  **Partial / provider verification** and **Deferred** mean the boundary is not
  fully resolved. General medium/low UI cleanup was not the approved priority.
- Existing accumulated credits were intentionally preserved. The accepted
  historical balance was not recalculated, moved, or clawed back.

## Finding index

Severity describes the original risk. Operational/provider limitations are not
automatically assigned a proven remote-exploit severity.

| ID | Finding | Original priority | Status |
|---|---|---|---|
| F01 | Public unguarded version pruning | Critical | Implemented |
| F02 | Missing ID leaked global version summaries | High | Implemented |
| F03 | Missing ID deleted an org's whole project list | High | Implemented |
| F04 | Prisma-only demotion could regain ADMIN | High | Implemented |
| F05 | Stale events / add-only reconciliation restored access | High | Implemented; mirror lag remains |
| F06 | Transient billing error became Free and duplicate top-up | High | Implemented |
| F07 | Absolute billing balance write erased a concurrent spend | High | Implemented |
| F08 | Same-plan monthly renewal never allocated credits | High | Implemented; real lifecycle verification needed |
| F09 | Wrong subscription item / loose plan mapping | High / related correctness | Implemented |
| F10 | Local-only org deletion left provider billing unresolved | High | Implemented; provider recovery boundary remains |
| F11 | Every new organization minted another free trial | High | Implemented; per-user, not per-person anti-abuse |
| F12 | Concurrent/stale project saves overwrote newer code | High | Implemented |
| F13 | Undo snapshot came from stale browser files | High | Implemented |
| F14 | Empty or malformed AI output was saved and charged | High | Implemented; not a compile guarantee |
| F15 | Post-commit cleanup failure falsely reported generation failure | High | Implemented |
| F16 | Abort during package validation still saved/charged | High | Implemented; after-commit abort cannot undo save |
| F17 | Improve/no-op requests lacked generation's abuse protection | High | Implemented; ingress/provider limits still relevant |
| F18 | Workspace-global GitHub paths deleted files in another target | High | Implemented |
| F19 | GitHub error handling misclassified failures / lost remote-success state | Related reliability | Implemented in push flow |
| F20 | Editor/navbar credits and roles used stale/wrong-org context | Related correctness | Implemented for workspace context/events |
| F21 | Captured SDK overload errors bypassed retry | Related reliability | Implemented |
| F22 | Vulnerable dependency resolutions, including new Next.js critical advisory | Critical/high advisories | Patched; zero reported at verification |
| H01 | Earlier org creator/link/activation/checkout drift | Earlier integration issue | Prior fixes retained and tested |
| H02 | Earlier webhook verification and build/provider integration failures | Earlier integration issue | Prior fixes retained; history in 06 |

## Authorization and membership

### F01 — Public, unguarded version pruning

**Problem and impact:** Version retention could be invoked as an unauthenticated
server action. With an omitted workspace ID, the mocked query became global and
kept only 20 versions across the table, risking unrelated project history.

**Cause:** `pruneVersions` was exported from a `"use server"` file as though it
were an internal utility. Exported actions are public callable entry points.
TypeScript's `string` annotation did not validate runtime input; Prisma omitted
the `undefined` filter.

**Fix:** Move pruning into internal `lib/versions.ts`, validate the workspace ID,
scope both reads and deletes to that exact workspace, and use deterministic
ordering. AI/restore callers use best-effort pruning after a successful commit.

**Evidence:** Actual-source tests reject invalid IDs, inspect exact query filters,
and tolerate cleanup failure. The production server-action manifest was checked
and **does not expose `pruneVersions`**.

**Files:** `actions/versions.ts`, `lib/versions.ts`, `lib/validation.ts`.

### F02 — Missing ID leaked other projects' version summaries

**Problem and impact:** An authenticated user could pass no workspace ID; an
authorization query matched an owned workspace while the separate history query
lost its filter and returned global summaries.

**Cause:** Runtime input was trusted, and authorization scope was not repeated
in the data query. An omitted value made both queries broader than intended.

**Fix:** `getVersions` validates the ID before database access, authorizes the
workspace, and includes workspace plus current membership relation in the
version query. Missing/empty/object IDs fail instead of widening the query.

**Evidence:** Invalid-action-input and signed-out regressions execute the action;
the source now contains the membership-scoped read.

**Files:** `actions/versions.ts`, `lib/validation.ts`.

### F03 — Missing ID deleted all projects in an authorized organization

**Problem and impact:** OWNER/ADMIN project deletion without an ID became an
organization-wide `deleteMany`, rather than one confirmed project's deletion.

**Cause:** Role/organization checks existed, but the exact project identifier
was not runtime-validated. Prisma dropped the missing project condition.

**Fix:** Validate ID first. The mutation itself requires exact project ID,
organization, and a current OWNER/ADMIN membership. No broad fallback exists.

**Evidence:** Invalid-input and MEMBER-forbidden tests ensure no database
mutation is reached by those calls.

**Files:** `actions/projects.ts`, `lib/validation.ts`.

### F04 — Prisma-only role changes allowed privilege restoration

**Problem and impact:** Demoting ADMIN locally left Clerk `org:admin` intact.
Invitation completion could mirror that provider role back to ADMIN.

**Cause:** Two role authorities diverged; the role endpoint wrote only Prisma.
The app also ignored membership-updated events.

**Fix:** Lock/recheck caller and target, verify provider admin access, update Clerk
first, then Prisma. Completion/webhooks use shared current-state reconciliation.
OWNER is preserved only while current Clerk role remains admin. App role changes
cannot change OWNER or the caller's own role.

**Evidence:** Tests assert Clerk-before-Prisma order, no local role change on
provider failure, current role mirroring, and OWNER/admin preservation/demotion.

**Files:** `app/api/orgs/members/role/route.ts`,
`app/api/orgs/invitations/complete/route.ts`, `lib/membership-sync.ts`.

### F05 — Stale events and reconciliation could restore removed access

**Problem and impact:** A delayed membership-created event restored a revoked
membership; full sync only added members; the old apply utility could recreate
missing provider memberships from local rows.

**Cause:** Event payload/order was treated as current truth, and reconciliation
was not consistently one-way from Clerk to Prisma.

**Fix:** Shared `syncClerkMemberships` reads current provider membership under
the org lock, paginates, updates roles, removes absent scoped members, and repairs
selection conditionally. Webhooks handle updates too. Invitation self-healing
uses that helper instead of direct stale upsert. Role/removal writers coordinate
with the same lock. The apply script requires `--apply`, handles linked orgs only,
and never recreates revoked Clerk members or guesses OWNER.

**Evidence:** Delayed created/updated/deleted webhook tests, revocation/role tests,
provider-failure preservation, and invitation self-healing tests.

**Boundary:** Local data access uses a mirror that can lag external Clerk changes
until webhook/explicit sync. Database locks do not lock external dashboard/API
changes or create a distributed transaction.

**Files:** `lib/membership-sync.ts`, `app/api/webhooks/clerk/route.ts`,
`app/api/orgs/sync/route.ts`, `app/api/orgs/members/{add,role,remove}/route.ts`,
`scripts/reconcile-clerk-apply.ts`.

## Billing, credits, and organization lifecycle

### F06 — Transient billing failure became Free, then duplicate credits

**Problem and impact:** A mocked Clerk 429 produced Pro/150 → Free/150 →
Pro/290. Recovery was mistaken for another upgrade and minted credits.

**Cause:** Catch-all subscription errors were converted to "no subscription"
and the old upgrade-only allowance logic granted a positive plan delta.

**Fix:** Propagate provider failures and keep mirrored state intact. Only a
successful authoritative read changes the plan. Period receipts replace
plan-transition top-ups; repeated reads cannot repeat the same allowance.

**Evidence:** Tests cover 429 preservation, retryable manual-sync failure, and
accepted 399-credit historical balance remaining unchanged on repeated sync.

**Files:** `lib/billing.ts`, `app/api/orgs/billing/sync/route.ts`.

### F07 — Absolute balance writes erased concurrent spending

**Problem and impact:** Billing sync read a balance, an AI run spent one, then
sync wrote an old calculated total. The fixture ended at 150 rather than 149.

**Cause:** Read/compute/overwrite outside an atomic grant transaction, instead
of applying a guarded delta to the current database balance.

**Fix:** Lock the org, insert unique receipt and **increment** allowance in one
transaction. AI deductions use `credits >= cost` and decrement atomically.
Cancellation/downgrade never writes a reset balance.

**Evidence:** Additive/idempotent billing regressions; in-memory PostgreSQL
concurrent grant/spend and one-credit/two-spenders checks; rollback tests.

**Files:** `lib/billing.ts`, `lib/workspace-save.ts`,
`prisma/schema.prisma` (`OrganizationCreditGrant`).

### F08 — Same-plan monthly renewals had no allocation

**Problem and impact:** Paying for another month on the same plan did not add
the plan's credits. Upgrade-only top-up logic could not represent renewals.

**Cause:** Credit allocation was keyed to plan change, not a confirmed billing
period. There was no persistent deduplication ledger.

**Fix:** Grant 50 Starter / 150 Pro credits for each eligible confirmed monthly
paid period, using a unique org/plan/period receipt. Active non-trial provider
periods and verified paid-payment history drive allocation. Delayed paid events
can recover a period after a later plan change. Balance rolls over; annual
allowances are not implemented for the monthly-only plans.

**Migration protection:** Record the existing paid plan/time baseline and seed
zero-value historical receipts where appropriate, rather than re-awarding an
already included historical purchase. Keep accepted accumulated balance.

**Evidence:** Tests for duplicate sync/events, unchanged-plan next period,
delayed payments, cancellation/reactivation, and historical baseline preservation.
Actual provider renewal/event-shape behavior still needs test-org verification.

**Files:** `lib/billing.ts`, `app/api/webhooks/clerk/route.ts`,
`prisma/migrations/20261001090000_security_billing_persistence/migration.sql`.

### F09 — Subscription selection and plan matching were too loose

**Problem and impact:** Selecting the first active/fallback item could choose
Free or upcoming/ended data instead of the current paid tier. A substring such
as `pro` could map an unrelated slug to Pro.

**Cause:** Array order/fallback and loose string matching substituted for
subscription eligibility and a supported-plan map.

**Fix:** Use current-period eligible active/past-due/canceled items, exclude
future/ended periods, prefer recognized higher tier/newer period. Distinguish
access-plan eligibility from new-credit eligibility. Accept exact supported
plan/org aliases only, unknown → Free.

**Evidence:** Free+paid+upcoming item fixtures and unknown-slug regressions.
Provider-specific grace/past-due behavior still needs live verification.

**Files:** `lib/billing.ts`, `lib/clerk.ts`.

### F10 — Local-only organization deletion left Clerk/billing behind

**Problem and impact:** Deleting Prisma data could leave the provider org and
subscription active, making future billing/support recovery ambiguous.

**Cause:** Deletion treated the local database as the entire lifecycle boundary.

**Fix:** Require OWNER, recheck local/provider members and access under org lock,
successfully read provider billing, block unresolved paid items, and delete Clerk
before local cascade. A confirmed provider-org 404 permits local cleanup.
Pointer repair is in the local deletion transaction; user accounts remain.

**Evidence:** Provider error / deletion error / paid-item fixtures do not delete
local data; free/already-gone fixtures check ordering/idempotent cleanup.

**Boundary:** Clerk and PostgreSQL are not one transaction. If provider deletion
succeeds but local commit fails, verified lifecycle webhook/retry must recover.
Explicit org deletion intentionally deletes its balance/data; preserving credits
on cancellation is not a promise to preserve them after org deletion.

**Files:** `app/api/orgs/delete/route.ts`, `app/api/webhooks/clerk/route.ts`.

### F11 — Organization creation could repeatedly mint free credits

**Problem and impact:** Each new local organization received 10 credits, even
if Clerk provisioning failed. Extra orgs and repeated first-org requests could
create unearned trial allocations.

**Cause:** Default balance/allocation was tied to organization creation, with no
per-user eligibility marker and insufficient first-request serialization.

**Fix:** Additional orgs and schema default start at zero. Initial personal-org
provisioning locks the user row/rechecks membership and atomically claims
`trialCreditsGrantedAt` for a one-time 10-credit allocation. Deleting the org
doesn't clear the user marker. Migration marks existing users as already allocated.

**Evidence:** Simultaneous initial provisioning creates one org/one allowance;
delete/recreate fixture receives no second trial; migration preserves markers.

**Boundary:** This is one trial **per user account**, not identity-proof anti-fraud
or protection against creating multiple distinct accounts. A first eligible
personal org can retain its one allocation if provider setup fails; no additional
allocations are generated by repair.

**Files:** `lib/org.ts`, `app/api/orgs/create/route.ts`, schema/migration.

## AI data preservation and abuse protection

### F12 — Concurrent/stale writes silently overwrote newer project code

**Problem and impact:** A slow edit/restore could overwrite a newer saved result.

**Cause:** Writes used project ID alone, without an expected revision; a long
provider run could commit against a database that changed while it ran.

**Fix:** `Workspace.revision`; require expected revision for existing edits/
generation/restores, conditionally update it, increment on successful write,
and rollback stale saves. Client carries the returned revision. Leases also
limit duplicate in-flight AI work but do not replace compare-and-swap.

**Evidence:** Stale/losing-race save regressions and PostgreSQL conditional-update
test; request-schema tests require revisions.

**Files:** `lib/workspace-save.ts`, `actions/versions.ts`, AI routes,
`components/WorkspaceClient.tsx`, schema/migration.

### F13 — Undo history recorded stale browser files

**Problem and impact:** A supposedly pre-edit version could omit newer code and
make rollback restore the wrong state.

**Cause:** The snapshot used body `fileData`, which was context supplied by a
browser, not the actual database state about to be replaced.

**Fix:** Read previous saved files in the revision-checked transaction and
snapshot those files. Restore similarly snapshots DB state before replacing it.

**Evidence:** Save fixture supplies different DB/browser files and asserts the
undo snapshot contains the database's previous code.

**Files:** `lib/workspace-save.ts`, `actions/versions.ts`.

### F14 — Empty/malformed model output was saved and charged

**Problem and impact:** `files: {}` was accepted, persisted, and charged; invalid
code/path/dependency shapes could also survive shallow object checks.

**Cause:** JSON parse and "is object" checks were treated as enough validation.
An AI instruction is not runtime output validation.

**Fix:** Shared request/output/file schemas, bounded code/deps/paths, nonempty
file set, required nonempty `/App.js` default export; validate before package
lookup and again in shared save. Tool path/package inputs also have guards.
ZIP/GitHub share export-path validation.

**Evidence:** Actual generation route tests empty/valid output; schema/save tests
reject invalid types/paths/empty entry point without charging.

**Boundary:** Shape checks and default-export detection are not JS compilation,
import resolution, package-version security scanning, or a guarantee of usable
preview. Bad generated runtime logic can still require Fix with AI.

**Files:** `lib/ai-request.ts`, `lib/validation.ts`, `lib/export-project.ts`,
`app/api/improve/agent-tools.ts`, AI finalization/save.

### F15 — Post-commit cleanup falsely reported failure after charging

**Problem and impact:** Files and credit deduction committed; pruning or a later
balance read failed; the stream reported failure and UI refunded optimistically.
Retrying could spend again even though the first run had succeeded.

**Cause:** Transactional completion and nonessential post-commit work shared one
failure classification, with another required DB read after the commit.

**Fix:** Return balance/revision inside the successful transaction. Scope pruning
as best-effort cleanup; failure is logged, not converted into failed generation.
Unconfirmed completion refreshes server truth rather than trusting a local refund.

**Evidence:** Successful save with intentionally failing prune still returns
committed completion/balance. Interrupted stream handling is explicit in client.

**Files:** `lib/workspace-save.ts`, `lib/versions.ts`, `components/WorkspaceClient.tsx`.

### F16 — Abort during dependency validation still persisted/charged

**Problem and impact:** Stop/navigation during async package lookup did not stop
the later write, so canceled work could be saved and charged.

**Cause:** Cancellation was checked around provider streaming but not after
async validation or before/within persistence.

**Fix:** Combined request/stream-disconnect/timeout signal, provider abort signal,
post-validation checks, transactional checkpoints, unmount aborts, and lease
finalization. Observed pre-commit abort rolls back files/history/credit.

**Evidence:** Abort during dependency lookup never enters save; abort during
charge rolls transaction back; actual generation stream cancel propagates to SDK
and releases the lease.

**Boundary:** After-commit cancellation cannot undo committed work. Provider SDK
cancellation also may not stop billable work already executing remotely.

**Files:** Both AI routes, `agent-finish.ts`, `lib/workspace-save.ts`, client.

### F17 — Improve and free no-ops could consume unbounded provider work

**Problem and impact:** Improvement lacked generation's rate screen; no-op
requests cost no app credits but still consumed provider resources. Parallel
submissions could multiply long-running work.

**Cause:** Abuse controls were attached to one endpoint rather than shared
provider-work entry points; no cross-instance concurrency guard existed.

**Fix:** Shared `protectAi`, bounded request/schema validation, per-user token
bucket/prompt screen on both routes, and transactional expiring leases per user/
existing project. No-op requests are screened even though not charged.

**Evidence:** Entry guards inspected in both routes; actual-route lease/cancel
tests plus PostgreSQL lease conflict/expiry/token-ownership checks.

**Boundary:** Tests mock Arcjet/provider responses; they do not validate production
rate service configuration. Body is still read into memory for size validation;
platform ingress limits and monitoring remain important.

**Files:** `lib/ai-request.ts`, `lib/arcjet.ts`, both AI routes, schema/migration.

## GitHub and client reliability

### F18 — Global push paths deleted files across repositories/branches/members

**Problem and impact:** A project pushed to repository A stored a global deletion
list; pushing it to B could delete B's unrelated paths based on A's history.

**Cause:** `Workspace.githubPushedFiles` lacked repository, branch, and member
identity even though credentials and repositories were user-owned.

**Fix:** `GithubPushTarget` unique key `(workspaceId, userId, lowercase repo,
branch)`. Only that target's prior paths authorize deletion. Current user's
latest target supplies reload/quick-update metadata. Keep legacy data but never
guess its member/target or import it as deletion authority.

**Evidence:** Push-route fixtures for new/known repo, different member/branch,
exact-key lookup/deletion isolation; database uniqueness checks.

**Boundary:** First target push starts without legacy deletion knowledge; old
removed files may remain for manual review. Non-forced ref updates protect
remote history, not a distributed metadata transaction with GitHub.

**Files:** `app/api/github/push/route.ts`, `actions/workspace.ts`, schema/migration.

### F19 — GitHub rate/permission errors and tracking failures were misleading

**Problem and impact:** Broad 403 handling swallowed rate-limit classification
and treated repo permission denial like an invalid token. A local metadata
failure after push could report failed upload despite remote success.

**Cause:** Error checks were ordered too broadly; post-push bookkeeping was
treated as part of whether the remote operation succeeded.

**Fix:** Push route classifies rate-limit first, 401 credentials separately, 403
repo permissions separately. `recordPush` returns best-effort status;
`trackingSaved: false` preserves remote success with a client warning.

**Evidence:** Mocked 403 rate limit → 429; successful remote push despite tracking
DB failure; both dialog/quick-update clients expose the warning.

**Boundary:** This fix describes the push flow; don't assume every other GitHub
endpoint's error helper has identical classification or token-refresh behavior.

**Files:** Push route, `lib/github-push-client.ts`, `GithubPushDialog.tsx`, `CodePanel.tsx`.

### F20 — Stale or wrong-org credit/role display

**Problem and impact:** Refreshed `userCredits` was ignored; an existing workspace
could use another active org's role/credits. Global credit events could change
the wrong navbar balance. Delayed pointer repair could undo an explicit switch.

**Cause:** Client initial state was not reconciled with server props, workspace
context was loaded independently from its org, and events/repair writes lacked
organization/current-selection conditions.

**Fix:** Load `getWorkspaceUser(workspaceId)` against the owning org; carry
revision/context through keyed workspace client; adopt new server credit props.
Events include org ID and subscribers filter it. Conditional pointer repair
does not overwrite a newer choice; unconfirmed SSE completion refreshes server.

**Evidence:** Org-filtered credit events and late-pointer repair regressions,
existing switching query-budget/rollback tests; source context wiring reviewed.

**Boundary:** The event bus is local display synchronization, not cross-user
realtime balance delivery or spending authority. A navbar may intentionally
represent a different selected org from an open authorized project.

**Files:** Workspace actions/page/client, `lib/credits-bus.ts`, header, `lib/org.ts`.

### F21 — Captured overload error parts skipped retry

**Problem and impact:** SDK 503 stream error parts could terminate/reclassify as
step exhaustion rather than using the retry loop. Call-time errors previously
also hit a temporal-dead-zone reference failure and masked quota.

**Cause:** Thrown and captured errors used different paths; retry state was
previously declared after a possible throw.

**Fix:** Captured overload enters common retry logic; reset patch state per attempt,
declare state before try, disable SDK nested retries, retain true quota/overload
classification, and honor abort/backoff. Gemini fallback recognizes exhausted
overload causes too.

**Evidence:** SDK-error-part fixture fails twice then succeeds on attempt three
with three fresh resets. Earlier nested-error classification remains documented.

**Files:** `app/api/improve/agent-run.ts`, `route.ts`, `errors.ts`.

## Dependencies and earlier integration fixes

### F22 — Vulnerable dependency resolutions

**Problem:** Original npm audit reported seven affected entries (five high,
two moderate): Prisma/config/deepmerge-ts, mysql2, brace-expansion, fast-uri,
ip-address. A fresh check during implementation also found a critical Next.js
advisory. Package entries are **not** seven proven reachable remote exploits.

**Cause:** Vulnerable direct/transitive versions in the installed dependency tree;
automatic audit suggested an unsuitable Prisma downgrade/major change.

**Fix:** Next.js and eslint-config-next **16.3.8**; targeted resolutions for
deepmerge-ts **8.0.2**, mysql2 **3.24.5**, brace-expansion **1.1.21 / 5.0.12**;
compatible fast-uri/ip-address updates in lockfile. Keep Prisma **7.10.0** and
the pinned AI SDK/provider pairing. No `audit fix --force` or Prisma downgrade.

**Evidence:** Prisma generation/validation, TypeScript and production build passed
with patched resolutions. `npm audit` reported **zero vulnerabilities** at the
end of fixes and again during this documentation update. Advisories can change;
this is a dated registry result, not a permanent vulnerability-free guarantee.

**Files:** `package.json`, `package-lock.json`.

### H01 — Earlier creator membership, activation, and checkout drift

**Symptoms:** Creator had local OWNER but lacked Clerk membership; selection
appeared successful without matching Clerk context; checkout/subscription could
be associated with the wrong provider organization.

**Causes:** Provisioning without the actual Clerk creator, guessing local links,
split Prisma/Clerk activation, and missing OWNER/context preflight.

**Prior fixes retained:** `createdBy`, exact private `drevoOrganizationId`, targeted
empty legacy repair, verified activation/rollback, visible creation errors,
checkout preflight and post-await context recheck. No membership repair changes
subscription ownership or paid balance. Accepted historical credits stay intact.

**Evidence:** `test-org-setup.cjs`, `test-org-switch.cjs`, and invitation tests
cover provisioning metadata, populated-org repair refusal, drift, failed activation,
and checkout guards. Live provider OWNER-only billing remains open below.

### H02 — Earlier build, webhook, and AI integration problems

Historical causes and fixes are retained in [06-troubleshooting.md](./06-troubleshooting.md):

- **Svix v2 verification return value:** assuming a parsed return caused handler
  failures. Verify raw bytes, then parse separately; signature tests cover it.
- **Deployment font resolution:** production Turbopack shim failed `next/font`
  imports. Production script uses `next build --webpack`.
- **SDK/model-spec mismatch:** independently floating AI/provider majors broke
  all edits. Compatible exact versions and type/build checks retained.
- **Stream double-close:** use closed flag/safe enqueue/close; combined cancellation
  now extends this protection through persistence.
- **Qwen/other provider limits:** nested quota errors and Retry-After are surfaced;
  account/provider limits themselves cannot be "fixed" by client code.
- **Unusable free model integrations:** caller-gated Spark/MiMo variants were not
  shipped as working options; Atria uses its verified Chat Completions integration.
- **Missing dependencies/invalid auth layout/shared export duplication:** earlier
  implementation corrections remain in source, not new changes in this batch.

## Remaining findings and limitations

These are deliberately **not marked fixed** merely because core regressions pass.

| Item | Cause / remaining action | Status |
|---|---|---|
| Provider-level OWNER-only billing | Local OWNER and ADMIN both use Clerk `org:admin`; app preflight cannot restrict direct provider billing interfaces. Verify/configure provider permissions or design distinct owner role. | Provider verification / design needed |
| Real renewal/webhook lifecycle | Mocked states do not prove real payload shapes, subscription transitions, retries, grace semantics, delivery permissions, or period timestamps. Verify in a separate test org. | Provider verification needed |
| Supabase Storage authorization | Org-prefixed upload paths and public anon key do not enforce org membership. Audit bucket insert/read/delete policies and access model. | Provider verification needed |
| Screenshot pixels not sent | Current builders supply image URL text, not provider image parts. Atria is text-only; do not advertise guaranteed screenshot understanding. | Deferred |
| Landing pricing fallback | `PricingModal` uses explicit organization plan claims; `app/page.tsx` still has unscoped display fallback. App checkout is separately server-guarded. | Deferred display correction |
| Other provisioning scripts/races | Targeted repair recovers exact metadata, but simultaneous repair/backfill/partial failure is not universally serialized/idempotent. `backfill-clerk-orgs.ts` can create duplicates. | Deferred hardening; controlled execution |
| Legacy replay/concurrency utilities | Some load real credentials and write real orgs/users/events despite test-like names. Do not run casually; use isolated suite. | Operational risk documented |
| Integrity verifier accuracy | `verify-orgs.ts` may report pointer PASS after failures and assumes departed project creators remain members. Not authoritative release proof. | Deferred correction |
| Repository-wide lint debt | Animated background has 13 errors; homepage has unused `Badge` warning after separate edit. General UI cleanup wasn't in priority batch. | Deferred |
| Chat-width hydration warning | Persisted browser width can differ from SSR default. Cosmetic earlier issue, not addressed by security fixes. | Deferred |
| Generated app/dependency correctness | Shape/package-existence validation isn't compilation/exact-version verification. Runtime errors can remain. | Known boundary |
| Cross-service/mirror timing | Database commits cannot atomically commit Clerk/GitHub; external removals can lag local mirror. Verify retries/recovery and monitor failures. | Known boundary |
| Multiple accounts / resource limits | One trial per user is not per-person verification; route limits do not replace platform ingress/provider controls. | Known boundary |

Global Arcjet blocking of Svix traffic **was addressed in code** by exempting
the exact signed endpoint while retaining signature validation; real delivery
still needs provider verification.

## Validation record

### End of implementation session

| Check | Result |
|---|---|
| `npm test` | **58 passed**, zero failed |
| TypeScript `--noEmit --incremental false` | Passed |
| `npx prisma validate` / client generation | Passed |
| `npm run build` (`--webpack`) | Passed on Next.js 16.3.8 |
| ESLint on changed code | Passed |
| Repository-wide ESLint | 13 existing errors in `hole.tsx`; one unused homepage import warning |
| `npm audit` | Zero reported vulnerabilities |
| `git diff --check` | Passed |
| Compiled server-action manifest | Internal pruning not exposed |

During the **documentation update on 2026-10-01**, the 58-test isolated suite and
dependency audit were rerun: 58 passed, zero audit vulnerabilities. Isolated
migration tests ran as part of that suite. The build was not rerun for these
documentation-only edits; no live migration, purchase, or provider test was run.

### Where the evidence lives

- `scripts/test-security.cjs`: actual TypeScript modules transpiled into fixture
  contexts with mocked Clerk/Prisma/AI/GitHub. Authorization, grants, snapshots,
  rollback/cancellation, retries, target isolation, deletion, credit display.
- `scripts/test-security-database.cjs`: actual ordered SQL migrations on
  in-memory PostgreSQL (`PGlite`, already installed transitively), preserved
  399-credit fixture/history, unique receipts/targets, conditional revisions,
  guarded spending, rollback, expiring leases, FK cascades.
- Existing org switch/setup/billing/invitation suites: creator membership,
  activation, query budget, checkout context, signed webhook and acceptance.

Isolated PostgreSQL proves those SQL behaviors, not production load, isolation
under every deployment topology, provider transaction guarantees, or end-to-end
renewal delivery. The standard suite never uses `.env` or live provider writes.

## Migration and rollout checklist

1. Back up the intended database; record current balances and project/version
   counts. Review environment and migration status without exposing credentials.
2. Review `20261001090000_security_billing_persistence`: additive columns/tables,
   existing users marked trial-allocated, existing org plan/time baselines,
   revisions default 0, balances/history untouched, legacy targets unguessed.
3. Coordinate the policy cutover so old and new billing writers do not race.
   Apply pending migrations with `npx prisma migrate deploy` against the intended
   `DIRECT_URL`, then deploy compatible code. Do not reset or substitute `db push`.
4. Configure signed Clerk subscription/item/paid-payment/membership/org lifecycle
   events; verify real delivery and repeat/late-event behavior in test orgs.
5. Verify OWNER vs ADMIN provider billing permissions and Supabase policies.
   These are blockers to those specific security guarantees, not solved by UI gates.
6. Check trial creation, extra-org zero allocation, renewals/rollover,
   cancellation preservation, membership revocation, switching, stale edits,
   interruption/reload, and member-specific GitHub targets in a safe test setup.
7. Monitor provider sync failures, post-commit cleanup, lease conflicts/expiry,
   tracking warnings, and balance reconciliation. Do not test by replaying real
   payments or pushing a real repo without explicit approval.

## Prevention principles

- Type annotations are not request validation; missing filters must fail closed.
- Treat server actions as public endpoints, internal cleanup as internal code.
- Current provider truth outranks delayed event payloads; sync one direction.
- Credit grants need persistent uniqueness and atomic increments, not balance reset.
- Client context/progress is not database truth; version commits against a revision.
- Separate committed success from fallible cleanup and uncertain response delivery.
- Scope destructive metadata by every relevant identity: org/project/user/repo/branch.
- Passing fixtures and a build are evidence with limits, not proof of deployment.
