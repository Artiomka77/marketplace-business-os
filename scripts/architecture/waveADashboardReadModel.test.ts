import assert from "node:assert/strict";
import test from "node:test";

import {
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
  LEGACY_V4_PERIOD_SNAPSHOT_FORMULA,
  createMemoryV6PeriodReadModelRepository,
  loadDashboardV6PeriodReadModel,
  persistPrecomputedV6DashboardBundle,
  syntheticSafeV2Attestation,
  type PeriodCompanyMarketplaceMetricsPayload,
  type DailyCompanyMarketplaceMetricsPayload,
} from "../../lib/dashboard/v6PeriodReadModel";

const SAFE_V2 = syntheticSafeV2Attestation();
const SHORT_V2 = syntheticSafeV2Attestation(
  "D1D5_V2_SAFE_PRELIMINARY_SHORT_DAILY_WINDOW"
);

function sampleCompany(
  name: string,
  wbRevenue: number,
  ozonRevenue = 0
): PeriodCompanyMarketplaceMetricsPayload {
  const totalRevenue = wbRevenue + ozonRevenue;
  return {
    companyName: name,
    ordersQty: 10,
    ordersAmount: totalRevenue,
    orderDataLoadedDays: 7,
    orderDataExpectedDays: 7,
    wbRevenue,
    ozonRevenue,
    totalRevenue,
    operatingProfitAfterTax: totalRevenue * 0.2,
    netProfit: totalRevenue * 0.15,
    profitAfterOwnerWithdrawal: totalRevenue * 0.1,
    cashFlowResult: totalRevenue * 0.05,
    adsCost: totalRevenue * 0.08,
    wbAdsCost: wbRevenue * 0.08,
    ozonAdsCost: ozonRevenue * 0.08,
    drr: 8,
    drrByOrders: 8,
    loanPayments: 0,
    creditPrincipal: 0,
    creditInterest: 0,
    personalExpenses: 0,
    financialExpenses: 0,
    cashOnlyExpenses: 0,
    wbStockQty: 1,
    ozonStockQty: 1,
    warehouseStockQty: 0,
    wbAbcA: 0,
    wbAbcB: 0,
    wbAbcC: 0,
    ozonAbcA: 0,
    ozonAbcB: 0,
    ozonAbcC: 0,
  };
}

function sampleDaily(date: string, revenue: number): DailyCompanyMarketplaceMetricsPayload {
  return {
    businessDate: date,
    wbRevenue: revenue * 0.4,
    ozonRevenue: revenue * 0.6,
    revenue,
    adsCost: revenue * 0.08,
    drr: 8,
    operatingProfitAfterTax: revenue * 0.2,
    netProfit: revenue * 0.15,
    cashFlowResult: revenue * 0.05,
    loanPayments: 0,
    creditPrincipal: 0,
    creditInterest: 0,
  };
}

const PETROV = "ИП Петров";
const LEBEDEVA = "ИП Лебедева";

test("Wave A: V6 COMPLETE FINAL accepted for 7d closed period", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  await persistPrecomputedV6DashboardBundle({
    repository,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    companyRows: [
      sampleCompany(PETROV, 237371.72),
      sampleCompany(LEBEDEVA, 47329.22, 408692.82),
    ],
    dailyPoints: [
      sampleDaily("2026-08-17", 90000),
      sampleDaily("2026-08-23", 100000),
    ],
    todayIso: "2026-09-02",
    dataMode: "FINAL",
    coverageStatus: "COMPLETE",
    readinessIsFinal: true,
    readinessStatus: "complete",
    issues: [],
    v2SafetyAttestation: SAFE_V2,
  });

  const loaded = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
  });
  assert.equal(loaded.status, "HIT");
  if (loaded.status !== "HIT") return;
  assert.equal(loaded.bundle.sourceMarker, "READ_MODEL");
  assert.equal(loaded.bundle.meta.formulaVersion, FINANCIAL_CORE_V6_PERIOD_READMODEL_V2);
  assert.equal(loaded.bundle.meta.dataMode, "FINAL");
  assert.equal(loaded.bundle.companyRows.length, 2);
  assert.ok(loaded.bundle.dailyPoints.length >= 2);
});

test("Wave A: short 1d period is read-model-first (no live FC)", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  await persistPrecomputedV6DashboardBundle({
    repository,
    dateFrom: "2026-08-20",
    dateTo: "2026-08-20",
    companyRows: [sampleCompany(PETROV, 1000)],
    dailyPoints: [sampleDaily("2026-08-20", 1000)],
    todayIso: "2026-09-02",
    v2SafetyAttestation: SAFE_V2,
  });
  const loaded = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-08-20",
    dateTo: "2026-08-20",
    companyScope: PETROV,
  });
  assert.equal(loaded.status, "HIT");
});

