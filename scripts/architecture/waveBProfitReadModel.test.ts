import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
  FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
  formulaForMarketplace,
  isWaveBProfitFormula,
  loadProfitReadModel,
  produceProfitReadModel,
  rejectsLegacyAsWaveBProfit,
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
  const key = (p: {
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
      return periods.get(key(params)) ?? null;
    },
    async replacePeriod({ period, skus: next }) {
      const k = key({
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
      skus.push(
        ...next.map((s) => ({ ...s, generatedAt: s.generatedAt ?? new Date() }))
      );
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

describe("Wave B profit read-model contract", () => {
  it("uses distinct formula versions and rejects Wave A/V4", () => {
    assert.equal(formulaForMarketplace("WB"), FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1);
    assert.equal(formulaForMarketplace("OZON"), FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1);
    assert.equal(isWaveBProfitFormula(FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1), true);
    assert.equal(rejectsLegacyAsWaveBProfit("FINANCIAL_CORE_V6_PERIOD_READMODEL_V2"), true);
    assert.equal(rejectsLegacyAsWaveBProfit("FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1"), true);
  });

  it("MISS enqueues rebuild and never reports heavy FC calls", async () => {
    const repo = memoryRepo();
    const miss = await loadProfitReadModel({
      repository: repo,
      marketplace: "WB",
      companyScope: "ALL",
      dateFrom: "2026-08-17",
      dateTo: "2026-08-23",
    });
    assert.equal(miss.status, "PENDING");
    assert.equal(miss.heavyFcCalls, 0);
    assert.equal(miss.sourceMarker, "PROFIT_READ_MODEL_MISS");
    assert.ok(repo.jobs.length >= 1);
  });

  it("HIT returns analytics with heavyFcCalls=0 after producer", async () => {
    const repo = memoryRepo();
    const fakeAnalytics = {
      rows: [{ nmId: "1", vendorCode: "A", revenue: 10, netProfitAfterTax: 1 }],
      totals: { revenue: 10, netProfitAfterTax: 1, adsCost: 0, drr: 0, margin: 10 },
      previousRows: [],
      previousTotals: { revenue: 8 },
      comparison: { revenue: { current: 10, previous: 8, diff: 2, diffPercent: 25 } },
      wbPnlAvailability: { status: "AVAILABLE" },
      independentAds: { adsCost: 0 },
    };
    await produceProfitReadModel({
      repository: repo,
      marketplace: "WB",
      companyScope: "ALL",
      dateFrom: "2026-08-17",
      dateTo: "2026-08-23",
      computeWb: async () => fakeAnalytics as never,
    });
    const hit = await loadProfitReadModel({
      repository: repo,
      marketplace: "WB",
      companyScope: "ALL",
      dateFrom: "2026-08-17",
      dateTo: "2026-08-23",
      enqueueOnMiss: false,
    });
    assert.equal(hit.status, "HIT");
    if (hit.status === "HIT") {
      assert.equal(hit.heavyFcCalls, 0);
      assert.equal(hit.skuCount, 1);
      assert.equal(
        (hit.analytics as { totals: { revenue: number } }).totals.revenue,
        10
      );
    }
  });

  it("company mismatch and checksum corruption fail closed", async () => {
    const repo = memoryRepo();
    await produceProfitReadModel({
      repository: repo,
      marketplace: "OZON",
      companyScope: "ИП Петров",
      dateFrom: "2026-08-17",
      dateTo: "2026-08-23",
      computeOzon: async () =>
        ({
          rows: [{ sku: "X", revenue: 1 }],
          totals: { revenue: 1 },
          comparison: null,
          taxesEstimated: false,
        }) as never,
    });
    // corrupt checksum
    const k = [...repo.periods.keys()][0];
    const row = repo.periods.get(k)!;
    (row.meta as { payloadChecksum: string }).payloadChecksum = "deadbeef";
    const bad = await loadProfitReadModel({
      repository: repo,
      marketplace: "OZON",
      companyScope: "ИП Петров",
      dateFrom: "2026-08-17",
      dateTo: "2026-08-23",
      enqueueOnMiss: false,
    });
    assert.equal(bad.status, "UNAVAILABLE");
    assert.equal(
      (bad as { reason: string }).reason,
      "PAYLOAD_CHECKSUM_MISMATCH"
    );
  });
});
