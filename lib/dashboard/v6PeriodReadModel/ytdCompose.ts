/**
 * Native YTD / long Jan-1 span materialization for V6 period read-model.
 *
 * Why: full-range oneshot (buildDailyReport + dailies) fails under certified
 * pool max=1 (timeouts). Month partitions already succeed; YTD must be composed
 * from those months + one getEffectiveFinanceTransactions pass — same formulas
 * as month jobs, no total substitution.
 *
 * Coverage COMPLETE = HIT-able grain (not "orders financially complete").
 * Order incompleteness stays in meta.completeness + PRELIMINARY dataMode.
 */
import { getEffectiveFinanceTransactions } from "@/lib/finance/effectiveFinanceTransactions";
import { calculateFinanceMetricsForRows } from "@/lib/finance/financeMetrics";
import { prisma } from "@/lib/prisma";

import {
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
  type DailyCompanyMarketplaceMetricsPayload,
  type PeriodCompanyMarketplaceMetricsPayload,
  type ReadinessFinalityMeta,
  type V6DataMode,
} from "./contract";
import { isYtdStyleSpan } from "./d1d5Eligibility";
import {
  resolveV6ReadModelFinality,
  type DirectFinalitySignals,
} from "./finality";
import {
  buildInvalidationKey,
  buildSourceFingerprint,
  checksumJson,
  isoDateOnly,
} from "./fingerprint";
import type { V6PeriodReadModelRepository } from "./repository";
import {
  liveV2SafetyAttestation,
  type V2SafetyAttestation,
} from "./v2SafetyAttestation";

export const YTD_COMPOSE_REASON =
  "D1D5_V2_SAFE_YTD_MONTH_PARTITION_COMPOSE" as const;

export class YtdMonthPartitionsIncompleteError extends Error {
  readonly missing: Array<{ companyScope: string; dateFrom: string; dateTo: string }>;
  constructor(
    missing: Array<{ companyScope: string; dateFrom: string; dateTo: string }>
  ) {
    super(
      `YTD_MONTH_PARTITIONS_INCOMPLETE:${missing
        .map((m) => `${m.companyScope}:${m.dateFrom}:${m.dateTo}`)
        .join(",")}`
    );
    this.name = "YtdMonthPartitionsIncompleteError";
    this.missing = missing;
  }
}

function startOfDay(value: string) {
  return new Date(`${isoDateOnly(value)}T00:00:00.000Z`);
}

function nextDayStart(value: string) {
  const date = startOfDay(value);
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function inclusiveDayCount(dateFrom: string, dateTo: string): number {
  const from = startOfDay(dateFrom).getTime();
  const to = startOfDay(dateTo).getTime();
  return Math.floor((to - from) / 86_400_000) + 1;
}

/** Calendar month slices covering [dateFrom, dateTo] inclusive (last may be partial). */
export function enumerateMonthPartitions(
  dateFrom: string,
  dateTo: string
): Array<{ dateFrom: string; dateTo: string }> {
  const from = isoDateOnly(dateFrom);
  const to = isoDateOnly(dateTo);
  const out: Array<{ dateFrom: string; dateTo: string }> = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  for (;;) {
    const monthStart = `${y}-${String(m).padStart(2, "0")}-01`;
    const nextM = m === 12 ? 1 : m + 1;
    const nextY = m === 12 ? y + 1 : y;
    const nextStart = new Date(Date.UTC(nextY, nextM - 1, 1));
    const monthEndDate = new Date(nextStart.getTime() - 86_400_000);
    const monthEnd = monthEndDate.toISOString().slice(0, 10);
    const sliceFrom = monthStart < from ? from : monthStart;
    const sliceTo = monthEnd > to ? to : monthEnd;
    if (sliceFrom <= sliceTo) {
      out.push({ dateFrom: sliceFrom, dateTo: sliceTo });
    }
    if (monthEnd >= to) break;
    y = nextY;
    m = nextM;
  }
  return out;
}

function sumOrNull(values: Array<number | null | undefined>): number | null {
  let sum = 0;
  let any = false;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    any = true;
    sum += v;
  }
  return any ? sum : null;
}

function sumFinite(values: Array<number | null | undefined>): number {
  let sum = 0;
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) sum += v;
  }
  return sum;
}

async function financeForScope(params: {
  companyName: string | null;
  dateFrom: string;
  dateTo: string;
}) {
  const from = startOfDay(params.dateFrom);
  const toExclusive = nextDayStart(params.dateTo);
  const asOfDate = startOfDay(params.dateTo);
  const [rows, categories] = [
    await getEffectiveFinanceTransactions({
      prisma,
      companyName: params.companyName,
      dateFrom: from,
      dateToExclusive: toExclusive,
      asOfDate,
    }),
    await prisma.financeCategory.findMany({
      select: {
        name: true,
        categoryType: true,
        parentName: true,
        profitTreatment: true,
      },
    }),
  ];
  return calculateFinanceMetricsForRows({
    transactions: rows,
    categories,
  });
}

