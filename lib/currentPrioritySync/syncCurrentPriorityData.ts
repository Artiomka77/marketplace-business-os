import { prisma } from "@/lib/prisma";
import {
  syncWbFinanceMissingReports,
  syncWbSalesByReportNumber,
} from "@/lib/wb/syncWb";

type CurrentPriorityMode = "PRIORITY" | "RECHECK";

type CurrentPrioritySyncOptions = {
  mode?: CurrentPriorityMode;
  weeks?: number;
  maxSalesJobs?: number;
  pauseHistorical?: boolean;
  syncFinance?: boolean;
  ensureSalesJobs?: boolean;
};

type ActiveWbConnection = {
  companyId: string;
  company: {
    name: string;
  };
};

type FinanceReportForSales = {
  companyId: string;
  companyName: string;
  reportNumber: string;
  dateFrom: Date;
  dateTo: Date;
};

type CurrentSalesJob = {
  id: string;
  companyId: string | null;
  companyName: string;
  cursorReportNumber: string | null;
  dateFrom: Date;
  dateTo: Date;
  retryCount: number;
};

const DEFAULT_PRIORITY_WEEKS = 8;
const DEFAULT_RECHECK_WEEKS = 12;
const DEFAULT_MAX_SALES_JOBS = 1;
const RATE_LIMIT_COOLDOWN_MS = 90 * 60 * 1000;
const STUCK_RUNNING_MS = 90 * 60 * 1000;
const CURRENT_PRIORITY_MARKER = "CURRENT_PRIORITY_SYNC";

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function isRateLimitError(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();

  return (
    message.includes("429") ||
    message.includes("too many requests") ||
    message.includes("limited by global limiter") ||
    message.includes("rate limit")
  );
}

function startOfUtcDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

function addUtcDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);

  return result;
}

function formatDateOnly(date: Date | null | undefined) {
  if (!date) return null;

  return date.toISOString().slice(0, 10);
}

function normalizeReportNumber(value: unknown) {
  return String(value ?? "").trim();
}

function getCurrentIsoWeekStart(today = new Date()) {
  const day = startOfUtcDay(today);
  const utcDay = day.getUTCDay();
  const daysSinceMonday = (utcDay + 6) % 7;

  return addUtcDays(day, -daysSinceMonday);
}

function getCompletedWeeksWindow(weeks: number) {
  const safeWeeks = Math.max(1, Math.floor(weeks));
  const currentWeekStart = getCurrentIsoWeekStart();
  const dateFrom = addUtcDays(currentWeekStart, -safeWeeks * 7);
  const dateTo = addUtcDays(currentWeekStart, -1);

  return {
    weeks: safeWeeks,
    dateFrom,
    dateTo,
    dateFromText: formatDateOnly(dateFrom),
    dateToText: formatDateOnly(dateTo),
    currentWeekStartText: formatDateOnly(currentWeekStart),
  };
}

function getRetryAllowedDate() {
  return new Date(Date.now() - RATE_LIMIT_COOLDOWN_MS);
}

function getStuckRunningBeforeDate() {
  return new Date(Date.now() - STUCK_RUNNING_MS);
}

function currentPriorityMessage(reason: string, mode: CurrentPriorityMode) {
  return `${CURRENT_PRIORITY_MARKER}:${mode}: ${reason}`;
}

function isCurrentPriorityJob(row: { lastError: string | null }) {
  return String(row.lastError ?? "").startsWith(CURRENT_PRIORITY_MARKER);
}

async function getActiveWbConnections() {
  return prisma.marketplaceApiConnection.findMany({
    where: {
      marketplace: "WB",
      isEnabled: true,
      wbToken: {
        not: null,
      },
      company: {
        isActive: true,
      },
    },
    select: {
      companyId: true,
      company: {
        select: {
          name: true,
        },
      },
    },
    orderBy: {
      companyId: "asc",
    },
  });
}

async function pauseNonCurrentHistoricalJobs() {
  const paused = await prisma.historicalSyncJob.updateMany({
    where: {
      status: {
        in: ["PENDING", "ERROR", "RATE_LIMITED"],
      },
      NOT: {
        lastError: {
          startsWith: CURRENT_PRIORITY_MARKER,
        },
      },
    },
    data: {
      status: "PAUSED",
      lastError: "Paused: current priority sync has higher priority",
    },
  });

  const stuck = await prisma.historicalSyncJob.updateMany({
    where: {
      status: "RUNNING",
      lastAttemptAt: {
        lte: getStuckRunningBeforeDate(),
      },
      NOT: {
        lastError: {
          startsWith: CURRENT_PRIORITY_MARKER,
        },
      },
    },
    data: {
      status: "PAUSED",
      lastError: "Paused stuck job: current priority sync has higher priority",
      retryCount: {
        increment: 1,
      },
    },
  });

  return {
    paused: paused.count,
    pausedStuckRunning: stuck.count,
  };
}

