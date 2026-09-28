import {
  formulaForMarketplace,
  isWaveBProfitFormula,
  rejectsLegacyAsWaveBProfit,
  type ProfitLoadResult,
  type ProfitMarketplace,
  type ProfitPeriodMeta,
} from "./contract";
import { isoDateOnly } from "./fingerprint";
import type { ProfitReadModelRepository } from "./repository";

export function isWaveBProfitReadModelFirstEnabled(): boolean {
  const env = process.env as Record<string, string | undefined>;
  return env["WAVE_B_PROFIT_READMODEL_FIRST"] === "1";
}

/** Explicit rollback only — ordinary HIT path never uses this. */
export function isWaveBHeavyLiveFallbackEnabled(): boolean {
  const env = process.env as Record<string, string | undefined>;
  return env["WAVE_B_PROFIT_LIVE_FALLBACK"] === "1";
}

function isPreliminaryStale(row: {
  dataMode: string;
  generatedAt: Date;
  staleAfterMs: number | null;
}): boolean {
  if (row.dataMode !== "PRELIMINARY") return false;
  if (row.staleAfterMs == null || row.staleAfterMs <= 0) return false;
  return Date.now() > row.generatedAt.getTime() + row.staleAfterMs;
}

export async function loadProfitReadModel(params: {
  repository: ProfitReadModelRepository;
  marketplace: ProfitMarketplace;
  companyScope: string;
  dateFrom: string;
  dateTo: string;
  enqueueOnMiss?: boolean;
  /**
   * Lazy cheap source-version resolver.
   * Invoked ONLY when a FINAL candidate row exists and freshness must be checked.
   * MISS / PENDING / PRELIMINARY paths must not call this (no DB fanout).
   */
  resolveCurrentSourceVersion?: () => Promise<string | null | undefined>;
  /** @deprecated prefer resolveCurrentSourceVersion lazy callback */
  currentSourceVersion?: string | null;
}): Promise<ProfitLoadResult> {
  const dateFrom = isoDateOnly(params.dateFrom);
  const dateTo = isoDateOnly(params.dateTo);
  const formulaVersion = formulaForMarketplace(params.marketplace);

  if (rejectsLegacyAsWaveBProfit(formulaVersion)) {
    return {
      status: "UNAVAILABLE",
      formulaVersion,
      reason: "LEGACY_FORMULA_REJECTED",
      heavyFcCalls: 0,
      sourceMarker: "PROFIT_READ_MODEL_MISS",
    };
  }

  const row = await params.repository.findPeriod({
    companyScope: params.companyScope,
    marketplace: params.marketplace,
    dateFrom,
    dateTo,
    formulaVersion,
  });

  if (!row) {
    let rebuildEnqueued = false;
    if (params.enqueueOnMiss !== false) {
      const enq = await params.repository.enqueueRebuild({
        companyScope: params.companyScope,
        dateFrom,
        dateTo,
        formulaVersion,
        priority: 40,
      });
      rebuildEnqueued =
        enq.action === "create" || enq.action === "reopen_success";
    }
    return {
      status: "PENDING",
      formulaVersion,
      reason: "MISS_NO_ROW",
      heavyFcCalls: 0,
      sourceMarker: "PROFIT_READ_MODEL_MISS",
      rebuildEnqueued,
    };
  }

  if (!isWaveBProfitFormula(row.formulaVersion)) {
    return {
      status: "UNAVAILABLE",
      formulaVersion,
      reason: "INCOMPATIBLE_FORMULA_VERSION",
      heavyFcCalls: 0,
      sourceMarker: "PROFIT_READ_MODEL_MISS",
    };
  }

  const meta = row.meta as ProfitPeriodMeta;
  if (meta.payloadChecksum && meta.payloadChecksum !== row.payloadChecksum) {
    return {
      status: "UNAVAILABLE",
      formulaVersion,
      reason: "PAYLOAD_CHECKSUM_MISMATCH",
      heavyFcCalls: 0,
      sourceMarker: "PROFIT_READ_MODEL_MISS",
    };
  }

  if (meta.companyScope !== params.companyScope) {
    return {
      status: "UNAVAILABLE",
      formulaVersion,
      reason: "COMPANY_SCOPE_MISMATCH",
      heavyFcCalls: 0,
      sourceMarker: "PROFIT_READ_MODEL_MISS",
    };
  }

  if (meta.marketplace !== params.marketplace) {
    return {
      status: "UNAVAILABLE",
      formulaVersion,
      reason: "MARKETPLACE_MISMATCH",
      heavyFcCalls: 0,
      sourceMarker: "PROFIT_READ_MODEL_MISS",
    };
  }

  if (row.dataMode === "FINAL" && row.coverageStatus !== "COMPLETE") {
    return {
      status: "UNAVAILABLE",
      formulaVersion,
      reason: "CLOSED_STALE_INCOMPLETE",
      heavyFcCalls: 0,
      sourceMarker: "PROFIT_READ_MODEL_MISS",
    };
  }

  // Closed FINAL freshness: resolve source version ONLY now (not on MISS).
  if (row.dataMode === "FINAL") {
    let currentSourceVersion = params.currentSourceVersion ?? null;
    if (
      currentSourceVersion == null &&
      typeof params.resolveCurrentSourceVersion === "function"
    ) {
      currentSourceVersion =
        (await params.resolveCurrentSourceVersion()) ?? null;
    }
    if (
      currentSourceVersion &&
      meta.sourceFingerprint &&
      currentSourceVersion !== meta.sourceFingerprint &&
      currentSourceVersion !== row.sourceFingerprint
    ) {
      let rebuildEnqueued = false;
      if (params.enqueueOnMiss !== false) {
        const enq = await params.repository.enqueueRebuild({
          companyScope: params.companyScope,
          dateFrom,
          dateTo,
          formulaVersion,
          priority: 30,
        });
        rebuildEnqueued =
          enq.action === "create" ||
          enq.action === "reopen_success" ||
          enq.action === "keep_existing";
      }
      return {
        status: "UNAVAILABLE",
        formulaVersion,
        reason: "SOURCE_FINGERPRINT_STALE",
        heavyFcCalls: 0,
        sourceMarker: "PROFIT_READ_MODEL_MISS",
        rebuildEnqueued,
      };
    }
  }

  let preliminaryStale = false;
  let rebuildEnqueued: boolean | undefined;
  if (isPreliminaryStale(row)) {
    preliminaryStale = true;
    if (params.enqueueOnMiss !== false) {
      const enq = await params.repository.enqueueRebuild({
        companyScope: params.companyScope,
        dateFrom,
        dateTo,
        formulaVersion,
        priority: 45,
      });
      rebuildEnqueued =
        enq.action === "create" ||
        enq.action === "reopen_success" ||
        enq.action === "keep_existing";
    }
    // Serve stale PRELIMINARY explicitly (never promote to FINAL).
  }

  const skuCount = await params.repository.countSkus({
    companyScope: params.companyScope,
    marketplace: params.marketplace,
    dateFrom,
    dateTo,
    formulaVersion,
  });

  return {
    status: "HIT",
    formulaVersion,
    dataMode: row.dataMode as "FINAL" | "PRELIMINARY",
    coverageStatus: row.coverageStatus as "COMPLETE" | "PARTIAL" | "MISSING",
    analytics: row.analyticsPayload,
    meta: {
      ...meta,
      weekPresentationStatus:
        row.dataMode === "PRELIMINARY"
          ? "PRELIMINARY"
          : meta.weekPresentationStatus,
    },
    skuCount,
    heavyFcCalls: 0,
    sourceMarker: "PROFIT_READ_MODEL_HIT",
    preliminaryStale,
    ...(rebuildEnqueued !== undefined ? { rebuildEnqueued } : {}),
  };
}
