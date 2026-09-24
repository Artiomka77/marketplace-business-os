import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateDashboardIncompleteWeek } from "../../lib/dashboard/incompleteWeekGuard";
import {
  applyOzonCanonicalIngestFinality,
  aggregatedSurfacesAgree,
  resolveCanonicalPeriodFinality,
  resolveOzonPeriodFinality,
  resolveWbPeriodFinality,
} from "../../lib/finance/canonicalPeriodFinality";
import {
  buildCanonicalOzonDayStatuses,
  buildRawOzonDayStatuses,
  listOzonDayStatusRecords,
  upsertOzonDayStatusRecords,
} from "../../lib/ozon/accrualDayStatus";
import { mapOzonAccrualByDay } from "../../lib/ozon/accrualByDay";
import { createMemoryOzonAccrualStore, ingestOzonAccrualByDay } from "../../lib/ozon/syncOzonAccrualByDay";
import { validateOzonAccrualIngest } from "../../lib/ozon/accrualIngestValidation";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function type76Accrual(id: number, date: string, accrued: number) {
  return {
    accrual_id: id,
    date,
    total_amount: accrued,
    non_item_fee: { type_id: 76, accrued },
  };
}

function unknownAccrual(id: number, date: string, accrued: number) {
  return {
    accrual_id: id,
    date,
    total_amount: accrued,
    non_item_fee: { type_id: 9999, accrued },
  };
}

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

function ingestArgs(store: ReturnType<typeof createMemoryOzonAccrualStore>, fetchRange: () => Promise<{
  requestedDates: string[];
  dayEnvelopes: ReturnType<typeof completeEnvelope>[];
  pagesByDay: Record<string, number>;
  accruals: unknown[];
}>) {
  return {
    companyId: "cmp",
    companyName: "ИП Петров",
    clientId: "cid",
    apiKey: "key",
    dateFrom: new Date("2026-08-23T00:00:00.000Z"),
    dateTo: new Date("2026-08-23T00:00:00.000Z"),
    store,
    fetchRange,
  };
}

test("DailyReport has no hardcoded Ozon quarantineCount: 0", () => {
  const source = readFileSync(path.join(root, "lib/telegram/dailyReport.ts"), "utf8");
  assert.equal((source.match(/quarantineCount:\s*0/g) ?? []).length, 0);
});

test("A unknown type with known summaries stays PRELIMINARY on all owner surfaces", () => {
  const days = buildCanonicalOzonDayStatuses({
    companyName: "ИП Петров",
    dates: ["2026-08-23"],
    importSessionId: "raw-1",
    dataMode: "PRELIMINARY",
    coverageComplete: false,
    quarantineCount: 1,
  });
  const ozon = resolveOzonPeriodFinality({
    companyName: "ИП Петров",
    dateFrom: "2026-08-23",
    dateTo: "2026-08-23",
    days,
  });
  assert.equal(ozon.quarantineCount, 1);
  assert.equal(ozon.dataMode, "PRELIMINARY");
  const profit = applyOzonCanonicalIngestFinality(
    {
      netProfitStatus: "FINAL",
      taxRevenueCoverageComplete: true,
      discountPointsCoverageComplete: true,
    },
    ozon,
  );
  const surfaces = resolveCanonicalPeriodFinality({
    wbSelected: true,
    ozonSelected: true,
    wb: resolveWbPeriodFinality({
      dataMode: "FINAL",
      sourceOwnershipMode: "EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS",
      sourceOwnershipFinal: true,
    }),
    ozon,
  });
  assert.equal(profit.netProfitStatus, "PRELIMINARY");
  assert.equal(surfaces.telegram, "PRELIMINARY");
  assert.equal(surfaces.dashboard, "PRELIMINARY");
  assert.equal(surfaces.insights, "PRELIMINARY");
  assert.equal(surfaces.profitOzon, "PRELIMINARY");
  assert.equal(aggregatedSurfacesAgree(surfaces), true);
  const dashboard = evaluateDashboardIncompleteWeek({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    dataReadiness: { isFinal: true, status: "complete", issues: [] },
    canonicalDataMode: surfaces.dashboard,
    wbExactCoverComplete: true,
    ozonCoverageComplete: false,
    ozonQuarantineCount: 1,
    now: new Date("2026-08-25T12:00:00Z"),
  });
  assert.equal(dashboard.mayPresentAsFinal, false);
});

