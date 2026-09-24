-- Wave A finality/refresh: ensure V6 rebuild queue table exists on ephemeral targets.
-- MAIN Loans V4 already has DashboardPeriodSnapshotJob; CREATE IF NOT EXISTS is additive/safe.
-- REBUILD_QUEUE_DECISION=REUSE_SAFE_EXISTING
-- V6 jobs isolated by formulaVersion=FINANCIAL_CORE_V6_PERIOD_READMODEL_V1
-- V4 worker allowlist excludes V6 => V4_JOB_CROSS_CONSUMPTION=NO

CREATE TABLE IF NOT EXISTS "DashboardPeriodSnapshotJob" (
  "id" TEXT PRIMARY KEY,
  "companyScope" TEXT NOT NULL,
  "dateFrom" TIMESTAMP(6) NOT NULL,
  "dateTo" TIMESTAMP(6) NOT NULL,
  "formulaVersion" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "priority" INTEGER NOT NULL,
  "attempts" INTEGER NOT NULL,
  "maxAttempts" INTEGER NOT NULL,
  "lockedAt" TIMESTAMP(6),
  "lockedBy" TEXT,
  "nextAttemptAt" TIMESTAMP(6),
  "startedAt" TIMESTAMP(6),
  "finishedAt" TIMESTAMP(6),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(6) NOT NULL,
  "updatedAt" TIMESTAMP(6) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "DashboardPeriodSnapshotJob_companyScope_dateFrom_dateTo_formulaVersion_key"
  ON "DashboardPeriodSnapshotJob" ("companyScope", "dateFrom", "dateTo", "formulaVersion");
CREATE INDEX IF NOT EXISTS "DashboardPeriodSnapshotJob_formulaVersion_idx"
  ON "DashboardPeriodSnapshotJob" ("formulaVersion");
CREATE INDEX IF NOT EXISTS "DashboardPeriodSnapshotJob_lockedAt_idx"
  ON "DashboardPeriodSnapshotJob" ("lockedAt");
CREATE INDEX IF NOT EXISTS "DashboardPeriodSnapshotJob_nextAttemptAt_idx"
  ON "DashboardPeriodSnapshotJob" ("nextAttemptAt");
CREATE INDEX IF NOT EXISTS "DashboardPeriodSnapshotJob_status_priority_createdAt_idx"
  ON "DashboardPeriodSnapshotJob" ("status", "priority", "createdAt");
