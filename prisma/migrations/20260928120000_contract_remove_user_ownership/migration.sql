-- DropForeignKey
ALTER TABLE "Workspace" DROP CONSTRAINT "Workspace_createdById_fkey";

-- DropForeignKey
ALTER TABLE "Workspace" DROP CONSTRAINT "Workspace_userId_fkey";

-- DropIndex
DROP INDEX "Workspace_userId_idx";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "credits",
DROP COLUMN "plan";

-- AlterTable
ALTER TABLE "Workspace" DROP COLUMN "userId",
ALTER COLUMN "createdById" SET NOT NULL,
ALTER COLUMN "organizationId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
