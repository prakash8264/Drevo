# Drevo — AI Website Builder

Drevo turns a prompt into a React application with a live Sandpack preview.
Users can iterate through chat, ask AI to fix preview errors, restore versions,
export a ZIP, and push saved projects to their own GitHub repositories.

## Documentation

Start with the [documentation index](./docs/README.md).

- [Overview and stack](./docs/01-overview.md)
- [Architecture, environment, and state management](./docs/02-architecture.md)
- [Organization access and billing](./docs/09-multi-tenancy.md)
- [Audit findings: causes, fixes, and remaining work](./docs/10-audit-findings-and-fixes.md)
- [Text-patch history: implementation and safe rollout](./docs/11-text-patch-version-history.md)
- [Troubleshooting](./docs/06-troubleshooting.md)

## Main features

- Gemini first-generation output; Gemini, NVIDIA Nemotron 3 Ultra (free), or Atria for follow-up edits.
- Sandpack preview and source viewer; AI-assisted runtime-error recovery.
- Organization-owned projects, subscriptions, and shared credits.
- Clerk authentication, organization invitations, and organization checkout.
- Checkpoint/text-patch version history with revision-checked, free restores.
- ZIP export and user-owned GitHub OAuth; safe, non-forced pushes.
- Light/dark themes and persistent multi-organization selection.

## Local setup

1. Install dependencies with `npm ci`. The `postinstall` script generates the
   Prisma client in `lib/generated/prisma`.
2. Configure the environment described in
   [02-architecture.md](./docs/02-architecture.md#environment). Use a dedicated
   development database and matching Clerk instance; never commit secrets.
3. Review the migration history and apply pending migrations to that database
   with `npx prisma migrate deploy`. Prisma CLI uses `DIRECT_URL`; application
   queries use `DATABASE_URL`.
4. Start `npm run dev` and open <http://localhost:3000>.
5. Configure Clerk invitations, organization plans, and signed webhook delivery
   for your environment. GitHub and the optional editing providers require their
   own credentials.

The host application uses Next.js **16.3.8**, React **19.2.8**, Prisma **7.10.0**,
and PostgreSQL. Production builds use **webpack**, not Turbopack, to avoid the
previous deployment-specific Google-font resolution failure.

## Checks

```bash
npm test
node node_modules/typescript/bin/tsc --noEmit --incremental false
npx prisma validate
npm run lint
npm audit
npm run build
```

Do not run the standalone TypeScript check at the same time as a build: Next.js
regenerates `.next/types`, which can cause temporary missing-file errors.

The standard regression suite is isolated: it uses mocks and in-memory
PostgreSQL, not production credentials. Other scripts in `scripts/` are **not**
automatically safe; see [the operational warnings](./docs/09-multi-tenancy.md#scripts-and-operational-safety).

## Credit policy

| Plan | Allocation | App-listed monthly price |
|---|---|---|
| Free | One 10-credit trial per user, in the initial personal organization | $0 |
| Starter | 50 credits per confirmed monthly paid period | $20 |
| Pro | 150 credits per confirmed monthly paid period | $29 |

Additional organizations start with zero credits. Paid allowances are additive
and deduplicated; unused credits roll over. Cancellation/downgrade does not
subtract an existing balance. Successful saved AI work costs one shared credit;
no-op edits, failed saves, GitHub pushes, exports, and restores do not.
Clerk's configured plan price is authoritative for an actual purchase.

## October 2026 release and rollout

The code includes the additive migration
`prisma/migrations/20261001090000_security_billing_persistence/migration.sql`.
It preserves balances and history, adds grant receipts/revisions/push-target
tracking/AI leases, and marks existing users as already trial-allocated.
Existing paid plans are recorded as a baseline to avoid re-awarding a historical
period. Legacy global GitHub metadata is preserved but is not assigned to a
guessed member/repository/branch.

Before rollout, back up the intended database, review the migration, apply it
with `npx prisma migrate deploy`, and deploy compatible application code. Do
not reset the database, use `prisma db push` as a substitute, or replay real
billing events as a test. Verify webhook delivery and renewals in a test
organization. Paid or unresolved subscriptions block organization deletion.

Text-patch history adds the separate additive migration
`prisma/migrations/20261001130000_text_patch_version_history/migration.sql`.
It preserves legacy snapshots and current full project data. Apply it before
using the new history code; do not run old history readers/pruners alongside
delta-writing code or roll back to them after deltas exist. See the
[history rollout guide](./docs/11-text-patch-version-history.md#7-migration-and-rollout).

At the end of the fix session, 58 regression tests, TypeScript, Prisma
validation, the production build, and changed-file ESLint passed. During the
documentation refresh on **2026-10-01**, all 58 tests passed again and
`npm audit` reported zero vulnerabilities. Repository-wide lint still had
pre-existing errors in the animated background and an unused homepage import;
see the [validation record](./docs/10-audit-findings-and-fixes.md#validation-record).

**Implemented does not mean deployed.** No live migration or deployment was
performed in the fix session, and live rollout status was not checked during
this documentation update. Provider-level OWNER-only billing, real billing
lifecycle behavior, and Supabase Storage authorization still require separate
verification. Clerk's default `org:admin` represents both local OWNER and ADMIN;
the app's checkout preflight alone cannot enforce that distinction in Clerk's
own billing interfaces.