test("Wave A: safe long final exact-cover V2 with attestation can HIT", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  for (const [from, to] of [
    ["2026-07-25", "2026-08-23"],
    ["2026-06-01", "2026-08-23"],
  ] as const) {
    await persistPrecomputedV6DashboardBundle({
      repository,
      dateFrom: from,
      dateTo: to,
      companyRows: [sampleCompany(PETROV, 5000), sampleCompany(LEBEDEVA, 6000)],
      dailyPoints: [sampleDaily(from, 100), sampleDaily(to, 200)],
      todayIso: "2026-09-02",
      dataMode: "FINAL",
      v2SafetyAttestation: SAFE_V2,
    });
    const loaded = await loadDashboardV6PeriodReadModel({
      repository,
      dateFrom: from,
      dateTo: to,
    });
    assert.equal(loaded.status, "HIT", `${from}..${to}`);
  }
});

test("Wave A: unsafe long/no-proof V2 fixture cannot HIT", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  await assert.rejects(
    () =>
      persistPrecomputedV6DashboardBundle({
        repository,
        dateFrom: "2026-06-01",
        dateTo: "2026-08-23",
        companyRows: [sampleCompany(PETROV, 5000)],
        dailyPoints: [sampleDaily("2026-06-01", 100)],
        todayIso: "2026-09-02",
      }),
    /D1D5_V2_PERSIST_FORBIDDEN/
  );
  const loaded = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-06-01",
    dateTo: "2026-08-23",
  });
  assert.notEqual(loaded.status, "HIT");
});

test("Wave A: current/open period is PRELIMINARY", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  await persistPrecomputedV6DashboardBundle({
    repository,
    dateFrom: "2026-09-01",
    dateTo: "2026-09-02",
    companyRows: [sampleCompany(PETROV, 10)],
    dailyPoints: [sampleDaily("2026-09-01", 10), sampleDaily("2026-09-02", 5)],
    todayIso: "2026-09-02",
    v2SafetyAttestation: SHORT_V2,
  });
  const loaded = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-09-01",
    dateTo: "2026-09-02",
  });
  assert.equal(loaded.status, "HIT");
  if (loaded.status !== "HIT") return;
  assert.equal(loaded.bundle.meta.dataMode, "PRELIMINARY");
});

test("Wave A: miss path returns PENDING without heavy FC", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  const loaded = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-01-01",
    dateTo: "2026-01-07",
  });
  assert.equal(loaded.status, "PENDING");
  assert.notEqual(loaded.status, "HIT");
  if (loaded.status === "PENDING" || loaded.status === "UNAVAILABLE") {
    assert.equal(loaded.sourceMarker, "READ_MODEL_MISS");
  }
});

test("Wave A: V4 formula row rejected as V6 FINAL", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  await repository.upsertPeriod({
    companyScope: "ALL",
    marketplace: "ALL",
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    formulaVersion: LEGACY_V4_PERIOD_SNAPSHOT_FORMULA,
    dataMode: "FINAL",
    coverageStatus: "COMPLETE",
    sourceFingerprint: "v4",
    payloadChecksum: "v4",
    payload: sampleCompany("ALL", 1),
    meta: {
      formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
      coverageStatus: "COMPLETE",
      dataMode: "FINAL",
      generatedAt: new Date().toISOString(),
      sourceFingerprint: "v4",
      payloadChecksum: "v4",
      companyScope: "ALL",
      marketplace: "ALL",
      dateFrom: "2026-08-17",
      dateTo: "2026-08-23",
      completeness: { orderDataLoadedDays: 0, orderDataExpectedDays: 0, issues: [] },
      invalidationKey: "x",
      staleAfterMs: null,
      closedDateAutoFinal: false,
      readinessIsFinal: true,
      readinessStatus: "complete",
      weekPresentationStatus: "FINAL",
      weekPresentationReason: null,
      wbSourceOwnershipFinal: true,
      wbTaxesUnavailable: false,
      ozonCoverageComplete: true,
      ozonQuarantineCount: 0,
      canonicalDataMode: "FINAL",
    },
    generatedAt: new Date().toISOString(),
  });

  const loaded = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
  });
  assert.equal(loaded.status, "UNAVAILABLE");
  assert.notEqual(loaded.status, "HIT");
  if (loaded.status === "UNAVAILABLE") {
    assert.equal(loaded.reason, "LEGACY_V4_FORMULA_REJECTED_AS_V6_FINAL");
    assert.equal(loaded.rejectedFormulaVersion, LEGACY_V4_PERIOD_SNAPSHOT_FORMULA);
  }
});

