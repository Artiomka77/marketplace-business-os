#!/usr/bin/env node
/* eslint-disable no-console */
const { Client } = require('pg');

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (const arg of args) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) result[m[1]] = m[2];
  }
  if (!result.dateFrom || !result.dateTo) {
    console.error('Usage: node scripts/audit_ozon_revenue_gap.js --dateFrom=YYYY-MM-DD --dateTo=YYYY-MM-DD --companyName="ИП Петров"|ALL');
    process.exit(1);
  }
  if (!result.companyName) result.companyName = 'ALL';
  return result;
}

function n(value) {
  if (value === null || value === undefined) return 0;
  const x = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(x) ? x : 0;
}
function fmt(value) { return Math.round(n(value) * 100) / 100; }
function companyWhere(alias, companyName, params) {
  if (!companyName || companyName === 'ALL') return '';
  params.push(companyName);
  return ` AND ${alias}."companyName" = $${params.length}`;
}
async function tableExists(client, tableName) {
  const { rows } = await client.query('SELECT to_regclass($1) AS name', [`public."${tableName}"`]);
  return Boolean(rows[0]?.name);
}
async function getExpectedDays(client, dateFrom, dateTo) {
  const { rows } = await client.query(
    `SELECT d::date::text AS day
     FROM generate_series(CAST($1 AS date), CAST($2 AS date), interval '1 day') AS d
     ORDER BY d::date`,
    [dateFrom, dateTo],
  );
  return rows.map((r) => r.day);
}
function byDate(rows) {
  const map = new Map();
  for (const row of rows) map.set(row.date, row);
  return map;
}
function printCoverage(expectedDays, label, rows, valueFields = []) {
  const map = byDate(rows);
  const table = expectedDays.map((day) => {
    const r = map.get(day);
    const base = { date: day, exists: Boolean(r), rows: r ? r.rows : 0 };
    for (const field of valueFields) base[field] = r ? fmt(r[field]) : 0;
    return base;
  });
  console.log(`\n=== DAILY COVERAGE: ${label} ===`);
  console.table(table);
  const missing = table.filter((r) => !r.exists).map((r) => r.date);
  console.log(`[coverage] ${label}: ${table.length - missing.length}/${table.length} days loaded`);
  if (missing.length) console.log(`[missing] ${label}: ${missing.join(', ')}`);
  return { table, missing };
}

