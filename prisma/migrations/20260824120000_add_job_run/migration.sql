-- Source-only JobRun foundation for Platform Core V1 Stage 1A.
-- Do not apply against production from this worktree.

CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "lockKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorClass" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "provenance" JSONB,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JobRun_idempotencyKey_key" ON "JobRun"("idempotencyKey");
CREATE INDEX "JobRun_jobType_scope_idx" ON "JobRun"("jobType", "scope");
CREATE INDEX "JobRun_fingerprint_idx" ON "JobRun"("fingerprint");
CREATE INDEX "JobRun_lockKey_idx" ON "JobRun"("lockKey");
CREATE INDEX "JobRun_status_idx" ON "JobRun"("status");
CREATE INDEX "JobRun_createdAt_idx" ON "JobRun"("createdAt");
