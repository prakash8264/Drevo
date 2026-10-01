# Drevo — Documentation

These guides describe the current organization-based application. Last reviewed
against the source on **2026-10-01**. Implementation descriptions are not proof of
a live deployment or provider configuration.

## Index

1. [01-overview.md](./01-overview.md) — Features, stack, credit policy, limitations.
2. [02-architecture.md](./02-architecture.md) — Structure, ownership, models, environment, and state management.
3. [03-files-reference.md](./03-files-reference.md) — Important files and their responsibilities.
4. [04-functions-reference.md](./04-functions-reference.md) — Action/helper signatures and API contracts.
5. [05-workflows.md](./05-workflows.md) — Generation, edits, versions, billing, invitations, switching, and GitHub flows.
6. [06-troubleshooting.md](./06-troubleshooting.md) — Earlier integration problems and current operational guidance.
7. [07-github-integration.md](./07-github-integration.md) — OAuth, exports, push algorithms, and target-specific tracking.
8. [08-ai-agent-deep-dive.md](./08-ai-agent-deep-dive.md) — Providers, tools, retries, SSE, cancellation, and transactional saves.
9. [09-multi-tenancy.md](./09-multi-tenancy.md) — Organization roles, Clerk synchronization, credits, migrations, and safe operations.
10. [10-audit-findings-and-fixes.md](./10-audit-findings-and-fixes.md) — Audit findings, root causes, fixes, evidence, and unresolved risks.
11. [11-text-patch-version-history.md](./11-text-patch-version-history.md) — Text patches, checkpoints, exact reconstruction, safe retention, tests, and rollout.

## Reading paths

- **New to the project:** 01 → 02 → 05.
- **Working on a feature:** 03 → 04 → the relevant deep dive.
- **Reviewing security/billing:** 09 → 10.
- **Working on history/storage:** 11 → source/tests linked there.
- **Preparing deployment:** root [README](../README.md), 09 migrations, then 10 rollout checklist.

## Important distinctions

- Clerk owns identity, provider membership, and subscriptions. Prisma mirrors
  organization membership/plan and stores projects, balances, and grant receipts.
- Credits belong to an **organization**, not to `User`; GitHub credentials
  belong to the **user**, not to the organization.
- React hooks and existing providers manage client state. The organization-scoped
  credit event bus is display-only, not a billing authority. Zustand is not needed
  for the current implementation.
- The October fixes are implemented in source and tested locally. Open
  provider/configuration risks and deferred findings are explicitly marked in 10.
- Historical troubleshooting notes are retained as history, not instructions to
  undo current security safeguards or mutate live data.
