export const TELEGRAM_OZON_OWNER_REPORT_JOB_TYPE = "TELEGRAM_OZON_OWNER_DAILY_REPORT";

export type OzonReadinessClass =
  | "READY_FINAL"
  | "RETRYABLE_PROVIDER_NOT_READY"
  | "RETRYABLE_PARTIAL"
  | "RETRYABLE_RATE_LIMIT"
  | "RETRYABLE_TRANSIENT_NETWORK"
  | "NONRETRYABLE_UNKNOWN_TYPE"
  | "NONRETRYABLE_SCHEMA"
  | "NONRETRYABLE_AUTH"
  | "NONRETRYABLE_OTHER";

export type OzonCompanyReadiness = {
  companyName: string;
  businessDate: string;
  class: OzonReadinessClass;
  dataMode: string | null;
  phase: string | null;
  coverageComplete: boolean;
  quarantineCount: number;
  missingEvidence: string[];
  reason: string;
};

export type OwnerReportDeliveryStatus =
  | "PENDING"
  | "WAITING_OZON"
  | "WAITING_WB_FINANCE"
  | "WAITING_PRODUCT_COST_COVERAGE"
  | "PRELIMINARY_MISSING_COGS"
  | "PRELIMINARY_MISSING_COGS_SENT"
  | "READY_TO_FINAL_SEND"
  | "SERVICE_NOTICE_SENT"
  | "TECHNICAL_BLOCKER_SENT"
  | "FINAL_SENT"
  | "ABANDONED_NONRETRYABLE";

/** Snapshot persisted at FINAL_SENT for historical dry-run / audit parity. */
export type OwnerReportFinalSnapshot = {
  capturedAt: string;
  sourceMode:
    | "FINAL_SENT_SNAPSHOT"
    | "OWNER_CONTROL_TRANSCRIPT"
    | "OWNER_TRANSCRIPT_REPLAY"
    | "RECALCULATED_CURRENT_SOURCE";
  /** False for historical owner-transcript backfills (audit only). */
  canonical?: boolean;
  historicalAuditOnly?: boolean;
  formatterVersion?: string;
  financialFormulaVersion?: string | null;
  finalSentAt?: string | null;
  ordersAsOf?: string | null;
  message1: string;
  message2: string;
  totals: {
    ordersQty: number;
    ordersAmount: number;
    economicTurnover: number;
    totalCost: number | null;
    netProfitImpact: number;
    adSpend: number;
  };
  companies: Array<{
    companyName: string;
    marketplace: "WB" | "OZON";
    ordersQty: number;
    ordersAmount: number;
    economicTurnover: number | null;
    totalCost: number | null;
    netProfitImpact: number | null;
    adSpend: number;
  }>;
  sourceFingerprint: {
    orders: Array<{
      companyName: string;
      marketplace: string;
      ordersQty: number;
      ordersAmount: number;
      lastSuccessfulSyncAt: string | null;
    }>;
    ordersAsOf?: string | null;
    ozonDays: Array<{
      companyName: string;
      payloadSha256: string | null;
      importSessionId: string | null;
      dataMode: string | null;
      phase: string | null;
    }>;
    productCostCreatedMaxAt: string | null;
    cogsCoverage?: {
      coverageComplete: boolean;
      expectedQty: number;
      coveredQty: number;
      unresolvedQty: number;
      unresolvedSkuCount: number;
      reason: string | null;
      marketplaces: Array<{
        companyName: string;
        marketplace: "WB" | "OZON";
        expectedQty: number;
        coveredQty: number;
        unresolvedQty: number;
        unresolvedSkuCount: number;
        coverageComplete: boolean;
      }>;
    } | null;
  };
};

export type OwnerReportDeliveryProvenance = {
  reportType: "OWNER_DAILY_V3";
  businessDate: string;
  deliveryStatus: OwnerReportDeliveryStatus;
  companyReadiness: OzonCompanyReadiness[];
  lastReason: string | null;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  attemptCount: number;
  serviceNoticeSentAt: string | null;
  /** Optional one escalation after ~12:00 MSK if still not FINAL_SENT. */
  escalationNoticeSentAt?: string | null;
  /** When PRELIMINARY_MISSING_COGS report was sent (numeric, not FINAL). */
  preliminarySentAt?: string | null;
  technicalNoticeSentAt: string | null;
  finalSentAt: string | null;
  finalMessageIds: Array<{ chatId: string; messageId: number | string | null }>;
  recoveryHeaderUsed: boolean;
  refreshHttpStatus: number | null;
  refreshRetryAfterSec: number | null;
  /** Present after FINAL_SENT when snapshot persistence is wired. */
  finalSnapshot?: OwnerReportFinalSnapshot | null;
  expectedParts?: number | null;
  chatDeliveries?: unknown;
  /** Last watchdog touch (ISO). */
  lastWatchdogAt?: string | null;
  /** Compact observability blocker label. */
  blocker?: string | null;
};

