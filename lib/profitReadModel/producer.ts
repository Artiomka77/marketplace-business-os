import { getProfitAnalytics } from "@/lib/analytics/profitAnalytics";
import { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";
import type { PrismaClient } from "@prisma/client";
import {
  formulaForMarketplace,
  type ProfitDataMode,
  type ProfitMarketplace,
  type ProfitPeriodMeta,
} from "./contract";
import {
  isoDateOnly,
  productKeyFromRow,
  sha256Json,
} from "./fingerprint";
import type { ProfitReadModelRepository } from "./repository";
import { computeCheapProfitSourceVersion } from "./sourceVersion";

function inferDataMode(
  analytics: Record<string, unknown>,
  marketplace: ProfitMarketplace
): ProfitDataMode {
  if (marketplace === "WB") {
    const avail = analytics?.wbPnlAvailability as { status?: string } | undefined;
    if (avail?.status === "UNAVAILABLE") return "PRELIMINARY";
    if (analytics?.totals == null) return "PRELIMINARY";
    const wbStatus = (analytics.totals as { netProfitStatus?: string } | null)
      ?.netProfitStatus;
    if (wbStatus === "PRELIMINARY") return "PRELIMINARY";
    if (
      (analytics.totals as { costCoverageIncomplete?: boolean } | null)
        ?.costCoverageIncomplete === true
    ) {
      return "PRELIMINARY";
    }
    return "FINAL";
  }
  if (analytics?.totals == null) return "PRELIMINARY";
  if (analytics?.taxesEstimated === true) return "PRELIMINARY";
  if (Number(analytics?.quarantineCount ?? 0) > 0) return "PRELIMINARY";
  const ozonStatus = (analytics.totals as { netProfitStatus?: string } | null)
    ?.netProfitStatus;
  if (ozonStatus === "PRELIMINARY") return "PRELIMINARY";
  if (
    (analytics.totals as { costCoverageIncomplete?: boolean } | null)
      ?.costCoverageIncomplete === true
  ) {
    return "PRELIMINARY";
  }
  return "FINAL";
}

function extractTotals(analytics: Record<string, unknown>) {
  return analytics?.totals ?? null;
}

function extractSkuRows(
  marketplace: ProfitMarketplace,
  analytics: Record<string, unknown>
) {
  const rows = Array.isArray(analytics?.rows) ? analytics.rows : [];
  return rows.map((row: Record<string, unknown>) => ({
    productKey: productKeyFromRow(marketplace, row),
    payload: row,
  }));
}

export async function produceProfitReadModel(params: {
  repository: ProfitReadModelRepository;
  marketplace: ProfitMarketplace;
  companyScope: string;
  dateFrom: string;
  dateTo: string;
  /** Injectables for tests / canaries */
  computeWb?: typeof getProfitAnalytics;
  computeOzon?: typeof getProfitAnalyticsOzon;
  /** Optional Prisma for cheap canonical source-version fingerprint */
  prisma?: PrismaClient;
  sourceFingerprintOverride?: string;
}): Promise<{
  formulaVersion: string;
  dataMode: ProfitDataMode;
  skuCount: number;
  payloadChecksum: string;
  sourceFingerprint: string;
  heavyFcCalls: number;
}> {
  const dateFrom = isoDateOnly(params.dateFrom);
  const dateTo = isoDateOnly(params.dateTo);
  const formulaVersion = formulaForMarketplace(params.marketplace);
  const companyName =
    params.companyScope === "ALL" ? "ALL" : params.companyScope;

  let analytics: Record<string, unknown>;
  let heavyFcCalls = 0;
  if (params.marketplace === "WB") {
    const fn = params.computeWb ?? getProfitAnalytics;
    analytics = (await fn({ dateFrom, dateTo, companyName })) as unknown as Record<
      string,
      unknown
    >;
    heavyFcCalls = 1;
  } else {
    const fn = params.computeOzon ?? getProfitAnalyticsOzon;
    analytics = (await fn({ dateFrom, dateTo, companyName })) as unknown as Record<
      string,
      unknown
    >;
    heavyFcCalls = 1;
  }

  const dataMode = inferDataMode(analytics, params.marketplace);
  const totals = extractTotals(analytics);
  const comparison = analytics?.comparison ?? null;
  const skuParts = extractSkuRows(params.marketplace, analytics);
  const payloadChecksum = sha256Json({
    totals,
    comparison,
    rows: analytics?.rows ?? [],
    previousTotals: analytics?.previousTotals ?? null,
  });
  const sourceFingerprint =
    params.sourceFingerprintOverride ??
    (params.prisma
      ? await computeCheapProfitSourceVersion({
          prisma: params.prisma,
          marketplace: params.marketplace,
          companyScope: params.companyScope,
          dateFrom,
          dateTo,
        })
      : sha256Json({
          marketplace: params.marketplace,
          companyScope: params.companyScope,
          dateFrom,
          dateTo,
          formulaVersion,
          payloadChecksum,
          totals,
        }));

  const meta: ProfitPeriodMeta = {
    formulaVersion,
    marketplace: params.marketplace,
    companyScope: params.companyScope,
    dateFrom,
    dateTo,
    dataMode,
    coverageStatus: totals == null ? "PARTIAL" : "COMPLETE",
    sourceFingerprint,
    payloadChecksum,
    generatedAt: new Date().toISOString(),
    staleAfterMs: dataMode === "PRELIMINARY" ? 6 * 60 * 60 * 1000 : null,
    sourceOwnershipFinal: dataMode === "FINAL",
    taxesUnavailable:
      (analytics?.wbPnlAvailability as { status?: string } | undefined)
        ?.status === "UNAVAILABLE"
        ? true
        : false,
    taxesEstimated: analytics?.taxesEstimated === true ? true : false,
    ozonQuarantineCount:
      params.marketplace === "OZON"
        ? Number(analytics?.quarantineCount ?? 0)
        : null,
    readinessStatus:
      dataMode === "FINAL"
        ? "complete"
        : totals == null
          ? "incomplete"
          : "preliminary",
    weekPresentationStatus:
      dataMode === "FINAL"
        ? "FINAL"
        : totals == null
          ? "INCOMPLETE"
          : "PRELIMINARY",
    heavyFcCallsInProducer: heavyFcCalls,
  };

  const generatedAt = new Date();
  await params.repository.replacePeriod({
    period: {
      companyScope: params.companyScope,
      marketplace: params.marketplace,
      dateFrom: new Date(`${dateFrom}T00:00:00.000Z`),
      dateTo: new Date(`${dateTo}T00:00:00.000Z`),
      formulaVersion,
      dataMode,
      coverageStatus: meta.coverageStatus,
      sourceFingerprint,
      payloadChecksum,
      totals,
      comparison,
      meta,
      analyticsPayload: analytics,
      generatedAt,
      staleAfterMs: meta.staleAfterMs,
    },
    skus: skuParts.map((s: { productKey: string; payload: Record<string, unknown> }) => ({
      companyScope: params.companyScope,
      marketplace: params.marketplace,
      dateFrom: new Date(`${dateFrom}T00:00:00.000Z`),
      dateTo: new Date(`${dateTo}T00:00:00.000Z`),
      formulaVersion,
      productKey: s.productKey,
      payload: s.payload,
      generatedAt,
    })),
  });

  return {
    formulaVersion,
    dataMode,
    skuCount: skuParts.length,
    payloadChecksum,
    sourceFingerprint,
    heavyFcCalls,
  };
}
