import type { SafePrismaPoolSnapshot } from "./prismaPoolConfig";
import type { TransientDatabaseClassification } from "./transientDatabaseError";

export type AnalyticsSurface = "dashboard" | "profit-wb" | "profit-ozon" | "sentinel";

export type AnalyticsDbUnavailableLog = {
  event: "analytics_db_unavailable";
  timestamp: string;
  surface: AnalyticsSurface;
  classificationSafeCode: string;
  retryAttempt: number;
  pool: SafePrismaPoolSnapshot;
  dataMode: "UNAVAILABLE";
};

const SENSITIVE = /password|secret|token|cookie|database_url|postgresql:\/\/|postgres:\/\//i;

export function buildAnalyticsDbUnavailableLog(params: {
  surface: AnalyticsSurface;
  classification: TransientDatabaseClassification;
  retryAttempt: number;
  pool: SafePrismaPoolSnapshot;
  now?: () => Date;
}): AnalyticsDbUnavailableLog {
  const payload: AnalyticsDbUnavailableLog = {
    event: "analytics_db_unavailable",
    timestamp: (params.now ?? (() => new Date()))().toISOString(),
    surface: params.surface,
    classificationSafeCode: params.classification.safeCode,
    retryAttempt: params.retryAttempt,
    pool: {
      total: params.pool.total,
      idle: params.pool.idle,
      waiting: params.pool.waiting,
      max: params.pool.max,
      connectionTimeoutMillis: params.pool.connectionTimeoutMillis,
    },
    dataMode: "UNAVAILABLE",
  };
  const serialized = JSON.stringify(payload);
  if (SENSITIVE.test(serialized)) {
    throw new Error("refusing to serialize sensitive pool log");
  }
  return payload;
}

export function logAnalyticsDbUnavailable(params: {
  surface: AnalyticsSurface;
  classification: TransientDatabaseClassification;
  retryAttempt: number;
  pool: SafePrismaPoolSnapshot;
}): void {
  const payload = buildAnalyticsDbUnavailableLog(params);
  console.error(JSON.stringify(payload));
}

export function inferPoolContentionClass(pool: SafePrismaPoolSnapshot):
  | "local_pool_starvation"
  | "upstream_or_network"
  | "unknown" {
  if (pool.waiting > 0 && pool.idle === 0 && pool.total >= pool.max) {
    return "local_pool_starvation";
  }
  if (pool.waiting === 0 && pool.total < pool.max) {
    return "upstream_or_network";
  }
  return "unknown";
}
