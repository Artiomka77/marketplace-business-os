export const PLATFORM_JOBS_SCHEMA_VERSION = 1 as const;

export const PLATFORM_JOB_TYPES = {
  OZON_ACCRUAL_BY_DAY: "OZON_ACCRUAL_BY_DAY",
  DAILY_COMPLETENESS: "DAILY_COMPLETENESS",
} as const;

export type PlatformJobType =
  (typeof PLATFORM_JOB_TYPES)[keyof typeof PLATFORM_JOB_TYPES];

export const PLATFORM_JOB_RUN_STATUSES = {
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  RATE_LIMITED: "RATE_LIMITED",
  FAIL_CLOSED: "FAIL_CLOSED",
  DUPLICATE: "DUPLICATE",
  SKIPPED: "SKIPPED",
} as const;

export type PlatformJobRunStatus =
  (typeof PLATFORM_JOB_RUN_STATUSES)[keyof typeof PLATFORM_JOB_RUN_STATUSES];

export const PLATFORM_ERROR_CLASSES = {
  RETRYABLE: "RETRYABLE",
  RATE_LIMIT: "RATE_LIMIT",
  FAIL_CLOSED: "FAIL_CLOSED",
  FATAL: "FATAL",
} as const;

export type PlatformErrorClass =
  (typeof PLATFORM_ERROR_CLASSES)[keyof typeof PLATFORM_ERROR_CLASSES];

export const PLATFORM_JOBS_MODES = {
  LEGACY: "legacy",
  SHADOW: "shadow",
} as const;

export type PlatformJobsMode =
  (typeof PLATFORM_JOBS_MODES)[keyof typeof PLATFORM_JOBS_MODES];

export type JobScope = {
  companyId: string | null;
  companyName: string | null;
  marketplace: "OZON" | "ALL";
  date: string;
  extra?: string | null;
};

export type OzonAccrualByDayPayload = {
  jobType: typeof PLATFORM_JOB_TYPES.OZON_ACCRUAL_BY_DAY;
  scope: JobScope;
  accrualTypeCode?: string | null;
};

export type DailyCompletenessPayload = {
  jobType: typeof PLATFORM_JOB_TYPES.DAILY_COMPLETENESS;
  scope: JobScope;
  windowDays?: number;
};

export type PlatformJobPayload =
  | OzonAccrualByDayPayload
  | DailyCompletenessPayload;

export type JobRunProvenance = {
  schemaVersion: typeof PLATFORM_JOBS_SCHEMA_VERSION;
  source: "platform-jobs";
  mode: PlatformJobsMode;
  actor: string;
  stage: "platform-core-v1-stage-1a";
  observedOnly: boolean;
  marketplaceExecuted: boolean;
};

export type SafeJobErrorMetadata = {
  errorClass: PlatformErrorClass;
  errorCode: string;
  errorMessage: string;
};

export type JobRunRecord = {
  id: string;
  jobType: PlatformJobType;
  scope: string;
  idempotencyKey: string;
  fingerprint: string;
  lockKey: string;
  status: PlatformJobRunStatus;
  attempts: number;
  errorClass: PlatformErrorClass | null;
  errorCode: string | null;
  errorMessage: string | null;
  provenance: JobRunProvenance | null;
    queuedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    nextAttemptAt: string | null;
    createdAt: string;
    updatedAt: string;
};

export type MarketplaceWorkRequest = {
  kind: PlatformJobType;
  scope: JobScope;
  payload: PlatformJobPayload;
};

export type MarketplaceWorkExecutor = (
  request: MarketplaceWorkRequest,
) => Promise<void>;
