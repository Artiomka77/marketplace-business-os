import assert from "node:assert/strict";
import test from "node:test";

import {
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V1,
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
  createMemoryV6PeriodReadModelRepository,
  evaluateD1D5CorrectedBuildEligibility,
  evaluateRequiredV2BundleEligibility,
  inclusiveIsoDayCount,
  isCalendarMonthSpan,
  isYtdStyleSpan,
  liveV2SafetyAttestation,
  loadDashboardV6PeriodReadModel,
  persistPrecomputedV6DashboardBundle,
  syntheticSafeV2Attestation,
  type PeriodCompanyMarketplaceMetricsPayload,
} from "../../lib/dashboard/v6PeriodReadModel";
import type { WbSourceOwnershipPlan } from "../../lib/wb/sourceOwnership";

function plan(
  modes: WbSourceOwnershipPlan["intervals"][number]["mode"][],
  isFinanciallyFinal: boolean
): WbSourceOwnershipPlan {
  return {
    selectedSessionIds: ["s1"],
    isFinanciallyFinal,
    intervals: modes.map((mode) => ({
      companyName: "ALL",
      dateFrom: "2026-08-17",
      dateTo: "2026-08-23",
      mode,
      reportNumbers: ["1"],
      selectedSessionIds: ["s1"],
      exactCoverageComplete: isFinanciallyFinal,
      dailyCalendarCoverageComplete: true,
      dailyReportCoverageComplete: true,
      isFinanciallyFinal,
      preliminaryReasons: [],
    })),
  };
}

function sampleCompany(name: string): PeriodCompanyMarketplaceMetricsPayload {
  return {
    companyName: name,
    ordersQty: 1,
    ordersAmount: 1,
    orderDataLoadedDays: 1,
    orderDataExpectedDays: 1,
    wbRevenue: 1,
    ozonRevenue: 0,
    totalRevenue: 1,
    operatingProfitAfterTax: 1,
    netProfit: 1,
    profitAfterOwnerWithdrawal: 1,
    cashFlowResult: 1,
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

test("SAFE_WEEK_V2_BUILD_TEST: exact financially final week is eligible", () => {
  const decision = evaluateD1D5CorrectedBuildEligibility({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    plan: plan(["EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS"], true),
  });
  assert.equal(decision.eligible, true);
  assert.equal(decision.reason, "D1D5_V2_SAFE_FINANCIALLY_FINAL_COVER");
});

test("D6_UNSAFE_BUILD_GUARD_TEST: YTD operational fallback is not eligible", () => {
  assert.equal(isYtdStyleSpan("2026-01-01", "2026-09-04"), true);
  const decision = evaluateD1D5CorrectedBuildEligibility({
    dateFrom: "2026-01-01",
    dateTo: "2026-09-04",
    plan: plan(["PRELIMINARY_OPERATIONAL_FALLBACK"], false),
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "D6_UNSAFE_WB_OWNERSHIP_MODE");
});

test("D6_UNSAFE_BUILD_GUARD_TEST: January calendar month no-source is not eligible", () => {
  assert.equal(isCalendarMonthSpan("2026-01-01", "2026-01-31"), true);
  const decision = evaluateD1D5CorrectedBuildEligibility({
    dateFrom: "2026-01-01",
    dateTo: "2026-01-31",
    plan: plan(["PRELIMINARY_NO_SOURCE"], false),
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "D6_UNSAFE_WB_OWNERSHIP_MODE");
});

test("D6_UNSAFE_BUILD_GUARD_TEST: June calendar month daily fallback is not eligible", () => {
  const decision = evaluateD1D5CorrectedBuildEligibility({
    dateFrom: "2026-06-01",
    dateTo: "2026-06-30",
    plan: plan(["PRELIMINARY_DAILY_FALLBACK"], false),
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "D6_UNSAFE_CALENDAR_MONTH_NOT_FINAL");
});

test("open 01-03.09 preliminary daily window is eligible", () => {
  assert.equal(inclusiveIsoDayCount("2026-09-01", "2026-09-03"), 3);
  const decision = evaluateD1D5CorrectedBuildEligibility({
    dateFrom: "2026-09-01",
    dateTo: "2026-09-03",
    plan: plan(["PRELIMINARY_DAILY_FALLBACK"], false),
  });
  assert.equal(decision.eligible, true);
  assert.equal(decision.reason, "D1D5_V2_SAFE_PRELIMINARY_SHORT_DAILY_WINDOW");
});

test("D6_UNSAFE_HTTP: consumer does not HIT or enqueue V2 for unsafe range", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  let rebuilds = 0;
  const original = repository.requestRebuild?.bind(repository);
  repository.requestRebuild = async (params) => {
    rebuilds += 1;
    return original ? original(params) : "queued_local";
  };
  const loaded = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-01-01",
    dateTo: "2026-08-31",
    rebuildGate: async () => ({
      eligible: false,
      reason: "D6_UNSAFE_YTD_NOT_FINAL",
    }),
  });
  assert.equal(loaded.status, "UNAVAILABLE");
  assert.notEqual(loaded.status, "HIT");
  if (loaded.status === "UNAVAILABLE") {
    assert.equal(loaded.reason, "D6_UNSAFE_YTD_NOT_FINAL");
    assert.equal(
      loaded.formulaVersionExpected,
      FINANCIAL_CORE_V6_PERIOD_READMODEL_V2
    );
  }
  assert.equal(rebuilds, 0);
});

test("OLD_V1_CORRECTED_HIT=NO: V1 row is not served as V2 HIT", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  await persistPrecomputedV6DashboardBundle({
    repository,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    companyRows: [sampleCompany("ALL"), sampleCompany("ИП Петров")],
    dailyPoints: [],
    todayIso: "2026-09-04",
    v2SafetyAttestation: syntheticSafeV2Attestation(),
  });
  const v2 = await repository.findPeriod({
    companyScope: "ALL",
    marketplace: "ALL",
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
  });
  assert.ok(v2);
  await repository.upsertPeriod({
    ...v2!,
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V1,
    sourceFingerprint: "v1-forensic",
  });
  const v1Only = createMemoryV6PeriodReadModelRepository();
  await v1Only.upsertPeriod({
    ...v2!,
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V1,
  });
  const loaded = await loadDashboardV6PeriodReadModel({
    repository: v1Only,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
  });
  assert.notEqual(loaded.status, "HIT");
});

test("SAFE_WEEK_V2: corrected version can HIT from memory fixture", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  await persistPrecomputedV6DashboardBundle({
    repository,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    companyRows: [sampleCompany("ALL"), sampleCompany("ИП Петров")],
    dailyPoints: [],
    todayIso: "2026-09-04",
    v2SafetyAttestation: syntheticSafeV2Attestation(),
  });
  const loaded = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
  });
  assert.equal(loaded.status, "HIT");
  if (loaded.status === "HIT") {
    assert.equal(
      loaded.bundle.meta.formulaVersion,
      FINANCIAL_CORE_V6_PERIOD_READMODEL_V2
    );
  }
});

