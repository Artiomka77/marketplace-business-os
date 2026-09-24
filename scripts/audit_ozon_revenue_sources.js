#!/usr/bin/env node
/* eslint-disable no-console */
const { Client } = require('pg');

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (const arg of args) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) result[match[1]] = match[2];
  }
  if (!result.dateFrom || !result.dateTo) {
    console.error('Usage: node scripts/audit_ozon_revenue_sources.js --dateFrom=YYYY-MM-DD --dateTo=YYYY-MM-DD --companyName=ИП Петров|ALL');
    process.exit(1);
  }
  if (!result.companyName) result.companyName = 'ALL';
  return result;
}

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  const n = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function fmt(value) {
  return Math.round(toNumber(value) * 100) / 100;
}

function inclusiveDays(dateFrom, dateTo) {
  const from = new Date(`${dateFrom}T00:00:00Z`);
  const to = new Date(`${dateTo}T00:00:00Z`);
  return Math.max(1, Math.round((to - from) / 86400000) + 1);
}

function companyWhere(alias, companyName, params) {
  if (!companyName || companyName === 'ALL') return '';
  params.push(companyName);
  return ` AND ${alias}."companyName" = $${params.length}`;
}

async function tableExists(client, tableName) {
  const { rows } = await client.query(
    `SELECT to_regclass($1) AS name`,
    [`public."${tableName}"`],
  );
  return Boolean(rows[0]?.name);
}

