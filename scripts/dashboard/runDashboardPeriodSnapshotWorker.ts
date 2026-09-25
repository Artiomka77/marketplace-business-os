import os from "node:os";
import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import {
  buildDashboardPeriodSnapshotPayload,
  DASHBOARD_PERIOD_SNAPSHOT_FORMULA_VERSION,
} from "@/lib/dashboard/periodSnapshot";
import { prisma } from "@/lib/prisma";
import {
  completeDashboardSnapshotJobClaim,
  failDashboardSnapshotJobClaim,
  lockDashboardSnapshotJobClaim,
  persistPreparedStockAbcSnapshot,
  prepareStockAbcSnapshot,
  STOCK_PLANNING_SNAPSHOT_FORMULA_VERSION,
} from "@/lib/stocks/stockAbcSnapshots";

type ClaimedJob = {
  id: string;
  companyScope: string;
  dateFrom: Date;
  dateTo: Date;
  formulaVersion: string;
  attempts: number;
  maxAttempts: number;
};

type RecoveredJob = {
  id: string;
  status: string;
  attempts: number;
  maxAttempts: number;
};


const workerMode = String(
  process.env.DASHBOARD_SNAPSHOT_WORKER_MODE ?? "continuous"
).toLowerCase();
const knownFormulaVersions = [
  DASHBOARD_PERIOD_SNAPSHOT_FORMULA_VERSION,
  STOCK_PLANNING_SNAPSHOT_FORMULA_VERSION,
] as const;
const configuredFormulaVersions = String(
  process.env.DASHBOARD_SNAPSHOT_FORMULA_VERSIONS ??
    knownFormulaVersions.join(",")
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const allowedFormulaVersions = Array.from(
  new Set(
    configuredFormulaVersions.filter((value) =>
      knownFormulaVersions.includes(
        value as (typeof knownFormulaVersions)[number]
      )
    )
  )
);

if (allowedFormulaVersions.length === 0) {
  throw new Error(
    "DASHBOARD_SNAPSHOT_FORMULA_VERSIONS contains no supported values"
  );
}

const handlesFinancialSnapshots = allowedFormulaVersions.includes(
  DASHBOARD_PERIOD_SNAPSHOT_FORMULA_VERSION
);
const handlesStockPlanningSnapshots = allowedFormulaVersions.includes(
  STOCK_PLANNING_SNAPSHOT_FORMULA_VERSION
);
const allowedFormulaVersionSql = Prisma.join(
  allowedFormulaVersions.map((value) => Prisma.sql`${value}`)
);
const pollIntervalMs = Math.max(
  5_000,
  Number(process.env.DASHBOARD_SNAPSHOT_POLL_INTERVAL_MS ?? 20_000)
);
const staleAfterMinutes = Math.max(
  10,
  Number(process.env.DASHBOARD_SNAPSHOT_STALE_AFTER_MINUTES ?? 45)
);
const claimMaxWaitMs = Math.max(
  5_000,
  Number(process.env.DASHBOARD_SNAPSHOT_CLAIM_MAX_WAIT_MS ?? 60_000)
);
const claimTimeoutMs = Math.max(
  30_000,
  Number(process.env.DASHBOARD_SNAPSHOT_CLAIM_TIMEOUT_MS ?? 120_000)
);
const heartbeatIntervalMs = Math.max(
  5_000,
  Number(process.env.DASHBOARD_SNAPSHOT_HEARTBEAT_INTERVAL_MS ?? 20_000)
);
const workerId = `${os.hostname()}:${process.pid}:${randomUUID()}`;
const stockWarmupIntervalMs = Math.max(
  60 * 60 * 1000,
  Number(
    process.env.STOCK_PLANNING_WARMUP_INTERVAL_MS ??
      6 * 60 * 60 * 1000
  )
);
let nextStockWarmupAt = 0;
let stopping = false;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeError(error: unknown) {
  return String(
    error instanceof Error ? error.stack ?? error.message : error
  )
    .replace(/(postgres(?:ql)?:\/\/)[^\s]+/gi, "$1[REDACTED]")
    .slice(0, 1800);
}

function log(payload: Record<string, unknown>) {
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      workerId,
      ...payload,
    })}\n`
  );
}

async function recoverStaleJobs() {
  const staleBefore = new Date(
    Date.now() - staleAfterMinutes * 60 * 1000
  );

  const recovered = await prisma.$queryRaw<RecoveredJob[]>`
    UPDATE "DashboardPeriodSnapshotJob"
    SET
      "status" = CASE
        WHEN "attempts" >= "maxAttempts" THEN 'ERROR'
        ELSE 'PENDING'
      END,
      "lockedAt" = NULL,
      "lockedBy" = NULL,
      "nextAttemptAt" = CASE
        WHEN "attempts" >= "maxAttempts" THEN NULL
        ELSE CURRENT_TIMESTAMP
      END,
      "finishedAt" = CASE
        WHEN "attempts" >= "maxAttempts" THEN CURRENT_TIMESTAMP
        ELSE NULL
      END,
      "lastError" = CASE
        WHEN "attempts" >= "maxAttempts"
          THEN 'Recovered stale RUNNING job after worker termination; retry limit reached'
        ELSE 'Recovered stale RUNNING job after worker termination'
      END,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "formulaVersion" IN (${allowedFormulaVersionSql})
      AND "status" = 'RUNNING'
      AND (
        "lockedAt" IS NULL
        OR "lockedAt" < ${staleBefore}
      )
    RETURNING "id", "status", "attempts", "maxAttempts"
  `;

  if (recovered.length > 0) {
    log({
      status: "STALE_JOBS_RECOVERED",
      count: recovered.length,
      jobs: recovered,
    });
  }
}

async function claimNextJob(): Promise<ClaimedJob | null> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<ClaimedJob[]>`
      SELECT
        "id",
        "companyScope",
        "dateFrom",
        "dateTo",
        "formulaVersion",
        "attempts",
        "maxAttempts"
      FROM "DashboardPeriodSnapshotJob"
      WHERE "formulaVersion" IN (${allowedFormulaVersionSql})
        AND "status" IN ('PENDING', 'ERROR')
        AND "attempts" < "maxAttempts"
        AND (
          "nextAttemptAt" IS NULL OR
          "nextAttemptAt" <= CURRENT_TIMESTAMP
        )
      ORDER BY "priority" DESC, "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;

    const job = rows[0];
    if (!job) return null;

    const updated = await tx.dashboardPeriodSnapshotJob.update({
      where: { id: job.id },
      data: {
        status: "RUNNING",
        attempts: {
          increment: 1,
        },
        lockedAt: new Date(),
        lockedBy: workerId,
        startedAt: new Date(),
        finishedAt: null,
        lastError: null,
      },
    });

    return {
      id: updated.id,
      companyScope: updated.companyScope,
      dateFrom: updated.dateFrom,
      dateTo: updated.dateTo,
      formulaVersion: updated.formulaVersion,
      attempts: updated.attempts,
      maxAttempts: updated.maxAttempts,
    };
  }, {
    maxWait: claimMaxWaitMs,
    timeout: claimTimeoutMs,
  });
}

