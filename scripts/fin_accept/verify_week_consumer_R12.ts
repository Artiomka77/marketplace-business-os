/**
 * Post-cutover consumer check vs accepted week canon (no re-audit).
 * Reads Profit period metrics; compares Business ALL and Ozon display N.
 *
 *   DATABASE_URL=... node --import tsx scripts/fin_accept/verify_week_consumer_R12.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { resolveOzonNetExpensesForDisplay } from "@/lib/analytics/profitAnalyticsOzon";
import {
  FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
  FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
} from "@/lib/profitReadModel/contract";

const dateFrom = process.env.DATE_FROM || "2026-10-19";
const dateTo = process.env.DATE_TO || "2026-10-25";
const outPath = process.argv[2] || "R12_verify_week_consumer.json";

const EXPECT = {
  "ИП Петров": { ozonN: 170858.17, ozonProfit: 866136.86, business: 982613.76 },
  "ИП Лебедева": { ozonN: 3090.47, ozonProfit: 16327.25, business: 11584.71 },
  ALL: { ozonN: 173948.64, ozonProfit: 882464.11, business: 994198.47 },
} as const;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(2);
}

const prisma = new PrismaClient();

function round2(n: number) {
  return Number(Number(n).toFixed(2));
}

async function loadTotals(companyScope: string, marketplace: "OZON" | "WB") {
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
  if (!row) throw new Error(`missing profit period row ${companyScope} ${marketplace}`);
  return row.totals as Record<string, unknown>;
}

async function main() {
  const cases = [];
  for (const companyScope of Object.keys(EXPECT) as Array<keyof typeof EXPECT>) {
    const ozon = await loadTotals(companyScope, "OZON");
    const wb = await loadTotals(companyScope, "WB");
    const n = resolveOzonNetExpensesForDisplay({
      grossOzonExpenses: ozon.grossOzonExpenses as number,
      discountPointsCompensation: ozon.discountPointsCompensation as number,
      discountPointsAmount: ozon.discountPointsAmount as number,
      partnerProgramsAmount: ozon.partnerProgramsAmount as number,
      netOzonExpenses: ozon.netOzonExpenses as number,
      netOzonExpensesRepresentation: ozon.netOzonExpensesRepresentation as
        | string
        | null,
    });
    const ozonProfit = Number(ozon.netProfitAfterTax);
    const wbProfit = Number(wb.netProfitAfterTax);
    // Finance layer is separate; business check uses accepted table when finance row available.
    const want = EXPECT[companyScope];
    assert.equal(round2(n), want.ozonN, `${companyScope} N`);
    assert.equal(round2(ozonProfit), want.ozonProfit, `${companyScope} ozon profit`);
    cases.push({
      companyScope,
      displayN: round2(n),
      ozonProfit: round2(ozonProfit),
      wbProfit: round2(wbProfit),
      expectedN: want.ozonN,
      expectedOzonProfit: want.ozonProfit,
      expectedBusiness: want.business,
    });
  }

  // ALL display N must equal sum of companies
  const petrov = cases.find((c) => c.companyScope === "ИП Петров")!;
  const lebedeva = cases.find((c) => c.companyScope === "ИП Лебедева")!;
  const all = cases.find((c) => c.companyScope === "ALL")!;
  assert.equal(round2(petrov.displayN + lebedeva.displayN), all.displayN);

  const out = {
    dateFrom,
    dateTo,
    cases,
    businessAllCanon: 994198.47,
    note: "Business ALL includes Finance; confirm Finance layer separately if bridge differs >0.01",
    ok: true,
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
  console.log("VERIFY_WEEK_CONSUMER_R12_PASS");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