async function main() {
  const args = parseArgs();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const expectedDays = inclusiveDays(args.dateFrom, args.dateTo);
  console.log('\n============================================================');
  console.log('AUDIT OZON REVENUE SOURCES');
  console.log('============================================================');
  console.log({ ...args, expectedDays });

  const paramsFinance = [args.dateFrom, args.dateTo];
  const whereCompanyFinance = companyWhere('f', args.companyName, paramsFinance);
  const financeSql = `
    SELECT
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
      ${whereCompanyFinance}
  `;
  const finance = (await client.query(financeSql, paramsFinance)).rows[0];
  console.log('\n=== OzonFinance period totals ===');
  console.table([{
    rows: finance.rows,
    salesAmount: fmt(finance.salesAmount),
    totalAmount: fmt(finance.totalAmount),
    ozonCommission: fmt(finance.ozonCommission),
    logisticsCost: fmt(finance.logisticsCost),
    reverseLogisticsCost: fmt(finance.reverseLogisticsCost),
    clickAdsRawTotal: fmt(finance.clickAdsRawTotal),
    orderAdsRawTotal: fmt(finance.orderAdsRawTotal),
  }]);

  const realizationExists = await tableExists(client, 'OzonRealizationSummary');
  console.log('\nOzonRealizationSummary exists:', realizationExists ? 'YES' : 'NO');
  if (realizationExists) {
    const paramsExact = [args.dateFrom, args.dateTo];
    const whereCompanyExact = companyWhere('r', args.companyName, paramsExact);
    const exactSql = `
      SELECT
        COUNT(*)::int AS rows,
        COUNT(DISTINCT r."dateFrom"::date)::int AS "daysByDateFrom",
        MIN(r."dateFrom"::date)::text AS "minDateFrom",
        MAX(r."dateTo"::date)::text AS "maxDateTo",
        COALESCE(SUM(r."realizedAmount"), 0) AS "realizedAmount",
        COALESCE(SUM(r."returnedAmount"), 0) AS "returnedAmount",
        COALESCE(SUM(r."taxableRevenue"), 0) AS "taxableRevenue",
        COALESCE(SUM(r."partnerProgramsAmount"), 0) AS "partnerProgramsAmount"
      FROM "OzonRealizationSummary" r
      WHERE r."dateFrom"::date = CAST($1 AS date)
        AND r."dateTo"::date = CAST($2 AS date)
        ${whereCompanyExact}
    `;
    const exact = (await client.query(exactSql, paramsExact)).rows[0];
    console.log('\n=== OzonRealizationSummary EXACT selected period ===');
    console.table([{
      rows: exact.rows,
      daysByDateFrom: exact.daysByDateFrom,
      minDateFrom: exact.minDateFrom,
      maxDateTo: exact.maxDateTo,
      realizedAmount: fmt(exact.realizedAmount),
      returnedAmount: fmt(exact.returnedAmount),
      taxableRevenue: fmt(exact.taxableRevenue),
      partnerProgramsAmount: fmt(exact.partnerProgramsAmount),
    }]);

    const paramsInside = [args.dateFrom, args.dateTo];
    const whereCompanyInside = companyWhere('r', args.companyName, paramsInside);
    const insideSql = `
      SELECT
        COUNT(*)::int AS rows,
        COUNT(DISTINCT r."dateFrom"::date)::int AS "daysByDateFrom",
        MIN(r."dateFrom"::date)::text AS "minDateFrom",
        MAX(r."dateTo"::date)::text AS "maxDateTo",
        COALESCE(SUM(r."realizedAmount"), 0) AS "realizedAmount",
        COALESCE(SUM(r."returnedAmount"), 0) AS "returnedAmount",
        COALESCE(SUM(r."taxableRevenue"), 0) AS "taxableRevenue",
        COALESCE(SUM(r."partnerProgramsAmount"), 0) AS "partnerProgramsAmount"
      FROM "OzonRealizationSummary" r
      WHERE r."dateFrom"::date >= CAST($1 AS date)
        AND r."dateTo"::date <= CAST($2 AS date)
        ${whereCompanyInside}
    `;
    const inside = (await client.query(insideSql, paramsInside)).rows[0];
    const insideComplete = Number(inside.daysByDateFrom) >= expectedDays;
    console.log('\n=== OzonRealizationSummary INSIDE selected period ===');
    console.table([{
      rows: inside.rows,
      daysByDateFrom: inside.daysByDateFrom,
      expectedDays,
      complete: insideComplete,
      minDateFrom: inside.minDateFrom,
      maxDateTo: inside.maxDateTo,
      realizedAmount: fmt(inside.realizedAmount),
      returnedAmount: fmt(inside.returnedAmount),
      taxableRevenue: fmt(inside.taxableRevenue),
      partnerProgramsAmount: fmt(inside.partnerProgramsAmount),
    }]);

    const impliedDiscountPoints = Math.max(
      0,
      toNumber(finance.salesAmount) -
        toNumber(inside.taxableRevenue) -
        toNumber(inside.partnerProgramsAmount),
    );
    console.log('\n=== Formula check if INSIDE realization is used ===');
    console.table([{
      economicTurnoverFromFinanceSalesAmount: fmt(finance.salesAmount),
      taxableRevenueFromRealization: fmt(inside.taxableRevenue),
      partnerProgramsAmount: fmt(inside.partnerProgramsAmount),
      impliedDiscountPoints: fmt(impliedDiscountPoints),
      realizationCoverageComplete: insideComplete,
    }]);
  }

  const discountExists = await tableExists(client, 'OzonDiscountPointsSummary');
  console.log('\nOzonDiscountPointsSummary exists:', discountExists ? 'YES' : 'NO');
  if (discountExists) {
    const paramsDiscount = [args.dateFrom, args.dateTo];
    const whereCompanyDiscount = companyWhere('d', args.companyName, paramsDiscount);
    const discountSql = `
      SELECT
        COUNT(*)::int AS rows,
        COUNT(DISTINCT d."dateFrom"::date)::int AS "daysByDateFrom",
        MIN(d."dateFrom"::date)::text AS "minDateFrom",
        MAX(d."dateTo"::date)::text AS "maxDateTo",
        COALESCE(SUM(d."pointsAccrued"), 0) AS "pointsAccrued",
        COALESCE(SUM(d."pointsWrittenOff"), 0) AS "pointsWrittenOff",
        COALESCE(SUM(d."totalPaidByPoints"), 0) AS "totalPaidByPoints",
        COALESCE(SUM(d."commissionPaidByPoints"), 0) AS "commissionPaidByPoints",
        COALESCE(SUM(d."logisticsPaidByPoints"), 0) AS "logisticsPaidByPoints",
        COALESCE(SUM(d."fboPaidByPoints"), 0) AS "fboPaidByPoints",
        COALESCE(SUM(d."advertisingPaidByPoints"), 0) AS "advertisingPaidByPoints",
        COALESCE(SUM(d."otherPaidByPoints"), 0) AS "otherPaidByPoints"
      FROM "OzonDiscountPointsSummary" d
      WHERE d."dateFrom"::date >= CAST($1 AS date)
        AND d."dateTo"::date <= CAST($2 AS date)
        ${whereCompanyDiscount}
    `;
    const discount = (await client.query(discountSql, paramsDiscount)).rows[0];
    console.log('\n=== OzonDiscountPointsSummary INSIDE selected period ===');
    console.table([{
      rows: discount.rows,
      daysByDateFrom: discount.daysByDateFrom,
      expectedDays,
      complete: Number(discount.daysByDateFrom) >= expectedDays,
      minDateFrom: discount.minDateFrom,
      maxDateTo: discount.maxDateTo,
      pointsAccrued: fmt(discount.pointsAccrued),
      pointsWrittenOff: fmt(discount.pointsWrittenOff),
      totalPaidByPoints: fmt(discount.totalPaidByPoints),
      commissionPaidByPoints: fmt(discount.commissionPaidByPoints),
      logisticsPaidByPoints: fmt(discount.logisticsPaidByPoints),
      fboPaidByPoints: fmt(discount.fboPaidByPoints),
      advertisingPaidByPoints: fmt(discount.advertisingPaidByPoints),
      otherPaidByPoints: fmt(discount.otherPaidByPoints),
    }]);
  }

  console.log('\n============================================================');
  console.log('READING RULE');
  console.log('============================================================');
  console.log('1. economicTurnover must not be forced equal to taxableRevenue when Ozon discount points / partner programs exist.');
  console.log('2. For daily/weekly periods, use Ozon realization data only if exact selected-period data exists or daily rows fully cover the selected range.');
  console.log('3. If realization coverage is incomplete, do not display a fake weekly taxableRevenue; show OzonFinance salesAmount as economic turnover and flag missing tax revenue source.');
  console.log('4. Ads from OzonFinance remain the priority source; Performance Ads is fallback only when Finance has no ads.');

  await client.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
