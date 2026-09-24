#!/usr/bin/env node
/* eslint-disable no-console */
const { Client } = require('pg');
const { randomUUID } = require('crypto');

function parseArgs() {
  const result = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) result[match[1]] = match[2];
  }

  if (!result.dateFrom || !result.dateTo) {
    console.error('Usage: node scripts/backfill_ozon_daily_economic_totals_from_finance.js --dateFrom=YYYY-MM-DD --dateTo=YYYY-MM-DD --companyName=ИП Петров|ALL');
    process.exit(1);
  }

  if (!result.companyName) result.companyName = 'ALL';
  return result;
}

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[–—−]/g, '-')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function n(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value).replace(/\s/g, '').replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function fmt(value) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n(value));
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function listDays(dateFrom, dateTo) {
  const days = [];
  for (let day = dateFrom; day <= dateTo; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
}

function isAdOperation(operationType) {
  const value = normalizeText(operationType);
  return (
    value.includes('оплата за клик') ||
    value.includes('продвижение с оплатой за заказ') ||
    value.includes('реклама оплата за заказ') ||
    value.includes('продвижение') ||
    value.includes('реклама') ||
    value.includes('реклам') ||
    value.includes('трафарет') ||
    value.includes('cpc') ||
    value.includes('cpo')
  );
}

function isNonOperating(operationType) {
  const value = normalizeText(operationType);
  return (
    value.includes('займ') ||
    value.includes('заем') ||
    value.includes('фактор') ||
    value.includes('кредит') ||
    value.includes('финансирован') ||
    value.includes('loan') ||
    value.includes('factor')
  );
}

function isDiscountPoints(operationType) {
  const value = normalizeText(operationType);
  return value.includes('балл') && value.includes('скид');
}

function isPartnerProgram(operationType) {
  const value = normalizeText(operationType);
  return value.includes('программ') && value.includes('партнер');
}

function isTaxableRevenue(operationType) {
  const value = normalizeText(operationType);
  return value.includes('выручк') && !isDiscountPoints(operationType) && !isPartnerProgram(operationType);
}

async function tableExists(client, tableName) {
  const res = await client.query(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`public."${tableName}"`],
  );
  return Boolean(res.rows[0]?.exists);
}

async function getCompanies(client, companyName, dateFrom, dateTo) {
  if (companyName !== 'ALL') return [companyName];

  const res = await client.query(
    `
      SELECT DISTINCT "companyName"
      FROM "OzonFinance"
      WHERE "accrualDate" >= $1::date
        AND "accrualDate" < ($2::date + INTERVAL '1 day')
        AND "companyName" IS NOT NULL
      ORDER BY "companyName"
    `,
    [dateFrom, dateTo],
  );

  return res.rows.map((row) => row.companyName).filter(Boolean);
}

async function calculateDay(client, companyName, dateText) {
  const res = await client.query(
    `
      SELECT
        COALESCE("operationType", '') AS "operationType",
        COUNT(*)::int AS rows,
        COALESCE(SUM("salesAmount"), 0)::numeric AS "salesAmount"
      FROM "OzonFinance"
      WHERE "companyName" = $1
        AND "accrualDate" >= $2::date
        AND "accrualDate" < ($2::date + INTERVAL '1 day')
      GROUP BY COALESCE("operationType", '')
      ORDER BY COALESCE("operationType", '')
    `,
    [companyName, dateText],
  );

  const components = {
    companyName,
    date: dateText,
    financeRows: 0,
    economicTurnover: 0,
    taxableRevenue: 0,
    realizedAmount: 0,
    returnedAmount: 0,
    discountPointsAmount: 0,
    partnerProgramsAmount: 0,
    unclassifiedSalesAmount: 0,
    operationTypes: [],
  };

  for (const row of res.rows) {
    const operationType = row.operationType;
    const rows = Number(row.rows ?? 0);
    const salesAmount = n(row.salesAmount);
    components.financeRows += rows;
    components.operationTypes.push({ operationType, rows, salesAmount });

    if (isAdOperation(operationType) || isNonOperating(operationType)) continue;

    components.economicTurnover += salesAmount;

    if (isTaxableRevenue(operationType)) {
      components.taxableRevenue += salesAmount;
      if (salesAmount >= 0) components.realizedAmount += salesAmount;
      else components.returnedAmount += Math.abs(salesAmount);
      continue;
    }

    if (isDiscountPoints(operationType)) {
      components.discountPointsAmount += salesAmount;
      continue;
    }

    if (isPartnerProgram(operationType)) {
      components.partnerProgramsAmount += salesAmount;
    }
  }

  components.unclassifiedSalesAmount =
    components.economicTurnover -
    components.taxableRevenue -
    components.discountPointsAmount -
    components.partnerProgramsAmount;

  return components;
}

