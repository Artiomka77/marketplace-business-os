const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const DATE_FROM = process.env.DATE_FROM || '2026-04-01';
const DATE_TO = process.env.DATE_TO || '2026-06-30';
const DATE_TO_EXCLUSIVE = addDays(DATE_TO, 1);
const SCAN_TRANSACTION_LIST = String(process.env.SCAN_TRANSACTION_LIST || 'false').toLowerCase() === 'true';
const MAX_PAGES = Number(process.env.MAX_PAGES || 120);
const API_SLEEP_MS = Number(process.env.API_SLEEP_MS || 250);

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'object' && typeof value.toNumber === 'function') return value.toNumber();
  const number = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(number) ? number : 0;
}

function money(value) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(toNumber(value)) + ' ₽';
}

function jsonSafe(value) {
  return JSON.stringify(
    value,
    (key, val) => {
      if (typeof val === 'bigint') return Number(val);
      if (val && typeof val === 'object' && typeof val.toNumber === 'function') return val.toNumber();
      if (val instanceof Date) return val.toISOString();
      return val;
    },
    2
  );
}

function printRows(title, rows) {
  console.log(`\n--- ${title} ---`);
  if (!rows || rows.length === 0) {
    console.log('[]');
    return;
  }
  console.log(jsonSafe(rows));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ozonPost(connection, path, body) {
  const response = await fetch(`https://api-seller.ozon.ru${path}`, {
    method: 'POST',
    headers: {
      'Client-Id': connection.ozonClientId,
      'Api-Key': connection.ozonApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 1000) };
  }

  return { status: response.status, ok: response.ok, json };
}

async function scanOzonTransactionList(connection) {
  const keywords = [
    'займ',
    'заём',
    'фактор',
    'кредит',
    'перевод',
    'финанс',
    'loan',
    'factor',
    'credit',
    'transfer',
    'money_transfer',
  ];

  const hits = [];
  let scanned = 0;
  let page = 1;
  let pageCount = 1;

  while (page <= pageCount && page <= MAX_PAGES) {
    const result = await ozonPost(connection, '/v3/finance/transaction/list', {
      filter: {
        date: {
          from: `${DATE_FROM}T00:00:00.000Z`,
          to: `${DATE_TO}T23:59:59.999Z`,
        },
        operation_type: [],
        posting_number: '',
        transaction_type: 'all',
      },
      page,
      page_size: 1000,
    });

    if (!result.ok) {
      hits.push({ apiError: true, status: result.status, body: result.json });
      break;
    }

    const body = result.json?.result || {};
    const operations = body.operations || [];
    pageCount = Number(body.page_count || page);

    for (const operation of operations) {
      scanned += 1;
      const text = JSON.stringify(operation).toLowerCase();
      const matched = keywords.filter((keyword) => text.includes(keyword.toLowerCase()));
      if (matched.length > 0) {
        hits.push({
          matched,
          operation_date: operation.operation_date,
          operation_type: operation.operation_type,
          operation_type_name: operation.operation_type_name,
          amount: operation.amount,
          accruals_for_sale: operation.accruals_for_sale,
        });
      }
    }

    if (page % 10 === 0 || page === pageCount) {
      console.log(`    scanned page ${page}/${pageCount}, rows=${scanned}, hits=${hits.length}`);
    }

    page += 1;
    if (API_SLEEP_MS > 0) await sleep(API_SLEEP_MS);
  }

  return { scanned, hits };
}

async function main() {
  console.log('=== OZON PROFIT AUDIT ===');
  console.log(`Period: ${DATE_FROM} — ${DATE_TO}`);
  console.log(`SCAN_TRANSACTION_LIST=${SCAN_TRANSACTION_LIST}`);

  const realization = await prisma.$queryRawUnsafe(
    `
      SELECT
        "companyName",
        COUNT(*)::int AS "rowsCount",
        COALESCE(SUM("taxableRevenue"), 0) AS "taxableRevenue",
        COALESCE(SUM("partnerProgramsAmount"), 0) AS "partnerProgramsAmount",
        COALESCE(SUM("realizedAmount"), 0) AS "realizedAmount",
        COALESCE(SUM("returnedAmount"), 0) AS "returnedAmount"
      FROM "OzonRealizationSummary"
      WHERE "dateFrom" >= $1::date
        AND "dateTo" <= $2::date
      GROUP BY "companyName"
      ORDER BY "companyName"
    `,
    DATE_FROM,
    DATE_TO
  );

  const points = await prisma.$queryRawUnsafe(
    `
      SELECT
        "companyName",
        COUNT(*)::int AS "rowsCount",
        COALESCE(SUM("totalPaidByPoints"), 0) AS "totalPaidByPoints",
        COALESCE(SUM("pointsAccrued"), 0) AS "pointsAccrued",
        COALESCE(SUM("pointsWrittenOff"), 0) AS "pointsWrittenOff",
        COALESCE(SUM("advertisingPaidByPoints"), 0) AS "advertisingPaidByPoints"
      FROM "OzonDiscountPointsSummary"
      WHERE "dateFrom" >= $1::date
        AND "dateTo" <= $2::date
      GROUP BY "companyName"
      ORDER BY "companyName"
    `,
    DATE_FROM,
    DATE_TO
  );

  const facts = await prisma.$queryRawUnsafe(
    `
      SELECT
        "companyName",
        "category",
        COUNT(*)::int AS "rowsCount",
        COALESCE(SUM("amount"), 0) AS "amount"
      FROM "OzonFinancialCategoryFact"
      WHERE COALESCE("operationDate", "dateFrom") >= $1::timestamp
        AND COALESCE("operationDate", "dateFrom") < $2::timestamp
      GROUP BY "companyName", "category"
      ORDER BY "companyName", "category"
    `,
    DATE_FROM,
    DATE_TO_EXCLUSIVE
  );

  const adDetails = await prisma.$queryRawUnsafe(
    `
      SELECT
        "companyName",
        COALESCE("sourceOperationType", '') AS "sourceOperationType",
        COALESCE("sourceOperationCode", '') AS "sourceOperationCode",
        COALESCE("sourceServiceName", '') AS "sourceServiceName",
        COUNT(*)::int AS "rowsCount",
        COALESCE(SUM("amount"), 0) AS "amount"
      FROM "OzonFinancialCategoryFact"
      WHERE COALESCE("operationDate", "dateFrom") >= $1::timestamp
        AND COALESCE("operationDate", "dateFrom") < $2::timestamp
        AND "category" = 'OZON_ADVERTISING'
      GROUP BY "companyName", COALESCE("sourceOperationType", ''), COALESCE("sourceOperationCode", ''), COALESCE("sourceServiceName", '')
      ORDER BY COALESCE(SUM("amount"), 0) DESC
      LIMIT 50
    `,
    DATE_FROM,
    DATE_TO_EXCLUSIVE
  );

  const excludedFacts = await prisma.$queryRawUnsafe(
    `
      SELECT
        "companyName",
        "category",
        COALESCE("sourceOperationType", '') AS "sourceOperationType",
        COALESCE("sourceOperationCode", '') AS "sourceOperationCode",
        COALESCE("sourceServiceName", '') AS "sourceServiceName",
        COUNT(*)::int AS "rowsCount",
        COALESCE(SUM("amount"), 0) AS "amount"
      FROM "OzonFinancialCategoryFact"
      WHERE COALESCE("operationDate", "dateFrom") >= $1::timestamp
        AND COALESCE("operationDate", "dateFrom") < $2::timestamp
        AND "category" LIKE 'EXCLUDED_%'
      GROUP BY "companyName", "category", COALESCE("sourceOperationType", ''), COALESCE("sourceOperationCode", ''), COALESCE("sourceServiceName", '')
      ORDER BY "companyName", "category", COALESCE(SUM("amount"), 0) DESC
    `,
    DATE_FROM,
    DATE_TO_EXCLUSIVE
  );

  const loanFinanceRows = await prisma.$queryRawUnsafe(
    `
      SELECT
        "companyName",
        COALESCE("operationType", '') AS "operationType",
        COUNT(*)::int AS "rowsCount",
        COALESCE(SUM("totalAmount"), 0) AS "totalAmount",
        COALESCE(SUM("salesAmount"), 0) AS "salesAmount"
      FROM "OzonFinance"
      WHERE "accrualDate" >= $1::timestamp
        AND "accrualDate" < $2::timestamp
        AND (
          "operationType" ILIKE '%займ%'
          OR "operationType" ILIKE '%заём%'
          OR "operationType" ILIKE '%фактор%'
          OR "operationType" ILIKE '%кредит%'
          OR "operationType" ILIKE '%перевод%'
          OR "operationType" ILIKE '%финанс%'
          OR "operationType" ILIKE '%loan%'
          OR "operationType" ILIKE '%factor%'
          OR "operationType" ILIKE '%credit%'
          OR "operationType" ILIKE '%transfer%'
        )
      GROUP BY "companyName", COALESCE("operationType", '')
      ORDER BY "companyName", ABS(COALESCE(SUM("totalAmount"), 0)) DESC
    `,
    DATE_FROM,
    DATE_TO_EXCLUSIVE
  );

  printRows('DB: OzonRealizationSummary', realization);
  printRows('DB: OzonDiscountPointsSummary', points);
  printRows('DB: OzonFinancialCategoryFact by category', facts);
  printRows('DB: Ozon advertising details', adDetails);
  printRows('DB: EXCLUDED_* facts', excludedFacts);
  printRows('DB: OzonFinance loan/factoring/credit/transfer keyword rows', loanFinanceRows);

  const companyModel = new Map();
  for (const row of realization) {
    companyModel.set(row.companyName, {
      companyName: row.companyName,
      taxableRevenue: toNumber(row.taxableRevenue),
      partnerProgramsAmount: toNumber(row.partnerProgramsAmount),
      discountPointsAmount: 0,
    });
  }

  for (const row of points) {
    const current = companyModel.get(row.companyName) || {
      companyName: row.companyName,
      taxableRevenue: 0,
      partnerProgramsAmount: 0,
      discountPointsAmount: 0,
    };
    current.discountPointsAmount = toNumber(row.totalPaidByPoints) || toNumber(row.pointsWrittenOff) || toNumber(row.pointsAccrued);
    companyModel.set(row.companyName, current);
  }

  console.log('\n--- DB calculated Ozon economic model ---');
  for (const value of companyModel.values()) {
    const economicTurnover = value.taxableRevenue + value.discountPointsAmount + value.partnerProgramsAmount;
    console.log(value.companyName);
    console.log(`  taxableRevenue: ${money(value.taxableRevenue)}`);
    console.log(`  discountPoints: ${money(value.discountPointsAmount)}`);
    console.log(`  partnerPrograms: ${money(value.partnerProgramsAmount)}`);
    console.log(`  economicTurnover: ${money(economicTurnover)}`);
  }

  const connections = await prisma.marketplaceApiConnection.findMany({
    where: {
      marketplace: 'OZON',
      isEnabled: true,
      ozonClientId: { not: null },
      ozonApiKey: { not: null },
      company: { isActive: true },
    },
    select: {
      ozonClientId: true,
      ozonApiKey: true,
      company: { select: { name: true } },
    },
    orderBy: { companyId: 'asc' },
  });

  console.log('\n--- API: /v3/finance/transaction/totals ---');
  for (const connection of connections) {
    const companyName = connection.company?.name || 'Без компании';
    const totals = await ozonPost(connection, '/v3/finance/transaction/totals', {
      filter: {
        date: { from: `${DATE_FROM}T00:00:00.000Z`, to: `${DATE_TO}T23:59:59.999Z` },
        transaction_type: 'all',
      },
    });

    console.log(`\n${companyName}`);
    console.log(`  status: ${totals.status}`);
    console.log(`  accruals_for_sale: ${money(totals.json?.result?.accruals_for_sale)}`);
    console.log(`  sale_commission: ${money(totals.json?.result?.sale_commission)}`);
    console.log(`  processing_and_delivery: ${money(totals.json?.result?.processing_and_delivery)}`);
    console.log(`  services_amount: ${money(totals.json?.result?.services_amount)}`);
    console.log(`  compensation_amount: ${money(totals.json?.result?.compensation_amount)}`);
    console.log(`  money_transfer: ${money(totals.json?.result?.money_transfer)}`);
    console.log(`  others_amount: ${money(totals.json?.result?.others_amount)}`);

    if (SCAN_TRANSACTION_LIST) {
      console.log('  scanning /v3/finance/transaction/list keywords...');
      const scan = await scanOzonTransactionList(connection);
      console.log(`  scanned transaction/list rows: ${scan.scanned}`);
      console.log(`  keyword hits: ${scan.hits.length}`);
      console.log(jsonSafe(scan.hits.slice(0, 40)));
    }
  }

  console.log('\n=== AUDIT DONE ===');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
