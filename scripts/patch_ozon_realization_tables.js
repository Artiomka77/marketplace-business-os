const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

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
      CREATE TABLE IF NOT EXISTS "OzonRealizationRow" (
        "id" TEXT PRIMARY KEY,
        "summaryId" TEXT,
        "importSessionId" TEXT,
        "companyName" TEXT,
        "dateFrom" TIMESTAMP NOT NULL,
        "dateTo" TIMESTAMP NOT NULL,
        "operationDate" TIMESTAMP,
        "sku" TEXT,
        "vendorCode" TEXT,
        "productName" TEXT,
        "realizedQty" INTEGER DEFAULT 0,
        "returnedQty" INTEGER DEFAULT 0,
        "netQty" INTEGER DEFAULT 0,
        "realizedAmount" NUMERIC(65,30) DEFAULT 0,
        "returnedAmount" NUMERIC(65,30) DEFAULT 0,
        "taxableRevenue" NUMERIC(65,30) DEFAULT 0,
        "partnerProgramsAmount" NUMERIC(65,30) DEFAULT 0,
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

    const indexStatements = [
      `CREATE INDEX IF NOT EXISTS "OzonRealizationSummary_companyName_idx" ON "OzonRealizationSummary" ("companyName")`,
      `CREATE INDEX IF NOT EXISTS "OzonRealizationSummary_dateFrom_idx" ON "OzonRealizationSummary" ("dateFrom")`,
      `CREATE INDEX IF NOT EXISTS "OzonRealizationSummary_dateTo_idx" ON "OzonRealizationSummary" ("dateTo")`,
      `CREATE INDEX IF NOT EXISTS "OzonRealizationSummary_contractNumber_idx" ON "OzonRealizationSummary" ("contractNumber")`,
      `CREATE INDEX IF NOT EXISTS "OzonRealizationSummary_reportNumber_idx" ON "OzonRealizationSummary" ("reportNumber")`,
      `CREATE INDEX IF NOT EXISTS "OzonRealizationRow_summaryId_idx" ON "OzonRealizationRow" ("summaryId")`,
      `CREATE INDEX IF NOT EXISTS "OzonRealizationRow_companyName_idx" ON "OzonRealizationRow" ("companyName")`,
      `CREATE INDEX IF NOT EXISTS "OzonRealizationRow_dateFrom_idx" ON "OzonRealizationRow" ("dateFrom")`,
      `CREATE INDEX IF NOT EXISTS "OzonRealizationRow_dateTo_idx" ON "OzonRealizationRow" ("dateTo")`,
      `CREATE INDEX IF NOT EXISTS "OzonRealizationRow_sku_idx" ON "OzonRealizationRow" ("sku")`,
      `CREATE INDEX IF NOT EXISTS "OzonRealizationRow_vendorCode_idx" ON "OzonRealizationRow" ("vendorCode")`,
      `CREATE INDEX IF NOT EXISTS "OzonDiscountPointsSummary_companyName_idx" ON "OzonDiscountPointsSummary" ("companyName")`,
      `CREATE INDEX IF NOT EXISTS "OzonDiscountPointsSummary_dateFrom_idx" ON "OzonDiscountPointsSummary" ("dateFrom")`,
      `CREATE INDEX IF NOT EXISTS "OzonDiscountPointsSummary_dateTo_idx" ON "OzonDiscountPointsSummary" ("dateTo")`,
      `CREATE INDEX IF NOT EXISTS "OzonDiscountPointsRow_summaryId_idx" ON "OzonDiscountPointsRow" ("summaryId")`,
      `CREATE INDEX IF NOT EXISTS "OzonDiscountPointsRow_companyName_idx" ON "OzonDiscountPointsRow" ("companyName")`,
      `CREATE INDEX IF NOT EXISTS "OzonDiscountPointsRow_dateFrom_idx" ON "OzonDiscountPointsRow" ("dateFrom")`,
      `CREATE INDEX IF NOT EXISTS "OzonDiscountPointsRow_dateTo_idx" ON "OzonDiscountPointsRow" ("dateTo")`,
      `CREATE INDEX IF NOT EXISTS "OzonDiscountPointsRow_category_idx" ON "OzonDiscountPointsRow" ("category")`
    ];

    for (const statement of indexStatements) {
      await client.query(statement);
    }

    await client.query("COMMIT");
    console.log("OZON REALIZATION TABLE PATCH OK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("OZON REALIZATION TABLE PATCH FAILED");
    console.error(error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
