import {
  PLATFORM_JOB_RUN_STATUSES,
  type JobRunRecord,
  type PlatformJobRunStatus,
} from "./types";

const ALLOWED_TRANSITIONS: Record<
  PlatformJobRunStatus,
  readonly PlatformJobRunStatus[]
> = {
  PENDING: ["RUNNING", "DUPLICATE", "SKIPPED", "FAIL_CLOSED"],
  RUNNING: ["SUCCEEDED", "FAILED", "RATE_LIMITED", "FAIL_CLOSED", "SKIPPED"],
  FAILED: ["RUNNING", "FAIL_CLOSED"],
  RATE_LIMITED: ["RUNNING", "FAIL_CLOSED"],
  SUCCEEDED: [],
  FAIL_CLOSED: [],
  DUPLICATE: [],
  SKIPPED: [],
};

export function canTransitionJobRun(
  from: PlatformJobRunStatus,
  to: PlatformJobRunStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function transitionJobRun(
  run: JobRunRecord,
  to: PlatformJobRunStatus,
  nowIso: string,
  patch: Partial<
    Pick<
      JobRunRecord,
      | "errorClass"
      | "errorCode"
      | "errorMessage"
      | "provenance"
      | "attempts"
      | "startedAt"
      | "finishedAt"
      | "nextAttemptAt"
    >
  > = {},
): JobRunRecord {
  if (!canTransitionJobRun(run.status, to)) {
    throw new Error(
      `Illegal JobRun transition ${run.status} -> ${to} for ${run.id}`,
    );
  }

  const next: JobRunRecord = {
    ...run,
    ...patch,
    status: to,
    updatedAt: nowIso,
  };

  if (to === PLATFORM_JOB_RUN_STATUSES.RUNNING) {
    next.startedAt = patch.startedAt ?? nowIso;
    next.finishedAt = null;
    next.attempts = patch.attempts ?? run.attempts + 1;
  }

  if (
    to === PLATFORM_JOB_RUN_STATUSES.SUCCEEDED ||
    to === PLATFORM_JOB_RUN_STATUSES.FAILED ||
    to === PLATFORM_JOB_RUN_STATUSES.RATE_LIMITED ||
    to === PLATFORM_JOB_RUN_STATUSES.FAIL_CLOSED ||
    to === PLATFORM_JOB_RUN_STATUSES.DUPLICATE ||
    to === PLATFORM_JOB_RUN_STATUSES.SKIPPED
  ) {
    next.finishedAt = patch.finishedAt ?? nowIso;
  }

  if (to === PLATFORM_JOB_RUN_STATUSES.RATE_LIMITED) {
    next.nextAttemptAt = patch.nextAttemptAt ?? nowIso;
  }

  return next;
}

export type JobRunStore = {
  findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<JobRunRecord | null>;
  findByLockKey(lockKey: string): Promise<JobRunRecord | null>;
  save(run: JobRunRecord): Promise<JobRunRecord>;
};

export function createMemoryJobRunStore(): JobRunStore {
  const byId = new Map<string, JobRunRecord>();
  const byIdempotency = new Map<string, string>();
  const byLock = new Map<string, string>();

  return {
    async findByIdempotencyKey(idempotencyKey) {
      const id = byIdempotency.get(idempotencyKey);
      return id ? byId.get(id) ?? null : null;
    },
    async findByLockKey(lockKey) {
      const id = byLock.get(lockKey);
      return id ? byId.get(id) ?? null : null;
    },
    async save(run) {
      byId.set(run.id, run);
      byIdempotency.set(run.idempotencyKey, run.id);

      if (run.status === PLATFORM_JOB_RUN_STATUSES.RUNNING) {
        byLock.set(run.lockKey, run.id);
      } else if (byLock.get(run.lockKey) === run.id) {
        byLock.delete(run.lockKey);
      }

      return run;
    },
  };
}
