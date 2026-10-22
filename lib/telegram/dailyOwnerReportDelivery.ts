import { prisma } from "@/lib/prisma";
import { loadOzonAccrualDayStatuses } from "@/lib/ozon/accrualDayStatusStore";
import {
  acquirePlatformJobRun,
  createPendingJobRunRecord,
  createPrismaJobRunStore,
} from "@/lib/platform/jobs/prismaStore";
import {
  aggregateOwnerOzonReadiness,
  classifyOzonDayStatus,
  computeNextRetryAt,
  emptyDeliveryProvenance,
  formatCogsCompletedFinalHeader,
  formatOwnerEscalationNotice,
  formatOwnerWaitingStatusNotice,
  formatOzonTechnicalBlockerNotice,
  formatOzonWaitingServiceNotice,
  formatRecoveredFinalHeader,
  isPastMoscowEscalationHour,
  isPastMoscowMorningDeadline,
  moscowBusinessYesterday,
  ownerReportIdempotencyKey,
  ownerReportLockKey,
  TELEGRAM_OZON_OWNER_REPORT_JOB_TYPE,
  type OwnerReportDeliveryProvenance,
  type OwnerReportFinalSnapshot,
  type OzonCompanyReadiness,
} from "@/lib/telegram/ozonMorningReportGate";
import { notifyOwnerCogsReminder } from "@/lib/telegram/ownerProductCostFlow";
import {
  isStalePlatformJobRun,
  PLATFORM_JOB_STALE_RUNNING_MS,
} from "@/lib/platform/jobs/prismaStore";
import {
  getTelegramAllowedChatIds,
  sendTelegramMessage,
} from "@/lib/telegram/sendTelegramMessage";
import type { DailyReport } from "@/lib/telegram/dailyReport";
import { asMarketplaceMetricsView } from "@/lib/telegram/dailyReportDisplay";
import {
  evaluateOwnerReportCogsCoverage,
  OWNER_REPORT_FINANCIAL_FORMULA_VERSION,
  OWNER_REPORT_FORMATTER_VERSION,
  summarizeCogsCoverageForSnapshot,
  type OwnerReportCogsCoverageEvidence,
} from "@/lib/telegram/ownerReportCogsCoverage";

const EXPECTED_OZON_COMPANIES = ["ИП Петров", "ИП Лебедева"] as const;

function asProvenance(value: unknown, businessDate: string): OwnerReportDeliveryProvenance {
  if (!value || typeof value !== "object") return emptyDeliveryProvenance(businessDate);
  const raw = value as Partial<OwnerReportDeliveryProvenance>;
  return {
    ...emptyDeliveryProvenance(businessDate),
    ...raw,
    businessDate,
    companyReadiness: Array.isArray(raw.companyReadiness) ? raw.companyReadiness : [],
    finalMessageIds: Array.isArray(raw.finalMessageIds) ? raw.finalMessageIds : [],
    finalSnapshot:
      raw.finalSnapshot && typeof raw.finalSnapshot === "object"
        ? (raw.finalSnapshot as OwnerReportFinalSnapshot)
        : null,
  };
}

export async function captureOwnerReportSourceFingerprint(businessDate: string) {
  const orderDate = new Date(`${businessDate}T00:00:00.000Z`);
  const orders = await prisma.marketplaceDailyOrderStat.findMany({
    where: { orderDate },
    select: {
      companyName: true,
      marketplace: true,
      ordersQty: true,
      ordersAmount: true,
      lastSuccessfulSyncAt: true,
    },
    orderBy: [{ companyName: "asc" }, { marketplace: "asc" }],
  });
  const ozonDays = await loadOzonAccrualDayStatuses({
    companyName: "ALL",
    dateFrom: businessDate,
    dateTo: businessDate,
  });
  const costAgg = await prisma.productCost.aggregate({
    _max: { createdAt: true },
  });
  const mappedOrders = orders.map((o) => ({
    companyName: o.companyName,
    marketplace: o.marketplace,
    ordersQty: Number(o.ordersQty ?? 0),
    ordersAmount: Number(o.ordersAmount ?? 0),
    lastSuccessfulSyncAt: o.lastSuccessfulSyncAt
      ? o.lastSuccessfulSyncAt.toISOString()
      : null,
  }));
  const ordersAsOf =
    mappedOrders
      .map((o) => o.lastSuccessfulSyncAt)
      .filter((v): v is string => Boolean(v))
      .sort()
      .at(-1) ?? null;
  return {
    orders: mappedOrders,
    ordersAsOf,
    ozonDays: EXPECTED_OZON_COMPANIES.map((companyName) => {
      const row = ozonDays.find((d) => d.companyName === companyName && d.date === businessDate);
      return {
        companyName,
        payloadSha256: row?.payloadSha256 ?? null,
        importSessionId: row?.importSessionId ?? null,
        dataMode: row?.dataMode ?? null,
        phase: row?.phase ?? null,
      };
    }),
    productCostCreatedMaxAt: costAgg._max.createdAt
      ? costAgg._max.createdAt.toISOString()
      : null,
    cogsCoverage: null,
  };
}