test("D6_UNSAFE_PRECOMPUTED_TEST: January/YTD persistPrecomputed is forbidden", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  await assert.rejects(
    () =>
      persistPrecomputedV6DashboardBundle({
        repository,
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
        companyRows: [sampleCompany("ALL")],
        dailyPoints: [],
        todayIso: "2026-09-04",
      }),
    /D1D5_V2_PERSIST_FORBIDDEN/
  );
  await assert.rejects(
    () =>
      persistPrecomputedV6DashboardBundle({
        repository,
        dateFrom: "2026-01-01",
        dateTo: "2026-09-04",
        companyRows: [sampleCompany("ALL")],
        dailyPoints: [],
        todayIso: "2026-09-04",
        v2SafetyAttestation: syntheticSafeV2Attestation(),
      }),
    /D1D5_V2_PERSIST_FORBIDDEN/
  );
  const jan = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-01-01",
    dateTo: "2026-01-31",
    rebuildGate: async () => ({
      eligible: false,
      reason: "D6_UNSAFE_WB_OWNERSHIP_MODE",
    }),
  });
  assert.notEqual(jan.status, "HIT");
});

test("D6_UNSAFE_DIRECT_UPSERT_TEST: V2 without attestation is rejected", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  await persistPrecomputedV6DashboardBundle({
    repository,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    companyRows: [sampleCompany("ALL")],
    dailyPoints: [],
    todayIso: "2026-09-04",
    v2SafetyAttestation: syntheticSafeV2Attestation(),
  });
  const v2 = await repository.findPeriod({
    companyScope: "ALL",
    marketplace: "ALL",
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
  });
  assert.ok(v2);
  await assert.rejects(
    () =>
      repository.upsertPeriod({
        ...v2!,
        sourceFingerprint: "no-proof",
        meta: { ...v2!.meta, v2SafetyAttestation: undefined },
      }),
    /D1D5_V2_PERSIST_FORBIDDEN/
  );
});

