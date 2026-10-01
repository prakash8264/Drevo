# 04 — Functions and API Reference

Last reviewed: **2026-10-01**. Client IDs are not authority: routes/actions derive
the user from Clerk and validate organization membership on the server.

## Workspace and project actions

| Function / file | Contract |
|---|---|
| `getWorkspaceUser(workspaceId?)` — `actions/workspace.ts` | Authenticated user plus org ID/name/role/plan/credits and GitHub connection boolean/username. A supplied workspace selects **its** authorized org context; otherwise use the validated active org. |
| `getWorkspaceById(workspaceId)` — `actions/workspace.ts` | Validate ID, authenticate, load a membership-authorized project. Return files/messages/revision and current user's latest `GithubPushTarget` link fields; dates serialized. |
| `getUserProjects()` — `actions/projects.ts` | Active-org projects, newest updated first; first prompt snippet, timestamps, message count. |
| `deleteProject(workspaceId)` — `actions/projects.ts` | Validate exact ID; OWNER/ADMIN only. Delete filter includes project, org, and managing membership. Revalidate `/projects`; cascade project history/targets. |
| `getVersions(workspaceId)` — `actions/versions.ts` | Validate ID and org access; membership-scoped version summaries, newest first, no file payloads. |
| `restoreVersion(workspaceId, versionId, expectedRevision)` — `actions/versions.ts` | Validate IDs/revision, authorize, lock/reconstruct/check hashes, compare revision, record DB files as `Before restore`, replace full files and increment revision atomically. Return detail plus new revision. Free. |

These are callable server actions, not trusted internal helpers. Unauthorized
reads redirect; invalid arguments/forbidden mutations can throw. There is no
public `pruneVersions` action.

## Organization helpers

| Helper | Responsibility |
|---|---|
| `checkUser()` — `lib/checkUser.ts` | Request-local identity/context load, one-read fast path, profile provisioning only when needed; no billing top-up logic. |
| `ensurePersonalOrganization(userId)` — `lib/org.ts` | Repair valid selection or serialize initial org creation under user-row lock. Claim `trialCreditsGrantedAt` once; provision Clerk counterpart with actual Clerk creator/private link metadata. |
| `getActiveOrganization()` — `lib/org.ts` | Cached per request, authenticate and validate persisted selection against memberships; conditional pointer repair. |
| `getMembershipForOrganization(id)`, `requireOrganizationRole(id, allowedRoles)` — `lib/org.ts` | Validate target ID, check caller membership/role rather than client role. |
| `getClerk()` — `lib/clerk.ts` | Backend Clerk client. |
| `toClerkRole(role)` / `toPrismaRole(role)` — `lib/clerk.ts` | OWNER/ADMIN → `org:admin`; MEMBER → `org:member`; inbound admin → ADMIN unless sync preserves an existing authorized OWNER. |
| `toDrevoPlan(slug)` — `lib/clerk.ts` | Supported exact Free/Starter/Pro names and org aliases, unknown → Free; no substring grant of a paid tier. |
| `syncClerkMemberships(clerkOrgId, clerkUserId?, activate = false)` — `lib/membership-sync.ts` | Paginate current provider membership under org-row lock; upsert users/roles, remove missing scoped members, repair revoked selection. Return counts/org ID, or null if unlinked. Optional activation is used for invitation completion. |
| `subscriptionOrgId(data)` — `lib/billing.ts` | Extract payer org from `payer.organization_id`, `organization_id`, or `organization.id`. |
| `syncOrgPlan(clerkOrgId, paidPeriods = [])` — `lib/billing.ts` | Authoritative subscription selection and unique additive grants; return `{plan, credits, updated}` or null if unlinked. Provider failures throw. Historical paid periods come from verified payment events, not a public client input. |

## Organization APIs

