/* eslint-disable no-console */
/**
 * Ozon Q2 profit audit.
 *
 * Safe diagnostic script:
 * - Reads DB via pg directly (no PrismaClient, so it works in temporary node containers).
 * - Does not change any DB data.
 * - Checks Ozon realization/discount points/category facts/ad details/excluded facts.
 * - Optionally scans Ozon transaction/list for loans/factoring/credit/transfer keywords.
 */

const { Client } = require("pg");

const DATE_FROM = process.env.DATE_FROM || "2026-04-01";
const DATE_TO = process.env.DATE_TO || "2026-06-30";
const DATE_TO_EXCLUSIVE = addDays(DATE_TO, 1);
const SCAN_TRANSACTION_LIST = String(process.env.SCAN_TRANSACTION_LIST || "false").toLowerCase() === "true";
const MAX_PAGES = Number(process.env.MAX_PAGES || 120);
const API_SLEEP_MS = Number(process.env.API_SLEEP_MS || 300);

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const normalized = String(value).replace(/\s/g, "").replace(",", ".");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function money(value) {
  return (
    new Intl.NumberFormat("ru-RU", {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
    }).format(toNumber(value)) + " ₽"
  );
}

function pct(value, base) {
  const n = toNumber(value);
  const b = toNumber(base);
  if (!b) return "0.0%";
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format((n / b) * 100)}%`;
}

function jsonSafe(value) {
  return JSON.stringify(
    value,
    (key, val) => {
      if (val instanceof Date) return val.toISOString();
      return val;
    },
    2
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mustGetDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is missing");
  }
  return url;
}

async function query(client, text, params = []) {
  const result = await client.query(text, params);
  return result.rows;
}

async function ozonPost(connection, path, body) {
  const response = await fetch(`https://api-seller.ozon.ru${path}`, {
    method: "POST",
    headers: {
      "Client-Id": connection.ozonClientId,
      "Api-Key": connection.ozonApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let json = null;

  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 1000) };
  }

  return {
    status: response.status,
    ok: response.ok,
    json,
  };
}

function printRows(title, rows) {
  console.log(`--- ${title} ---`);
  if (!rows.length) {
    console.log("[]");
    console.log("");
    return;
  }
  console.log(jsonSafe(rows));
  console.log("");
}

function getByCompany(rows, companyName, field) {
  const row = rows.find((item) => item.companyName === companyName);
  return row ? toNumber(row[field]) : 0;
}

function sumCategory(facts, companyName, category) {
  return facts
    .filter((row) => row.companyName === companyName && row.category === category)
    .reduce((sum, row) => sum + toNumber(row.amount), 0);
}

async function scanTransactionListForKeywords(connection, companyName) {
  const keywords = [
    "займ",
    "заём",
    "фактор",
    "кредит",
    "перевод",
    "финанс",
    "loan",
    "factor",
    "credit",
    "transfer",
    "money_transfer",
  ];

  const hits = [];
  let scanned = 0;
  let page = 1;
  let pageCount = 1;

  while (page <= pageCount && page <= MAX_PAGES) {
    const list = await ozonPost(connection, "/v3/finance/transaction/list", {
      filter: {
        date: {
          from: `${DATE_FROM}T00:00:00.000Z`,
          to: `${DATE_TO}T23:59:59.999Z`,
        },
        operation_type: [],
        posting_number: "",
        transaction_type: "all",
      },
      page,
      page_size: 1000,
    });

    if (!list.ok) {
      hits.push({
        apiError: true,
        status: list.status,
        body: list.json,
      });
      break;
    }

    const result = list.json?.result ?? {};
    const operations = result.operations ?? [];
    pageCount = result.page_count ?? page;

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

    if (API_SLEEP_MS > 0) {
      await sleep(API_SLEEP_MS);
    }

    page += 1;
  }

  console.log(`  scanned transaction/list rows: ${scanned}`);
  console.log(`  loan/factoring/credit/transfer keyword hits: ${hits.length}`);
  console.log(jsonSafe(hits.slice(0, 40)));
  console.log("");
}