async function upsertDay(client, components) {
  const dateText = components.date;
  const importSessionId = createId('impozeco');
  const realizationSummaryId = createId('ozrday');
  const pointsSummaryId = createId('ozpday');
  const sourceName = `Ozon Finance detailed accruals ${components.companyName} ${dateText}`;
  const status = Math.abs(components.unclassifiedSalesAmount) > 0.005 ? 'WARNING' : 'SUCCESS';

  await client.query(
    `
      INSERT INTO "ImportSession" (
        "id", "fileName", "reportType", "marketplace", "companyName", "rowsCount",
        "previewJson", "sheetName", "headerRow", "status", "createdAt"
      )
      VALUES ($1, $2, 'OZON_DAILY_ECONOMIC_TOTALS', 'OZON', $3, $4, $5::jsonb, $6, 1, $7, NOW())
    `,
    [
      importSessionId,
      sourceName,
      components.companyName,
      components.financeRows,
      JSON.stringify({
        source: 'OzonFinance',
        economicTurnover: components.economicTurnover,
        taxableRevenue: components.taxableRevenue,
        discountPointsAmount: components.discountPointsAmount,
        partnerProgramsAmount: components.partnerProgramsAmount,
        unclassifiedSalesAmount: components.unclassifiedSalesAmount,
      }),
      'OzonFinance derived daily economics',
      status,
    ],
  );

  await client.query(
    `DELETE FROM "OzonRealizationRow" WHERE "companyName" = $1 AND "dateFrom"::date = $2::date AND "dateTo"::date = $2::date`,
    [components.companyName, dateText],
  );
  await client.query(
    `DELETE FROM "OzonRealizationSummary" WHERE "companyName" = $1 AND "dateFrom"::date = $2::date AND "dateTo"::date = $2::date`,
    [components.companyName, dateText],
  );
  await client.query(
    `DELETE FROM "OzonDiscountPointsRow" WHERE "companyName" = $1 AND "dateFrom"::date = $2::date AND "dateTo"::date = $2::date`,
    [components.companyName, dateText],
  );
  await client.query(
    `DELETE FROM "OzonDiscountPointsSummary" WHERE "companyName" = $1 AND "dateFrom"::date = $2::date AND "dateTo"::date = $2::date`,
    [components.companyName, dateText],
  );

  await client.query(
    `
      INSERT INTO "OzonRealizationSummary" (
        "id", "importSessionId", "companyName", "dateFrom", "dateTo", "contractNumber", "sourceFileName",
        "realizedAmount", "returnedAmount", "taxableRevenue", "partnerProgramsAmount", "rowsCount", "createdAt"
      )
      VALUES ($1, $2, $3, $4::date, $4::date, 'DAILY_OZON_FINANCE', $5, $6, $7, $8, $9, $10, NOW())
    `,
    [
      realizationSummaryId,
      importSessionId,
      components.companyName,
      dateText,
      sourceName,
      components.realizedAmount,
      components.returnedAmount,
      components.taxableRevenue,
      components.partnerProgramsAmount,
      components.financeRows,
    ],
  );

  await client.query(
    `
      INSERT INTO "OzonRealizationRow" (
        "id", "summaryId", "importSessionId", "companyName", "dateFrom", "dateTo", "operationDate",
        "sku", "vendorCode", "productName", "realizedQty", "returnedQty", "netQty",
        "realizedAmount", "returnedAmount", "taxableRevenue", "partnerProgramsAmount", "createdAt"
      )
      VALUES ($1, $2, $3, $4, $5::date, $5::date, $5::date, NULL, NULL, 'Итого по дню из Ozon Finance', 0, 0, 0, $6, $7, $8, $9, NOW())
    `,
    [
      createId('ozrrday'),
      realizationSummaryId,
      importSessionId,
      components.companyName,
      dateText,
      components.realizedAmount,
      components.returnedAmount,
      components.taxableRevenue,
      components.partnerProgramsAmount,
    ],
  );

  await client.query(
    `
      INSERT INTO "OzonDiscountPointsSummary" (
        "id", "importSessionId", "companyName", "dateFrom", "dateTo", "sourceFileName",
        "pointsAccrued", "pointsWrittenOff", "commissionPaidByPoints", "logisticsPaidByPoints", "fboPaidByPoints",
        "advertisingPaidByPoints", "otherPaidByPoints", "totalPaidByPoints", "createdAt"
      )
      VALUES ($1, $2, $3, $4::date, $4::date, $5, $6, $6, 0, 0, 0, 0, $6, $6, NOW())
    `,
    [
      pointsSummaryId,
      importSessionId,
      components.companyName,
      dateText,
      sourceName,
      components.discountPointsAmount,
    ],
  );

  if (Math.abs(components.discountPointsAmount) > 0.005) {
    await client.query(
      `
        INSERT INTO "OzonDiscountPointsRow" (
          "id", "summaryId", "importSessionId", "companyName", "dateFrom", "dateTo", "category", "name", "amount", "createdAt"
        )
        VALUES ($1, $2, $3, $4, $5::date, $5::date, 'DISCOUNT_POINTS', 'Баллы за скидки Ozon из отчёта начислений', $6, NOW())
      `,
      [
        createId('ozprday'),
        pointsSummaryId,
        importSessionId,
        components.companyName,
        dateText,
        components.discountPointsAmount,
      ],
    );
  }
}

