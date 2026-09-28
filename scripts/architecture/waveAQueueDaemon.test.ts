import assert from "node:assert/strict";
import test from "node:test";

import { runV6QueueWorkerLoop } from "../dashboard/runV6PeriodReadModelWorker";

test("queue loop stays alive across idle polls and then claims a late job", async () => {
  let idleCount = 0;
  let stop = false;
  const jobs: Array<{
    id: string;
    companyScope: string;
    dateFrom: Date;
    dateTo: Date;
    attempts: number;
    maxAttempts: number;
  } | null> = [null, null, {
    id: "job-1",
    companyScope: "ALL",
    dateFrom: new Date("2026-08-17T00:00:00.000Z"),
    dateTo: new Date("2026-08-23T00:00:00.000Z"),
    attempts: 0,
    maxAttempts: 3,
  }];
  let claimIdx = 0;
  let processedIds: string[] = [];
  const sleeps: number[] = [];

  const result = await runV6QueueWorkerLoop({
    pollMs: 1000,
    maxJobs: 1,
    shouldStop: () => stop,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    claimNext: async () => {
      const next = jobs[claimIdx] ?? null;
      claimIdx += 1;
      return next;
    },
    onIdle: async () => {
      idleCount += 1;
    },
    processJob: async (job) => {
      processedIds.push(job.id);
      stop = true;
    },
  });

  assert.ok(idleCount >= 2, "expected at least two idle polls before job");
  assert.deepEqual(processedIds, ["job-1"]);
  assert.equal(result.processed, 1);
  assert.ok(sleeps.every((ms) => ms >= 1000));
});

test("queue loop does not busy-spin and honors graceful stop", async () => {
  let claims = 0;
  let stop = false;
  const sleeps: number[] = [];

  const result = await runV6QueueWorkerLoop({
    pollMs: 2500,
    maxJobs: null,
    shouldStop: () => stop,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (sleeps.length >= 3) stop = true;
    },
    claimNext: async () => {
      claims += 1;
      return null;
    },
    processJob: async () => {
      throw new Error("should not process");
    },
  });

  assert.equal(result.processed, 0);
  assert.ok(claims >= 3);
  assert.ok(sleeps.every((ms) => ms === 2500));
});

test("queue loop applies transient backoff", async () => {
  let attempts = 0;
  let stop = false;
  const sleeps: number[] = [];

  await runV6QueueWorkerLoop({
    pollMs: 1000,
    transientBackoffMs: 7000,
    maxJobs: null,
    shouldStop: () => stop,
    sleep: async (ms) => {
      sleeps.push(ms);
      stop = true;
    },
    claimNext: async () => {
      attempts += 1;
      throw new Error("transient db");
    },
    onTransientError: async () => {},
    processJob: async () => {},
  });

  assert.equal(attempts, 1);
  assert.deepEqual(sleeps, [7000]);
});
