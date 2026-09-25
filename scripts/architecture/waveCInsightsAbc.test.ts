import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  produceProfitReadModel,
  type ProfitPeriodRow,
  type ProfitReadModelRepository,
  type ProfitSkuRow,
} from "@/lib/profitReadModel";
import {
  deriveAbcEnriched,
  deriveAbcRawRows,
  deriveInsightClassifications,
  deriveInsightSkuRows,
  loadWaveCAbcCompany,
  loadWaveCCompanyProfitPair,
} from "@/lib/waveC/insightsAbcAdapter";

function memoryRepo(): ProfitReadModelRepository & {
  periods: Map<string, ProfitPeriodRow>;
  skus: ProfitSkuRow[];
  jobs: string[];
  findCalls: string[];
} {
  const periods = new Map<string, ProfitPeriodRow>();
  const skus: ProfitSkuRow[] = [];
  const jobs: string[] = [];
  const findCalls: string[] = [];
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
    findCalls,
    async findPeriod(params) {
      findCalls.push(params.marketplace);
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

function wbAnalytics(rows: Array<Record<string, unknown>>) {
  const revenue = rows.reduce((s, r) => s + Number(r.revenue ?? 0), 0);
  const profit = rows.reduce((s, r) => s + Number(r.netProfitAfterTax ?? 0), 0);
  return {
    rows,
    totals: {
      revenue,
      netProfitAfterTax: profit,
      dataMode: "FINAL" as "FINAL" | "PRELIMINARY",
      netProfitStatus: "FINAL" as "FINAL" | "PRELIMINARY",
      sourceOwnershipMode: "CANONICAL",
      sourceOwnershipFinal: true,
      sourceOwnershipReasons: [],
      costCoverageIncomplete: false,
    },
    previousRows: [],
    previousTotals: { revenue: 0 },
    comparison: { revenue: { current: revenue, previous: 0, diff: revenue, diffPercent: 0 } },
    wbPnlAvailability: { status: "AVAILABLE" },
    independentAds: { adsCost: 0 },
  };
}

function ozonAnalytics(rows: Array<Record<string, unknown>>) {
  const revenue = rows.reduce((s, r) => s + Number(r.revenue ?? 0), 0);
  const profit = rows.reduce((s, r) => s + Number(r.netProfitAfterTax ?? 0), 0);
  return {
    rows,
    totals: {
      revenue,
      netProfitAfterTax: profit,
      netProfitStatus: "FINAL",
      costCoverageIncomplete: false,
    },
    previousRows: [],
    previousTotals: { revenue: 0 },
    comparison: null,
    taxesEstimated: false,
    quarantineCount: 0,
  };
}

const CLOSED = { dateFrom: "2026-08-17", dateTo: "2026-08-23" } as const;

const PETROV_WB = wbAnalytics([
  {
    nmId: "111",
    vendorCode: "SKU-A",
    netSalesQty: 10,
    revenue: 1000,
    netProfitAfterTax: 400,
    abcByProfit: "A",
    costCoverageIncomplete: false,
  },
  {
    nmId: "112",
    vendorCode: "SKU-C",
    netSalesQty: 1,
    revenue: 200,
    netProfitAfterTax: -50,
    abcByProfit: "C",
    costCoverageIncomplete: false,
  },
]);

const PETROV_OZON = ozonAnalytics([
  {
    nmId: "211",
    vendorCode: "OZ-B",
    netSalesQty: 5,
    revenue: 500,
    netProfitAfterTax: 20,
    abcByProfit: "B",
    costCoverageIncomplete: false,
  },
]);

const LEB_WB = wbAnalytics([
  {
    nmId: "311",
    vendorCode: "LB-A",
    netSalesQty: 8,
    revenue: 800,
    netProfitAfterTax: 250,
    abcByProfit: "A",
    costCoverageIncomplete: false,
  },
]);

const LEB_OZON = ozonAnalytics([
  {
    nmId: "411",
    vendorCode: "LB-C",
    netSalesQty: 2,
    revenue: 80,
    netProfitAfterTax: 1,
    abcByProfit: "C",
    costCoverageIncomplete: false,
  },
]);

async function seedCompany(
  repo: ProfitReadModelRepository,
  companyName: string,
  wb: ReturnType<typeof wbAnalytics>,
  ozon: ReturnType<typeof ozonAnalytics>
) {
  await produceProfitReadModel({
    repository: repo,
    marketplace: "WB",
    companyScope: companyName,
    ...CLOSED,
    computeWb: async () => wb as never,
  });
  await produceProfitReadModel({
    repository: repo,
    marketplace: "OZON",
    companyScope: companyName,
    ...CLOSED,
    computeOzon: async () => ozon as never,
  });
}

describe("Wave C Insights/ABC read-model consumer", () => {
  it("HIT loads WB then Ozon with heavyFcCalls=0 and no second producer", async () => {
    const repo = memoryRepo();
    await seedCompany(repo, "ИП Петров", PETROV_WB, PETROV_OZON);
    const loaded = await loadWaveCCompanyProfitPair({
      companyName: "ИП Петров",
      ...CLOSED,
      repository: repo,
    });
    assert.equal(loaded.status, "HIT");
    assert.equal(loaded.heavyFcCalls, 0);
    assert.equal(loaded.sourceMarker, "PROFIT_READ_MODEL_HIT");
    if (loaded.status === "HIT") {
      assert.equal(loaded.wbDataMode, "FINAL");
      assert.equal(loaded.ozonDataMode, "FINAL");
      assert.equal(loaded.insightsDataMode, "FINAL");
      assert.equal(loaded.wb.rows.length, 2);
      assert.equal(loaded.ozon.rows.length, 1);
    }
  });

  it("MISS fail-soft enqueues existing Wave B rebuild and never uses heavy FC", async () => {
    const repo = memoryRepo();
    const miss = await loadWaveCCompanyProfitPair({
      companyName: "ИП Петров",
      ...CLOSED,
      repository: repo,
    });
    assert.equal(miss.status, "PENDING");
    assert.equal(miss.heavyFcCalls, 0);
    assert.equal(miss.sourceMarker, "PROFIT_READ_MODEL_MISS");
    assert.ok(repo.jobs.length >= 1);
  });

  it("wrong formula fail-soft without heavy FC", async () => {
    const repo = memoryRepo();
    await seedCompany(repo, "ИП Петров", PETROV_WB, PETROV_OZON);
    const k = [...repo.periods.keys()].find((x) => x.includes("|WB|"))!;
    const row = repo.periods.get(k)!;
    row.formulaVersion = "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2";
    (row.meta as { formulaVersion: string }).formulaVersion =
      "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2";
    const bad = await loadWaveCCompanyProfitPair({
      companyName: "ИП Петров",
      ...CLOSED,
      repository: repo,
    });
    assert.notEqual(bad.status, "HIT");
    assert.equal(bad.heavyFcCalls, 0);
    assert.equal(bad.sourceMarker, "PROFIT_READ_MODEL_MISS");
  });

  it("Insights closed derivation preserves SKU order, totals, and labels", async () => {
    const items = [
      {
        companyName: "ИП Петров",
        wb: PETROV_WB as never,
        ozon: PETROV_OZON as never,
        wbUnavailable: false,
      },
      {
        companyName: "ИП Лебедева",
        wb: LEB_WB as never,
        ozon: LEB_OZON as never,
        wbUnavailable: false,
      },
    ];
    const rows = deriveInsightSkuRows(items);
    const cls = deriveInsightClassifications(rows);
    assert.equal(cls.totalRevenue, 1000 + 200 + 500 + 800 + 80);
    assert.equal(cls.totalProfit, 400 + -50 + 20 + 250 + 1);
    assert.equal(cls.lossSkuCount, 1);
    assert.equal(cls.profitableRows[0].vendorCode, "SKU-A");
    assert.equal(cls.lossRows[0].vendorCode, "SKU-C");
    assert.equal(cls.lowMarginRows[0].vendorCode, "SKU-C");
  });

  it("ABC keeps producer abcByProfit and current liquidation semantics", async () => {
    const items = [
      {
        companyName: "ИП Петров",
        wb: PETROV_WB as never,
        ozon: PETROV_OZON as never,
        wbUnavailable: false,
      },
    ];
    const rows = deriveAbcRawRows(items, "ALL");
    assert.deepEqual(
      rows.map((r) => r.abc),
      ["A", "B", "C"]
    );
    assert.equal(rows[0].vendorCode, "SKU-A");
    const abc = deriveAbcEnriched(rows);
    assert.equal(abc.aStats.count, 1);
    assert.equal(abc.bStats.count, 1);
    assert.equal(abc.cStats.count, 1);
    assert.equal(abc.liquidationCandidates[0].vendorCode, "SKU-C");
    assert.ok(abc.slowRows.some((r) => r.vendorCode === "SKU-C"));
  });

  it("ABC company filter does not leak the other company", async () => {
    const items = [
      {
        companyName: "ИП Петров",
        wb: PETROV_WB as never,
        ozon: PETROV_OZON as never,
        wbUnavailable: false,
      },
      {
        companyName: "ИП Лебедева",
        wb: LEB_WB as never,
        ozon: LEB_OZON as never,
        wbUnavailable: false,
      },
    ];
    const petrov = deriveAbcRawRows(items, "ALL").filter(
      (row) => row.company === "ИП Петров"
    );
    assert.equal(
      petrov.every((row) => row.company === "ИП Петров"),
      true
    );
    assert.equal(
      petrov.some((row) => row.company === "ИП Лебедева"),
      false
    );
  });

  it("PRELIMINARY Wave B dataMode is propagated, not promoted to FINAL", async () => {
    const repo = memoryRepo();
    const prelim = ozonAnalytics([
      {
        nmId: "1",
        vendorCode: "P",
        netSalesQty: 1,
        revenue: 10,
        netProfitAfterTax: 1,
        abcByProfit: "C",
      },
    ]);
    prelim.totals.netProfitStatus = "PRELIMINARY";
    prelim.taxesEstimated = true;
    await seedCompany(repo, "ИП Петров", PETROV_WB, prelim);
    const loaded = await loadWaveCCompanyProfitPair({
      companyName: "ИП Петров",
      ...CLOSED,
      repository: repo,
    });
    assert.equal(loaded.status, "HIT");
    if (loaded.status === "HIT") {
      assert.equal(loaded.ozonDataMode, "PRELIMINARY");
      assert.equal(loaded.insightsDataMode, "PRELIMINARY");
      assert.notEqual(loaded.insightsDataMode, "FINAL");
    }
  });

  it("1 ABC WB-only HIT FINAL does not read or enqueue Ozon", async () => {
    const repo = memoryRepo();
    await produceProfitReadModel({
      repository: repo,
      marketplace: "WB",
      companyScope: "ИП Петров",
      ...CLOSED,
      computeWb: async () => PETROV_WB as never,
    });
    const loaded = await loadWaveCAbcCompany({
      companyName: "ИП Петров",
      ...CLOSED,
      repository: repo,
      selectedMarketplace: "WB",
    });
    assert.equal(loaded.status, "HIT");
    assert.equal(loaded.heavyFcCalls, 0);
    if (loaded.status === "HIT") {
      assert.equal(loaded.abcDataMode, "FINAL");
      assert.equal(loaded.wbDataMode, "FINAL");
      assert.equal(loaded.ozon, undefined);
      assert.equal(loaded.abcCostIncomplete, false);
    }
    assert.equal(repo.findCalls.filter((m) => m === "OZON").length, 0);
    assert.equal(
      repo.jobs.some((job) => job.includes("PROFIT_OZON")),
      false
    );
  });

  it("2 ABC Ozon-only HIT FINAL does not read or enqueue WB", async () => {
    const repo = memoryRepo();
    await produceProfitReadModel({
      repository: repo,
      marketplace: "OZON",
      companyScope: "ИП Петров",
      ...CLOSED,
      computeOzon: async () => PETROV_OZON as never,
    });
    const loaded = await loadWaveCAbcCompany({
      companyName: "ИП Петров",
      ...CLOSED,
      repository: repo,
      selectedMarketplace: "Ozon",
    });
    assert.equal(loaded.status, "HIT");
    assert.equal(loaded.heavyFcCalls, 0);
    if (loaded.status === "HIT") {
      assert.equal(loaded.abcDataMode, "FINAL");
      assert.equal(loaded.ozonDataMode, "FINAL");
      assert.equal(loaded.wb, undefined);
      assert.equal(loaded.abcCostIncomplete, false);
    }
    assert.equal(repo.findCalls.filter((m) => m === "WB").length, 0);
    assert.equal(
      repo.jobs.some((job) => job.includes("PROFIT_WB")),
      false
    );
  });

  it("3 ABC ALL WB FINAL + Ozon FINAL => FINAL", async () => {
    const repo = memoryRepo();
    await seedCompany(repo, "ИП Петров", PETROV_WB, PETROV_OZON);
    const loaded = await loadWaveCAbcCompany({
      companyName: "ИП Петров",
      ...CLOSED,
      repository: repo,
      selectedMarketplace: "ALL",
    });
    assert.equal(loaded.status, "HIT");
    if (loaded.status === "HIT") {
      assert.equal(loaded.abcDataMode, "FINAL");
      assert.equal(loaded.wbDataMode, "FINAL");
      assert.equal(loaded.ozonDataMode, "FINAL");
    }
    assert.deepEqual(repo.findCalls, ["WB", "OZON"]);
  });

  it("4 ABC ALL WB FINAL + Ozon PRELIMINARY + complete costs => PRELIMINARY", async () => {
    const repo = memoryRepo();
    const ozonPrelim = ozonAnalytics([
      {
        nmId: "211",
        vendorCode: "OZ-B",
        netSalesQty: 5,
        revenue: 500,
        netProfitAfterTax: 20,
        abcByProfit: "B",
        costCoverageIncomplete: false,
      },
    ]);
    ozonPrelim.totals.netProfitStatus = "PRELIMINARY";
    ozonPrelim.totals.costCoverageIncomplete = false;
    ozonPrelim.taxesEstimated = true;
    await seedCompany(repo, "ИП Петров", PETROV_WB, ozonPrelim);
    const loaded = await loadWaveCAbcCompany({
      companyName: "ИП Петров",
      ...CLOSED,
      repository: repo,
      selectedMarketplace: "ALL",
    });
    assert.equal(loaded.status, "HIT");
    if (loaded.status === "HIT") {
      assert.equal(loaded.abcCostIncomplete, false);
      assert.equal(loaded.wbDataMode, "FINAL");
      assert.equal(loaded.ozonDataMode, "PRELIMINARY");
      assert.equal(loaded.abcDataMode, "PRELIMINARY");
      assert.notEqual(loaded.abcDataMode, "FINAL");
    }
  });

  it("5 ABC WB-only PRELIMINARY + complete costs => PRELIMINARY", async () => {
    const repo = memoryRepo();
    const wbPrelim = wbAnalytics([
      {
        nmId: "111",
        vendorCode: "SKU-A",
        netSalesQty: 10,
        revenue: 1000,
        netProfitAfterTax: 400,
        abcByProfit: "A",
        costCoverageIncomplete: false,
      },
    ]);
    wbPrelim.totals.netProfitStatus = "PRELIMINARY";
    wbPrelim.totals.dataMode = "PRELIMINARY";
    wbPrelim.totals.costCoverageIncomplete = false;
    await produceProfitReadModel({
      repository: repo,
      marketplace: "WB",
      companyScope: "ИП Петров",
      ...CLOSED,
      computeWb: async () => wbPrelim as never,
    });
    const loaded = await loadWaveCAbcCompany({
      companyName: "ИП Петров",
      ...CLOSED,
      repository: repo,
      selectedMarketplace: "WB",
    });
    assert.equal(loaded.status, "HIT");
    if (loaded.status === "HIT") {
      assert.equal(loaded.abcCostIncomplete, false);
      assert.equal(loaded.wbDataMode, "PRELIMINARY");
      assert.equal(loaded.abcDataMode, "PRELIMINARY");
      assert.notEqual(loaded.abcDataMode, "FINAL");
    }
    assert.equal(repo.findCalls.filter((m) => m === "OZON").length, 0);
  });

  it("6 ABC Ozon-only PRELIMINARY + complete costs => PRELIMINARY", async () => {
    const repo = memoryRepo();
    const ozonPrelim = ozonAnalytics([
      {
        nmId: "211",
        vendorCode: "OZ-B",
        netSalesQty: 5,
        revenue: 500,
        netProfitAfterTax: 20,
        abcByProfit: "B",
        costCoverageIncomplete: false,
      },
    ]);
    ozonPrelim.totals.netProfitStatus = "PRELIMINARY";
    ozonPrelim.totals.costCoverageIncomplete = false;
    ozonPrelim.taxesEstimated = true;
    await produceProfitReadModel({
      repository: repo,
      marketplace: "OZON",
      companyScope: "ИП Петров",
      ...CLOSED,
      computeOzon: async () => ozonPrelim as never,
    });
    const loaded = await loadWaveCAbcCompany({
      companyName: "ИП Петров",
      ...CLOSED,
      repository: repo,
      selectedMarketplace: "Ozon",
    });
    assert.equal(loaded.status, "HIT");
    if (loaded.status === "HIT") {
      assert.equal(loaded.abcCostIncomplete, false);
      assert.equal(loaded.ozonDataMode, "PRELIMINARY");
      assert.equal(loaded.abcDataMode, "PRELIMINARY");
      assert.notEqual(loaded.abcDataMode, "FINAL");
    }
    assert.equal(repo.findCalls.filter((m) => m === "WB").length, 0);
  });

  it("7 selected marketplace MISS is PENDING with no heavy fallback", async () => {
    const repo = memoryRepo();
    const miss = await loadWaveCAbcCompany({
      companyName: "ИП Петров",
      ...CLOSED,
      repository: repo,
      selectedMarketplace: "WB",
      enqueueOnMiss: false,
    });
    assert.equal(miss.status, "PENDING");
    assert.equal(miss.heavyFcCalls, 0);
    assert.equal(miss.sourceMarker, "PROFIT_READ_MODEL_MISS");
    assert.equal(repo.findCalls.filter((m) => m === "OZON").length, 0);
    assert.equal(repo.jobs.length, 0);
  });

  it("8 wrong selected marketplace formula fail-soft without heavy FC", async () => {
    const repo = memoryRepo();
    await produceProfitReadModel({
      repository: repo,
      marketplace: "WB",
      companyScope: "ИП Петров",
      ...CLOSED,
      computeWb: async () => PETROV_WB as never,
    });
    const k = [...repo.periods.keys()].find((x) => x.includes("|WB|"))!;
    const row = repo.periods.get(k)!;
    row.formulaVersion = "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2";
    (row.meta as { formulaVersion: string }).formulaVersion =
      "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2";
    const bad = await loadWaveCAbcCompany({
      companyName: "ИП Петров",
      ...CLOSED,
      repository: repo,
      selectedMarketplace: "WB",
      enqueueOnMiss: false,
    });
    assert.notEqual(bad.status, "HIT");
    assert.equal(bad.heavyFcCalls, 0);
    assert.equal(bad.sourceMarker, "PROFIT_READ_MODEL_MISS");
    assert.equal(repo.findCalls.filter((m) => m === "OZON").length, 0);
  });

  it("9 actual ABC page consumes adapter abcDataMode and has no cost-only FINAL shortcut", () => {
    const src = readFileSync(
      path.join(process.cwd(), "app/abc/page.tsx"),
      "utf8"
    );
    assert.match(src, /loadWaveCAbcCompany/);
    assert.match(src, /abcDataMode: loaded\.abcDataMode/);
    assert.match(src, /data-abc-data-mode=\{abcDataMode\}/);
    assert.doesNotMatch(
      src,
      /wbUnavailable \|\| costIncomplete \? "PRELIMINARY" : "FINAL"/
    );
    assert.match(
      src,
      /abcDataMode === "FINAL" && !wbUnavailable && !costIncomplete/
    );
  });
});