test("B RAW_PERSISTED never becomes FINAL on any surface", async () => {
  const store = createMemoryOzonAccrualStore({
    beforePersistCanonical: () => {
      throw new Error("canonical overlay failed");
    },
  });
  const accruals = [type76Accrual(1, "2026-08-23", -1911.55)];
  await assert.rejects(
    () =>
      ingestOzonAccrualByDay(
        ingestArgs(store, async () => ({
          requestedDates: ["2026-08-23"],
          dayEnvelopes: [completeEnvelope("2026-08-23", 1)],
          pagesByDay: { "2026-08-23": 1 },
          accruals,
        })),
      ),
    /canonical overlay failed/,
  );
  const days = listOzonDayStatusRecords({
    store: store.dayStatuses,
    companyName: "ИП Петров",
    dateFrom: "2026-08-23",
    dateTo: "2026-08-23",
  });
  assert.equal(days.length, 1);
  assert.equal(days[0]?.phase, "RAW");
  assert.equal(days[0]?.dataMode, "PRELIMINARY");
  const ozon = resolveOzonPeriodFinality({
    companyName: "ИП Петров",
    dateFrom: "2026-08-23",
    dateTo: "2026-08-23",
    days,
  });
  const surfaces = resolveCanonicalPeriodFinality({
    wbSelected: true,
    ozonSelected: true,
    wb: resolveWbPeriodFinality({
      dataMode: "FINAL",
      sourceOwnershipMode: "EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS",
      sourceOwnershipFinal: true,
    }),
    ozon,
  });
  assert.equal(surfaces.combined.dataMode, "PRELIMINARY");
  assert.equal(surfaces.telegram, "PRELIMINARY");
  assert.equal(surfaces.dashboard, "PRELIMINARY");
  assert.equal(surfaces.insights, "PRELIMINARY");
  assert.equal(surfaces.profitOzon, "PRELIMINARY");
});

test("C WB daily complete without exact weekly owner stays Dashboard PRELIMINARY", () => {
  const wb = resolveWbPeriodFinality({
    dataMode: "PRELIMINARY",
    sourceOwnershipMode: "PRELIMINARY_NO_SOURCE",
    sourceOwnershipFinal: false,
    sourceOwnershipReasons: ["FINANCE_INTERVAL_COVER_INCOMPLETE"],
  });
  const ozon = resolveOzonPeriodFinality({
    companyName: "ИП Петров",
    dateFrom: "2026-08-23",
    dateTo: "2026-08-23",
    days: buildCanonicalOzonDayStatuses({
      companyName: "ИП Петров",
      dates: ["2026-08-23"],
      importSessionId: "ozon-final",
      dataMode: "FINAL",
      coverageComplete: true,
      quarantineCount: 0,
    }),
  });
  const surfaces = resolveCanonicalPeriodFinality({
    wbSelected: true,
    ozonSelected: true,
    wb,
    ozon,
  });
  assert.equal(surfaces.dashboard, "PRELIMINARY");
  const presentation = evaluateDashboardIncompleteWeek({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    dataReadiness: { isFinal: true, status: "complete", issues: [] },
    canonicalDataMode: surfaces.dashboard,
    wbExactCoverComplete: false,
    ozonCoverageComplete: true,
    ozonQuarantineCount: 0,
    now: new Date("2026-08-25T12:00:00Z"),
  });
  assert.equal(presentation.mayPresentAsFinal, false);
});

test("D mapper replay promotes PRELIMINARY to FINAL on all surfaces", async () => {
  const store = createMemoryOzonAccrualStore();
  const date = "2026-08-23";
  const rawAccruals = [unknownAccrual(1, date, -50), type76Accrual(2, date, -1911.55)];
  await assert.rejects(
    () =>
      ingestOzonAccrualByDay(
        ingestArgs(store, async () => ({
          requestedDates: [date],
          dayEnvelopes: [completeEnvelope(date, 2)],
          pagesByDay: { [date]: 1 },
          accruals: rawAccruals,
        })),
      ),
    /unknown accrual types/,
  );
  assert.equal(store.canonicalWrites?.length ?? 0, 0);
  const before = resolveOzonPeriodFinality({
    companyName: "ИП Петров",
    dateFrom: date,
    dateTo: date,
    days: listOzonDayStatusRecords({
      store: store.dayStatuses,
      companyName: "ИП Петров",
      dateFrom: date,
      dateTo: date,
    }),
  });
  assert.equal(before.dataMode, "PRELIMINARY");
  const rawId = [...store.rawById.keys()][0];
  await ingestOzonAccrualByDay({
    ...ingestArgs(store, async () => {
      throw new Error("replay must not refetch");
    }),
    replayFromRawId: rawId,
    mapAccruals: (params) =>
      mapOzonAccrualByDay({
        ...params,
        accruals: (params.accruals ?? []).map((row) => {
          const record = row as { non_item_fee?: { type_id?: number } };
          if (record.non_item_fee?.type_id === 9999) {
            return { ...record, non_item_fee: { ...record.non_item_fee, type_id: 18 } };
          }
          return row;
        }),
      }),
  });
  const afterDays = listOzonDayStatusRecords({
    store: store.dayStatuses,
    companyName: "ИП Петров",
    dateFrom: date,
    dateTo: date,
  });
  const after = resolveOzonPeriodFinality({
    companyName: "ИП Петров",
    dateFrom: date,
    dateTo: date,
    days: afterDays,
  });
  assert.equal(afterDays[0]?.phase, "CANONICAL");
  const plan = validateOzonAccrualIngest({
    mapped: mapOzonAccrualByDay({
      accruals: rawAccruals.map((row) =>
        (row as { non_item_fee?: { type_id?: number } }).non_item_fee?.type_id === 9999
          ? { ...row, non_item_fee: { type_id: 18, accrued: -50 } }
          : row,
      ),
      requestedDates: [date],
      dayEnvelopes: [completeEnvelope(date, 2)],
    }),
    dateFrom: new Date(`${date}T00:00:00.000Z`),
    dateTo: new Date(`${date}T00:00:00.000Z`),
    requestedDates: [date],
  });
  assert.equal(plan.status, "FINAL");
  assert.equal(after.dataMode, "FINAL");
  const surfaces = resolveCanonicalPeriodFinality({
    wbSelected: true,
    ozonSelected: true,
    wb: resolveWbPeriodFinality({
      dataMode: "FINAL",
      sourceOwnershipMode: "EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS",
      sourceOwnershipFinal: true,
    }),
    ozon: after,
  });
  assert.equal(surfaces.combined.dataMode, "FINAL");
  assert.equal(surfaces.telegram, "FINAL");
  assert.equal(surfaces.dashboard, "FINAL");
  assert.equal(surfaces.insights, "FINAL");
  assert.equal(surfaces.profitOzon, "FINAL");
  assert.equal(aggregatedSurfacesAgree(surfaces), true);
});