export function buildOwnerReportFinalSnapshot(params: {
  report: DailyReport;
  message1: string;
  message2: string;
  sourceFingerprint: Awaited<ReturnType<typeof captureOwnerReportSourceFingerprint>>;
  capturedAt?: Date;
  sourceMode?: OwnerReportFinalSnapshot["sourceMode"];
  cogsCoverage?: OwnerReportCogsCoverageEvidence | null;
  canonical?: boolean;
  historicalAuditOnly?: boolean;
  finalSentAt?: string | null;
}): OwnerReportFinalSnapshot {
  const capturedAt = (params.capturedAt ?? new Date()).toISOString();
  const companies: OwnerReportFinalSnapshot["companies"] = [];
  for (const company of params.report.companies) {
    for (const marketplace of ["wb", "ozon"] as const) {
      const m = asMarketplaceMetricsView(company[marketplace]);
      companies.push({
        companyName: company.companyName,
        marketplace: marketplace === "wb" ? "WB" : "OZON",
        ordersQty: Number(m.ordersQty ?? 0),
        ordersAmount: Number(m.ordersAmount ?? 0),
        economicTurnover:
          m.economicTurnover != null
            ? Number(m.economicTurnover)
            : Number(m.salesAmount ?? 0),
        totalCost: m.totalCost != null ? Number(m.totalCost) : null,
        netProfitImpact:
          m.netProfitAfterTax != null ? Number(m.netProfitAfterTax) : null,
        adSpend: Number(m.adSpend ?? 0),
      });
    }
  }
  const cogsSummary = params.cogsCoverage
    ? summarizeCogsCoverageForSnapshot(params.cogsCoverage)
    : params.sourceFingerprint.cogsCoverage ?? null;
  const sourceMode = params.sourceMode ?? "FINAL_SENT_SNAPSHOT";
  const historicalAuditOnly =
    params.historicalAuditOnly === true ||
    sourceMode === "OWNER_TRANSCRIPT_REPLAY" ||
    sourceMode === "OWNER_CONTROL_TRANSCRIPT";
  const canonical =
    params.canonical ??
    (historicalAuditOnly ? false : sourceMode === "FINAL_SENT_SNAPSHOT");
  return {
    capturedAt,
    sourceMode,
    canonical,
    historicalAuditOnly,
    formatterVersion: OWNER_REPORT_FORMATTER_VERSION,
    financialFormulaVersion: OWNER_REPORT_FINANCIAL_FORMULA_VERSION,
    finalSentAt: params.finalSentAt ?? null,
    ordersAsOf: params.sourceFingerprint.ordersAsOf ?? null,
    message1: params.message1,
    message2: params.message2,
    totals: {
      ordersQty: Number(params.report.totals.ordersQty ?? 0),
      ordersAmount: Number(params.report.totals.ordersAmount ?? 0),
      economicTurnover: Number(params.report.totals.economicTurnover ?? 0),
      totalCost:
        params.report.totals.totalCost != null
          ? Number(params.report.totals.totalCost)
          : null,
      netProfitImpact: Number(params.report.totals.netProfitImpact ?? 0),
      adSpend: Number(params.report.totals.adSpend ?? 0),
    },
    companies,
    sourceFingerprint: {
      ...params.sourceFingerprint,
      cogsCoverage: cogsSummary,
    },
  };
}

export async function loadFinalSentSnapshot(
  businessDate: string
): Promise<{ provenance: OwnerReportDeliveryProvenance; snapshot: OwnerReportFinalSnapshot | null }> {
  const state = await loadDeliveryState(businessDate);
  const snapshot =
    state.provenance.deliveryStatus === "FINAL_SENT" && state.provenance.finalSnapshot
      ? state.provenance.finalSnapshot
      : null;
  return { provenance: state.provenance, snapshot };
}

export async function loadOzonCompanyReadiness(businessDate: string): Promise<OzonCompanyReadiness[]> {
  const days = await loadOzonAccrualDayStatuses({
    companyName: "ALL",
    dateFrom: businessDate,
    dateTo: businessDate,
  });
  return EXPECTED_OZON_COMPANIES.map((companyName) => {
    const row = days.find((d) => d.companyName === companyName && d.date === businessDate);
    return classifyOzonDayStatus({ companyName, businessDate, row });
  });
}

