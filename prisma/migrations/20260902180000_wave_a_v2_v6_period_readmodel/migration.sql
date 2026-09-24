-- Wave A V2: FINANCIAL_CORE_V6_PERIOD_READMODEL_V1
-- Artifact only for production. Applied to ephemeral PG in this task.
-- PERSISTENCE_DECISION=NEW_V6_MODELS
-- PRODUCTION_MIGRATION_EXECUTED=NO
-- UNRELATED_SCHEMA_DELTA=0

CREATE TABLE IF NOT EXISTS "DailyCompanyMarketplaceMetric" (
  "id" TEXT PRIMARY KEY,
  "companyScope" TEXT NOT NULL,
  "marketplace" TEXT NOT NULL,
  "businessDate" DATE NOT NULL,
  "formulaVersion" TEXT NOT NULL,
  "dataMode" TEXT NOT NULL,
  "coverageStatus" TEXT NOT NULL,
  "sourceFingerprint" TEXT NOT NULL,
  "payloadChecksum" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "generatedAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "DailyCompanyMarketplaceMetric_companyScope_marketplace_businessDate_formulaVersion_key"
  ON "DailyCompanyMarketplaceMetric" ("companyScope", "marketplace", "businessDate", "formulaVersion");
CREATE INDEX IF NOT EXISTS "DailyCompanyMarketplaceMetric_companyScope_businessDate_idx"
  ON "DailyCompanyMarketplaceMetric" ("companyScope", "businessDate");
CREATE INDEX IF NOT EXISTS "DailyCompanyMarketplaceMetric_formulaVersion_idx"
  ON "DailyCompanyMarketplaceMetric" ("formulaVersion");
CREATE INDEX IF NOT EXISTS "DailyCompanyMarketplaceMetric_coverageStatus_idx"
  ON "DailyCompanyMarketplaceMetric" ("coverageStatus");

CREATE TABLE IF NOT EXISTS "PeriodCompanyMarketplaceMetric" (
  "id" TEXT PRIMARY KEY,
  "companyScope" TEXT NOT NULL,
  "marketplace" TEXT NOT NULL,
  "dateFrom" DATE NOT NULL,
  "dateTo" DATE NOT NULL,
  "formulaVersion" TEXT NOT NULL,
  "dataMode" TEXT NOT NULL,
  "coverageStatus" TEXT NOT NULL,
  "sourceFingerprint" TEXT NOT NULL,
  "payloadChecksum" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "meta" JSONB NOT NULL,
  "generatedAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "PeriodCompanyMarketplaceMetric_companyScope_marketplace_dateFrom_dateTo_formulaVersion_key"
  ON "PeriodCompanyMarketplaceMetric" ("companyScope", "marketplace", "dateFrom", "dateTo", "formulaVersion");
CREATE INDEX IF NOT EXISTS "PeriodCompanyMarketplaceMetric_companyScope_dateFrom_dateTo_idx"
  ON "PeriodCompanyMarketplaceMetric" ("companyScope", "dateFrom", "dateTo");
CREATE INDEX IF NOT EXISTS "PeriodCompanyMarketplaceMetric_formulaVersion_idx"
  ON "PeriodCompanyMarketplaceMetric" ("formulaVersion");
CREATE INDEX IF NOT EXISTS "PeriodCompanyMarketplaceMetric_coverageStatus_idx"
  ON "PeriodCompanyMarketplaceMetric" ("coverageStatus");
CREATE INDEX IF NOT EXISTS "PeriodCompanyMarketplaceMetric_dataMode_idx"
  ON "PeriodCompanyMarketplaceMetric" ("dataMode");