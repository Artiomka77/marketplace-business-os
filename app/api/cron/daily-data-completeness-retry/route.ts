import { NextResponse } from "next/server";
import {
  cronAuthorizationHeader,
  rejectUnauthorizedCron,
} from "@/lib/security/cronAuth";

import { prisma } from "@/lib/prisma";
import {
  buildCompletenessJobRecord,
  planCompletenessSelfHeal,
  snapshotFromMissingReasons,
} from "@/lib/platform/completeness/watchdog";
import { buildExactPeriodHealScope } from "@/lib/platform/completeness/exactPeriodHeal";
import {
  acquirePlatformJobRun,
  createPendingJobRunRecord,
  createPrismaJobRunStore,
  finishPlatformJobRun,
  PLATFORM_JOBS_SCHEMA_VERSION,
} from "@/lib/platform/jobs";
import { buildDailyReport } from "@/lib/telegram/dailyReport";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// DAILY_DATA_COMPLETENESS_RETRY_V1:
// Watchdog for owner-report data completeness.
// It scans recent closed days and reruns daily-priority sync for the first incomplete dates.
// This keeps trying on every cron run until orders, Ozon economic totals/tax revenue/points,
// WB sales/finance and ads-related daily inputs are loaded.

const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_MAX_DATES_PER_RUN = 1;
const MAX_WINDOW_DAYS = 30;
const MAX_DATES_PER_RUN = 3;
const DAILY_PRIORITY_TIMEOUT_MS = 180_000;

type MissingReason = {
  companyName?: string;
  marketplace?: "WB" | "OZON" | "ALL";
  dataType: string;
  message: string;
};

type DateCheckResult = {
  date: string;
  complete: boolean;
  missingReasons: MissingReason[];
  syncAttempted: boolean;
  syncOk: boolean | null;
  syncStatus: number | null;
  syncError: string | null;
  ozonExactDateAttempt?: string | null;
  ozonRepair?: {
    httpStatus: number;
    ok: boolean | null;
    partial: boolean | null;
    results: Array<{
      companyName?: string;
      ok?: boolean;
      sourceReadiness?: string;
      ingestStatus?: string;
      coverageComplete?: boolean;
      legacyFinanceStep?: unknown;
      byDayCanonicalStep?: unknown;
      error?: string;
    }>;
  } | null;
  before?: {
    ordersLoadedDays: number;
    ordersExpectedDays: number;
    warnings: string[];
  };
  after?: {
    complete: boolean;
    missingReasons: MissingReason[];
    ordersLoadedDays: number;
    ordersExpectedDays: number;
    warnings: string[];
  };
};

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function parsePositiveInteger(
  value: string | null,
  defaultValue: number,
  minValue: number,
  maxValue: number
) {
  if (!value) return defaultValue;

  const number = Number(value);

  if (!Number.isInteger(number)) {
    throw new Error(`Параметр должен быть целым числом: ${value}`);
  }

  return Math.min(Math.max(number, minValue), maxValue);
}

function parseBoolean(value: string | null, defaultValue = false) {
  if (value === null) return defaultValue;

  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;

  return defaultValue;
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);

  return result;
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getYesterdayMoscowDate() {
  const moscowNow = new Date(Date.now() + 3 * 60 * 60 * 1000);

  return new Date(
    Date.UTC(
      moscowNow.getUTCFullYear(),
      moscowNow.getUTCMonth(),
      moscowNow.getUTCDate() - 1
    )
  );
}

function buildDatesToCheck(windowDays: number) {
  const yesterday = startOfUtcDay(getYesterdayMoscowDate());

  return Array.from({ length: windowDays }, (_, index) =>
    formatDateOnly(addUtcDays(yesterday, -index))
  );
}

