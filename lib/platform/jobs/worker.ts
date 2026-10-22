import { randomUUID } from "node:crypto";

import { runShadowPilotAdapter } from "./adapters";
import { PLATFORM_JOB_DEFAULT_ATTEMPTS } from "./contracts";
import { classifyPlatformError, statusForErrorClass } from "./errors";
import { buildJobKeys } from "./keys";
import { resolvePlatformJobsMode } from "./mode";
import { assertOzonAccrualTypeAllowed } from "./ozonPilot";
import {
  createMemoryJobRunStore,
  transitionJobRun,
  type JobRunStore,
} from "./transitions";
import {
  PLATFORM_JOB_TYPES,
  PLATFORM_JOB_RUN_STATUSES,
  PLATFORM_JOBS_MODES,
  PLATFORM_JOBS_SCHEMA_VERSION,
  type JobRunProvenance,
  type JobRunRecord,
  type MarketplaceWorkExecutor,
  type PlatformJobPayload,
  type PlatformJobsMode,
} from "./types";

export type HandlePlatformJobInput = {
  payload: PlatformJobPayload;
  store?: JobRunStore;
  mode?: PlatformJobsMode;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  now?: () => Date;
  actor?: string;
  marketplaceExecutor?: MarketplaceWorkExecutor;
  maxAttempts?: number;
};

function nowIso(now: () => Date) {
  return now().toISOString();
}

function createProvenance(params: {
  mode: PlatformJobsMode;
  actor: string;
  observedOnly: boolean;
  marketplaceExecuted: boolean;
}): JobRunProvenance {
  return {
    schemaVersion: PLATFORM_JOBS_SCHEMA_VERSION,
    source: "platform-jobs",
    mode: params.mode,
    actor: params.actor,
    stage: "platform-core-v1-stage-1a",
    observedOnly: params.observedOnly,
    marketplaceExecuted: params.marketplaceExecuted,
  };
}

