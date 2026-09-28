import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyOzonLegacyFinanceError,
  isExplicitByDayEligible,
  legacyFinanceAllowsByDayContinue,
} from "../../lib/ozon/legacyFinanceStep";
import { classifyOzonByDayRouteOutcome } from "../../lib/ozon/ozonAccrualSyncWindow";

const obsoleteMsg =
  'Ozon Finance API: 400 {"code":9,"message":"obsolete method cannot be used"}';

function day(iso: string) {
  return new Date(`${iso}T00:00:00.000Z`);
}

test("A: explicit 1-day + obsolete code9 continues to by-day", () => {
  const obsolete = classifyOzonLegacyFinanceError(new Error(obsoleteMsg));
  assert.equal(obsolete.status, "OBSOLETE_METHOD");
  const eligible = isExplicitByDayEligible({
    dateFromOption: day("2026-09-08"),
    dateToOption: day("2026-09-08"),
    dateFrom: day("2026-09-08"),
    dateTo: day("2026-09-08"),
  });
  assert.equal(eligible, true);
  assert.equal(legacyFinanceAllowsByDayContinue(obsolete, eligible), true);
});

test("B: explicit 3-day + obsolete continues to by-day", () => {
  const obsolete = classifyOzonLegacyFinanceError(new Error(obsoleteMsg));
  const eligible = isExplicitByDayEligible({
    dateFromOption: day("2026-09-06"),
    dateToOption: day("2026-09-08"),
    dateFrom: day("2026-09-06"),
    dateTo: day("2026-09-08"),
  });
  assert.equal(eligible, true);
  assert.equal(legacyFinanceAllowsByDayContinue(obsolete, eligible), true);
});

test("C: explicit >7-day + obsolete MUST fail / not silently skip", () => {
  const obsolete = classifyOzonLegacyFinanceError(new Error(obsoleteMsg));
  const eligible = isExplicitByDayEligible({
    dateFromOption: day("2026-09-01"),
    dateToOption: day("2026-09-09"),
    dateFrom: day("2026-09-01"),
    dateTo: day("2026-09-09"),
  });
  assert.equal(eligible, false);
  assert.equal(legacyFinanceAllowsByDayContinue(obsolete, eligible), false);
});

test("D: no explicit dates + obsolete MUST fail (syncOzonAll path)", () => {
  const obsolete = classifyOzonLegacyFinanceError(new Error(obsoleteMsg));
  const eligible = isExplicitByDayEligible({
    dateFromOption: null,
    dateToOption: null,
    dateFrom: day("2026-08-26"),
    dateTo: day("2026-09-09"),
  });
  assert.equal(eligible, false);
  assert.equal(legacyFinanceAllowsByDayContinue(obsolete, eligible), false);
});

test("E: unknown Finance error + explicit date fail closed", () => {
  const other = classifyOzonLegacyFinanceError(
    new Error('Ozon Finance API: 400 {"code":3,"message":"invalid argument"}'),
  );
  assert.equal(other.status, "FAILED");
  const eligible = isExplicitByDayEligible({
    dateFromOption: day("2026-09-08"),
    dateToOption: day("2026-09-08"),
    dateFrom: day("2026-09-08"),
    dateTo: day("2026-09-08"),
  });
  assert.equal(eligible, true);
  assert.equal(legacyFinanceAllowsByDayContinue(other, eligible), false);

  const rate = classifyOzonLegacyFinanceError(
    new Error("Ozon Finance API: 429 rate limit"),
  );
  assert.equal(rate.status, "FAILED");
  assert.equal(rate.retryable, true);
  assert.equal(legacyFinanceAllowsByDayContinue(rate, eligible), false);
});

test("F: code9 + by-day mapper/persist failure remains FAILED readiness", () => {
  const obsolete = classifyOzonLegacyFinanceError(new Error(obsoleteMsg));
  const eligible = isExplicitByDayEligible({
    dateFromOption: day("2026-09-08"),
    dateToOption: day("2026-09-08"),
    dateFrom: day("2026-09-08"),
    dateTo: day("2026-09-08"),
  });
  assert.equal(legacyFinanceAllowsByDayContinue(obsolete, eligible), true);
  const failed = classifyOzonByDayRouteOutcome({
    executionOk: false,
    ingestStatus: "FAILED",
    coverageComplete: false,
  });
  assert.equal(failed.sourceReadiness, "FAILED");
  assert.equal(failed.ok, false);
});

test("source readiness never coerces Boolean(ingestStatus)", () => {
  const failed = classifyOzonByDayRouteOutcome({
    executionOk: true,
    ingestStatus: "FAILED",
    coverageComplete: false,
  });
  assert.equal(failed.sourceReadiness, "FAILED");
  assert.equal(failed.ok, false);

  const pendingString = classifyOzonByDayRouteOutcome({
    executionOk: true,
    ingestStatus: "PENDING",
    coverageComplete: null,
  });
  assert.equal(pendingString.sourceReadiness, "PENDING");
  assert.equal(pendingString.ok, true);

  const ready = classifyOzonByDayRouteOutcome({
    executionOk: true,
    ingestStatus: "FINAL",
    coverageComplete: true,
    windowPartial: false,
    pendingDays: [],
  });
  assert.equal(ready.sourceReadiness, "READY");
  assert.equal(ready.ok, true);

  const preliminary = classifyOzonByDayRouteOutcome({
    executionOk: true,
    ingestStatus: "PRELIMINARY",
    coverageComplete: false,
  });
  assert.equal(preliminary.sourceReadiness, "PRELIMINARY");
  assert.equal(preliminary.ok, true);

  const thrown = classifyOzonByDayRouteOutcome({
    executionOk: false,
    ingestStatus: "FINAL",
    coverageComplete: true,
  });
  assert.equal(thrown.sourceReadiness, "FAILED");
  assert.equal(thrown.ok, false);

  // Non-empty garbage must NOT become READY via Boolean(string)
  const garbage = classifyOzonByDayRouteOutcome({
    executionOk: true,
    ingestStatus: "SOMETHING",
    coverageComplete: true,
  });
  assert.notEqual(garbage.sourceReadiness, "READY");
});
