import fs from "node:fs";
import { prisma } from "../../lib/prisma";

type Output = Record<string, unknown>;

const mode = process.env.AUDIT_MODE ?? "";
const caseId = process.env.CASE_ID ?? "unknown";
const dateFrom = process.env.DATE_FROM ?? "";
const dateTo = process.env.DATE_TO ?? "";
const companyName = process.env.COMPANY_NAME ?? "";
const outputPath = `/regression-output/cases/${caseId}.json`;

async function runDirect(): Promise<Output> {
  const { getProfitAnalytics } = await import(
    "../../lib/analytics/profitAnalytics"
  );
  const { getProfitAnalyticsOzon } = await import(
    "../../lib/analytics/profitAnalyticsOzon"
  );
  const { getDataReadinessSummary } = await import(
    "../../lib/analytics/dataReadiness"
  );

  const wb = await getProfitAnalytics({
    dateFrom,
    dateTo,
    companyName,
  });

  const ozon = await getProfitAnalyticsOzon({
    dateFrom,
    dateTo,
    companyName,
  });

  const readiness = await getDataReadinessSummary({
    dateFrom,
    dateTo,
    companyName,
  });

  return {
    mode,
    caseId,
    dateFrom,
    dateTo,
    companyName,
    wb: wb.totals,
    ozon: ozon.totals,
    readiness,
  };
}

async function runReadiness(): Promise<Output> {
  const { getDataReadinessSummary } = await import(
    "../../lib/analytics/dataReadiness"
  );

  const readiness = await getDataReadinessSummary({
    dateFrom,
    dateTo,
    companyName,
  });

  return {
    mode,
    caseId,
    dateFrom,
    dateTo,
    companyName,
    readiness,
  };
}

async function runReport(): Promise<Output> {
  const { buildDailyReport } = await import(
    "../../lib/telegram/dailyReport"
  );

  const report = await buildDailyReport({
    from: dateFrom,
    to: dateTo,
    skipComparison: true,
  });

  return {
    mode,
    caseId,
    dateFrom,
    dateTo,
    report,
  };
}

async function runProductCost(): Promise<Output> {
  const rows = await prisma.$queryRaw<
    Array<{ rows: bigint }>
  >`
    SELECT COUNT(*)::bigint AS "rows"
    FROM "ProductCost"
    WHERE "costDate" > TIMESTAMP '2030-01-01'
  `;

  return {
    mode,
    caseId,
    anomalies: Number(rows[0]?.rows ?? 0),
  };
}

async function main() {
  fs.mkdirSync("/regression-output/cases", {
    recursive: true,
  });

  let output: Output;

  if (mode === "direct") {
    output = await runDirect();
  } else if (mode === "readiness") {
    output = await runReadiness();
  } else if (mode === "report") {
    output = await runReport();
  } else if (mode === "product-cost") {
    output = await runProductCost();
  } else {
    throw new Error(`Unknown AUDIT_MODE: ${mode}`);
  }

  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      output,
      (_, value) =>
        typeof value === "bigint" ? Number(value) : value,
      2
    ),
    "utf8"
  );

  console.log(`CASE_WRITTEN ${outputPath}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