test("cross-surface parity helper agrees for FINAL and PRELIMINARY", () => {
  const finalDays = buildCanonicalOzonDayStatuses({
    companyName: "ИП Петров",
    dates: ["2026-08-23"],
    importSessionId: "s",
    dataMode: "FINAL",
    coverageComplete: true,
    quarantineCount: 0,
  });
  const finality = resolveCanonicalPeriodFinality({
    wbSelected: true,
    ozonSelected: true,
    wb: resolveWbPeriodFinality({
      dataMode: "FINAL",
      sourceOwnershipMode: "EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS",
      sourceOwnershipFinal: true,
    }),
    ozon: resolveOzonPeriodFinality({
      companyName: "ИП Петров",
      dateFrom: "2026-08-23",
      dateTo: "2026-08-23",
      days: finalDays,
    }),
  });
  assert.equal(aggregatedSurfacesAgree(finality), true);
  upsertOzonDayStatusRecords(new Map(), finalDays);
});

test("Telegram combined tests: WB FINAL + Ozon RAW/unknown/summary PRELIMINARY", () => {
  const wb = resolveWbPeriodFinality({
    dataMode: "FINAL",
    sourceOwnershipMode: "EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS",
    sourceOwnershipFinal: true,
  });
  const unknown = resolveCanonicalPeriodFinality({
    wbSelected: true,
    ozonSelected: true,
    wb,
    ozon: resolveOzonPeriodFinality({
      companyName: "ИП Петров",
      dateFrom: "2026-08-23",
      dateTo: "2026-08-23",
      days: buildCanonicalOzonDayStatuses({
        companyName: "ИП Петров",
        dates: ["2026-08-23"],
        importSessionId: "q",
        dataMode: "PRELIMINARY",
        coverageComplete: true,
        quarantineCount: 1,
      }),
    }),
  });
  const raw = resolveCanonicalPeriodFinality({
    wbSelected: true,
    ozonSelected: true,
    wb,
    ozon: resolveOzonPeriodFinality({
      companyName: "ИП Петров",
      dateFrom: "2026-08-23",
      dateTo: "2026-08-23",
      days: buildRawOzonDayStatuses({
        companyName: "ИП Петров",
        dates: ["2026-08-23"],
        importSessionId: "raw",
      }),
    }),
  });
  const wbPrelim = resolveCanonicalPeriodFinality({
    wbSelected: true,
    ozonSelected: true,
    wb: resolveWbPeriodFinality({
      dataMode: "PRELIMINARY",
      sourceOwnershipFinal: false,
    }),
    ozon: resolveOzonPeriodFinality({
      companyName: "ИП Петров",
      dateFrom: "2026-08-23",
      dateTo: "2026-08-23",
      days: buildCanonicalOzonDayStatuses({
        companyName: "ИП Петров",
        dates: ["2026-08-23"],
        importSessionId: "oz",
        dataMode: "FINAL",
        coverageComplete: true,
        quarantineCount: 0,
      }),
    }),
  });
  assert.equal(unknown.telegram, "PRELIMINARY");
  assert.equal(raw.telegram, "PRELIMINARY");
  assert.equal(wbPrelim.telegram, "PRELIMINARY");
  assert.equal(wbPrelim.profitOzon, "FINAL");
});
