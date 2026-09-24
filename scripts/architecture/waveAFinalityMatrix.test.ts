import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_V4_PERIOD_SNAPSHOT_FORMULA,
  createMemoryV6PeriodReadModelRepository,
  loadDashboardV6PeriodReadModel,
  persistPrecomputedV6DashboardBundle,
  resolveV6FinalityFromSynthetic,
  rejectsLegacyV4AsV6Final,
  syntheticSafeV2Attestation,
  type PeriodCompanyMarketplaceMetricsPayload,
  type DailyCompanyMarketplaceMetricsPayload,
} from "../../lib/dashboard/v6PeriodReadModel";

function sampleCompany(name: string, wbRevenue: number): PeriodCompanyMarketplaceMetricsPayload {
  return {
    companyName: name,
    ordersQty: 1,
    ordersAmount: wbRevenue,
    orderDataLoadedDays: 7,
    orderDataExpectedDays: 7,
    wbRevenue,
    ozonRevenue: 0,
    totalRevenue: wbRevenue,
    operatingProfitAfterTax: wbRevenue * 0.2,
    netProfit: wbRevenue * 0.15,
    profitAfterOwnerWithdrawal: wbRevenue * 0.1,
    cashFlowResult: 0,
    adsCost: 0,
    wbAdsCost: 0,
    ozonAdsCost: 0,
    drr: null,
    drrByOrders: null,
    loanPayments: 0,
    creditPrincipal: 0,
    creditInterest: 0,
    personalExpenses: 0,
    financialExpenses: 0,
    cashOnlyExpenses: 0,
    wbStockQty: 0,
    ozonStockQty: 0,
    warehouseStockQty: 0,
    wbAbcA: 0,
    wbAbcB: 0,
    wbAbcC: 0,
    ozonAbcA: 0,
    ozonAbcB: 0,
    ozonAbcC: 0,
    wbNetProfitStatus: "FINAL",
    wbSourceOwnershipFinal: true,
    wbTaxesUnavailable: false,
    ozonNetProfitStatus: "FINAL",
    ozonTaxesEstimated: false,
    ozonCoverageComplete: true,
    ozonQuarantineCount: 0,
    combinedDataMode: "FINAL",
  };
}

function sampleDaily(date: string, revenue: number): DailyCompanyMarketplaceMetricsPayload {
  return {
    businessDate: date,
    wbRevenue: revenue,
    ozonRevenue: 0,
    revenue,
    adsCost: 0,
    drr: null,
    operatingProfitAfterTax: revenue * 0.2,
    netProfit: revenue * 0.15,
    cashFlowResult: 0,
    loanPayments: 0,
    creditPrincipal: 0,
    creditInterest: 0,
  };
}

test("Finality A: closed + readiness final => FINAL allowed", () => {
  const r = resolveV6FinalityFromSynthetic({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    todayIso: "2026-09-02",
    readinessIsFinal: true,
    readinessStatus: "complete",
    issueKinds: [],
  });
  assert.equal(r.closedDateAutoFinal, false);
  assert.equal(r.dataMode, "FINAL");
  assert.equal(r.coverageStatus, "COMPLETE");
  assert.equal(r.weekPresentation.mayPresentAsFinal, true);
});

test("Finality B: closed + WB_FINANCE_MISSING => NOT FINAL", () => {
  const r = resolveV6FinalityFromSynthetic({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    todayIso: "2026-09-02",
    readinessIsFinal: false,
    readinessStatus: "incomplete",
    issueKinds: ["WB_FINANCE_MISSING"],
  });
  assert.equal(r.dataMode, "PRELIMINARY");
  assert.notEqual(r.weekPresentation.status, "FINAL");
  assert.ok(r.issues.includes("WB_FINANCE_MISSING"));
});

test("Finality C: closed + source ownership not final (readiness preliminary) => NOT FINAL", () => {
  const r = resolveV6FinalityFromSynthetic({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    todayIso: "2026-09-02",
    readinessIsFinal: false,
    readinessStatus: "preliminary",
    issueKinds: ["WB_WEEKLY_NOT_CLOSED"],
  });
  assert.equal(r.dataMode, "PRELIMINARY");
  assert.equal(r.closedDateAutoFinal, false);
});

test("Finality D: closed + Ozon realization incomplete => NOT silently FINAL", () => {
  const r = resolveV6FinalityFromSynthetic({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    todayIso: "2026-09-02",
    readinessIsFinal: false,
    readinessStatus: "incomplete",
    issueKinds: ["OZON_REALIZATION_SUMMARY_INCOMPLETE"],
  });
  assert.equal(r.dataMode, "PRELIMINARY");
  assert.ok(r.issues.includes("OZON_REALIZATION_SUMMARY_INCOMPLETE"));
});

