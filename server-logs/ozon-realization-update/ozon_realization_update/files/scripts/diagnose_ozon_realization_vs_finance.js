const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function getArg(name, fallback = "") {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  return Math.round(toNumber(value)).toLocaleString("ru-RU") + " ₽";
}

async function main() {
  const companyName = getArg("companyName", "ИП Петров");
  const dateFrom = getArg("dateFrom", "2026-05-01");
  const dateTo = getArg("dateTo", "2026-05-31");

  const client = await pool.connect();

  try {
    const finance = await client.query(
      `
        SELECT
          COALESCE(SUM("salesAmount"), 0) AS "salesAmount",
          COALESCE(SUM("totalAmount"), 0) AS "totalAmount",
          COALESCE(SUM("ozonCommission"), 0) AS "ozonCommission",
          COALESCE(SUM("logisticsCost"), 0) AS "logisticsCost",
          COALESCE(SUM("reverseLogisticsCost"), 0) AS "reverseLogisticsCost",
          COUNT(*)::int AS "rowsCount"
        FROM "OzonFinance"
        WHERE "companyName" = $1
          AND "accrualDate" >= $2::date
          AND "accrualDate" < ($3::date + interval '1 day')
      `,
      [companyName, dateFrom, dateTo]
    );

    const realization = await client.query(
      `
        SELECT *
        FROM "OzonRealizationSummary"
        WHERE "companyName" = $1
          AND "dateFrom" = $2::date
          AND "dateTo" = $3::date
        ORDER BY "createdAt" DESC
        LIMIT 1
      `,
      [companyName, dateFrom, dateTo]
    );

    const points = await client.query(
      `
        SELECT *
        FROM "OzonDiscountPointsSummary"
        WHERE "companyName" = $1
          AND "dateFrom" = $2::date
          AND "dateTo" = $3::date
        ORDER BY "createdAt" DESC
        LIMIT 1
      `,
      [companyName, dateFrom, dateTo]
    );

    const f = finance.rows[0];
    const r = realization.rows[0] || null;
    const p = points.rows[0] || null;

    console.log("OZON MAY CHECK");
    console.log("company:", companyName);
    console.log("period:", dateFrom, "-", dateTo);
    console.log("");

    console.log("OzonFinance / старый источник сайта:");
    console.log("salesAmount:", money(f.salesAmount));
    console.log("totalAmount:", money(f.totalAmount));
    console.log("commission:", money(f.ozonCommission));
    console.log("logistics:", money(toNumber(f.logisticsCost) + toNumber(f.reverseLogisticsCost)));
    console.log("rows:", f.rowsCount);
    console.log("");

    if (r) {
      console.log("OzonRealization / налоговая база:");
      console.log("realizedAmount:", money(r.realizedAmount));
      console.log("returnedAmount:", money(r.returnedAmount));
      console.log("taxableRevenue:", money(r.taxableRevenue));
      console.log("partnerProgramsAmount:", money(r.partnerProgramsAmount));
      console.log("rows:", r.rowsCount);
      console.log("difference finance.salesAmount - taxableRevenue:", money(toNumber(f.salesAmount) - toNumber(r.taxableRevenue)));
    } else {
      console.log("OzonRealization: нет загруженного отчёта реализации за период.");
    }

    console.log("");

    if (p) {
      console.log("Ozon discount points / соинвест:");
      console.log("pointsAccrued:", money(p.pointsAccrued));
      console.log("pointsWrittenOff:", money(p.pointsWrittenOff));
      console.log("commissionPaidByPoints:", money(p.commissionPaidByPoints));
      console.log("logisticsPaidByPoints:", money(p.logisticsPaidByPoints));
      console.log("fboPaidByPoints:", money(p.fboPaidByPoints));
      console.log("advertisingPaidByPoints:", money(p.advertisingPaidByPoints));
      console.log("otherPaidByPoints:", money(p.otherPaidByPoints));
      console.log("totalPaidByPoints:", money(p.totalPaidByPoints));
    } else {
      console.log("OzonDiscountPoints: нет загруженного отчёта баллов за период.");
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