test("Wave A: bounded concurrency read hits stay stable", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  await persistPrecomputedV6DashboardBundle({
    repository,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    companyRows: [sampleCompany(PETROV, 237371.72), sampleCompany(LEBEDEVA, 47329.22)],
    dailyPoints: [sampleDaily("2026-08-17", 1), sampleDaily("2026-08-23", 2)],
    todayIso: "2026-09-02",
    v2SafetyAttestation: SAFE_V2,
  });

  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      loadDashboardV6PeriodReadModel({
        repository,
        dateFrom: "2026-08-17",
        dateTo: "2026-08-23",
      })
    )
  );
  const elapsed = Date.now() - started;
  assert.equal(results.every((r) => r.status === "HIT"), true);
  assert.ok(elapsed < 2000, `p95-ish elapsed ${elapsed}`);
});

test("Wave A V2: company-scoped daily grain differs from ALL", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  await persistPrecomputedV6DashboardBundle({
    repository,
    companyScope: "ALL",
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    companyRows: [
      sampleCompany(PETROV, 237371.72, 0),
      sampleCompany(LEBEDEVA, 47329.22, 408692.82),
    ],
    dailyPoints: [sampleDaily("2026-08-17", 100000), sampleDaily("2026-08-23", 200000)],
    todayIso: "2026-09-02",
    v2SafetyAttestation: SAFE_V2,
  });
  await persistPrecomputedV6DashboardBundle({
    repository,
    companyScope: PETROV,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    companyRows: [sampleCompany(PETROV, 237371.72, 0)],
    dailyPoints: [sampleDaily("2026-08-17", 10000), sampleDaily("2026-08-23", 20000)],
    todayIso: "2026-09-02",
    v2SafetyAttestation: SAFE_V2,
  });
  await persistPrecomputedV6DashboardBundle({
    repository,
    companyScope: LEBEDEVA,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    companyRows: [sampleCompany(LEBEDEVA, 47329.22, 408692.82)],
    dailyPoints: [sampleDaily("2026-08-17", 90000), sampleDaily("2026-08-23", 180000)],
    todayIso: "2026-09-02",
    v2SafetyAttestation: SAFE_V2,
  });

  const all = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    companyScope: "ALL",
  });
  const petrov = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    companyScope: PETROV,
  });
  const lebedeva = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    companyScope: LEBEDEVA,
  });
  assert.equal(all.status, "HIT");
  assert.equal(petrov.status, "HIT");
  assert.equal(lebedeva.status, "HIT");
  if (all.status !== "HIT" || petrov.status !== "HIT" || lebedeva.status !== "HIT") return;
  assert.notEqual(
    all.bundle.dailyPoints[0]?.revenue,
    petrov.bundle.dailyPoints[0]?.revenue
  );
  assert.equal(petrov.bundle.dailyPoints[0]?.revenue, 10000);
  assert.equal(lebedeva.bundle.dailyPoints[0]?.revenue, 90000);
  assert.equal(all.bundle.dailyPoints[0]?.revenue, 100000);
});

test("Wave A oracle controls: closed week WB/Ozon company revenues", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  const petrov = sampleCompany(PETROV, 237371.72);
  const lebedeva = sampleCompany(LEBEDEVA, 47329.22);
  // Ozon ALL control is carried on combined ALL aggregate via company rows.
  lebedeva.ozonRevenue = 0;
  const ozonOnly = sampleCompany("OZON_CONTROL", 0, 408692.82);
  ozonOnly.companyName = LEBEDEVA;
  // Use two companies with known WB controls; Ozon control checked via sum.
  const rows = [
    sampleCompany(PETROV, 237371.72, 0),
    sampleCompany(LEBEDEVA, 47329.22, 408692.82),
  ];
  await persistPrecomputedV6DashboardBundle({
    repository,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    companyRows: rows,
    dailyPoints: [sampleDaily("2026-08-17", 100)],
    todayIso: "2026-09-02",
    v2SafetyAttestation: SAFE_V2,
  });
  const loaded = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
  });
  assert.equal(loaded.status, "HIT");
  if (loaded.status !== "HIT") return;
  const byName = new Map(loaded.bundle.companyRows.map((r) => [r.companyName, r]));
  assert.ok(Math.abs((byName.get(PETROV)?.wbRevenue ?? 0) - 237371.72) < 0.011);
  assert.ok(Math.abs((byName.get(LEBEDEVA)?.wbRevenue ?? 0) - 47329.22) < 0.011);
  const wb =
    (byName.get(PETROV)?.wbRevenue ?? 0) + (byName.get(LEBEDEVA)?.wbRevenue ?? 0);
  const ozon =
    (byName.get(PETROV)?.ozonRevenue ?? 0) + (byName.get(LEBEDEVA)?.ozonRevenue ?? 0);
  assert.ok(Math.abs(wb - 284700.94) < 0.011);
  assert.ok(Math.abs(ozon - 408692.82) < 0.011);
  assert.ok(Math.abs(wb + ozon - 693393.76) < 0.011);
});
