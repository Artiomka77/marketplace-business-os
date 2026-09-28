import assert from "node:assert/strict";
import test from "node:test";

import {
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V1,
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
  buildDashboardPeriodSnapshotJobId,
  buildLegacyDashboardPeriodSnapshotJobId,
} from "../../lib/dashboard/v6PeriodReadModel";
import {
  applyAtomicV6JobRebuildWrite,
  type V6JobWriteRow,
} from "../../lib/dashboard/v6PeriodReadModel/repository";
import {
  decideV6JobRebuild,
  isUnclaimableZombiePending,
  isV6QueueClaimable,
} from "../../lib/dashboard/v6PeriodReadModel/queueLifecycle";

const TARGET = { dateFrom: "2026-08-10", dateTo: "2026-08-16" };
const STUCK_ID = "v6rmj_3e529cbdedbcfc990c199cd96a888fdb4b237a4d4eece52808fbe87b2f75caa0";
const LEGACY_V1 = "v6rm_QUxMfDIwMjYtMDktMDF8MjAyNi0wOS0wMw";
const NOW = new Date("2026-09-05T18:00:00.000Z");
const BACKOFF = new Date("2026-09-05T19:00:00.000Z");
const DATE_FROM = new Date("2026-08-10T00:00:00.000Z");
const DATE_TO = new Date("2026-08-16T00:00:00.000Z");
const FORMULA = FINANCIAL_CORE_V6_PERIOD_READMODEL_V2;

type StoredJob = V6JobWriteRow & {
  companyScope: string;
  dateFrom: Date;
  dateTo: Date;
  formulaVersion: string;
  priority?: number;
  createdAt?: Date;
  updatedAt?: Date;
};

function createJobStore(initial: StoredJob | null) {
  let row: StoredJob | null = initial ? { ...initial } : null;
  let p2002 = 0;
  let upsertCalls = 0;
  const jobs = {
    findFirst: async (_args?: unknown) => (row ? { ...row } : null),
    updateMany: async (args: unknown) => {
      const a = args as { where?: { id?: string; status?: string }; data?: Record<string, unknown> };
      if (!row) return { count: 0 };
      if (a.where?.id && row.id !== a.where.id) return { count: 0 };
      if (a.where?.status && row.status !== a.where.status) return { count: 0 };
      Object.assign(row, a.data || {});
      return { count: 1 };
    },
    create: async (args: unknown) => {
      const data = (args as { data: StoredJob }).data;
      if (row) {
        p2002 += 1;
        const err = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        throw err;
      }
      row = { ...data };
      return { ...row };
    },
    upsert: async (_args?: unknown) => {
      upsertCalls += 1;
      throw new Error("unconditional upsert is forbidden on the atomic SUCCESS path");
    },
  };
  return {
    jobs,
    snapshot: () => (row ? { ...row } : null),
    replace: (next: StoredJob) => {
      row = { ...next };
    },
    p2002Count: () => p2002,
    upsertCalls: () => upsertCalls,
  };
}

function baseJob(partial: Partial<StoredJob> & Pick<StoredJob, "status" | "attempts" | "maxAttempts">): StoredJob {
  return {
    id: STUCK_ID,
    companyScope: "ALL",
    dateFrom: DATE_FROM,
    dateTo: DATE_TO,
    formulaVersion: FORMULA,
    lockedAt: null,
    lockedBy: null,
    startedAt: null,
    finishedAt: null,
    nextAttemptAt: null,
    lastError: null,
    ...partial,
  };
}

async function write(store: ReturnType<typeof createJobStore>, existing: V6JobWriteRow | null) {
  return applyAtomicV6JobRebuildWrite({
    jobs: store.jobs,
    existing,
    id: STUCK_ID,
    formula: FORMULA,
    companyScope: "ALL",
    dateFrom: DATE_FROM,
    dateTo: DATE_TO,
    now: NOW,
    priority: 100,
    dateFromRaw: TARGET.dateFrom,
    dateToRaw: TARGET.dateTo,
  });
}

