import { createHash } from "node:crypto";

import {
  PLATFORM_JOB_TYPES,
  type JobScope,
  type PlatformJobPayload,
  type PlatformJobType,
} from "./types";

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();

  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function normalizeScope(scope: JobScope): string {
  const companyId = String(scope.companyId ?? "").trim() || "none";
  const companyName = String(scope.companyName ?? "").trim() || "none";
  const marketplace = String(scope.marketplace ?? "ALL").trim().toUpperCase();
  const date = String(scope.date ?? "").trim();
  const extra = String(scope.extra ?? "").trim() || "none";

  return [companyId, companyName, marketplace, date, extra].join("|");
}

export function buildIdempotencyKey(
  jobType: PlatformJobType,
  scope: JobScope,
): string {
  return `jr:v1:${jobType}:${normalizeScope(scope)}`;
}

export function buildLockKey(jobType: PlatformJobType, scope: JobScope): string {
  return `lock:v1:${jobType}:${normalizeScope(scope)}`;
}

export function buildFingerprint(payload: PlatformJobPayload): string {
  if (payload.jobType === PLATFORM_JOB_TYPES.DAILY_COMPLETENESS) {
    return hashCanonical({
      jobType: payload.jobType,
      scope: payload.scope,
      windowDays: payload.windowDays ?? null,
    });
  }

  return hashCanonical({
    jobType: payload.jobType,
    scope: payload.scope,
  });
}

export function buildJobKeys(payload: PlatformJobPayload) {
  return {
    scope: normalizeScope(payload.scope),
    idempotencyKey: buildIdempotencyKey(payload.jobType, payload.scope),
    lockKey: buildLockKey(payload.jobType, payload.scope),
    fingerprint: buildFingerprint(payload),
  };
}