async function resetStuckCurrentWbJobs(mode: CurrentPriorityMode) {
  const result = await prisma.historicalSyncJob.updateMany({
    where: {
      marketplace: "WB",
      dataType: "SALES",
      status: "RUNNING",
      lastAttemptAt: {
        lte: getStuckRunningBeforeDate(),
      },
      lastError: {
        startsWith: CURRENT_PRIORITY_MARKER,
      },
    },
    data: {
      status: "ERROR",
      lastError: currentPriorityMessage(
        "Current WB Sales job was running too long and was returned to queue",
        mode
      ),
      retryCount: {
        increment: 1,
      },
    },
  });

  return result.count;
}

async function syncMissingWbFinanceReports(params: {
  connections: ActiveWbConnection[];
  dateFrom: Date;
  dateTo: Date;
}) {
  const results = [];

  for (const connection of params.connections) {
    try {
      const result = await syncWbFinanceMissingReports(connection.companyId, {
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
      });

      results.push({
        marketplace: "WB",
        companyId: connection.companyId,
        companyName: connection.company.name,
        dataType: "FINANCE",
        ok: true,
        result,
      });
    } catch (error) {
      results.push({
        marketplace: "WB",
        companyId: connection.companyId,
        companyName: connection.company.name,
        dataType: "FINANCE",
        ok: false,
        error: getErrorMessage(error),
        isRateLimit: isRateLimitError(error),
      });
    }
  }

  return results;
}

