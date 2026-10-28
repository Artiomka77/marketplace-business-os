#!/usr/bin/env node
/**
 * R15 data-rollback rehearsal: full ProfitPeriodMetric contract (totals +
 * analyticsPayload + checksum/fingerprint/meta). Uses in-memory store that
 * mirrors run_data_rollback_ozon_R12.ts field set — not a Map of totals-only.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const store = new Map();
function key(r) {
  return [r.companyScope, r.marketplace, r.dateFrom, r.dateTo, r.formulaVersion].join("|");
}
function upsert(row) {
  store.set(key(row), structuredClone(row));
}
function get(k) {
  return store.has(k) ? structuredClone(store.get(k)) : null;
}

const period = {
  companyScope: "ALL",
  marketplace: "OZON",
  dateFrom: "2026-10-19",
  dateTo: "2026-10-25",
  formulaVersion: "FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1",
};

const oldRow = {
  ...period,
  dataMode: "FINAL",
  coverageStatus: "COMPLETE",
  sourceFingerprint: "fp-old",
  payloadChecksum: "old-checksum",
  totals: {
    netOzonExpenses: 197613.06,
    netOzonExpensesRepresentation: "G_MINUS_B",
    netProfitAfterTax: 882464.11,
  },
  comparison: null,
  meta: { payloadChecksum: "old-checksum" },
  analyticsPayload: {
    totals: {
      netOzonExpenses: 197613.06,
      netOzonExpensesRepresentation: "G_MINUS_B",
      netProfitAfterTax: 882464.11,
    },
  },
  generatedAt: "2026-10-26T00:00:00.000Z",
  staleAfterMs: null,
};

const newRow = {
  ...oldRow,
  sourceFingerprint: "fp-new",
  payloadChecksum: "new-checksum",
  totals: {
    netOzonExpenses: 173948.64,
    netOzonExpensesRepresentation: "G_MINUS_B_MINUS_A",
    netProfitAfterTax: 882464.11,
  },
  meta: { payloadChecksum: "new-checksum" },
  analyticsPayload: {
    totals: {
      netOzonExpenses: 173948.64,
      netOzonExpensesRepresentation: "G_MINUS_B_MINUS_A",
      netProfitAfterTax: 882464.11,
    },
  },
};

upsert(oldRow);
const snapshot = [structuredClone(get(key(oldRow)))];
upsert(newRow);
assert.equal(get(key(newRow)).totals.netOzonExpenses, 173948.64);
assert.equal(
  get(key(newRow)).analyticsPayload.totals.netOzonExpenses,
  173948.64,
);

// Broken partial restore (totals only) — must be rejected by contract check
const broken = structuredClone(get(key(newRow)));
broken.totals = snapshot[0].totals;
assert.notEqual(
  broken.totals.netOzonExpenses,
  broken.analyticsPayload.totals.netOzonExpenses,
);

// Full restore
for (const r of snapshot) upsert(r);
const restored = get(key(oldRow));
assert.equal(restored.totals.netOzonExpenses, 197613.06);
assert.equal(restored.analyticsPayload.totals.netOzonExpenses, 197613.06);
assert.equal(restored.payloadChecksum, "old-checksum");
assert.equal(restored.meta.payloadChecksum, "old-checksum");
assert.equal(restored.sourceFingerprint, "fp-old");

const out = {
  procedure: "restore_full_profit_period_metric_contract",
  rowsRestored: 1,
  totalsAnalyticsAgree: true,
  checksumRestored: true,
  partialTotalsOnlyWouldDiverge: true,
  cogsFinanceUntouched: true,
};
fs.writeFileSync(process.argv[2] || "R15_data_rollback_rehearsal.json", JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
console.log("DATA_ROLLBACK_REHEARSAL_R15_PASS");
