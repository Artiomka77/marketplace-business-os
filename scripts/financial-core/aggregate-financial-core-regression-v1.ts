import fs from "node:fs";
import path from "node:path";

type AnyRow = Record<string, any>;

const casesDir = "/regression-output/cases";
const outputJson =
  "/regression-output/financial-core-v1-regression.json";
const outputSummary =
  "/regression-output/financial-core-v1-regression.summary.txt";

const cases: Record<string, AnyRow> = {};

for (const fileName of fs
  .readdirSync(casesDir)
  .filter((item) => item.endsWith(".json"))
  .sort()) {
  const value = JSON.parse(
    fs.readFileSync(path.join(casesDir, fileName), "utf8")
  );

  cases[value.caseId] = value;
}

const failuresPath =
  "/regression-output/case-failures.json";

const failures = fs.existsSync(failuresPath)
  ? JSON.parse(fs.readFileSync(failuresPath, "utf8"))
  : [];

const checks: AnyRow[] = [];

function num(value: unknown) {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function closeEnough(
  left: unknown,
  right: unknown,
  tolerance = 0.15
) {
  return Math.abs(num(left) - num(right)) <= tolerance;
}

function addCheck(
  id: string,
  ok: boolean,
  expected?: unknown,
  actual?: unknown
) {
  checks.push({
    id,
    ok,
    expected,
    actual,
  });
}

const requiredCaseIds = [
  "direct-day8-petrov",
  "direct-day12-petrov",
  "direct-q2-petrov",
  "direct-q2-lebedeva",
  "readiness-ytd-petrov",
  "readiness-ytd-lebedeva",
  "report-day12",
  "product-cost",
];

for (const caseId of requiredCaseIds) {
  addCheck(
    `case.${caseId}.exists`,
    Boolean(cases[caseId]),
    true,
    Boolean(cases[caseId])
  );
}

const day8 = cases["direct-day8-petrov"];

if (day8) {
  const economicTurnover =
    num(day8.wb.sellerRetailAmount) ||
    num(day8.wb.revenue);

  const ratio =
    economicTurnover > 0
      ? Math.abs(num(day8.wb.netProfitAfterTax)) /
        economicTurnover
      : 0;

  addCheck(
    "day8.noWholeWeeklyFinance",
    day8.wb.dataMode === "PRELIMINARY" &&
      num(day8.wb.sellerPayout) < 10000 &&
      ratio < 1,
    "PRELIMINARY, seller payout < 10 000, |profit|/turnover < 1",
    {
      dataMode: day8.wb.dataMode,
      sellerPayout: day8.wb.sellerPayout,
      economicTurnover,
      netProfitAfterTax: day8.wb.netProfitAfterTax,
      ratio,
    }
  );

  addCheck(
    "day8.wbEconomicTurnover",
    closeEnough(day8.wb.sellerRetailAmount, 4475.62),
    4475.62,
    day8.wb.sellerRetailAmount
  );

  addCheck(
    "day8.wbProfit",
    closeEnough(day8.wb.netProfitAfterTax, 1070.9157502644614),
    1070.9157502644614,
    day8.wb.netProfitAfterTax
  );
}

const day12 = cases["direct-day12-petrov"];

if (day12) {
  addCheck(
    "day12.wbEconomicTurnover",
    closeEnough(day12.wb.sellerRetailAmount, 534945.33),
    534945.33,
    day12.wb.sellerRetailAmount
  );

  addCheck(
    "day12.wbTaxableRevenue",
    closeEnough(day12.wb.revenue, 367931.12),
    367931.12,
    day12.wb.revenue
  );

  addCheck(
    "day12.wbNetProfit",
    closeEnough(day12.wb.netProfitAfterTax, 21598.379276190462),
    21598.379276190462,
    day12.wb.netProfitAfterTax
  );

  addCheck(
    "day12.ozonNetProfit",
    closeEnough(day12.ozon.netProfitAfterTax, 150332.11934761913),
    150332.11934761913,
    day12.ozon.netProfitAfterTax
  );

  addCheck(
    "day12.readiness",
    day12.readiness.status === "complete" &&
      day12.readiness.isFinal === true &&
      day12.readiness.issues.length === 0,
    {
      status: "complete",
      isFinal: true,
      issues: 0,
    },
    {
      status: day12.readiness.status,
      isFinal: day12.readiness.isFinal,
      issues: day12.readiness.issues,
    }
  );
}

const q2Petrov = cases["direct-q2-petrov"];

if (q2Petrov) {
  addCheck(
    "q2.petrov.ozonTaxableRevenue",
    closeEnough(
      q2Petrov.ozon.taxableRevenue,
      14445957.17
    ),
    14445957.17,
    q2Petrov.ozon.taxableRevenue
  );

  addCheck(
    "q2.petrov.ozonCoverage",
    q2Petrov.ozon.taxRevenueCoverageComplete === true &&
      q2Petrov.ozon.discountPointsCoverageComplete === true,
    true,
    {
      tax: q2Petrov.ozon.taxRevenueCoverageComplete,
      points:
        q2Petrov.ozon.discountPointsCoverageComplete,
    }
  );
}

const q2Lebedeva = cases["direct-q2-lebedeva"];

if (q2Lebedeva) {
  addCheck(
    "q2.lebedeva.ozonTaxableRevenue",
    closeEnough(
      q2Lebedeva.ozon.taxableRevenue,
      2456623.33
    ),
    2456623.33,
    q2Lebedeva.ozon.taxableRevenue
  );

  addCheck(
    "q2.lebedeva.ozonCoverage",
    q2Lebedeva.ozon.taxRevenueCoverageComplete === true &&
      q2Lebedeva.ozon.discountPointsCoverageComplete === true,
    true,
    {
      tax: q2Lebedeva.ozon.taxRevenueCoverageComplete,
      points:
        q2Lebedeva.ozon.discountPointsCoverageComplete,
    }
  );
}

for (const caseId of [
  "readiness-ytd-petrov",
  "readiness-ytd-lebedeva",
]) {
  const row = cases[caseId];

  if (!row) continue;

  addCheck(
    `${caseId}.complete`,
    row.readiness.status === "complete" &&
      row.readiness.isFinal === true &&
      row.readiness.issues.length === 0,
    {
      status: "complete",
      isFinal: true,
      issues: 0,
    },
    {
      status: row.readiness.status,
      isFinal: row.readiness.isFinal,
      issues: row.readiness.issues,
    }
  );
}

const report = cases["report-day12"]?.report;

if (day12 && report) {
  const company = report.companies.find(
    (item: AnyRow) =>
      item.companyName === "ИП Петров"
  );

  addCheck(
    "report.day12.petrov.exists",
    Boolean(company),
    true,
    Boolean(company)
  );

  if (company) {
    addCheck(
      "report.day12.wbProfit",
      closeEnough(
        company.wb.netProfitAfterTax,
        day12.wb.netProfitAfterTax
      ),
      day12.wb.netProfitAfterTax,
      company.wb.netProfitAfterTax
    );

    addCheck(
      "report.day12.ozonProfit",
      closeEnough(
        company.ozon.netProfitAfterTax,
        day12.ozon.netProfitAfterTax
      ),
      day12.ozon.netProfitAfterTax,
      company.ozon.netProfitAfterTax
    );

    const beforeOwner =
      num(company.wb.netProfitAfterTax) +
      num(company.ozon.netProfitAfterTax) +
      num(company.finance.netProfitImpact);

    const afterOwner =
      beforeOwner -
      num(company.finance.ownerWithdrawals);

    addCheck(
      "report.day12.companyProfitBeforeOwner",
      closeEnough(beforeOwner, 171930.4986238096),
      171930.4986238096,
      beforeOwner
    );

    addCheck(
      "report.day12.companyProfitAfterOwner",
      closeEnough(afterOwner, 162930.4986238096),
      162930.4986238096,
      afterOwner
    );
  }
}

const productCost = cases["product-cost"];

if (productCost) {
  addCheck(
    "productCost.noAnomalousDates",
    num(productCost.anomalies) === 0,
    0,
    productCost.anomalies
  );
}

const result = {
  generatedAt: new Date().toISOString(),
  failures,
  cases,
  checks,
  summary: {
    casesExpected: requiredCaseIds.length,
    casesCreated: requiredCaseIds.filter(
      (caseId) => Boolean(cases[caseId])
    ).length,
    processFailures: failures.length,
    checks: checks.length,
    failedChecks: checks.filter(
      (check) => !check.ok
    ).length,
    passed:
      failures.length === 0 &&
      checks.every((check) => check.ok),
  },
};

fs.writeFileSync(
  outputJson,
  JSON.stringify(result, null, 2),
  "utf8"
);

const lines = [
  "AVOROFIN — FINANCIAL CORE V1 REGRESSION",
  `Generated: ${result.generatedAt}`,
  `Cases expected: ${result.summary.casesExpected}`,
  `Cases created: ${result.summary.casesCreated}`,
  `Process failures: ${result.summary.processFailures}`,
  `Checks: ${result.summary.checks}`,
  `Failed checks: ${result.summary.failedChecks}`,
  `Passed: ${result.summary.passed}`,
  "",
  "CONTROL VALUES:",
];

if (day8) {
  lines.push(
    [
      "08.07 ИП Петров",
      `WB econ=${Math.round(num(day8.wb.sellerRetailAmount) * 100) / 100}`,
      `WB tax=${Math.round(num(day8.wb.revenue) * 100) / 100}`,
      `WB profit=${Math.round(num(day8.wb.netProfitAfterTax) * 100) / 100}`,
      `mode=${day8.wb.dataMode}`,
    ].join(" | ")
  );
}

if (day12) {
  lines.push(
    [
      "12.07 ИП Петров",
      `WB econ=${Math.round(num(day12.wb.sellerRetailAmount) * 100) / 100}`,
      `WB tax=${Math.round(num(day12.wb.revenue) * 100) / 100}`,
      `WB profit=${Math.round(num(day12.wb.netProfitAfterTax) * 100) / 100}`,
      `Ozon profit=${Math.round(num(day12.ozon.netProfitAfterTax) * 100) / 100}`,
    ].join(" | ")
  );
}

lines.push(
  "",
  "FAILED PROCESSES:",
  ...failures.map(
    (failure: AnyRow) =>
      `${failure.caseId}: exit=${failure.exitCode}`
  ),
  "",
  "FAILED CHECKS:",
  ...checks
    .filter((check) => !check.ok)
    .map(
      (check) =>
        `${check.id}: actual=${JSON.stringify(check.actual)}`
    ),
  "",
  `RESULT: ${
    result.summary.passed
      ? "REGRESSION_PASS"
      : "REGRESSION_FAIL"
  }`
);

fs.writeFileSync(
  outputSummary,
  lines.join("\n"),
  "utf8"
);

if (!result.summary.passed) {
  process.exitCode = 1;
}
