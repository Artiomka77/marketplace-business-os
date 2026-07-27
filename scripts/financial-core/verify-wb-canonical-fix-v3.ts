import { prisma } from "@/lib/prisma";
import { getProfitAnalytics } from "@/lib/analytics/profitAnalytics";
import { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";
import { buildDailyReport } from "@/lib/telegram/dailyReport";

const MODE = String(process.env.VERIFY_MODE ?? "").trim();
const VERIFICATION_NAME =
  "AVOROFIN_WB_READONLY_VERIFICATION_V13";
const DATE_FROM = "2026-07-01";
const DATE_TO = "2026-07-26";
const DEFAULT_TOLERANCE = 2;

function asNumber(value: unknown) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) {
    throw new Error(`Non-finite number: ${String(value)}`);
  }
  return number;
}

function assertNear(
  label: string,
  actualValue: unknown,
  expected: number,
  tolerance = DEFAULT_TOLERANCE
) {
  const actual = asNumber(actualValue);
  const delta = Math.abs(actual - expected);

  if (delta > tolerance) {
    throw new Error(
      `${label}: expected ${expected}, actual ${actual}, delta ${delta}, tolerance ${tolerance}`
    );
  }

  return { label, actual, expected, delta, tolerance };
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  return {
    rssMb: memory.rss / 1024 / 1024,
    heapUsedMb: memory.heapUsed / 1024 / 1024,
    heapTotalMb: memory.heapTotal / 1024 / 1024,
    externalMb: memory.external / 1024 / 1024,
  };
}

async function verifyWb(params: {
  companyName: "ALL" | "ИП Петров" | "ИП Лебедева";
  expectedProfit: number;
  expected?: {
    economicTurnover: number;
    revenue: number;
    sellerPayout: number;
    totalCost: number;
    logisticsCost: number;
    storageCost: number;
    penaltiesAmount: number;
    adsCost: number;
    taxesAmount: number;
  };
}) {
  const startedAt = Date.now();
  const before = memorySnapshot();
  const result = await getProfitAnalytics({
    dateFrom: DATE_FROM,
    dateTo: DATE_TO,
    companyName: params.companyName,
    skipComparison: true,
  });
  const after = memorySnapshot();

  console.log(
    JSON.stringify(
      {
        checkpoint: "WB_TOTALS_BEFORE_ASSERTIONS",
        mode: MODE,
        companyName: params.companyName,
        rowsCount: result.rows.length,
        totals: result.totals,
        memoryBefore: before,
        memoryAfter: after,
      },
      null,
      2
    )
  );

  const checks = [
    assertNear(
      `${params.companyName}.netProfitAfterTax`,
      result.totals.netProfitAfterTax,
      params.expectedProfit
    ),
  ];

  if (params.expected) {
    checks.push(
      assertNear(
        `${params.companyName}.economicTurnover`,
        result.totals.sellerRetailAmount,
        params.expected.economicTurnover
      ),
      assertNear(
        `${params.companyName}.revenue`,
        result.totals.revenue,
        params.expected.revenue
      ),
      assertNear(
        `${params.companyName}.sellerPayout`,
        result.totals.sellerPayout,
        params.expected.sellerPayout
      ),
      assertNear(
        `${params.companyName}.totalCost`,
        result.totals.totalCost,
        params.expected.totalCost
      ),
      assertNear(
        `${params.companyName}.logisticsCost`,
        result.totals.logisticsCost,
        params.expected.logisticsCost
      ),
      assertNear(
        `${params.companyName}.storageCost`,
        result.totals.storageCost,
        params.expected.storageCost
      ),
      assertNear(
        `${params.companyName}.penaltiesAmount`,
        result.totals.penaltiesAmount,
        params.expected.penaltiesAmount
      ),
      assertNear(
        `${params.companyName}.adsCost`,
        result.totals.adsCost,
        params.expected.adsCost
      ),
      assertNear(
        `${params.companyName}.taxesAmount`,
        result.totals.taxesAmount,
        params.expected.taxesAmount
      )
    );
  }

  return {
    mode: MODE,
    companyName: params.companyName,
    elapsedMs: Date.now() - startedAt,
    rowsCount: result.rows.length,
    totals: result.totals,
    checks,
    memoryBefore: before,
    memoryAfter: after,
  };
}