| Endpoint | Input / behavior |
|---|---|
| `GET /api/orgs` | Authenticated user's organizations, roles, balances/plans/Clerk links, active selection. |
| `POST /api/orgs/switch` | `{organizationId}`; target membership required; persist pointer and return Clerk org link for client activation. |
| `POST /api/orgs/create` | `{name}` (1–60 trimmed chars); caller local OWNER, additional org credits **0**, provider provisioning; failures remain visible. |
| `POST /api/orgs/repair` | `{organizationId}`; verified local OWNER, exact metadata recovery or empty legacy-org creator repair only; never change billing/balance. |
| `GET /api/orgs/members` | Current active-org membership list and caller role. |
| `POST /api/orgs/members/add` | `{email, role?: "ADMIN" \| "MEMBER"}`; OWNER/ADMIN, current Clerk admin verification, pending invite check, Clerk invitation email. Existing provider membership uses shared authoritative sync. |
| `PATCH /api/orgs/members/role` | `{memberId, role: "ADMIN" \| "MEMBER"}`; no own-role or OWNER changes; lock/recheck and update Clerk before Prisma. |
| `DELETE /api/orgs/members/remove` | `{memberId}`; manager removal or self-leave, sole-OWNER protection; Clerk-first, local removal and conditional selection repair. |
| `POST /api/orgs/invitations/complete` | `{clerkOrgId}`; current authenticated Clerk membership required; mirror and select accepted org. No membership is granted from the ID alone. |
| `POST /api/orgs/sync` | OWNER/ADMIN; current active linked org; reconcile additions, roles, **and removals**. |
| `DELETE /api/orgs/delete` | `{organizationId}`; OWNER, no other local/provider members, current provider access, billing resolved/ended; Clerk-first deletion, then local cascade/pointer repair. |
| `POST /api/orgs/billing/checkout` | `{clerkOrgId}`; OWNER and matching persistent Prisma selection, session org, and client org; preflight before Clerk drawer. |
| `POST /api/orgs/billing/sync` | No client plan/balance; fetch active org provider state and call `syncOrgPlan`. Provider failure → 503, not Free. |

Auth/role/context failures use redirects or endpoint-specific 401/403/404/409;
provider failures are surfaced as retryable errors rather than silently
changing local entitlements. See source for exact response shapes.

## AI request contracts

### `POST /api/gen-ai-code`

```ts
{
  orgId: string;
  workspaceId?: string | null;
  revision?: number; // required for an existing project
  messages: Message[];
  fileData?: FileData | null;
}
```

Clerk determines identity. New-project creation requires OWNER/ADMIN in the
matching active org; an existing project requires membership in its org and the
expected revision. Parse/screen, check credits, acquire lease, generate valid
full-project JSON, validate packages/cancellation, commit via `saveAiWorkspace`.

### `POST /api/improve`

```ts
{
  workspaceId: string;
  revision: number;
  userRequest: string;
  imageUrl?: string;
  messages?: Message[];
  fileData: FileData;
  model?: "gemini" | "qwen" | "atria";
}
```

Existing-project membership and revision required. Same screening/lease/credit
preflight as generation. Run patch tools, classify completion, return no-op free
or commit valid changed work through `createFinishRun` / `saveAiWorkspace`.
Unsupported model values fail request validation; missing provider keys return
configuration errors before provider work.

### Guards and shared helpers

| Helper — `lib/ai-request.ts` | Behavior |
|---|---|
| `GenerateRequestSchema`, `ImproveRequestSchema` | Validate body fields, IDs, model allowlist, existing-workspace revision. |
| `FileDataSchema`, `GeneratedOutputSchema` | Nonempty safe file map, string code, bounded deps/title/output; generation also requires assistant text. |
| `validateApp(data)` | Require valid shape plus nonempty `/App.js` with `export default`. **Not** a compiler or runtime correctness proof. |
| `readAiBody(request)` | Body-size checks around parsing (10,000,000 bytes); host ingress limits are still useful. |
| `protectAi(request, body, clerkId, prompt)` | Shared Arcjet rate/prompt screen; denial → free 429. |
| `acquireAiLease(userId, workspaceId?)` | Atomically claim user/existing-workspace leases; conflict → error/409; return token-scoped best-effort release function. |
| `aiErrorMessage(error)` | Expose known no-charge validation/save messages; sanitize unexpected errors. |

Current schema bounds: up to 300 files, 1,000,000 characters of code per file,
8,000,000 aggregate code characters; 80 dependencies; 1–1,000 history messages
with at most 40,000 characters per message. GitHub separately checks UTF-8 bytes.

`saveAiWorkspace(args)` in `lib/workspace-save.ts` rechecks access/revision,
snapshots **DB state**, and charges `Organization.credits` in one transaction.
Return: `{workspaceId, revision, creditsRemaining}`. Its internal pruning uses
`pruneVersionsBestEffort(id)` from `lib/versions.ts`; retention is scoped and is
not exposed as a server action.

Internal history helpers in `lib/versions.ts` are `createWorkspaceVersion(tx,
workspaceId, fileData, summary)`, `readVersionFileData(tx, workspaceId, versionId)`,
and `lockWorkspaceHistory(tx, workspaceId)`. Reconstruction requires authorized,
locked transaction callers. The codec in `lib/version-data.ts` chooses and
verifies checkpoint/text-delta payloads. See [11](./11-text-patch-version-history.md).

### Agent module interfaces