function snapshotJobClaim(job: ClaimedJob) {
  return {
    id: job.id,
    lockedBy: workerId,
    attempts: job.attempts,
  };
}

async function touchJobHeartbeat(job: ClaimedJob) {
  await lockDashboardSnapshotJobClaim(
    prisma,
    snapshotJobClaim(job)
  );
}

async function withJobHeartbeat<T>(
  job: ClaimedJob,
  task: () => Promise<T>
) {
  let stopped = false;
  let heartbeatInFlight = false;

  const timer = setInterval(() => {
    if (stopped || heartbeatInFlight) return;

    heartbeatInFlight = true;
    touchJobHeartbeat(job)
      .catch((error) => {
        log({
          status: "SNAPSHOT_JOB_HEARTBEAT_ERROR",
          jobId: job.id,
          error: safeError(error),
        });
      })
      .finally(() => {
        heartbeatInFlight = false;
      });
  }, heartbeatIntervalMs);

  timer.unref();

  try {
    return await task();
  } finally {
    stopped = true;
    clearInterval(timer);
  }
}

function toIsoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addUtcDays(value: Date, days: number) {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function startOfUtcToday() {
  const now = new Date();

  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate()
    )
  );
}

function stockSnapshotPlanningVersion(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return Number(
    (value as { planningVersion?: unknown }).planningVersion ?? 0
  );
}

async function hasFreshStockPlanningSnapshot(params: {
  companyScope: string;
  dateFrom: Date;
  dateTo: Date;
  freshAfter: Date;
}) {
  const rows = await prisma.stockAbcSnapshot.findMany({
    where: {
      companyScope: params.companyScope,
      marketplace: {
        in: ["WB", "OZON"],
      },
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      generatedAt: {
        gte: params.freshAfter,
      },
    },
    select: {
      marketplace: true,
      payload: true,
    },
  });

  const versions = new Map(
    rows.map((row) => [
      row.marketplace,
      stockSnapshotPlanningVersion(row.payload),
    ])
  );

  return (
    versions.get("WB") === 3 &&
    versions.get("OZON") === 3
  );
}