test("V2_HIT_WITHOUT_SAFE_PROOF=REJECTED: consumer refuses unattested V2", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  const untrusted = {
    companyScope: "ALL",
    marketplace: "ALL" as const,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
    dataMode: "FINAL" as const,
    coverageStatus: "COMPLETE" as const,
    sourceFingerprint: "no-proof",
    payloadChecksum: "no-proof",
    payload: sampleCompany("ALL"),
    meta: {
      formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
      coverageStatus: "COMPLETE" as const,
      dataMode: "FINAL" as const,
      generatedAt: new Date().toISOString(),
      sourceFingerprint: "no-proof",
      payloadChecksum: "no-proof",
      companyScope: "ALL",
      marketplace: "ALL" as const,
      dateFrom: "2026-08-17",
      dateTo: "2026-08-23",
      completeness: {
        orderDataLoadedDays: 1,
        orderDataExpectedDays: 1,
        issues: [],
      },
      invalidationKey: "x",
      staleAfterMs: null,
      closedDateAutoFinal: false as const,
      readinessIsFinal: true,
      readinessStatus: "complete" as const,
      weekPresentationStatus: "FINAL" as const,
      weekPresentationReason: null,
      wbSourceOwnershipFinal: true,
      wbTaxesUnavailable: false,
      ozonCoverageComplete: true,
      ozonQuarantineCount: 0,
      canonicalDataMode: "FINAL" as const,
    },
    generatedAt: new Date().toISOString(),
  };
  repository.findPeriod = async () => untrusted;
  const loaded = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
  });
  assert.equal(loaded.status, "UNAVAILABLE");
  if (loaded.status === "UNAVAILABLE") {
    assert.equal(loaded.reason, "V2_SAFETY_ATTESTATION_MISSING_OR_UNSAFE");
  }
});

const PETROV = "ИП Петров";
const LEBEDEVA = "ИП Лебедева";
const CLOSED_FROM = "2026-08-17";
const CLOSED_TO = "2026-08-23";

test("ATTESTATION_SCOPE_REPLAY=REJECTED: Petrov proof cannot persist Lebedeva", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  let writes = 0;
  const orig = repository.upsertPeriod.bind(repository);
  repository.upsertPeriod = async (row) => {
    writes += 1;
    return orig(row);
  };
  const petrovProof = syntheticSafeV2Attestation(
    "D1D5_V2_SAFE_FINANCIALLY_FINAL_COVER",
    { dateFrom: CLOSED_FROM, dateTo: CLOSED_TO, companyScope: PETROV }
  );
  await assert.rejects(
    () =>
      persistPrecomputedV6DashboardBundle({
        repository,
        dateFrom: CLOSED_FROM,
        dateTo: CLOSED_TO,
        companyRows: [sampleCompany(LEBEDEVA)],
        dailyPoints: [],
        todayIso: "2026-09-04",
        v2SafetyAttestation: petrovProof,
      }),
    /V2_SAFETY_ATTESTATION_ROW_IDENTITY_MISMATCH/
  );
  assert.equal(writes, 0);
});

test("ATTESTATION_RANGE_REPLAY=REJECTED: closed-week proof cannot persist another week", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  const weekProof = syntheticSafeV2Attestation(
    "D1D5_V2_SAFE_FINANCIALLY_FINAL_COVER",
    { dateFrom: CLOSED_FROM, dateTo: CLOSED_TO, companyScope: "ALL" }
  );
  await assert.rejects(
    () =>
      persistPrecomputedV6DashboardBundle({
        repository,
        dateFrom: "2026-08-10",
        dateTo: "2026-08-16",
        companyRows: [sampleCompany("ALL")],
        dailyPoints: [],
        todayIso: "2026-09-04",
        v2SafetyAttestation: weekProof,
      }),
    /V2_SAFETY_ATTESTATION_ROW_IDENTITY_MISMATCH/
  );
  await assert.rejects(
    () =>
      persistPrecomputedV6DashboardBundle({
        repository,
        dateFrom: "2026-01-01",
        dateTo: "2026-09-04",
        companyRows: [sampleCompany("ALL")],
        dailyPoints: [],
        todayIso: "2026-09-04",
        v2SafetyAttestation: weekProof,
      }),
    /D1D5_V2_PERSIST_FORBIDDEN/
  );
});

