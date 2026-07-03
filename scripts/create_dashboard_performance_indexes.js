const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('[dashboard-indexes] DATABASE_URL is required');
  process.exit(1);
}

const statements = [
  {
    name: 'idx_wb_sale_company_sale_date',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_wb_sale_company_sale_date" ON "WbSale" ("companyName", "saleDate")',
  },
  {
    name: 'idx_wb_ads_company_date_span',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_wb_ads_company_date_span" ON "WbAds" ("companyName", "dateFrom", "dateTo")',
  },
  {
    name: 'idx_wb_finance_company_date_span',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_wb_finance_company_date_span" ON "WbFinance" ("companyName", "dateFrom", "dateTo")',
  },
  {
    name: 'idx_ozon_finance_company_accrual_date',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_ozon_finance_company_accrual_date" ON "OzonFinance" ("companyName", "accrualDate")',
  },
  {
    name: 'idx_ozon_ads_company_report_date',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_ozon_ads_company_report_date" ON "OzonAds" ("companyName", "reportDate")',
  },
  {
    name: 'idx_finance_transaction_company_operation_date',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_finance_transaction_company_operation_date" ON "FinanceTransaction" ("companyName", "operationDate")',
  },
  {
    name: 'idx_product_cost_vendor_cost_date',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_product_cost_vendor_cost_date" ON "ProductCost" ("vendorCode", "costDate")',
  },
  {
    name: 'idx_ozon_realization_summary_company_date_span',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_ozon_realization_summary_company_date_span" ON "OzonRealizationSummary" ("companyName", "dateFrom", "dateTo")',
  },
  {
    name: 'idx_ozon_realization_row_company_date_span',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_ozon_realization_row_company_date_span" ON "OzonRealizationRow" ("companyName", "dateFrom", "dateTo")',
  },
  {
    name: 'idx_ozon_discount_points_summary_company_date_span',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_ozon_discount_points_summary_company_date_span" ON "OzonDiscountPointsSummary" ("companyName", "dateFrom", "dateTo")',
  },
  {
    name: 'idx_ozon_discount_points_row_company_date_span',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_ozon_discount_points_row_company_date_span" ON "OzonDiscountPointsRow" ("companyName", "dateFrom", "dateTo")',
  },
];

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  console.log('[dashboard-indexes] start');
  console.log(`[dashboard-indexes] indexes planned: ${statements.length}`);

  for (const item of statements) {
    const startedAt = Date.now();
    try {
      console.log(`[dashboard-indexes] creating/checking ${item.name}`);
      await client.query(item.sql);
      console.log(`[dashboard-indexes] ok ${item.name} ${Date.now() - startedAt}ms`);
    } catch (error) {
      console.error(`[dashboard-indexes] failed ${item.name}`);
      console.error(error);
      throw error;
    }
  }

  const existing = await client.query(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = ANY($1::text[])
    ORDER BY indexname
  `, [statements.map((item) => item.name)]);

  console.log('[dashboard-indexes] existing indexes:');
  for (const row of existing.rows) {
    console.log(`- ${row.indexname}`);
  }

  await client.end();
  console.log('[dashboard-indexes] done');
}

main().catch((error) => {
  console.error('[dashboard-indexes] fatal');
  console.error(error);
  process.exit(1);
});