async function seedStockPlanningWarmups() {
  if (!handlesStockPlanningSnapshots) return;

  const now = Date.now();

  if (now < nextStockWarmupAt) return;

  nextStockWarmupAt = now + stockWarmupIntervalMs;

  const dateTo = startOfUtcToday();
  const dateFrom = addUtcDays(dateTo, -30);
  const freshAfter = new Date(now - stockWarmupIntervalMs);
  const companies = await prisma.company.findMany({
    where: {
      isActive: true,
    },
    orderBy: {
      name: "asc",
    },
    select: {
      name: true,
    },
  });
  const scopes = [
    "ALL",
    ...companies.map((company) => company.name),
  ];
  const queued: string[] = [];

  for (const companyScope of scopes) {
    const fresh = await hasFreshStockPlanningSnapshot({
      companyScope,
      dateFrom,
      dateTo,
      freshAfter,
    });

    if (fresh) continue;

    const key = {
      companyScope,
      dateFrom,
      dateTo,
      formulaVersion: STOCK_PLANNING_SNAPSHOT_FORMULA_VERSION,
    };
    const existingJob =
      await prisma.dashboardPeriodSnapshotJob.findUnique({
        where: {
          companyScope_dateFrom_dateTo_formulaVersion: key,
        },
        select: {
          status: true,
        },
      });

    if (
      existingJob?.status === "PENDING" ||
      existingJob?.status === "RUNNING"
    ) {
      continue;
    }

    await prisma.dashboardPeriodSnapshotJob.upsert({
      where: {
        companyScope_dateFrom_dateTo_formulaVersion: key,
      },
      create: {
        ...key,
        status: "PENDING",
        priority: companyScope === "ALL" ? 7_900 : 7_800,
        maxAttempts: 3,
      },
      update: {
        status: "PENDING",
        priority: companyScope === "ALL" ? 7_900 : 7_800,
        attempts: 0,
        maxAttempts: 3,
        lockedAt: null,
        lockedBy: null,
        nextAttemptAt: null,
        startedAt: null,
        finishedAt: null,
        lastError: null,
      },
    });

    queued.push(companyScope);
  }

  log({
    status: "STOCK_PLANNING_WARMUPS_CHECKED",
    dateFrom: toIsoDate(dateFrom),
    dateTo: toIsoDate(dateTo),
    queuedScopes: queued,
  });
}

async function markJobFailure(job: ClaimedJob, error: unknown) {
  const errorText = safeError(error);
  const delayMinutes = Math.min(60, Math.max(5, job.attempts * 10));
  const hasRetriesLeft = job.attempts < job.maxAttempts;

  const failed = await failDashboardSnapshotJobClaim(
    prisma,
    snapshotJobClaim(job),
    {
      finishedAt: new Date(),
      nextAttemptAt: hasRetriesLeft
        ? new Date(Date.now() + delayMinutes * 60 * 1000)
        : null,
      lastError: errorText,
    }
  );

  if (!failed) {
    log({
      status: "SNAPSHOT_JOB_CLAIM_LOST",
      jobId: job.id,
      attempts: job.attempts,
    });
    return;
  }

  log({
    status: "SNAPSHOT_JOB_ERROR",
    jobId: job.id,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    error: errorText,
  });
}