test("matching bound attestation persists and can HIT", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  await persistPrecomputedV6DashboardBundle({
    repository,
    dateFrom: CLOSED_FROM,
    dateTo: CLOSED_TO,
    companyRows: [sampleCompany("ALL")],
    dailyPoints: [],
    todayIso: "2026-09-04",
    v2SafetyAttestation: syntheticSafeV2Attestation(
      "D1D5_V2_SAFE_FINANCIALLY_FINAL_COVER",
      { dateFrom: CLOSED_FROM, dateTo: CLOSED_TO, companyScope: "ALL" }
    ),
  });
  const row = await repository.findPeriod({
    companyScope: "ALL",
    marketplace: "ALL",
    dateFrom: CLOSED_FROM,
    dateTo: CLOSED_TO,
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
  });
  assert.ok(row?.meta?.v2SafetyAttestation?.safetyPlanDigest);
  assert.equal(row?.meta?.v2SafetyAttestation?.companyScope, "ALL");
  assert.equal(row?.meta?.v2SafetyAttestation?.dateFrom, CLOSED_FROM);
  const loaded = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: CLOSED_FROM,
    dateTo: CLOSED_TO,
  });
  assert.equal(loaded.status, "HIT");
});

test("SCOPE_DIVERGENCE_GUARD_TEST: ALL-safe / Petrov-unsafe bundle is rejected", () => {
  const bundle = evaluateRequiredV2BundleEligibility({
    dateFrom: CLOSED_FROM,
    dateTo: CLOSED_TO,
    scopes: [
      {
        companyScope: "ALL",
        plan: plan(["EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS"], true),
      },
      {
        companyScope: PETROV,
        plan: plan(["PRELIMINARY_OPERATIONAL_FALLBACK"], false),
      },
      {
        companyScope: LEBEDEVA,
        plan: plan(["EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS"], true),
      },
    ],
  });
  assert.equal(bundle.eligible, false);
  assert.equal(bundle.failedScope, PETROV);
  assert.equal(bundle.reason, "D6_UNSAFE_WB_OWNERSHIP_MODE");
});

test("ALL_SAFE_COMPANY_UNSAFE_BUNDLE_REJECTED: zero partial V2 rows", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  let writes = 0;
  const origPeriod = repository.upsertPeriod.bind(repository);
  const origDaily = repository.upsertDaily.bind(repository);
  repository.upsertPeriod = async (row) => {
    writes += 1;
    return origPeriod(row);
  };
  repository.upsertDaily = async (row) => {
    writes += 1;
    return origDaily(row);
  };
  const allProof = syntheticSafeV2Attestation(
    "D1D5_V2_SAFE_FINANCIALLY_FINAL_COVER",
    { dateFrom: CLOSED_FROM, dateTo: CLOSED_TO, companyScope: "ALL" }
  );
  await assert.rejects(
    () =>
      persistPrecomputedV6DashboardBundle({
        repository,
        dateFrom: CLOSED_FROM,
        dateTo: CLOSED_TO,
        companyRows: [sampleCompany(PETROV), sampleCompany(LEBEDEVA)],
        dailyPoints: [
          {
            businessDate: CLOSED_FROM,
            wbRevenue: 1,
            ozonRevenue: 0,
            revenue: 1,
            adsCost: 0,
            drr: null,
            operatingProfitAfterTax: 1,
            netProfit: 1,
            cashFlowResult: 1,
            loanPayments: 0,
            creditPrincipal: 0,
            creditInterest: 0,
          },
        ],
        todayIso: "2026-09-04",
        v2SafetyAttestation: allProof,
      }),
    /V2_SAFETY_ATTESTATION_ROW_IDENTITY_MISMATCH/
  );
  assert.equal(writes, 0);
  assert.equal(
    await repository.findPeriod({
      companyScope: "ALL",
      marketplace: "ALL",
      dateFrom: CLOSED_FROM,
      dateTo: CLOSED_TO,
      formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
    }),
    null
  );
  assert.equal(
    await repository.findPeriod({
      companyScope: PETROV,
      marketplace: "ALL",
      dateFrom: CLOSED_FROM,
      dateTo: CLOSED_TO,
      formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
    }),
    null
  );
  assert.equal(
    await repository.findPeriod({
      companyScope: LEBEDEVA,
      marketplace: "ALL",
      dateFrom: CLOSED_FROM,
      dateTo: CLOSED_TO,
      formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
    }),
    null
  );
});