async function getCurrentFinanceReportsForSales(params: {
  connections: ActiveWbConnection[];
  dateFrom: Date;
  dateTo: Date;
}) {
  const companyNames = params.connections.map(
    (connection) => connection.company.name
  );

  if (companyNames.length === 0) {
    return [];
  }

  const companyIdByName = new Map(
    params.connections.map((connection) => [
      connection.company.name,
      connection.companyId,
    ])
  );

  const rows = await prisma.wbFinance.findMany({
    where: {
      companyName: {
        in: companyNames,
      },
      reportNumber: {
        not: null,
      },
      dateFrom: {
        gte: params.dateFrom,
      },
      dateTo: {
        lte: params.dateTo,
      },
    },
    select: {
      companyName: true,
      reportNumber: true,
      dateFrom: true,
      dateTo: true,
      createdAt: true,
    },
    orderBy: [
      {
        dateTo: "desc",
      },
      {
        dateFrom: "desc",
      },
      {
        createdAt: "desc",
      },
    ],
  });

  const seen = new Set<string>();
  const reports: FinanceReportForSales[] = [];

  for (const row of rows) {
    const companyName = String(row.companyName ?? "").trim();
    const reportNumber = normalizeReportNumber(row.reportNumber);
    const companyId = companyIdByName.get(companyName);

    if (!companyId || !companyName || !reportNumber || !row.dateFrom || !row.dateTo) {
      continue;
    }

    const key = `${companyName}::${reportNumber}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    reports.push({
      companyId,
      companyName,
      reportNumber,
      dateFrom: row.dateFrom,
      dateTo: row.dateTo,
    });
  }

  return reports;
}

async function getLoadedSalesReportNumbers(reports: FinanceReportForSales[]) {
  if (reports.length === 0) {
    return new Set<string>();
  }

  const reportNumbers = Array.from(
    new Set(reports.map((report) => report.reportNumber))
  );

  const companyNames = Array.from(
    new Set(reports.map((report) => report.companyName))
  );

  const rows = await prisma.wbSale.findMany({
    where: {
      companyName: {
        in: companyNames,
      },
      reportNumber: {
        in: reportNumbers,
      },
    },
    select: {
      companyName: true,
      reportNumber: true,
    },
    distinct: ["companyName", "reportNumber"],
  });

  return new Set(
    rows
      .map((row) => {
        const companyName = String(row.companyName ?? "").trim();
        const reportNumber = normalizeReportNumber(row.reportNumber);

        return companyName && reportNumber
          ? `${companyName}::${reportNumber}`
          : "";
      })
      .filter(Boolean)
  );
}

async function getExistingSalesJobs(reports: FinanceReportForSales[]) {
  if (reports.length === 0) {
    return new Map<string, { id: string; status: string; lastError: string | null }>();
  }

  const reportNumbers = Array.from(
    new Set(reports.map((report) => report.reportNumber))
  );

  const companyIds = Array.from(
    new Set(reports.map((report) => report.companyId))
  );

  const rows = await prisma.historicalSyncJob.findMany({
    where: {
      companyId: {
        in: companyIds,
      },
      marketplace: "WB",
      dataType: "SALES",
      cursorReportNumber: {
        in: reportNumbers,
      },
    },
    select: {
      id: true,
      companyId: true,
      cursorReportNumber: true,
      status: true,
      lastError: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  const jobs = new Map<
    string,
    { id: string; status: string; lastError: string | null }
  >();

  for (const row of rows) {
    const companyId = String(row.companyId ?? "").trim();
    const reportNumber = normalizeReportNumber(row.cursorReportNumber);
    const key = `${companyId}::${reportNumber}`;

    if (!companyId || !reportNumber || jobs.has(key)) {
      continue;
    }

    jobs.set(key, {
      id: row.id,
      status: row.status,
      lastError: row.lastError,
    });
  }

  return jobs;
}

async function ensureCurrentWbSalesJobs(params: {
  connections: ActiveWbConnection[];
  dateFrom: Date;
  dateTo: Date;
  mode: CurrentPriorityMode;
}) {
  const reports = await getCurrentFinanceReportsForSales(params);
  const loadedReports = await getLoadedSalesReportNumbers(reports);
  const existingJobs = await getExistingSalesJobs(reports);

  let createdJobs = 0;
  let adoptedJobs = 0;
  let reactivatedJobs = 0;
  let skippedLoadedSales = 0;
  let skippedExistingActiveJobs = 0;
  let skippedExistingSuccessJobs = 0;

  const missingReports = [];

  for (const report of reports) {
    const loadedKey = `${report.companyName}::${report.reportNumber}`;

    if (loadedReports.has(loadedKey)) {
      skippedLoadedSales += 1;
      continue;
    }

    missingReports.push({
      companyName: report.companyName,
      reportNumber: report.reportNumber,
      dateFrom: formatDateOnly(report.dateFrom),
      dateTo: formatDateOnly(report.dateTo),
    });

    const jobKey = `${report.companyId}::${report.reportNumber}`;
    const existingJob = existingJobs.get(jobKey);

    if (!existingJob) {
      const job = await prisma.historicalSyncJob.create({
        data: {
          companyId: report.companyId,
          companyName: report.companyName,
          marketplace: "WB",
          dataType: "SALES",
          dateFrom: report.dateFrom,
          dateTo: report.dateTo,
          cursorReportNumber: report.reportNumber,
          cursorOffset: null,
          status: "PENDING",
          totalSteps: 1,
          completedSteps: 0,
          lastError: currentPriorityMessage(
            `Missing WB Sales report ${report.reportNumber}`,
            params.mode
          ),
        },
        select: {
          id: true,
        },
      });

      existingJobs.set(jobKey, {
        id: job.id,
        status: "PENDING",
        lastError: currentPriorityMessage(
          `Missing WB Sales report ${report.reportNumber}`,
          params.mode
        ),
      });

      createdJobs += 1;
      continue;
    }

    if (existingJob.status === "SUCCESS") {
      skippedExistingSuccessJobs += 1;
      continue;
    }

    if (existingJob.status === "PAUSED" || existingJob.status === "ERROR") {
      await prisma.historicalSyncJob.update({
        where: {
          id: existingJob.id,
        },
        data: {
          status: "PENDING",
          dateFrom: report.dateFrom,
          dateTo: report.dateTo,
          cursorReportNumber: report.reportNumber,
          cursorOffset: null,
          totalSteps: 1,
          completedSteps: 0,
          finishedAt: null,
          lastError: currentPriorityMessage(
            `Reactivated missing WB Sales report ${report.reportNumber}`,
            params.mode
          ),
        },
      });

      reactivatedJobs += 1;
      continue;
    }

    if (!isCurrentPriorityJob(existingJob)) {
      await prisma.historicalSyncJob.update({
        where: {
          id: existingJob.id,
        },
        data: {
          lastError: currentPriorityMessage(
            `Adopted existing WB Sales job for report ${report.reportNumber}`,
            params.mode
          ),
        },
      });

      adoptedJobs += 1;
    } else {
      skippedExistingActiveJobs += 1;
    }
  }

  return {
    financeReportsInWindow: reports.length,
    missingSalesReports: missingReports.length,
    missingReports,
    createdJobs,
    adoptedJobs,
    reactivatedJobs,
    skippedLoadedSales,
    skippedExistingActiveJobs,
    skippedExistingSuccessJobs,
  };
}

async function findNextCurrentSalesJob() {
  const job = await prisma.historicalSyncJob.findFirst({
    where: {
      marketplace: "WB",
      dataType: "SALES",
      cursorReportNumber: {
        not: null,
      },
      lastError: {
        startsWith: CURRENT_PRIORITY_MARKER,
      },
      OR: [
        {
          status: "PENDING",
        },
        {
          status: "ERROR",
        },
        {
          status: "RATE_LIMITED",
          OR: [
            {
              lastAttemptAt: null,
            },
            {
              lastAttemptAt: {
                lte: getRetryAllowedDate(),
              },
            },
          ],
        },
      ],
    },
    orderBy: [
      {
        dateTo: "desc",
      },
      {
        dateFrom: "desc",
      },
      {
        createdAt: "asc",
      },
    ],
    select: {
      id: true,
      companyId: true,
      companyName: true,
      cursorReportNumber: true,
      dateFrom: true,
      dateTo: true,
      retryCount: true,
    },
  });

  return job as CurrentSalesJob | null;
}

async function markCurrentJobRunning(job: CurrentSalesJob, mode: CurrentPriorityMode) {
  return prisma.historicalSyncJob.update({
    where: {
      id: job.id,
    },
    data: {
      status: "RUNNING",
      startedAt: new Date(),
      lastAttemptAt: new Date(),
      lastError: currentPriorityMessage(
        `Running WB Sales report ${job.cursorReportNumber}`,
        mode
      ),
    },
  });
}

async function markCurrentJobSuccess(jobId: string) {
  return prisma.historicalSyncJob.update({
    where: {
      id: jobId,
    },
    data: {
      status: "SUCCESS",
      completedSteps: 1,
      finishedAt: new Date(),
      lastError: null,
      cursorOffset: null,
    },
  });
}

async function markCurrentJobFailed(
  jobId: string,
  error: unknown,
  mode: CurrentPriorityMode
) {
  const errorText = getErrorMessage(error);
  const isRateLimit = isRateLimitError(error);

  await prisma.historicalSyncJob.update({
    where: {
      id: jobId,
    },
    data: {
      status: isRateLimit ? "RATE_LIMITED" : "ERROR",
      lastAttemptAt: new Date(),
      lastError: currentPriorityMessage(errorText, mode).slice(0, 1000),
      retryCount: {
        increment: 1,
      },
    },
  });

  return {
    isRateLimit,
    errorText,
  };
}

async function processNextCurrentWbSalesJob(mode: CurrentPriorityMode) {
  const job = await findNextCurrentSalesJob();

  if (!job) {
    return {
      ok: true,
      skipped: true,
      reason: "NO_CURRENT_WB_SALES_JOBS",
      message:
        "Нет текущих приоритетных WB Sales задач, готовых к выполнению.",
    };
  }

  if (!job.companyId || !job.cursorReportNumber) {
    await markCurrentJobFailed(
      job.id,
      new Error("Current WB Sales job has no companyId or reportNumber"),
      mode
    );

    return {
      ok: false,
      skipped: false,
      reason: "BROKEN_CURRENT_WB_SALES_JOB",
      jobId: job.id,
      companyName: job.companyName,
      reportNumber: job.cursorReportNumber,
    };
  }

  await markCurrentJobRunning(job, mode);

  try {
    const result = await syncWbSalesByReportNumber(
      job.companyId,
      job.cursorReportNumber,
      {
        dateFrom: job.dateFrom,
        dateTo: job.dateTo,
      }
    );

    await markCurrentJobSuccess(job.id);

    return {
      ok: true,
      skipped: false,
      jobId: job.id,
      companyName: job.companyName,
      reportNumber: job.cursorReportNumber,
      dateFrom: formatDateOnly(job.dateFrom),
      dateTo: formatDateOnly(job.dateTo),
      result,
    };
  } catch (error) {
    const failure = await markCurrentJobFailed(job.id, error, mode);

    return {
      ok: false,
      skipped: false,
      isRateLimit: failure.isRateLimit,
      jobId: job.id,
      companyName: job.companyName,
      reportNumber: job.cursorReportNumber,
      dateFrom: formatDateOnly(job.dateFrom),
      dateTo: formatDateOnly(job.dateTo),
      error: failure.errorText,
    };
  }
}

async function processCurrentWbSalesJobs(
  maxSalesJobs: number,
  mode: CurrentPriorityMode
) {
  const results = [];

  for (let index = 0; index < maxSalesJobs; index += 1) {
    const result = await processNextCurrentWbSalesJob(mode);

    results.push(result);

    if (result.skipped || !result.ok) {
      break;
    }
  }

  return results;
}

async function getCurrentCoverageSummary(params: {
  connections: ActiveWbConnection[];
  dateFrom: Date;
  dateTo: Date;
}) {
  const reports = await getCurrentFinanceReportsForSales(params);
  const loadedReports = await getLoadedSalesReportNumbers(reports);
  const missingSalesReports = reports.filter(
    (report) => !loadedReports.has(`${report.companyName}::${report.reportNumber}`)
  );

  const byCompany = new Map<
    string,
    {
      companyName: string;
      financeReports: number;
      loadedSalesReports: number;
      missingSalesReports: number;
    }
  >();

  for (const report of reports) {
    const current =
      byCompany.get(report.companyName) ?? {
        companyName: report.companyName,
        financeReports: 0,
        loadedSalesReports: 0,
        missingSalesReports: 0,
      };

    current.financeReports += 1;

    if (loadedReports.has(`${report.companyName}::${report.reportNumber}`)) {
      current.loadedSalesReports += 1;
    } else {
      current.missingSalesReports += 1;
    }

    byCompany.set(report.companyName, current);
  }

  return {
    financeReports: reports.length,
    loadedSalesReports: loadedReports.size,
    missingSalesReports: missingSalesReports.length,
    byCompany: Array.from(byCompany.values()),
    missingSalesReportList: missingSalesReports.map((report) => ({
      companyName: report.companyName,
      reportNumber: report.reportNumber,
      dateFrom: formatDateOnly(report.dateFrom),
      dateTo: formatDateOnly(report.dateTo),
    })),
  };
}

export async function runCurrentPrioritySync(
  options: CurrentPrioritySyncOptions = {}
) {
  const mode = options.mode ?? "PRIORITY";
  const defaultWeeks =
    mode === "RECHECK" ? DEFAULT_RECHECK_WEEKS : DEFAULT_PRIORITY_WEEKS;
  const weeks = Math.max(1, options.weeks ?? defaultWeeks);
  const maxSalesJobs = Math.max(
    0,
    options.maxSalesJobs ?? DEFAULT_MAX_SALES_JOBS
  );
  const syncFinance = options.syncFinance !== false;
  const ensureSalesJobs = options.ensureSalesJobs !== false;
  const window = getCompletedWeeksWindow(weeks);
  const connections = await getActiveWbConnections();

  const pausedHistorical =
    options.pauseHistorical === false
      ? { paused: 0, pausedStuckRunning: 0 }
      : await pauseNonCurrentHistoricalJobs();

  const resetStuckCurrentJobs = await resetStuckCurrentWbJobs(mode);
  const financeResults = syncFinance
    ? await syncMissingWbFinanceReports({
        connections,
        dateFrom: window.dateFrom,
        dateTo: window.dateTo,
      })
    : [];
  const salesJobs = ensureSalesJobs
    ? await ensureCurrentWbSalesJobs({
        connections,
        dateFrom: window.dateFrom,
        dateTo: window.dateTo,
        mode,
      })
    : null;
  const salesResults = await processCurrentWbSalesJobs(maxSalesJobs, mode);
  const coverage = await getCurrentCoverageSummary({
    connections,
    dateFrom: window.dateFrom,
    dateTo: window.dateTo,
  });

  return {
    ok:
      financeResults.every((result) => result.ok || result.isRateLimit) &&
      salesResults.every((result) => result.ok || result.isRateLimit),
    purpose:
      "Current priority sync: only full completed WB weeks. Existing WbFinance/WbSale reportNumber values are not reloaded.",
    mode,
    weeks,
    fullWeeksOnly: true,
    weekRule: "Monday-Sunday, only completed weeks. Current unfinished week is not loaded as weekly WB Finance/Sales.",
    maxSalesJobs,
    syncFinance,
    ensureSalesJobs,
    rateLimitCooldownMinutes: Math.round(RATE_LIMIT_COOLDOWN_MS / 60_000),
    dateFrom: window.dateFromText,
    dateTo: window.dateToText,
    currentWeekStart: window.currentWeekStartText,
    activeWbCompanies: connections.length,
    pausedHistorical,
    resetStuckCurrentJobs,
    financeResults,
    salesJobs,
    salesResults,
    coverage,
    executedAt: new Date().toISOString(),
  };
}