test("Finality E: open/current period => PRELIMINARY even if readiness looks final", () => {
  const r = resolveV6FinalityFromSynthetic({
    dateFrom: "2026-09-01",
    dateTo: "2026-09-02",
    todayIso: "2026-09-02",
    readinessIsFinal: true,
    readinessStatus: "complete",
    issueKinds: [],
  });
  assert.equal(r.periodOpen, true);
  assert.equal(r.dataMode, "PRELIMINARY");
});

test("Finality F: incomplete readiness keeps HIT-able COMPLETE with explicit issues", () => {
  const r = resolveV6FinalityFromSynthetic({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    todayIso: "2026-09-02",
    readinessIsFinal: false,
    readinessStatus: "incomplete",
    issueKinds: ["OZON_FINANCE_MISSING"],
    hasUsablePayload: true,
  });
  assert.equal(r.coverageStatus, "COMPLETE");
  assert.equal(r.dataMode, "PRELIMINARY");
  assert.ok(r.issues.includes("OZON_FINANCE_MISSING"));
});

test("Finality G: V4 formula rejected", () => {
  assert.equal(rejectsLegacyV4AsV6Final(LEGACY_V4_PERIOD_SNAPSHOT_FORMULA), true);
});

test("Finality: calendar closed alone does not auto-FINAL without evidence", () => {
  // persistPrecomputed without explicit FINAL stays PRELIMINARY (CLOSED_DATE_AUTO_FINAL=NO)
  const repository = createMemoryV6PeriodReadModelRepository();
  return persistPrecomputedV6DashboardBundle({
    repository,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    companyRows: [sampleCompany("ИП Петров", 1000)],
    dailyPoints: [sampleDaily("2026-08-17", 1000)],
    todayIso: "2026-09-02",
    // no dataMode — must not fabricate FINAL
    v2SafetyAttestation: syntheticSafeV2Attestation(),
  }).then(async (bundle) => {
    assert.equal(bundle.meta.closedDateAutoFinal, false);
    assert.equal(bundle.meta.dataMode, "PRELIMINARY");
    const loaded = await loadDashboardV6PeriodReadModel({
      repository,
      dateFrom: "2026-08-17",
      dateTo: "2026-08-23",
    });
    assert.equal(loaded.status, "HIT");
    if (loaded.status === "HIT") {
      assert.equal(loaded.bundle.meta.dataMode, "PRELIMINARY");
    }
  });
});

test("Finality: explicit evidence FINAL persists", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  await persistPrecomputedV6DashboardBundle({
    repository,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    companyRows: [sampleCompany("ИП Петров", 1000)],
    dailyPoints: [sampleDaily("2026-08-17", 1000)],
    todayIso: "2026-09-02",
    dataMode: "FINAL",
    coverageStatus: "COMPLETE",
    readinessIsFinal: true,
    readinessStatus: "complete",
    issues: [],
    v2SafetyAttestation: syntheticSafeV2Attestation(),
  });
  const loaded = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
  });
  assert.equal(loaded.status, "HIT");
  if (loaded.status === "HIT") {
    assert.equal(loaded.bundle.meta.dataMode, "FINAL");
    assert.equal(loaded.bundle.meta.closedDateAutoFinal, false);
  }
});

test("Direct 1: closed + ownership final + taxes available + no quarantine => FINAL allowed", () => {
  const r = resolveV6FinalityFromSynthetic({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    todayIso: "2026-09-02",
    readinessIsFinal: true,
    readinessStatus: "complete",
    issueKinds: [],
    direct: {
      wbSourceOwnershipFinal: true,
      wbTaxesUnavailable: false,
      ozonCoverageComplete: true,
      ozonQuarantineCount: 0,
      canonicalDataMode: "FINAL",
    },
  });
  assert.equal(r.dataMode, "FINAL");
  assert.equal(r.direct.wbSourceOwnershipFinal, true);
  assert.equal(r.direct.wbTaxesUnavailable, false);
});

test("Direct 2: sourceOwnershipFinal=false demotes FINAL", () => {
  const r = resolveV6FinalityFromSynthetic({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    todayIso: "2026-09-02",
    readinessIsFinal: true,
    readinessStatus: "complete",
    issueKinds: [],
    direct: {
      wbSourceOwnershipFinal: false,
      wbTaxesUnavailable: false,
      ozonCoverageComplete: true,
      ozonQuarantineCount: 0,
      canonicalDataMode: "FINAL",
    },
  });
  assert.equal(r.dataMode, "PRELIMINARY");
  assert.equal(r.weekPresentation.reason, "WB_SOURCE_OWNERSHIP_NOT_FINAL");
});

