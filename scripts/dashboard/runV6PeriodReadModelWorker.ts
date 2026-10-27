/**
 * Wave A V6 Dashboard period read-model worker.
 * Modes:
 * - oneshot (default): V6_READMODEL_DATE_FROM/TO seed once
 * - queue: long-lived durable service (poll forever until SIGTERM/SIGINT)
 * - queue-once: claim/process up to maxJobs then exit (canary/batch)
 *
 * Persists to V6_READMODEL_TARGET_DATABASE_URL (ephemeral/candidate).
 * Must NOT be scheduled against production in this task.
 */
import { createHash, randomUUID } from "node:crypto";

import {
  createPrismaV6PeriodReadModelRepository,
  createV6ReadModelTargetPrismaClient,
  asPrismaLikeV6Client,
  disconnectV6ReadModelTargetPrismaClient,
  produceV6DashboardPeriodReadModel,
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
  D1D5V2BuildForbiddenError,
} from "@/lib/dashboard/v6PeriodReadModel";

const concurrencyRequested = Math.max(
  1,
  Number(process.env.V6_PERIOD_READMODEL_WORKER_CONCURRENCY ?? "1") || 1
);
const concurrency = 1;
const workerMode = String(
  process.env.V6_READMODEL_WORKER_MODE ?? "oneshot"
).toLowerCase();
const workerId =
  process.env.V6_READMODEL_WORKER_ID ??
  `v6rm-${process.pid}-${randomUUID().slice(0, 8)}`;
const pollMs = Math.max(
  1000,
  Number(process.env.V6_READMODEL_WORKER_POLL_MS ?? "5000") || 5000
);
const transientBackoffMs = Math.max(
  1000,
  Number(process.env.V6_READMODEL_WORKER_ERROR_BACKOFF_MS ?? "10000") || 10000
);

function resolveMaxJobs(): number | null {
  // queue = durable service: no maxJobs termination
  if (workerMode === "queue") return null;
  const raw = process.env.V6_READMODEL_WORKER_MAX_JOBS;
  if (raw == null || raw === "") {
    return workerMode === "queue-once" ? 1 : 1;
  }
  return Math.max(1, Number(raw) || 1);
}

