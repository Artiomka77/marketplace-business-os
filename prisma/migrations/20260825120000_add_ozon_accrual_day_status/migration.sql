-- Durable Ozon accrual-by-day canonical finality per company/date.
-- Do not apply against production from this worktree.

CREATE TABLE "OzonAccrualDayStatus" (
    "id" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "importSessionId" TEXT NOT NULL,
    "dataMode" TEXT NOT NULL,
    "coverageComplete" BOOLEAN NOT NULL DEFAULT false,
    "quarantineCount" INTEGER NOT NULL DEFAULT 0,
    "missingEvidence" JSONB NOT NULL,
    "payloadSha256" TEXT,
    "phase" TEXT NOT NULL DEFAULT 'RAW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OzonAccrualDayStatus_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OzonAccrualDayStatus_companyName_date_key" ON "OzonAccrualDayStatus"("companyName", "date");
CREATE INDEX "OzonAccrualDayStatus_companyName_date_idx" ON "OzonAccrualDayStatus"("companyName", "date");
CREATE INDEX "OzonAccrualDayStatus_importSessionId_idx" ON "OzonAccrualDayStatus"("importSessionId");
