const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const WB_COMMISSION_VAT_RATE_FALLBACK = 0.22;

const columns = [
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
];

async function main() {
  const client = await pool.connect();

  try {
    console.log("START WB SALE SPP/VAT ENRICHMENT");
    console.log("Fallback commission VAT rate:", WB_COMMISSION_VAT_RATE_FALLBACK);

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
        ADD COLUMN IF NOT EXISTS "loyaltyPointsAmount" NUMERIC(65,30)
    `);

    const result = await client.query(
      `
        UPDATE "WbSale"
        SET
          "retailPriceWithDiscount" = COALESCE("retailPriceWithDiscount", "retailPrice"),
          "sppDiscountAmount" = CASE
            WHEN "sppDiscountAmount" IS NULL
            THEN COALESCE("retailPriceWithDiscount", "retailPrice", 0) - COALESCE("wbRealizedAmount", 0)
            ELSE "sppDiscountAmount"
          END,
          "platformDiscountPercent" = CASE
            WHEN "platformDiscountPercent" IS NULL
              AND COALESCE("retailPriceWithDiscount", "retailPrice", 0) <> 0
            THEN (
              (
                COALESCE("retailPriceWithDiscount", "retailPrice", 0) - COALESCE("wbRealizedAmount", 0)
              ) / COALESCE("retailPriceWithDiscount", "retailPrice", 1)
            ) * 100
            ELSE COALESCE("platformDiscountPercent", 0)
          END,
          "commissionPercentBase" = COALESCE("commissionPercentBase", 0),
          "commissionPercentFinal" = COALESCE("commissionPercentFinal", 0),
          "wbRewardVat" = CASE
            WHEN COALESCE("wbRewardVat", 0) = 0 AND COALESCE("wbReward", 0) <> 0
            THEN COALESCE("wbReward", 0) * $1
            ELSE COALESCE("wbRewardVat", 0)
          END,
          "wbRewardTotal" = CASE
            WHEN COALESCE("wbRewardTotal", 0) = 0
            THEN COALESCE("wbReward", 0) + (
              CASE
                WHEN COALESCE("wbRewardVat", 0) = 0 AND COALESCE("wbReward", 0) <> 0
                THEN COALESCE("wbReward", 0) * $1
                ELSE COALESCE("wbRewardVat", 0)
              END
            )
            ELSE "wbRewardTotal"
          END,
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
          OR (COALESCE("wbRewardVat", 0) = 0 AND COALESCE("wbReward", 0) <> 0)
          OR "wbRewardTotal" IS NULL
          OR (COALESCE("wbRewardTotal", 0) = 0 AND COALESCE("wbReward", 0) <> 0)
          OR "loyaltyDiscountCompensation" IS NULL
          OR "loyaltyParticipationCost" IS NULL
          OR "loyaltyPointsAmount" IS NULL
      `,
      [WB_COMMISSION_VAT_RATE_FALLBACK]
    );

    await client.query("COMMIT");

    console.log("UPDATED ROWS:", result.rowCount);

    const columnResult = await client.query(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'WbSale'
          AND column_name = ANY($1::text[])
        ORDER BY column_name
      `,
      [columns]
    );

    console.log("COLUMNS FOUND:", columnResult.rows.length);
    console.table(columnResult.rows);

    const reportCheck = await client.query(`
      SELECT
        "companyName",
        "reportNumber",
        COUNT(*)::int AS rows,
        ROUND(SUM(COALESCE("retailPriceWithDiscount", "retailPrice", 0))::numeric, 2) AS seller_retail,
        ROUND(SUM(COALESCE("wbRealizedAmount", 0))::numeric, 2) AS wb_realized,
        ROUND(SUM(COALESCE("sppDiscountAmount", 0))::numeric, 2) AS spp,
        ROUND(SUM(COALESCE("wbReward", 0))::numeric, 2) AS commission_without_vat,
        ROUND(SUM(COALESCE("wbRewardVat", 0))::numeric, 2) AS commission_vat,
        ROUND(SUM(COALESCE("wbRewardTotal", 0))::numeric, 2) AS commission_total
      FROM "WbSale"
      WHERE "reportNumber" IN ('764420141', '767331387')
      GROUP BY "companyName", "reportNumber"
      ORDER BY "companyName", "reportNumber"
    `);

    console.log("CONTROL REPORTS 764420141 / 767331387:");
    console.table(reportCheck.rows);
    console.log("ENRICHMENT OK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("ENRICHMENT FAILED");
    console.error(error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
