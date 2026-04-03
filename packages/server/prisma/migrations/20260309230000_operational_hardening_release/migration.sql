DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SourceVersionStatus') THEN
    CREATE TYPE "SourceVersionStatus" AS ENUM ('STAGED', 'PROMOTING', 'ACTIVE', 'SUPERSEDED', 'FAILED');
  END IF;
END $$;

ALTER TABLE "sources"
  ADD COLUMN IF NOT EXISTS "activeVersionId" TEXT,
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "restoreUntil" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "source_versions" (
  "id" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "projectId" TEXT,
  "versionNumber" INTEGER NOT NULL,
  "status" "SourceVersionStatus" NOT NULL DEFAULT 'STAGED',
  "syncJobId" TEXT,
  "partialFailure" BOOLEAN NOT NULL DEFAULT false,
  "warningCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "documentCount" INTEGER NOT NULL DEFAULT 0,
  "chunkCount" INTEGER NOT NULL DEFAULT 0,
  "promotedAt" TIMESTAMP(3),
  "supersededAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "restoreUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  CONSTRAINT "source_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "source_versions_sourceId_versionNumber_key"
  ON "source_versions"("sourceId", "versionNumber");
CREATE INDEX IF NOT EXISTS "source_versions_sourceId_status_idx"
  ON "source_versions"("sourceId", "status");
CREATE INDEX IF NOT EXISTS "source_versions_syncJobId_idx"
  ON "source_versions"("syncJobId");
CREATE INDEX IF NOT EXISTS "source_versions_restoreUntil_idx"
  ON "source_versions"("restoreUntil");

ALTER TABLE "documents"
  ADD COLUMN IF NOT EXISTS "sourceVersionId" TEXT,
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

ALTER TABLE "sync_jobs"
  ADD COLUMN IF NOT EXISTS "sourceVersionId" TEXT,
  ADD COLUMN IF NOT EXISTS "partialFailure" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "warningCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "errorCode" TEXT,
  ADD COLUMN IF NOT EXISTS "traceId" TEXT,
  ADD COLUMN IF NOT EXISTS "parentTraceId" TEXT;

ALTER TABLE "webhook_deliveries"
  ADD COLUMN IF NOT EXISTS "eventId" TEXT,
  ADD COLUMN IF NOT EXISTS "action" TEXT NOT NULL DEFAULT 'deliver',
  ADD COLUMN IF NOT EXISTS "attempt" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "durationMs" INTEGER,
  ADD COLUMN IF NOT EXISTS "errorCode" TEXT,
  ADD COLUMN IF NOT EXISTS "traceId" TEXT,
  ADD COLUMN IF NOT EXISTS "parentTraceId" TEXT;

CREATE INDEX IF NOT EXISTS "sources_activeVersionId_idx"
  ON "sources"("activeVersionId");
CREATE INDEX IF NOT EXISTS "sources_deletedAt_idx"
  ON "sources"("deletedAt");
CREATE INDEX IF NOT EXISTS "documents_sourceVersionId_idx"
  ON "documents"("sourceVersionId");
CREATE INDEX IF NOT EXISTS "documents_deletedAt_idx"
  ON "documents"("deletedAt");
CREATE INDEX IF NOT EXISTS "webhook_deliveries_eventId_idx"
  ON "webhook_deliveries"("eventId");

DROP INDEX IF EXISTS "documents_sourceId_externalId_key";

ALTER TABLE "source_versions"
  ADD CONSTRAINT "source_versions_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sources"
  ADD CONSTRAINT "sources_activeVersionId_fkey"
  FOREIGN KEY ("activeVersionId") REFERENCES "source_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_sourceVersionId_fkey"
  FOREIGN KEY ("sourceVersionId") REFERENCES "source_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "source_versions" (
  "id",
  "sourceId",
  "orgId",
  "projectId",
  "versionNumber",
  "status",
  "documentCount",
  "chunkCount",
  "promotedAt",
  "restoreUntil",
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  s."id",
  s."orgId",
  s."projectId",
  1,
  'ACTIVE'::"SourceVersionStatus",
  COALESCE(s."documentCount", 0),
  COALESCE(s."chunkCount", 0),
  NOW(),
  NOW() + make_interval(days => COALESCE(o."dataRetentionDays", 90)),
  NOW(),
  NOW()
FROM "sources" s
LEFT JOIN "organizations" o ON o."id" = s."orgId"
WHERE NOT EXISTS (
  SELECT 1
  FROM "source_versions" sv
  WHERE sv."sourceId" = s."id"
);

UPDATE "sources" s
SET "activeVersionId" = sv."id"
FROM "source_versions" sv
WHERE sv."sourceId" = s."id"
  AND sv."status" = 'ACTIVE'::"SourceVersionStatus"
  AND s."activeVersionId" IS NULL;

UPDATE "documents" d
SET "sourceVersionId" = s."activeVersionId"
FROM "sources" s
WHERE d."sourceId" = s."id"
  AND d."sourceVersionId" IS NULL
  AND s."activeVersionId" IS NOT NULL;