function composePayloadFromMonths(params: {
  scope: string;
  monthPayloads: PeriodCompanyMarketplaceMetricsPayload[];
  finance: Awaited<ReturnType<typeof financeForScope>>;
  ytdDateFrom: string;
  ytdDateTo: string;
}): PeriodCompanyMarketplaceMetricsPayload {
  const payloads = params.monthPayloads;
  const pick = (key: keyof PeriodCompanyMarketplaceMetricsPayload) =>
    sumOrNull(payloads.map((p) => p[key] as number | null | undefined));

  const orderExpectedCalendar = inclusiveDayCount(
    params.ytdDateFrom,
    params.ytdDateTo
  );
  // Loaded days: sum of month loaded (each month counts its own loaded days).
  // Never inflate via marketplace double-count — months already store company-level days.
  const orderLoaded = sumFinite(payloads.map((p) => p.orderDataLoadedDays));
  const orderExpectedFromMonths = sumFinite(
    payloads.map((p) => p.orderDataExpectedDays)
  );
  const orderExpected = Math.max(orderExpectedCalendar, orderExpectedFromMonths);

  const last = payloads[payloads.length - 1];
  const wbRevenue = pick("wbRevenue");
  const ozonRevenue = pick("ozonRevenue");
  const totalRevenue = pick("totalRevenue");
  const adsCost = sumFinite(payloads.map((p) => p.adsCost));
  const wbAdsCost = sumFinite(payloads.map((p) => p.wbAdsCost));
  const ozonAdsCost = sumFinite(payloads.map((p) => p.ozonAdsCost));
  const ordersAmount = sumFinite(payloads.map((p) => p.ordersAmount));
  const ordersQty = sumFinite(payloads.map((p) => p.ordersQty));

  return {
    companyName: params.scope,
    ordersQty,
    ordersAmount,
    orderDataLoadedDays: orderLoaded,
    orderDataExpectedDays: orderExpected,
    wbRevenue,
    ozonRevenue,
    totalRevenue,
    operatingProfitAfterTax: pick("operatingProfitAfterTax"),
    wbOperatingProfitAfterTax: pick("wbOperatingProfitAfterTax"),
    ozonOperatingProfitAfterTax: pick("ozonOperatingProfitAfterTax"),
    netProfit: pick("netProfit"),
    profitAfterOwnerWithdrawal: pick("profitAfterOwnerWithdrawal"),
    cashFlowResult: params.finance.netCashFlow,
    adsCost,
    wbAdsCost,
    ozonAdsCost,
    drr:
      totalRevenue != null && totalRevenue > 0
        ? (adsCost / totalRevenue) * 100
        : null,
    drrByOrders: ordersAmount > 0 ? (adsCost / ordersAmount) * 100 : null,
    loanPayments: params.finance.creditPrincipal + params.finance.creditInterest,
    creditPrincipal: params.finance.creditPrincipal,
    creditInterest: params.finance.creditInterest,
    personalExpenses: params.finance.ownerWithdrawals,
    financialExpenses: params.finance.creditInterest,
    cashOnlyExpenses: params.finance.cashOnlyTotal,
    wbStockQty: last?.wbStockQty ?? 0,
    ozonStockQty: last?.ozonStockQty ?? 0,
    warehouseStockQty: 0,
    wbAbcA: 0,
    wbAbcB: 0,
    wbAbcC: 0,
    ozonAbcA: 0,
    ozonAbcB: 0,
    ozonAbcC: 0,
    wbSourceOwnershipFinal: payloads.every(
      (p) => p.wbSourceOwnershipFinal === true
    ),
    wbTaxesUnavailable: payloads.some((p) => p.wbTaxesUnavailable === true),
    ozonCoverageComplete: payloads.every((p) => p.ozonCoverageComplete !== false),
    ozonQuarantineCount: sumFinite(payloads.map((p) => p.ozonQuarantineCount)),
    combinedDataMode: "PRELIMINARY",
  };
}

function directFromRow(
  row: PeriodCompanyMarketplaceMetricsPayload
): DirectFinalitySignals {
  return {
    wbSourceOwnershipFinal: row.wbSourceOwnershipFinal ?? null,
    wbTaxesUnavailable: row.wbTaxesUnavailable ?? null,
    ozonCoverageComplete: row.ozonCoverageComplete ?? null,
    ozonQuarantineCount: row.ozonQuarantineCount ?? 0,
    canonicalDataMode: row.combinedDataMode ?? "PRELIMINARY",
  };
}