export type OwnerMorningBlockerKind =
  | "OZON"
  | "PRODUCT_COST_COGS"
  | "WB_SOURCE"
  | "INTERNAL"
  | "PIPELINE_ERROR";

export function formatBusinessDateLabel(businessDate: string) {
  const [y, m, d] = businessDate.split("-");
  return `${d}.${m}.${y}`;
}

/** Owner-facing waiting status — one per businessDate until FINAL. */
export function formatOwnerWaitingStatusNotice(
  businessDate: string,
  blocker: OwnerMorningBlockerKind,
  detail?: string | null,
) {
  const label = formatBusinessDateLabel(businessDate);
  const what =
    blocker === "OZON"
      ? "данные Ozon"
      : blocker === "PRODUCT_COST_COGS"
        ? "данные ProductCost/COGS"
        : blocker === "WB_SOURCE"
          ? "данные WB"
          : blocker === "PIPELINE_ERROR"
            ? "устранения технической ошибки"
            : "внутренней обработки";
  const extra = detail ? `\n${detail}` : "";
  return `⏳ Сводка за ${label} ещё готовится: ждём ${what}.${extra}\nОтправлю автоматически после готовности.`;
}

export function formatOwnerEscalationNotice(businessDate: string) {
  const label = formatBusinessDateLabel(businessDate);
  return `⚠️ Сводка за ${label} задерживается. Автоматические повторы продолжаются.`;
}

/** Prior Moscow calendar day as YYYY-MM-DD. */
export function moscowBusinessYesterday(now: Date = new Date()): string {
  const mskMs = now.getTime() + 3 * 60 * 60 * 1000;
  const msk = new Date(mskMs);
  msk.setUTCDate(msk.getUTCDate() - 1);
  return msk.toISOString().slice(0, 10);
}

/** True when Moscow local time is at/after morning deadline 09:20. */
export function isPastMoscowMorningDeadline(now: Date = new Date()): boolean {
  const mskMs = now.getTime() + 3 * 60 * 60 * 1000;
  const msk = new Date(mskMs);
  const minutes = msk.getUTCHours() * 60 + msk.getUTCMinutes();
  return minutes >= 9 * 60 + 20;
}

/** True when Moscow local hour >= 12 (escalation window). */
export function isPastMoscowEscalationHour(now: Date = new Date()): boolean {
  const mskHour = (now.getUTCHours() + 3) % 24;
  return mskHour >= 12;
}

export function isRetryableOzonClass(value: OzonReadinessClass): boolean {
  return value.startsWith("RETRYABLE_");
}

export function isNonRetryableOzonClass(value: OzonReadinessClass): boolean {
  return value.startsWith("NONRETRYABLE_");
}