async function verifyOzonAll() {
  const startedAt = Date.now();
  const before = memorySnapshot();
  const result = await getProfitAnalyticsOzon({
    dateFrom: DATE_FROM,
    dateTo: DATE_TO,
    companyName: "ALL",
    skipComparison: true,
  });
  const after = memorySnapshot();

  console.log(
    JSON.stringify(
      {
        checkpoint: "OZON_TOTALS_BEFORE_ASSERTIONS",
        mode: MODE,
        rowsCount: result.rows.length,
        totals: result.totals,
        memoryBefore: before,
        memoryAfter: after,
      },
      null,
      2
    )
  );

  const checks = [
    assertNear(
      "OZON_ALL.economicTurnover",
      result.totals.economicTurnover,
      24_526_654.98
    ),
    assertNear(
      "OZON_ALL.grossOzonExpenses",
      result.totals.grossOzonExpenses,
      17_832_897.51
    ),
    assertNear(
      "OZON_ALL.totalCost",
      result.totals.totalCost,
      3_769_815.00
    ),
    assertNear(
      "OZON_ALL.taxesAmount",
      result.totals.taxesAmount,
      503_112.63
    ),
    assertNear(
      "OZON_ALL.netProfitAfterTax",
      result.totals.netProfitAfterTax,
      2_420_829.84
    ),
  ];

  if (result.totals.netProfitStatus !== "FINAL") {
    throw new Error(
      `OZON_ALL.netProfitStatus expected FINAL, actual ${result.totals.netProfitStatus}`
    );
  }

  return {
    mode: MODE,
    elapsedMs: Date.now() - startedAt,
    rowsCount: result.rows.length,
    totals: result.totals,
    checks,
    memoryBefore: before,
    memoryAfter: after,
  };
}


async function verifyWbAllWithComparison() {
  const startedAt = Date.now();
  const before = memorySnapshot();
  const result = await getProfitAnalytics({
    dateFrom: DATE_FROM,
    dateTo: DATE_TO,
    companyName: "ALL",
  });
  const after = memorySnapshot();

  console.log(
    JSON.stringify(
      {
        checkpoint: "WB_COMPARISON_BEFORE_ASSERTIONS",
        mode: MODE,
        currentRowsCount: result.rows.length,
        previousRowsCount: result.previousRows.length,
        totals: result.totals,
        previousTotals: result.previousTotals,
        memoryBefore: before,
        memoryAfter: after,
      },
      null,
      2
    )
  );

  const checks = [
    assertNear(
      "WB_ALL_COMPARISON.netProfitAfterTax",
      result.totals.netProfitAfterTax,
      1_359_701.6852904762
    ),
    assertNear(
      "WB_ALL_COMPARISON.economicTurnover",
      result.totals.sellerRetailAmount,
      18_227_836.37
    ),
  ];

  return {
    mode: MODE,
    elapsedMs: Date.now() - startedAt,
    currentRowsCount: result.rows.length,
    previousRowsCount: result.previousRows.length,
    totals: result.totals,
    previousTotals: result.previousTotals,
    checks,
    memoryBefore: before,
    memoryAfter: after,
  };
}

async function verifyDashboardCore() {
  const startedAt = Date.now();
  const before = memorySnapshot();

  const current = await buildDailyReport({
    from: DATE_FROM,
    to: DATE_TO,
    skipComparison: true,
  });
  const previous = await buildDailyReport({
    from: "2026-06-05",
    to: "2026-06-30",
    skipComparison: true,
  });

  const currentWbProfit = current.companies.reduce(
    (sum, company) => sum + Number(company.wb.netProfitAfterTax ?? 0),
    0
  );
  const currentOzonProfit = current.companies.reduce(
    (sum, company) => sum + Number(company.ozon.netProfitAfterTax ?? 0),
    0
  );

  console.log(
    JSON.stringify(
      {
        checkpoint: "DASHBOARD_CORE_BEFORE_ASSERTIONS",
        mode: MODE,
        currentCompanyCount: current.companies.length,
        previousCompanyCount: previous.companies.length,
        currentWbProfit,
        currentOzonProfit,
        currentTotals: current.totals,
        previousTotals: previous.totals,
      },
      null,
      2
    )
  );

  const checks = [
    assertNear(
      "DASHBOARD_CORE.wbNetProfitAfterTax",
      currentWbProfit,
      1_359_701.6852904762
    ),
    assertNear(
      "DASHBOARD_CORE.ozonNetProfitAfterTax",
      currentOzonProfit,
      2_420_829.84
    ),
  ];

  const after = memorySnapshot();

  return {
    mode: MODE,
    elapsedMs: Date.now() - startedAt,
    currentCompanyCount: current.companies.length,
    previousCompanyCount: previous.companies.length,
    currentWbProfit,
    currentOzonProfit,
    currentTotals: current.totals,
    previousTotals: previous.totals,
    checks,
    memoryBefore: before,
    memoryAfter: after,
  };
}

