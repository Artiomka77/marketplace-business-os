const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const DATE_FROM = process.env.DATE_FROM || "2026-06-01";
const DATE_TO = process.env.DATE_TO || "2026-06-30";
const COMPANY_NAMES = (process.env.COMPANY_NAMES || "ИП Петров,ИП Лебедева")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const RAW_API_SCAN = process.env.RAW_API_SCAN === "1";
const API_MAX_PAGES = Number(process.env.API_MAX_PAGES || "80");
const API_PAGE_SIZE = Number(process.env.API_PAGE_SIZE || "1000");
const API_SLEEP_MS = Number(process.env.API_SLEEP_MS || "350");

const KEYWORDS = [
  "балл",
  "скид",
  "discount",
  "point",
  "points",
  "partner",
  "партнер",
  "партнёр",
  "программ",
  "соинвест",
  "coinvest",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function money(value) {
  const number = Number(value || 0);
  return number.toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + " ₽";
}

function normalizeText(value) {
  return String(value ?? "").toLowerCase().replaceAll("ё", "е");
}

function hasKeyword(value) {
  const text = normalizeText(value);
  return KEYWORDS.some((keyword) => text.includes(keyword));
}

function compactJson(value, maxLength = 700) {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "\n...TRUNCATED...";
}

async function getConnections(client) {
  const result = await client.query(
    `
      SELECT
        c."id" AS "companyId",
        c."name" AS "companyName",
        mac."ozonClientId",
        mac."ozonApiKey",
        mac."isEnabled",
        mac."status"
      FROM "MarketplaceApiConnection" mac
      JOIN "Company" c ON c."id" = mac."companyId"
      WHERE mac."marketplace" = 'OZON'
        AND c."name" = ANY($1)
      ORDER BY c."name"
    `,
    [COMPANY_NAMES]
  );

  return result.rows;
}

async function printExactSummaries(client, companyName) {
  const realization = await client.query(
    `
      SELECT
        "sourceFileName",
        "realizedAmount",
        "returnedAmount",
        "taxableRevenue",
        "partnerProgramsAmount",
        "rowsCount",
        "createdAt"
      FROM "OzonRealizationSummary"
      WHERE "companyName" = $1
        AND "dateFrom"::date = $2::date
        AND "dateTo"::date = $3::date
      ORDER BY "createdAt" DESC
    `,
    [companyName, DATE_FROM, DATE_TO]
  );

  const points = await client.query(
    `
      SELECT
        "sourceFileName",
        "pointsAccrued",
        "pointsWrittenOff",
        "commissionPaidByPoints",
        "logisticsPaidByPoints",
        "fboPaidByPoints",
        "advertisingPaidByPoints",
        "otherPaidByPoints",
        "totalPaidByPoints",
        "createdAt"
      FROM "OzonDiscountPointsSummary"
      WHERE "companyName" = $1
        AND "dateFrom"::date = $2::date
        AND "dateTo"::date = $3::date
      ORDER BY "createdAt" DESC
    `,
    [companyName, DATE_FROM, DATE_TO]
  );

  console.log("");
  console.log(`--- Exact summary rows: ${companyName} ${DATE_FROM} — ${DATE_TO} ---`);

  console.log(`OzonRealizationSummary rows: ${realization.rows.length}`);
  for (const row of realization.rows) {
    console.log({
      sourceFileName: row.sourceFileName,
      taxableRevenue: money(row.taxableRevenue),
      partnerProgramsAmount: money(row.partnerProgramsAmount),
      realizedAmount: money(row.realizedAmount),
      returnedAmount: money(row.returnedAmount),
      rowsCount: row.rowsCount,
      createdAt: row.createdAt,
    });
  }

  console.log(`OzonDiscountPointsSummary rows: ${points.rows.length}`);
  for (const row of points.rows) {
    console.log({
      sourceFileName: row.sourceFileName,
      pointsAccrued: money(row.pointsAccrued),
      pointsWrittenOff: money(row.pointsWrittenOff),
      totalPaidByPoints: money(row.totalPaidByPoints),
      commissionPaidByPoints: money(row.commissionPaidByPoints),
      logisticsPaidByPoints: money(row.logisticsPaidByPoints),
      fboPaidByPoints: money(row.fboPaidByPoints),
      advertisingPaidByPoints: money(row.advertisingPaidByPoints),
      otherPaidByPoints: money(row.otherPaidByPoints),
      createdAt: row.createdAt,
    });
  }
}

async function printFinanceKeywordRows(client, companyName) {
  console.log("");
  console.log(`--- Keyword search in stored OzonFinance: ${companyName} ---`);

  const financeRows = await client.query(
    `
      SELECT
        "operationType",
        COUNT(*) AS "rowsCount",
        COALESCE(SUM("salesAmount"), 0) AS "salesAmount",
        COALESCE(SUM("totalAmount"), 0) AS "totalAmount"
      FROM "OzonFinance"
      WHERE "companyName" = $1
        AND "accrualDate" >= $2::date
        AND "accrualDate" < ($3::date + INTERVAL '1 day')
        AND (
          LOWER(COALESCE("operationType", '')) LIKE '%балл%'
          OR LOWER(COALESCE("operationType", '')) LIKE '%скид%'
          OR LOWER(COALESCE("operationType", '')) LIKE '%discount%'
          OR LOWER(COALESCE("operationType", '')) LIKE '%point%'
          OR LOWER(COALESCE("operationType", '')) LIKE '%partner%'
          OR LOWER(COALESCE("operationType", '')) LIKE '%партнер%'
          OR LOWER(COALESCE("operationType", '')) LIKE '%партнёр%'
          OR LOWER(COALESCE("operationType", '')) LIKE '%программ%'
          OR LOWER(COALESCE("operationType", '')) LIKE '%соинвест%'
        )
      GROUP BY "operationType"
      ORDER BY ABS(COALESCE(SUM("totalAmount"), 0)) DESC
      LIMIT 50
    `,
    [companyName, DATE_FROM, DATE_TO]
  );

  if (financeRows.rows.length === 0) {
    console.log("No keyword rows found in stored OzonFinance.");
  } else {
    for (const row of financeRows.rows) {
      console.log({
        operationType: row.operationType,
        rows: Number(row.rowsCount),
        salesAmount: money(row.salesAmount),
        totalAmount: money(row.totalAmount),
      });
    }
  }

  console.log("");
  console.log(`--- Keyword search in OzonFinancialCategoryFact source fields: ${companyName} ---`);

  const factRows = await client.query(
    `
      SELECT
        "sourceOperationType",
        "sourceOperationCode",
        "sourceServiceName",
        "category",
        COUNT(*) AS "rowsCount",
        COALESCE(SUM("amount"), 0) AS "amount"
      FROM "OzonFinancialCategoryFact"
      WHERE "companyName" = $1
        AND "operationDate" >= $2::date
        AND "operationDate" < ($3::date + INTERVAL '1 day')
        AND (
          LOWER(COALESCE("sourceOperationType", '')) LIKE '%балл%'
          OR LOWER(COALESCE("sourceOperationType", '')) LIKE '%скид%'
          OR LOWER(COALESCE("sourceOperationType", '')) LIKE '%discount%'
          OR LOWER(COALESCE("sourceOperationType", '')) LIKE '%point%'
          OR LOWER(COALESCE("sourceOperationType", '')) LIKE '%partner%'
          OR LOWER(COALESCE("sourceOperationType", '')) LIKE '%партнер%'
          OR LOWER(COALESCE("sourceOperationType", '')) LIKE '%партнёр%'
          OR LOWER(COALESCE("sourceOperationType", '')) LIKE '%программ%'
          OR LOWER(COALESCE("sourceServiceName", '')) LIKE '%балл%'
          OR LOWER(COALESCE("sourceServiceName", '')) LIKE '%скид%'
          OR LOWER(COALESCE("sourceServiceName", '')) LIKE '%discount%'
          OR LOWER(COALESCE("sourceServiceName", '')) LIKE '%point%'
          OR LOWER(COALESCE("sourceServiceName", '')) LIKE '%partner%'
          OR LOWER(COALESCE("sourceServiceName", '')) LIKE '%партнер%'
          OR LOWER(COALESCE("sourceServiceName", '')) LIKE '%партнёр%'
          OR LOWER(COALESCE("sourceServiceName", '')) LIKE '%программ%'
        )
      GROUP BY "sourceOperationType", "sourceOperationCode", "sourceServiceName", "category"
      ORDER BY ABS(COALESCE(SUM("amount"), 0)) DESC
      LIMIT 80
    `,
    [companyName, DATE_FROM, DATE_TO]
  );

  if (factRows.rows.length === 0) {
    console.log("No keyword rows found in OzonFinancialCategoryFact source fields.");
  } else {
    for (const row of factRows.rows) {
      console.log({
        sourceOperationType: row.sourceOperationType,
        sourceOperationCode: row.sourceOperationCode,
        sourceServiceName: row.sourceServiceName,
        category: row.category,
        rows: Number(row.rowsCount),
        amount: money(row.amount),
      });
    }
  }
}

async function fetchOzonTransactions(connection) {
  console.log("");
  console.log(`--- Raw Ozon API /v3/finance/transaction/list scan: ${connection.companyName} ---`);
  console.log(`RAW_API_SCAN=${RAW_API_SCAN}`);
  if (!RAW_API_SCAN) {
    console.log("Skipped raw API scan. Set RAW_API_SCAN=1 to run it.");
    return;
  }

  if (!connection.ozonClientId || !connection.ozonApiKey) {
    console.log("Skipped: Ozon credentials are missing.");
    return;
  }

  let page = 1;
  let pageCount = 1;
  let scanned = 0;
  let matched = 0;
  const examples = [];

  while (page <= pageCount && page <= API_MAX_PAGES) {
    const response = await fetch("https://api-seller.ozon.ru/v3/finance/transaction/list", {
      method: "POST",
      headers: {
        "Client-Id": connection.ozonClientId,
        "Api-Key": connection.ozonApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
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
        page_size: API_PAGE_SIZE,
      }),
    });

    const rawText = await response.text();

    if (!response.ok) {
      console.log(`API_ERROR page=${page} status=${response.status}`);
      console.log(rawText.slice(0, 1000));
      return;
    }

    const json = JSON.parse(rawText);
    const operations = json.result?.operations ?? [];
    pageCount = json.result?.page_count ?? 1;

    for (const operation of operations) {
      scanned += 1;
      const opText = JSON.stringify(operation);
      if (hasKeyword(opText)) {
        matched += 1;
        if (examples.length < 12) {
          examples.push({
            operation_id: operation.operation_id,
            operation_date: operation.operation_date,
            operation_type: operation.operation_type,
            operation_type_name: operation.operation_type_name,
            amount: operation.amount,
            accruals_for_sale: operation.accruals_for_sale,
            sale_commission: operation.sale_commission,
            services: (operation.services ?? []).map((service) => ({
              name: service.name,
              price: service.price,
            })),
            items: (operation.items ?? []).slice(0, 3),
          });
        }
      }
    }

    console.log(`page=${page}/${pageCount}, operations=${operations.length}, scanned=${scanned}, matched=${matched}`);

    page += 1;
    if (page <= pageCount) await sleep(API_SLEEP_MS);
  }

  console.log(`Raw API scan finished. scanned=${scanned}, matched=${matched}, maxPages=${API_MAX_PAGES}`);
  if (examples.length === 0) {
    console.log("No raw API examples with discount/points/partner keywords found.");
  } else {
    console.log("Raw API keyword examples:");
    for (const example of examples) {
      console.log(compactJson(example, 1200));
    }
  }
}

async function main() {
  const client = await pool.connect();

  try {
    console.log("OZON POINTS AUTOMATION GAP DIAGNOSTICS");
    console.log(`Period: ${DATE_FROM} — ${DATE_TO}`);
    console.log(`Companies: ${COMPANY_NAMES.join(", ")}`);

    const connections = await getConnections(client);

    console.log(`Connections found: ${connections.length}`);
    for (const connection of connections) {
      console.log(`- ${connection.companyName}: enabled=${connection.isEnabled}, status=${connection.status}, hasClientId=${Boolean(connection.ozonClientId)}, hasApiKey=${Boolean(connection.ozonApiKey)}`);
    }

    for (const connection of connections) {
      await printExactSummaries(client, connection.companyName);
      await printFinanceKeywordRows(client, connection.companyName);
      await fetchOzonTransactions(connection);
    }

    console.log("");
    console.log("DIAGNOSTICS DONE. No data was changed.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("OZON POINTS AUTOMATION GAP DIAGNOSTICS FAILED");
  console.error(error);
  process.exit(1);
});