async function main() {
  const args = parseArgs();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const expectedDays = await getExpectedDays(client, args.dateFrom, args.dateTo);

  console.log('\n============================================================');
  console.log('AUDIT OZON REVENUE GAP / MISSING DAYS');
  console.log('============================================================');
  console.log({ ...args, expectedDays: expectedDays.length, days: expectedDays });

  const paramsFinance = [args.dateFrom, args.dateTo];
  const whereFinance = companyWhere('f', args.companyName, paramsFinance);
  const financeDaily = (await client.query(`
    SELECT
      f."accrualDate"::date::text AS date,
      COUNT(*)::int AS rows,
      COALESCE(SUM(f."salesAmount"), 0) AS "salesAmount",
      COALESCE(SUM(f."totalAmount"), 0) AS "totalAmount",
      COALESCE(SUM(f."ozonCommission"), 0) AS "ozonCommission",
      COALESCE(SUM(f."logisticsCost"), 0) AS "logisticsCost",
      COALESCE(SUM(f."reverseLogisticsCost"), 0) AS "reverseLogisticsCost",
      COALESCE(SUM(CASE WHEN lower(coalesce(f."operationType", '')) LIKE '%клик%' THEN f."totalAmount" ELSE 0 END), 0) AS "clickAdsRawTotal",
      COALESCE(SUM(CASE WHEN lower(coalesce(f."operationType", '')) LIKE '%заказ%' OR lower(coalesce(f."operationType", '')) LIKE '%продвиж%' THEN f."totalAmount" ELSE 0 END), 0) AS "orderAdsRawTotal"
    FROM "OzonFinance" f
    WHERE f."accrualDate"::date >= CAST($1 AS date)
      AND f."accrualDate"::date <= CAST($2 AS date)
      ${whereFinance}
    GROUP BY f."accrualDate"::date
    ORDER BY f."accrualDate"::date
  `, paramsFinance)).rows;

  printCoverage(expectedDays, 'OzonFinance', financeDaily, [
    'salesAmount', 'totalAmount', 'ozonCommission', 'logisticsCost', 'reverseLogisticsCost', 'clickAdsRawTotal', 'orderAdsRawTotal',
  ]);

  const realizationExists = await tableExists(client, 'OzonRealizationSummary');
  console.log('\nOzonRealizationSummary exists:', realizationExists ? 'YES' : 'NO');
  let missingRealization = expectedDays;
  if (realizationExists) {
    const params = [args.dateFrom, args.dateTo];
    const where = companyWhere('r', args.companyName, params);
    const exact = (await client.query(`
      SELECT COUNT(*)::int AS rows,
             COALESCE(SUM(r."taxableRevenue"), 0) AS "taxableRevenue",
             COALESCE(SUM(r."partnerProgramsAmount"), 0) AS "partnerProgramsAmount"
      FROM "OzonRealizationSummary" r
      WHERE r."dateFrom"::date = CAST($1 AS date)
        AND r."dateTo"::date = CAST($2 AS date)
        ${where}
    `, params)).rows[0];
    console.log('\n=== EXACT PERIOD: OzonRealizationSummary ===');
    console.table([{ rows: exact.rows, taxableRevenue: fmt(exact.taxableRevenue), partnerProgramsAmount: fmt(exact.partnerProgramsAmount) }]);

    const daily = (await client.query(`
      SELECT r."dateFrom"::date::text AS date,
             COUNT(*)::int AS rows,
             MIN(r."dateTo"::date)::text AS "minDateTo",
             MAX(r."dateTo"::date)::text AS "maxDateTo",
             COALESCE(SUM(r."realizedAmount"), 0) AS "realizedAmount",
             COALESCE(SUM(r."returnedAmount"), 0) AS "returnedAmount",
             COALESCE(SUM(r."taxableRevenue"), 0) AS "taxableRevenue",
             COALESCE(SUM(r."partnerProgramsAmount"), 0) AS "partnerProgramsAmount",
             STRING_AGG(DISTINCT COALESCE(r."sourceFileName", ''), ' | ') AS "sourceFiles"
      FROM "OzonRealizationSummary" r
      WHERE r."dateFrom"::date >= CAST($1 AS date)
        AND r."dateTo"::date <= CAST($2 AS date)
        ${where}
      GROUP BY r."dateFrom"::date
      ORDER BY r."dateFrom"::date
    `, params)).rows;
    const coverage = printCoverage(expectedDays, 'OzonRealizationSummary', daily, [
      'realizedAmount', 'returnedAmount', 'taxableRevenue', 'partnerProgramsAmount',
    ]);
    missingRealization = coverage.missing;
  }

  const realizationRowExists = await tableExists(client, 'OzonRealizationRow');
  console.log('\nOzonRealizationRow exists:', realizationRowExists ? 'YES' : 'NO');
  if (realizationRowExists) {
    const params = [args.dateFrom, args.dateTo];
    const where = companyWhere('rr', args.companyName, params);
    const daily = (await client.query(`
      SELECT rr."dateFrom"::date::text AS date,
             COUNT(*)::int AS rows,
             COALESCE(SUM(rr."realizedAmount"), 0) AS "realizedAmount",
             COALESCE(SUM(rr."returnedAmount"), 0) AS "returnedAmount",
             COALESCE(SUM(rr."taxableRevenue"), 0) AS "taxableRevenue",
             COALESCE(SUM(rr."partnerProgramsAmount"), 0) AS "partnerProgramsAmount"
      FROM "OzonRealizationRow" rr
      WHERE rr."dateFrom"::date >= CAST($1 AS date)
        AND rr."dateTo"::date <= CAST($2 AS date)
        ${where}
      GROUP BY rr."dateFrom"::date
      ORDER BY rr."dateFrom"::date
    `, params)).rows;
    printCoverage(expectedDays, 'OzonRealizationRow', daily, [
      'realizedAmount', 'returnedAmount', 'taxableRevenue', 'partnerProgramsAmount',
    ]);
  }

  const discountExists = await tableExists(client, 'OzonDiscountPointsSummary');
  console.log('\nOzonDiscountPointsSummary exists:', discountExists ? 'YES' : 'NO');
  let missingDiscount = expectedDays;
  if (discountExists) {
    const params = [args.dateFrom, args.dateTo];
    const where = companyWhere('d', args.companyName, params);
    const exact = (await client.query(`
      SELECT COUNT(*)::int AS rows,
             COALESCE(SUM(d."pointsAccrued"), 0) AS "pointsAccrued",
             COALESCE(SUM(d."totalPaidByPoints"), 0) AS "totalPaidByPoints"
      FROM "OzonDiscountPointsSummary" d
      WHERE d."dateFrom"::date = CAST($1 AS date)
        AND d."dateTo"::date = CAST($2 AS date)
        ${where}
    `, params)).rows[0];
    console.log('\n=== EXACT PERIOD: OzonDiscountPointsSummary ===');
    console.table([{ rows: exact.rows, pointsAccrued: fmt(exact.pointsAccrued), totalPaidByPoints: fmt(exact.totalPaidByPoints) }]);

    const daily = (await client.query(`
      SELECT d."dateFrom"::date::text AS date,
             COUNT(*)::int AS rows,
             MIN(d."dateTo"::date)::text AS "minDateTo",
             MAX(d."dateTo"::date)::text AS "maxDateTo",
             COALESCE(SUM(d."pointsAccrued"), 0) AS "pointsAccrued",
             COALESCE(SUM(d."pointsWrittenOff"), 0) AS "pointsWrittenOff",
             COALESCE(SUM(d."totalPaidByPoints"), 0) AS "totalPaidByPoints",
             COALESCE(SUM(d."commissionPaidByPoints"), 0) AS "commissionPaidByPoints",
             COALESCE(SUM(d."logisticsPaidByPoints"), 0) AS "logisticsPaidByPoints",
             COALESCE(SUM(d."advertisingPaidByPoints"), 0) AS "advertisingPaidByPoints",
             STRING_AGG(DISTINCT COALESCE(d."sourceFileName", ''), ' | ') AS "sourceFiles"
      FROM "OzonDiscountPointsSummary" d
      WHERE d."dateFrom"::date >= CAST($1 AS date)
        AND d."dateTo"::date <= CAST($2 AS date)
        ${where}
      GROUP BY d."dateFrom"::date
      ORDER BY d."dateFrom"::date
    `, params)).rows;
    const coverage = printCoverage(expectedDays, 'OzonDiscountPointsSummary', daily, [
      'pointsAccrued', 'pointsWrittenOff', 'totalPaidByPoints', 'commissionPaidByPoints', 'logisticsPaidByPoints', 'advertisingPaidByPoints',
    ]);
    missingDiscount = coverage.missing;
  }

  const paramsImport = [];
  let importCompany = '';
  if (args.companyName && args.companyName !== 'ALL') {
    paramsImport.push(args.companyName);
    importCompany = ` AND (i."companyName" = $${paramsImport.length} OR i."companyName" IS NULL)`;
  }
  const imports = (await client.query(`
    SELECT i."createdAt"::text AS "createdAt",
           i."marketplace", i."reportType", i."companyName", i."fileName", i."rowsCount", i."status"
    FROM "ImportSession" i
    WHERE lower(coalesce(i."marketplace", '')) LIKE '%ozon%'
      ${importCompany}
      AND (
        lower(coalesce(i."reportType", '')) LIKE '%real%'
        OR lower(coalesce(i."reportType", '')) LIKE '%discount%'
        OR lower(coalesce(i."fileName", '')) LIKE '%real%'
        OR lower(coalesce(i."fileName", '')) LIKE '%discount%'
        OR lower(coalesce(i."fileName", '')) LIKE '%балл%'
        OR lower(coalesce(i."fileName", '')) LIKE '%юнит%'
      )
    ORDER BY i."createdAt" DESC
    LIMIT 40
  `, paramsImport)).rows;
  console.log('\n=== Recent relevant ImportSession rows ===');
  console.table(imports);

  console.log('\n============================================================');
  console.log('RESULT / NEXT ACTION');
  console.log('============================================================');
  console.log('Missing OzonRealizationSummary days:', missingRealization.length ? missingRealization.join(', ') : 'none');
  console.log('Missing OzonDiscountPointsSummary days:', missingDiscount.length ? missingDiscount.join(', ') : 'none');
  console.log('If OzonFinance has the day but Ozon realization/discount summaries do not, the bug is in Ozon economy/tax-revenue sync or upload coverage, not in Ozon Finance import.');
  console.log('Next code fix should add a backfill step: after sync, compare expected days with loaded days and retry missing days before marking data as complete.');

  await client.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
