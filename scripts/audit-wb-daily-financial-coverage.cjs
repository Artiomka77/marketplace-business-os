const { Pool } = require('pg');

function getDateEnv(name, fallback) {
  const value = process.env[name] || fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${name} должен быть в формате YYYY-MM-DD`);
  }
  return value;
}

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function main() {
  const dateFrom = getDateEnv('DATE_FROM', '2026-07-06');
  const dateTo = getDateEnv('DATE_TO', '2026-07-07');
  const companyName = process.env.COMPANY_NAME || null;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const finance = await pool.query(
      `
      select
        "companyName",
        "reportNumber",
        "reportTypeName",
        to_char("dateFrom", 'YYYY-MM-DD') as "dateFrom",
        to_char("dateTo", 'YYYY-MM-DD') as "dateTo",
        "salesAmount",
        "payoutAmount",
        "logisticsCost",
        "storageCost",
        "acceptanceCost",
        "otherDeductions",
        "penaltiesAmount",
        "totalToPay"
      from "WbFinance"
      where ("dateFrom"::date between $1::date and $2::date or "dateTo"::date between $1::date and $2::date)
        and ($3::text is null or "companyName" = $3::text)
      order by "companyName", "dateFrom", "reportNumber"
      `,
      [dateFrom, dateTo, companyName]
    );

    const reportNumbers = finance.rows.map((row) => String(row.reportNumber || '')).filter(Boolean);

    const detail = reportNumbers.length
      ? await pool.query(
          `
          select
            "companyName",
            "reportNumber",
            count(*)::int as rows,
            sum(coalesce("wbRealizedAmount", 0)) as "wbRealizedAmount",
            sum(coalesce("sellerPayout", 0)) as "sellerPayout",
            sum(coalesce("wbReward", 0)) as "wbReward",
            sum(coalesce("wbRewardVat", 0)) as "wbRewardVat",
            sum(coalesce("logisticsCost", 0)) as "logisticsCost",
            sum(coalesce("storageCost", 0)) as "storageCost",
            sum(coalesce("acceptanceCost", 0)) as "acceptanceCost",
            sum(coalesce("deductions", 0)) as "deductions",
            sum(coalesce("penaltiesAmount", 0)) as "penaltiesAmount"
          from "WbSale"
          where "reportNumber" = any($1::text[])
            and ($2::text is null or "companyName" = $2::text)
          group by "companyName", "reportNumber"
          order by "companyName", "reportNumber"
          `,
          [reportNumbers, companyName]
        )
      : { rows: [] };

    const detailByReport = new Map(detail.rows.map((row) => [String(row.reportNumber), row]));

    const merged = finance.rows.map((row) => {
      const detailRow = detailByReport.get(String(row.reportNumber)) || null;
      const financeHasExpenses =
        toNumber(row.logisticsCost) !== 0 ||
        toNumber(row.storageCost) !== 0 ||
        toNumber(row.acceptanceCost) !== 0 ||
        toNumber(row.otherDeductions) !== 0 ||
        toNumber(row.penaltiesAmount) !== 0;

      const detailHasExpenses = detailRow
        ? toNumber(detailRow.logisticsCost) !== 0 ||
          toNumber(detailRow.storageCost) !== 0 ||
          toNumber(detailRow.acceptanceCost) !== 0 ||
          toNumber(detailRow.deductions) !== 0 ||
          toNumber(detailRow.penaltiesAmount) !== 0 ||
          toNumber(detailRow.wbReward) !== 0
        : false;

      return {
        ...row,
        financeHasExpenses,
        detailRows: detailRow ? detailRow.rows : 0,
        detailHasExpenses,
        detail: detailRow,
        status: financeHasExpenses && detailHasExpenses ? 'OK' : financeHasExpenses ? 'NO_DETAIL_ROWS' : 'NO_FINANCE_EXPENSES',
      };
    });

    console.log(JSON.stringify({
      ok: true,
      dateFrom,
      dateTo,
      companyName,
      financeReports: finance.rows.length,
      detailedReports: detail.rows.length,
      rows: merged,
      generatedAt: new Date().toISOString(),
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message, stack: error.stack }, null, 2));
  process.exit(1);
});
