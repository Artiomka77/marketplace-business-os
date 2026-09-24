import assert from "node:assert/strict";
import test from "node:test";

import {
  createMemoryV6PeriodReadModelRepository,
  loadDashboardV6PeriodReadModel,
  persistPrecomputedV6DashboardBundle,
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
  syntheticSafeV2Attestation,
  type PeriodCompanyMarketplaceMetricsPayload,
  type DailyCompanyMarketplaceMetricsPayload,
} from "../../lib/dashboard/v6PeriodReadModel";
import { runV6QueueWorkerLoop } from "../dashboard/runV6PeriodReadModelWorker";

function company(
  name: string,
  opts: Partial<PeriodCompanyMarketplaceMetricsPayload> = {}
): PeriodCompanyMarketplaceMetricsPayload {
  return {
    companyName: name,
    ordersQty: 1,
    ordersAmount: 100,
    orderDataLoadedDays: 7,
    orderDataExpectedDays: 7,
    wbRevenue: 100,
    ozonRevenue: 0,
    totalRevenue: 100,
    operatingProfitAfterTax: 20,
    netProfit: 15,
    profitAfterOwnerWithdrawal: 10,
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
    ...opts,
  };
}

function daily(date: string): DailyCompanyMarketplaceMetricsPayload {
  return {
    businessDate: date,
    wbRevenue: 100,
    ozonRevenue: 0,
    revenue: 100,
    adsCost: 0,
    drr: null,
    operatingProfitAfterTax: 20,
    netProfit: 15,
    cashFlowResult: 0,
    loanPayments: 0,
    creditPrincipal: 0,
    creditInterest: 0,
  };
}

test("local daemon lifecycle: idle then late enqueue consumed without restart", async () => {
  const repository = createMemoryV6PeriodReadModelRepository();
  const pending: Array<{
    id: string;
    companyScope: string;
    dateFrom: Date;
    dateTo: Date;
    attempts: number;
    maxAttempts: number;
  }> = [];
  let idlePolls = 0;
  let stop = false;

  // Worker already running / idle before any job exists.
  const worker = runV6QueueWorkerLoop({
    pollMs: 1000,
    maxJobs: 1,
    shouldStop: () => stop,
    sleep: async () => {
      idlePolls += 1;
      // After two idle polls, enqueue a rebuild request (Dashboard MISS path).
      if (idlePolls === 2) {
        pending.push({
          id: "late-job",
          companyScope: "ALL",
          dateFrom: new Date("2026-08-17T00:00:00.000Z"),
          dateTo: new Date("2026-08-23T00:00:00.000Z"),
          attempts: 0,
          maxAttempts: 3,
        });
      }
    },
    claimNext: async () => pending.shift() ?? null,
    processJob: async () => {
      await persistPrecomputedV6DashboardBundle({
        repository,
        dateFrom: "2026-08-17",
        dateTo: "2026-08-23",
        companyRows: [company("ИП Петров"), company("ИП Лебедева")],
        dailyPoints: [daily("2026-08-17")],
        dataMode: "FINAL",
        coverageStatus: "COMPLETE",
        readinessIsFinal: true,
        readinessStatus: "complete",
        issues: [],
        todayIso: "2026-09-02",
        v2SafetyAttestation: syntheticSafeV2Attestation(),
      });
      stop = true;
    },
  });

  // Prove MISS before worker finishes.
  const miss = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
  });
  assert.equal(miss.status, "PENDING");
  assert.equal(miss.sourceMarker, "READ_MODEL_MISS");

  await worker;
  assert.ok(idlePolls >= 2);

  const hit = await loadDashboardV6PeriodReadModel({
    repository,
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
  });
  assert.equal(hit.status, "HIT");
  if (hit.status === "HIT") {
    assert.equal(hit.bundle.sourceMarker, "READ_MODEL");
    assert.equal(hit.bundle.meta.formulaVersion, FINANCIAL_CORE_V6_PERIOD_READMODEL_V2);
  }
});
