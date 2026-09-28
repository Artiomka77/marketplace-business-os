import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCompletenessJobRecord,
  buildCompletenessJobRunFinishData,
  buildCompletenessJobRunStartData,
  isStaleCompletenessJobRun,
  planCompletenessSelfHeal,
  snapshotFromMissingReasons,
} from "../../lib/platform/completeness/watchdog";

describe("DAILY_COMPLETENESS JobRun lifecycle helpers", () => {
  it("start payload sets RUNNING with startedAt and attempts >= 1", () => {
    const snapshot = snapshotFromMissingReasons({
      missingReasons: [{ marketplace: "OZON", dataType: "SALES" }],
      date: "2026-08-24",
    });
    const plan = planCompletenessSelfHeal(snapshot);
    const job = buildCompletenessJobRecord({ date: "2026-08-24", snapshot, plan });
    const now = new Date("2026-08-25T08:15:13.000Z");
    const start = buildCompletenessJobRunStartData({ job, now, attempts: 1 });

    assert.equal(start.status, "RUNNING");
    assert.equal(start.attempts, 1);
    assert.equal(start.startedAt.toISOString(), now.toISOString());
    assert.equal(start.finishedAt, null);
    assert.equal(start.idempotencyKey, job.idempotencyKey);
    assert.equal(start.lockKey, job.lockKey);
  });

  it("finish payload sets finishedAt and terminal status", () => {
    const ok = buildCompletenessJobRunFinishData({
      ok: true,
      now: new Date("2026-08-25T08:16:00.000Z"),
    });
    assert.equal(ok.status, "SUCCEEDED");
    assert.ok(ok.finishedAt);
    assert.equal(ok.errorMessage, null);

    const fail = buildCompletenessJobRunFinishData({
      ok: false,
      now: new Date("2026-08-25T08:16:00.000Z"),
      errorMessage: "still incomplete",
    });
    assert.equal(fail.status, "FAILED");
    assert.equal(fail.errorCode, "COMPLETENESS_INCOMPLETE");
    assert.equal(fail.errorMessage, "still incomplete");
  });

  it("RUNNING with null startedAt is stale/reclaimable", () => {
    assert.equal(
      isStaleCompletenessJobRun({
        status: "RUNNING",
        attempts: 0,
        startedAt: null,
        finishedAt: null,
      }),
      true,
    );
  });

  it("fresh RUNNING with recent startedAt is not reclaimable", () => {
    const now = new Date("2026-08-25T08:20:00.000Z");
    assert.equal(
      isStaleCompletenessJobRun(
        {
          status: "RUNNING",
          attempts: 1,
          startedAt: new Date("2026-08-25T08:15:00.000Z"),
          finishedAt: null,
        },
        now,
        30 * 60 * 1000,
      ),
      false,
    );
  });

  it("old RUNNING is reclaimable after stale window", () => {
    const now = new Date("2026-08-25T09:00:00.000Z");
    assert.equal(
      isStaleCompletenessJobRun(
        {
          status: "RUNNING",
          attempts: 1,
          startedAt: new Date("2026-08-25T08:15:00.000Z"),
          finishedAt: null,
        },
        now,
        30 * 60 * 1000,
      ),
      true,
    );
  });

  it("terminal statuses are not treated as stale RUNNING", () => {
    assert.equal(
      isStaleCompletenessJobRun({
        status: "SUCCEEDED",
        attempts: 1,
        startedAt: new Date(),
        finishedAt: new Date(),
      }),
      false,
    );
    assert.equal(
      isStaleCompletenessJobRun({
        status: "FAILED",
        attempts: 2,
        startedAt: new Date(),
        finishedAt: new Date(),
      }),
      false,
    );
  });
});
