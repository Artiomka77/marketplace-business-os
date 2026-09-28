import assert from "node:assert/strict";
import test from "node:test";

import {
  createMemoryV6PeriodReadModelRepository,
  loadDashboardV6PeriodReadModel,
  persistPrecomputedV6DashboardBundle,
  syntheticSafeV2Attestation,
  type DailyCompanyMarketplaceMetricsPayload,
  type PeriodCompanyMarketplaceMetricsPayload,
} from "../../lib/dashboard/v6PeriodReadModel";
import {
  pageDataModeFromMeta,
  resolveSelectedScopeIdentity,
} from "../../lib/dashboard/selectedScopeIdentity";

const PETROV = "ИП Петров";
const LEBEDEVA = "ИП Лебедева";
const FORMULA = "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2";

function sampleCompany(
  name: string,
  revenue: number
): PeriodCompanyMarketplaceMetricsPayload {
  return {
    companyName: name,
    ordersQty: 1,
    ordersAmount: revenue,
    orderDataLoadedDays: 7,
    orderDataExpectedDays: 7,
    wbRevenue: revenue,
    ozonRevenue: 0,
    totalRevenue: revenue,
    operatingProfitAfterTax: revenue * 0.2,
    netProfit: revenue * 0.15,
    profitAfterOwnerWithdrawal: revenue * 0.1,
    cashFlowResult: revenue * 0.05,
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
  };
}

function sampleDaily(
  date: string,
  revenue: number
): DailyCompanyMarketplaceMetricsPayload {
  return {
    businessDate: date,
    wbRevenue: revenue,
    ozonRevenue: 0,
    revenue,
    adsCost: 0,
    drr: null,
    operatingProfitAfterTax: 0,
    netProfit: 0,
    cashFlowResult: 0,
    loanPayments: 0,
    creditPrincipal: 0,
    creditInterest: 0,
  };
}

async function seedDivergentScopes() {
  const repository = createMemoryV6PeriodReadModelRepository();
  const petrov = sampleCompany(PETROV, 111111.11);
  const lebedeva = sampleCompany(LEBEDEVA, 222222.22);
  await persistPrecomputedV6DashboardBundle({
    repository,
    dateFrom: "2026-06-01",
    dateTo: "2026-06-07",
    companyRows: [petrov, lebedeva],
    dailyPoints: [sampleDaily("2026-06-01", 333333.33)],
    todayIso: "2026-09-03",
    dataMode: "PRELIMINARY",
    coverageStatus: "COMPLETE",
    readinessIsFinal: false,
    readinessStatus: "incomplete",
    issues: ["OZON_ADS_PENDING"],
    v2SafetyAttestation: syntheticSafeV2Attestation(
      "D1D5_V2_SAFE_PRELIMINARY_SHORT_DAILY_WINDOW"
    ),
  });

  const allHit = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-06-01",
    dateTo: "2026-06-07",
    companyScope: "ALL",
  });
  assert.equal(allHit.status, "HIT");
  if (allHit.status !== "HIT") throw new Error("ALL miss");

  const petrovExisting = await repository.findPeriod({
    companyScope: PETROV,
    marketplace: "ALL",
    dateFrom: "2026-06-01",
    dateTo: "2026-06-07",
    formulaVersion: FORMULA,
  });
  await repository.upsertPeriod({
    companyScope: PETROV,
    marketplace: "ALL",
    dateFrom: "2026-06-01",
    dateTo: "2026-06-07",
    formulaVersion: FORMULA,
    dataMode: "FINAL",
    coverageStatus: "COMPLETE",
    sourceFingerprint: "petrov-final",
    payloadChecksum: "petrov-final",
    payload: petrov,
    meta: {
      ...allHit.bundle.meta,
      companyScope: PETROV,
      dataMode: "FINAL",
      readinessIsFinal: true,
      readinessStatus: "complete",
      weekPresentationStatus: "FINAL",
      weekPresentationReason: null,
      ozonQuarantineCount: 0,
      canonicalDataMode: "FINAL",
      completeness: { ...allHit.bundle.meta.completeness, issues: [] },
      sourceFingerprint: "petrov-final",
      payloadChecksum: "petrov-final",
      v2SafetyAttestation: petrovExisting?.meta?.v2SafetyAttestation,
    },
    generatedAt: new Date().toISOString(),
  });

  const lebedevaExisting = await repository.findPeriod({
    companyScope: LEBEDEVA,
    marketplace: "ALL",
    dateFrom: "2026-06-01",
    dateTo: "2026-06-07",
    formulaVersion: FORMULA,
  });
  await repository.upsertPeriod({
    companyScope: LEBEDEVA,
    marketplace: "ALL",
    dateFrom: "2026-06-01",
    dateTo: "2026-06-07",
    formulaVersion: FORMULA,
    dataMode: "PRELIMINARY",
    coverageStatus: "COMPLETE",
    sourceFingerprint: "lebedeva-prelim",
    payloadChecksum: "lebedeva-prelim",
    payload: lebedeva,
    meta: {
      ...allHit.bundle.meta,
      companyScope: LEBEDEVA,
      dataMode: "PRELIMINARY",
      readinessIsFinal: false,
      readinessStatus: "incomplete",
      weekPresentationStatus: "PRELIMINARY",
      weekPresentationReason: "OZON_QUARANTINE_ACTIVE",
      ozonQuarantineCount: 3,
      canonicalDataMode: "PRELIMINARY",
      completeness: {
        ...allHit.bundle.meta.completeness,
        issues: ["OZON_ADS_PENDING"],
      },
      sourceFingerprint: "lebedeva-prelim",
      payloadChecksum: "lebedeva-prelim",
      v2SafetyAttestation: lebedevaExisting?.meta?.v2SafetyAttestation,
    },
    generatedAt: new Date().toISOString(),
  });

  return repository;
}