- `createImproveTools(state, emitFilePatch)` → update-file, dependency, completion tools.
- `buildAgentInstructions(...)`, `buildAgentInput(...)`, `buildFileContext(...)`
  → bounded conversation/file instructions. Image references are URL text.
- `runAgentWithRetries(args)` → `{steps, finalText, streamError}` or null for
  cancellation. Three overload attempts with fresh state; SDK retries disabled.
- `createFinishRun(args)` → finalization callback; validate before/after package
  lookup and cancellation, shared save, emit summary/partial/credits/revision.
- `diffPaths(current, base)` → added/edited paths; dependency differences are
  checked separately for no-op detection.
- Error helpers in `errors.ts` match nested statuses/causes and `Retry-After`.
  Quota/overload failures are not blindly retried or relabeled as step exhaustion.

## AI SSE responses

| Event | Fields |
|---|---|
| `status` | `message` |
| `thinking` | `text` (editing) |
| `file_patch` | `path`, `code`, `reason` (editing progress; not a commit receipt) |
| `done` | `fileData`, `creditsRemaining`, `revision`; generation adds `workspaceId`, `assistantMessage`; editing adds `summary`, `partial` |
| `error` | `message`, optional `code`, `retryAfter` |

Before opening the SSE stream, invalid requests → 400; no identity → 401; no
access/project → 404/403 as applicable; no credits → 402; stale revision or
already-running lease → 409; rate/prompt denial → 429. Failures after streaming
starts are SSE events, not a new HTTP status.

`done` can be a free no-op. Saved changed work costs one credit; a valid retained
partial edit can also cost one. Cancellation observed before commit rolls back;
loss of the response after commit must be reconciled, not assumed free.

## Signed webhook

`POST /api/webhooks/clerk` requires `svix-id`, `svix-timestamp`,
`svix-signature`, and `CLERK_WEBHOOK_SECRET`. Verify **original raw bytes**,
then parse. Svix v2 verification returns no event payload.

- `subscription.*`, `subscriptionItem.*`, `paymentAttempt.paid` → current plan
  sync; eligible verified paid payloads also supply delayed grant periods.
- `organizationMembership.*`, `organizationInvitation.accepted` → current
  provider membership sync, not a blind event-role upsert.
- `organization.created` → exact private `drevoOrganizationId` link only.
- `organization.deleted` → verify provider 404 before local deletion.

Missing/invalid signature → 400, missing secret/processing failure → 500,
handled/ignored event → `{ok: true}`. Events lacking an extractable payer org
are logged and skipped; review payloads/delivery rather than assuming sync.

## GitHub and export

| Interface | Behavior |
|---|---|
| `GET /api/github/connect` | Clerk auth, OAuth state cookies, redirect to GitHub. |
| `GET /api/github/callback` | Validate state/code, exchange token, encrypt/store account credentials, return to workspace. |
| `GET /api/github/status` | `{connected, username}`; never token. |
| `DELETE /api/github/disconnect` | Clear credentials only. |
| `GET /api/github/repos?search=` | Connected user's own-repo list; up to two 100-entry pages. |
| `GET /api/github/branches?repo=owner/name` | Validate own-repo owner and list branches, capped at 100. |
| `POST /api/github/push` | `{workspaceId, mode?: "create" \| "existing", repoName?, isPrivate?, repoFullName?, branch?, commitMessage?}`; rebuild files from DB, verify org membership and user's GitHub target, never force-push. |

Push success: `{repoUrl, fullName, branch, unchanged?, trackingSaved}`.
`trackingSaved: false` means GitHub succeeded but local target history could not
be saved. Clients show a warning, not a false remote-failure toast.

`recordPush(...)` is route-internal; history is keyed by project/user/lowercase
repo/branch. `pushToExisting(...)` obtains only that target's prior paths; remote
ref conflicts → `BRANCH_DIVERGED`. Rate limit is distinguished from invalid
credentials and repository permission denial. Full algorithm: [07](./07-github-integration.md).

`lib/export-project.ts`: `buildProjectFiles`, `buildProjectFilesFromFileData`,
`exportZipName`, base dependencies/scaffold constants. Both ZIP and push use the
same safe-path builder.

`lib/github-push-client.ts`: `pushToGithub`, `listGithubRepos`,
`listGithubBranches`; shared by dialog and quick update.

## Client credit notifications

`emitCredits(credits, orgId)` / `subscribeCredits(orgId, callback)` in
`lib/credits-bus.ts`: display-only organization-scoped events. `WorkspaceClient`
owns optimistic decrement/refund and authoritative completion; fresh server
props and interrupted-stream refresh reconcile it. A client balance never
authorizes spending.
