const { Client } = require("pg");

async function main() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "OzonFinancialCategoryFact" (
        "id" TEXT PRIMARY KEY,
        "importSessionId" TEXT,
        "companyName" TEXT,
        "operationDate" TIMESTAMPTZ,
        "dateFrom" TIMESTAMPTZ,
        "dateTo" TIMESTAMPTZ,
        "source" TEXT NOT NULL DEFAULT 'OZON_FINANCE_API',
        "sourceOperationType" TEXT,
        "sourceOperationCode" TEXT,
        "sourceServiceName" TEXT,
        "category" TEXT NOT NULL,
        "amount" NUMERIC(18, 2) NOT NULL DEFAULT 0,
        "includeInProfit" BOOLEAN NOT NULL DEFAULT TRUE,
        "isCashFlowOnly" BOOLEAN NOT NULL DEFAULT FALSE,
        "isCompensation" BOOLEAN NOT NULL DEFAULT FALSE,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS "OzonFinancialCategoryFact_company_date_idx"
      ON "OzonFinancialCategoryFact" ("companyName", "operationDate")
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS "OzonFinancialCategoryFact_category_idx"
      ON "OzonFinancialCategoryFact" ("category")
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS "OzonFinancialCategoryFact_importSession_idx"
      ON "OzonFinancialCategoryFact" ("importSessionId")
    `);

    console.log("OZON FINANCIAL CATEGORY FACT PATCH OK");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("OZON FINANCIAL CATEGORY FACT PATCH FAILED");
  console.error(error);
  process.exit(1);
});