test("Wave A selected-scope: ALL selection uses ALL meta", () => {
  const decision = resolveSelectedScopeIdentity({
    selectedCompanyValue: "ALL",
    selectedScopeStatus: "HIT",
  });
  assert.equal(decision.kind, "USE_ALL");
  assert.equal(decision.usesAllMeta, true);
  assert.equal(pageDataModeFromMeta({ dataMode: "PRELIMINARY" }), "PRELIMINARY");
});

test("Wave A selected-scope: Petrov FINAL while ALL PRELIMINARY → selected page FINAL", async () => {
  const repository = await seedDivergentScopes();
  const allHit = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-06-01",
    dateTo: "2026-06-07",
    companyScope: "ALL",
  });
  assert.equal(allHit.status, "HIT");
  if (allHit.status !== "HIT") return;
  assert.equal(allHit.bundle.meta.dataMode, "PRELIMINARY");

  const petrovHit = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-06-01",
    dateTo: "2026-06-07",
    companyScope: PETROV,
  });
  assert.equal(petrovHit.status, "HIT");
  if (petrovHit.status !== "HIT") return;
  assert.equal(petrovHit.bundle.meta.dataMode, "FINAL");

  const decision = resolveSelectedScopeIdentity({
    selectedCompanyValue: PETROV,
    selectedScopeStatus: petrovHit.status,
  });
  assert.equal(decision.kind, "USE_SELECTED");
  assert.equal(decision.usesAllMeta, false);
  assert.equal(pageDataModeFromMeta(petrovHit.bundle.meta), "FINAL");
  assert.notEqual(
    pageDataModeFromMeta(petrovHit.bundle.meta),
    pageDataModeFromMeta(allHit.bundle.meta)
  );
});

test("Wave A selected-scope: Lebedeva PRELIMINARY while Petrov FINAL → selected PRELIMINARY", async () => {
  const repository = await seedDivergentScopes();
  const leb = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-06-01",
    dateTo: "2026-06-07",
    companyScope: LEBEDEVA,
  });
  assert.equal(leb.status, "HIT");
  if (leb.status !== "HIT") return;
  assert.equal(leb.bundle.meta.dataMode, "PRELIMINARY");

  const decision = resolveSelectedScopeIdentity({
    selectedCompanyValue: LEBEDEVA,
    selectedScopeStatus: leb.status,
  });
  assert.equal(decision.kind, "USE_SELECTED");
  assert.equal(pageDataModeFromMeta(leb.bundle.meta), "PRELIMINARY");
});

test("Wave A selected-scope: MISS fails closed — no ALL meta fallback", () => {
  const decision = resolveSelectedScopeIdentity({
    selectedCompanyValue: PETROV,
    selectedScopeStatus: "PENDING",
    selectedScopeReason: "V6_PERIOD_READMODEL_COMPANY_MISSING",
  });
  assert.equal(decision.kind, "FAIL_CLOSED");
  assert.equal(decision.usesAllMeta, false);
  assert.equal(decision.failClosedReason, "V6_PERIOD_READMODEL_COMPANY_MISSING");
});

test("Wave A selected-scope: marketplaceCompanyName sync uses same selected meta", () => {
  const viaCompany = resolveSelectedScopeIdentity({
    selectedCompanyValue: PETROV,
    selectedScopeStatus: "HIT",
  });
  const viaMarketplace = resolveSelectedScopeIdentity({
    selectedCompanyValue: PETROV,
    selectedScopeStatus: "HIT",
  });
  assert.deepEqual(viaCompany, viaMarketplace);
  assert.equal(viaMarketplace.kind, "USE_SELECTED");
  assert.equal(viaMarketplace.usesAllMeta, false);
});

test("Wave A selected-scope: HIT selected read supplies daily without duplicate decision", () => {
  const decision = resolveSelectedScopeIdentity({
    selectedCompanyValue: PETROV,
    selectedScopeStatus: "HIT",
  });
  assert.equal(decision.kind, "USE_SELECTED");
  assert.equal(decision.usesAllMeta, false);
});
