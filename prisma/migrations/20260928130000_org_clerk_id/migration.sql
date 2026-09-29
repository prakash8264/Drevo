-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "clerkOrgId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Organization_clerkOrgId_key" ON "Organization"("clerkOrgId");
