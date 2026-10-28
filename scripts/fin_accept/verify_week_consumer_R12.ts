/**
 * Post-cutover acceptance via the REAL profit read-model consumer (HIT path).
 * No table-totals fallback. enqueueOnMiss=false (read-only gate).
 * Closed-week acceptance requires HIT + FINAL + COMPLETE + analytics.totals.
 *
 *   DATABASE_URL=... node --import tsx scripts/fin_accept/verify_week_consumer_R12.ts [out.json]
 */
import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import { resolveOzonNetExpensesForDisplay } from "@/lib/analytics/profitAnalyticsOzon";
import {
  FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
  FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
} from "@/lib/profitReadModel/contract";
import { createPrismaProfitReadModelRepository } from "@/lib/profitReadModel/repository";
import { loadProfitReadModel } from "@/lib/profitReadModel/consumer";
import { createWaveBProfitTargetPrismaClient } from "@/lib/profitReadModel/targetClient";

const dateFrom = process.env.DATE_FROM || "2026-10-19";
const dateTo = process.env.DATE_TO || "2026-10-25";
const outPath = process.argv[2] || "R16_verify_week_consumer.json";
const requireFinal = (process.env.VERIFY_REQUIRE_FINAL || "1") === "1";

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

async function loadProfitConsumer(
  companyScope: string,
  marketplace: "OZON" | "WB",
) {
  const targetPrisma = createWaveBProfitTargetPrismaClient();
  const repository = createPrismaProfitReadModelRepository(targetPrisma);
  const loaded = await loadProfitReadModel({
    repository,
    marketplace,
    companyScope,
    dateFrom,
    dateTo,
    enqueueOnMiss: false,
  });

  if (loaded.status !== "HIT") {
    throw new Error(
      `consumer ${companyScope} ${marketplace} status=${loaded.status} reason=${
        "reason" in loaded ? loaded.reason : "?"
      }`,
    );
  }
  if (requireFinal) {
    if (loaded.dataMode !== "FINAL") {
      throw new Error(
        `consumer ${companyScope} ${marketplace} dataMode=${loaded.dataMode} (need FINAL)`,
      );
    }
    if (loaded.coverageStatus !== "COMPLETE") {
      throw new Error(
        `consumer ${companyScope} ${marketplace} coverage=${loaded.coverageStatus} (need COMPLETE)`,
      );
    }
  }
  if (loaded.preliminaryStale) {
    throw new Error(
      `consumer ${companyScope} ${marketplace} preliminaryStale=true`,
    );
  }

  const analytics = loaded.analytics as {
    totals?: Record<string, unknown>;
  } | null;
  if (!analytics || typeof analytics !== "object" || !analytics.totals) {
    throw new Error(
      `consumer ${companyScope} ${marketplace} missing analytics.totals (no fallback)`,
    );
  }
  const totals = analytics.totals;
  return {
    totals,
    status: loaded.status,
    dataMode: loaded.dataMode,
    coverageStatus: loaded.coverageStatus,
    formulaVersion: loaded.formulaVersion,
    sourceMarker: loaded.sourceMarker,
    meta: loaded.meta,
    payloadChecksum:
      (loaded.meta as { payloadChecksum?: string } | null)?.payloadChecksum ??
      null,
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

type CaseRow = {
  companyScope: string;
  displayN: number;
  ozonProfit: number;
  wbProfit: number;
  finance: number;
  business: number;
  expected: (typeof EXPECT)[keyof typeof EXPECT];
  consumerSource: string;
  ozonChecksum: unknown;
  wbChecksum: unknown;
  ozonStatus: string;
  wbStatus: string;
};

async function main() {
  const cases: CaseRow[] = [];
  const failures: string[] = [];

  for (const companyScope of Object.keys(EXPECT) as Array<
    keyof typeof EXPECT
  >) {
    const want = EXPECT[companyScope];
    let ozon: Awaited<ReturnType<typeof loadProfitConsumer>>;
    let wb: Awaited<ReturnType<typeof loadProfitConsumer>>;
    try {
      ozon = await loadProfitConsumer(companyScope, "OZON");
    } catch (e) {
      failures.push(`${companyScope}: OZON ${String(e)}`);
      continue;
    }
    try {
      wb = await loadProfitConsumer(companyScope, "WB");
    } catch (e) {
      failures.push(`${companyScope}: WB ${String(e)}`);
      continue;
    }
    const finance = await loadFinanceImpact(companyScope);

    const n = resolveOzonNetExpensesForDisplay({
      grossOzonExpenses: ozon.totals.grossOzonExpenses as number,
      discountPointsCompensation: ozon.totals
        .discountPointsCompensation as number,
      discountPointsAmount: ozon.totals.discountPointsAmount as number,
      partnerProgramsAmount: ozon.totals.partnerProgramsAmount as number,
      netOzonExpenses: ozon.totals.netOzonExpenses as number,
      netOzonExpensesRepresentation: ozon.totals
        .netOzonExpensesRepresentation as string | null,
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

    // Prove formulas match Wave-B pair via consumer
    if (ozon.formulaVersion !== FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1) {
      failures.push(`${companyScope}: unexpected Ozon formula`);
    }
    if (wb.formulaVersion !== FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1) {
      failures.push(`${companyScope}: unexpected WB formula`);
    }

    cases.push({
      companyScope,
      displayN: round2(n),
      ozonProfit: round2(ozonProfit),
      wbProfit: round2(wbProfit),
      finance: round2(finance),
      business,
      expected: want,
      consumerSource: "loadProfitReadModel.HIT.analytics.totals",
      ozonChecksum: ozon.payloadChecksum,
      wbChecksum: wb.payloadChecksum,
      ozonStatus: `${ozon.status}/${ozon.dataMode}/${ozon.coverageStatus}`,
      wbStatus: `${wb.status}/${wb.dataMode}/${wb.coverageStatus}`,
    });
  }

  const petrov = cases.find((c) => c.companyScope === "ИП Петров");
  const lebedeva = cases.find((c) => c.companyScope === "ИП Лебедева");
  const all = cases.find((c) => c.companyScope === "ALL");
  if (petrov && lebedeva && all) {
    if (!nearly(round2(petrov.displayN + lebedeva.displayN), all.displayN)) {
      failures.push("ALL N != sum of companies");
    }
    if (!nearly(round2(petrov.business + lebedeva.business), all.business)) {
      failures.push("ALL business != sum of companies");
    }
  } else {
    failures.push("missing company case rows for ALL sum check");
  }

  const out = {
    dateFrom,
    dateTo,
    requireFinal,
    cases,
    businessAllActual: all?.business ?? null,
    businessAllCanon: 994198.47,
    failures,
    ok: failures.length === 0,
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
  if (failures.length) {
    console.error("VERIFY_WEEK_CONSUMER_R16_FAIL");
    process.exit(1);
  }
  console.log("VERIFY_WEEK_CONSUMER_R16_PASS");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
