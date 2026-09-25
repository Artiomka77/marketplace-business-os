import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import {
  createMemoryJobRunStore,
  transitionJobRun,
  type JobRunStore,
} from "./transitions";
import {
  PLATFORM_JOB_RUN_STATUSES,
  type JobRunProvenance,
  type JobRunRecord,
  type PlatformJobRunStatus,
} from "./types";

export const PLATFORM_JOB_STALE_RUNNING_MS = 30 * 60 * 1000;

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function fromDb(row: {
  id: string;
  jobType: string;
  scope: string;
  idempotencyKey: string;
  fingerprint: string;
  lockKey: string;
  status: string;
  attempts: number;
  errorClass: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  provenance: unknown;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): JobRunRecord {
  return {
    id: row.id,
    jobType: row.jobType as JobRunRecord["jobType"],
    scope: row.scope,
    idempotencyKey: row.idempotencyKey,
    fingerprint: row.fingerprint,
    lockKey: row.lockKey,
    status: row.status as PlatformJobRunStatus,
    attempts: row.attempts,
    errorClass: row.errorClass as JobRunRecord["errorClass"],
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    provenance: (row.provenance as JobRunProvenance | null) ?? null,
    queuedAt: row.queuedAt.toISOString(),
    startedAt: toIso(row.startedAt),
    finishedAt: toIso(row.finishedAt),
    nextAttemptAt: toIso(row.nextAttemptAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function isStalePlatformJobRun(
  run: Pick<JobRunRecord, "status" | "startedAt"> | null | undefined,
  now: Date = new Date(),
  staleMs: number = PLATFORM_JOB_STALE_RUNNING_MS,
): boolean {
  if (!run) return false;
  if (run.status !== PLATFORM_JOB_RUN_STATUSES.RUNNING) return false;
  if (!run.startedAt) return true;
  const startedMs = new Date(run.startedAt).getTime();
  if (!Number.isFinite(startedMs)) return true;
  return now.getTime() - startedMs >= staleMs;
}

export function createPrismaJobRunStore(prisma: PrismaClient): JobRunStore {
  return {
    async findByIdempotencyKey(idempotencyKey) {
      const row = await prisma.jobRun.findUnique({ where: { idempotencyKey } });
      return row ? fromDb(row) : null;
    },
    async findByLockKey(lockKey) {
      const row = await prisma.jobRun.findFirst({
        where: { lockKey, status: PLATFORM_JOB_RUN_STATUSES.RUNNING },
        orderBy: { updatedAt: "desc" },
      });
      return row ? fromDb(row) : null;
    },
    async save(run) {
      const data = {
        id: run.id,
        jobType: run.jobType,
        scope: run.scope,
        idempotencyKey: run.idempotencyKey,
        fingerprint: run.fingerprint,
        lockKey: run.lockKey,
        status: run.status,
        attempts: run.attempts,
        errorClass: run.errorClass,
        errorCode: run.errorCode,
        errorMessage: run.errorMessage,
        provenance: run.provenance ?? undefined,
        queuedAt: new Date(run.queuedAt),
        startedAt: run.startedAt ? new Date(run.startedAt) : null,
        finishedAt: run.finishedAt ? new Date(run.finishedAt) : null,
        nextAttemptAt: run.nextAttemptAt ? new Date(run.nextAttemptAt) : null,
        createdAt: new Date(run.createdAt),
        updatedAt: new Date(run.updatedAt),
      };

      const saved = await prisma.jobRun.upsert({
        where: { idempotencyKey: run.idempotencyKey },
        create: data,
        update: {
          fingerprint: data.fingerprint,
          lockKey: data.lockKey,
          status: data.status,
          attempts: data.attempts,
          errorClass: data.errorClass,
          errorCode: data.errorCode,
          errorMessage: data.errorMessage,
          provenance: data.provenance,
          startedAt: data.startedAt,
          finishedAt: data.finishedAt,
          nextAttemptAt: data.nextAttemptAt,
          updatedAt: data.updatedAt,
        },
      });

      return fromDb(saved);
    },
  };
}

export function createPendingJobRunRecord(input: {
  jobType: JobRunRecord["jobType"] | string;
  scope: string;
  idempotencyKey: string;
  fingerprint: string;
  lockKey: string;
  now?: Date;
  provenance?: JobRunProvenance | null;
}): JobRunRecord {
  const stamp = (input.now ?? new Date()).toISOString();
  return {
    id: randomUUID(),
    jobType: input.jobType as JobRunRecord["jobType"],
    scope: input.scope,
    idempotencyKey: input.idempotencyKey,
    fingerprint: input.fingerprint,
    lockKey: input.lockKey,
    status: PLATFORM_JOB_RUN_STATUSES.PENDING,
    attempts: 0,
    errorClass: null,
    errorCode: null,
    errorMessage: null,
    provenance: input.provenance ?? null,
    queuedAt: stamp,
    startedAt: null,
    finishedAt: null,
    nextAttemptAt: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/**
 * Acquire RUNNING for an idempotent completeness/job scope.
 * Stale RUNNING (null startedAt or aged past lease) is fail-closed to FAILED then reclaimed.
 * Critical: persistence errors propagate (not swallowed).
 */
export async function acquirePlatformJobRun(input: {
  store: JobRunStore;
  pending: JobRunRecord;
  now?: Date;
  staleMs?: number;
}): Promise<
  | { ok: true; run: JobRunRecord }
  | { ok: false; reason: "IN_FLIGHT"; run: JobRunRecord }
> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const existing = await input.store.findByIdempotencyKey(
    input.pending.idempotencyKey,
  );

  if (
    existing &&
    existing.status === PLATFORM_JOB_RUN_STATUSES.RUNNING &&
    !isStalePlatformJobRun(existing, now, input.staleMs)
  ) {
    return { ok: false, reason: "IN_FLIGHT", run: existing };
  }

  let base = existing ?? input.pending;

  if (
    existing &&
    existing.status === PLATFORM_JOB_RUN_STATUSES.RUNNING &&
    isStalePlatformJobRun(existing, now, input.staleMs)
  ) {
    base = await input.store.save(
      transitionJobRun(existing, PLATFORM_JOB_RUN_STATUSES.FAILED, nowIso, {
        errorClass: "RETRYABLE",
        errorCode: "STALE_RUNNING_RECLAIMED",
        errorMessage: "stale RUNNING reclaimed before restart",
        finishedAt: nowIso,
      }),
    );
  }

  if (
    base.status === PLATFORM_JOB_RUN_STATUSES.SUCCEEDED ||
    base.status === PLATFORM_JOB_RUN_STATUSES.FAIL_CLOSED ||
    base.status === PLATFORM_JOB_RUN_STATUSES.DUPLICATE ||
    base.status === PLATFORM_JOB_RUN_STATUSES.SKIPPED
  ) {
    // Allow re-run of FAILED/RATE_LIMITED only; terminal success stays idempotent.
    if (base.status === PLATFORM_JOB_RUN_STATUSES.SUCCEEDED) {
      return { ok: false, reason: "IN_FLIGHT", run: base };
    }
  }

  const startFrom =
    base.status === PLATFORM_JOB_RUN_STATUSES.FAILED ||
    base.status === PLATFORM_JOB_RUN_STATUSES.RATE_LIMITED ||
    base.status === PLATFORM_JOB_RUN_STATUSES.PENDING
      ? base
      : await input.store.save(input.pending);

  const running = await input.store.save(
    transitionJobRun(startFrom, PLATFORM_JOB_RUN_STATUSES.RUNNING, nowIso),
  );
  return { ok: true, run: running };
}

export async function finishPlatformJobRun(input: {
  store: JobRunStore;
  run: JobRunRecord;
  ok: boolean;
  now?: Date;
  retryable?: boolean;
  errorCode?: string | null;
  errorMessage?: string | null;
  provenance?: JobRunProvenance | null;
}): Promise<JobRunRecord> {
  const nowIso = (input.now ?? new Date()).toISOString();
  if (input.ok) {
    return input.store.save(
      transitionJobRun(input.run, PLATFORM_JOB_RUN_STATUSES.SUCCEEDED, nowIso, {
        provenance: input.provenance ?? input.run.provenance,
        errorClass: null,
        errorCode: null,
        errorMessage: null,
      }),
    );
  }

  if (input.retryable) {
    const failed = transitionJobRun(
      input.run,
      PLATFORM_JOB_RUN_STATUSES.FAILED,
      nowIso,
      {
        errorClass: "RETRYABLE",
        errorCode: input.errorCode ?? "RETRYABLE_FAILURE",
        errorMessage: input.errorMessage ?? "retryable failure",
        nextAttemptAt: nowIso,
        provenance: input.provenance ?? input.run.provenance,
      },
    );
    return input.store.save(failed);
  }

  return input.store.save(
    transitionJobRun(input.run, PLATFORM_JOB_RUN_STATUSES.FAILED, nowIso, {
      errorClass: "FATAL",
      errorCode: input.errorCode ?? "FAILED",
      errorMessage: input.errorMessage ?? "failed",
      provenance: input.provenance ?? input.run.provenance,
    }),
  );
}

export { createMemoryJobRunStore };
