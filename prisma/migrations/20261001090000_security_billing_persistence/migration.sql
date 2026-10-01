-- Additive only: preserve organization balances, projects and history.
ALTER TABLE "User" ADD COLUMN "trialCreditsGrantedAt" TIMESTAMP(3);
-- Existing users participated in the old trial policy; no second trial.
UPDATE "User" SET "trialCreditsGrantedAt" = CURRENT_TIMESTAMP;
ALTER TABLE "Organization" ALTER COLUMN "credits" SET DEFAULT 0;
ALTER TABLE "Organization" ADD COLUMN "billingBaselineAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Organization" ADD COLUMN "billingBaselinePlan" TEXT NOT NULL DEFAULT 'free';
UPDATE "Organization" SET "billingBaselinePlan" = "plan";
ALTER TABLE "Workspace" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "OrganizationCreditGrant" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "key" TEXT NOT NULL,
  "credits" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "OrganizationCreditGrant_organizationId_key_key" ON "OrganizationCreditGrant"("organizationId", "key");
CREATE TABLE "GithubPushTarget" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL,
  "repoFullName" TEXT NOT NULL,
  "branch" TEXT NOT NULL,
  "repoUrl" TEXT NOT NULL,
  "pushedFiles" JSONB NOT NULL,
  "lastPushedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "GithubPushTarget_workspaceId_userId_repoFullName_branch_key" ON "GithubPushTarget"("workspaceId", "userId", "repoFullName", "branch");
-- Preserve legacy global GitHub metadata, but do not guess its member/target.
CREATE TABLE "AiRunLease" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "token" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL
);
