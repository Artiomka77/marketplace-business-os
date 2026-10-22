import {
  PLATFORM_JOB_TYPES,
  type PlatformJobPayload,
  type PlatformJobType,
} from "./types";

/** BullMQ queue/job contracts only. No Redis/BullMQ runtime dependency. */
export const PLATFORM_QUEUE_NAME = "avorofin-platform-jobs" as const;

export const PLATFORM_QUEUE_JOB_NAMES = {
  [PLATFORM_JOB_TYPES.OZON_ACCRUAL_BY_DAY]: "ozon-accrual-by-day",
  [PLATFORM_JOB_TYPES.DAILY_COMPLETENESS]: "daily-completeness",
} as const;

export const PLATFORM_JOB_DEFAULT_ATTEMPTS = 5 as const;
export const PLATFORM_JOB_BACKOFF_MS = 30_000 as const;

export type PlatformBullMqJobOptions = {
  jobId: string;
  attempts: number;
  backoff: {
    type: "exponential";
    delay: number;
  };
  removeOnComplete: number;
  removeOnFail: number;
};

export type PlatformBullMqJobContract<T extends PlatformJobType = PlatformJobType> = {
  queueName: typeof PLATFORM_QUEUE_NAME;
  name: (typeof PLATFORM_QUEUE_JOB_NAMES)[T];
  data: Extract<PlatformJobPayload, { jobType: T }>;
  opts: PlatformBullMqJobOptions;
};

export function buildBullMqJobContract(
  payload: PlatformJobPayload,
  idempotencyKey: string,
): PlatformBullMqJobContract {
  return {
    queueName: PLATFORM_QUEUE_NAME,
    name: PLATFORM_QUEUE_JOB_NAMES[payload.jobType],
    data: payload as never,
    opts: {
      jobId: idempotencyKey,
      attempts: PLATFORM_JOB_DEFAULT_ATTEMPTS,
      backoff: {
        type: "exponential",
        delay: PLATFORM_JOB_BACKOFF_MS,
      },
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  };
}

export function isPilotJobType(value: string): value is PlatformJobType {
  return (
    value === PLATFORM_JOB_TYPES.OZON_ACCRUAL_BY_DAY ||
    value === PLATFORM_JOB_TYPES.DAILY_COMPLETENESS
  );
}
