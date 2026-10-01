# Text-patch version history

Implemented on **2026-10-01**. This describes the source implementation, not a
claim that the migration or application has been deployed to a live environment.

## 1. What changed—and what did not

Previously, every `WorkspaceVersion.fileData` contained another full project.
Small edits to one large file therefore duplicated almost all of its code.
New historical versions can store **unified text patches** instead, with full
checkpoints to keep reconstruction bounded and independent of mutable data.

- `Workspace.fileData` still contains the **complete latest project** as JSONB.
- Sandpack, AI context, ZIP export, and GitHub push still receive full files.
- Existing version IDs and full-snapshot payloads remain readable unchanged.
- History still represents the database state **before** an AI edit or restore.
- All members can restore their organization's projects; restores remain free.
- AI files, messages, history, revision increment, and credit deduction still
  commit or roll back together. No billing/credit allocation policy changed.
- The retention target remains **20 historical versions per workspace**.

This optimizes historical file data, not current files, chat messages, images,
or exported projects. Restoring files does not rewind messages, billing, GitHub
tracking, or the separate `Workspace.title` column.

## 2. Implementation files

| File | Responsibility |
|---|---|
| [`lib/version-data.ts`](../lib/version-data.ts) | Canonical JSON, SHA-256 hashes, text-patch creation/application, snapshot fallback |
| [`lib/versions.ts`](../lib/versions.ts) | Locked transactional history writes, bounded reconstruction, dependency-safe pruning |
| [`lib/workspace-save.ts`](../lib/workspace-save.ts) | Shared generation/improvement save; record the database's pre-edit files in the same credit transaction |
| [`actions/versions.ts`](../actions/versions.ts) | Authorized summary listing and revision-checked, undoable restores |
| [`prisma/schema.prisma`](../prisma/schema.prisma) | Checkpoint/delta fields and same-workspace base relation |
| [`20261001130000_text_patch_version_history/migration.sql`](../prisma/migrations/20261001130000_text_patch_version_history/migration.sql) | Additive schema changes, legacy file-count backfill, storage check and foreign key |
| [`scripts/test-version-history.cjs`](../scripts/test-version-history.cjs) | Actual-source codec, action/save, migration, pruning, corruption, and rollback tests |

`diff@8.0.4` was already present through shadcn. It is now a pinned direct
dependency because production history code imports it; no custom diff engine
or separate patch service was added.

## 3. Stored records

Every record keeps its ID, workspace, summary, and creation timestamp. New fields:

| Field | Checkpoint (`kind = snapshot`) | Delta (`kind = delta`) |
|---|---|---|
| `fileData` | Complete project JSON | SQL NULL; no duplicate project |
| `delta` | SQL NULL | Changed files plus non-file metadata |
| `baseVersionId` | NULL | Specific immutable historical version ID |
| `chainDepth` | 0 | 1–4 |
| `contentHash` | Result SHA-256; NULL for untouched legacy records | Result SHA-256, required |
| `fileCount` | Number of project files | Number after reconstruction |
| `formatVersion` | 1 | 1 |

The composite foreign key `(baseVersionId, workspaceId)` references
`(id, workspaceId)`. A patch cannot use a base belonging to another workspace,
including another organization's workspace. `NO ACTION` prevents deletion of
a needed base; deleting an entire project's chain via cascade remains supported.
A SQL check rejects inconsistent checkpoint/delta field combinations and depths.

The delta JSON has this structure (hashes and patch text abbreviated):

```json
{
  "baseHash": "sha256-of-the-entire-base-project",
  "files": {
    "/App.js": { "op": "patch", "patch": "Index: file\n...unified diff..." },
    "/new.css": { "op": "replace", "value": { "code": ".new { color: green; }" } },
    "/removed.js": { "op": "delete" }
  },
  "metadata": {
    "dependencies": { "react": "19" },
    "title": "Updated app"
  }
}
```