export function classifyOzonDayStatus(input: {
  companyName: string;
  businessDate: string;
  row:
    | {
        dataMode?: string | null;
        phase?: string | null;
        coverageComplete?: boolean | null;
        quarantineCount?: number | null;
        missingEvidence?: unknown;
      }
    | null
    | undefined;
  refreshError?: {
    httpStatus?: number | null;
    message?: string | null;
    retryAfterSec?: number | null;
  } | null;
}): OzonCompanyReadiness {
  const missingEvidence = Array.isArray(input.row?.missingEvidence)
    ? input.row!.missingEvidence!.map((item) => String(item))
    : [];

  const msg = String(input.refreshError?.message ?? "");

  // Semantic blockers must win over batch HTTP status: MAIN sync often returns
  // HTTP 500 for the whole date when only one company has unknown types.
  if (/unknown accrual types|unknownMeaningfulTypeIds/i.test(msg)) {
    return {
      companyName: input.companyName,
      businessDate: input.businessDate,
      class: "NONRETRYABLE_UNKNOWN_TYPE",
      dataMode: input.row?.dataMode ?? null,
      phase: input.row?.phase ?? null,
      coverageComplete: false,
      quarantineCount: Number(input.row?.quarantineCount ?? 0),
      missingEvidence:
        missingEvidence.length > 0
          ? missingEvidence
          : ["UNKNOWN_ACCRUAL_TYPE"],
      reason: msg.slice(0, 300) || "UNKNOWN_TYPE",
    };
  }
  if (/unauthorized|401|403|auth/i.test(msg)) {
    return {
      companyName: input.companyName,
      businessDate: input.businessDate,
      class: "NONRETRYABLE_AUTH",
      dataMode: input.row?.dataMode ?? null,
      phase: input.row?.phase ?? null,
      coverageComplete: false,
      quarantineCount: Number(input.row?.quarantineCount ?? 0),
      missingEvidence,
      reason: msg.slice(0, 300) || "AUTH",
    };
  }
  if (/schema|prisma|column|relation/i.test(msg)) {
    return {
      companyName: input.companyName,
      businessDate: input.businessDate,
      class: "NONRETRYABLE_SCHEMA",
      dataMode: input.row?.dataMode ?? null,
      phase: input.row?.phase ?? null,
      coverageComplete: false,
      quarantineCount: Number(input.row?.quarantineCount ?? 0),
      missingEvidence,
      reason: msg.slice(0, 300) || "SCHEMA",
    };
  }

  if (input.refreshError?.httpStatus === 429) {
    return {
      companyName: input.companyName,
      businessDate: input.businessDate,
      class: "RETRYABLE_RATE_LIMIT",
      dataMode: input.row?.dataMode ?? null,
      phase: input.row?.phase ?? null,
      coverageComplete: input.row?.coverageComplete === true,
      quarantineCount: Number(input.row?.quarantineCount ?? 0),
      missingEvidence,
      reason: `HTTP_429${input.refreshError.retryAfterSec != null ? `:Retry-After=${input.refreshError.retryAfterSec}` : ""}`,
    };
  }

  if (
    input.refreshError?.httpStatus &&
    [408, 425, 500, 502, 503, 504].includes(input.refreshError.httpStatus)
  ) {
    return {
      companyName: input.companyName,
      businessDate: input.businessDate,
      class: "RETRYABLE_TRANSIENT_NETWORK",
      dataMode: input.row?.dataMode ?? null,
      phase: input.row?.phase ?? null,
      coverageComplete: input.row?.coverageComplete === true,
      quarantineCount: Number(input.row?.quarantineCount ?? 0),
      missingEvidence,
      reason: `HTTP_${input.refreshError.httpStatus}`,
    };
  }

  if (!input.row) {
    return {
      companyName: input.companyName,
      businessDate: input.businessDate,
      class: "RETRYABLE_PROVIDER_NOT_READY",
      dataMode: null,
      phase: null,
      coverageComplete: false,
      quarantineCount: 0,
      missingEvidence: ["MISSING_OZON_ACCRUAL_DAY_STATUS"],
      reason: "MISSING_STATUS_ROW",
    };
  }

  const financiallyFinal =
    (input.row.dataMode === "FINAL" ||
      input.row.dataMode === "FINAL_WITH_UNCLASSIFIED") &&
    input.row.phase === "CANONICAL" &&
    input.row.coverageComplete === true &&
    Number(input.row.quarantineCount ?? 0) === 0;

  if (financiallyFinal) {
    return {
      companyName: input.companyName,
      businessDate: input.businessDate,
      class: "READY_FINAL",
      dataMode: String(input.row.dataMode),
      phase: String(input.row.phase),
      coverageComplete: true,
      quarantineCount: 0,
      missingEvidence,
      reason:
        input.row.dataMode === "FINAL_WITH_UNCLASSIFIED"
          ? "FINAL_WITH_UNCLASSIFIED"
          : "FINAL_CANONICAL",
    };
  }

  // Monetary-unsafe quarantine only. Analytical UNCLASSIFIED_ADJUSTMENT is not
  // a hard blocker once status is FINAL_WITH_UNCLASSIFIED (handled above).
  if (Number(input.row.quarantineCount ?? 0) > 0) {
    const joined = missingEvidence.join(" ");
    if (/unknown|TYPE_/i.test(joined) && !/UNCLASSIFIED_ADJUSTMENT/i.test(joined)) {
      return {
        companyName: input.companyName,
        businessDate: input.businessDate,
        class: "NONRETRYABLE_UNKNOWN_TYPE",
        dataMode: String(input.row.dataMode ?? ""),
        phase: String(input.row.phase ?? ""),
        coverageComplete: false,
        quarantineCount: Number(input.row.quarantineCount ?? 0),
        missingEvidence,
        reason: joined || "QUARANTINE_UNKNOWN",
      };
    }
  }

  if (input.row.phase === "RAW" || input.row.dataMode === "PRELIMINARY") {
    return {
      companyName: input.companyName,
      businessDate: input.businessDate,
      class: "RETRYABLE_PROVIDER_NOT_READY",
      dataMode: String(input.row.dataMode ?? ""),
      phase: String(input.row.phase ?? ""),
      coverageComplete: input.row.coverageComplete === true,
      quarantineCount: Number(input.row.quarantineCount ?? 0),
      missingEvidence,
      reason: missingEvidence[0] || "OZON_NOT_FINAL",
    };
  }

  return {
    companyName: input.companyName,
    businessDate: input.businessDate,
    class: "RETRYABLE_PARTIAL",
    dataMode: String(input.row.dataMode ?? ""),
    phase: String(input.row.phase ?? ""),
    coverageComplete: input.row.coverageComplete === true,
    quarantineCount: Number(input.row.quarantineCount ?? 0),
    missingEvidence,
    reason: missingEvidence[0] || "OZON_PARTIAL",
  };
}