test("selected Petrov cannot HIT or enqueue from ALL-only proof", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  await persistPrecomputedV6DashboardBundle({
    repository,
    dateFrom: CLOSED_FROM,
    dateTo: CLOSED_TO,
    companyRows: [sampleCompany(LEBEDEVA)],
    dailyPoints: [],
    todayIso: "2026-09-04",
    v2SafetyAttestation: syntheticSafeV2Attestation(),
  });
  let rebuildScope: string | null = null;
  const original = repository.requestRebuild?.bind(repository);
  repository.requestRebuild = async (params) => {
    rebuildScope = params.companyScope;
    return original ? original(params) : "queued_local";
  };
  const loaded = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: CLOSED_FROM,
    dateTo: CLOSED_TO,
    companyScope: PETROV,
    rebuildGate: async () => ({
      eligible: false,
      reason: "D6_UNSAFE_WB_OWNERSHIP_MODE",
    }),
  });
  assert.notEqual(loaded.status, "HIT");
  assert.equal(loaded.status, "UNAVAILABLE");
  if (loaded.status === "UNAVAILABLE") {
    assert.equal(loaded.reason, "D6_UNSAFE_WB_OWNERSHIP_MODE");
  }
  assert.equal(rebuildScope, null);
});

async function withLiveEligibilityGate<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.V6_READMODEL_D1D5_ELIGIBILITY;
  process.env.V6_READMODEL_D1D5_ELIGIBILITY = "live";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.V6_READMODEL_D1D5_ELIGIBILITY;
    else process.env.V6_READMODEL_D1D5_ELIGIBILITY = previous;
  }
}

const LIVE_TEMPLATE = {
  strategy: "A_V2_BOUNDED_SAFE_PERIOD_ELIGIBILITY" as const,
  eligible: true as const,
  reason: "D1D5_V2_SAFE_FINANCIALLY_FINAL_COVER",
  source: "LIVE_ELIGIBILITY" as const,
};

test("SYNTHETIC_SAFE_WEEK_LIVE_PERSIST_REJECTED", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  await withLiveEligibilityGate(async () => {
    await assert.rejects(
      () =>
        persistPrecomputedV6DashboardBundle({
          repository,
          dateFrom: CLOSED_FROM,
          dateTo: CLOSED_TO,
          companyRows: [sampleCompany("ALL")],
          dailyPoints: [],
          todayIso: "2026-09-04",
          v2SafetyAttestation: syntheticSafeV2Attestation(),
        }),
      /V2_SYNTHETIC_ATTESTATION_FORBIDDEN_IN_LIVE_RUNTIME/
    );
  });
});

test("SYNTHETIC_15D_CUSTOM_LIVE_PERSIST_REJECTED", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  await withLiveEligibilityGate(async () => {
    await assert.rejects(
      () =>
        persistPrecomputedV6DashboardBundle({
          repository,
          dateFrom: "2026-08-01",
          dateTo: "2026-08-15",
          companyRows: [sampleCompany("ALL")],
          dailyPoints: [],
          todayIso: "2026-09-04",
          v2SafetyAttestation: syntheticSafeV2Attestation(),
        }),
      /V2_SYNTHETIC_ATTESTATION_FORBIDDEN_IN_LIVE_RUNTIME/
    );
  });
});

test("SYNTHETIC_YTD_LIVE_PERSIST_REJECTED", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  await withLiveEligibilityGate(async () => {
    await assert.rejects(
      () =>
        persistPrecomputedV6DashboardBundle({
          repository,
          dateFrom: "2026-01-01",
          dateTo: "2026-09-04",
          companyRows: [sampleCompany("ALL")],
          dailyPoints: [],
          todayIso: "2026-09-04",
          v2SafetyAttestation: syntheticSafeV2Attestation(),
        }),
      /V2_SYNTHETIC_ATTESTATION_FORBIDDEN_IN_LIVE_RUNTIME/
    );
  });
});