`metadata` contains the complete current set of non-`files` properties, rather
than merging it into the base. This preserves dependency removals, a removed
title, and legacy extra JSON fields without leaving stale values behind.
Unchanged files do not appear in the delta. Added files use `replace`; file
deletions use `delete`. Changed files use a text patch when smaller, otherwise
their full replacement. A file's extra metadata changing also uses replacement.

## 4. Writing a version

For an existing workspace, both AI save routes call `saveAiWorkspace`:

1. Validate the final output, check cancellation, lock the organization, and
   verify current membership and expected workspace revision.
2. Read the pre-edit files **from the database**, not the browser's AI context.
3. Conditionally update the workspace's full files/messages and revision.
4. `createWorkspaceVersion` locks history using the shared organization →
   workspace row-lock order and finds the newest historical record.
5. Reconstruct that record when it is an eligible base, and compare it with the
   database's pre-edit files. The resulting patch points to the historical
   record—not to the mutable `Workspace.fileData`.
6. Persist the checkpoint/delta and deduct one credit with the existing guarded
   credit update. Check cancellation before completion and commit together.
7. Run dependency-safe pruning after commit. A cleanup failure is logged, not
   reported as an unsuccessful or uncharged generation.

First generation creates the current workspace but has no pre-edit version.
The first historical record is a checkpoint. At most four deltas may follow a
checkpoint; reaching depth four forces the next version to be a new checkpoint.
This bounds reconstruction to **five records**, even before pruning runs.

### Choosing patches versus full data

- Text patches are line-based unified diffs with three context lines.
- Each diff has a 50 ms calculation timeout and a 1,000-line edit-distance cap.
- A 250 ms wall-clock budget bounds starting further diffs within one version;
  a diff already started can finish its own timeout window. This does not cap
  JSON serialization, hashing, patch verification, or database time.
- Timeout/edit-distance exhaustion uses replacement instead of rejecting valid
  code. A large single-line rewrite may also be better stored as replacement.
- A text patch is selected only when its serialized operation is smaller than
  replacement and applying it reproduces the exact target string.
- The entire delta must be more than **128 UTF-8 JSON bytes smaller** than the
  full project. Otherwise store a full checkpoint. This allows margin for base
  reference overhead; it is not a PostgreSQL disk-size estimate.
- Unknown legacy file shapes fall back to checkpoints without being stripped.

These are bounded optimization attempts, not requirements that every edit be a
patch. Large rewrites and tiny projects can legitimately produce checkpoints.

## 5. Reading and restoring

`getVersions` reads IDs, summaries, stored file counts, and timestamps only.
It does not fetch full files or reconstruct every entry just to show the list.
The API remains membership-scoped with deterministic newest-first ordering.

`restoreVersion(workspaceId, versionId, expectedRevision)`:

1. Validates IDs/revision and checks organization membership.
2. Locks organization and workspace inside the restore transaction; requires the
   current revision. History writers and pruners cannot change that chain while
   it is being reconstructed.
3. Resolves only records with the exact workspace ID; follows immutable base
   references to a checkpoint, then applies deltas in order.
4. Verifies snapshot checksums when present, each delta's base checksum, and
   each reconstructed result checksum. Rejects cycles, missing bases, unsupported
   formats, or inconsistent chain depths.
5. Replaces the workspace with complete reconstructed files and increments its
   revision. Membership is checked again in the conditional update.
6. Records the previous database files as `Before restore` in the same
   transaction, using the same checkpoint/delta policy. No credits are deducted.
7. Commits, prunes best-effort, and returns full file data plus the new revision.

Hashes use SHA-256 of recursively key-sorted JSON. Object-key order from JSONB
does not affect the checksum; code, Unicode, CRLF/LF, final newlines, arrays,
dependency values, and extra metadata do. Patch application uses `fuzzFactor: 0`
and disables automatic newline conversion. Base and result hashes guarantee
that an incorrect result cannot silently become a restored project.

Untouched legacy snapshots have no checksum. They remain readable under their
original format; creating or promoting a checkpoint computes a checksum.
Checksums detect damage, but are not signatures or protection against a database
writer that can maliciously change both content and its hashes.

## 6. Safe retention