function hasMissingMarketplaceMetrics(
  metric: {
    ordersDataMissing: boolean;
    ordersDataIncomplete: boolean;
    ordersDataMissingReason: string | null;
    salesDataMissing: boolean;
    salesDataMissingReason: string | null;
    adDataMissing: boolean;
    adDataMissingReason: string | null;
    taxRevenueCoverageComplete?: boolean;
    discountPointsCoverageComplete?: boolean;
    taxRevenueMissingDays?: string[];
    discountPointsMissingDays?: string[];
    ozonEconomicsWarning?: string | null;
    financialUnavailable?: boolean;
  },
  companyName: string,
  marketplace: "WB" | "OZON"
): MissingReason[] {
  const reasons: MissingReason[] = [];

  if (metric.ordersDataMissing || metric.ordersDataIncomplete) {
    reasons.push({
      companyName,
      marketplace,
      dataType: "ORDERS",
      message:
        metric.ordersDataMissingReason ??
        `${marketplace} заказы загружены неполностью`,
    });
  }

  if (metric.salesDataMissing) {
    reasons.push({
      companyName,
      marketplace,
      dataType: "SALES",
      message:
        metric.salesDataMissingReason ??
        `${marketplace} продажи/начисления загружены неполностью`,
    });
  }

  if (metric.adDataMissing) {
    reasons.push({
      companyName,
      marketplace,
      dataType: "ADS",
      message:
        metric.adDataMissingReason ??
        `${marketplace} рекламные расходы загружены неполностью`,
    });
  }

  if (
    marketplace === "OZON" &&
    (metric.financialUnavailable ||
      metric.ozonEconomicsWarning ||
      metric.taxRevenueCoverageComplete === false ||
      metric.discountPointsCoverageComplete === false)
  ) {
    const missingTaxDays = metric.taxRevenueMissingDays?.length
      ? ` Нет налоговой выручки за дни: ${metric.taxRevenueMissingDays.join(", ")}.`
      : "";
    const missingPointDays = metric.discountPointsMissingDays?.length
      ? ` Нет баллов за дни: ${metric.discountPointsMissingDays.join(", ")}.`
      : "";

    reasons.push({
      companyName,
      marketplace,
      dataType: "OZON_ECONOMIC_TOTALS",
      message:
        (metric.ozonEconomicsWarning ??
          "налоговая выручка / баллы Ozon неполные") +
        missingTaxDays +
        missingPointDays,
    });
  }

  return reasons;
}

async function checkDateCompleteness(date: string) {
  const report = await buildDailyReport({
    date,
    skipComparison: true,
  });

  const missingReasons: MissingReason[] = [];

  if (report.totals.orderDataLoadedDays < report.totals.orderDataExpectedDays) {
    missingReasons.push({
      marketplace: "ALL",
      dataType: "ORDERS_TOTAL_COVERAGE",
      message: `Заказы загружены частично: ${report.totals.orderDataLoadedDays} из ${report.totals.orderDataExpectedDays} дневных срезов`,
    });
  }

  for (const company of report.companies) {
    missingReasons.push(
      ...hasMissingMarketplaceMetrics(company.wb, company.companyName, "WB"),
      ...hasMissingMarketplaceMetrics(company.ozon, company.companyName, "OZON")
    );
  }

  return {
    complete: missingReasons.length === 0,
    missingReasons,
    ordersLoadedDays: report.totals.orderDataLoadedDays,
    ordersExpectedDays: report.totals.orderDataExpectedDays,
    warnings: report.warnings,
  };
}

