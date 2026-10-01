-- Preserve every existing payload and version ID. Old rows are checkpoints.
ALTER TABLE "WorkspaceVersion"
  ALTER COLUMN "fileData" DROP NOT NULL,
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'snapshot',
  ADD COLUMN "delta" JSONB,
  ADD COLUMN "formatVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "contentHash" TEXT,
  ADD COLUMN "fileCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "chainDepth" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "baseVersionId" TEXT;

UPDATE "WorkspaceVersion" SET "fileCount" = CASE
  WHEN jsonb_typeof("fileData" -> 'files') = 'object'
    THEN (SELECT count(*)::integer FROM jsonb_object_keys("fileData" -> 'files'))
  ELSE 0 END;

CREATE UNIQUE INDEX "WorkspaceVersion_id_workspaceId_key" ON "WorkspaceVersion"("id", "workspaceId");
CREATE INDEX "WorkspaceVersion_workspaceId_createdAt_id_idx" ON "WorkspaceVersion"("workspaceId", "createdAt", "id");
-- Composite FK prevents a patch from referencing another organization's project.
-- NO ACTION permits deleting an entire project's chain in one cascade/statement,
-- but prevents deleting a base while its dependent versions remain.
ALTER TABLE "WorkspaceVersion" ADD CONSTRAINT "WorkspaceVersion_baseVersionId_workspaceId_fkey"
  FOREIGN KEY ("baseVersionId", "workspaceId") REFERENCES "WorkspaceVersion"("id", "workspaceId")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "WorkspaceVersion" ADD CONSTRAINT "WorkspaceVersion_storage_check" CHECK (
  "fileCount" >= 0 AND "formatVersion" > 0 AND
  ("contentHash" IS NULL OR "contentHash" ~ '^[a-f0-9]{64}$') AND (
    ("kind" = 'snapshot' AND "fileData" IS NOT NULL AND "delta" IS NULL AND "baseVersionId" IS NULL AND "chainDepth" = 0)
    OR
    ("kind" = 'delta' AND "fileData" IS NULL AND "delta" IS NOT NULL AND "baseVersionId" IS NOT NULL
      AND "contentHash" IS NOT NULL AND "chainDepth" BETWEEN 1 AND 4)
  )
);
