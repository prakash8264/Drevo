-- AlterTable
ALTER TABLE "User" ADD COLUMN     "githubAccessToken" TEXT,
ADD COLUMN     "githubConnectedAt" TIMESTAMP(3),
ADD COLUMN     "githubUserId" TEXT,
ADD COLUMN     "githubUsername" TEXT;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "githubBranch" TEXT,
ADD COLUMN     "githubRepoFullName" TEXT,
ADD COLUMN     "githubRepoUrl" TEXT,
ADD COLUMN     "lastPushedAt" TIMESTAMP(3);
