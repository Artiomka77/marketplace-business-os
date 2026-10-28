/**
 * Post-cutover consumer check vs accepted week canon (no re-audit).
 * Loads Profit period metrics through the same payload fields consumers use
 * (analyticsPayload preferred; totals fallback) and Finance via accepted path.
 *
 *   DATABASE_URL=... node --import tsx scripts/fin_accept/verify_week_consumer_R12.ts [out.json]
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import { resolveOzonNetExpensesForDisplay } from "@/lib/analytics/profitAnalyticsOzon";
import {
  FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
  FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
} from "@/lib/profitReadModel/contract";
import { asMeta } from "@/lib/profitReadModel/repository";

const dateFrom = process.env.DATE_FROM || "2026-10-19";
const dateTo = process.env.DATE_TO || "2026-10-25";
const outPath = process.argv[2] || "R15_verify_week_consumer.json";

const EXPECT = {
  "ИП Петров": {
    ozonN: 170858.17,
    ozonProfit: 866136.86,
    wbProfit: 150408.0,
    finance: -33931.1,
    business: 982613.76,
  },
  "ИП Лебедева": {
    ozonN: 3090.47,
    ozonProfit: 16327.25,
    wbProfit: -1160.77,
    finance: -3581.77,
    business: 11584.71,
  },
  ALL: {
    ozonN: 173948.64,
    ozonProfit: 882464.11,
    wbProfit: 149247.23,
    finance: -37512.87,
    business: 994198.47,
  },
} as const;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(2);
}

function round2(n: number) {
  return Number(Number(n).toFixed(2));
}

function nearly(a: number, b: number, eps = 0.015) {
  return Math.abs(a - b) <= eps;
}

async function loadProfitConsumer(companyScope: string, marketplace: "OZON" | "WB") {
  const formulaVersion =
    marketplace === "OZON"
      ? FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1
      : FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1;
  const row = await prisma.profitPeriodMetric.findUnique({
    where: {
      companyScope_marketplace_dateFrom_dateTo_formulaVersion: {
        companyScope,
        marketplace,
        dateFrom: new Date(`${dateFrom}T00:00:00.000Z`),
        dateTo: new Date(`${dateTo}T00:00:00.000Z`),
        formulaVersion,
      },
    },
  });
  if (!row) {
    throw new Error(`MISS profit period row ${companyScope} ${marketplace}`);
  }
  const meta = asMeta(row as never);
  if (String(row.coverageStatus || "").toUpperCase().includes("PENDING")) {
    throw new Error(`PENDING coverage ${companyScope} ${marketplace}`);
  }
  const analytics = row.analyticsPayload as {
    totals?: Record<string, unknown>;
  } | null;
  const totals =
    (analytics?.totals as Record<string, unknown> | undefined) ??
    (row.totals as Record<string, unknown>);
  if (!totals || typeof totals !== "object") {
    throw new Error(`empty consumer totals ${companyScope} ${marketplace}`);
  }
  return {
    totals,
    payloadChecksum: row.payloadChecksum,
    sourceFingerprint: row.sourceFingerprint,
    metaPayloadChecksum: (meta as { payloadChecksum?: string } | null)?.payloadChecksum,
    dataMode: row.dataMode,
    coverageStatus: row.coverageStatus,
  };
}

async function loadFinanceImpact(companyScope: string): Promise<number> {
  const { getEffectiveFinanceTransactions } = await import(
    "@/lib/finance/effectiveFinanceTransactions"
  );
  const { calculateFinanceMetricsForRows } = await import(
    "@/lib/finance/financeMetrics"
  );
  const dateFromDt = new Date(`${dateFrom}T00:00:00.000Z`);
  const dateToExclusive = new Date(`${dateTo}T00:00:00.000Z`);
  dateToExclusive.setUTCDate(dateToExclusive.getUTCDate() + 1);
  const companyName = companyScope === "ALL" ? null : companyScope;
  const transactions = await getEffectiveFinanceTransactions({
    prisma,
    companyName,
    dateFrom: dateFromDt,
    dateToExclusive,
    asOfDate: dateToExclusive,
  });
  const categories = await prisma.financeCategory.findMany({
    select: {
      name: true,
      categoryType: true,
      parentName: true,
      profitTreatment: true,
    },
  });
  const metrics = calculateFinanceMetricsForRows({
    transactions: transactions as never,
    categories,
  });
  return Number(metrics.netProfitImpact);
}

async function main() {
  const cases: Array<Record<string, unknown>> = [];
  const failures: string[] = [];

  for (const companyScope of Object.keys(EXPECT) as Array<keyof typeof EXPECT>) {
    const want = EXPECT[companyScope];
    const ozon = await loadProfitConsumer(companyScope, "OZON");
    const wb = await loadProfitConsumer(companyScope, "WB");
    const finance = await loadFinanceImpact(companyScope);

    const n = resolveOzonNetExpensesForDisplay({
      grossOzonExpenses: ozon.totals.grossOzonExpenses as number,
      discountPointsCompensation: ozon.totals.discountPointsCompensation as number,
      discountPointsAmount: ozon.totals.discountPointsAmount as number,
      partnerProgramsAmount: ozon.totals.partnerProgramsAmount as number,
      netOzonExpenses: ozon.totals.netOzonExpenses as number,
      netOzonExpensesRepresentation: ozon.totals.netOzonExpensesRepresentation as
        | string
        | null,
    });
    const ozonProfit = Number(ozon.totals.netProfitAfterTax);
    const wbProfit = Number(wb.totals.netProfitAfterTax);
    if (!Number.isFinite(wbProfit)) {
      failures.push(`${companyScope}: WB profit non-finite`);
    }
    if (!Number.isFinite(ozonProfit)) {
      failures.push(`${companyScope}: Ozon profit non-finite`);
    }
    if (!Number.isFinite(n)) {
      failures.push(`${companyScope}: Ozon N non-finite`);
    }
    if (!Number.isFinite(finance)) {
      failures.push(`${companyScope}: Finance non-finite`);
    }

    const business = round2(wbProfit + ozonProfit + finance);

    if (!nearly(round2(n), want.ozonN)) {
      failures.push(`${companyScope}: N ${round2(n)} != ${want.ozonN}`);
    }
    if (!nearly(round2(ozonProfit), want.ozonProfit)) {
      failures.push(
        `${companyScope}: ozonProfit ${round2(ozonProfit)} != ${want.ozonProfit}`,
      );
    }
    if (!nearly(round2(wbProfit), want.wbProfit)) {
      failures.push(
        `${companyScope}: wbProfit ${round2(wbProfit)} != ${want.wbProfit}`,
      );
    }
    if (!nearly(round2(finance), want.finance)) {
      failures.push(
        `${companyScope}: finance ${round2(finance)} != ${want.finance}`,
      );
    }
    if (!nearly(business, want.business)) {
      failures.push(
        `${companyScope}: business ${business} != ${want.business}`,
      );
    }

    cases.push({
      companyScope,
      displayN: round2(n),
      ozonProfit: round2(ozonProfit),
      wbProfit: round2(wbProfit),
      finance: round2(finance),
      business,
      expected: want,
      consumerSource: "analyticsPayload.totals||totals",
      ozonChecksum: ozon.payloadChecksum,
      wbChecksum: wb.payloadChecksum,
    });
  }

  const petrov = cases.find((c) => c.companyScope === "ИП Петров")!;
  const lebedeva = cases.find((c) => c.companyScope === "ИП Лебедева")!;
  const all = cases.find((c) => c.companyScope === "ALL") as { displayN: number; business: number };
  if (!nearly(round2(petrov.displayN + lebedeva.displayN), all.displayN)) {
    failures.push("ALL N != sum of companies");
  }
  if (!nearly(round2(petrov.business + lebedeva.business), all.business)) {
    failures.push("ALL business != sum of companies");
  }

  const out = {
    dateFrom,
    dateTo,
    cases,
    businessAllActual: all.business,
    businessAllCanon: 994198.47,
    failures,
    ok: failures.length === 0,
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
  if (failures.length) {
    console.error("VERIFY_WEEK_CONSUMER_R15_FAIL");
    process.exit(1);
  }
  console.log("VERIFY_WEEK_CONSUMER_R15_PASS");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