function isoDate(value: Date | string) {
  return new Date(value).toISOString().slice(0, 10);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function runOneshot() {
  const dateFrom = process.env.V6_READMODEL_DATE_FROM;
  const dateTo = process.env.V6_READMODEL_DATE_TO;
  if (!dateFrom || !dateTo) {
    throw new Error(
      "V6_READMODEL_DATE_FROM and V6_READMODEL_DATE_TO are required"
    );
  }

  const targetClient = createV6ReadModelTargetPrismaClient();
  const repository = createPrismaV6PeriodReadModelRepository(
    asPrismaLikeV6Client(targetClient)
  );

  console.log(
    JSON.stringify({
      event: "v6_period_readmodel_worker_start",
      mode: "oneshot",
      formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
      concurrency,
      dateFrom,
      dateTo,
      persistTarget: "prisma_v6_readmodel_target",
      repositoryKind: "prisma",
    })
  );

  try {
    const result = await produceV6DashboardPeriodReadModel({
      repository,
      dateFrom,
      dateTo,
      companyScope: process.env.V6_READMODEL_COMPANY_SCOPE ?? "ALL",
    });

    console.log(
      JSON.stringify({
        event: "v6_period_readmodel_worker_done",
        mode: "oneshot",
        formulaVersion: result.meta.formulaVersion,
        dataMode: result.meta.dataMode,
        coverageStatus: result.meta.coverageStatus,
        issues: result.meta.completeness.issues,
        companyRows: result.companyRows.length,
        dailyPoints: result.dailyPoints.length,
        sourceFingerprint: result.meta.sourceFingerprint,
        persistTarget: "prisma_v6_readmodel_target",
      })
    );
  } finally {
    await disconnectV6ReadModelTargetPrismaClient();
  }
}

type ClaimedJob = {
  id: string;
  companyScope: string;
  dateFrom: Date;
  dateTo: Date;
  attempts: number;
  maxAttempts: number;
};

export type V6QueueWorkerHooks = {
  claimNext: () => Promise<ClaimedJob | null>;
  processJob: (job: ClaimedJob) => Promise<void>;
  onIdle?: (processed: number) => void | Promise<void>;
  onTransientError?: (error: unknown) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  shouldStop?: () => boolean;
  pollMs?: number;
  transientBackoffMs?: number;
  maxJobs?: number | null;
};

/**
 * Long-lived queue loop (testable). Does not exit on idle.
 * Stops only when shouldStop() is true or maxJobs is reached (queue-once).
 */
export async function runV6QueueWorkerLoop(hooks: V6QueueWorkerHooks) {
  const poll = Math.max(1000, hooks.pollMs ?? 5000);
  const backoff = Math.max(1000, hooks.transientBackoffMs ?? 10000);
  const maxJobs = hooks.maxJobs ?? null;
  const wait = hooks.sleep ?? sleep;
  let processed = 0;

  while (!(hooks.shouldStop?.() ?? false)) {
    if (maxJobs != null && processed >= maxJobs) break;

    try {
      const job = await hooks.claimNext();
      if (!job) {
        await hooks.onIdle?.(processed);
        await wait(poll);
        continue;
      }

      await hooks.processJob(job);
      processed += 1;
    } catch (error) {
      await hooks.onTransientError?.(error);
      await wait(backoff);
    }
  }

  return { processed };
}

async function claimNextV6Job(
  client: ReturnType<typeof createV6ReadModelTargetPrismaClient>
) {
  return client.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<ClaimedJob[]>`
      SELECT
        "id",
        "companyScope",
        "dateFrom",
        "dateTo",
        "attempts",
        "maxAttempts"
      FROM "DashboardPeriodSnapshotJob"
      WHERE "formulaVersion" = ${FINANCIAL_CORE_V6_PERIOD_READMODEL_V2}
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
    await tx.dashboardPeriodSnapshotJob.update({
      where: { id: job.id },
      data: {
        status: "RUNNING",
        attempts: { increment: 1 },
        lockedAt: new Date(),
        lockedBy: workerId,
        startedAt: new Date(),
        finishedAt: null,
        lastError: null,
        updatedAt: new Date(),
      },
    });
    return job;
  });
}

async function runQueueService(options: { maxJobs: number | null }) {
  if (concurrencyRequested !== 1) {
    console.log(
      JSON.stringify({
        event: "v6_queue_worker_concurrency_forced",
        requested: concurrencyRequested,
        effective: 1,
      })
    );
  }

  const targetClient = createV6ReadModelTargetPrismaClient();
  const repository = createPrismaV6PeriodReadModelRepository(
    asPrismaLikeV6Client(targetClient)
  );

  let stopping = false;
  const onSigTerm = () => {
    console.log(
      JSON.stringify({
        event: "v6_queue_worker_shutdown_signal",
        signal: "SIGTERM",
        workerId,
      })
    );
    stopping = true;
  };
  const onSigInt = () => {
    console.log(
      JSON.stringify({
        event: "v6_queue_worker_shutdown_signal",
        signal: "SIGINT",
        workerId,
      })
    );
    stopping = true;
  };
  process.on("SIGTERM", onSigTerm);
  process.on("SIGINT", onSigInt);

  console.log(
    JSON.stringify({
      event: "v6_period_readmodel_worker_start",
      mode: options.maxJobs == null ? "queue" : "queue-once",
      formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
      concurrency: 1,
      maxJobs: options.maxJobs,
      pollMs,
      workerId,
      persistTarget: "prisma_v6_readmodel_target",
      longLived: options.maxJobs == null,
    })
  );

  try {
    const result = await runV6QueueWorkerLoop({
      maxJobs: options.maxJobs,
      pollMs,
      transientBackoffMs,
      shouldStop: () => stopping,
      claimNext: () => claimNextV6Job(targetClient),
      onIdle: async (processed) => {
        console.log(
          JSON.stringify({
            event: "v6_queue_idle",
            processed,
            pollMs,
            stayingAlive: options.maxJobs == null,
          })
        );
      },
      onTransientError: async (error) => {
        const message =
          error instanceof Error ? error.message.slice(0, 500) : String(error);
        console.log(
          JSON.stringify({
            event: "v6_queue_transient_error",
            backoffMs: transientBackoffMs,
            errorClass: createHash("sha256")
              .update(message)
              .digest("hex")
              .slice(0, 12),
          })
        );
      },
      processJob: async (job) => {
        const dateFrom = isoDate(job.dateFrom);
        const dateTo = isoDate(job.dateTo);
        console.log(
          JSON.stringify({
            event: "v6_queue_job_claimed",
            id: job.id,
            companyScope: job.companyScope,
            dateFrom,
            dateTo,
            attempts: job.attempts + 1,
          })
        );

        try {
          const produced = await produceV6DashboardPeriodReadModel({
            repository,
            dateFrom,
            dateTo,
            companyScope: "ALL",
          });
          await targetClient.dashboardPeriodSnapshotJob.update({
            where: { id: job.id },
            data: {
              status: "SUCCESS",
              lockedAt: null,
              lockedBy: null,
              finishedAt: new Date(),
              lastError: null,
              updatedAt: new Date(),
            },
          });
          console.log(
            JSON.stringify({
              event: "v6_queue_job_success",
              id: job.id,
              dataMode: produced.meta.dataMode,
              coverageStatus: produced.meta.coverageStatus,
              issues: produced.meta.completeness.issues,
              fingerprint: produced.meta.sourceFingerprint,
            })
          );
        } catch (error) {
          const forbidden =
            error instanceof D1D5V2BuildForbiddenError ||
            (error instanceof Error &&
              error.message.startsWith("D1D5_V2_BUILD_FORBIDDEN:"));
          const message =
            error instanceof Error ? error.message.slice(0, 500) : String(error);
          const attempts = job.attempts + 1;
          const exhausted = forbidden || attempts >= job.maxAttempts;
          const backoffMin = Math.min(60, Math.max(5, attempts * 10));
          await targetClient.dashboardPeriodSnapshotJob.update({
            where: { id: job.id },
            data: {
              status: exhausted ? "ERROR" : "PENDING",
              lockedAt: null,
              lockedBy: null,
              finishedAt: exhausted ? new Date() : null,
              nextAttemptAt: exhausted
                ? null
                : new Date(Date.now() + backoffMin * 60_000),
              lastError: message,
              updatedAt: new Date(),
            },
          });
          console.log(
            JSON.stringify({
              event: forbidden
                ? "v6_queue_job_rejected_d6_unsafe"
                : "v6_queue_job_failed",
              id: job.id,
              attempts,
              exhausted,
              falseFinal: false,
              errorClass: createHash("sha256")
                .update(message)
                .digest("hex")
                .slice(0, 12),
            })
          );
        }
      },
    });

    console.log(
      JSON.stringify({
        event: "v6_period_readmodel_worker_stop",
        mode: options.maxJobs == null ? "queue" : "queue-once",
        processed: result.processed,
        graceful: stopping,
      })
    );
  } finally {
    process.off("SIGTERM", onSigTerm);
    process.off("SIGINT", onSigInt);
    await disconnectV6ReadModelTargetPrismaClient();
  }
}

async function main() {
  if (process.env.V6_READMODEL_ALLOW_PROD_PERSIST === "1") {
    throw new Error(
      "Wave A forbids production persist; unset V6_READMODEL_ALLOW_PROD_PERSIST"
    );
  }
  if (!process.env.V6_READMODEL_TARGET_DATABASE_URL?.trim()) {
    throw new Error(
      "V6_READMODEL_TARGET_DATABASE_URL is required (ephemeral/candidate target only)"
    );
  }

  if (workerMode === "queue") {
    await runQueueService({ maxJobs: null });
  } else if (workerMode === "queue-once") {
    await runQueueService({ maxJobs: resolveMaxJobs() });
  } else {
    await runOneshot();
  }
}

const isDirectRun =
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module;

if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
