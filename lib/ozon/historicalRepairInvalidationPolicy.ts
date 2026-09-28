/**
 * Pure helpers for deferred vs normal invalidation contract tests.
 */
export type InvalidationMode = "NORMAL" | "DEFERRED_OWNER_REPAIR";

export function shouldInvalidateSnapshots(mode: InvalidationMode = "NORMAL"): boolean {
  return mode !== "DEFERRED_OWNER_REPAIR";
}

export function shouldInvalidateProfit(mode: InvalidationMode = "NORMAL"): boolean {
  return mode !== "DEFERRED_OWNER_REPAIR";
}

export function separateStatusUpsertForSourceBackfillAllowed(): boolean {
  return false;
}

export function classifyStatusMutation(kind: "INTRINSIC_SOURCE_BACKFILL" | "STANDALONE_STATUS_ONLY" | "NOOP_ALREADY_FINAL") {
  return kind;
}

export function postBatchV2PromotionAllowed(scope: string): boolean {
  return scope === "ALL";
}