export async function refreshOzonExactDayOnMain(businessDate: string): Promise<{
  ok: boolean;
  httpStatus: number;
  retryAfterSec: number | null;
  bodyPreview: string;
  errorMessage: string | null;
}> {
  const base =
    String(process.env.AVOROFIN_MAIN_CRON_BASE_URL ?? "").trim() ||
    String(process.env.NEXT_PUBLIC_SITE_URL ?? "").trim() ||
    "https://ardelo.su";
  const secret = String(process.env.CRON_SECRET ?? "").trim();
  if (!secret) {
    return {
      ok: false,
      httpStatus: 0,
      retryAfterSec: null,
      bodyPreview: "",
      errorMessage: "CRON_SECRET_MISSING",
    };
  }
  const url = `${base.replace(/\/$/, "")}/api/cron/sync-ozon-accruals?date=${encodeURIComponent(businessDate)}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(280_000),
    });
    const retryAfterRaw = res.headers.get("retry-after");
    const retryAfterSec = retryAfterRaw && /^\d+$/.test(retryAfterRaw) ? Number(retryAfterRaw) : null;
    const text = await res.text();
    return {
      ok: res.ok,
      httpStatus: res.status,
      retryAfterSec,
      // Keep enough body for per-company unknown-type extraction.
      bodyPreview: text.slice(0, 8000),
      errorMessage: res.ok ? null : text.slice(0, 4000),
    };
  } catch (error) {
    return {
      ok: false,
      httpStatus: 0,
      retryAfterSec: null,
      bodyPreview: "",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Prefer company-specific sync error from MAIN batch JSON body. */
export function extractCompanyOzonSyncError(
  body: string | null | undefined,
  companyName: string
): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as {
      results?: Array<{ companyName?: string; error?: string | null; ok?: boolean }>;
    };
    const hit = (parsed.results ?? []).find(
      (r) => String(r.companyName ?? "") === companyName && r.error
    );
    if (hit?.error) return String(hit.error);
  } catch {
    // fall through to raw search
  }
  if (/unknown accrual types|unknownMeaningfulTypeIds/i.test(body)) {
    return body.slice(0, 500);
  }
  return null;
}

async function upsertDeliveryState(params: {
  businessDate: string;
  provenance: OwnerReportDeliveryProvenance;
  status: string;
  errorClass?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  nextAttemptAt?: Date | null;
}) {
  const idempotencyKey = ownerReportIdempotencyKey(params.businessDate);
  const lockKey = ownerReportLockKey(params.businessDate);
  const existing = await prisma.jobRun.findUnique({ where: { idempotencyKey } });
  const attempts = Math.max(
    existing?.attempts ?? 0,
    params.provenance.attemptCount,
  );
  await prisma.jobRun.upsert({
    where: { idempotencyKey },
    create: {
      jobType: TELEGRAM_OZON_OWNER_REPORT_JOB_TYPE,
      scope: params.businessDate,
      idempotencyKey,
      fingerprint: idempotencyKey,
      lockKey,
      status: params.status,
      attempts,
      errorClass: params.errorClass ?? null,
      errorCode: params.errorCode ?? null,
      errorMessage: params.errorMessage ?? null,
      provenance: params.provenance as object,
      nextAttemptAt: params.nextAttemptAt ?? null,
    },
    update: {
      status: params.status,
      attempts,
      errorClass: params.errorClass ?? null,
      errorCode: params.errorCode ?? null,
      errorMessage: params.errorMessage ?? null,
      provenance: params.provenance as object,
      nextAttemptAt: params.nextAttemptAt ?? null,
      finishedAt:
        params.status === "SUCCEEDED" || params.status === "FAILED"
          ? new Date()
          : existing?.finishedAt ?? null,
    },
  });
}

export async function loadDeliveryState(businessDate: string) {
  const row = await prisma.jobRun.findUnique({
    where: { idempotencyKey: ownerReportIdempotencyKey(businessDate) },
  });
  return {
    row,
    provenance: asProvenance(row?.provenance, businessDate),
  };
}

async function sendPlainToAllChats(text: string) {
  const chatIds = getTelegramAllowedChatIds();
  const ids: Array<{ chatId: string; messageId: number | string | null }> = [];
  for (const chatId of chatIds) {
    const result = await sendTelegramMessage({ chatId, text });
    ids.push({
      chatId,
      messageId: result?.result?.message_id ?? result?.message_id ?? null,
    });
  }
  return ids;
}

/**
 * Optional one escalation after ~12:00 MSK if FINAL not yet sent.
 * Idempotent via escalationNoticeSentAt (separate from serviceNotice).
 */
async function maybeSendEscalationNotice(params: {
  businessDate: string;
  provenance: OwnerReportDeliveryProvenance;
  now: Date;
}): Promise<{ provenance: OwnerReportDeliveryProvenance; sent: boolean }> {
  if (params.provenance.deliveryStatus === "FINAL_SENT") {
    return { provenance: params.provenance, sent: false };
  }
  if (params.provenance.escalationNoticeSentAt) {
    return { provenance: params.provenance, sent: false };
  }
  if (!isPastMoscowEscalationHour(params.now)) {
    return { provenance: params.provenance, sent: false };
  }
  // Prefer after an initial status was already attempted, or if morning window long passed.
  const hadInitial =
    Boolean(params.provenance.serviceNoticeSentAt) ||
    Boolean(params.provenance.technicalNoticeSentAt) ||
    (params.provenance.attemptCount ?? 0) >= 1;
  if (!hadInitial) {
    return { provenance: params.provenance, sent: false };
  }
  await sendPlainToAllChats(formatOwnerEscalationNotice(params.businessDate));
  return {
    provenance: {
      ...params.provenance,
      escalationNoticeSentAt: params.now.toISOString(),
    },
    sent: true,
  };
}

export type OwnerMorningGateResult =
  | {
      action: "SEND_FINAL";
      businessDate: string;
      readiness: OzonCompanyReadiness[];
      provenance: OwnerReportDeliveryProvenance;
      recoveryHeader: string | null;
      cogs: OwnerReportCogsCoverageEvidence | null;
    }
  | {
      action: "SEND_PRELIMINARY";
      businessDate: string;
      readiness: OzonCompanyReadiness[];
      provenance: OwnerReportDeliveryProvenance;
      cogs: OwnerReportCogsCoverageEvidence;
      reason: "PRELIMINARY_MISSING_COGS";
    }
  | {
      action: "DEFER";
      businessDate: string;
      readiness: OzonCompanyReadiness[];
      provenance: OwnerReportDeliveryProvenance;
      serviceNoticeSent: boolean;
      technicalNoticeSent: boolean;
      reason: string;
    }
  | {
      action: "ALREADY_FINAL_SENT";
      businessDate: string;
      provenance: OwnerReportDeliveryProvenance;
    }
  | {
      action: "ALREADY_PRELIMINARY_SENT";
      businessDate: string;
      readiness: OzonCompanyReadiness[];
      provenance: OwnerReportDeliveryProvenance;
      cogs: OwnerReportCogsCoverageEvidence;
    };

/**
 * Pre-send gate for single-day owner morning report.
 * Never sends incomplete financial final as the final report.
 */
export async function gateOwnerMorningReportSend(params: {
  businessDate: string;
  allowRecoveryHeader?: boolean;
  forceRefresh?: boolean;
  now?: Date;
}): Promise<OwnerMorningGateResult> {
  const now = params.now ?? new Date();
  const store = createPrismaJobRunStore(prisma);
  const pending = createPendingJobRunRecord({
    jobType: TELEGRAM_OZON_OWNER_REPORT_JOB_TYPE,
    scope: params.businessDate,
    idempotencyKey: ownerReportIdempotencyKey(params.businessDate),
    fingerprint: ownerReportIdempotencyKey(params.businessDate),
    lockKey: ownerReportLockKey(params.businessDate),
    provenance: null,
  });
  const acquired = await acquirePlatformJobRun({ store, pending, now });
  if (!acquired.ok) {
    const provenance = asProvenance(acquired.run.provenance, params.businessDate);
    if (
      provenance.deliveryStatus === "FINAL_SENT" ||
      acquired.run.status === "SUCCEEDED"
    ) {
      return { action: "ALREADY_FINAL_SENT", businessDate: params.businessDate, provenance };
    }
    return {
      action: "DEFER",
      businessDate: params.businessDate,
      readiness: provenance.companyReadiness,
      provenance,
      serviceNoticeSent: false,
      technicalNoticeSent: false,
      reason: "IN_FLIGHT_LOCK",
    };
  }

  try {
    const existing = asProvenance(acquired.run.provenance, params.businessDate);
    if (existing.deliveryStatus === "FINAL_SENT") {
      await upsertDeliveryState({
        businessDate: params.businessDate,
        provenance: existing,
        status: "SUCCEEDED",
        nextAttemptAt: null,
      });
      return { action: "ALREADY_FINAL_SENT", businessDate: params.businessDate, provenance: existing };
    }

    let readiness = await loadOzonCompanyReadiness(params.businessDate);
    let agg = aggregateOwnerOzonReadiness(readiness);
    let refreshHttpStatus: number | null = null;
    let refreshRetryAfterSec: number | null = null;

    const shouldRefresh =
      params.forceRefresh === true || !agg.allReady;
    if (shouldRefresh && !agg.allReady) {
      const incompleteCompanies = readiness.filter((c) => c.class !== "READY_FINAL");
      // Exact-day MAIN refresh once per attempt (covers all incomplete accounts).
      if (incompleteCompanies.length > 0) {
        const refresh = await refreshOzonExactDayOnMain(params.businessDate);
        refreshHttpStatus = refresh.httpStatus;
        refreshRetryAfterSec = refresh.retryAfterSec;
        readiness = await loadOzonCompanyReadiness(params.businessDate);
        if (!refresh.ok) {
          // Do not demote companies that already reloaded as READY_FINAL.
          // Batch HTTP 500 often means only one company failed (e.g. unknown type).
          readiness = readiness.map((row) => {
            if (row.class === "READY_FINAL") return row;
            const companyError = extractCompanyOzonSyncError(
              refresh.bodyPreview || refresh.errorMessage,
              row.companyName,
            );
            return classifyOzonDayStatus({
              companyName: row.companyName,
              businessDate: params.businessDate,
              row: {
                dataMode: row.dataMode,
                phase: row.phase,
                coverageComplete: row.coverageComplete,
                quarantineCount: row.quarantineCount,
                missingEvidence: row.missingEvidence,
              },
              refreshError: {
                httpStatus: refresh.httpStatus,
                message:
                  companyError ??
                  refresh.errorMessage ??
                  refresh.bodyPreview,
                retryAfterSec: refresh.retryAfterSec,
              },
            });
          });
        }
        agg = aggregateOwnerOzonReadiness(readiness);
      }
    }

    let provenance: OwnerReportDeliveryProvenance = {
      ...existing,
      companyReadiness: readiness,
      lastAttemptAt: now.toISOString(),
      attemptCount: Math.max(existing.attemptCount, acquired.run.attempts) + 1,
      refreshHttpStatus,
      refreshRetryAfterSec,
      lastReason: agg.allReady
        ? "READY_FINAL"
        : readiness.map((r) => `${r.companyName}:${r.class}`).join(";"),
    };

    if (agg.allReady) {
      const cogs = await evaluateOwnerReportCogsCoverage(params.businessDate);
      const preliminaryAlreadySent =
        existing.deliveryStatus === "PRELIMINARY_MISSING_COGS_SENT" ||
        Boolean(existing.preliminarySentAt);

      if (!cogs.coverageComplete) {
        provenance.blocker = "PRODUCT_COST_COGS";
        // First numeric morning report with missing COGS — do not block.
        if (!preliminaryAlreadySent) {
          provenance.deliveryStatus = "PRELIMINARY_MISSING_COGS";
          provenance.lastReason = "PRELIMINARY_MISSING_COGS";
          provenance.nextAttemptAt = null;
          await upsertDeliveryState({
            businessDate: params.businessDate,
            provenance,
            status: "RUNNING",
            errorClass: "RETRYABLE",
            errorCode: "PRELIMINARY_MISSING_COGS",
            errorMessage: `unresolvedSku=${cogs.unresolvedSkuCount};unresolvedQty=${cogs.unresolvedQty}`,
            nextAttemptAt: null,
          });
          return {
            action: "SEND_PRELIMINARY",
            businessDate: params.businessDate,
            readiness,
            provenance,
            cogs,
            reason: "PRELIMINARY_MISSING_COGS",
          };
        }

        // Preliminary already sent — keep retrying until COGS complete; no resend.
        let serviceNoticeSent = false;
        if (
          isPastMoscowEscalationHour(now) &&
          !existing.escalationNoticeSentAt &&
          !provenance.escalationNoticeSentAt
        ) {
          await notifyOwnerCogsReminder({
            businessDate: params.businessDate,
            unresolvedSkuCount: cogs.unresolvedSkuCount,
          });
          provenance.escalationNoticeSentAt = now.toISOString();
          serviceNoticeSent = true;
        }
        const nextAttemptAt = computeNextRetryAt({ now, rateLimited: false });
        provenance.deliveryStatus = "PRELIMINARY_MISSING_COGS_SENT";
        provenance.lastReason = "WAITING_REMAINING_PRODUCT_COST";
        provenance.nextAttemptAt = nextAttemptAt.toISOString();
        await upsertDeliveryState({
          businessDate: params.businessDate,
          provenance,
          status: "PENDING",
          errorClass: "RETRYABLE",
          errorCode: "WAITING_REMAINING_PRODUCT_COST",
          errorMessage: `unresolvedSku=${cogs.unresolvedSkuCount};unresolvedQty=${cogs.unresolvedQty}`,
          nextAttemptAt,
        });
        return {
          action: "ALREADY_PRELIMINARY_SENT",
          businessDate: params.businessDate,
          readiness,
          provenance,
          cogs,
        };
      }

      const fromPreliminary =
        preliminaryAlreadySent ||
        existing.deliveryStatus === "PRELIMINARY_MISSING_COGS" ||
        existing.deliveryStatus === "PRELIMINARY_MISSING_COGS_SENT" ||
        existing.deliveryStatus === "WAITING_PRODUCT_COST_COVERAGE";
      const needsRecoveryHeader =
        params.allowRecoveryHeader === true ||
        existing.deliveryStatus === "WAITING_OZON" ||
        existing.deliveryStatus === "SERVICE_NOTICE_SENT" ||
        existing.deliveryStatus === "TECHNICAL_BLOCKER_SENT" ||
        Boolean(existing.serviceNoticeSentAt) ||
        fromPreliminary;
      const recoveryHeader = fromPreliminary
        ? formatCogsCompletedFinalHeader(params.businessDate)
        : needsRecoveryHeader
          ? formatRecoveredFinalHeader(params.businessDate)
          : null;
      // Keep RUNNING until caller marks FINAL_SENT after successful send.
      provenance.deliveryStatus = "READY_TO_FINAL_SEND";
      provenance.lastReason = "READY_TO_FINAL_SEND";
      provenance.blocker = null;
      provenance.nextAttemptAt = null;
      await upsertDeliveryState({
        businessDate: params.businessDate,
        provenance: { ...provenance, deliveryStatus: "READY_TO_FINAL_SEND" },
        status: "RUNNING",
        nextAttemptAt: null,
      });
      return {
        action: "SEND_FINAL",
        businessDate: params.businessDate,
        readiness,
        provenance,
        recoveryHeader,
        cogs,
      };
    }

    if (agg.anyNonRetryable) {
      let technicalNoticeSent = false;
      provenance.blocker = "PIPELINE_ERROR";
      if (!existing.technicalNoticeSentAt) {
        await sendPlainToAllChats(
          formatOzonTechnicalBlockerNotice(params.businessDate, provenance.lastReason || agg.worstClass),
        );
        provenance.technicalNoticeSentAt = now.toISOString();
        technicalNoticeSent = true;
      }
      const escalated = await maybeSendEscalationNotice({
        businessDate: params.businessDate,
        provenance,
        now,
      });
      provenance = escalated.provenance;
      const nextAttemptAt = computeNextRetryAt({ now, rateLimited: false });
      // Low-frequency recovery check after repair.
      provenance.deliveryStatus = "TECHNICAL_BLOCKER_SENT";
      provenance.nextAttemptAt = nextAttemptAt.toISOString();
      await upsertDeliveryState({
        businessDate: params.businessDate,
        provenance,
        status: "FAILED",
        errorClass: "FAIL_CLOSED",
        errorCode: agg.worstClass,
        errorMessage: provenance.lastReason,
        nextAttemptAt,
      });
      return {
        action: "DEFER",
        businessDate: params.businessDate,
        readiness,
        provenance,
        serviceNoticeSent: false,
        technicalNoticeSent,
        reason: provenance.lastReason || agg.worstClass,
      };
    }

    // Retryable incomplete
    let serviceNoticeSent = false;
    provenance.blocker = "OZON";
    if (!existing.serviceNoticeSentAt) {
      await sendPlainToAllChats(
        formatOzonWaitingServiceNotice(params.businessDate, readiness),
      );
      provenance.serviceNoticeSentAt = now.toISOString();
      serviceNoticeSent = true;
    }
    const escalated = await maybeSendEscalationNotice({
      businessDate: params.businessDate,
      provenance,
      now,
    });
    provenance = escalated.provenance;
    const rateLimited = readiness.some((r) => r.class === "RETRYABLE_RATE_LIMIT");
    const nextAttemptAt = computeNextRetryAt({
      now,
      rateLimited,
      retryAfterSec: refreshRetryAfterSec,
    });
    provenance.deliveryStatus = serviceNoticeSent || existing.serviceNoticeSentAt
      ? "SERVICE_NOTICE_SENT"
      : "WAITING_OZON";
    provenance.nextAttemptAt = nextAttemptAt.toISOString();
    await upsertDeliveryState({
      businessDate: params.businessDate,
      provenance,
      status: "PENDING",
      errorClass: "RETRYABLE",
      errorCode: agg.worstClass,
      errorMessage: provenance.lastReason,
      nextAttemptAt,
    });

    return {
      action: "DEFER",
      businessDate: params.businessDate,
      readiness,
      provenance,
      serviceNoticeSent,
      technicalNoticeSent: false,
      reason: provenance.lastReason || agg.worstClass,
    };
  } catch (error) {
    await upsertDeliveryState({
      businessDate: params.businessDate,
      provenance: {
        ...emptyDeliveryProvenance(params.businessDate),
        lastAttemptAt: now.toISOString(),
        lastReason: error instanceof Error ? error.message : String(error),
        deliveryStatus: "WAITING_OZON",
        nextAttemptAt: computeNextRetryAt({ now }).toISOString(),
        attemptCount: 1,
      },
      status: "PENDING",
      errorClass: "RETRYABLE",
      errorCode: "GATE_EXCEPTION",
      errorMessage: error instanceof Error ? error.message : String(error),
      nextAttemptAt: computeNextRetryAt({ now }),
    });
    throw error;
  }
}

export async function markOwnerMorningPreliminarySent(params: {
  businessDate: string;
  provenance: OwnerReportDeliveryProvenance;
  messageIds: Array<{ chatId: string; messageId: number | string | null }>;
  cogs: OwnerReportCogsCoverageEvidence;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const nextAttemptAt = computeNextRetryAt({ now, rateLimited: false });
  const provenance: OwnerReportDeliveryProvenance = {
    ...params.provenance,
    deliveryStatus: "PRELIMINARY_MISSING_COGS_SENT",
    preliminarySentAt: now.toISOString(),
    finalMessageIds: params.messageIds,
    lastReason: "PRELIMINARY_MISSING_COGS_SENT",
    blocker: "PRODUCT_COST_COGS",
    nextAttemptAt: nextAttemptAt.toISOString(),
  };
  await upsertDeliveryState({
    businessDate: params.businessDate,
    provenance,
    status: "PENDING",
    errorClass: "RETRYABLE",
    errorCode: "WAITING_REMAINING_PRODUCT_COST",
    errorMessage: `unresolvedSku=${params.cogs.unresolvedSkuCount};unresolvedQty=${params.cogs.unresolvedQty}`,
    nextAttemptAt,
  });
  return provenance;
}

export async function markOwnerMorningFinalSent(params: {
  businessDate: string;
  provenance: OwnerReportDeliveryProvenance;
  messageIds: Array<{ chatId: string; messageId: number | string | null }>;
  recoveryHeaderUsed: boolean;
  finalSnapshot?: OwnerReportFinalSnapshot | null;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const provenance: OwnerReportDeliveryProvenance = {
    ...params.provenance,
    deliveryStatus: "FINAL_SENT",
    finalSentAt: now.toISOString(),
    finalMessageIds: params.messageIds,
    recoveryHeaderUsed: params.recoveryHeaderUsed,
    nextAttemptAt: null,
    lastReason: "FINAL_SENT",
    finalSnapshot: params.finalSnapshot ?? params.provenance.finalSnapshot ?? null,
  };
  await upsertDeliveryState({
    businessDate: params.businessDate,
    provenance,
    status: "SUCCEEDED",
    nextAttemptAt: null,
  });
  return provenance;
}

export async function listDueOwnerMorningRetries(now = new Date()) {
  const rows = await prisma.jobRun.findMany({
    where: {
      jobType: TELEGRAM_OZON_OWNER_REPORT_JOB_TYPE,
      status: { in: ["PENDING", "FAILED", "RATE_LIMITED"] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { updatedAt: "asc" },
    take: 20,
  });
  return rows.filter((row) => {
    const provenance = asProvenance(row.provenance, row.scope);
    return provenance.deliveryStatus !== "FINAL_SENT";
  });
}

const WATCHDOG_STALL_MS = 60 * 60 * 1000;

/**
 * Ensure a delivery JobRun exists for businessDate (idempotent).
 * Used when morning cron was missed and no JobRun was created.
 */
export async function ensureOwnerMorningDeliveryJob(businessDate: string, now = new Date()) {
  const existing = await loadDeliveryState(businessDate);
  if (existing.row && existing.provenance.deliveryStatus === "FINAL_SENT") {
    return { created: false, requeued: false, businessDate, status: "FINAL_SENT" as const };
  }
  if (existing.row) {
    return {
      created: false,
      requeued: false,
      businessDate,
      status: existing.row.status,
      deliveryStatus: existing.provenance.deliveryStatus,
    };
  }
  const provenance = emptyDeliveryProvenance(businessDate);
  provenance.lastReason = "WATCHDOG_ENSURE_JOB";
  provenance.lastWatchdogAt = now.toISOString();
  provenance.nextAttemptAt = now.toISOString();
  await upsertDeliveryState({
    businessDate,
    provenance,
    status: "PENDING",
    errorClass: "RETRYABLE",
    errorCode: "WATCHDOG_ENSURE_JOB",
    errorMessage: "created by delivery watchdog after missed morning attempt",
    nextAttemptAt: now,
  });
  return { created: true, requeued: true, businessDate, status: "PENDING" as const };
}

/**
 * Lightweight delivery watchdog: no silent miss after morning deadline.
 * - FINAL_SENT => noop
 * - missing JobRun => create + due now
 * - stale RUNNING => reclaim (via acquire on next gate; also force PENDING here)
 * - no progress >60m => requeue existing retry once
 */
export async function runOwnerMorningDeliveryWatchdog(now = new Date()) {
  const actions: Array<Record<string, unknown>> = [];
  if (!isPastMoscowMorningDeadline(now)) {
    return {
      ok: true,
      skipped: true,
      reason: "BEFORE_MORNING_DEADLINE",
      actions,
    };
  }

  const businessDate = moscowBusinessYesterday(now);
  const ensured = await ensureOwnerMorningDeliveryJob(businessDate, now);
  actions.push({ kind: "ENSURE", ...ensured });

  const state = await loadDeliveryState(businessDate);
  if (state.provenance.deliveryStatus === "FINAL_SENT") {
    actions.push({ kind: "SKIP_FINAL", businessDate });
    return { ok: true, businessDate, actions };
  }

  const row = state.row;
  if (!row) {
    return { ok: true, businessDate, actions };
  }

  // Stale RUNNING reclaim into PENDING so listDue / gate can proceed.
  const staleProbe = {
    status: row.status as "RUNNING" | "PENDING" | "FAILED" | "SUCCEEDED" | "RATE_LIMITED",
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
  };
  if (row.status === "RUNNING" && isStalePlatformJobRun(staleProbe, now, PLATFORM_JOB_STALE_RUNNING_MS)) {
    const provenance: OwnerReportDeliveryProvenance = {
      ...state.provenance,
      lastWatchdogAt: now.toISOString(),
      lastReason: "WATCHDOG_STALE_RUNNING_RECLAIM",
      nextAttemptAt: now.toISOString(),
      blocker: state.provenance.blocker ?? "INTERNAL",
    };
    await upsertDeliveryState({
      businessDate,
      provenance,
      status: "PENDING",
      errorClass: "RETRYABLE",
      errorCode: "STALE_RUNNING_RECLAIMED",
      errorMessage: "watchdog reclaimed stale RUNNING",
      nextAttemptAt: now,
    });
    actions.push({ kind: "RECLAIM_STALE_RUNNING", businessDate });
    return { ok: true, businessDate, actions };
  }

  const lastProgressMs = Math.max(
    state.provenance.lastAttemptAt
      ? new Date(state.provenance.lastAttemptAt).getTime()
      : 0,
    row.updatedAt ? new Date(row.updatedAt).getTime() : 0,
    state.provenance.lastWatchdogAt
      ? new Date(state.provenance.lastWatchdogAt).getTime()
      : 0,
  );
  const stalled =
    !Number.isFinite(lastProgressMs) ||
    lastProgressMs <= 0 ||
    now.getTime() - lastProgressMs >= WATCHDOG_STALL_MS;

  const nextDue =
    !row.nextAttemptAt || new Date(row.nextAttemptAt).getTime() <= now.getTime();

  if (stalled && !nextDue) {
    const provenance: OwnerReportDeliveryProvenance = {
      ...state.provenance,
      lastWatchdogAt: now.toISOString(),
      lastReason: "WATCHDOG_REQUEUE_STALLED",
      nextAttemptAt: now.toISOString(),
    };
    await upsertDeliveryState({
      businessDate,
      provenance,
      status: row.status === "RUNNING" ? "PENDING" : row.status,
      errorClass: row.errorClass ?? "RETRYABLE",
      errorCode: row.errorCode ?? "WATCHDOG_REQUEUE",
      errorMessage: row.errorMessage ?? "watchdog requeued stalled delivery",
      nextAttemptAt: now,
    });
    actions.push({ kind: "REQUEUE_STALLED", businessDate });
  } else if (!stalled) {
    actions.push({
      kind: "LEAVE_RETRY",
      businessDate,
      nextAttemptAt: row.nextAttemptAt,
    });
  } else {
    actions.push({ kind: "ALREADY_DUE", businessDate });
  }

  // Escalation-only pass if stalled past noon and status already sent.
  if (
    isPastMoscowEscalationHour(now) &&
    !state.provenance.escalationNoticeSentAt &&
    (state.provenance.serviceNoticeSentAt || state.provenance.technicalNoticeSentAt)
  ) {
    const escalated = await maybeSendEscalationNotice({
      businessDate,
      provenance: {
        ...state.provenance,
        lastWatchdogAt: now.toISOString(),
      },
      now,
    });
    if (escalated.sent) {
      await upsertDeliveryState({
        businessDate,
        provenance: escalated.provenance,
        status: row.status === "SUCCEEDED" ? "PENDING" : row.status,
        nextAttemptAt: row.nextAttemptAt ? new Date(row.nextAttemptAt) : now,
      });
      actions.push({ kind: "ESCALATION_SENT", businessDate });
    }
  }

  return { ok: true, businessDate, actions };
}
