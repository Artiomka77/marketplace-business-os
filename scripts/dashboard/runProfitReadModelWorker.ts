/**
 * Wave B Profit read-model worker — V2 queue lifecycle.
 * Claims PENDING|ERROR with attempts < maxAttempts and nextAttemptAt due.
 * Concurrency=1. Failures use ERROR vocabulary (not FAILED).
 */
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

import {
  WAVE_B_PROFIT_FORMULAS,
  createPrismaProfitReadModelRepository,
  createWaveBProfitTargetPrismaClient,
  disconnectWaveBProfitTargetPrismaClient,
  isWaveBProfitFormula,
  produceProfitReadModel,
  type ProfitMarketplace,
} from "@/lib/profitReadModel";

const concurrency = 1;
const workerId =
  process.env.WAVE_B_PROFIT_WORKER_ID ??
  `waveb-${process.pid}-${randomUUID().slice(0, 8)}`;
const pollMs = Math.max(
  1000,
  Number(process.env.WAVE_B_PROFIT_WORKER_POLL_MS ?? "5000") || 5000
);
const workerMode = String(
  process.env.WAVE_B_PROFIT_WORKER_MODE ?? "queue-once"
).toLowerCase();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function marketplaceFromFormula(formula: string): ProfitMarketplace {
  return formula.includes("OZON") ? "OZON" : "WB";
}

type ClaimedJob = {
  id: string;
  companyScope: string;
  dateFrom: Date;
  dateTo: Date;
  formulaVersion: string;
  attempts: number;
  maxAttempts: number;
};

async function claimOne(
  prisma: ReturnType<typeof createWaveBProfitTargetPrismaClient>
): Promise<ClaimedJob | null> {
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
      WHERE "formulaVersion" IN (${Prisma.join([...WAVE_B_PROFIT_FORMULAS])})
        AND "status" IN ('PENDING', 'ERROR')
        AND "attempts" < "maxAttempts"
        AND (
          "nextAttemptAt" IS NULL OR
          "nextAttemptAt" <= CURRENT_TIMESTAMP
        )
      ORDER BY "priority" ASC, "createdAt" ASC
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

async function processJob(
  prisma: ReturnType<typeof createWaveBProfitTargetPrismaClient>,
  job: ClaimedJob
) {
  if (!isWaveBProfitFormula(job.formulaVersion)) {
    throw new Error(`unexpected formula ${job.formulaVersion}`);
  }
  const repository = createPrismaProfitReadModelRepository(prisma);
  const marketplace = marketplaceFromFormula(job.formulaVersion);
  const dateFrom = job.dateFrom.toISOString().slice(0, 10);
  const dateTo = job.dateTo.toISOString().slice(0, 10);

  // SAME_PRODUCTION_DB: target === canonical (single pool).
  // EPHEMERAL_SEPARATE_DB: FC/sourceVersion on canonical; persist/jobs on target.
  const { resolveWaveBTargetDbMode } = await import(
    "@/lib/profitReadModel/targetClient"
  );
  const mode = resolveWaveBTargetDbMode();
  const { prisma: canonicalPrisma } = await import("@/lib/prisma");
  const computePrisma =
    mode === "SAME_PRODUCTION_DB" ? prisma : canonicalPrisma;
  const result = await produceProfitReadModel({
    repository,
    marketplace,
    companyScope: job.companyScope,
    dateFrom,
    dateTo,
    prisma: computePrisma,
  });

  await prisma.dashboardPeriodSnapshotJob.update({
    where: { id: job.id },
    data: {
      status: "SUCCESS",
      finishedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      updatedAt: new Date(),
    },
  });

  console.log(
    JSON.stringify({
      event: "wave_b_profit_job_success",
      jobId: job.id,
      marketplace,
      companyScope: job.companyScope,
      dateFrom,
      dateTo,
      ...result,
      concurrency,
    })
  );
}

async function failJob(
  prisma: ReturnType<typeof createWaveBProfitTargetPrismaClient>,
  job: ClaimedJob,
  err: unknown
) {
  const message = err instanceof Error ? err.message : String(err);
  const attempts = Number(job.attempts) + 1;
  const exhausted = attempts >= Number(job.maxAttempts);
  // Default bounded backoff (minutes). Canary may set WAVE_B_PROFIT_WORKER_RETRY_BACKOFF_SEC.
  const backoffSecEnv = process.env.WAVE_B_PROFIT_WORKER_RETRY_BACKOFF_SEC;
  const backoffMs = exhausted
    ? 0
    : backoffSecEnv != null && backoffSecEnv !== ""
      ? Math.max(1, Number(backoffSecEnv)) * 1000
      : Math.min(60, Math.max(5, attempts * 10)) * 60_000;
  await prisma.dashboardPeriodSnapshotJob.update({
    where: { id: job.id },
    data: {
      status: exhausted ? "ERROR" : "PENDING",
      lastError: message.slice(0, 2000),
      finishedAt: exhausted ? new Date() : null,
      lockedAt: null,
      lockedBy: null,
      nextAttemptAt: exhausted ? null : new Date(Date.now() + backoffMs),
      updatedAt: new Date(),
    },
  });
  console.error(
    JSON.stringify({
      event: "wave_b_profit_job_failed",
      jobId: job.id,
      attempts,
      exhausted,
      errorClass: createHash("sha256").update(message).digest("hex").slice(0, 12),
    })
  );
}

async function runOnce(
  prisma: ReturnType<typeof createWaveBProfitTargetPrismaClient>
) {
  const job = await claimOne(prisma);
  if (!job) {
    console.log(JSON.stringify({ event: "wave_b_profit_idle", workerId }));
    return false;
  }
  try {
    await processJob(prisma, job);
  } catch (err) {
    await failJob(prisma, job, err);
  }
  return true;
}

async function main() {
  const { resolveWaveBTargetDbMode, waveBTargetPoolContract } = await import(
    "@/lib/profitReadModel/targetClient"
  );
  const mode = resolveWaveBTargetDbMode();
  if (
    mode === "EPHEMERAL_SEPARATE_DB" &&
    !process.env.WAVE_B_PROFIT_TARGET_DATABASE_URL?.trim()
  ) {
    throw new Error(
      "EPHEMERAL_SEPARATE_DB requires WAVE_B_PROFIT_TARGET_DATABASE_URL"
    );
  }
  const prisma = createWaveBProfitTargetPrismaClient();
  const poolContract = waveBTargetPoolContract();
  console.log(
    JSON.stringify({
      event: "wave_b_profit_worker_start",
      workerId,
      mode: workerMode,
      targetDbMode: mode,
      concurrency,
      formulas: WAVE_B_PROFIT_FORMULAS,
      persistTarget:
        mode === "SAME_PRODUCTION_DB"
          ? "canonical_prisma_same_db"
          : "wave_b_profit_ephemeral_target",
      queueVocabulary: "V2_PENDING_ERROR_SUCCESS",
      ...poolContract,
      workerHoldsTransactionDuringCanonicalCompute: false,
    })
  );

  try {
    if (workerMode === "oneshot" || workerMode === "queue-once") {
      const max = Number(process.env.WAVE_B_PROFIT_WORKER_MAX_JOBS ?? "1") || 1;
      for (let i = 0; i < max; i++) {
        const did = await runOnce(prisma);
        if (!did) break;
      }
      return;
    }

    for (;;) {
      const did = await runOnce(prisma);
      if (!did) await sleep(pollMs);
    }
  } finally {
    await disconnectWaveBProfitTargetPrismaClient();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
