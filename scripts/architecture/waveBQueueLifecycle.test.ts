import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyConsumerRebuild,
  decideV6JobRebuild,
  isV6QueueClaimable,
} from "@/lib/profitReadModel/queueLifecycle";

describe("Wave B queue lifecycle binds V2 semantics", () => {
  it("PENDING/RUNNING/ERROR keep_existing; SUCCESS reopen; create when missing", () => {
    assert.equal(decideV6JobRebuild(null).action, "create");
    assert.equal(
      decideV6JobRebuild({ status: "PENDING", attempts: 0, maxAttempts: 5 }).action,
      "keep_existing"
    );
    assert.equal(
      decideV6JobRebuild({ status: "RUNNING", attempts: 1, maxAttempts: 5 }).action,
      "keep_existing"
    );
    assert.equal(
      decideV6JobRebuild({ status: "ERROR", attempts: 5, maxAttempts: 5 }).action,
      "keep_existing"
    );
    assert.equal(
      decideV6JobRebuild({ status: "ERROR", attempts: 2, maxAttempts: 5 }).action,
      "keep_existing"
    );
    assert.equal(
      decideV6JobRebuild({ status: "SUCCESS", attempts: 1, maxAttempts: 5 }).action,
      "reopen_success"
    );
  });

  it("claimable respects ERROR below maxAttempts and nextAttemptAt semantics via helper", () => {
    assert.equal(
      isV6QueueClaimable({ status: "PENDING", attempts: 0, maxAttempts: 5 }),
      true
    );
    assert.equal(
      isV6QueueClaimable({ status: "ERROR", attempts: 2, maxAttempts: 5 }),
      true
    );
    assert.equal(
      isV6QueueClaimable({ status: "ERROR", attempts: 5, maxAttempts: 5 }),
      false
    );
    assert.equal(
      isV6QueueClaimable({ status: "FAILED", attempts: 1, maxAttempts: 5 }),
      false
    );
  });

  it("applyConsumerRebuild never resets exhausted ERROR", () => {
    const now = new Date();
    const exhausted = applyConsumerRebuild(
      { status: "ERROR", attempts: 5, maxAttempts: 5 },
      now,
      40
    );
    assert.equal(exhausted.action, "keep_existing");
    assert.equal(exhausted.update, null);

    const success = applyConsumerRebuild(
      { status: "SUCCESS", attempts: 1, maxAttempts: 5 },
      now,
      40
    );
    assert.equal(success.action, "reopen_success");
    assert.equal(success.update?.status, "PENDING");
    assert.equal(success.update?.attempts, 0);
  });
});