async function executeJob(job: ClaimedJob) {
  const dateFrom = job.dateFrom.toISOString().slice(0, 10);
  const dateTo = job.dateTo.toISOString().slice(0, 10);

  log({
    status: "SNAPSHOT_JOB_STARTED",
    jobId: job.id,
    formulaVersion: job.formulaVersion,
    companyScope: job.companyScope,
    dateFrom,
    dateTo,
    attempts: job.attempts,
  });

  if (
    job.formulaVersion ===
    STOCK_PLANNING_SNAPSHOT_FORMULA_VERSION
  ) {
    const startedAt = Date.now();
    const wbPrepared = await prepareStockAbcSnapshot({
      companyScope: job.companyScope,
      marketplace: "WB",
      dateFrom,
      dateTo,
      allowEmpty: true,
    });
    const ozonPrepared = await prepareStockAbcSnapshot({
      companyScope: job.companyScope,
      marketplace: "OZON",
      dateFrom,
      dateTo,
      allowEmpty: true,
    });

    const { wb, ozon } = await prisma.$transaction(async (tx) => {
      await lockDashboardSnapshotJobClaim(
        tx,
        snapshotJobClaim(job)
      );
      const wb = await persistPreparedStockAbcSnapshot(
        tx,
        wbPrepared
      );
      const ozon = await persistPreparedStockAbcSnapshot(
        tx,
        ozonPrepared
      );
      await completeDashboardSnapshotJobClaim(
        tx,
        snapshotJobClaim(job)
      );

      return { wb, ozon };
    });

    log({
      status: "STOCK_PLANNING_JOB_SUCCESS",
      jobId: job.id,
      formulaVersion: job.formulaVersion,
      companyScope: job.companyScope,
      dateFrom,
      dateTo,
      calculationMs: Date.now() - startedAt,
      wbRowsCount: wb.rowsCount,
      wbGeoSalesRowsCount: wb.wbGeoSalesRowsCount,
      ozonRowsCount: ozon.rowsCount,
      ozonSalesRowsCount: ozon.ozonSalesRowsCount,
    });

    return;
  }

  if (
    job.formulaVersion !==
    DASHBOARD_PERIOD_SNAPSHOT_FORMULA_VERSION
  ) {
    throw new Error(
      `Unsupported snapshot formula version: ${job.formulaVersion}`
    );
  }

  const result = await buildDashboardPeriodSnapshotPayload({
    companyScope: job.companyScope,
    dateFrom,
    dateTo,
  });

  await prisma.$transaction(async (tx) => {
    await lockDashboardSnapshotJobClaim(
        tx,
        snapshotJobClaim(job)
      );

    await tx.dashboardPeriodSnapshot.upsert({
      where: {
        companyScope_dateFrom_dateTo_formulaVersion: {
          companyScope: job.companyScope,
          dateFrom: job.dateFrom,
          dateTo: job.dateTo,
          formulaVersion: job.formulaVersion,
        },
      },
      create: {
        companyScope: job.companyScope,
        dateFrom: job.dateFrom,
        dateTo: job.dateTo,
        formulaVersion: job.formulaVersion,
        payload: result.payload as Prisma.InputJsonValue,
        payloadChecksum: result.payloadChecksum,
        sourceFingerprint: result.sourceFingerprint,
        coverageStatus: result.coverageStatus,
        rowsCount: result.rowsCount,
        calculationMs: result.calculationMs,
      },
      update: {
        payload: result.payload as Prisma.InputJsonValue,
        payloadChecksum: result.payloadChecksum,
        sourceFingerprint: result.sourceFingerprint,
        coverageStatus: result.coverageStatus,
        rowsCount: result.rowsCount,
        calculationMs: result.calculationMs,
        generatedAt: new Date(),
      },
    });

    await completeDashboardSnapshotJobClaim(
        tx,
        snapshotJobClaim(job)
      );
  });

  log({
    status: "SNAPSHOT_JOB_SUCCESS",
    jobId: job.id,
    formulaVersion: job.formulaVersion,
    companyScope: job.companyScope,
    dateFrom,
    dateTo,
    rowsCount: result.rowsCount,
    calculationMs: result.calculationMs,
    coverageStatus: result.coverageStatus,
    payloadChecksum: result.payloadChecksum,
  });
}

async function processOneJob() {
  const job = await claimNextJob();
  if (!job) return false;

  try {
    await withJobHeartbeat(job, () => executeJob(job));
  } catch (error) {
    await markJobFailure(job, error);
  }

  return true;
}

async function main() {
  log({
    status: "WORKER_START",
    mode: workerMode,
    formulaVersions: allowedFormulaVersions,
    handlesFinancialSnapshots,
    handlesStockPlanningSnapshots,
    pollIntervalMs,
    staleAfterMinutes,
    claimMaxWaitMs,
    claimTimeoutMs,
    heartbeatIntervalMs,
    stockWarmupIntervalMs,
  });

  await recoverStaleJobs();

  if (workerMode === "once") {
    await processOneJob();
    return;
  }

  if (workerMode === "drain") {
    while (!stopping && (await processOneJob())) {
      // Drain all currently available jobs sequentially.
    }
    return;
  }

  while (!stopping) {
    await seedStockPlanningWarmups();

    const processed = await processOneJob();

    if (!processed) {
      await sleep(pollIntervalMs);
    }
  }
}

process.on("SIGTERM", () => {
  stopping = true;
  log({ status: "WORKER_STOP_REQUESTED", signal: "SIGTERM" });
});

process.on("SIGINT", () => {
  stopping = true;
  log({ status: "WORKER_STOP_REQUESTED", signal: "SIGINT" });
});

main()
  .catch((error) => {
    log({ status: "WORKER_FATAL", error: safeError(error) });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    log({ status: "WORKER_STOPPED" });
  });
