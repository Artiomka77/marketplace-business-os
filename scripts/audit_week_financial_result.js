#!/usr/bin/env node
const { Client } = require('pg');

function parseArgs(argv) {
  const args = {};
  for (const item of argv.slice(2)) {
    const m = item.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

function num(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
}

function rub(v) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(num(v)) + ' ₽';
}

function pct(v) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(num(v)) + '%';
}

function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 10);
  return d.toISOString().slice(0, 10);
}

async function tableColumns(client, tableName) {
  const res = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
    [tableName]
  );
  return new Set(res.rows.map((r) => r.column_name));
}

function col(cols, preferred, fallback = null) {
  for (const name of preferred) {
    if (cols.has(name)) return name;
  }
  return fallback;
}

function safeSelect(cols, name, alias = name) {
  return cols.has(name) ? `COALESCE("${name}", 0) AS "${alias}"` : `0 AS "${alias}"`;
}

async function queryOptional(client, title, sql, params) {
  console.log('\n=== ' + title + ' ===');
  try {
    const res = await client.query(sql, params);
    console.table(res.rows);
    return res.rows;
  } catch (error) {
    console.log('ERROR:', error.message);
    return [];
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const dateFrom = args.dateFrom || '2026-06-29';
  const dateTo = args.dateTo || '2026-07-05';
  const companyName = args.companyName || 'ALL';

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is empty');
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('[week-audit] start', { dateFrom, dateTo, companyName });

  const wbFinanceCols = await tableColumns(client, 'WbFinance');
  const wbSaleCols = await tableColumns(client, 'WbSale');
  const ozonFinanceCols = await tableColumns(client, 'OzonFinance');
  const financeTxCols = await tableColumns(client, 'FinanceTransaction');

  console.log('\n[columns] WbFinance:', Array.from(wbFinanceCols).join(', '));
  console.log('[columns] WbSale:', Array.from(wbSaleCols).join(', '));
  console.log('[columns] OzonFinance:', Array.from(ozonFinanceCols).join(', '));
  console.log('[columns] FinanceTransaction:', Array.from(financeTxCols).join(', '));

  const companyFilterFinance = companyName === 'ALL' ? '' : 'AND "companyName" = $3';
  const companyParams = companyName === 'ALL' ? [dateFrom, dateTo] : [dateFrom, dateTo, companyName];

  const financeRows = await queryOptional(
    client,
    'WB FINANCE REPORTS IN PERIOD',
    `SELECT
      "companyName",
      "reportNumber",
      "dateFrom",
      "dateTo",
      ${safeSelect(wbFinanceCols, 'retailAmountSum')},
      ${safeSelect(wbFinanceCols, 'forPaySum')},
      ${safeSelect(wbFinanceCols, 'bankPaymentSum')},
      ${safeSelect(wbFinanceCols, 'deliveryServiceSum')},
      ${safeSelect(wbFinanceCols, 'paidStorageSum')},
      ${safeSelect(wbFinanceCols, 'paidAcceptanceSum')},
      ${safeSelect(wbFinanceCols, 'deductionSum')},
      ${safeSelect(wbFinanceCols, 'penaltySum')}
    FROM "WbFinance"
    WHERE "dateFrom"::date >= $1::date
      AND "dateTo"::date <= $2::date
      ${companyFilterFinance}
    ORDER BY "companyName", "dateFrom", "reportNumber"`,
    companyParams
  );

  const reportNumbers = financeRows.map((r) => String(r.reportNumber)).filter(Boolean);

  if (reportNumbers.length > 0) {
    const salesReportCol = col(wbSaleCols, ['reportNumber', 'reportId']);
    if (salesReportCol) {
      await queryOptional(
        client,
        'WB SALE ROWS BY REPORT NUMBER',
        `SELECT
          "companyName",
          "${salesReportCol}"::text AS "reportNumber",
          COUNT(*)::int AS "rows"
        FROM "WbSale"
        WHERE "${salesReportCol}"::text = ANY($1::text[])
        GROUP BY "companyName", "${salesReportCol}"
        ORDER BY "companyName", "${salesReportCol}"`,
        [reportNumbers]
      );
    } else {
      console.log('\n=== WB SALE ROWS BY REPORT NUMBER ===');
      console.log('Cannot check: WbSale has no reportNumber/reportId column');
    }
  }

  console.log('\n=== WB FINANCE TOTALS BY COMPANY ===');
  const wbByCompany = new Map();
  for (const row of financeRows) {
    const key = row.companyName || 'NO_COMPANY';
    if (!wbByCompany.has(key)) {
      wbByCompany.set(key, {
        companyName: key,
        reports: 0,
        retailAmountSum: 0,
        forPaySum: 0,
        bankPaymentSum: 0,
        deliveryServiceSum: 0,
        paidStorageSum: 0,
        paidAcceptanceSum: 0,
        deductionSum: 0,
        penaltySum: 0,
      });
    }
    const item = wbByCompany.get(key);
    item.reports += 1;
    for (const f of Object.keys(item)) {
      if (f !== 'companyName' && f !== 'reports') item[f] += num(row[f]);
    }
  }
  const wbTotalsRows = Array.from(wbByCompany.values()).map((x) => ({
    companyName: x.companyName,
    reports: x.reports,
    retailAmountSum: rub(x.retailAmountSum),
    forPaySum: rub(x.forPaySum),
    bankPaymentSum: rub(x.bankPaymentSum),
    deliveryServiceSum: rub(x.deliveryServiceSum),
    paidStorageSum: rub(x.paidStorageSum),
    paidAcceptanceSum: rub(x.paidAcceptanceSum),
    deductionSum: rub(x.deductionSum),
    penaltySum: rub(x.penaltySum),
  }));
  console.table(wbTotalsRows);

  const ozonDateCol = col(ozonFinanceCols, ['accrualDate', 'operationDate', 'date']);
  const ozonAmountCol = col(ozonFinanceCols, ['amount', 'totalAmount']);
  const ozonOperationCol = col(ozonFinanceCols, ['operationType', 'type', 'operationName']);
  if (ozonDateCol && ozonAmountCol) {
    const companyFilterOzon = companyName === 'ALL' ? '' : 'AND "companyName" = $3';
    await queryOptional(
      client,
      'OZON FINANCE TOTALS BY COMPANY',
      `SELECT
        "companyName",
        COUNT(*)::int AS "rows",
        SUM(COALESCE("${ozonAmountCol}", 0)) AS "amountSum",
        SUM(CASE
          WHEN LOWER(COALESCE("${ozonOperationCol || ozonAmountCol}"::text, '')) LIKE '%оплата за клик%'
            OR LOWER(COALESCE("${ozonOperationCol || ozonAmountCol}"::text, '')) LIKE '%продвижение%'
            OR LOWER(COALESCE("${ozonOperationCol || ozonAmountCol}"::text, '')) LIKE '%реклам%'
          THEN COALESCE("${ozonAmountCol}", 0)
          ELSE 0
        END) AS "financeAdAmount"
      FROM "OzonFinance"
      WHERE "${ozonDateCol}"::date >= $1::date
        AND "${ozonDateCol}"::date <= $2::date
        ${companyFilterOzon}
      GROUP BY "companyName"
      ORDER BY "companyName"`,
      companyParams
    );
  } else {
    console.log('\n=== OZON FINANCE TOTALS BY COMPANY ===');
    console.log('Cannot check: OzonFinance date/amount columns not detected');
  }

  const txDateCol = col(financeTxCols, ['date', 'operationDate', 'paidAt', 'createdAt']);
  const txAmountCol = col(financeTxCols, ['amount', 'sum', 'value']);
  const txCompanyCol = col(financeTxCols, ['companyName']);
  const txCategoryCol = col(financeTxCols, ['categoryName', 'category', 'type', 'comment', 'description']);

  if (txDateCol && txAmountCol) {
    const txCompanySelect = txCompanyCol ? `"${txCompanyCol}"` : `'NO_COMPANY'`;
    const txCategorySelect = txCategoryCol ? `COALESCE("${txCategoryCol}"::text, '')` : `''`;
    const txCompanyFilter = companyName === 'ALL' || !txCompanyCol ? '' : `AND "${txCompanyCol}" = $3`;

    await queryOptional(
      client,
      'FINANCE TRANSACTIONS TOTALS BY COMPANY',
      `SELECT
        ${txCompanySelect} AS "companyName",
        COUNT(*)::int AS "rows",
        SUM(COALESCE("${txAmountCol}", 0)) AS "amountSum",
        SUM(CASE WHEN LOWER(${txCategorySelect}) LIKE '%вывод%' OR LOWER(${txCategorySelect}) LIKE '%собственник%' THEN COALESCE("${txAmountCol}", 0) ELSE 0 END) AS "ownerWithdrawalGuess",
        SUM(CASE WHEN LOWER(${txCategorySelect}) LIKE '%кредит%' OR LOWER(${txCategorySelect}) LIKE '%займ%' THEN COALESCE("${txAmountCol}", 0) ELSE 0 END) AS "loanGuess"
      FROM "FinanceTransaction"
      WHERE "${txDateCol}"::date >= $1::date
        AND "${txDateCol}"::date <= $2::date
        ${txCompanyFilter}
      GROUP BY ${txCompanySelect}
      ORDER BY ${txCompanySelect}`,
      companyParams
    );
  } else {
    console.log('\n=== FINANCE TRANSACTIONS TOTALS BY COMPANY ===');
    console.log('Cannot aggregate: FinanceTransaction date/amount columns not detected');
  }

  console.log('\n=== QUICK INTERPRETATION CHECKLIST ===');
  console.log('1) If WB FINANCE reports exist but WB SALE rows are 0 for some reportNumber, WB Sale details did not load.');
  console.log('2) If WB FINANCE reports exist and WB SALE rows exist, the WB weekly source is loaded.');
  console.log('3) Compare Dashboard WB sales/charges with WB Finance totals above.');
  console.log('4) If net profit is too high, inspect deductionSum/penalty/storage/acceptance, Ozon ads, and finance transactions.');
  console.log('[week-audit] done');

  await client.end();
}

main().catch(async (error) => {
  console.error('[week-audit] failed');
  console.error(error);
  process.exitCode = 1;
});
