CREATE TABLE IF NOT EXISTS "wizard_events" (
  "id" TEXT PRIMARY KEY,
  "orgId" TEXT,
  "projectId" TEXT,
  "session_id" TEXT NOT NULL,
  "install_id" TEXT NOT NULL,
  "wizard_version" TEXT NOT NULL,
  "event_name" TEXT NOT NULL,
  "step" TEXT,
  "success" BOOLEAN NOT NULL DEFAULT true,
  "stack" TEXT,
  "connector" TEXT,
  "error_code" TEXT,
  "duration_ms" INTEGER,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "wizard_events_created_at_idx" ON "wizard_events"("created_at");
CREATE INDEX IF NOT EXISTS "wizard_events_event_name_created_at_idx" ON "wizard_events"("event_name", "created_at");
CREATE INDEX IF NOT EXISTS "wizard_events_orgId_created_at_idx" ON "wizard_events"("orgId", "created_at");
CREATE INDEX IF NOT EXISTS "wizard_events_session_id_created_at_idx" ON "wizard_events"("session_id", "created_at");
