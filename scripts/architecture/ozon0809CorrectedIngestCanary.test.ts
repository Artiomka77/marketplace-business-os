import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyOzonLegacyFinanceError,
  legacyFinanceAllowsByDayContinue,
} from "../../lib/ozon/legacyFinanceStep";
import {
  createMemoryOzonAccrualStore,
  ingestOzonAccrualByDay,
} from "../../lib/ozon/syncOzonAccrualByDay";

function completeEnvelope(date: string, rawAccrualCount: number) {
  return {
    date,
    httpOk: true,
    pages: 1,
    paginationComplete: true,
    rawAccrualCount,
    explicitZeroDayEvidence: false,
  };
}

function type76Accrual(id: number, date: string, accrued: number) {
  return {
    accrual_id: id,
    date,
    total_amount: accrued,
    non_item_fee: { type_id: 76, accrued },
  };
}

test("corrected ingest canary: obsolete Finance injected but by-day memory persist survives", async () => {
  const obsolete = classifyOzonLegacyFinanceError(
    new Error(
      'Ozon Finance API: 400 {"code":9,"message":"obsolete method cannot be used"}',
    ),
  );
  assert.equal(obsolete.status, "OBSOLETE_METHOD");
  assert.equal(legacyFinanceAllowsByDayContinue(obsolete, true), true);
  assert.equal(legacyFinanceAllowsByDayContinue(obsolete, false), false);

  const date = "2026-09-08";
  const accruals = [type76Accrual(1001, date, -100)];
  const store = createMemoryOzonAccrualStore();
  const result = await ingestOzonAccrualByDay({
    companyId: "co_test",
    companyName: "ИП Петров",
    clientId: "x",
    apiKey: "y",
    dateFrom: new Date(`${date}T00:00:00.000Z`),
    dateTo: new Date(`${date}T00:00:00.000Z`),
    store,
    fetchRange: async () => ({
      accruals,
      requestedDates: [date],
      dayEnvelopes: [completeEnvelope(date, accruals.length)],
      pagesByDay: { [date]: 1 },
    }),
  });

  assert.equal(result.canonicalPersisted, true);
  assert.ok(["FINAL", "PRELIMINARY"].includes(String(result.ingestStatus)));
  assert.equal(result.diagnostics.unknownMeaningfulTypeIds.length, 0);
  assert.equal(result.diagnostics.unresolvedType71Groups.length, 0);
  assert.ok([...store.dayStatuses.keys()].some((k) => k.includes(date)));
});

test("completeness recovery canary: exact date attempt + idempotent second ingest", async () => {
  const date = "2026-09-08";
  const accruals = [type76Accrual(2002, date, -50)];
  const store = createMemoryOzonAccrualStore();
  const fetchRange = async () => ({
    accruals,
    requestedDates: [date],
    dayEnvelopes: [completeEnvelope(date, accruals.length)],
    pagesByDay: { [date]: 1 },
  });

  const first = await ingestOzonAccrualByDay({
    companyId: "co_leb",
    companyName: "ИП Лебедева",
    dateFrom: new Date(`${date}T00:00:00.000Z`),
    dateTo: new Date(`${date}T00:00:00.000Z`),
    store,
    fetchRange,
  });
  const second = await ingestOzonAccrualByDay({
    companyId: "co_leb",
    companyName: "ИП Лебедева",
    dateFrom: new Date(`${date}T00:00:00.000Z`),
    dateTo: new Date(`${date}T00:00:00.000Z`),
    store,
    fetchRange,
  });

  assert.equal(first.canonicalPersisted, true);
  assert.equal(second.canonicalPersisted, true);
  assert.equal(store.canonicalCallCount, 2);
  assert.ok(store.dayStatuses.size >= 1);
});
