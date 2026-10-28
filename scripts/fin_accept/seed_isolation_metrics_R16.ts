import { prisma } from "@/lib/prisma";
import {
  FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
  FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
} from "@/lib/profitReadModel/contract";

const dateFrom = new Date("2026-10-19T00:00:00.000Z");
const dateTo = new Date("2026-10-25T00:00:00.000Z");

const canon = {
  "ИП Петров": {
    ozon: 866136.86,
    wb: 150408.0,
    n: 170858.17,
    g: 200000,
    b: 10000,
    a: 19141.83,
  },
  "ИП Лебедева": {
    ozon: 16327.25,
    wb: -1160.77,
    n: 3090.47,
    g: 5000,
    b: 1000,
    a: 909.53,
  },
  ALL: {
    ozon: 882464.11,
    wb: 149247.23,
    n: 173948.64,
    g: 205000,
    b: 11000,
    a: 20051.36,
  },
} as const;

async function upsert(
  companyScope: string,
  marketplace: "OZON" | "WB",
  formulaVersion: string,
  netProfitAfterTax: number,
) {
  const c = canon[companyScope as keyof typeof canon];
  const totals =
    marketplace === "OZON"
      ? {
          netProfitAfterTax,
          netOzonExpenses: c.n,
          grossOzonExpenses: c.g,
          discountPointsCompensation: c.b,
          discountPointsAmount: 0,
          partnerProgramsAmount: c.a,
          netOzonExpensesRepresentation: "N=G-B-A",
        }
      : { netProfitAfterTax };
  const payloadChecksum = `cs-${companyScope}-${marketplace}`;
  const meta = {
    companyScope,
    marketplace,
    payloadChecksum,
    sourceFingerprint: `fp-${companyScope}-${marketplace}`,
    weekPresentationStatus: "FINAL",
  };
  const analyticsPayload = { totals };
  await prisma.profitPeriodMetric.upsert({
    where: {
      companyScope_marketplace_dateFrom_dateTo_formulaVersion: {
        companyScope,
        marketplace,
        dateFrom,
        dateTo,
        formulaVersion,
      },
    },
    create: {
      companyScope,
      marketplace,
      dateFrom,
      dateTo,
      formulaVersion,
      dataMode: "FINAL",
      coverageStatus: "COMPLETE",
      sourceFingerprint: meta.sourceFingerprint,
      payloadChecksum,
      totals,
      meta,
      analyticsPayload,
      generatedAt: new Date("2026-10-26T12:00:00.000Z"),
      staleAfterMs: null,
    },
    update: {
      dataMode: "FINAL",
      coverageStatus: "COMPLETE",
      sourceFingerprint: meta.sourceFingerprint,
      payloadChecksum,
      totals,
      meta,
      analyticsPayload,
      generatedAt: new Date("2026-10-26T12:00:00.000Z"),
      staleAfterMs: null,
    },
  });
}

async function main() {
  for (const scope of Object.keys(canon) as (keyof typeof canon)[]) {
    await upsert(
      scope,
      "OZON",
      FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
      canon[scope].ozon,
    );
    await upsert(
      scope,
      "WB",
      FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
      canon[scope].wb,
    );
  }
  console.log("SEED_METRICS_OK");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
