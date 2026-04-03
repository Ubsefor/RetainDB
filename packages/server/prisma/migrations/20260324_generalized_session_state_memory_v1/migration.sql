ALTER TABLE "memories"
  ADD COLUMN IF NOT EXISTS "taskId" TEXT;

ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "taskId" TEXT;

CREATE INDEX IF NOT EXISTS "memories_taskId_idx"
  ON "memories"("taskId");

CREATE INDEX IF NOT EXISTS "sessions_taskId_idx"
  ON "sessions"("taskId");
