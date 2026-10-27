-- R09 controlled-job fixtures for isolated Postgres (NOT production).
-- Single company only so ALL-scope D1D5 does not fail on unstaged peers.
-- Period: 2026-10-19 .. 2026-10-25

BEGIN;

DELETE FROM "DashboardPeriodSnapshotJob"
 WHERE "dateFrom" = TIMESTAMPTZ '2026-10-19 00:00:00+00'
   AND "dateTo"   = TIMESTAMPTZ '2026-10-25 00:00:00+00';

INSERT INTO "Company" ("id", "name", "taxSystem", "usnRate", "vatRate", "isActive", "createdAt", "updatedAt")
VALUES ('seed-company-petrov', 'ИП Петров', 'УСН Доходы', 1, 5, true, NOW(), NOW())
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "WbFinance" (
  "id", "companyName", "reportNumber", "dateFrom", "dateTo", "createdAt"
) VALUES (
  'seed-wb-finance-1',
  'ИП Петров',
  '37024220261019',
  TIMESTAMPTZ '2026-10-19 00:00:00+00',
  TIMESTAMPTZ '2026-10-25 00:00:00+00',
  NOW()
) ON CONFLICT ("id") DO NOTHING;

INSERT INTO "ImportSession" (
  "id", "fileName", "reportType", "marketplace", "companyName", "rowsCount", "status", "createdAt"
) VALUES (
  'seed-wb-sales-1',
  'WB weekly 37024220261019 2026-10-19 - 2026-10-25',
  'WB_SALES',
  'WB',
  'ИП Петров',
  1,
  'SUCCESS',
  NOW()
) ON CONFLICT ("id") DO NOTHING;

INSERT INTO "WbSale" (
  "id", "importSessionId", "companyName", "reportNumber", "saleDate",
  "quantity", "retailPriceWithDiscount", "wbRealizedAmount", "sellerPayout",
  "paymentReason", "documentType", "vendorCode", "nmId", "createdAt"
) VALUES (
  'seed-wb-sale-1',
  'seed-wb-sales-1',
  'ИП Петров',
  '37024220261019',
  TIMESTAMPTZ '2026-10-20 12:00:00+00',
  1,
  1000,
  1000,
  800,
  'Продажа',
  'Продажа',
  'SEED-SKU-1',
  '1000001',
  NOW()
) ON CONFLICT ("id") DO NOTHING;

INSERT INTO "ProductCost" (
  "id", "vendorCode", "nmId", "costPrice", "name", "costDate", "createdAt"
) VALUES (
  'seed-pc-1', 'SEED-SKU-1', '1000001', 200, 'Seed SKU', TIMESTAMPTZ '2026-01-01 00:00:00+00', NOW()
) ON CONFLICT ("id") DO NOTHING;

INSERT INTO "MarketplaceDailyOrderStat" (
  "id", "companyName", "marketplace", "orderDate", "ordersQty", "ordersAmount", "source", "createdAt", "updatedAt"
) VALUES (
  'seed-mdos-1', 'ИП Петров', 'WB', TIMESTAMPTZ '2026-10-19 00:00:00+00', 1, 1000, 'SEED', NOW(), NOW()
) ON CONFLICT ("id") DO NOTHING;

-- Stock/Ozon COGS coverage: proven-complete zero-sales accrual ownership for
-- each day so quantityCoverageComplete=true (costCoverageIncomplete=false).
-- reportType must be OZON_ACCRUAL_BY_DAY_API (see findOzonProductCogsRowsByPeriod).
INSERT INTO "ImportSession" (
  "id", "fileName", "reportType", "marketplace", "companyName", "rowsCount", "status", "previewJson", "createdAt"
) VALUES (
  'seed-ozon-accrual-zero-week',
  'ozon accrual by day zero fixture R10',
  'OZON_ACCRUAL_BY_DAY_API',
  'OZON',
  'ИП Петров',
  0,
  'SUCCESS',
  '{
    "dateFrom":"2026-10-19",
    "dateTo":"2026-10-25",
    "requestedDates":["2026-10-19","2026-10-20","2026-10-21","2026-10-22","2026-10-23","2026-10-24","2026-10-25"],
    "coverageComplete":true,
    "rawAccruals":[]
  }'::jsonb,
  NOW()
) ON CONFLICT ("id") DO UPDATE SET
  "previewJson" = EXCLUDED."previewJson",
  "status" = 'SUCCESS',
  "reportType" = EXCLUDED."reportType";

-- Controlled jobs (PENDING)
INSERT INTO "DashboardPeriodSnapshotJob" (
  "id", "companyScope", "dateFrom", "dateTo", "formulaVersion",
  "status", "priority", "attempts", "maxAttempts", "createdAt", "updatedAt"
) VALUES
(
  'job-profit-wb-r09',
  'ИП Петров',
  TIMESTAMPTZ '2026-10-19 00:00:00+00',
  TIMESTAMPTZ '2026-10-25 00:00:00+00',
  'FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1',
  'PENDING', 10, 0, 3, NOW(), NOW()
),
(
  'job-profit-ozon-r09',
  'ИП Петров',
  TIMESTAMPTZ '2026-10-19 00:00:00+00',
  TIMESTAMPTZ '2026-10-25 00:00:00+00',
  'FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1',
  'PENDING', 10, 0, 3, NOW(), NOW()
),
(
  'job-dash-v4-r09',
  'ИП Петров',
  TIMESTAMPTZ '2026-10-19 00:00:00+00',
  TIMESTAMPTZ '2026-10-25 00:00:00+00',
  'FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1',
  'PENDING', 10, 0, 3, NOW(), NOW()
),
(
  'job-stock-r09',
  'ИП Петров',
  TIMESTAMPTZ '2026-10-19 00:00:00+00',
  TIMESTAMPTZ '2026-10-25 00:00:00+00',
  'STOCK_PLANNING_SNAPSHOT_V3',
  'PENDING', 10, 0, 3, NOW(), NOW()
),
(
  'job-v6-r09',
  'ALL',
  TIMESTAMPTZ '2026-10-19 00:00:00+00',
  TIMESTAMPTZ '2026-10-25 00:00:00+00',
  'FINANCIAL_CORE_V6_PERIOD_READMODEL_V2',
  'PENDING', 10, 0, 3, NOW(), NOW()
)
ON CONFLICT ("id") DO UPDATE SET
  "status" = 'PENDING',
  "attempts" = 0,
  "lockedAt" = NULL,
  "lockedBy" = NULL,
  "lastError" = NULL,
  "finishedAt" = NULL,
  "updatedAt" = NOW();

COMMIT;