export function aggregateOwnerOzonReadiness(companies: OzonCompanyReadiness[]): {
  allReady: boolean;
  anyNonRetryable: boolean;
  anyRetryable: boolean;
  worstClass: OzonReadinessClass;
} {
  const allReady = companies.length > 0 && companies.every((c) => c.class === "READY_FINAL");
  const anyNonRetryable = companies.some((c) => isNonRetryableOzonClass(c.class));
  const anyRetryable = companies.some((c) => isRetryableOzonClass(c.class));
  const worstClass = allReady
    ? "READY_FINAL"
    : anyNonRetryable
      ? companies.find((c) => isNonRetryableOzonClass(c.class))!.class
      : anyRetryable
        ? companies.find((c) => isRetryableOzonClass(c.class))!.class
        : "NONRETRYABLE_OTHER";
  return { allReady, anyNonRetryable, anyRetryable, worstClass };
}

/** Moscow-aware next attempt: 30m default; 60m on 429; hourly after 15:00 UTC (=18:00 Moscow). */
export function computeNextRetryAt(params: {
  now?: Date;
  rateLimited?: boolean;
  retryAfterSec?: number | null;
}): Date {
  const now = params.now ?? new Date();
  if (params.rateLimited) {
    const sec =
      params.retryAfterSec != null && Number.isFinite(params.retryAfterSec)
        ? Math.max(60, Number(params.retryAfterSec))
        : 60 * 60;
    return new Date(now.getTime() + sec * 1000);
  }
  const moscowHour = (now.getUTCHours() + 3) % 24;
  const delayMs = moscowHour >= 18 ? 60 * 60 * 1000 : 30 * 60 * 1000;
  return new Date(now.getTime() + delayMs);
}

export function ownerReportIdempotencyKey(businessDate: string) {
  return `tg-ozon-owner-daily|${businessDate}`;
}

export function ownerReportLockKey(businessDate: string) {
  return `lock:tg-ozon-owner-daily|${businessDate}`;
}

export function formatOzonWaitingServiceNotice(
  businessDate: string,
  readiness?: OzonCompanyReadiness[] | null
) {
  const blockers = (readiness ?? [])
    .filter((r) => r.class !== "READY_FINAL")
    .map((r) => {
      if (r.class === "NONRETRYABLE_UNKNOWN_TYPE") {
        const typeMatch = String(r.reason ?? "").match(/typeId["\s:]*(\d+)/i);
        const typePart = typeMatch ? `тип ${typeMatch[1]}` : "неизвестный тип начислений";
        return `${r.companyName}: ${typePart}`;
      }
      if (r.dataMode === "PRELIMINARY" || r.phase === "RAW") {
        return `${r.companyName}: Ozon ещё формирует начисления (${r.phase || r.dataMode || r.class})`;
      }
      return `${r.companyName}: ${r.reason || r.class}`;
    });
  if (blockers.length > 0) {
    return formatOwnerWaitingStatusNotice(
      businessDate,
      "OZON",
      blockers.slice(0, 4).join("\n"),
    );
  }
  return formatOwnerWaitingStatusNotice(businessDate, "OZON");
}

export function formatOzonTechnicalBlockerNotice(businessDate: string, reason: string) {
  const label = formatBusinessDateLabel(businessDate);
  return `⚠️ Сводка за ${label} задерживается из-за технической ошибки. Повторная отправка выполняется автоматически.\n(${String(reason).slice(0, 180)})`;
}

export function formatRecoveredFinalHeader(businessDate: string) {
  const label = formatBusinessDateLabel(businessDate);
  return `✅ Обновлённая финальная сводка за ${label}`;
}

export function formatCogsCompletedFinalHeader(businessDate: string) {
  const label = formatBusinessDateLabel(businessDate);
  return `✅ Уточнённая сводка за ${label} — себестоимость заполнена`;
}

export function emptyDeliveryProvenance(businessDate: string): OwnerReportDeliveryProvenance {
  return {
    reportType: "OWNER_DAILY_V3",
    businessDate,
    deliveryStatus: "PENDING",
    companyReadiness: [],
    lastReason: null,
    lastAttemptAt: null,
    nextAttemptAt: null,
    attemptCount: 0,
    serviceNoticeSentAt: null,
    escalationNoticeSentAt: null,
    preliminarySentAt: null,
    technicalNoticeSentAt: null,
    finalSentAt: null,
    finalMessageIds: [],
    recoveryHeaderUsed: false,
    refreshHttpStatus: null,
    refreshRetryAfterSec: null,
    finalSnapshot: null,
    expectedParts: null,
    chatDeliveries: null,
    lastWatchdogAt: null,
    blocker: null,
  };
}
