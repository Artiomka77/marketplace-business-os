-- Wave B Profit read-model — additive schema ONLY.
-- NEVER run against production without separate owner approval.
-- NO DROP / NO TRUNCATE / NO ALTER destructive.
-- Assumes tables may already exist (IF NOT EXISTS).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'ProfitPeriodMetric'
  ) THEN
    CREATE TABLE "ProfitPeriodMetric" (
      "id" TEXT NOT NULL,
      "companyScope" TEXT NOT NULL,
      "marketplace" TEXT NOT NULL,
      "dateFrom" DATE NOT NULL,
      "dateTo" DATE NOT NULL,
      "formulaVersion" TEXT NOT NULL,
      "dataMode" TEXT NOT NULL,
      "coverageStatus" TEXT NOT NULL,
      "sourceFingerprint" TEXT NOT NULL,
      "payloadChecksum" TEXT NOT NULL,
      "totals" JSONB NOT NULL,
      "comparison" JSONB,
      "meta" JSONB NOT NULL,
      "analyticsPayload" JSONB NOT NULL,
      "generatedAt" TIMESTAMPTZ(6) NOT NULL,
      "staleAfterMs" INTEGER,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "ProfitPeriodMetric_pkey" PRIMARY KEY ("id")
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ProfitPeriodMetric_companyScope_marketplace_dateFrom_dateTo_formulaVersion_key'
  ) THEN
    ALTER TABLE "ProfitPeriodMetric"
      ADD CONSTRAINT "ProfitPeriodMetric_companyScope_marketplace_dateFrom_dateTo_formulaVersion_key"
      UNIQUE ("companyScope", "marketplace", "dateFrom", "dateTo", "formulaVersion");
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "ProfitPeriodMetric_companyScope_dateFrom_dateTo_idx"
  ON "ProfitPeriodMetric" ("companyScope", "dateFrom", "dateTo");
CREATE INDEX IF NOT EXISTS "ProfitPeriodMetric_formulaVersion_idx"
  ON "ProfitPeriodMetric" ("formulaVersion");
CREATE INDEX IF NOT EXISTS "ProfitPeriodMetric_coverageStatus_idx"
  ON "ProfitPeriodMetric" ("coverageStatus");
CREATE INDEX IF NOT EXISTS "ProfitPeriodMetric_dataMode_idx"
  ON "ProfitPeriodMetric" ("dataMode");
CREATE INDEX IF NOT EXISTS "ProfitPeriodMetric_marketplace_idx"
  ON "ProfitPeriodMetric" ("marketplace");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'ProfitSkuPeriodMetric'
  ) THEN
    CREATE TABLE "ProfitSkuPeriodMetric" (
      "id" TEXT NOT NULL,
      "companyScope" TEXT NOT NULL,
      "marketplace" TEXT NOT NULL,
      "dateFrom" DATE NOT NULL,
      "dateTo" DATE NOT NULL,
      "formulaVersion" TEXT NOT NULL,
      "productKey" TEXT NOT NULL,
      "payload" JSONB NOT NULL,
      "generatedAt" TIMESTAMPTZ(6) NOT NULL,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "ProfitSkuPeriodMetric_pkey" PRIMARY KEY ("id")
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ProfitSkuPeriodMetric_companyScope_marketplace_dateFrom_dateTo_formulaVersion_productKey_key'
  ) THEN
    ALTER TABLE "ProfitSkuPeriodMetric"
      ADD CONSTRAINT "ProfitSkuPeriodMetric_companyScope_marketplace_dateFrom_dateTo_formulaVersion_productKey_key"
      UNIQUE ("companyScope", "marketplace", "dateFrom", "dateTo", "formulaVersion", "productKey");
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "ProfitSkuPeriodMetric_period_idx"
  ON "ProfitSkuPeriodMetric" ("companyScope", "marketplace", "dateFrom", "dateTo", "formulaVersion");
CREATE INDEX IF NOT EXISTS "ProfitSkuPeriodMetric_productKey_idx"
  ON "ProfitSkuPeriodMetric" ("productKey");
CREATE INDEX IF NOT EXISTS "ProfitSkuPeriodMetric_formulaVersion_idx"
  ON "ProfitSkuPeriodMetric" ("formulaVersion");

-- Post-create verification (run separately and record results):
-- SELECT table_name FROM information_schema.tables
--  WHERE table_schema='public'
--    AND table_name IN ('ProfitPeriodMetric','ProfitSkuPeriodMetric');
