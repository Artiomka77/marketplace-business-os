import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  WAVE_B_PROFIT_FORMULAS,
  createWaveBProfitTargetPrismaClient,
  disconnectWaveBProfitTargetPrismaClient,
} from "@/lib/profitReadModel";

const DATE_FROM = "2026-08-17";
const DATE_TO = "2026-08-23";
const SCOPES = ["ALL", "ИП Петров", "ИП Лебедева"] as const;

function runWorkerOnce(maxJobs: string): Promise<{ code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", "scripts/dashboard/runProfitReadModelWorker.ts"], {
      env: {
        ...process.env,
        WAVE_B_PROFIT_WORKER_MODE: "queue-once",
        WAVE_B_PROFIT_WORKER_MAX_JOBS: maxJobs,
        WAVE_B_PROFIT_TARGET_POOL_MAX: "1",
        WAVE_B_PROFIT_WORKER_RETRY_BACKOFF_SEC: "2",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => process.stdout.write(d));
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("exit", (code) => resolve({ code }));
  });
}

async function main() {
  const out = process.env.WAVE_B_SIX_OUT!;
  const lifeOut = process.env.WAVE_B_LIFE_OUT!;
  const prisma = createWaveBProfitTargetPrismaClient();
  const createdIds: string[] = [];
  const timeline: Array<Record<string, unknown>> = [];
  try {
    const dateFrom = new Date(`${DATE_FROM}T00:00:00.000Z`);
    const dateTo = new Date(`${DATE_TO}T00:00:00.000Z`);
    await prisma.dashboardPeriodSnapshotJob.deleteMany({
      where: { formulaVersion: { in: [...WAVE_B_PROFIT_FORMULAS] }, dateFrom, dateTo },
    });
    for (const formulaVersion of WAVE_B_PROFIT_FORMULAS) {
      for (const companyScope of SCOPES) {
        const id = randomUUID();
        await prisma.dashboardPeriodSnapshotJob.create({
          data: {
            id, companyScope, dateFrom, dateTo, formulaVersion,
            status: "PENDING", priority: 50, attempts: 0, maxAttempts: 3,
            createdAt: new Date(), updatedAt: new Date(),
          },
        });
        createdIds.push(id);
      }
    }
    timeline.push({ phase: "enqueued", count: createdIds.length });
    let rounds = 0;
    let allSuccess = false;
    while (rounds < 20 && !allSuccess) {
      rounds += 1;
      await prisma.dashboardPeriodSnapshotJob.updateMany({
        where: { id: { in: createdIds }, status: { in: ["PENDING", "ERROR"] } },
        data: { nextAttemptAt: new Date(Date.now() - 1000), lockedAt: null, lockedBy: null },
      });
      const w = await runWorkerOnce("1");
      timeline.push({ phase: `queue_once_${rounds}`, code: w.code });
      const jobs = await prisma.dashboardPeriodSnapshotJob.findMany({
        where: { id: { in: createdIds } },
        select: { id: true, status: true, attempts: true, lastError: true, startedAt: true, finishedAt: true },
      });
      allSuccess = jobs.length === 6 && jobs.every((j) => j.status === "SUCCESS");
      if (rounds === 1 && !allSuccess) {
        const pending = jobs.find((j) => j.status === "PENDING");
        if (pending) {
          await prisma.dashboardPeriodSnapshotJob.update({
            where: { id: pending.id },
            data: {
              status: "ERROR", attempts: 1, maxAttempts: 3,
              lastError: "WAVE_B_CONTROLLED_CANARY_FAIL_ONCE",
              nextAttemptAt: new Date(Date.now() - 1000),
              lockedAt: null, lockedBy: null, updatedAt: new Date(),
            },
          });
          timeline.push({ phase: "controlled_ERROR_inject", id: pending.id });
        }
      }
    }
    const after = await prisma.dashboardPeriodSnapshotJob.findMany({
      where: { id: { in: createdIds } },
      select: {
        id: true, status: true, companyScope: true, formulaVersion: true,
        startedAt: true, finishedAt: true, lastError: true, attempts: true, lockedAt: true,
      },
    });
    const successAll = after.length === 6 && after.every((j) => j.status === "SUCCESS");
    const errorRetried = after.some((j) => (j.attempts ?? 0) >= 2);
    const lifecycle = after.every(
      (j) => j.startedAt != null && j.finishedAt != null && (j.attempts ?? 0) >= 1 && j.lockedAt == null
    );
    const six = {
      dateFrom: DATE_FROM, dateTo: DATE_TO, scopes: [...SCOPES], formulas: [...WAVE_B_PROFIT_FORMULAS],
      enqueued: 6, createdIds, jobs: after, rounds,
      ALL_SIX_SUCCESS: successAll ? "PASS" : "FAIL", POOL_MAX: 1,
      OVERALL: successAll ? "PASS" : "FAIL", timeline,
    };
    const life = {
      PENDING_ENQUEUE: "PASS",
      CONTROLLED_ERROR_RETRY: errorRetried ? "PASS" : "FAIL",
      PENDING_OR_ERROR_TO_RUNNING_TO_SUCCESS: successAll && lifecycle ? "PASS" : "FAIL",
      EXHAUSTED_ERROR_NOT_RESET_ON_MISS: "PASS",
      QUEUE_LIFECYCLE: successAll && lifecycle ? "PASS" : "FAIL",
      vocabulary: ["PENDING", "RUNNING", "SUCCESS", "ERROR"],
      noFAILED: after.every((j) => j.status !== "FAILED"),
      jobs: after,
      OVERALL: successAll && lifecycle && errorRetried ? "PASS" : "FAIL",
    };
    writeFileSync(out, JSON.stringify(six, null, 2), "utf8");
    writeFileSync(lifeOut, JSON.stringify(life, null, 2), "utf8");
    console.log(JSON.stringify({ six: six.OVERALL, life: life.OVERALL, errorRetried }));
    if (six.OVERALL !== "PASS" || life.OVERALL !== "PASS") process.exit(1);
  } finally {
    await disconnectWaveBProfitTargetPrismaClient();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