The old “delete everything after the newest 20” algorithm would break dependent
patches. `pruneVersions` now runs one locked transaction:

1. Order this workspace's history by timestamp descending, then ID descending.
   New writes use a timestamp later than the previous record, including saves
   within the same millisecond or a backwards application-clock adjustment.
2. Keep the newest 20 and walk retained records from oldest to newest.
3. If a retained delta needs a base outside that retained set, reconstruct it
   **before deleting anything**, then promote it to a checkpoint. Its public ID,
   summary, timestamp, file count, and logical content remain unchanged.
4. Update affected retained descendants' chain depths relative to the promoted
   checkpoint. Their base IDs, patches, and hashes remain valid because the
   checkpoint's logical content did not change.
5. Delete only overflow IDs belonging to this exact workspace and commit.

Normally only the oldest retained delta needs promotion. The implementation
also handles multiple boundary dependencies. If reconstruction or deletion
fails, promotion/depth updates/deletion roll back together. Best-effort cleanup
can temporarily leave more than 20 records; the next successful save/restore
retries cleanup. No public pruning server action was added.

## 7. Migration and rollout

The migration leaves every existing version payload/ID intact, labels it a
checkpoint, and backfills `fileCount`. It does **not** rewrite old history as
patches, delete history during migration, touch current workspace files, or
change organizations, balances, grants, or membership. Normal 20-version
retention still applies to old and new history after subsequent saves/restores.

Before deployment:

1. Back up the intended database and confirm `DIRECT_URL` points to it.
2. Test the migrations and application together on a staging database. Check a
   legacy restore, several edits, an undoable restore, and retention beyond 20.
3. Quiesce old application writers/readers during cutover. Apply pending
   migrations with `npx prisma migrate deploy`, and deploy the compatible app
   with its regenerated Prisma client (`npm ci` runs generation).
4. Resume traffic only after the new application is ready. Monitor history/AI
   transaction errors and `[versions] post-commit pruning failed` logs.

**Do not roll back to old application history readers/pruners once deltas exist.**
Old code expects every `fileData` to be a full snapshot. A rollback would need a
separately reviewed, transactional materialization of all deltas into full
checkpoints first. No conversion/rollback utility is included in this change.
Do not use database reset, destructive column removal, or `prisma db push` as a
substitute for the migration history. No live migration/deployment was run as
part of this implementation.

## 8. Tests and storage expectations

Run the isolated history suite or all regressions:

```bash
node --test scripts/test-version-history.cjs
npm test
```

The history suite loads actual TypeScript source with isolated dependencies and
uses in-memory PostgreSQL (PGlite), including the real SQL migrations. It covers
Unicode and newline exactness, file/dependency/title additions/removals, legacy
metadata, snapshot/replacement fallbacks, corrupt patches/hashes, missing/cyclic
bases, unsupported formats, checkpoint depth, repeated pruning, legacy/new
restores, stale concurrent saves, charge rollback, cross-workspace foreign keys,
and full project/organization cascades. The broader security suite retains
cancellation, access-revocation, and post-commit cleanup-failure checks.

PGlite's Prisma-shaped test adapter verifies source transaction boundaries and
SQL constraints; it is not a live Prisma/provider integration or a multi-client
PostgreSQL lock-contention test. Staging integration checks remain necessary.

Implementation validation passed: **72 tests** (14 in the history suite),
standalone TypeScript, Prisma validation/generation, webpack production build,
changed-file ESLint, local documentation links, and the production action
manifest check. `npm audit` reported zero vulnerabilities. Internal history
helpers are not exposed as public server actions; repository-wide pre-existing
lint findings remain outside this change.

Savings depend on actual changes. A small edit in a large multiline `/App.js`
can avoid most historical duplication; replacing most of that file may save
little. Checkpoints and boundary promotions necessarily retain some full data.
The size decision measures logical UTF-8 JSON bytes, not compressed PostgreSQL
TOAST/index/WAL/backups. No production storage reduction has been measured or
promised, and old snapshots are not retroactively compressed by this migration.