test("Direct 3: taxesUnavailable=true demotes FINAL", () => {
  const r = resolveV6FinalityFromSynthetic({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    todayIso: "2026-09-02",
    readinessIsFinal: true,
    readinessStatus: "complete",
    issueKinds: [],
    direct: {
      wbSourceOwnershipFinal: true,
      wbTaxesUnavailable: true,
      ozonCoverageComplete: true,
      ozonQuarantineCount: 0,
      canonicalDataMode: "FINAL",
    },
  });
  assert.equal(r.dataMode, "PRELIMINARY");
  assert.equal(r.weekPresentation.reason, "WB_TAXES_UNAVAILABLE");
});

test("Direct 4: ozon quarantine count > 0 demotes FINAL", () => {
  const r = resolveV6FinalityFromSynthetic({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    todayIso: "2026-09-02",
    readinessIsFinal: true,
    readinessStatus: "complete",
    issueKinds: [],
    direct: {
      wbSourceOwnershipFinal: true,
      wbTaxesUnavailable: false,
      ozonCoverageComplete: true,
      ozonQuarantineCount: 2,
      canonicalDataMode: "FINAL",
    },
  });
  assert.equal(r.dataMode, "PRELIMINARY");
  assert.equal(r.weekPresentation.reason, "OZON_QUARANTINE_ACTIVE");
});

test("Direct 5-6: selected company meta diverges from ALL", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  const petrov = {
    ...sampleCompany("ИП Петров", 1000),
    wbSourceOwnershipFinal: true,
    wbTaxesUnavailable: false,
    combinedDataMode: "FINAL" as const,
  };
  const lebedeva = {
    ...sampleCompany("ИП Лебедева", 500),
    wbSourceOwnershipFinal: false,
    wbTaxesUnavailable: false,
    wbNetProfitStatus: "PRELIMINARY" as const,
    combinedDataMode: "PRELIMINARY" as const,
  };
  await persistPrecomputedV6DashboardBundle({
    repository,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    companyRows: [petrov, lebedeva],
    dailyPoints: [
      sampleDaily("2026-08-17", 1500),
    ],
    todayIso: "2026-09-02",
    dataMode: "PRELIMINARY",
    coverageStatus: "COMPLETE",
    readinessIsFinal: false,
    readinessStatus: "preliminary",
    issues: [],
    v2SafetyAttestation: syntheticSafeV2Attestation(),
  });

  const allHit = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    companyScope: "ALL",
  });
  assert.equal(allHit.status, "HIT");
  if (allHit.status === "HIT") {
    assert.equal(allHit.bundle.meta.companyScope, "ALL");
    assert.equal(allHit.bundle.meta.dataMode, "PRELIMINARY");
  }

  // Force Petrov company row meta to FINAL while ALL stays PRELIMINARY.
  const petrovExisting = await repository.findPeriod({
    companyScope: "ИП Петров",
    marketplace: "ALL",
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    formulaVersion: "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2",
  });
  await repository.upsertPeriod({
    companyScope: "ИП Петров",
    marketplace: "ALL",
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    formulaVersion: "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2",
    dataMode: "FINAL",
    coverageStatus: "COMPLETE",
    sourceFingerprint: "petrov-final",
    payloadChecksum: "petrov-final",
    payload: petrov,
    meta: {
      ...(allHit.status === "HIT" ? allHit.bundle.meta : ({} as never)),
      companyScope: "ИП Петров",
      dataMode: "FINAL",
      readinessIsFinal: true,
      readinessStatus: "complete",
      weekPresentationStatus: "FINAL",
      weekPresentationReason: null,
      wbSourceOwnershipFinal: true,
      wbTaxesUnavailable: false,
      ozonCoverageComplete: true,
      ozonQuarantineCount: 0,
      canonicalDataMode: "FINAL",
      sourceFingerprint: "petrov-final",
      payloadChecksum: "petrov-final",
      v2SafetyAttestation: petrovExisting?.meta?.v2SafetyAttestation,
    },
    generatedAt: new Date().toISOString(),
  });

  const petrovHit = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    companyScope: "ИП Петров",
  });
  assert.equal(petrovHit.status, "HIT");
  if (petrovHit.status === "HIT") {
    assert.equal(petrovHit.bundle.meta.companyScope, "ИП Петров");
    assert.equal(petrovHit.bundle.meta.dataMode, "FINAL");
    assert.notEqual(petrovHit.bundle.meta.companyScope, "ALL");
  }

  const lebedevaHit = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    companyScope: "ИП Лебедева",
  });
  assert.equal(lebedevaHit.status, "HIT");
  if (lebedevaHit.status === "HIT") {
    assert.equal(lebedevaHit.bundle.meta.companyScope, "ИП Лебедева");
    assert.equal(lebedevaHit.bundle.meta.dataMode, "PRELIMINARY");
  }
});
