const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const companyName = Buffer.from("0JjQnyDQn9C10YLRgNC+0LI=", "base64").toString("utf8");
const dateFrom = "2026-05-01";
const dateTo = "2026-05-31";

function id(prefix) {
  return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

async function main() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      'DELETE FROM "OzonRealizationSummary" WHERE "companyName"=$1 AND "dateFrom"=$2::date AND "dateTo"=$3::date',
      [companyName, dateFrom, dateTo]
    );

    await client.query(
      'DELETE FROM "OzonDiscountPointsSummary" WHERE "companyName"=$1 AND "dateFrom"=$2::date AND "dateTo"=$3::date',
      [companyName, dateFrom, dateTo]
    );

    await client.query(
      'INSERT INTO "OzonRealizationSummary" ("id","companyName","dateFrom","dateTo","sourceFileName","realizedAmount","returnedAmount","taxableRevenue","partnerProgramsAmount","rowsCount") VALUES ($1,$2,$3::date,$4::date,$5,$6,$7,$8,$9,$10)',
      [id("ozr"), companyName, dateFrom, dateTo, "ozon_realization_may_2026.xlsx", 4931869.82, 278816.92, 4653052.90, 41291.78, 0]
    );

    await client.query(
      'INSERT INTO "OzonDiscountPointsSummary" ("id","companyName","dateFrom","dateTo","sourceFileName","pointsAccrued","pointsWrittenOff","commissionPaidByPoints","logisticsPaidByPoints","fboPaidByPoints","advertisingPaidByPoints","otherPaidByPoints","totalPaidByPoints") VALUES ($1,$2,$3::date,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [id("ozp"), companyName, dateFrom, dateTo, "ozon_points_may_2026.xlsx", 7160269.08, 7160269.08, 0, 0, 0, 0, 0, 7160269.08]
    );

    await client.query("COMMIT");

    console.log("OZON MAY SUMMARY INSERT OK");
    console.log("taxableRevenue=4653052.90");
    console.log("pointsWrittenOff=7160269.08");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("OZON MAY SUMMARY INSERT FAILED");
    console.error(error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
