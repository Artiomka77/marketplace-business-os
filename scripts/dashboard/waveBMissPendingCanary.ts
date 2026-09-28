/* eslint-disable @typescript-eslint/no-explicit-any -- canary fixtures intentionally loose */
/**
 * Local/ephemeral Wave B miss/pending/incompatible canary (no production DB).
 * Uses in-memory repository — proves consumer fail-closed contracts.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
  FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
  FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
  loadProfitReadModel,
  produceProfitReadModel,
  type ProfitPeriodRow,
  type ProfitReadModelRepository,
  type ProfitSkuRow,
} from "@/lib/profitReadModel";

function memoryRepo(): ProfitReadModelRepository & {
  periods: Map<string, ProfitPeriodRow>;
  skus: ProfitSkuRow[];
  jobs: string[];
} {
  const periods = new Map<string, ProfitPeriodRow>();
  const skus: ProfitSkuRow[] = [];
  const jobs: string[] = [];
  const keyOf = (p: {
    companyScope: string;
    marketplace: string;
    dateFrom: string;
    dateTo: string;
    formulaVersion: string;
  }) =>
    `${p.companyScope}|${p.marketplace}|${p.dateFrom}|${p.dateTo}|${p.formulaVersion}`;
  return {
    periods,
    skus,
    jobs,
    async findPeriod(params) {
      return periods.get(keyOf(params)) ?? null;
    },
    async replacePeriod({ period, skus: next }) {
      const k = keyOf({
        companyScope: period.companyScope,
        marketplace: period.marketplace,
        dateFrom: period.dateFrom.toISOString().slice(0, 10),
        dateTo: period.dateTo.toISOString().slice(0, 10),
        formulaVersion: period.formulaVersion,
      });
      periods.set(k, { ...period, generatedAt: period.generatedAt ?? new Date() });
      for (let i = skus.length - 1; i >= 0; i--) {
        if (
          skus[i].companyScope === period.companyScope &&
          skus[i].marketplace === period.marketplace &&
          skus[i].formulaVersion === period.formulaVersion
        ) {
          skus.splice(i, 1);
        }
      }
      skus.push(...next.map((s) => ({ ...s, generatedAt: s.generatedAt ?? new Date() })));
    },
    async countSkus(params) {
      return skus.filter(
        (s) =>
          s.companyScope === params.companyScope &&
          s.marketplace === params.marketplace &&
          s.formulaVersion === params.formulaVersion
      ).length;
    },
    async enqueueRebuild(params) {
      const id = `${params.formulaVersion}:${params.companyScope}`;
      jobs.push(id);
      return { id, created: true, action: "create" as const };
    },
  };
}

async function main() {
  const outPath = process.env.WAVE_B_MISS_OUT;
  if (!outPath) throw new Error("WAVE_B_MISS_OUT required");
  const repo = memoryRepo();
  const cases: Record<string, unknown> = {};

  // A. no row
  const miss = await loadProfitReadModel({
    repository: repo,
    marketplace: "WB",
    companyScope: "ALL",
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
  });
  cases.A_MISS = {
    status: miss.status,
    reason: (miss as any).reason,
    heavyFcCalls: miss.heavyFcCalls,
    rebuildEnqueued: (miss as any).rebuildEnqueued === true,
  };

  // seed for further cases
  await produceProfitReadModel({
    repository: repo,
    marketplace: "WB",
    companyScope: "ИП Петров",
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    computeWb: async () =>
      ({
        rows: [{ nmId: "1", vendorCode: "A", revenue: 100, netProfitAfterTax: 10 }],
        totals: { revenue: 100, netProfitAfterTax: 10 },
        comparison: { revenue: { current: 100, previous: 80 } },
        previousTotals: { revenue: 80 },
        wbPnlAvailability: { status: "AVAILABLE" },
      }) as any,
  });

  // E. company mismatch — requesting Lebedeva must not reuse Petrov
  const companyMiss = await loadProfitReadModel({
    repository: repo,
    marketplace: "WB",
    companyScope: "ИП Лебедева",
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    enqueueOnMiss: false,
  });
  cases.E_COMPANY_MISMATCH = {
    status: companyMiss.status,
    reason: (companyMiss as any).reason,
    heavyFcCalls: companyMiss.heavyFcCalls,
  };

  // F. marketplace mismatch
  const mktMiss = await loadProfitReadModel({
    repository: repo,
    marketplace: "OZON",
    companyScope: "ИП Петров",
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    enqueueOnMiss: false,
  });
  cases.F_MARKETPLACE_MISMATCH = {
    status: mktMiss.status,
    reason: (mktMiss as any).reason,
    heavyFcCalls: mktMiss.heavyFcCalls,
  };

  // C. incompatible formulaVersion
  const k = [...repo.periods.keys()][0];
  const row = repo.periods.get(k)!;
  row.formulaVersion = "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2";
  const incompat = await loadProfitReadModel({
    repository: repo,
    marketplace: "WB",
    companyScope: "ИП Петров",
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    enqueueOnMiss: false,
  });
  cases.C_INCOMPATIBLE_FORMULA = {
    status: incompat.status,
    reason: (incompat as any).reason,
    heavyFcCalls: incompat.heavyFcCalls,
    expectedLookupFormula: FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
  };
  // restore key formula for checksum test — re-produce
  repo.periods.clear();
  await produceProfitReadModel({
    repository: repo,
    marketplace: "OZON",
    companyScope: "ALL",
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    computeOzon: async () =>
      ({
        rows: [{ nmId: "9", vendorCode: "Z", revenue: 50 }],
        totals: { revenue: 50 },
        comparison: null,
        taxesEstimated: false,
      }) as any,
  });
  const ozKey = [...repo.periods.keys()][0];
  const ozRow = repo.periods.get(ozKey)!;
  (ozRow.meta as any).payloadChecksum = "deadbeef";
  const corrupt = await loadProfitReadModel({
    repository: repo,
    marketplace: "OZON",
    companyScope: "ALL",
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    enqueueOnMiss: false,
  });
  cases.D_CHECKSUM_CORRUPT = {
    status: corrupt.status,
    reason: (corrupt as any).reason,
    heavyFcCalls: corrupt.heavyFcCalls,
    formula: FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
  };

  // G closed stale incomplete
  await produceProfitReadModel({
    repository: repo,
    marketplace: "WB",
    companyScope: "ALL",
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    computeWb: async () =>
      ({
        rows: [],
        totals: null,
        comparison: null,
        wbPnlAvailability: { status: "AVAILABLE" },
      }) as any,
  });
  // force FINAL + incomplete
  const allKey = [...repo.periods.keys()].find((x) => x.startsWith("ALL|WB|"));
  assert.ok(allKey);
  const allRow = repo.periods.get(allKey)!;
  allRow.dataMode = "FINAL";
  allRow.coverageStatus = "PARTIAL";
  const stale = await loadProfitReadModel({
    repository: repo,
    marketplace: "WB",
    companyScope: "ALL",
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    enqueueOnMiss: false,
  });
  cases.G_CLOSED_STALE = {
    status: stale.status,
    reason: (stale as any).reason,
    heavyFcCalls: stale.heavyFcCalls,
  };

  const result = {
    HEAVY_LIVE_FALLBACK_ON_MISS: "NO",
    cases,
    PASS:
      cases.A_MISS &&
      (cases.A_MISS as any).status === "PENDING" &&
      (cases.A_MISS as any).heavyFcCalls === 0 &&
      (cases.E_COMPANY_MISMATCH as any).status === "PENDING" &&
      (cases.F_MARKETPLACE_MISMATCH as any).status === "PENDING" &&
      (cases.C_INCOMPATIBLE_FORMULA as any).status === "UNAVAILABLE" &&
      (cases.D_CHECKSUM_CORRUPT as any).status === "UNAVAILABLE" &&
      (cases.G_CLOSED_STALE as any).status === "UNAVAILABLE",
  };
  writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify({ wrote: outPath, PASS: result.PASS }));
  if (!result.PASS) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