async function main() {
  const args = parseArgs();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const realizationExists = await tableExists(client, 'OzonRealizationSummary');
    const discountExists = await tableExists(client, 'OzonDiscountPointsSummary');
    if (!realizationExists || !discountExists) {
      throw new Error('OzonRealizationSummary/OzonDiscountPointsSummary tables do not exist. Run the table patch first.');
    }

    const companies = await getCompanies(client, args.companyName, args.dateFrom, args.dateTo);
    const days = listDays(args.dateFrom, args.dateTo);
    const rows = [];

    console.log('[ozon-daily-economics-backfill] start', {
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
      companyName: args.companyName,
      companies,
      days,
    });

    await client.query('BEGIN');

    for (const companyName of companies) {
      for (const day of days) {
        const components = await calculateDay(client, companyName, day);
        const hasFinanceRows = components.financeRows > 0;
        const hasClassifiedEconomicData =
          Math.abs(components.taxableRevenue) > 0.005 ||
          Math.abs(components.discountPointsAmount) > 0.005 ||
          Math.abs(components.partnerProgramsAmount) > 0.005;

        const row = {
          companyName,
          date: day,
          financeRows: components.financeRows,
          economicTurnover: components.economicTurnover,
          taxableRevenue: components.taxableRevenue,
          discountPointsAmount: components.discountPointsAmount,
          partnerProgramsAmount: components.partnerProgramsAmount,
          unclassifiedSalesAmount: components.unclassifiedSalesAmount,
          status: hasFinanceRows && hasClassifiedEconomicData ? 'UPSERTED' : 'SKIPPED',
          reason: !hasFinanceRows
            ? 'NO_OZON_FINANCE_ROWS'
            : !hasClassifiedEconomicData
              ? 'NO_REVENUE_COMPONENTS_IN_OZON_FINANCE'
              : null,
        };

        if (row.status === 'UPSERTED') {
          await upsertDay(client, components);
        }

        rows.push(row);
      }
    }

    await client.query('COMMIT');

    console.table(rows.map((row) => ({
      companyName: row.companyName,
      date: row.date,
      status: row.status,
      reason: row.reason || '',
      financeRows: row.financeRows,
      economicTurnover: fmt(row.economicTurnover),
      taxableRevenue: fmt(row.taxableRevenue),
      discountPoints: fmt(row.discountPointsAmount),
      partnerPrograms: fmt(row.partnerProgramsAmount),
      unclassified: fmt(row.unclassifiedSalesAmount),
    })));

    console.log('[ozon-daily-economics-backfill] done');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[ozon-daily-economics-backfill] failed');
    console.error(error);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