async function main() {
  console.log("=== OZON PROFIT Q2 AUDIT ===");
  console.log(`Period: ${DATE_FROM} — ${DATE_TO}`);
  console.log(`SCAN_TRANSACTION_LIST=${SCAN_TRANSACTION_LIST}`);
  console.log("");

  const client = new Client({
    connectionString: mustGetDatabaseUrl(),
  });

  await client.connect();

  try {
    const realization = await query(
      client,
      `
        SELECT
          "companyName" AS "companyName",
          COUNT(*)::int AS "rowsCount",
          COALESCE(SUM("taxableRevenue"), 0)::text AS "taxableRevenue",
          COALESCE(SUM("partnerProgramsAmount"), 0)::text AS "partnerProgramsAmount",
          COALESCE(SUM("realizedAmount"), 0)::text AS "realizedAmount",
          COALESCE(SUM("returnedAmount"), 0)::text AS "returnedAmount"
        FROM "OzonRealizationSummary"
        WHERE "dateFrom" >= $1::date
          AND "dateTo" <= $2::date
        GROUP BY "companyName"
        ORDER BY "companyName"
      `,
      [DATE_FROM, DATE_TO]
    );

    const points = await query(
      client,
      `
        SELECT
          "companyName" AS "companyName",
          COUNT(*)::int AS "rowsCount",
          COALESCE(SUM("totalPaidByPoints"), 0)::text AS "totalPaidByPoints",
          COALESCE(SUM("pointsAccrued"), 0)::text AS "pointsAccrued",
          COALESCE(SUM("pointsWrittenOff"), 0)::text AS "pointsWrittenOff",
          COALESCE(SUM("advertisingPaidByPoints"), 0)::text AS "advertisingPaidByPoints"
        FROM "OzonDiscountPointsSummary"
        WHERE "dateFrom" >= $1::date
          AND "dateTo" <= $2::date
        GROUP BY "companyName"
        ORDER BY "companyName"
      `,
      [DATE_FROM, DATE_TO]
    );

    const facts = await query(
      client,
      `
        SELECT
          "companyName" AS "companyName",
          "category" AS "category",
          COUNT(*)::int AS "rowsCount",
          COALESCE(SUM("amount"), 0)::text AS "amount"
        FROM "OzonFinancialCategoryFact"
        WHERE COALESCE("operationDate", "dateFrom") >= $1::timestamp
          AND COALESCE("operationDate", "dateFrom") < $2::timestamp
        GROUP BY "companyName", "category"
        ORDER BY "companyName", "category"
      `,
      [DATE_FROM, DATE_TO_EXCLUSIVE]
    );

    const adDetails = await query(
      client,
      `
        SELECT
          "companyName" AS "companyName",
          COALESCE("sourceOperationType", '') AS "sourceOperationType",
          COALESCE("sourceOperationCode", '') AS "sourceOperationCode",
          COALESCE("sourceServiceName", '') AS "sourceServiceName",
          COUNT(*)::int AS "rowsCount",
          COALESCE(SUM("amount"), 0)::text AS "amount"
        FROM "OzonFinancialCategoryFact"
        WHERE COALESCE("operationDate", "dateFrom") >= $1::timestamp
          AND COALESCE("operationDate", "dateFrom") < $2::timestamp
          AND "category" = 'OZON_ADVERTISING'
        GROUP BY
          "companyName",
          COALESCE("sourceOperationType", ''),
          COALESCE("sourceOperationCode", ''),
          COALESCE("sourceServiceName", '')
        ORDER BY COALESCE(SUM("amount"), 0) DESC
        LIMIT 60
      `,
      [DATE_FROM, DATE_TO_EXCLUSIVE]
    );

    const excludedFacts = await query(
      client,
      `
        SELECT
          "companyName" AS "companyName",
          "category" AS "category",
          COALESCE("sourceOperationType", '') AS "sourceOperationType",
          COALESCE("sourceOperationCode", '') AS "sourceOperationCode",
          COALESCE("sourceServiceName", '') AS "sourceServiceName",
          COUNT(*)::int AS "rowsCount",
          COALESCE(SUM("amount"), 0)::text AS "amount"
        FROM "OzonFinancialCategoryFact"
        WHERE COALESCE("operationDate", "dateFrom") >= $1::timestamp
          AND COALESCE("operationDate", "dateFrom") < $2::timestamp
          AND "category" LIKE 'EXCLUDED_%'
        GROUP BY
          "companyName",
          "category",
          COALESCE("sourceOperationType", ''),
          COALESCE("sourceOperationCode", ''),
          COALESCE("sourceServiceName", '')
        ORDER BY "companyName", "category", COALESCE(SUM("amount"), 0) DESC
      `,
      [DATE_FROM, DATE_TO_EXCLUSIVE]
    );

    const loanFinanceRows = await query(
      client,
      `
        SELECT
          "companyName" AS "companyName",
          COALESCE("operationType", '') AS "operationType",
          COUNT(*)::int AS "rowsCount",
          COALESCE(SUM("totalAmount"), 0)::text AS "totalAmount"
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
      [DATE_FROM, DATE_TO_EXCLUSIVE]
    );

    printRows("DB: OzonRealizationSummary", realization);
    printRows("DB: OzonDiscountPointsSummary", points);
    printRows("DB: OzonFinancialCategoryFact by category", facts);
    printRows("DB: Ozon advertising details", adDetails);
    printRows("DB: EXCLUDED_* facts", excludedFacts);
    printRows("DB: raw OzonFinance loan/factoring/credit/transfer keyword rows", loanFinanceRows);

    const companyNames = Array.from(
      new Set([
        ...realization.map((row) => row.companyName),
        ...points.map((row) => row.companyName),
        ...facts.map((row) => row.companyName),
      ])
    ).sort((a, b) => a.localeCompare(b, "ru"));

    console.log("--- DB calculated economic model by company ---");

    let totalTaxableRevenue = 0;
    let totalPartnerPrograms = 0;
    let totalDiscountPoints = 0;
    let totalEconomicTurnover = 0;

    for (const companyName of companyNames) {
      const taxableRevenue = getByCompany(realization, companyName, "taxableRevenue");
      const partnerProgramsAmount = getByCompany(realization, companyName, "partnerProgramsAmount");
      const discountPointsAmount =
        getByCompany(points, companyName, "totalPaidByPoints") ||
        getByCompany(points, companyName, "pointsWrittenOff") ||
        getByCompany(points, companyName, "pointsAccrued");
      const economicTurnover = taxableRevenue + partnerProgramsAmount + discountPointsAmount;

      totalTaxableRevenue += taxableRevenue;
      totalPartnerPrograms += partnerProgramsAmount;
      totalDiscountPoints += discountPointsAmount;
      totalEconomicTurnover += economicTurnover;

      const commission = sumCategory(facts, companyName, "OZON_COMMISSION");
      const delivery = sumCategory(facts, companyName, "OZON_DELIVERY");
      const fbo = sumCategory(facts, companyName, "OZON_FBO");
      const advertising = sumCategory(facts, companyName, "OZON_ADVERTISING");
      const partnerServices = sumCategory(facts, companyName, "OZON_PARTNER_SERVICES");
      const otherServices = sumCategory(facts, companyName, "OZON_OTHER_SERVICES");
      const compensation = sumCategory(facts, companyName, "OZON_COMPENSATION");
      const excluded =
        sumCategory(facts, companyName, "EXCLUDED_LOANS_FACTORING") +
        sumCategory(facts, companyName, "EXCLUDED_CREDIT") +
        sumCategory(facts, companyName, "EXCLUDED_TRANSFER");
      const grossOzonExpenses =
        commission + delivery + fbo + advertising + partnerServices + otherServices + compensation;
      const netOzonAfterPoints = grossOzonExpenses - discountPointsAmount;

      console.log(companyName);
      console.log(`  taxableRevenue: ${money(taxableRevenue)}`);
      console.log(`  discountPoints: ${money(discountPointsAmount)}`);
      console.log(`  partnerPrograms: ${money(partnerProgramsAmount)}`);
      console.log(`  economicTurnover: ${money(economicTurnover)}`);
      console.log(`  commission: ${money(commission)} (${pct(commission, economicTurnover)})`);
      console.log(`  delivery: ${money(delivery)} (${pct(delivery, economicTurnover)})`);
      console.log(`  fbo: ${money(fbo)} (${pct(fbo, economicTurnover)})`);
      console.log(`  advertising: ${money(advertising)} (${pct(advertising, economicTurnover)})`);
      console.log(`  other/partner services: ${money(otherServices + partnerServices)} (${pct(otherServices + partnerServices, economicTurnover)})`);
      console.log(`  compensation: ${money(compensation)} (${pct(compensation, economicTurnover)})`);
      console.log(`  grossOzonExpenses: ${money(grossOzonExpenses)} (${pct(grossOzonExpenses, economicTurnover)})`);
      console.log(`  netOzonAfterPoints: ${money(netOzonAfterPoints)} (${pct(netOzonAfterPoints, economicTurnover)})`);
      console.log(`  excludedLoansFactoringCreditTransfer: ${money(excluded)} (${pct(excluded, economicTurnover)})`);
      console.log("");
    }

    console.log("TOTAL");
    console.log(`  taxableRevenue: ${money(totalTaxableRevenue)}`);
    console.log(`  discountPoints: ${money(totalDiscountPoints)}`);
    console.log(`  partnerPrograms: ${money(totalPartnerPrograms)}`);
    console.log(`  economicTurnover: ${money(totalEconomicTurnover)}`);
    console.log("");

    const connections = await query(
      client,
      `
        SELECT
          c."name" AS "companyName",
          mac."ozonClientId" AS "ozonClientId",
          mac."ozonApiKey" AS "ozonApiKey"
        FROM "MarketplaceApiConnection" mac
        JOIN "Company" c ON c."id" = mac."companyId"
        WHERE mac."marketplace" = 'OZON'
          AND mac."isEnabled" = true
          AND mac."ozonClientId" IS NOT NULL
          AND mac."ozonApiKey" IS NOT NULL
          AND c."isActive" = true
        ORDER BY c."name"
      `
    );

    console.log("--- API: /v3/finance/transaction/totals Q2 ---");

    for (const connection of connections) {
      const totals = await ozonPost(connection, "/v3/finance/transaction/totals", {
        filter: {
          date: {
            from: `${DATE_FROM}T00:00:00.000Z`,
            to: `${DATE_TO}T23:59:59.999Z`,
          },
          transaction_type: "all",
        },
      });

      console.log(connection.companyName);
      console.log(`  status: ${totals.status}`);
      console.log(`  accruals_for_sale: ${money(totals.json?.result?.accruals_for_sale)}`);
      console.log(`  sale_commission: ${money(totals.json?.result?.sale_commission)}`);
      console.log(`  processing_and_delivery: ${money(totals.json?.result?.processing_and_delivery)}`);
      console.log(`  services_amount: ${money(totals.json?.result?.services_amount)}`);
      console.log(`  compensation_amount: ${money(totals.json?.result?.compensation_amount)}`);
      console.log(`  money_transfer: ${money(totals.json?.result?.money_transfer)}`);
      console.log(`  others_amount: ${money(totals.json?.result?.others_amount)}`);
      console.log("");

      if (SCAN_TRANSACTION_LIST) {
        await scanTransactionListForKeywords(connection, connection.companyName);
      }
    }

    console.log("=== AUDIT DONE ===");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