test("1 SUCCESS/5/5 conditional SUCCESS write wins -> PENDING/0/5", async () => {
  const store = createJobStore(baseJob({ status: "SUCCESS", attempts: 5, maxAttempts: 5 }));
  assert.equal(decideV6JobRebuild(store.snapshot()!).action, "reopen_success");
  const result = await write(store, store.snapshot());
  assert.equal(result, "queued_prisma");
  const after = store.snapshot()!;
  assert.equal(after.status, "PENDING");
  assert.equal(after.attempts, 0);
  assert.equal(after.maxAttempts, 5);
  assert.equal(after.lastError, null);
  assert.equal(isV6QueueClaimable(after), true);
  assert.equal(store.upsertCalls(), 0);
});

test("2 ERROR/4/5 preserved with backoff", async () => {
  const store = createJobStore(
    baseJob({ status: "ERROR", attempts: 4, maxAttempts: 5, nextAttemptAt: BACKOFF, lastError: "transient" })
  );
  await write(store, store.snapshot());
  const after = store.snapshot()!;
  assert.equal(after.status, "ERROR");
  assert.equal(after.attempts, 4);
  assert.equal(after.nextAttemptAt, BACKOFF);
  assert.equal(after.lastError, "transient");
  assert.equal(isV6QueueClaimable(after), true);
});

test("3 ERROR/5/5 preserved exhausted, no automatic reopen", async () => {
  const store = createJobStore(baseJob({ status: "ERROR", attempts: 5, maxAttempts: 5, lastError: "exhausted" }));
  await write(store, store.snapshot());
  const after = store.snapshot()!;
  assert.equal(after.status, "ERROR");
  assert.equal(after.attempts, 5);
  assert.equal(isV6QueueClaimable(after), false);
});

test("4 repeated ERROR/5/5 consumer calls never PENDING/0", async () => {
  const store = createJobStore(baseJob({ status: "ERROR", attempts: 5, maxAttempts: 5 }));
  for (let i = 0; i < 10; i++) {
    await write(store, store.snapshot());
    const after = store.snapshot()!;
    assert.equal(after.status, "ERROR");
    assert.equal(after.attempts, 5);
  }
});

test("5 PENDING preserved", async () => {
  const store = createJobStore(baseJob({ status: "PENDING", attempts: 3, maxAttempts: 5 }));
  await write(store, store.snapshot());
  const after = store.snapshot()!;
  assert.equal(after.status, "PENDING");
  assert.equal(after.attempts, 3);
});

test("6 RUNNING preserved", async () => {
  const store = createJobStore(
    baseJob({ status: "RUNNING", attempts: 1, maxAttempts: 5, lockedAt: NOW, lockedBy: "worker-1", startedAt: NOW })
  );
  await write(store, store.snapshot());
  const after = store.snapshot()!;
  assert.equal(after.status, "RUNNING");
  assert.equal(after.attempts, 1);
  assert.equal(after.lockedBy, "worker-1");
  assert.equal(after.lockedAt, NOW);
});

test("7 stale SUCCESS race: loser count=0 must not clobber RUNNING", async () => {
  const store = createJobStore(baseJob({ status: "SUCCESS", attempts: 5, maxAttempts: 5 }));
  const observedA = store.snapshot();
  const observedB = store.snapshot();
  const a = await write(store, observedA);
  assert.equal(a, "queued_prisma");
  assert.equal(store.snapshot()?.status, "PENDING");
  store.replace(
    baseJob({
      status: "RUNNING",
      attempts: 1,
      maxAttempts: 5,
      lockedAt: NOW,
      lockedBy: "worker-1",
      startedAt: NOW,
    })
  );
  const b = await write(store, observedB);
  assert.equal(b, "queued_prisma");
  const final = store.snapshot()!;
  assert.equal(final.status, "RUNNING");
  assert.equal(final.attempts, 1);
  assert.equal(final.lockedBy, "worker-1");
  assert.equal(final.lockedAt, NOW);
  assert.equal(final.startedAt, NOW);
  assert.equal(store.p2002Count(), 0);
});

