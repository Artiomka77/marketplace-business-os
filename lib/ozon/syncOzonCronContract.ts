export type OzonCronWorkStatus = "completed" | "skipped" | "failed";

export type OzonCronResult = {
  companyId: string;
  ok: boolean;
  skipped: boolean;
  status: OzonCronWorkStatus;
  retryable: boolean;
  reason: string | null;
  message: string | null;
  results?: unknown;
  error?: string | null;
  mode?: string;
  ownedDomains?: string[];
  deferredDomains?: string[];
};

export type OzonCronHttpContract = {
  success: boolean;
  httpStatus: 200 | 503 | 500;
  retryable: boolean;
  completedCompanies: number;
  skippedCompanies: number;
  failedCompanies: number;
};

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Неизвестная ошибка";
}

export function isOzonRateLimitText(value: unknown) {
  const text = getErrorMessage(value).toLowerCase();

  return (
    text.includes("429") ||
    text.includes("rate limit") ||
    text.includes("rate exceeded") ||
    text.includes("too many requests")
  );
}

export function historicalSyncSkipResult(
  companyId: string,
  activeHistoricalJobs: number
): OzonCronResult {
  return {
    companyId,
    ok: false,
    skipped: true,
    status: "skipped",
    retryable: true,
    reason: "OZON_HISTORICAL_SYNC_ACTIVE",
    message: `Ежедневная синхронизация Ozon пропущена: сейчас идёт историческая загрузка Ozon. Осталось задач: ${activeHistoricalJobs}.`,
    error: null,
  };
}

export function rateLimitCooldownSkipResult(companyId: string): OzonCronResult {
  return {
    companyId,
    ok: false,
    skipped: true,
    status: "skipped",
    retryable: true,
    reason: "OZON_RATE_LIMIT_COOLDOWN",
    message:
      "Ежедневная синхронизация Ozon пропущена: недавно был лимит API. Система повторит позже.",
    error: null,
  };
}

export function fromSyncOzonAllResult(
  companyId: string,
  result: {
    ok: boolean;
    results?: unknown;
    error?: string | null;
    mode?: string;
    ownedDomains?: string[];
    deferredDomains?: string[];
  }
): OzonCronResult {
  const modeFields = {
    mode: result.mode,
    ownedDomains: result.ownedDomains,
    deferredDomains: result.deferredDomains,
  };

  if (result.ok) {
    return {
      companyId,
      ok: true,
      skipped: false,
      status: "completed",
      retryable: false,
      reason: null,
      message: null,
      results: result.results,
      error: null,
      ...modeFields,
    };
  }

  const retryable = isOzonRateLimitText(result.error);

  return {
    companyId,
    ok: false,
    skipped: false,
    status: "failed",
    retryable,
    reason: retryable ? "OZON_RATE_LIMIT" : "OZON_SYNC_ERROR",
    message: null,
    results: result.results,
    error: result.error ?? "Ozon sync failed",
    ...modeFields,
  };
}

export async function mapCompaniesSequentially<T, R>(
  items: T[],
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (const item of items) {
    results.push(await mapper(item));
  }
  return results;
}

export function fromSyncOzonThrownError(
  companyId: string,
  error: unknown
): OzonCronResult {
  const retryable = isOzonRateLimitText(error);

  return {
    companyId,
    ok: false,
    skipped: false,
    status: "failed",
    retryable,
    reason: retryable ? "OZON_RATE_LIMIT" : "OZON_SYNC_ERROR",
    message: null,
    error: getErrorMessage(error),
  };
}

export function summarizeOzonCronResults(
  results: OzonCronResult[]
): OzonCronHttpContract {
  const completedCompanies = results.filter(
    (result) => result.status === "completed"
  ).length;
  const skippedCompanies = results.filter(
    (result) => result.status === "skipped"
  ).length;
  const failedCompanies = results.filter(
    (result) => result.status === "failed"
  ).length;
  const requiredIncomplete = skippedCompanies + failedCompanies > 0;
  const hasNonRetryableFailure = results.some(
    (result) => result.status === "failed" && !result.retryable
  );
  const success = !requiredIncomplete;
  const retryable = requiredIncomplete && !hasNonRetryableFailure;

  return {
    success,
    httpStatus: success ? 200 : hasNonRetryableFailure ? 500 : 503,
    retryable,
    completedCompanies,
    skippedCompanies,
    failedCompanies,
  };
}
