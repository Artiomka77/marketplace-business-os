const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const APPLY_FIX = process.env.APPLY_FIX === "true";

const companyName = "ИП Петров";
const dateFrom = "2026-06-01";
const dateTo = "2026-06-30";

const realization = {
  sourceFileName: "Ozon Seller / Экономика магазина / 01.06.2026-30.06.2026",
  realizedAmount: 7046626,
  returnedAmount: 0,
  taxableRevenue: 7046626,
  partnerProgramsAmount: 69340,
  rowsCount: 0,
};

const points = {
  sourceFileName: "Отчёт о начислении и списании баллов_июнь 2026.xlsx",
  pointsAccrued: 12348325.59,
  pointsWrittenOff: 12348325.59,
  commissionPaidByPoints: 9053224.34,
  logisticsPaidByPoints: 0,
  fboPaidByPoints: 0,
  advertisingPaidByPoints: 1629643.52,
  otherPaidByPoints: 1665457.73,
  totalPaidByPoints: 12348325.59,
};

function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`;
}

function money(value) {
  return Number(value || 0).toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + " ₽";
}

async function printCurrent(client, label) {
  console.log("");
  console.log(label);

  const r = await client.query(
    `
      SELECT
        "id",
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
    [companyName, dateFrom, dateTo]
  );

  const p = await client.query(
    `
      SELECT
        "id",
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
    [companyName, dateFrom, dateTo]
  );

  console.log("OzonRealizationSummary rows:", r.rows.length);
  for (const row of r.rows) {
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

  console.log("OzonDiscountPointsSummary rows:", p.rows.length);
  for (const row of p.rows) {
    console.log({
      sourceFileName: row.sourceFileName,
      pointsAccrued: money(row.pointsAccrued),
      pointsWrittenOff: money(row.pointsWrittenOff),
      totalPaidByPoints: money(row.totalPaidByPoints),
      commissionPaidByPoints: money(row.commissionPaidByPoints),
      advertisingPaidByPoints: money(row.advertisingPaidByPoints),
      otherPaidByPoints: money(row.otherPaidByPoints),
      createdAt: row.createdAt,
    });
  }

  const expectedEconomicTurnover =
    realization.taxableRevenue +
    realization.partnerProgramsAmount +
    points.totalPaidByPoints;

  console.log("");
  console.log("Expected page values after fix:");
  console.log("taxableRevenue:", money(realization.taxableRevenue));
  console.log("partnerProgramsAmount:", money(realization.partnerProgramsAmount));
  console.log("discountPointsAmount:", money(points.totalPaidByPoints));
  console.log("economicTurnover:", money(expectedEconomicTurnover));
}

async function main() {
  const client = await pool.connect();

  try {
    console.log("FIX OZON JUNE PETROV SUMMARY");
    console.log("APPLY_FIX=" + APPLY_FIX);
    console.log(`Company: ${companyName}`);
    console.log(`Period: ${dateFrom} — ${dateTo}`);

    await printCurrent(client, "Before:");

    if (!APPLY_FIX) {
      console.log("");
      console.log("DRY RUN ONLY. No data changed.");
      return;
    }

    await client.query("BEGIN");

    await client.query(
      `
        DELETE FROM "OzonRealizationSummary"
        WHERE "companyName" = $1
          AND "dateFrom"::date = $2::date
          AND "dateTo"::date = $3::date
      `,
      [companyName, dateFrom, dateTo]
    );

    await client.query(
      `
        INSERT INTO "OzonRealizationSummary" (
          "id",
          "companyName",
          "dateFrom",
          "dateTo",
          "sourceFileName",
          "realizedAmount",
          "returnedAmount",
          "taxableRevenue",
          "partnerProgramsAmount",
          "rowsCount"
        )
        VALUES ($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10)
      `,
      [
        id("ozr"),
        companyName,
        dateFrom,
        dateTo,
        realization.sourceFileName,
        realization.realizedAmount,
        realization.returnedAmount,
        realization.taxableRevenue,
        realization.partnerProgramsAmount,
        realization.rowsCount,
      ]
    );

    await client.query(
      `
        DELETE FROM "OzonDiscountPointsRow"
        WHERE "companyName" = $1
          AND "dateFrom"::date = $2::date
          AND "dateTo"::date = $3::date
      `,
      [companyName, dateFrom, dateTo]
    );

    await client.query(
      `
        DELETE FROM "OzonDiscountPointsSummary"
        WHERE "companyName" = $1
          AND "dateFrom"::date = $2::date
          AND "dateTo"::date = $3::date
      `,
      [companyName, dateFrom, dateTo]
    );

    const pointsSummaryId = id("ozp");

    await client.query(
      `
        INSERT INTO "OzonDiscountPointsSummary" (
          "id",
          "companyName",
          "dateFrom",
          "dateTo",
          "sourceFileName",
          "pointsAccrued",
          "pointsWrittenOff",
          "commissionPaidByPoints",
          "logisticsPaidByPoints",
          "fboPaidByPoints",
          "advertisingPaidByPoints",
          "otherPaidByPoints",
          "totalPaidByPoints"
        )
        VALUES ($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `,
      [
        pointsSummaryId,
        companyName,
        dateFrom,
        dateTo,
        points.sourceFileName,
        points.pointsAccrued,
        points.pointsWrittenOff,
        points.commissionPaidByPoints,
        points.logisticsPaidByPoints,
        points.fboPaidByPoints,
        points.advertisingPaidByPoints,
        points.otherPaidByPoints,
        points.totalPaidByPoints,
      ]
    );

    const pointRows = [
      ["COMMISSION", "Вознаграждение Ozon", points.commissionPaidByPoints],
      ["ADVERTISING", "Продвижение и реклама", points.advertisingPaidByPoints],
      ["OTHER", "Прочие услуги и штрафы", points.otherPaidByPoints],
    ];

    for (const row of pointRows) {
      await client.query(
        `
          INSERT INTO "OzonDiscountPointsRow" (
            "id",
            "summaryId",
            "companyName",
            "dateFrom",
            "dateTo",
            "category",
            "name",
            "amount"
          )
          VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8)
        `,
        [id("ozpr"), pointsSummaryId, companyName, dateFrom, dateTo, row[0], row[1], row[2]]
      );
    }

    await client.query("COMMIT");

    await printCurrent(client, "After:");
    console.log("");
    console.log("FIX DONE");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("FIX FAILED");
    console.error(error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
