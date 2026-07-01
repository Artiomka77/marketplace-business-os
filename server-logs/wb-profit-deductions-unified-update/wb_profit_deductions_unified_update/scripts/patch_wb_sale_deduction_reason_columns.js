const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const expectedColumns = [
  "retailPriceWithDiscount",
  "platformDiscountPercent",
  "sppDiscountAmount",
  "commissionPercentBase",
  "commissionPercentFinal",
  "wbRewardVat",
  "wbRewardTotal",
  "loyaltyDiscountCompensation",
  "loyaltyParticipationCost",
  "loyaltyPointsAmount",
  "deductionReason",
];

async function main() {
  const client = await pool.connect();

  try {
    console.log("START WB SALE DEDUCTION / SPP COLUMN PATCH");

    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE "WbSale"
        ADD COLUMN IF NOT EXISTS "retailPriceWithDiscount" NUMERIC(65,30),
        ADD COLUMN IF NOT EXISTS "platformDiscountPercent" NUMERIC(65,30),
        ADD COLUMN IF NOT EXISTS "sppDiscountAmount" NUMERIC(65,30),
        ADD COLUMN IF NOT EXISTS "commissionPercentBase" NUMERIC(65,30),
        ADD COLUMN IF NOT EXISTS "commissionPercentFinal" NUMERIC(65,30),
        ADD COLUMN IF NOT EXISTS "wbRewardVat" NUMERIC(65,30),
        ADD COLUMN IF NOT EXISTS "wbRewardTotal" NUMERIC(65,30),
        ADD COLUMN IF NOT EXISTS "loyaltyDiscountCompensation" NUMERIC(65,30),
        ADD COLUMN IF NOT EXISTS "loyaltyParticipationCost" NUMERIC(65,30),
        ADD COLUMN IF NOT EXISTS "loyaltyPointsAmount" NUMERIC(65,30),
        ADD COLUMN IF NOT EXISTS "deductionReason" TEXT
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS "WbSale_deductionReason_idx"
        ON "WbSale"("deductionReason")
    `);

    const updateResult = await client.query(`
      UPDATE "WbSale"
      SET
        "retailPriceWithDiscount" = COALESCE("retailPriceWithDiscount", "retailPrice"),
        "sppDiscountAmount" = COALESCE(
          "sppDiscountAmount",
          COALESCE("retailPriceWithDiscount", "retailPrice", 0) - COALESCE("wbRealizedAmount", 0)
        ),
        "platformDiscountPercent" = COALESCE(
          "platformDiscountPercent",
          CASE
            WHEN COALESCE("retailPriceWithDiscount", "retailPrice", 0) <> 0
            THEN (
              (
                COALESCE("retailPriceWithDiscount", "retailPrice", 0) - COALESCE("wbRealizedAmount", 0)
              ) / COALESCE("retailPriceWithDiscount", "retailPrice", 1)
            ) * 100
            ELSE 0
          END
        ),
        "commissionPercentBase" = COALESCE("commissionPercentBase", 0),
        "commissionPercentFinal" = COALESCE("commissionPercentFinal", 0),
        "wbRewardVat" = COALESCE("wbRewardVat", 0),
        "wbRewardTotal" = COALESCE("wbRewardTotal", COALESCE("wbReward", 0) + COALESCE("wbRewardVat", 0)),
        "loyaltyDiscountCompensation" = COALESCE("loyaltyDiscountCompensation", 0),
        "loyaltyParticipationCost" = COALESCE("loyaltyParticipationCost", 0),
        "loyaltyPointsAmount" = COALESCE("loyaltyPointsAmount", 0)
      WHERE
        "retailPriceWithDiscount" IS NULL
        OR "sppDiscountAmount" IS NULL
        OR "platformDiscountPercent" IS NULL
        OR "commissionPercentBase" IS NULL
        OR "commissionPercentFinal" IS NULL
        OR "wbRewardVat" IS NULL
        OR "wbRewardTotal" IS NULL
        OR "loyaltyDiscountCompensation" IS NULL
        OR "loyaltyParticipationCost" IS NULL
        OR "loyaltyPointsAmount" IS NULL
    `);

    await client.query("COMMIT");

    console.log("UPDATED ROWS:", updateResult.rowCount);

    const result = await client.query(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'WbSale'
          AND column_name = ANY($1::text[])
        ORDER BY column_name
      `,
      [expectedColumns]
    );

    console.log("COLUMNS FOUND:", result.rows.length);
    console.table(result.rows);

    if (result.rows.length !== expectedColumns.length) {
      throw new Error(`Expected ${expectedColumns.length} columns, found ${result.rows.length}`);
    }

    console.log("WB SALE COLUMN PATCH OK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("WB SALE COLUMN PATCH FAILED");
    console.error(error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