function orderCompletenessIssues(row: PeriodCompanyMarketplaceMetricsPayload): string[] {
  const issues: string[] = [];
  if (row.orderDataLoadedDays < row.orderDataExpectedDays) {
    issues.push("ORDER_DAY_COVERAGE_INCOMPLETE");
  }
  return issues;
}

/**
 * Produce + persist YTD (or Jan-1 long span) from month PCM partitions.
 */
export async function produceV6YtdFromMonthPartitions(params: {
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
  const dateFrom = isoDateOnly(params.dateFrom);
  const dateTo = isoDateOnly(params.dateTo);
  if (!isYtdStyleSpan(dateFrom, dateTo)) {
    throw new Error(`YTD_COMPOSE_REQUIRES_YTD_STYLE_SPAN:${dateFrom}:${dateTo}`);
  }

  const months = enumerateMonthPartitions(dateFrom, dateTo);
  const companyNames = (
    await prisma.company.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { name: true },
    })
  ).map((c) => c.name);
  const scopes = ["ALL", ...companyNames];

  const missing: Array<{ companyScope: string; dateFrom: string; dateTo: string }> =
    [];
  const monthRowsByScope = new Map<
    string,
    Array<{
      dateFrom: string;
      dateTo: string;
      payload: PeriodCompanyMarketplaceMetricsPayload;
      meta: ReadinessFinalityMeta | null;
      coverageStatus: string;
      sourceFingerprint: string;
      payloadChecksum: string;
    }>
  >();

  for (const scope of scopes) {
    const list: NonNullable<ReturnType<typeof monthRowsByScope.get>> = [];
    for (const part of months) {
      const row = await params.repository.findPeriod({
        companyScope: scope,
        marketplace: "ALL",
        dateFrom: part.dateFrom,
        dateTo: part.dateTo,
        formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
      });
      if (!row || row.coverageStatus !== "COMPLETE") {
        missing.push({
          companyScope: scope,
          dateFrom: part.dateFrom,
          dateTo: part.dateTo,
        });
        continue;
      }
      list.push({
        dateFrom: part.dateFrom,
        dateTo: part.dateTo,
        payload: row.payload,
        meta: row.meta,
        coverageStatus: row.coverageStatus,
        sourceFingerprint: row.sourceFingerprint,
        payloadChecksum: row.payloadChecksum,
      });
    }
    monthRowsByScope.set(scope, list);
  }

  if (missing.length > 0) {
    // Ask workers to fill missing months first (best-effort).
    for (const m of missing.slice(0, 40)) {
      await params.repository.requestRebuild?.({
        companyScope: m.companyScope === "ALL" ? "ALL" : m.companyScope,
        dateFrom: m.dateFrom,
        dateTo: m.dateTo,
        priority: 90,
      });
    }
    throw new YtdMonthPartitionsIncompleteError(missing);
  }

  const generatedAt = new Date().toISOString();
  const companyRows: PeriodCompanyMarketplaceMetricsPayload[] = [];
  const composedByScope = new Map<
    string,
    {
      payload: PeriodCompanyMarketplaceMetricsPayload;
      dailyPoints: DailyCompanyMarketplaceMetricsPayload[];
      monthDigests: string[];
    }
  >();

  for (const scope of scopes) {
    const monthRows = monthRowsByScope.get(scope)!;
    const finance = await financeForScope({
      companyName: scope === "ALL" ? null : scope,
      dateFrom,
      dateTo,
    });
    const payload = composePayloadFromMonths({
      scope,
      monthPayloads: monthRows.map((r) => r.payload),
      finance,
      ytdDateFrom: dateFrom,
      ytdDateTo: dateTo,
    });

    // Concatenate month dailies (no full-range daily analytics oneshot).
    const dailyPoints: DailyCompanyMarketplaceMetricsPayload[] = [];
    for (const part of months) {
      const dailies = await params.repository.findDailyRange({
        companyScope: scope,
        marketplace: "ALL",
        dateFrom: part.dateFrom,
        dateTo: part.dateTo,
        formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
      });
      for (const d of dailies) {
        dailyPoints.push(d.payload);
      }
    }
    dailyPoints.sort((a, b) => a.businessDate.localeCompare(b.businessDate));

    composedByScope.set(scope, {
      payload,
      dailyPoints,
      monthDigests: monthRows.map((r) => r.payloadChecksum),
    });
    if (scope !== "ALL") companyRows.push(payload);
  }

  const allComposed = composedByScope.get("ALL")!;
  const allDirect = directFromRow(allComposed.payload);
  const allFinality = await resolveV6ReadModelFinality({
    dateFrom,
    dateTo,
    todayIso: params.todayIso,
    companyName: null,
    hasUsablePayload: true,
    direct: allDirect,
  });
  // YTD open-year compose is never FINAL; keep PRELIMINARY explicitly.
  const dataMode: V6DataMode = "PRELIMINARY";
  const coverageStatus = allFinality.coverageStatus; // COMPLETE when payload usable

  const attestations = new Map<string, V2SafetyAttestation>();
  for (const scope of scopes) {
    const composed = composedByScope.get(scope)!;
    const evidence = {
      dateFrom,
      dateTo,
      companyScope: scope,
      isFinanciallyFinal: false,
      selectedSessionIds: [] as string[],
      intervals: [] as Array<{
        companyName: string;
        dateFrom: string;
        dateTo: string;
        mode: string;
        sessionId: string | null;
      }>,
      composition: {
        method: "month_partition_sum + getEffectiveFinanceTransactions",
        monthCount: months.length,
        months,
        monthPayloadChecksums: composed.monthDigests,
      },
    };
    attestations.set(
      scope,
      liveV2SafetyAttestation({
        reason: YTD_COMPOSE_REASON,
        dateFrom,
        dateTo,
        companyScope: scope,
        planEvidence: evidence as any,
      })
    );
  }

  async function persistScope(scope: string) {
    const composed = composedByScope.get(scope)!;
    const row = composed.payload;
    const dailyPoints = composed.dailyPoints;
    const finality =
      scope === "ALL"
        ? allFinality
        : await resolveV6ReadModelFinality({
            dateFrom,
            dateTo,
            todayIso: params.todayIso,
            companyName: scope,
            hasUsablePayload: true,
            direct: directFromRow(row),
          });
    const orderIssues = orderCompletenessIssues(row);
    const issues = [
      ...finality.issues,
      ...orderIssues,
      "YTD_COMPOSED_FROM_MONTH_PARTITIONS_PLUS_EFFECTIVE_FINANCE",
    ];
    const sourceFingerprint = buildSourceFingerprint({
      companyScope: scope,
      dateFrom,
      dateTo,
      companyRows: scope === "ALL" ? companyRows : [row],
      dailyPoints,
      dataMode,
    });
    const payloadChecksum =
      scope === "ALL"
        ? checksumJson({ companyRows, dailyPoints })
        : checksumJson(row);
    const attestation = attestations.get(scope)!;
    const meta: ReadinessFinalityMeta = {
      formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
      coverageStatus: finality.coverageStatus,
      dataMode,
      generatedAt,
      sourceFingerprint,
      payloadChecksum,
      companyScope: scope,
      marketplace: "ALL",
      dateFrom,
      dateTo,
      completeness: {
        orderDataLoadedDays: row.orderDataLoadedDays,
        orderDataExpectedDays: row.orderDataExpectedDays,
        issues,
      },
      invalidationKey: buildInvalidationKey({
        companyScope: scope,
        marketplace: "ALL",
        dateFrom,
        dateTo,
      }),
      staleAfterMs: 30 * 60 * 1000,
      closedDateAutoFinal: false,
      readinessIsFinal: false,
      readinessStatus: "preliminary",
      weekPresentationStatus: finality.weekPresentation.status,
      weekPresentationReason: finality.weekPresentation.reason,
      wbSourceOwnershipFinal: finality.direct.wbSourceOwnershipFinal,
      wbTaxesUnavailable: finality.direct.wbTaxesUnavailable,
      ozonCoverageComplete: finality.direct.ozonCoverageComplete,
      ozonQuarantineCount: finality.direct.ozonQuarantineCount,
      canonicalDataMode: "PRELIMINARY",
      v2SafetyAttestation: attestation,
    };

    await params.repository.upsertPeriod({
      companyScope: scope,
      marketplace: "ALL",
      dateFrom,
      dateTo,
      formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
      dataMode,
      coverageStatus: finality.coverageStatus,
      sourceFingerprint,
      payloadChecksum,
      payload: row,
      meta,
      generatedAt,
    });

    for (const point of dailyPoints) {
      const pointChecksum = checksumJson(point);
      await params.repository.upsertDaily({
        companyScope: scope,
        marketplace: "ALL",
        businessDate: point.businessDate,
        formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
        dataMode,
        coverageStatus: finality.coverageStatus,
        sourceFingerprint: pointChecksum,
        payloadChecksum: pointChecksum,
        payload: point,
        generatedAt,
      });
    }

    return meta;
  }

  for (const scope of companyNames) {
    await persistScope(scope);
  }
  const allMeta = await persistScope("ALL");

  const requested = params.companyScope ?? "ALL";
  if (requested === "ALL") {
    return {
      meta: allMeta,
      companyRows,
      dailyPoints: allComposed.dailyPoints,
    };
  }
  const scoped = composedByScope.get(requested);
  return {
    meta: allMeta,
    companyRows: scoped ? [scoped.payload] : [],
    dailyPoints: scoped?.dailyPoints ?? [],
  };
}