async function runInternalCron(
  req: Request,
  pathname: string,
  search?: Record<string, string>,
) {
  const requestOrigin = new URL(req.url).origin;
  const internalOrigin =
    process.env.AVOROFIN_INTERNAL_CRON_ORIGIN ??
    process.env.INTERNAL_CRON_ORIGIN ??
    "http://127.0.0.1:3000";
  const syncUrl = new URL(pathname, internalOrigin || requestOrigin);
  if (search) {
    for (const [key, value] of Object.entries(search)) {
      syncUrl.searchParams.set(key, value);
    }
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DAILY_PRIORITY_TIMEOUT_MS);
  try {
    return await fetch(syncUrl, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "x-avorofin-source": "daily-data-completeness-retry",
        ...cronAuthorizationHeader(),
      },
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runDailyPrioritySync(req: Request, date: string) {
  // DAILY_DATA_COMPLETENESS_RETRY_INTERNAL_FETCH_V1:
  // From inside the app container, fetching the public https origin can fail.
  // Use local Next.js origin for the retry call; cron/public URL stays unchanged.
  const requestOrigin = new URL(req.url).origin;
  const internalOrigin =
    process.env.AVOROFIN_INTERNAL_CRON_ORIGIN ??
    process.env.INTERNAL_CRON_ORIGIN ??
    "http://127.0.0.1:3000";
  const syncUrl = new URL(
    "/api/cron/daily-priority-sync",
    internalOrigin || requestOrigin
  );
  syncUrl.searchParams.set("date", date);
  syncUrl.searchParams.set("source", "daily-data-completeness-retry");

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    DAILY_PRIORITY_TIMEOUT_MS
  );

  try {
    const response = await fetch(syncUrl, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "x-avorofin-source": "daily-data-completeness-retry",
        ...cronAuthorizationHeader(),
      },
    });
    const text = await response.text().catch(() => "");

    return {
      ok: response.ok,
      status: response.status,
      body: text.slice(0, 2_000),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function GET(req: Request) {
  const cronDenied = rejectUnauthorizedCron(req);
  if (cronDenied) return cronDenied;
  try {
    const url = new URL(req.url);
    const windowDays = parsePositiveInteger(
      url.searchParams.get("windowDays"),
      DEFAULT_WINDOW_DAYS,
      1,
      MAX_WINDOW_DAYS
    );
    const maxDates = parsePositiveInteger(
      url.searchParams.get("maxDates"),
      DEFAULT_MAX_DATES_PER_RUN,
      0,
      MAX_DATES_PER_RUN
    );
    const dryRun = parseBoolean(url.searchParams.get("dryRun"), false);
    const explicitDate = url.searchParams.get("date");

    if (explicitDate && !/^\d{4}-\d{2}-\d{2}$/.test(explicitDate)) {
      throw new Error("date должен быть в формате YYYY-MM-DD");
    }

    const dates = explicitDate ? [explicitDate] : buildDatesToCheck(windowDays);
    const results: DateCheckResult[] = [];
    let syncAttempts = 0;

    for (const date of dates) {
      const before = await checkDateCompleteness(date);

      const item: DateCheckResult = {
        date,
        complete: before.complete,
        missingReasons: before.missingReasons,
        syncAttempted: false,
        syncOk: null,
        syncStatus: null,
        syncError: null,
        before: {
          ordersLoadedDays: before.ordersLoadedDays,
          ordersExpectedDays: before.ordersExpectedDays,
          warnings: before.warnings,
        },
      };

      if (!before.complete && !dryRun && syncAttempts < maxDates) {
        item.syncAttempted = true;
        syncAttempts += 1;

        {
          const snapshot = snapshotFromMissingReasons({
            missingReasons: before.missingReasons,
            date,
          });
          const heal = planCompletenessSelfHeal(snapshot);
          const job = buildCompletenessJobRecord({ date, snapshot, plan: heal });
          const exactScope = buildExactPeriodHealScope({
            missingDate: date,
            plan: heal,
          });
          const store = createPrismaJobRunStore(prisma);
          const pending = createPendingJobRunRecord({
            jobType: job.jobType,
            scope: job.scope,
            idempotencyKey: job.idempotencyKey,
            fingerprint: job.fingerprint,
            lockKey: job.lockKey,
            provenance: {
              schemaVersion: PLATFORM_JOBS_SCHEMA_VERSION,
              source: "platform-jobs",
              mode: "legacy",
              actor: "daily-data-completeness-retry",
              stage: "platform-core-v1-stage-1a",
              observedOnly: false,
              marketplaceExecuted: true,
            },
          });

          let run = null as Awaited<
            ReturnType<typeof acquirePlatformJobRun>
          >["run"] | null;

          try {
            const acquired = await acquirePlatformJobRun({ store, pending });
            run = acquired.run;
            if (!acquired.ok) {
              item.syncOk = false;
              item.syncError = `JobRun ${acquired.reason} for completeness scope`;
            } else {
              if (exactScope.dailyOperationalDate) {
                const syncResult = await runDailyPrioritySync(
                  req,
                  exactScope.dailyOperationalDate,
                );
                item.syncOk = syncResult.ok;
                item.syncStatus = syncResult.status;
                if (!syncResult.ok) {
                  item.syncError =
                    syncResult.body || `HTTP ${syncResult.status}`;
                }
              }

              if (exactScope.wbWeek) {
                await runInternalCron(req, "/api/cron/finalize-wb-closed-week", {
                  dateFrom: exactScope.wbWeek.dateFrom,
                  dateTo: exactScope.wbWeek.dateTo,
                });
              }

              if (exactScope.ozonExactDate) {
                const day = exactScope.ozonExactDate;
                item.ozonExactDateAttempt = day;
                const ozonResponse = await runInternalCron(
                  req,
                  "/api/cron/sync-ozon-accruals",
                  {
                    date: day,
                  },
                );
                const ozonStatus = ozonResponse.status;
                let ozonBody: {
                  ok?: boolean;
                  partial?: boolean;
                  results?: Array<Record<string, unknown>>;
                  error?: string;
                } | null = null;
                try {
                  ozonBody = (await ozonResponse.json()) as {
                    ok?: boolean;
                    partial?: boolean;
                    results?: Array<Record<string, unknown>>;
                    error?: string;
                  };
                } catch {
                  ozonBody = null;
                }

                const companyResults = (ozonBody?.results ?? []).map(
                  (row) => ({
                    companyName:
                      typeof row.companyName === "string"
                        ? row.companyName
                        : undefined,
                    ok: typeof row.ok === "boolean" ? row.ok : undefined,
                    sourceReadiness:
                      typeof row.sourceReadiness === "string"
                        ? row.sourceReadiness
                        : undefined,
                    ingestStatus:
                      typeof row.ingestStatus === "string"
                        ? row.ingestStatus
                        : undefined,
                    coverageComplete:
                      typeof row.coverageComplete === "boolean"
                        ? row.coverageComplete
                        : undefined,
                    legacyFinanceStep: row.legacyFinanceStep,
                    byDayCanonicalStep: row.byDayCanonicalStep,
                    error:
                      typeof row.error === "string" ? row.error : undefined,
                  }),
                );

                item.ozonRepair = {
                  httpStatus: ozonStatus,
                  ok: typeof ozonBody?.ok === "boolean" ? ozonBody.ok : null,
                  partial:
                    typeof ozonBody?.partial === "boolean"
                      ? ozonBody.partial
                      : null,
                  results: companyResults,
                };

                const ozonCompaniesFailed = companyResults.some(
                  (row) => row.ok === false,
                );
                if (!ozonResponse.ok || ozonCompaniesFailed) {
                  item.syncOk = false;
                  item.syncStatus = ozonStatus;
                  item.syncError =
                    ozonBody?.error ||
                    companyResults
                      .filter((row) => row.ok === false)
                      .map((row) => `${row.companyName}: ${row.error ?? "FAILED"}`)
                      .join("; ") ||
                    `Ozon accrual repair HTTP ${ozonStatus}`;
                } else if (item.syncOk === null) {
                  item.syncOk = true;
                  item.syncStatus = ozonStatus;
                }
              }

              const after = await checkDateCompleteness(date);
              item.complete = after.complete;
              item.missingReasons = after.missingReasons;
              item.after = {
                complete: after.complete,
                missingReasons: after.missingReasons,
                ordersLoadedDays: after.ordersLoadedDays,
                ordersExpectedDays: after.ordersExpectedDays,
                warnings: after.warnings,
              };

              await finishPlatformJobRun({
                store,
                run,
                ok: after.complete,
                retryable: !after.complete,
                errorCode: after.complete ? null : "COMPLETENESS_INCOMPLETE",
                errorMessage: after.complete
                  ? null
                  : item.syncError ||
                    after.missingReasons
                      .map((reason) => reason.message)
                      .filter(Boolean)
                      .slice(0, 3)
                      .join("; ") ||
                    "completeness still incomplete",
              });
            }
          } catch (error) {
            item.syncOk = false;
            item.syncError = getErrorMessage(error);
            if (run && run.status === "RUNNING") {
              // Critical finish persistence must not be swallowed.
              await finishPlatformJobRun({
                store,
                run,
                ok: false,
                retryable: true,
                errorCode: "COMPLETENESS_EXCEPTION",
                errorMessage: item.syncError,
              });
            }
            throw error;
          }
        }
      }

      results.push(item);
    }

    const incompleteDates = results.filter((item) => !item.complete);

    return NextResponse.json({
      ok: incompleteDates.length === 0,
      mode: "daily-data-completeness-retry",
      dryRun,
      windowDays,
      maxDates,
      syncAttempts,
      checkedDates: dates,
      incompleteDates: incompleteDates.map((item) => item.date),
      results,
      executedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        mode: "daily-data-completeness-retry",
        error: getErrorMessage(error),
        executedAt: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