async function verifyInsightsCore() {
  const startedAt = Date.now();
  const before = memorySnapshot();
  const companyNames = ["ИП Лебедева", "ИП Петров"] as const;

  let wbProfit = 0;
  let ozonProfit = 0;
  const companyResults: unknown[] = [];

  for (const companyName of companyNames) {
    const wb = await getProfitAnalytics({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      companyName,
      skipComparison: true,
    });
    const ozon = await getProfitAnalyticsOzon({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      companyName,
      skipComparison: true,
    });
    const previousWb = await getProfitAnalytics({
      dateFrom: "2026-06-05",
      dateTo: "2026-06-30",
      companyName,
      skipComparison: true,
    });
    const previousOzon = await getProfitAnalyticsOzon({
      dateFrom: "2026-06-05",
      dateTo: "2026-06-30",
      companyName,
      skipComparison: true,
    });

    wbProfit += Number(wb.totals.netProfitAfterTax ?? 0);
    ozonProfit += Number(ozon.totals.netProfitAfterTax ?? 0);

    companyResults.push({
      companyName,
      wbRows: wb.rows.length,
      ozonRows: ozon.rows.length,
      previousWbRows: previousWb.rows.length,
      previousOzonRows: previousOzon.rows.length,
    });
  }

  console.log(
    JSON.stringify(
      {
        checkpoint: "INSIGHTS_CORE_BEFORE_ASSERTIONS",
        mode: MODE,
        wbProfit,
        ozonProfit,
        companyResults,
      },
      null,
      2
    )
  );

  const checks = [
    assertNear(
      "INSIGHTS_CORE.wbNetProfitAfterTax",
      wbProfit,
      1_359_701.6852904762
    ),
    assertNear(
      "INSIGHTS_CORE.ozonNetProfitAfterTax",
      ozonProfit,
      2_420_829.84
    ),
  ];

  const after = memorySnapshot();

  return {
    mode: MODE,
    elapsedMs: Date.now() - startedAt,
    wbProfit,
    ozonProfit,
    companyResults,
    checks,
    memoryBefore: before,
    memoryAfter: after,
  };
}

async function main() {
  let verification: unknown;

  if (MODE === "WB_ALL") {
    verification = await verifyWb({
      companyName: "ALL",
      expectedProfit: 1_359_701.6852904762,
      expected: {
        economicTurnover: 18_227_836.37,
        revenue: 12_683_681.09,
        sellerPayout: 7_228_011.33,
        totalCost: 2_067_760.00,
        logisticsCost: 1_996_592.17,
        storageCost: 74_638.85,
        penaltiesAmount: 140.00,
        adsCost: 998_357.00,
        taxesAmount: 730_821.6247095238,
      },
    });
  } else if (MODE === "WB_PETROV") {
    verification = await verifyWb({
      companyName: "ИП Петров",
      expectedProfit: 1_145_293.888295238,
    });
  } else if (MODE === "WB_LEBEDEVA") {
    verification = await verifyWb({
      companyName: "ИП Лебедева",
      expectedProfit: 214_407.7969952381,
    });
  } else if (MODE === "OZON_ALL") {
    verification = await verifyOzonAll();
  } else if (MODE === "WB_ALL_COMPARISON") {
    verification = await verifyWbAllWithComparison();
  } else if (MODE === "DASHBOARD_CORE") {
    verification = await verifyDashboardCore();
  } else if (MODE === "INSIGHTS_CORE") {
    verification = await verifyInsightsCore();
  } else {
    throw new Error(`Unsupported VERIFY_MODE: ${MODE || "EMPTY"}`);
  }

  console.log(JSON.stringify({
    result: "PASS",
    verification,
    completedAt: new Date().toISOString(),
  }, null, 2));
  console.log(`RESULT: ${VERIFICATION_NAME}_${MODE}_PASS`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    console.log(JSON.stringify({
      result: "FAIL",
      mode: MODE,
      error: error instanceof Error ? error.message : String(error),
      completedAt: new Date().toISOString(),
    }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
