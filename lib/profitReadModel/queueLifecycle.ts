/**
 * Wave B reuses V2 DashboardPeriodSnapshotJob claim/rebuild vocabulary.
 * Re-export certified helpers so Wave B does not invent a divergent queue.
 */
export {
  applyConsumerRebuild,
  decideV6JobRebuild,
  isUnclaimableZombiePending,
  isV6QueueClaimable,
  v6JobReopenClaimableUpdate,
  type V6JobRebuildApplication,
  type V6JobRebuildDecision,
  type V6QueueJobLite,
} from "@/lib/dashboard/v6PeriodReadModel/queueLifecycle";

export {
  applyAtomicV6JobRebuildWrite,
  type V6JobWriteRow,
} from "@/lib/dashboard/v6PeriodReadModel/repository";

export { buildDashboardPeriodSnapshotJobId } from "@/lib/dashboard/v6PeriodReadModel/jobIdentity";