function createPendingRun(params: {
  payload: PlatformJobPayload;
  keys: ReturnType<typeof buildJobKeys>;
  now: () => Date;
}): JobRunRecord {
  const stamp = nowIso(params.now);

  return {
    id: randomUUID(),
    jobType: params.payload.jobType,
    scope: params.keys.scope,
    idempotencyKey: params.keys.idempotencyKey,
    fingerprint: params.keys.fingerprint,
    lockKey: params.keys.lockKey,
    status: PLATFORM_JOB_RUN_STATUSES.PENDING,
    attempts: 0,
    errorClass: null,
    errorCode: null,
    errorMessage: null,
    provenance: null,
    queuedAt: stamp,
    startedAt: null,
    finishedAt: null,
    nextAttemptAt: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

function terminalObservation(params: {
  base: JobRunRecord;
  status: typeof PLATFORM_JOB_RUN_STATUSES.DUPLICATE | typeof PLATFORM_JOB_RUN_STATUSES.FAIL_CLOSED;
  mode: PlatformJobsMode;
  actor: string;
  now: () => Date;
  errorCode?: string;
  errorMessage?: string;
}): JobRunRecord {
  const stamp = nowIso(params.now);

  return {
    ...params.base,
    id: randomUUID(),
    status: params.status,
    errorClass: params.status === PLATFORM_JOB_RUN_STATUSES.FAIL_CLOSED ? "FAIL_CLOSED" : null,
    errorCode: params.errorCode ?? null,
    errorMessage: params.errorMessage ?? null,
    provenance: createProvenance({
      mode: params.mode,
      actor: params.actor,
      observedOnly: true,
      marketplaceExecuted: false,
    }),
    finishedAt: stamp,
    updatedAt: stamp,
  };
}

/**
 * Shared worker handler for both Stage 1A pilot job types.
 * Legacy remains default. Shadow is observe-only and never double-executes.
 */
export async function handlePlatformJob(
  input: HandlePlatformJobInput,
): Promise<JobRunRecord> {
  const store = input.store ?? createMemoryJobRunStore();
  const now = input.now ?? (() => new Date());
  const actor = input.actor ?? "platform-worker";
  const maxAttempts = input.maxAttempts ?? PLATFORM_JOB_DEFAULT_ATTEMPTS;
  const mode =
    input.mode ?? resolvePlatformJobsMode(input.env ?? process.env);
  const keys = buildJobKeys(input.payload);
  const marketplaceExecutor = input.marketplaceExecutor;

  const existing = await store.findByIdempotencyKey(keys.idempotencyKey);

  if (existing) {
    if (existing.fingerprint !== keys.fingerprint) {
      return terminalObservation({
        base: existing,
        status: PLATFORM_JOB_RUN_STATUSES.FAIL_CLOSED,
        mode,
        actor,
        now,
        errorCode: "FINGERPRINT_CONFLICT",
        errorMessage: "fail-closed: fingerprint conflict for idempotency key",
      });
    }

    if (existing.status === PLATFORM_JOB_RUN_STATUSES.SUCCEEDED) {
      return terminalObservation({
        base: existing,
        status: PLATFORM_JOB_RUN_STATUSES.DUPLICATE,
        mode,
        actor,
        now,
      });
    }

    if (
      existing.status === PLATFORM_JOB_RUN_STATUSES.RUNNING ||
      existing.status === PLATFORM_JOB_RUN_STATUSES.SKIPPED ||
      existing.status === PLATFORM_JOB_RUN_STATUSES.FAIL_CLOSED ||
      existing.status === PLATFORM_JOB_RUN_STATUSES.DUPLICATE
    ) {
      return terminalObservation({
        base: existing,
        status: PLATFORM_JOB_RUN_STATUSES.DUPLICATE,
        mode,
        actor,
        now,
      });
    }

    if (
      (existing.status === PLATFORM_JOB_RUN_STATUSES.FAILED ||
        existing.status === PLATFORM_JOB_RUN_STATUSES.RATE_LIMITED) &&
      existing.attempts >= maxAttempts
    ) {
      return store.save(
        transitionJobRun(
          existing,
          PLATFORM_JOB_RUN_STATUSES.FAIL_CLOSED,
          nowIso(now),
          {
            errorClass: "FAIL_CLOSED",
            errorCode: "MAX_ATTEMPTS",
            errorMessage: "fail-closed: max attempts exhausted",
            provenance: createProvenance({
              mode,
              actor,
              observedOnly: true,
              marketplaceExecuted: false,
            }),
          },
        ),
      );
    }
  }

  const locked = await store.findByLockKey(keys.lockKey);
  if (
    locked &&
    locked.status === PLATFORM_JOB_RUN_STATUSES.RUNNING &&
    locked.idempotencyKey !== keys.idempotencyKey
  ) {
    return terminalObservation({
      base: createPendingRun({ payload: input.payload, keys, now }),
      status: PLATFORM_JOB_RUN_STATUSES.DUPLICATE,
      mode,
      actor,
      now,
    });
  }

  let run =
    existing &&
    (existing.status === PLATFORM_JOB_RUN_STATUSES.FAILED ||
      existing.status === PLATFORM_JOB_RUN_STATUSES.RATE_LIMITED)
      ? existing
      : await store.save(
          createPendingRun({
            payload: input.payload,
            keys,
            now,
          }),
        );

  try {
    if (
      input.payload.jobType === PLATFORM_JOB_TYPES.OZON_ACCRUAL_BY_DAY &&
      input.payload.accrualTypeCode !== undefined &&
      input.payload.accrualTypeCode !== null
    ) {
      assertOzonAccrualTypeAllowed(input.payload.accrualTypeCode);
    }

    run = await store.save(
      transitionJobRun(run, PLATFORM_JOB_RUN_STATUSES.RUNNING, nowIso(now)),
    );

    // Stage 1A: never call marketplaceExecutor in legacy or shadow.
    void marketplaceExecutor;

    if (mode === PLATFORM_JOBS_MODES.LEGACY) {
      return store.save(
        transitionJobRun(run, PLATFORM_JOB_RUN_STATUSES.SKIPPED, nowIso(now), {
          provenance: createProvenance({
            mode,
            actor,
            observedOnly: true,
            marketplaceExecuted: false,
          }),
        }),
      );
    }

    await runShadowPilotAdapter({
      payload: input.payload,
      mode,
      marketplaceExecutor,
    });

    return store.save(
      transitionJobRun(run, PLATFORM_JOB_RUN_STATUSES.SUCCEEDED, nowIso(now), {
        provenance: createProvenance({
          mode,
          actor,
          observedOnly: true,
          marketplaceExecuted: false,
        }),
      }),
    );
  } catch (error) {
    const safe = classifyPlatformError(error);
    const status = statusForErrorClass(safe.errorClass);
    const from =
      run.status === PLATFORM_JOB_RUN_STATUSES.RUNNING
        ? run
        : await store.save(
            transitionJobRun(run, PLATFORM_JOB_RUN_STATUSES.RUNNING, nowIso(now)),
          );

    return store.save(
      transitionJobRun(from, status, nowIso(now), {
        errorClass: safe.errorClass,
        errorCode: safe.errorCode,
        errorMessage: safe.errorMessage,
        nextAttemptAt:
          status === PLATFORM_JOB_RUN_STATUSES.RATE_LIMITED
            ? new Date(now().getTime() + 60_000).toISOString()
            : null,
        provenance: createProvenance({
          mode,
          actor,
          observedOnly: true,
          marketplaceExecuted: false,
        }),
      }),
    );
  }
}
