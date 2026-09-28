import {
  PLATFORM_JOB_TYPES,
  PLATFORM_JOBS_MODES,
  type MarketplaceWorkExecutor,
  type MarketplaceWorkRequest,
  type PlatformJobPayload,
  type PlatformJobsMode,
} from "./types";

/**
 * Shadow adapters for the two Stage 1A pilots.
 * Observe-only: never invoke marketplace executors.
 */
export async function observeOzonAccrualByDay(params: {
  payload: Extract<
    PlatformJobPayload,
    { jobType: typeof PLATFORM_JOB_TYPES.OZON_ACCRUAL_BY_DAY }
  >;
  mode: PlatformJobsMode;
  marketplaceExecutor?: MarketplaceWorkExecutor;
}): Promise<{ observed: true; marketplaceExecuted: false }> {
  void params.marketplaceExecutor;
  void params.mode;

  return { observed: true, marketplaceExecuted: false };
}

export async function observeDailyCompleteness(params: {
  payload: Extract<
    PlatformJobPayload,
    { jobType: typeof PLATFORM_JOB_TYPES.DAILY_COMPLETENESS }
  >;
  mode: PlatformJobsMode;
  marketplaceExecutor?: MarketplaceWorkExecutor;
}): Promise<{ observed: true; marketplaceExecuted: false }> {
  void params.marketplaceExecutor;
  void params.mode;

  return { observed: true, marketplaceExecuted: false };
}

export async function runShadowPilotAdapter(params: {
  payload: PlatformJobPayload;
  mode: PlatformJobsMode;
  marketplaceExecutor?: MarketplaceWorkExecutor;
}): Promise<{ observed: true; marketplaceExecuted: false }> {
  if (params.mode !== PLATFORM_JOBS_MODES.SHADOW) {
    throw new Error("shadow adapters require shadow mode");
  }

  if (params.payload.jobType === PLATFORM_JOB_TYPES.OZON_ACCRUAL_BY_DAY) {
    return observeOzonAccrualByDay({
      payload: params.payload,
      mode: params.mode,
      marketplaceExecutor: params.marketplaceExecutor,
    });
  }

  return observeDailyCompleteness({
    payload: params.payload,
    mode: params.mode,
    marketplaceExecutor: params.marketplaceExecutor,
  });
}

/** Intentionally unused in Stage 1A. Kept typed so a future stage can wire safely. */
export function buildMarketplaceWorkRequest(
  payload: PlatformJobPayload,
): MarketplaceWorkRequest {
  return {
    kind: payload.jobType,
    scope: payload.scope,
    payload,
  };
}
