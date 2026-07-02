const { Pool } = require("pg");
const { randomUUID } = require("crypto");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const APPLY_FIX = process.env.APPLY_FIX === "true";
const COMPANY_NAMES = String(process.env.COMPANY_NAMES || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
const YEAR = Number(process.env.YEAR || new Date().getUTCFullYear());
const MONTH = Number(process.env.MONTH || new Date().getUTCMonth() + 1);
const DATE_FROM = process.env.DATE_FROM || `${YEAR}-${String(MONTH).padStart(2, "0")}-01`;
const DATE_TO = process.env.DATE_TO || new Date().toISOString().slice(0, 10);

function toNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function money(value) {
  return roundMoney(toNumber(value)).toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + " ₽";
}

function getCommissionAmount(value) {
  return toNumber(value && value.amount);
}

function getBonusAmount(value) {
  return toNumber(value && value.bonus);
}

function getPartnerProgramsAmount(value) {
  return toNumber(value && value.bank_coinvestment) + toNumber(value && value.pick_up_point_coinvestment);
}

async function getOzonConnections(client) {
  const result = await client.query(`
    SELECT
      c."id" AS "companyId",
      c."name" AS "companyName",
      mac."ozonClientId" AS "ozonClientId",
      mac."ozonApiKey" AS "ozonApiKey",
      mac."isEnabled" AS "isEnabled",
      mac."status" AS "status"
    FROM "MarketplaceApiConnection" mac
    INNER JOIN "Company" c ON c."id" = mac."companyId"
    WHERE mac."marketplace" = 'OZON'
      AND mac."isEnabled" = TRUE
    ORDER BY c."name" ASC
  `);

  if (COMPANY_NAMES.length === 0) return result.rows;
  const requested = new Set(COMPANY_NAMES);
  return result.rows.filter((row) => requested.has(row.companyName));
}

async function fetchOzonRealization(connection) {
  const response = await fetch("https://api-seller.ozon.ru/v2/finance/realization", {
    method: "POST",
    headers: {
      "Client-Id": connection.ozonClientId,
      "Api-Key": connection.ozonApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ month: MONTH, year: YEAR }),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Ozon realization API: ${response.status} ${text.slice(0, 1000)}`.trim());
  }

  return JSON.parse(text);
}

async function fetchOzonTransactionTotals(connection) {
  const response = await fetch("https://api-seller.ozon.ru/v3/finance/transaction/totals", {
    method: "POST",
    headers: {
      "Client-Id": connection.ozonClientId,
      "Api-Key": connection.ozonApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      date: {
        from: `${DATE_FROM}T00:00:00.000Z`,
        to: `${DATE_TO}T23:59:59.999Z`,
      },
      transaction_type: "all",
    }),
  });

  if (!response.ok) return null;
  const json = await response.json().catch(() => null);
  return json && json.result ? json.result.accruals_for_sale : null;
}

function parseRealization(payload, companyName) {
  const rows = (payload.result && payload.result.rows) || [];
  const header = (payload.result && payload.result.header) || {};

  let realizedAmount = 0;
  let returnedAmount = 0;
  let grossPointsAccrued = 0;
  let grossPointsReturned = 0;
  let deliveryPartnerProgramsAmount = 0;
  let returnPartnerProgramsAmount = 0;

  for (const row of rows) {
    const delivery = row.delivery_commission || null;
    const returned = row.return_commission || null;

    realizedAmount += getCommissionAmount(delivery);
    returnedAmount += getCommissionAmount(returned);
    grossPointsAccrued += getBonusAmount(delivery);
    grossPointsReturned += getBonusAmount(returned);
    deliveryPartnerProgramsAmount += getPartnerProgramsAmount(delivery);
    returnPartnerProgramsAmount += getPartnerProgramsAmount(returned);
  }

  const taxableRevenue = realizedAmount - returnedAmount;
  const totalPaidByPoints = grossPointsAccrued - grossPointsReturned;
  const partnerProgramsAmount = deliveryPartnerProgramsAmount - returnPartnerProgramsAmount;

  return {
    reportNumber: header.number || null,
    contractNumber: header.contract_number || null,
    sourceFileName: `Ozon API /v2/finance/realization ${companyName} ${YEAR}-${String(MONTH).padStart(2, "0")}`,
    apiStartDate: header.start_date || null,
    apiStopDate: header.stop_date || null,
    rowsCount: rows.length,
    realizedAmount: roundMoney(realizedAmount),
    returnedAmount: roundMoney(returnedAmount),
    taxableRevenue: roundMoney(taxableRevenue),
    grossPointsAccrued: roundMoney(grossPointsAccrued),
    grossPointsReturned: roundMoney(grossPointsReturned),
    totalPaidByPoints: roundMoney(totalPaidByPoints),
    partnerProgramsAmount: roundMoney(partnerProgramsAmount),
  };
}

async function ensureTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "OzonRealizationSummary" (
      "id" TEXT PRIMARY KEY,
      "importSessionId" TEXT,
      "companyName" TEXT,
      "dateFrom" TIMESTAMP NOT NULL,
      "dateTo" TIMESTAMP NOT NULL,
      "reportNumber" TEXT,
      "contractNumber" TEXT,
      "sourceFileName" TEXT,
      "realizedAmount" NUMERIC(65,30) DEFAULT 0,
      "returnedAmount" NUMERIC(65,30) DEFAULT 0,
      "taxableRevenue" NUMERIC(65,30) DEFAULT 0,
      "partnerProgramsAmount" NUMERIC(65,30) DEFAULT 0,
      "rowsCount" INTEGER DEFAULT 0,
      "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS "OzonDiscountPointsSummary" (
      "id" TEXT PRIMARY KEY,
      "importSessionId" TEXT,
      "companyName" TEXT,
      "dateFrom" TIMESTAMP NOT NULL,
      "dateTo" TIMESTAMP NOT NULL,
      "sourceFileName" TEXT,
      "pointsAccrued" NUMERIC(65,30) DEFAULT 0,
      "pointsWrittenOff" NUMERIC(65,30) DEFAULT 0,
      "commissionPaidByPoints" NUMERIC(65,30) DEFAULT 0,
      "logisticsPaidByPoints" NUMERIC(65,30) DEFAULT 0,
      "fboPaidByPoints" NUMERIC(65,30) DEFAULT 0,
      "advertisingPaidByPoints" NUMERIC(65,30) DEFAULT 0,
      "otherPaidByPoints" NUMERIC(65,30) DEFAULT 0,
      "totalPaidByPoints" NUMERIC(65,30) DEFAULT 0,
      "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS "OzonDiscountPointsRow" (
      "id" TEXT PRIMARY KEY,
      "summaryId" TEXT,
      "importSessionId" TEXT,
      "companyName" TEXT,
      "dateFrom" TIMESTAMP NOT NULL,
      "dateTo" TIMESTAMP NOT NULL,
      "category" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "amount" NUMERIC(65,30) DEFAULT 0,
      "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
}

async function applySummary(client, companyName, parsed) {
  const realizationId = `ozr_${randomUUID()}`;
  const pointsId = `ozp_${randomUUID()}`;

  await client.query("BEGIN");

  try {
    await client.query(
      `DELETE FROM "OzonRealizationSummary" WHERE "companyName" = $1 AND "dateFrom"::date = $2::date AND "dateTo"::date = $3::date`,
      [companyName, DATE_FROM, DATE_TO]
    );
    await client.query(
      `DELETE FROM "OzonDiscountPointsRow" WHERE "companyName" = $1 AND "dateFrom"::date = $2::date AND "dateTo"::date = $3::date`,
      [companyName, DATE_FROM, DATE_TO]
    );
    await client.query(
      `DELETE FROM "OzonDiscountPointsSummary" WHERE "companyName" = $1 AND "dateFrom"::date = $2::date AND "dateTo"::date = $3::date`,
      [companyName, DATE_FROM, DATE_TO]
    );

    await client.query(
      `
        INSERT INTO "OzonRealizationSummary" (
          "id", "companyName", "dateFrom", "dateTo", "reportNumber", "contractNumber", "sourceFileName",
          "realizedAmount", "returnedAmount", "taxableRevenue", "partnerProgramsAmount", "rowsCount"
        )
        VALUES ($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10, $11, $12)
      `,
      [
        realizationId,
        companyName,
        DATE_FROM,
        DATE_TO,
        parsed.reportNumber,
        parsed.contractNumber,
        parsed.sourceFileName,
        parsed.realizedAmount,
        parsed.returnedAmount,
        parsed.taxableRevenue,
        parsed.partnerProgramsAmount,
        parsed.rowsCount,
      ]
    );

    await client.query(
      `
        INSERT INTO "OzonDiscountPointsSummary" (
          "id", "companyName", "dateFrom", "dateTo", "sourceFileName",
          "pointsAccrued", "pointsWrittenOff",
          "commissionPaidByPoints", "logisticsPaidByPoints", "fboPaidByPoints",
          "advertisingPaidByPoints", "otherPaidByPoints", "totalPaidByPoints"
        )
        VALUES ($1, $2, $3::date, $4::date, $5, $6, $7, 0, 0, 0, 0, $8, $9)
      `,
      [
        pointsId,
        companyName,
        DATE_FROM,
        DATE_TO,
        parsed.sourceFileName,
        parsed.grossPointsAccrued,
        parsed.grossPointsReturned,
        parsed.totalPaidByPoints,
        parsed.totalPaidByPoints,
      ]
    );

    await client.query(
      `
        INSERT INTO "OzonDiscountPointsRow" (
          "id", "summaryId", "companyName", "dateFrom", "dateTo", "category", "name", "amount"
        )
        VALUES ($1, $2, $3, $4::date, $5::date, 'DISCOUNT_POINTS', 'Баллы за скидки по API Ozon realization', $6)
      `,
      [`ozpr_${randomUUID()}`, pointsId, companyName, DATE_FROM, DATE_TO, parsed.totalPaidByPoints]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function main() {
  const client = await pool.connect();

  try {
    console.log("OZON REALIZATION API SYNC");
    console.log("APPLY_FIX=" + APPLY_FIX);
    console.log(`Period for storage: ${DATE_FROM} — ${DATE_TO}`);
    console.log(`Ozon API month/year: ${MONTH}/${YEAR}`);
    console.log("Companies:", COMPANY_NAMES.length ? COMPANY_NAMES.join(", ") : "all enabled Ozon connections");

    await ensureTables(client);

    const connections = await getOzonConnections(client);
    console.log("Connections found:", connections.length);

    for (const connection of connections) {
      console.log("");
      console.log(`=== ${connection.companyName} ===`);

      const payload = await fetchOzonRealization(connection);
      const parsed = parseRealization(payload, connection.companyName);
      const transactionTotalsAccrualsForSale = await fetchOzonTransactionTotals(connection);
      const economicTurnover = roundMoney(
        parsed.taxableRevenue + parsed.totalPaidByPoints + parsed.partnerProgramsAmount
      );

      console.log("apiStartDate:", parsed.apiStartDate);
      console.log("apiStopDate:", parsed.apiStopDate);
      console.log("rowsCount:", parsed.rowsCount);
      console.log("realizedAmount:", money(parsed.realizedAmount));
      console.log("returnedAmount:", money(parsed.returnedAmount));
      console.log("taxableRevenue:", money(parsed.taxableRevenue));
      console.log("pointsAccruedGross:", money(parsed.grossPointsAccrued));
      console.log("pointsReturnedGross:", money(parsed.grossPointsReturned));
      console.log("discountPointsAmount:", money(parsed.totalPaidByPoints));
      console.log("partnerProgramsAmount:", money(parsed.partnerProgramsAmount));
      console.log("economicTurnover:", money(economicTurnover));
      console.log("transactionTotals.accruals_for_sale:", transactionTotalsAccrualsForSale === null ? "n/a" : money(transactionTotalsAccrualsForSale));
      console.log("difference:", transactionTotalsAccrualsForSale === null ? "n/a" : money(economicTurnover - transactionTotalsAccrualsForSale));

      if (APPLY_FIX) {
        await applySummary(client, connection.companyName, parsed);
        console.log("Saved to DB: yes");
      } else {
        console.log("Saved to DB: no, dry run");
      }
    }

    console.log("");
    console.log("DONE");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("OZON REALIZATION API SYNC FAILED");
  console.error(error);
  process.exit(1);
});