test("SYNTHETIC_LIVE_HIT_REJECTED: existing synthetic row is not HIT in live runtime", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  await persistPrecomputedV6DashboardBundle({
    repository,
    dateFrom: CLOSED_FROM,
    dateTo: CLOSED_TO,
    companyRows: [sampleCompany("ALL")],
    dailyPoints: [],
    todayIso: "2026-09-04",
    v2SafetyAttestation: syntheticSafeV2Attestation(),
  });
  await withLiveEligibilityGate(async () => {
    const loaded = await loadDashboardV6PeriodReadModel({
      repository,
      dateFrom: CLOSED_FROM,
      dateTo: CLOSED_TO,
      rebuildGate: async () => ({
        eligible: false,
        reason: "V2_SAFETY_ATTESTATION_MISSING_OR_UNSAFE",
      }),
    });
    assert.equal(loaded.status, "UNAVAILABLE");
    assert.notEqual(loaded.status, "HIT");
    if (loaded.status === "UNAVAILABLE") {
      assert.equal(loaded.reason, "V2_SAFETY_ATTESTATION_MISSING_OR_UNSAFE");
    }
  });
});

test("TEST_ONLY_SYNTHETIC_FIXTURE: memory mode may persist and HIT synthetic", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  await persistPrecomputedV6DashboardBundle({
    repository,
    dateFrom: "2026-08-01",
    dateTo: "2026-08-15",
    companyRows: [sampleCompany("ALL")],
    dailyPoints: [],
    todayIso: "2026-09-04",
    dataMode: "FINAL",
    v2SafetyAttestation: syntheticSafeV2Attestation(),
  });
  const loaded = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-08-01",
    dateTo: "2026-08-15",
  });
  assert.equal(loaded.status, "HIT");
});

test("LIVE_PRODUCER_ATTESTATION_SOURCE=LIVE_ELIGIBILITY persists and HITs in live runtime", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  const live = liveV2SafetyAttestation({
    reason: "D1D5_V2_SAFE_FINANCIALLY_FINAL_COVER",
    dateFrom: CLOSED_FROM,
    dateTo: CLOSED_TO,
    companyScope: "ALL",
    planEvidence: {
      dateFrom: CLOSED_FROM,
      dateTo: CLOSED_TO,
      companyScope: "ALL",
      isFinanciallyFinal: true,
      selectedSessionIds: ["s1"],
      intervals: [
        {
          companyName: "ALL",
          dateFrom: CLOSED_FROM,
          dateTo: CLOSED_TO,
          mode: "EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS",
          selectedSessionIds: ["s1"],
          exactCoverageComplete: true,
          dailyCalendarCoverageComplete: true,
          dailyReportCoverageComplete: true,
          isFinanciallyFinal: true,
        },
      ],
    },
  });
  assert.equal(live.source, "LIVE_ELIGIBILITY");
  await withLiveEligibilityGate(async () => {
    await persistPrecomputedV6DashboardBundle({
      repository,
      dateFrom: CLOSED_FROM,
      dateTo: CLOSED_TO,
      companyRows: [sampleCompany("ALL")],
      dailyPoints: [],
      todayIso: "2026-09-04",
      v2SafetyAttestation: live,
    });
    const row = await repository.findPeriod({
      companyScope: "ALL",
      marketplace: "ALL",
      dateFrom: CLOSED_FROM,
      dateTo: CLOSED_TO,
      formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
    });
    assert.equal(row?.meta?.v2SafetyAttestation?.source, "LIVE_ELIGIBILITY");
    const loaded = await loadDashboardV6PeriodReadModel({
      repository,
      dateFrom: CLOSED_FROM,
      dateTo: CLOSED_TO,
    });
    assert.equal(loaded.status, "HIT");
  });
});

test("LIVE_ELIGIBILITY target 01-03.09 ALL/Petrov/Lebedeva in live runtime", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  await withLiveEligibilityGate(async () => {
    await persistPrecomputedV6DashboardBundle({
      repository,
      dateFrom: "2026-09-01",
      dateTo: "2026-09-03",
      companyRows: [sampleCompany(PETROV), sampleCompany(LEBEDEVA)],
      dailyPoints: [],
      todayIso: "2026-09-04",
      v2SafetyAttestation: {
        ...LIVE_TEMPLATE,
        reason: "D1D5_V2_SAFE_PRELIMINARY_SHORT_DAILY_WINDOW",
      },
    });
    for (const scope of ["ALL", PETROV, LEBEDEVA]) {
      const row = await repository.findPeriod({
        companyScope: scope,
        marketplace: "ALL",
        dateFrom: "2026-09-01",
        dateTo: "2026-09-03",
        formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
      });
      assert.equal(row?.meta?.v2SafetyAttestation?.source, "LIVE_ELIGIBILITY");
      assert.equal(row?.meta?.v2SafetyAttestation?.companyScope, scope);
    }
  });
});