test("8 two concurrent SUCCESS consumers: one reopen wins, loser preserves PENDING, one row, no P2002", async () => {
  const store = createJobStore(baseJob({ status: "SUCCESS", attempts: 5, maxAttempts: 5 }));
  const observedA = store.snapshot();
  const observedB = store.snapshot();
  await Promise.all([write(store, observedA), write(store, observedB)]);
  const final = store.snapshot()!;
  assert.equal(final.status, "PENDING");
  assert.equal(final.attempts, 0);
  assert.equal(final.id, STUCK_ID);
  assert.equal(store.p2002Count(), 0);
});

test("9 two concurrent missing-row consumers: one PENDING row, loser does not reset, no unhandled P2002", async () => {
  const store = createJobStore(null);
  const results = await Promise.all([write(store, null), write(store, null)]);
  assert.deepEqual(results, ["queued_prisma", "queued_prisma"]);
  const final = store.snapshot()!;
  assert.equal(final.status, "PENDING");
  assert.equal(final.attempts, 0);
  assert.equal(final.id, STUCK_ID);
  assert.ok(store.p2002Count() <= 1);
});

test("10 deterministic V2 job identity unchanged", () => {
  const first = buildDashboardPeriodSnapshotJobId({
    formulaVersion: FORMULA,
    companyScope: "ALL",
    ...TARGET,
  });
  const second = buildDashboardPeriodSnapshotJobId({
    formulaVersion: FORMULA,
    companyScope: "ALL",
    dateFrom: "2026-08-10T00:00:00.000Z",
    dateTo: "2026-08-16T00:00:00.000Z",
  });
  assert.equal(first, second);
  assert.equal(first, STUCK_ID);
});

test("11 worker claim predicate unchanged", () => {
  assert.equal(isV6QueueClaimable({ status: "ERROR", attempts: 4, maxAttempts: 5 }), true);
  assert.equal(isV6QueueClaimable({ status: "ERROR", attempts: 5, maxAttempts: 5 }), false);
  assert.equal(isV6QueueClaimable({ status: "PENDING", attempts: 0, maxAttempts: 5 }), true);
});

test("12 historical PENDING/5/5 zombie remains unclaimable and is not auto-reset", async () => {
  const zombie = baseJob({ status: "PENDING", attempts: 5, maxAttempts: 5 });
  assert.equal(isUnclaimableZombiePending(zombie), true);
  assert.equal(isV6QueueClaimable(zombie), false);
  const store = createJobStore(zombie);
  await write(store, store.snapshot());
  const after = store.snapshot()!;
  assert.equal(after.status, "PENDING");
  assert.equal(after.attempts, 5);
  assert.equal(isV6QueueClaimable(after), false);
});

test("13 unknown status fail closed", async () => {
  const store = createJobStore(baseJob({ status: "CANCELLED", attempts: 2, maxAttempts: 5 }));
  await write(store, store.snapshot());
  const after = store.snapshot()!;
  assert.equal(after.status, "CANCELLED");
  assert.equal(after.attempts, 2);
});

test("14 repeated consumer after SUCCESS reopen does not reset PENDING attempts", async () => {
  const store = createJobStore(baseJob({ status: "SUCCESS", attempts: 5, maxAttempts: 5 }));
  await write(store, store.snapshot());
  store.replace({ ...store.snapshot()!, attempts: 1, status: "PENDING" });
  await write(store, store.snapshot());
  const after = store.snapshot()!;
  assert.equal(after.status, "PENDING");
  assert.equal(after.attempts, 1);
});

test("formula-aware V2 job id unchanged vs legacy V1 collision id", () => {
  const v2 = buildDashboardPeriodSnapshotJobId({
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
    companyScope: "ALL",
    dateFrom: "2026-09-01",
    dateTo: "2026-09-03",
  });
  const v1 = buildDashboardPeriodSnapshotJobId({
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V1,
    companyScope: "ALL",
    dateFrom: "2026-09-01",
    dateTo: "2026-09-03",
  });
  assert.match(v2, /^v6rmj_[0-9a-f]{64}$/);
  assert.notEqual(v2, v1);
  assert.equal(
    buildLegacyDashboardPeriodSnapshotJobId({
      companyScope: "ALL",
      dateFrom: "2026-09-01",
      dateTo: "2026-09-03",
    }),
    LEGACY_V1
  );
  assert.notEqual(v2, LEGACY_V1);
});
