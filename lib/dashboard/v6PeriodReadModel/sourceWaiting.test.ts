import assert from "node:assert/strict";
import test from "node:test";

import {
  formatWaitingSourceReason,
  isBuildPendingReason,
  isSourceWaitingD6Reason,
  waitingSourceOwnerNote,
} from "./sourceWaiting.ts";

test("D6 unsafe ownership maps to WAITING_SOURCE weekly close", () => {
  const reason = formatWaitingSourceReason({
    d6Reason: "D6_UNSAFE_WB_OWNERSHIP_MODE",
    modes: ["PRELIMINARY_NO_SOURCE", "EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS"],
    preliminaryReasons: ["SOURCE_INCOMPLETE", "FINANCE_INTERVAL_COVER_INCOMPLETE"],
  });
  assert.equal(reason, "WAITING_SOURCE:WAITING_FOR_WB_WEEKLY_CLOSE");
  assert.equal(isSourceWaitingD6Reason(reason), true);
  assert.equal(isBuildPendingReason(reason), false);
});

test("missing readmodel build stays BUILD_PENDING classifier helper", () => {
  assert.equal(isBuildPendingReason("BUILD_PENDING:V6_PERIOD_READMODEL_MISSING"), true);
  assert.equal(isSourceWaitingD6Reason("BUILD_PENDING:V6_PERIOD_READMODEL_MISSING"), false);
});

test("owner note uses period bounds", () => {
  const note = waitingSourceOwnerNote({
    reason: "WAITING_SOURCE:WAITING_FOR_WB_WEEKLY_CLOSE",
    dateFrom: "2026-10-01",
    dateTo: "2026-10-11",
  });
  assert.match(String(note), /01\.10/);
  assert.match(String(note), /11\.10/);
});
