/**
 * Waits for the candidate read-model workers to drain exactly the work the repair
 * requeued, and refuses anything else.
 *
 * EXECUTE_FROM_CACHE deletes 35 V4 period snapshots and requeues their jobs, and
 * enqueues the 2 ALL-scope V6 period read-model rows. The host wrapper starts the
 * candidate v6 + dashboard workers after the mutation and then has to prove the
 * queue actually drained — "the containers are running" is not evidence.
 *
 * This polls the job table read-only and demands EXACT counts: exactly the expected
 * number of SUCCESS rows touched inside the operation window, zero ERROR rows, and
 * zero rows still PENDING or RUNNING. A surplus SUCCESS row is as much a failure as
 * a missing one, because it means something outside the approved blast radius ran.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1,
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
} from "@/lib/ozon/financialRepairProductionAdapters";
import { prisma } from "@/lib/prisma";

export type DrainStatusCounts = {
  SUCCESS: number;
  ERROR: number;
  PENDING: number;
  RUNNING: number;
  OTHER: number;
};

export type DrainObservation = {
  formulaVersion: string;
  expectedSuccess: number;
  counts: DrainStatusCounts;
  settled: boolean;
  failures: string[];
};

const TERMINAL_FAILURE_STATUSES = new Set(["ERROR"]);

export function evaluateDrainCounts(params: {
  formulaVersion: string;
  expectedSuccess: number;
  rows: Array<{ status: string; count: number }>;
}): DrainObservation {
  const counts: DrainStatusCounts = {
    SUCCESS: 0,
    ERROR: 0,
    PENDING: 0,
    RUNNING: 0,
    OTHER: 0,
  };
  for (const row of params.rows) {
    const status = String(row.status).toUpperCase();
    if (status in counts) {
      counts[status as keyof DrainStatusCounts] += Number(row.count);
    } else {
      counts.OTHER += Number(row.count);
    }
  }
  const failures: string[] = [];
  if (counts.ERROR > 0) {
    failures.push(`${params.formulaVersion} has ${counts.ERROR} ERROR jobs`);
  }
  if (counts.OTHER > 0) {
    failures.push(`${params.formulaVersion} has ${counts.OTHER} jobs in an unexpected status`);
  }
  if (counts.SUCCESS > params.expectedSuccess) {
    failures.push(
      `${params.formulaVersion} has ${counts.SUCCESS} SUCCESS jobs, expected exactly ${params.expectedSuccess}`,
    );
  }
  const settled =
    failures.length === 0 &&
    counts.SUCCESS === params.expectedSuccess &&
    counts.PENDING === 0 &&
    counts.RUNNING === 0;
  return {
    formulaVersion: params.formulaVersion,
    expectedSuccess: params.expectedSuccess,
    counts,
    settled,
    failures,
  };
}

async function observe(params: {
  formulaVersion: string;
  expectedSuccess: number;
  operationStartedAt: string;
}): Promise<DrainObservation> {
  const rows = await prisma.$queryRaw<Array<{ status: string; count: number }>>`
    SELECT "status", COUNT(*)::int AS "count"
    FROM "DashboardPeriodSnapshotJob"
    WHERE "formulaVersion" = ${params.formulaVersion}
      AND "updatedAt" >= ${params.operationStartedAt}::timestamptz
    GROUP BY 1
    ORDER BY 1
  `;
  return evaluateDrainCounts({
    formulaVersion: params.formulaVersion,
    expectedSuccess: params.expectedSuccess,
    rows,
  });
}

function requireArg(args: Record<string, string>, name: string): string {
  const value = args[name];
  if (!value || value === "UNSET") {
    throw new Error(`WORKER_DRAIN_FAILED EXECUTION=BLOCKED missing --${name}`);
  }
  return value;
}

function requireCount(args: Record<string, string>, name: string): number {
  const raw = requireArg(args, name);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`WORKER_DRAIN_FAILED EXECUTION=BLOCKED --${name} must be an integer`);
  }
  return Number(raw);
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export async function runWorkerDrainCli(argv = process.argv.slice(2)): Promise<number> {
  const args = Object.fromEntries(
    argv
      .filter((arg) => arg.startsWith("--") && arg.includes("="))
      .map((arg) => {
        const eq = arg.indexOf("=");
        return [arg.slice(2, eq), arg.slice(eq + 1)];
      }),
  ) as Record<string, string>;

  const operationStartedAt = requireArg(args, "operationStartedAt");
  const v6FormulaVersion = args.v6FormulaVersion || FINANCIAL_CORE_V6_PERIOD_READMODEL_V2;
  const snapshotFormulaVersion =
    args.snapshotFormulaVersion || FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1;
  const v6ExpectedSuccess = requireCount(args, "v6ExpectedSuccess");
  const snapshotExpectedSuccess = requireCount(args, "snapshotExpectedSuccess");
  const timeoutSeconds = requireCount(args, "timeoutSeconds");
  const pollSeconds = Math.max(1, Number(args.pollSeconds ?? "10") || 10);
  const outDir = resolve(args.outDir || ".");
  mkdirSync(outDir, { recursive: true });

  const startedAt = Date.now();
  const deadline = startedAt + timeoutSeconds * 1000;
  let attempts = 0;
  const empty = (formulaVersion: string, expectedSuccess: number): DrainObservation =>
    evaluateDrainCounts({ formulaVersion, expectedSuccess, rows: [] });
  let v6: DrainObservation = empty(v6FormulaVersion, v6ExpectedSuccess);
  let snapshot: DrainObservation = empty(snapshotFormulaVersion, snapshotExpectedSuccess);
  let hardFailures: string[] = [];

  for (;;) {
    attempts += 1;
    [v6, snapshot] = await Promise.all([
      observe({
        formulaVersion: v6FormulaVersion,
        expectedSuccess: v6ExpectedSuccess,
        operationStartedAt,
      }),
      observe({
        formulaVersion: snapshotFormulaVersion,
        expectedSuccess: snapshotExpectedSuccess,
        operationStartedAt,
      }),
    ]);
    hardFailures = [...v6.failures, ...snapshot.failures];
    console.log(
      `WORKER_DRAIN attempt=${attempts} v6=${v6.counts.SUCCESS}/${v6ExpectedSuccess} ` +
        `snapshot=${snapshot.counts.SUCCESS}/${snapshotExpectedSuccess} ` +
        `pending=${v6.counts.PENDING + snapshot.counts.PENDING} ` +
        `running=${v6.counts.RUNNING + snapshot.counts.RUNNING}`,
    );
    // A hard failure can only get worse by waiting; stop immediately.
    if (hardFailures.length > 0) break;
    if (v6.settled && snapshot.settled) break;
    if (Date.now() >= deadline) {
      hardFailures.push(
        `drain did not settle within ${timeoutSeconds}s ` +
          `(v6 SUCCESS=${v6.counts.SUCCESS}/${v6ExpectedSuccess}, ` +
          `snapshot SUCCESS=${snapshot.counts.SUCCESS}/${snapshotExpectedSuccess})`,
      );
      break;
    }
    await sleep(pollSeconds * 1000);
  }

  const ok = hardFailures.length === 0 && v6.settled && snapshot.settled;
  const report = {
    WORKER_DRAIN: ok ? "PASS" : "FAIL",
    DATABASE_ACCESS: "READ_ONLY",
    operationStartedAt,
    attempts,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
    timeoutSeconds,
    terminalFailureStatuses: [...TERMINAL_FAILURE_STATUSES],
    v6,
    snapshot,
    failures: hardFailures,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(
    join(outDir, "WORKER_DRAIN_RESULT.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
  return ok ? 0 : 1;
}

const isDirect =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  Boolean(process.argv[1]) &&
  /pollRepairWorkerDrain\.(ts|js|mjs|cjs)$/.test(String(process.argv[1]).replace(/\\/g, "/"));
if (isDirect) {
  runWorkerDrainCli()
    .then(
      (code) => {
        process.exitCode = code;
      },
      (error) => {
        console.error(error);
        process.exitCode = 1;
      },
    )
    .finally(() => prisma.$disconnect().catch(() => undefined));
}
