/**
 * V2 DashboardPeriodSnapshotJob consumer rebuild / claim rules.
 * Pure helpers. No Prisma and no production writes.
 *
 * Ordinary consumer requestRebuild MUST NEVER turn exhausted ERROR into a
 * new claimable cycle. Only SUCCESS may reopen. ERROR retry belongs to the worker.
 */
export type V6QueueJobLite = {
  status: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt?: Date | string | null;
  lastError?: string | null;
  lockedAt?: Date | string | null;
  lockedBy?: string | null;
};

export type V6JobRebuildDecision =
  | { action: "create" }
  | { action: "keep_existing" }
  | { action: "reopen_success" };

export type V6JobRebuildApplication = {
  action: V6JobRebuildDecision["action"];
  update: ReturnType<typeof v6JobReopenClaimableUpdate> | null;
  next: V6QueueJobLite | null;
};

/** Worker SQL: status IN ('PENDING','ERROR') AND attempts < maxAttempts */
export function isV6QueueClaimable(job: V6QueueJobLite): boolean {
  const status = String(job.status || "");
  const attempts = Number(job.attempts);
  const maxAttempts = Number(job.maxAttempts);
  if (!Number.isFinite(attempts) || !Number.isFinite(maxAttempts) || maxAttempts <= 0) {
    return false;
  }
  return (status === "PENDING" || status === "ERROR") && attempts < maxAttempts;
}

export function isUnclaimableZombiePending(job: V6QueueJobLite): boolean {
  return String(job.status || "") === "PENDING" && Number(job.attempts) >= Number(job.maxAttempts);
}

/**
 * Consumer rebuild decision. SUCCESS may start a new claimable cycle.
 * PENDING/RUNNING/ERROR/unknown are preserved (fail closed).
 */
export function decideV6JobRebuild(existing: V6QueueJobLite | null | undefined): V6JobRebuildDecision {
  if (!existing) return { action: "create" };
  const status = String(existing.status || "");
  if (status === "SUCCESS") return { action: "reopen_success" };
  return { action: "keep_existing" };
}

export function v6JobReopenClaimableUpdate(now: Date, priority: number) {
  return {
    status: "PENDING" as const,
    priority,
    attempts: 0,
    nextAttemptAt: now,
    lockedAt: null,
    lockedBy: null,
    startedAt: null,
    finishedAt: null,
    lastError: null,
    updatedAt: now,
  };
}

/** Apply DECISION + UPDATE together. Tests must use this, not a generic reopen payload. */
export function applyConsumerRebuild(
  existing: V6QueueJobLite | null | undefined,
  now: Date,
  priority: number
): V6JobRebuildApplication {
  const decision = decideV6JobRebuild(existing);
  if (decision.action === "create") {
    return {
      action: "create",
      update: null,
      next: { status: "PENDING", attempts: 0, maxAttempts: 5, lastError: null, nextAttemptAt: now },
    };
  }
  if (decision.action === "reopen_success") {
    const update = v6JobReopenClaimableUpdate(now, priority);
    const maxAttempts = Number(existing?.maxAttempts) > 0 ? Number(existing?.maxAttempts) : 5;
    return {
      action: "reopen_success",
      update,
      next: {
        status: update.status,
        attempts: update.attempts,
        maxAttempts,
        lastError: update.lastError,
        nextAttemptAt: update.nextAttemptAt,
        lockedAt: update.lockedAt,
        lockedBy: update.lockedBy,
      },
    };
  }
  return {
    action: "keep_existing",
    update: null,
    next: existing ? { ...existing } : null,
  };
}
