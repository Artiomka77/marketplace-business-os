const { Client } = require('pg');

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function rub(value) {
  const n = Number(value || 0);
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n);
}

const dateFrom = arg('dateFrom');
const dateTo = arg('dateTo');
const companyName = arg('companyName', 'ALL');

if (!dateFrom || !dateTo) {
  console.error('Usage: node scripts/audit_ozon_financial_category_facts.js --dateFrom=YYYY-MM-DD --dateTo=YYYY-MM-DD --companyName=ALL');
  process.exit(1);
}

const client = new Client({ connectionString: process.env.DATABASE_URL });

async function hasTable(tableName) {
  const res = await client.query(
    `SELECT to_regclass($1) AS table_name`,
    [`public.${tableName}`]
  );
  return Boolean(res.rows[0]?.table_name);
}

async function main() {
  await client.connect();

  const companyFilterSql = companyName && companyName !== 'ALL' ? 'AND "companyName" = $3' : '';
  const params = companyName && companyName !== 'ALL' ? [dateFrom, dateTo, companyName] : [dateFrom, dateTo];

  console.log('[ozon-facts-audit] start', { dateFrom, dateTo, companyName });

  console.log('\n=== OZON FINANCE BY COMPANY ===');
  const finance = await client.query(
    `
      SELECT
        "companyName",
        COUNT(*)::int AS rows,
        COALESCE(SUM("salesAmount"), 0) AS "salesAmount",
        COALESCE(SUM("totalAmount"), 0) AS "totalAmount",
        COALESCE(SUM("ozonCommission"), 0) AS "ozonCommission",
        COALESCE(SUM("logisticsCost"), 0) AS "logisticsCost",
        COALESCE(SUM("reverseLogisticsCost"), 0) AS "reverseLogisticsCost",
        COALESCE(SUM(CASE WHEN lower(COALESCE("operationType", '')) LIKE '%оплата за клик%'
          OR lower(COALESCE("operationType", '')) LIKE '%продвижение с оплатой за заказ%'
          OR lower(COALESCE("operationType", '')) LIKE '%реклам%'
          THEN ABS("totalAmount") ELSE 0 END), 0) AS "financeAds"
      FROM "OzonFinance"
      WHERE "accrualDate"::date >= $1::date
        AND "accrualDate"::date <= $2::date
        ${companyFilterSql}
      GROUP BY "companyName"
      ORDER BY "companyName"
    `,
    params
  );
  console.table(finance.rows.map((row) => ({
    companyName: row.companyName,
    rows: row.rows,
    salesAmount: rub(row.salesAmount),
    totalAmount: rub(row.totalAmount),
    ozonCommission: rub(row.ozonCommission),
    logisticsCost: rub(row.logisticsCost),
    reverseLogisticsCost: rub(row.reverseLogisticsCost),
    financeAds: rub(row.financeAds),
  })));

  if (!(await hasTable('OzonFinancialCategoryFact'))) {
    console.log('\n=== OZON FINANCIAL CATEGORY FACTS ===');
    console.log('Table OzonFinancialCategoryFact does not exist.');
    await client.end();
    return;
  }

  console.log('\n=== OZON FINANCIAL CATEGORY FACTS BY COMPANY/CATEGORY ===');
  const facts = await client.query(
    `
      SELECT
        "companyName",
        "category",
        COUNT(*)::int AS rows,
        COALESCE(SUM("amount"), 0) AS amount
      FROM "OzonFinancialCategoryFact"
      WHERE "operationDate"::date >= $1::date
        AND "operationDate"::date <= $2::date
        ${companyFilterSql}
      GROUP BY "companyName", "category"
      ORDER BY "companyName", "category"
    `,
    params
  );

  console.table(facts.rows.map((row) => ({
    companyName: row.companyName,
    category: row.category,
    rows: row.rows,
    amount: rub(row.amount),
  })));

  console.log('\n=== CHECK ===');
  console.log('If facts contain advertising but no commission/delivery/fbo categories, old logic overwrote Ozon commission/logistics with zero and overstated profit.');
  console.log('[ozon-facts-audit] done');
  await client.end();
}

main().catch(async (error) => {
  console.error(error);
  await client.end().catch(() => {});
  process.exit(1);
});
