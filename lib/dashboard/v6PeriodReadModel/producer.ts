import type { DashboardDailyPoint } from "@/lib/analytics/dashboardDailyAnalytics";
import { sequentialAll } from "@/lib/db/sequentialAll";
import { getDashboardDailyAnalytics } from "@/lib/analytics/dashboardDailyAnalytics";
import { getProfitAnalytics } from "@/lib/analytics/profitAnalytics";
import { marketplaceManagementRevenue } from "@/lib/dashboard/managementRevenue";

function sumOrNull<T extends Record<string, unknown>>(
  rows: T[],
  key: keyof T
): number | null {
  let sum = 0;
  for (const row of rows) {
    const value = row[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    sum += value;
  }
  return sum;
}
import { calculateFinanceMetricsForRows } from "@/lib/finance/financeMetrics";
import { prisma } from "@/lib/prisma";
import { buildDailyReport } from "@/lib/telegram/dailyReport";

import {
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V1,
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
  type DailyCompanyMarketplaceMetricsPayload,
  type PeriodCompanyMarketplaceMetricsPayload,
  type ReadinessFinalityMeta,
  type V6CoverageStatus,
  type V6DataMode,
} from "./contract";
import {
  D1D5V2BuildForbiddenError,
  resolveD1D5CorrectedBuildEligibility,
} from "./d1d5Eligibility";
import {
  assertPersistableV2SafetyAttestation,
  liveV2SafetyAttestation,
  type V2SafetyAttestation,
  type V2SafetyAttestationTemplate,
} from "./v2SafetyAttestation";
import {
  readDirectSourceOwnershipFinal,
  readDirectTaxesUnavailable,
  resolveV6ReadModelFinality,
  type DirectFinalitySignals,
  type V6FinalityResolution,
} from "./finality";
import {
  buildInvalidationKey,
  buildSourceFingerprint,
  checksumJson,
  isoDateOnly,
  resolveDataMode,
} from "./fingerprint";
import type { V6PeriodReadModelRepository } from "./repository";

function startOfDay(value: string) {
  return new Date(`${isoDateOnly(value)}T00:00:00.000Z`);
}

function nextDayStart(value: string) {
  const date = startOfDay(value);
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

async function getFinanceCashResult(params: {
  companyName: string;
  dateFrom: string;
  dateTo: string;
}) {
  const from = startOfDay(params.dateFrom);
  const toExclusive = nextDayStart(params.dateTo);

  const [rows, categories] = await sequentialAll([
    async () => (prisma.financeTransaction.findMany({
      where: {
        companyName: params.companyName,
        transactionStatus: "FACT",
        operationDate: {
          gte: from,
          lt: toExclusive,
        },
      },
    })),
    async () => (prisma.financeCategory.findMany({
      select: {
        name: true,
        categoryType: true,
        parentName: true,
        profitTreatment: true,
      },
    })),
  ]);

  const metrics = calculateFinanceMetricsForRows({
    transactions: rows,
    categories,
  });

  return {
    cashFlowResult: metrics.netCashFlow,
    loanPayments: metrics.creditPrincipal + metrics.creditInterest,
    creditPrincipal: metrics.creditPrincipal,
    creditInterest: metrics.creditInterest,
    personalExpenses: metrics.ownerWithdrawals,
    financialExpenses: metrics.creditInterest,
    cashOnlyExpenses: metrics.cashOnlyTotal,
    netProfitIncludedIncome: metrics.netProfitIncome,
    netProfitIncludedExpenses: metrics.netProfitExpense,
  };
}

function companyReportHasAnyDashboardMetric(
  companyReport:
    | Awaited<ReturnType<typeof buildDailyReport>>["companies"][number]
    | undefined
) {
  if (!companyReport) return false;

  return (
    companyReport.wb.ordersQty !== 0 ||
    companyReport.wb.ordersAmount !== 0 ||
    companyReport.wb.salesQty !== 0 ||
    companyReport.wb.salesAmount !== 0 ||
    (companyReport.wb.economicTurnover ?? 0) !== 0 ||
    companyReport.wb.adSpend !== 0 ||
    companyReport.wb.stockQty !== 0 ||
    companyReport.wb.netProfitAfterTax !== 0 ||
    companyReport.ozon.ordersQty !== 0 ||
    companyReport.ozon.ordersAmount !== 0 ||
    companyReport.ozon.salesQty !== 0 ||
    companyReport.ozon.salesAmount !== 0 ||
    companyReport.ozon.adSpend !== 0 ||
    companyReport.ozon.stockQty !== 0 ||
    companyReport.ozon.netProfitAfterTax !== 0 ||
    companyReport.finance.cashIncome !== 0 ||
    companyReport.finance.cashOutflow !== 0 ||
    companyReport.finance.netCashFlow !== 0 ||
    companyReport.finance.netProfitImpact !== 0 ||
    companyReport.finance.ownerWithdrawals !== 0
  );
}

async function readWbDirectFinalitySignals(params: {
  companyName: string;
  dateFrom: string;
  dateTo: string;
}): Promise<{
  sourceOwnershipFinal: boolean | null;
  taxesUnavailable: boolean | null;
}> {
  try {
    const analytics = await getProfitAnalytics({
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      companyName: params.companyName,
    });
    return {
      sourceOwnershipFinal: readDirectSourceOwnershipFinal(analytics.totals),
      taxesUnavailable: readDirectTaxesUnavailable(analytics.totals),
    };
  } catch {
    // Fail-closed: missing analytics must not invent FINAL ownership.
    return { sourceOwnershipFinal: false, taxesUnavailable: null };
  }
}

function resolveOzonCoverageComplete(ozon: {
  taxRevenueCoverageComplete?: boolean;
  discountPointsCoverageComplete?: boolean;
  taxesEstimated?: boolean;
  netProfitStatus?: "FINAL" | "PRELIMINARY";
}): boolean {
  if (ozon.taxesEstimated === true) return false;
  if (ozon.taxRevenueCoverageComplete === false) return false;
  if (ozon.discountPointsCoverageComplete === false) return false;
  if (ozon.netProfitStatus === "PRELIMINARY") return false;
  return true;
}

type OzonQuarantineCountSource = {
  /**
   * Canonical Loans V4 / Dashboard quarantine count.
   * In this workspace type definitions may be stripped, so we read it via
   * a narrow structural type.
   */
  ozonQuarantineCount?: number;
};

/**
 * Read quarantine count from the canonical buildDailyReport company report.
 * Must NOT substitute a derived planner-based value.
 */
export function readOzonQuarantineCountFromCompanyReport(ozon: unknown): number {
  return (ozon as OzonQuarantineCountSource | null | undefined)?.ozonQuarantineCount ?? 0;
}

function buildMetaFromFinality(params: {
  companyScope: string;
  dateFrom: string;
  dateTo: string;
  generatedAt: string;
  companyRows: PeriodCompanyMarketplaceMetricsPayload[];
  dailyPoints: DailyCompanyMarketplaceMetricsPayload[];
  dataMode: V6DataMode;
  coverageStatus: V6CoverageStatus;
  finality: V6FinalityResolution;
  sourceFingerprint: string;
  payloadChecksum: string;
  v2SafetyAttestation: V2SafetyAttestation;
}): ReadinessFinalityMeta {
  return {
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
    coverageStatus: params.coverageStatus,
    dataMode: params.dataMode,
    generatedAt: params.generatedAt,
    sourceFingerprint: params.sourceFingerprint,
    payloadChecksum: params.payloadChecksum,
    companyScope: params.companyScope,
    marketplace: "ALL",
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    completeness: {
      orderDataLoadedDays: params.companyRows.reduce(
        (s, r) => s + r.orderDataLoadedDays,
        0
      ),
      orderDataExpectedDays: params.companyRows.reduce(
        (s, r) => s + r.orderDataExpectedDays,
        0
      ),
      issues: params.finality.issues,
    },
    invalidationKey: buildInvalidationKey({
      companyScope: params.companyScope,
      marketplace: "ALL",
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    }),
    staleAfterMs: params.dataMode === "PRELIMINARY" ? 30 * 60 * 1000 : null,
    closedDateAutoFinal: false,
    readinessIsFinal: params.finality.readiness.isFinal,
    readinessStatus: params.finality.readiness.status,
    weekPresentationStatus: params.finality.weekPresentation.status,
    weekPresentationReason: params.finality.weekPresentation.reason,
    wbSourceOwnershipFinal: params.finality.direct.wbSourceOwnershipFinal,
    wbTaxesUnavailable: params.finality.direct.wbTaxesUnavailable,
    ozonCoverageComplete: params.finality.direct.ozonCoverageComplete,
    ozonQuarantineCount: params.finality.direct.ozonQuarantineCount,
    canonicalDataMode: params.finality.direct.canonicalDataMode,
    v2SafetyAttestation: params.v2SafetyAttestation,
  };
}

/**
 * Heavy producer path — worker/canary only. Must never run on ordinary Dashboard HTTP.
 */
export async function buildV6DashboardPeriodCompanyRows(params: {
  dateFrom: string;
  dateTo: string;
}): Promise<PeriodCompanyMarketplaceMetricsPayload[]> {
  const companies = await prisma.company.findMany({
    orderBy: { name: "asc" },
  });

  const ownerReport = await buildDailyReport({
    from: params.dateFrom,
    to: params.dateTo,
    skipComparison: true,
  });

  const reportByCompanyName = new Map(
    ownerReport.companies.map((companyReport) => [
      companyReport.companyName,
      companyReport,
    ])
  );

  const rows: PeriodCompanyMarketplaceMetricsPayload[] = [];

  for (const company of companies) {
    const companyReport = reportByCompanyName.get(company.name);
    if (!companyReportHasAnyDashboardMetric(companyReport)) continue;

    const cash = await getFinanceCashResult({
      companyName: company.name,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    });

    const ordersQty =
      (companyReport?.wb.ordersQty ?? 0) + (companyReport?.ozon.ordersQty ?? 0);
    const ordersAmount =
      (companyReport?.wb.ordersAmount ?? 0) +
      (companyReport?.ozon.ordersAmount ?? 0);
    const orderDataLoadedDays =
      (companyReport?.wb.orderDataLoadedDays ?? 0) +
      (companyReport?.ozon.orderDataLoadedDays ?? 0);
    const orderDataExpectedDays =
      (companyReport?.wb.orderDataExpectedDays ?? 0) +
      (companyReport?.ozon.orderDataExpectedDays ?? 0);

    const wbRevenue = marketplaceManagementRevenue(companyReport?.wb);
    const wbNetProfitAfterTax = companyReport?.wb.netProfitAfterTax ?? 0;
    const wbAdsCost = companyReport?.wb.adSpend ?? 0;
    const ozonRevenue = marketplaceManagementRevenue(companyReport?.ozon);
    const ozonNetProfitAfterTax = companyReport?.ozon.netProfitAfterTax ?? 0;
    const ozonAdsCost = companyReport?.ozon.adSpend ?? 0;
    const totalRevenue =
      wbRevenue == null || ozonRevenue == null ? null : wbRevenue + ozonRevenue;
    const marketplaceFinancialPartial =
      companyReport?.wb.financialUnavailable === true ||
      companyReport?.ozon.financialUnavailable === true;
    const operatingProfitAfterTax = marketplaceFinancialPartial
      ? null
      : wbNetProfitAfterTax + ozonNetProfitAfterTax;
    const netProfit =
      operatingProfitAfterTax == null
        ? null
        : operatingProfitAfterTax +
          cash.netProfitIncludedIncome -
          cash.netProfitIncludedExpenses;
    const personalExpenses = cash.personalExpenses;
    const profitAfterOwnerWithdrawal =
      netProfit == null ? null : netProfit - personalExpenses;
    const adsCost = wbAdsCost + ozonAdsCost;

    const wbDirect = await readWbDirectFinalitySignals({
      companyName: company.name,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    });
    const ozonCoverageComplete = resolveOzonCoverageComplete({
      taxRevenueCoverageComplete: companyReport?.ozon.taxRevenueCoverageComplete,
      discountPointsCoverageComplete:
        companyReport?.ozon.discountPointsCoverageComplete,
      taxesEstimated: companyReport?.ozon.taxesEstimated,
      netProfitStatus: companyReport?.ozon.netProfitStatus,
    });
    const ozonQuarantineCount = readOzonQuarantineCountFromCompanyReport(
      companyReport?.ozon
    );
    const wbNetProfitStatus = companyReport?.wb.netProfitStatus;
    const ozonNetProfitStatus = companyReport?.ozon.netProfitStatus;
    const ozonTaxesEstimated = companyReport?.ozon.taxesEstimated === true;
    const combinedDataMode: "FINAL" | "PRELIMINARY" | undefined = (() => {
      if (
        wbDirect.sourceOwnershipFinal === false ||
        wbDirect.taxesUnavailable === true ||
        wbNetProfitStatus === "PRELIMINARY" ||
        ozonNetProfitStatus === "PRELIMINARY" ||
        ozonTaxesEstimated ||
        !ozonCoverageComplete ||
        ozonQuarantineCount > 0
      ) {
        return "PRELIMINARY";
      }
      if (wbNetProfitStatus === "FINAL" || ozonNetProfitStatus === "FINAL") {
        return "FINAL";
      }
      return undefined;
    })();

    rows.push({
      companyName: company.name,
      ordersQty,
      ordersAmount,
      orderDataLoadedDays,
      orderDataExpectedDays,
      wbRevenue,
      ozonRevenue,
      totalRevenue,
      operatingProfitAfterTax,
      netProfit,
      profitAfterOwnerWithdrawal,
      cashFlowResult: cash.cashFlowResult,
      adsCost,
      wbAdsCost,
      ozonAdsCost,
      drr:
        totalRevenue != null && totalRevenue > 0
          ? (adsCost / totalRevenue) * 100
          : null,
      drrByOrders: ordersAmount > 0 ? (adsCost / ordersAmount) * 100 : null,
      loanPayments: cash.loanPayments,
      creditPrincipal: cash.creditPrincipal,
      creditInterest: cash.creditInterest,
      personalExpenses,
      financialExpenses: cash.financialExpenses,
      cashOnlyExpenses: cash.cashOnlyExpenses,
      wbStockQty: companyReport?.wb.stockQty ?? 0,
      ozonStockQty: companyReport?.ozon.stockQty ?? 0,
      warehouseStockQty: 0,
      wbAbcA: 0,
      wbAbcB: 0,
      wbAbcC: 0,
      ozonAbcA: 0,
      ozonAbcB: 0,
      ozonAbcC: 0,
      wbNetProfitStatus,
      wbSourceOwnershipFinal: wbDirect.sourceOwnershipFinal === true,
      wbTaxesUnavailable: wbDirect.taxesUnavailable === true,
      ozonNetProfitStatus,
      ozonTaxesEstimated,
      ozonCoverageComplete,
      ozonQuarantineCount,
      combinedDataMode,
    });
  }

  return rows;
}

export async function buildV6DashboardDailyPoints(params: {
  dateFrom: string;
  dateTo: string;
  companyName?: string | null;
  expectedFromRows?: PeriodCompanyMarketplaceMetricsPayload[];
}): Promise<DailyCompanyMarketplaceMetricsPayload[]> {
  const expectedWb = params.expectedFromRows
    ? sumOrNull(params.expectedFromRows, "wbRevenue")
    : null;
  const expectedOzon = params.expectedFromRows
    ? sumOrNull(params.expectedFromRows, "ozonRevenue")
    : null;
  const expectedRevenue = params.expectedFromRows
    ? sumOrNull(params.expectedFromRows, "totalRevenue")
    : null;
  const expectedOperating = params.expectedFromRows
    ? sumOrNull(params.expectedFromRows, "operatingProfitAfterTax")
    : null;
  const expectedNet = params.expectedFromRows
    ? sumOrNull(params.expectedFromRows, "netProfit")
    : null;
  const expectedTotals =
    params.expectedFromRows &&
    expectedWb != null &&
    expectedOzon != null &&
    expectedRevenue != null &&
    expectedOperating != null &&
    expectedNet != null
    ? {
        wbRevenue: expectedWb,
        ozonRevenue: expectedOzon,
        revenue: expectedRevenue,
        adsCost: params.expectedFromRows.reduce((s, r) => s + r.adsCost, 0),
        operatingProfitAfterTax: expectedOperating,
        netProfit: expectedNet,
        cashFlowResult: params.expectedFromRows.reduce(
          (s, r) => s + r.cashFlowResult,
          0
        ),
        loanPayments: params.expectedFromRows.reduce((s, r) => s + r.loanPayments, 0),
        creditPrincipal: params.expectedFromRows.reduce(
          (s, r) => s + r.creditPrincipal,
          0
        ),
        creditInterest: params.expectedFromRows.reduce(
          (s, r) => s + r.creditInterest,
          0
        ),
      }
    : undefined;

  const points: DashboardDailyPoint[] = await getDashboardDailyAnalytics({
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    companyName: params.companyName ?? null,
    expectedTotals,
  });

  return points.map((point) => ({
    businessDate: point.date,
    wbRevenue: point.wbRevenue,
    ozonRevenue: point.ozonRevenue,
    revenue: point.revenue,
    adsCost: point.adsCost,
    drr: point.drr,
    operatingProfitAfterTax: point.operatingProfitAfterTax,
    netProfit: point.netProfit,
    cashFlowResult: point.cashFlowResult,
    loanPayments: point.loanPayments,
    creditPrincipal: point.creditPrincipal,
    creditInterest: point.creditInterest,
  }));
}

export async function produceV6DashboardPeriodReadModel(params: {
  repository: V6PeriodReadModelRepository;
  dateFrom: string;
  dateTo: string;
  companyScope?: string;
  todayIso?: string;
}): Promise<{
  meta: ReadinessFinalityMeta;
  companyRows: PeriodCompanyMarketplaceMetricsPayload[];
  dailyPoints: DailyCompanyMarketplaceMetricsPayload[];
}> {
  const companyScope = params.companyScope ?? "ALL";
  const dateFrom = isoDateOnly(params.dateFrom);
  const dateTo = isoDateOnly(params.dateTo);
  const generatedAt = new Date().toISOString();

  const allEligibility = await resolveD1D5CorrectedBuildEligibility({
    dateFrom,
    dateTo,
    companyName: null,
  });
  if (!allEligibility.eligible) {
    throw new D1D5V2BuildForbiddenError(allEligibility.reason);
  }
  void FINANCIAL_CORE_V6_PERIOD_READMODEL_V1;

  const companyRows = await buildV6DashboardPeriodCompanyRows({
    dateFrom,
    dateTo,
  });

  const persistScopes = [
    "ALL",
    ...[...new Set(companyRows.map((row) => row.companyName))],
  ];
  const attestations = new Map<string, V2SafetyAttestation>();
  attestations.set(
    "ALL",
    liveV2SafetyAttestation({
      reason: allEligibility.reason,
      dateFrom,
      dateTo,
      companyScope: "ALL",
      planEvidence: allEligibility.planEvidence,
    })
  );
  for (const scope of persistScopes) {
    if (scope === "ALL") continue;
    const eligibility = await resolveD1D5CorrectedBuildEligibility({
      dateFrom,
      dateTo,
      companyName: scope,
    });
    if (!eligibility.eligible) {
      throw new D1D5V2BuildForbiddenError(`${eligibility.reason}:SCOPE:${scope}`);
    }
    attestations.set(
      scope,
      liveV2SafetyAttestation({
        reason: eligibility.reason,
        dateFrom,
        dateTo,
        companyScope: scope,
        planEvidence: eligibility.planEvidence,
      })
    );
  }
  const v2SafetyAttestation = attestations.get("ALL")!;
  // One producer run always covers ALL + each company for period + daily grains.
  // Optional companyScope only selects which meta/dailyPoints are returned to the caller.
  const allDailyPoints = await buildV6DashboardDailyPoints({
    dateFrom,
    dateTo,
    companyName: null,
    expectedFromRows: companyRows,
  });

  const dailyByCompany = new Map<string, DailyCompanyMarketplaceMetricsPayload[]>();
  for (const row of companyRows) {
    dailyByCompany.set(
      row.companyName,
      await buildV6DashboardDailyPoints({
        dateFrom,
        dateTo,
        companyName: row.companyName,
        expectedFromRows: [row],
      })
    );
  }

  const scopedRows =
    companyScope === "ALL"
      ? companyRows
      : companyRows.filter((row) => row.companyName === companyScope);
  const dailyPoints =
    companyScope === "ALL"
      ? allDailyPoints
      : (dailyByCompany.get(companyScope) ?? []);

  function directFromRow(
    row: PeriodCompanyMarketplaceMetricsPayload
  ): DirectFinalitySignals {
    return {
      wbSourceOwnershipFinal: row.wbSourceOwnershipFinal ?? null,
      wbTaxesUnavailable: row.wbTaxesUnavailable ?? null,
      ozonCoverageComplete: row.ozonCoverageComplete ?? null,
      ozonQuarantineCount: row.ozonQuarantineCount ?? 0,
      canonicalDataMode: row.combinedDataMode ?? null,
    };
  }

  function aggregateDirect(
    rows: PeriodCompanyMarketplaceMetricsPayload[]
  ): DirectFinalitySignals {
    if (rows.length === 0) {
      return {
        wbSourceOwnershipFinal: null,
        wbTaxesUnavailable: null,
        ozonCoverageComplete: null,
        ozonQuarantineCount: 0,
        canonicalDataMode: null,
      };
    }
    const ownership = rows.map((r) => r.wbSourceOwnershipFinal === true);
    const taxesUnavailable = rows.some((r) => r.wbTaxesUnavailable === true);
    const ozonCoverage = rows.every((r) => r.ozonCoverageComplete !== false);
    const quarantine = rows.reduce(
      (s, r) => s + (r.ozonQuarantineCount ?? 0),
      0
    );
    const anyPreliminary = rows.some(
      (r) =>
        r.combinedDataMode === "PRELIMINARY" ||
        r.wbNetProfitStatus === "PRELIMINARY" ||
        r.ozonNetProfitStatus === "PRELIMINARY" ||
        r.ozonTaxesEstimated === true ||
        r.wbSourceOwnershipFinal === false ||
        r.wbTaxesUnavailable === true
    );
    return {
      wbSourceOwnershipFinal: ownership.every(Boolean),
      wbTaxesUnavailable: taxesUnavailable,
      ozonCoverageComplete: ozonCoverage,
      ozonQuarantineCount: quarantine,
      canonicalDataMode: anyPreliminary ? "PRELIMINARY" : "FINAL",
    };
  }

  const allDirect = aggregateDirect(companyRows);
  const allFinality = await resolveV6ReadModelFinality({
    dateFrom,
    dateTo,
    todayIso: params.todayIso,
    companyName: null,
    hasUsablePayload: companyRows.length > 0,
    direct: allDirect,
  });
  const dataMode: V6DataMode = allFinality.dataMode;
  const coverageStatus: V6CoverageStatus = allFinality.coverageStatus;

  const sourceFingerprint = buildSourceFingerprint({
    companyScope: "ALL",
    dateFrom,
    dateTo,
    companyRows,
    dailyPoints: allDailyPoints,
    dataMode,
  });

  const meta = buildMetaFromFinality({
    companyScope: "ALL",
    dateFrom,
    dateTo,
    generatedAt,
    companyRows,
    dailyPoints: allDailyPoints,
    dataMode,
    coverageStatus,
    finality: allFinality,
    sourceFingerprint,
    payloadChecksum: checksumJson({ companyRows, dailyPoints: allDailyPoints }),
    v2SafetyAttestation,
  });

  // Persist each company with independently computed finality/readiness meta.
  for (const row of companyRows) {
    const companyFinality = await resolveV6ReadModelFinality({
      dateFrom,
      dateTo,
      todayIso: params.todayIso,
      companyName: row.companyName,
      hasUsablePayload: true,
      direct: directFromRow(row),
    });
    const companyDataMode: V6DataMode = companyFinality.dataMode;
    const rowFingerprint = checksumJson(row);
    const companyMeta = buildMetaFromFinality({
      companyScope: row.companyName,
      dateFrom,
      dateTo,
      generatedAt,
      companyRows: [row],
      dailyPoints: dailyByCompany.get(row.companyName) ?? [],
      dataMode: companyDataMode,
      coverageStatus: companyFinality.coverageStatus,
      finality: companyFinality,
      sourceFingerprint: rowFingerprint,
      payloadChecksum: rowFingerprint,
      v2SafetyAttestation: attestations.get(row.companyName) ?? v2SafetyAttestation,
    });
    await params.repository.upsertPeriod({
      companyScope: row.companyName,
      marketplace: "ALL",
      dateFrom,
      dateTo,
      formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
      dataMode: companyDataMode,
      coverageStatus: companyFinality.coverageStatus,
      sourceFingerprint: rowFingerprint,
      payloadChecksum: rowFingerprint,
      payload: row,
      meta: companyMeta,
      generatedAt,
    });
  }

  // ALL aggregate period row carries the dashboard bundle identity.
  await params.repository.upsertPeriod({
    companyScope: "ALL",
    marketplace: "ALL",
    dateFrom,
    dateTo,
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
    dataMode,
    coverageStatus,
    sourceFingerprint,
    payloadChecksum: meta.payloadChecksum,
    payload: {
      companyName: "ALL",
      ordersQty: companyRows.reduce((s, r) => s + r.ordersQty, 0),
      ordersAmount: companyRows.reduce((s, r) => s + r.ordersAmount, 0),
      orderDataLoadedDays: meta.completeness.orderDataLoadedDays,
      orderDataExpectedDays: meta.completeness.orderDataExpectedDays,
      wbRevenue: sumOrNull(companyRows, "wbRevenue"),
      ozonRevenue: sumOrNull(companyRows, "ozonRevenue"),
      totalRevenue: sumOrNull(companyRows, "totalRevenue"),
      operatingProfitAfterTax: sumOrNull(companyRows, "operatingProfitAfterTax"),
      netProfit: sumOrNull(companyRows, "netProfit"),
      profitAfterOwnerWithdrawal: sumOrNull(
        companyRows,
        "profitAfterOwnerWithdrawal"
      ),
      cashFlowResult: companyRows.reduce((s, r) => s + r.cashFlowResult, 0),
      adsCost: companyRows.reduce((s, r) => s + r.adsCost, 0),
      wbAdsCost: companyRows.reduce((s, r) => s + r.wbAdsCost, 0),
      ozonAdsCost: companyRows.reduce((s, r) => s + r.ozonAdsCost, 0),
      drr: null,
      drrByOrders: null,
      loanPayments: companyRows.reduce((s, r) => s + r.loanPayments, 0),
      creditPrincipal: companyRows.reduce((s, r) => s + r.creditPrincipal, 0),
      creditInterest: companyRows.reduce((s, r) => s + r.creditInterest, 0),
      personalExpenses: companyRows.reduce((s, r) => s + r.personalExpenses, 0),
      financialExpenses: companyRows.reduce((s, r) => s + r.financialExpenses, 0),
      cashOnlyExpenses: companyRows.reduce((s, r) => s + r.cashOnlyExpenses, 0),
      wbStockQty: companyRows.reduce((s, r) => s + r.wbStockQty, 0),
      ozonStockQty: companyRows.reduce((s, r) => s + r.ozonStockQty, 0),
      warehouseStockQty: companyRows.reduce((s, r) => s + r.warehouseStockQty, 0),
      wbAbcA: 0,
      wbAbcB: 0,
      wbAbcC: 0,
      ozonAbcA: 0,
      ozonAbcB: 0,
      ozonAbcC: 0,
      wbSourceOwnershipFinal: allDirect.wbSourceOwnershipFinal === true,
      wbTaxesUnavailable: allDirect.wbTaxesUnavailable === true,
      ozonCoverageComplete: allDirect.ozonCoverageComplete !== false,
      ozonQuarantineCount: allDirect.ozonQuarantineCount ?? 0,
      combinedDataMode: allDirect.canonicalDataMode ?? undefined,
    },
    meta,
    generatedAt,
  });

  async function persistDailyScope(
    scope: string,
    points: DailyCompanyMarketplaceMetricsPayload[],
    scopeDataMode: V6DataMode,
    scopeCoverage: V6CoverageStatus,
    scopeFingerprint: string
  ) {
    for (const point of points) {
      const payloadChecksum = checksumJson(point);
      await params.repository.upsertDaily({
        companyScope: scope,
        marketplace: "ALL",
        businessDate: point.businessDate,
        formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
        dataMode: scopeDataMode,
        coverageStatus: scopeCoverage,
        sourceFingerprint: scopeFingerprint,
        payloadChecksum,
        payload: point,
        generatedAt,
      });
    }
  }

  await persistDailyScope("ALL", allDailyPoints, dataMode, coverageStatus, sourceFingerprint);
  for (const [scope, points] of dailyByCompany) {
    const companyRow = companyRows.find((r) => r.companyName === scope);
    const companyPeriod = companyRow
      ? await params.repository.findPeriod({
          companyScope: scope,
          marketplace: "ALL",
          dateFrom,
          dateTo,
          formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
        })
      : null;
    await persistDailyScope(
      scope,
      points,
      companyPeriod?.dataMode ?? dataMode,
      companyPeriod?.coverageStatus ?? coverageStatus,
      companyPeriod?.sourceFingerprint ?? sourceFingerprint
    );
  }

  const returnMeta =
    companyScope === "ALL"
      ? meta
      : ((
          await params.repository.findPeriod({
            companyScope,
            marketplace: "ALL",
            dateFrom,
            dateTo,
            formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
          })
        )?.meta ?? meta);

  return { meta: returnMeta, companyRows: scopedRows, dailyPoints };
}

/** Fixture/canary producer without live FC — callers must supply evidence-derived dataMode. */
export async function persistPrecomputedV6DashboardBundle(params: {
  repository: V6PeriodReadModelRepository;
  companyScope?: string;
  dateFrom: string;
  dateTo: string;
  companyRows: PeriodCompanyMarketplaceMetricsPayload[];
  dailyPoints: DailyCompanyMarketplaceMetricsPayload[];
  dataMode?: V6DataMode;
  coverageStatus?: V6CoverageStatus;
  issues?: string[];
  readinessIsFinal?: boolean;
  readinessStatus?: "complete" | "preliminary" | "incomplete";
  todayIso?: string;
  /**
   * Explicit typed proof required for trusted V2 persist.
   * Synthetic fixtures must pass syntheticSafeV2Attestation(...).
   * Missing/unsafe proof must not manufacture a trusted V2 row.
   */
  v2SafetyAttestation?: V2SafetyAttestation | V2SafetyAttestationTemplate;
}) {
  const companyScope = params.companyScope ?? "ALL";
  const dateFrom = isoDateOnly(params.dateFrom);
  const dateTo = isoDateOnly(params.dateTo);
  const persistScopes = [
    "ALL",
    ...[...new Set(params.companyRows.map((row) => row.companyName))],
  ];
  const attestations = new Map<string, V2SafetyAttestation>();
  for (const scope of persistScopes) {
    attestations.set(
      scope,
      assertPersistableV2SafetyAttestation({
        attestation: params.v2SafetyAttestation,
        dateFrom,
        dateTo,
        companyScope: scope,
      })
    );
  }
  const v2SafetyAttestation = attestations.get("ALL")!;
  // Calendar-only resolveDataMode is a PRELIMINARY floor for open periods; never sole FINAL source.
  const calendarHint = resolveDataMode(dateTo, params.todayIso);
  const dataMode: V6DataMode =
    params.dataMode ??
    (calendarHint === "PRELIMINARY" ? "PRELIMINARY" : "PRELIMINARY");
  // If caller explicitly passes FINAL, honor it (synthetic matrix / proven fixtures).
  const resolvedDataMode = params.dataMode ?? dataMode;
  const coverageStatus: V6CoverageStatus = params.coverageStatus ?? "COMPLETE";
  const issues = params.issues ?? [];
  const readinessIsFinal = params.readinessIsFinal ?? resolvedDataMode === "FINAL";
  const readinessStatus =
    params.readinessStatus ??
    (resolvedDataMode === "FINAL" ? "complete" : "preliminary");
  const generatedAt = new Date().toISOString();
  const sourceFingerprint = buildSourceFingerprint({
    companyScope,
    dateFrom,
    dateTo,
    companyRows: params.companyRows,
    dailyPoints: params.dailyPoints,
    dataMode: resolvedDataMode,
  });
  const meta: ReadinessFinalityMeta = {
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
    coverageStatus,
    dataMode: resolvedDataMode,
    generatedAt,
    sourceFingerprint,
    payloadChecksum: checksumJson({
      companyRows: params.companyRows,
      dailyPoints: params.dailyPoints,
    }),
    companyScope,
    marketplace: "ALL",
    dateFrom,
    dateTo,
    completeness: {
      orderDataLoadedDays: params.companyRows.reduce(
        (s, r) => s + r.orderDataLoadedDays,
        0
      ),
      orderDataExpectedDays: params.companyRows.reduce(
        (s, r) => s + r.orderDataExpectedDays,
        0
      ),
      issues,
    },
    invalidationKey: buildInvalidationKey({
      companyScope,
      marketplace: "ALL",
      dateFrom,
      dateTo,
    }),
    staleAfterMs: resolvedDataMode === "PRELIMINARY" ? 30 * 60 * 1000 : null,
    closedDateAutoFinal: false,
    readinessIsFinal,
    readinessStatus,
    weekPresentationStatus:
      resolvedDataMode === "FINAL" ? "FINAL" : "PRELIMINARY",
    weekPresentationReason:
      resolvedDataMode === "FINAL" ? null : "PERIOD_NOT_FINAL",
    wbSourceOwnershipFinal: null,
    wbTaxesUnavailable: null,
    ozonCoverageComplete: null,
    ozonQuarantineCount: 0,
    canonicalDataMode: resolvedDataMode,
    v2SafetyAttestation,
  };

  for (const row of params.companyRows) {
    const rowFingerprint = checksumJson(row);
    const rowDataMode: V6DataMode =
      row.wbTaxesUnavailable === true ||
      row.wbSourceOwnershipFinal === false ||
      (row.ozonQuarantineCount ?? 0) > 0 ||
      row.ozonCoverageComplete === false ||
      row.combinedDataMode === "PRELIMINARY" ||
      row.wbNetProfitStatus === "PRELIMINARY" ||
      row.ozonNetProfitStatus === "PRELIMINARY" ||
      row.ozonTaxesEstimated === true
        ? "PRELIMINARY"
        : resolvedDataMode;
    const companyMeta: ReadinessFinalityMeta = {
      ...meta,
      companyScope: row.companyName,
      dataMode: rowDataMode,
      sourceFingerprint: rowFingerprint,
      payloadChecksum: rowFingerprint,
      invalidationKey: buildInvalidationKey({
        companyScope: row.companyName,
        marketplace: "ALL",
        dateFrom,
        dateTo,
      }),
      staleAfterMs: rowDataMode === "PRELIMINARY" ? 30 * 60 * 1000 : null,
      readinessIsFinal: rowDataMode === "FINAL" ? readinessIsFinal : false,
      readinessStatus: rowDataMode === "FINAL" ? readinessStatus : "preliminary",
      weekPresentationStatus: rowDataMode === "FINAL" ? "FINAL" : "PRELIMINARY",
      weekPresentationReason:
        rowDataMode === "FINAL" ? null : "PERIOD_NOT_FINAL",
      wbSourceOwnershipFinal: row.wbSourceOwnershipFinal ?? null,
      wbTaxesUnavailable: row.wbTaxesUnavailable ?? null,
      ozonCoverageComplete: row.ozonCoverageComplete ?? null,
      ozonQuarantineCount: row.ozonQuarantineCount ?? 0,
      canonicalDataMode: row.combinedDataMode ?? rowDataMode,
      v2SafetyAttestation: attestations.get(row.companyName) ?? v2SafetyAttestation,
    };
    await params.repository.upsertPeriod({
      companyScope: row.companyName,
      marketplace: "ALL",
      dateFrom,
      dateTo,
      formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
      dataMode: rowDataMode,
      coverageStatus,
      sourceFingerprint: rowFingerprint,
      payloadChecksum: rowFingerprint,
      payload: row,
      meta: companyMeta,
      generatedAt,
    });
  }

  await params.repository.upsertPeriod({
    companyScope: "ALL",
    marketplace: "ALL",
    dateFrom,
    dateTo,
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
    dataMode: resolvedDataMode,
    coverageStatus,
    sourceFingerprint,
    payloadChecksum: meta.payloadChecksum,
    payload: {
      companyName: "ALL",
      ordersQty: params.companyRows.reduce((s, r) => s + r.ordersQty, 0),
      ordersAmount: params.companyRows.reduce((s, r) => s + r.ordersAmount, 0),
      orderDataLoadedDays: meta.completeness.orderDataLoadedDays,
      orderDataExpectedDays: meta.completeness.orderDataExpectedDays,
      wbRevenue: sumOrNull(params.companyRows, "wbRevenue"),
      ozonRevenue: sumOrNull(params.companyRows, "ozonRevenue"),
      totalRevenue: sumOrNull(params.companyRows, "totalRevenue"),
      operatingProfitAfterTax: sumOrNull(
        params.companyRows,
        "operatingProfitAfterTax"
      ),
      netProfit: sumOrNull(params.companyRows, "netProfit"),
      profitAfterOwnerWithdrawal: sumOrNull(
        params.companyRows,
        "profitAfterOwnerWithdrawal"
      ),
      cashFlowResult: params.companyRows.reduce((s, r) => s + r.cashFlowResult, 0),
      adsCost: params.companyRows.reduce((s, r) => s + r.adsCost, 0),
      wbAdsCost: params.companyRows.reduce((s, r) => s + r.wbAdsCost, 0),
      ozonAdsCost: params.companyRows.reduce((s, r) => s + r.ozonAdsCost, 0),
      drr: null,
      drrByOrders: null,
      loanPayments: params.companyRows.reduce((s, r) => s + r.loanPayments, 0),
      creditPrincipal: params.companyRows.reduce((s, r) => s + r.creditPrincipal, 0),
      creditInterest: params.companyRows.reduce((s, r) => s + r.creditInterest, 0),
      personalExpenses: params.companyRows.reduce((s, r) => s + r.personalExpenses, 0),
      financialExpenses: params.companyRows.reduce(
        (s, r) => s + r.financialExpenses,
        0
      ),
      cashOnlyExpenses: params.companyRows.reduce((s, r) => s + r.cashOnlyExpenses, 0),
      wbStockQty: params.companyRows.reduce((s, r) => s + r.wbStockQty, 0),
      ozonStockQty: params.companyRows.reduce((s, r) => s + r.ozonStockQty, 0),
      warehouseStockQty: params.companyRows.reduce(
        (s, r) => s + r.warehouseStockQty,
        0
      ),
      wbAbcA: 0,
      wbAbcB: 0,
      wbAbcC: 0,
      ozonAbcA: 0,
      ozonAbcB: 0,
      ozonAbcC: 0,
    },
    meta,
    generatedAt,
  });

  for (const point of params.dailyPoints) {
    const payloadChecksum = checksumJson(point);
    await params.repository.upsertDaily({
      companyScope,
      marketplace: "ALL",
      businessDate: point.businessDate,
      formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
      dataMode: resolvedDataMode,
      coverageStatus,
      sourceFingerprint,
      payloadChecksum,
      payload: point,
      generatedAt,
    });
  }

  return { meta, companyRows: params.companyRows, dailyPoints: params.dailyPoints };
}
