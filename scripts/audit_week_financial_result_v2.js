const { Client } = require('pg');

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    dateFrom: '2026-06-29',
    dateTo: '2026-07-05',
    companyName: 'ALL',
  };
  for (const arg of args) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key && value !== undefined) result[key] = value;
  }
  return result;
}

function n(value) {
  const x = Number(value || 0);
  return Number.isFinite(x) ? x : 0;
}

function rub(value) {
  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 2,
  }).format(n(value));
}

function asText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

async function getColumns(client, tableName) {
  const res = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = $1
     ORDER BY ordinal_position`,
    [tableName]
  );
  return res.rows.map((row) => row.column_name);
}

async function tableExists(client, tableName) {
  const res = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables WHERE table_name = $1
     ) AS exists`,
    [tableName]
  );
  return Boolean(res.rows[0]?.exists);
}

async function printTable(title, rows) {
  console.log('\n=== ' + title + ' ===');
  if (!rows.length) {
    console.log('(no rows)');
  } else {
    console.table(rows);
  }
}

async function main() {
  const { dateFrom, dateTo, companyName } = parseArgs();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    console.log('[week-audit-v2] start', { dateFrom, dateTo, companyName });

    const wbFinanceCols = await getColumns(client, 'WbFinance');
    const wbSaleCols = await getColumns(client, 'WbSale');
    console.log('[columns] WbFinance:', wbFinanceCols.join(', '));
    console.log('[columns] WbSale:', wbSaleCols.join(', '));

    const companyFilter = companyName && companyName !== 'ALL' ? 'AND "companyName" = $3' : '';
    const params = companyName && companyName !== 'ALL' ? [dateFrom, dateTo, companyName] : [dateFrom, dateTo];

    const exactFinance = await client.query(
      `SELECT
         "companyName",
         "reportNumber"::text AS "reportNumber",
         "dateFrom"::date AS "dateFrom",
         "dateTo"::date AS "dateTo",
         COALESCE("salesAmount", 0) AS "salesAmount",
         COALESCE("payoutAmount", 0) AS "payoutAmount",
         COALESCE("totalToPay", 0) AS "totalToPay",
         COALESCE("logisticsCost", 0) AS "logisticsCost",
         COALESCE("storageCost", 0) AS "storageCost",
         COALESCE("acceptanceCost", 0) AS "acceptanceCost",
         COALESCE("otherDeductions", 0) AS "otherDeductions",
         COALESCE("penaltiesAmount", 0) AS "penaltiesAmount"
       FROM "WbFinance"
       WHERE "dateFrom"::date >= $1::date
         AND "dateTo"::date <= $2::date
         ${companyFilter}
       ORDER BY "companyName", "dateFrom", "dateTo", "reportNumber"`,
      params
    );

    await printTable('WB FINANCE EXACTLY INSIDE SELECTED PERIOD', exactFinance.rows.map((row) => ({
      ...row,
      dateFrom: asText(row.dateFrom),
      dateTo: asText(row.dateTo),
      salesAmount: rub(row.salesAmount),
      payoutAmount: rub(row.payoutAmount),
      totalToPay: rub(row.totalToPay),
      logisticsCost: rub(row.logisticsCost),
      storageCost: rub(row.storageCost),
      acceptanceCost: rub(row.acceptanceCost),
      otherDeductions: rub(row.otherDeductions),
      penaltiesAmount: rub(row.penaltiesAmount),
    })));

    const overlapFinance = await client.query(
      `SELECT
         "companyName",
         "reportNumber"::text AS "reportNumber",
         "dateFrom"::date AS "dateFrom",
         "dateTo"::date AS "dateTo",
         COALESCE("salesAmount", 0) AS "salesAmount",
         COALESCE("payoutAmount", 0) AS "payoutAmount",
         COALESCE("totalToPay", 0) AS "totalToPay",
         COALESCE("logisticsCost", 0) AS "logisticsCost",
         COALESCE("storageCost", 0) AS "storageCost",
         COALESCE("acceptanceCost", 0) AS "acceptanceCost",
         COALESCE("otherDeductions", 0) AS "otherDeductions",
         COALESCE("penaltiesAmount", 0) AS "penaltiesAmount"
       FROM "WbFinance"
       WHERE "dateFrom"::date <= $2::date
         AND "dateTo"::date >= $1::date
         ${companyFilter}
       ORDER BY "companyName", "dateFrom", "dateTo", "reportNumber"`,
      params
    );

    await printTable('WB FINANCE OVERLAPPING SELECTED PERIOD', overlapFinance.rows.map((row) => ({
      ...row,
      dateFrom: asText(row.dateFrom),
      dateTo: asText(row.dateTo),
      salesAmount: rub(row.salesAmount),
      payoutAmount: rub(row.payoutAmount),
      totalToPay: rub(row.totalToPay),
      logisticsCost: rub(row.logisticsCost),
      storageCost: rub(row.storageCost),
      acceptanceCost: rub(row.acceptanceCost),
      otherDeductions: rub(row.otherDeductions),
      penaltiesAmount: rub(row.penaltiesAmount),
    })));

    const nearbyFinance = await client.query(
      `SELECT
         "companyName",
         "reportNumber"::text AS "reportNumber",
         "dateFrom"::date AS "dateFrom",
         "dateTo"::date AS "dateTo",
         COALESCE("salesAmount", 0) AS "salesAmount",
         COALESCE("payoutAmount", 0) AS "payoutAmount",
         COALESCE("totalToPay", 0) AS "totalToPay",
         COALESCE("otherDeductions", 0) AS "otherDeductions",
         COALESCE("penaltiesAmount", 0) AS "penaltiesAmount"
       FROM "WbFinance"
       WHERE "dateFrom"::date >= ($1::date - INTERVAL '21 days')
         AND "dateFrom"::date <= ($2::date + INTERVAL '21 days')
         ${companyFilter}
       ORDER BY "companyName", "dateFrom", "dateTo", "reportNumber"`,
      params
    );

    await printTable('WB FINANCE NEARBY REPORTS +/- 21 DAYS', nearbyFinance.rows.map((row) => ({
      ...row,
      dateFrom: asText(row.dateFrom),
      dateTo: asText(row.dateTo),
      salesAmount: rub(row.salesAmount),
      payoutAmount: rub(row.payoutAmount),
      totalToPay: rub(row.totalToPay),
      otherDeductions: rub(row.otherDeductions),
      penaltiesAmount: rub(row.penaltiesAmount),
    })));

    const reportNumbers = overlapFinance.rows.map((row) => String(row.reportNumber)).filter(Boolean);
    if (reportNumbers.length) {
      const salesByReport = await client.query(
        `SELECT
           "companyName",
           "reportNumber"::text AS "reportNumber",
           COUNT(*)::int AS "rows",
           SUM(COALESCE("quantity", 0)) AS "quantity",
           SUM(COALESCE("sellerPayout", 0)) AS "sellerPayout",
           SUM(COALESCE("wbRealizedAmount", 0)) AS "wbRealizedAmount",
           SUM(COALESCE("retailPriceWithDiscount", 0)) AS "retailPriceWithDiscount",
           SUM(COALESCE("logisticsCost", 0)) AS "logisticsCost",
           SUM(COALESCE("storageCost", 0)) AS "storageCost",
           SUM(COALESCE("deductions", 0)) AS "deductions",
           SUM(COALESCE("acceptanceCost", 0)) AS "acceptanceCost",
           SUM(COALESCE("penaltiesAmount", 0)) AS "penaltiesAmount"
         FROM "WbSale"
         WHERE "reportNumber"::text = ANY($1::text[])
         GROUP BY "companyName", "reportNumber"
         ORDER BY "companyName", "reportNumber"`,
        [reportNumbers]
      );

      await printTable('WB SALE ROWS BY OVERLAPPING FINANCE REPORT NUMBER', salesByReport.rows.map((row) => ({
        ...row,
        sellerPayout: rub(row.sellerPayout),
        wbRealizedAmount: rub(row.wbRealizedAmount),
        retailPriceWithDiscount: rub(row.retailPriceWithDiscount),
        logisticsCost: rub(row.logisticsCost),
        storageCost: rub(row.storageCost),
        deductions: rub(row.deductions),
        acceptanceCost: rub(row.acceptanceCost),
        penaltiesAmount: rub(row.penaltiesAmount),
      })));
    } else {
      console.log('\n[wb-sale] no overlapping WB finance reportNumbers, skip reportNumber sales check');
    }

    const wbSalesByDate = await client.query(
      `SELECT
         "companyName",
         COUNT(*)::int AS "rows",
         SUM(COALESCE("quantity", 0)) AS "quantity",
         SUM(COALESCE("sellerPayout", 0)) AS "sellerPayout",
         SUM(COALESCE("wbRealizedAmount", 0)) AS "wbRealizedAmount",
         SUM(COALESCE("retailPriceWithDiscount", 0)) AS "retailPriceWithDiscount",
         COUNT(DISTINCT "reportNumber")::int AS "reportNumbers"
       FROM "WbSale"
       WHERE "saleDate"::date >= $1::date
         AND "saleDate"::date <= $2::date
         ${companyFilter}
       GROUP BY "companyName"
       ORDER BY "companyName"`,
      params
    );

    await printTable('WB SALE ROWS BY saleDate INSIDE SELECTED PERIOD', wbSalesByDate.rows.map((row) => ({
      ...row,
      sellerPayout: rub(row.sellerPayout),
      wbRealizedAmount: rub(row.wbRealizedAmount),
      retailPriceWithDiscount: rub(row.retailPriceWithDiscount),
    })));

    const wbDeductions = await client.query(
      `SELECT
         "companyName",
         COALESCE(NULLIF(TRIM("deductionReason"), ''), '(empty)') AS "deductionReason",
         COUNT(*)::int AS "rows",
         SUM(COALESCE("deductions", 0)) AS "deductions"
       FROM "WbSale"
       WHERE "saleDate"::date >= $1::date
         AND "saleDate"::date <= $2::date
         ${companyFilter}
       GROUP BY "companyName", COALESCE(NULLIF(TRIM("deductionReason"), ''), '(empty)')
       HAVING ABS(SUM(COALESCE("deductions", 0))) > 0
       ORDER BY ABS(SUM(COALESCE("deductions", 0))) DESC
       LIMIT 50`,
      params
    );

    await printTable('WB DEDUCTIONS BY REASON BY saleDate', wbDeductions.rows.map((row) => ({
      ...row,
      deductions: rub(row.deductions),
    })));

    const ozonTotals = await client.query(
      `SELECT
         "companyName",
         COUNT(*)::int AS "rows",
         SUM(COALESCE("salesAmount", 0)) AS "salesAmount",
         SUM(COALESCE("totalAmount", 0)) AS "totalAmount",
         SUM(COALESCE("ozonCommission", 0)) AS "ozonCommission",
         SUM(COALESCE("logisticsCost", 0)) AS "logisticsCost",
         SUM(COALESCE("reverseLogisticsCost", 0)) AS "reverseLogisticsCost",
         SUM(
           CASE
             WHEN LOWER(COALESCE("operationType", '')) LIKE '%оплата за клик%'
               OR LOWER(COALESCE("operationType", '')) LIKE '%продвижение%'
               OR LOWER(COALESCE("operationType", '')) LIKE '%реклам%'
             THEN COALESCE("totalAmount", 0)
             ELSE 0
           END
         ) AS "financeAdTotalAmount",
         SUM(
           CASE
             WHEN LOWER(COALESCE("operationType", '')) LIKE '%оплата за клик%'
               OR LOWER(COALESCE("operationType", '')) LIKE '%продвижение%'
               OR LOWER(COALESCE("operationType", '')) LIKE '%реклам%'
             THEN COALESCE("salesAmount", 0)
             ELSE 0
           END
         ) AS "financeAdSalesAmount"
       FROM "OzonFinance"
       WHERE "accrualDate"::date >= $1::date
         AND "accrualDate"::date <= $2::date
         ${companyFilter}
       GROUP BY "companyName"
       ORDER BY "companyName"`,
      params
    );

    await printTable('OZON FINANCE TOTALS BY COMPANY', ozonTotals.rows.map((row) => ({
      ...row,
      salesAmount: rub(row.salesAmount),
      totalAmount: rub(row.totalAmount),
      ozonCommission: rub(row.ozonCommission),
      logisticsCost: rub(row.logisticsCost),
      reverseLogisticsCost: rub(row.reverseLogisticsCost),
      financeAdTotalAmount: rub(row.financeAdTotalAmount),
      financeAdSalesAmount: rub(row.financeAdSalesAmount),
    })));

    const txTotals = await client.query(
      `SELECT
         "companyName",
         COUNT(*)::int AS "rows",
         SUM(COALESCE("amount", 0)) AS "amountSum",
         SUM(CASE WHEN LOWER(COALESCE("operationType", '')) LIKE '%вывод%'
                   OR LOWER(COALESCE("category", '')) LIKE '%собствен%'
                   OR LOWER(COALESCE("category", '')) LIKE '%вывод%'
                  THEN COALESCE("amount", 0) ELSE 0 END) AS "ownerWithdrawalGuess",
         SUM(CASE WHEN LOWER(COALESCE("category", '')) LIKE '%кредит%'
                   OR LOWER(COALESCE("subcategory", '')) LIKE '%кредит%'
                   OR LOWER(COALESCE("comment", '')) LIKE '%кредит%'
                  THEN COALESCE("amount", 0) ELSE 0 END) AS "loanGuess"
       FROM "FinanceTransaction"
       WHERE "operationDate"::date >= $1::date
         AND "operationDate"::date <= $2::date
         ${companyFilter}
       GROUP BY "companyName"
       ORDER BY "companyName"`,
      params
    );

    await printTable('FINANCE TRANSACTION TOTALS BY COMPANY', txTotals.rows.map((row) => ({
      ...row,
      amountSum: rub(row.amountSum),
      ownerWithdrawalGuess: rub(row.ownerWithdrawalGuess),
      loanGuess: rub(row.loanGuess),
    })));

    const txByCategory = await client.query(
      `SELECT
         "companyName",
         "operationType",
         COALESCE(NULLIF(TRIM("category"), ''), '(empty)') AS "category",
         COALESCE(NULLIF(TRIM("subcategory"), ''), '(empty)') AS "subcategory",
         COUNT(*)::int AS "rows",
         SUM(COALESCE("amount", 0)) AS "amountSum"
       FROM "FinanceTransaction"
       WHERE "operationDate"::date >= $1::date
         AND "operationDate"::date <= $2::date
         ${companyFilter}
       GROUP BY "companyName", "operationType", COALESCE(NULLIF(TRIM("category"), ''), '(empty)'), COALESCE(NULLIF(TRIM("subcategory"), ''), '(empty)')
       ORDER BY ABS(SUM(COALESCE("amount", 0))) DESC
       LIMIT 80`,
      params
    );

    await printTable('FINANCE TRANSACTIONS BY CATEGORY TOP 80', txByCategory.rows.map((row) => ({
      ...row,
      amountSum: rub(row.amountSum),
    })));

    console.log('\n=== INTERPRETATION ===');
    console.log('A) If WB FINANCE EXACT is empty but NEARBY has reports, selected week boundaries do not match stored WB report dates.');
    console.log('B) If WB FINANCE OVERLAPPING has reports and WB SALE rows by reportNumber > 0, weekly WB source is loaded.');
    console.log('C) If Dashboard still says incomplete while weekly source is loaded, fix dataReadiness/status logic, not finance import.');
    console.log('D) If net profit is too high, inspect Ozon totals and FinanceTransaction categories first.');
    console.log('[week-audit-v2] done');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('[week-audit-v2] failed');
  console.error(error);
  process.exit(1);
});
