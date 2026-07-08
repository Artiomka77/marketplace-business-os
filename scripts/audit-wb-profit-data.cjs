const { Pool } = require('pg');

const DATE_FROM = process.env.DATE_FROM || '2026-07-06';
const DATE_TO = process.env.DATE_TO || '2026-07-07';
const COMPANIES = (process.env.COMPANIES || 'ИП Петров,ИП Лебедева')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

const EXPECTED_DAILY_REPORT_2026_07_07 = {
  'ИП Петров': {
    ordersQty: 149,
    ordersAmount: 847755,
    salesQty: 64,
    salesAmount: 329108,
    adSpend: 34348,
    stockQty: 3372,
  },
  'ИП Лебедева': {
    ordersQty: 27,
    ordersAmount: 131275,
    salesQty: 9,
    salesAmount: 51957,
    adSpend: 0,
    stockQty: 1313,
  },
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function dateOnly(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetweenInclusive(from, to) {
  const start = new Date(`${from}T00:00:00.000Z`).getTime();
  const end = new Date(`${to}T00:00:00.000Z`).getTime();
  return Math.max(1, Math.round((end - start) / 86400000) + 1);
}

function normalizeReason(value) {
  return String(value || '').toLowerCase().replaceAll('ё', 'е').trim();
}

function isWbSaleOperation(reason) {
  const value = normalizeReason(reason);
  return value === 'продажа' || value === 'сторно возвратов';
}

function isWbReturnOperation(reason) {
  return normalizeReason(reason) === 'возврат';
}

function isDailyStatsReport(reportNumber) {
  return String(reportNumber || '').startsWith('WB_DAILY_STATISTICS_');
}

function getDateSpan(from, to) {
  const start = from ? new Date(from) : to ? new Date(to) : null;
  const end = to ? new Date(to) : from ? new Date(from) : null;
  if (!start || !end) return [];
  start.setUTCHours(0, 0, 0, 0);
  end.setUTCHours(0, 0, 0, 0);
  const dates = [];
  for (const d = new Date(start); d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

function selectPreferredWbSaleRows(rows) {
  const rowsByCompanyDay = new Map();
  for (const row of rows) {
    const key = `${row.companyName}__${row.saleDay}`;
    const list = rowsByCompanyDay.get(key) || [];
    list.push(row);
    rowsByCompanyDay.set(key, list);
  }

  const preferred = [];
  for (const dayRows of rowsByCompanyDay.values()) {
    const finalRows = dayRows.filter((row) => !isDailyStatsReport(row.reportNumber));
    const dailyRows = dayRows.filter((row) => isDailyStatsReport(row.reportNumber));
    preferred.push(...(finalRows.length > 0 ? finalRows : dailyRows));
  }
  return preferred;
}

function summarizeWbSaleRows(rows) {
  const summary = {
    rows: rows.length,
    reportNumbers: [...new Set(rows.map((r) => r.reportNumber).filter(Boolean))].slice(0, 20),
    importSessions: [...new Set(rows.map((r) => r.importSessionId).filter(Boolean))].slice(0, 20),
    salesQty: 0,
    salesAmount: 0,
    sellerPayout: 0,
    returnsQty: 0,
    returnsAmount: 0,
    netQty: 0,
    netSalesAmount: 0,
    reasons: {},
  };

  for (const row of rows) {
    const qty = Math.abs(Number(row.quantity || 0)) || 1;
    const realized = Math.abs(Number(row.wbRealizedAmount || 0));
    const payout = Math.abs(Number(row.sellerPayout || 0));
    const reason = row.paymentReason || 'NO_REASON';
    summary.reasons[reason] = (summary.reasons[reason] || 0) + 1;

    if (isWbSaleOperation(row.paymentReason)) {
      summary.salesQty += qty;
      summary.salesAmount += realized;
      summary.sellerPayout += payout;
    } else if (isWbReturnOperation(row.paymentReason)) {
      summary.returnsQty += qty;
      summary.returnsAmount += realized;
    }
  }

  summary.salesAmount = round2(summary.salesAmount);
  summary.sellerPayout = round2(summary.sellerPayout);
  summary.returnsAmount = round2(summary.returnsAmount);
  summary.netQty = summary.salesQty - summary.returnsQty;
  summary.netSalesAmount = round2(summary.salesAmount - summary.returnsAmount);
  return summary;
}

function keepLatestWbAdsRowsPerDate(rows) {
  const latestSessionByCompanyDate = new Map();
  for (const row of rows) {
    const dates = getDateSpan(row.dateFrom, row.dateTo);
    for (const date of dates) {
      const key = `${row.companyName}__${date}`;
      if (!latestSessionByCompanyDate.has(key)) {
        latestSessionByCompanyDate.set(key, row.importSessionId || null);
      }
    }
  }
  return rows.filter((row) => {
    const dates = getDateSpan(row.dateFrom, row.dateTo);
    return dates.some((date) => latestSessionByCompanyDate.get(`${row.companyName}__${date}`) === (row.importSessionId || null));
  });
}

function summarizeAds(rows) {
  return {
    rows: rows.length,
    spend: round2(rows.reduce((sum, row) => sum + Number(row.spend || 0), 0)),
    importSessions: [...new Set(rows.map((r) => r.importSessionId).filter(Boolean))].slice(0, 20),
  };
}

function compareToExpected(actual, expected) {
  if (!expected) return null;
  const result = {};
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = Number(actual[key] || 0);
    result[key] = {
      expected: expectedValue,
      actual: round2(actualValue),
      delta: round2(actualValue - expectedValue),
      ok: Math.abs(actualValue - expectedValue) < 1,
    };
  }
  return result;
}

async function main() {
  const dateToExclusive = addDaysIso(DATE_TO, 1);
  const dailyDate = DATE_TO;

  const companiesResult = await pool.query(
    `
      SELECT c."id", c."name", c."isActive", api."marketplace", api."isEnabled", api."status", api."lastSyncAt", api."lastAttemptAt", api."lastError"
      FROM "Company" c
      LEFT JOIN "MarketplaceApiConnection" api ON api."companyId" = c."id" AND api."marketplace" = 'WB'
      WHERE c."name" = ANY($1)
      ORDER BY c."name"
    `,
    [COMPANIES]
  );

  const orderStatsResult = await pool.query(
    `
      SELECT
        "companyName",
        "marketplace",
        to_char("orderDate", 'YYYY-MM-DD') AS "orderDay",
        SUM(COALESCE("ordersQty", 0))::float AS "ordersQty",
        SUM(COALESCE("ordersAmount", 0))::float AS "ordersAmount",
        COUNT(*)::int AS "rows"
      FROM "MarketplaceDailyOrderStat"
      WHERE "companyName" = ANY($1)
        AND "orderDate" >= $2::date
        AND "orderDate" < $3::date
      GROUP BY "companyName", "marketplace", to_char("orderDate", 'YYYY-MM-DD')
      ORDER BY "companyName", "marketplace", "orderDay"
    `,
    [COMPANIES, DATE_FROM, dateToExclusive]
  );

  const wbSaleRowsResult = await pool.query(
    `
      SELECT
        "id",
        "companyName",
        "importSessionId",
        "reportNumber",
        to_char("saleDate", 'YYYY-MM-DD') AS "saleDay",
        "paymentReason",
        "documentType",
        COALESCE("quantity", 0)::float AS "quantity",
        COALESCE("retailPrice", 0)::float AS "retailPrice",
        COALESCE("retailPriceWithDiscount", 0)::float AS "retailPriceWithDiscount",
        COALESCE("wbRealizedAmount", 0)::float AS "wbRealizedAmount",
        COALESCE("sellerPayout", 0)::float AS "sellerPayout",
        "createdAt"
      FROM "WbSale"
      WHERE "companyName" = ANY($1)
        AND "saleDate" >= $2::date
        AND "saleDate" < $3::date
      ORDER BY "companyName", "saleDate", "createdAt"
    `,
    [COMPANIES, DATE_FROM, dateToExclusive]
  );

  const adsRowsResult = await pool.query(
    `
      SELECT
        "companyName",
        "importSessionId",
        "campaignId",
        "campaignName",
        "dateFrom",
        "dateTo",
        COALESCE("spend", 0)::float AS "spend",
        "createdAt"
      FROM "WbAds"
      WHERE "companyName" = ANY($1)
        AND "dateFrom" <= $3::date
        AND "dateTo" >= $2::date
      ORDER BY "companyName", "createdAt" DESC
    `,
    [COMPANIES, DATE_FROM, DATE_TO]
  );

  const financeRowsResult = await pool.query(
    `
      SELECT
        "companyName",
        "reportNumber",
        "dateFrom",
        "dateTo",
        COALESCE("salesAmount", 0)::float AS "salesAmount",
        COALESCE("payoutAmount", 0)::float AS "payoutAmount",
        COALESCE("logisticsCost", 0)::float AS "logisticsCost",
        COALESCE("storageCost", 0)::float AS "storageCost",
        COALESCE("acceptanceCost", 0)::float AS "acceptanceCost",
        COALESCE("otherDeductions", 0)::float AS "otherDeductions",
        COALESCE("penaltiesAmount", 0)::float AS "penaltiesAmount",
        COALESCE("totalToPay", 0)::float AS "totalToPay",
        "createdAt"
      FROM "WbFinance"
      WHERE "companyName" = ANY($1)
        AND "dateFrom" <= $3::date
        AND "dateTo" >= $2::date
      ORDER BY "companyName", "dateFrom", "reportNumber"
    `,
    [COMPANIES, DATE_FROM, DATE_TO]
  );

  const stockResult = await pool.query(
    `
      SELECT DISTINCT ON ("companyName")
        "companyName",
        SUM(COALESCE("warehouseQty", "totalStock", 0)) OVER (PARTITION BY "companyName", "importSessionId")::float AS "stockQty",
        "importSessionId",
        "createdAt"
      FROM "WbStock"
      WHERE "companyName" = ANY($1)
      ORDER BY "companyName", "createdAt" DESC
    `,
    [COMPANIES]
  ).catch((error) => ({ rows: [], error: String(error.message || error) }));

  const sessionsResult = await pool.query(
    `
      SELECT
        "id", "companyName", "marketplace", "reportType", "fileName", "rowsCount", "status", "createdAt"
      FROM "ImportSession"
      WHERE "companyName" = ANY($1)
        AND "marketplace" = 'WB'
        AND "createdAt" >= ($2::date - interval '7 days')
      ORDER BY "createdAt" DESC
      LIMIT 60
    `,
    [COMPANIES, DATE_FROM]
  );

  const allSalesRows = wbSaleRowsResult.rows;
  const preferredSalesRows = selectPreferredWbSaleRows(allSalesRows);
  const allAdsRows = adsRowsResult.rows.map((row) => ({
    ...row,
    dateFrom: row.dateFrom ? new Date(row.dateFrom) : null,
    dateTo: row.dateTo ? new Date(row.dateTo) : null,
  }));
  const preferredAdsRows = keepLatestWbAdsRowsPerDate(allAdsRows);

  const byCompany = {};
  for (const company of COMPANIES) {
    byCompany[company] = {
      apiConnection: companiesResult.rows.find((row) => row.name === company) || null,
      byDay: {},
      range: {},
      wbFinanceOverlappingRows: financeRowsResult.rows.filter((row) => row.companyName === company),
      recentImportSessions: sessionsResult.rows.filter((row) => row.companyName === company),
      stockLatest: stockResult.rows.find((row) => row.companyName === company) || null,
    };

    for (let d = DATE_FROM; d <= DATE_TO; d = addDaysIso(d, 1)) {
      const orderWB = orderStatsResult.rows.find((row) => row.companyName === company && row.marketplace === 'WB' && row.orderDay === d) || null;
      const dayAllRows = allSalesRows.filter((row) => row.companyName === company && row.saleDay === d);
      const dayPreferredRows = preferredSalesRows.filter((row) => row.companyName === company && row.saleDay === d);
      const dayAdsRows = preferredAdsRows.filter((row) => row.companyName === company && getDateSpan(row.dateFrom, row.dateTo).includes(d));
      const daySummary = summarizeWbSaleRows(dayPreferredRows);
      const actual = {
        ordersQty: Number(orderWB?.ordersQty || 0),
        ordersAmount: round2(orderWB?.ordersAmount || 0),
        salesQty: daySummary.salesQty,
        salesAmount: daySummary.salesAmount,
        adSpend: summarizeAds(dayAdsRows).spend,
        stockQty: Number(byCompany[company].stockLatest?.stockQty || 0),
      };
      byCompany[company].byDay[d] = {
        orderStatsWB: orderWB,
        wbSale: {
          allRows: summarizeWbSaleRows(dayAllRows),
          preferredRows: daySummary,
          dailyStatsRows: summarizeWbSaleRows(dayAllRows.filter((row) => isDailyStatsReport(row.reportNumber))),
          finalWeeklyRows: summarizeWbSaleRows(dayAllRows.filter((row) => !isDailyStatsReport(row.reportNumber))),
        },
        wbAds: summarizeAds(dayAdsRows),
        compareToTelegram20260707: d === '2026-07-07' ? compareToExpected(actual, EXPECTED_DAILY_REPORT_2026_07_07[company]) : null,
      };
    }

    const rangeRows = preferredSalesRows.filter((row) => row.companyName === company);
    const rangeAds = preferredAdsRows.filter((row) => row.companyName === company);
    byCompany[company].range = {
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      days: daysBetweenInclusive(DATE_FROM, DATE_TO),
      wbSalePreferred: summarizeWbSaleRows(rangeRows),
      wbAdsPreferred: summarizeAds(rangeAds),
      orderStatsWB: orderStatsResult.rows.filter((row) => row.companyName === company && row.marketplace === 'WB'),
    };
  }

  const result = {
    mode: 'AUDIT_ONLY',
    applied: false,
    ok: true,
    generatedAt: new Date().toISOString(),
    params: {
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      companies: COMPANIES,
    },
    importantInterpretation: {
      profitPageWithDateFromAndDateToIsInclusive: true,
      telegramReport20260707IsOneDayOnly: true,
      note: 'If the profit page is opened with dateFrom=2026-07-06&dateTo=2026-07-07, it must not match a Telegram report for only 2026-07-07.',
    },
    databaseCounts: {
      marketplaceDailyOrderStatRows: orderStatsResult.rows.length,
      wbSaleRows: allSalesRows.length,
      wbAdsRowsRaw: allAdsRows.length,
      wbAdsRowsPreferred: preferredAdsRows.length,
      wbFinanceRowsOverlapping: financeRowsResult.rows.length,
      recentImportSessions: sessionsResult.rows.length,
    },
    byCompany,
    rawSamples: {
      recentImportSessions: sessionsResult.rows.slice(0, 20),
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error.message || error), stack: error.stack }, null, 2));
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
