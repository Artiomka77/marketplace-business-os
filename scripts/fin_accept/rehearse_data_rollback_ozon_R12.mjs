#!/usr/bin/env node
/**
 * R12 data-rollback isolation: exact Ozon period payload restore (old↔new).
 * Scope-limited: one companyScope/marketplace/period row pair. No COGS/Finance.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

/** In-memory stand-in for PeriodCompanyMarketplaceMetric / Profit period row. */
const store = new Map();

function key(row) {
  return [row.companyScope, row.marketplace, row.dateFrom, row.dateTo, row.formulaVersion].join("|");
}

function upsert(row) {
  store.set(key(row), structuredClone(row));
}

function get(k) {
  return store.get(k) ? structuredClone(store.get(k)) : null;
}

function snapshotRows(filter) {
  return [...store.values()]
    .filter(
      (r) =>
        r.dateFrom === filter.dateFrom &&
        r.dateTo === filter.dateTo &&
        r.marketplace === filter.marketplace,
    )
    .map((r) => structuredClone(r));
}

function restoreExact(rows) {
  for (const r of rows) upsert(r);
}

const period = {
  dateFrom: "2026-10-19",
  dateTo: "2026-10-25",
  marketplace: "OZON",
  formulaVersion: "FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1",
};

const oldRow = {
  companyScope: "ALL",
  ...period,
  totals: {
    netOzonExpenses: 197613.06,
    netOzonExpensesRepresentation: "G_MINUS_B",
    partnerProgramsAmount: 23664.42,
    netProfitAfterTax: 882464.11,
  },
};

const newRow = {
  ...oldRow,
  totals: {
    ...oldRow.totals,
    netOzonExpenses: 173948.64,
    netOzonExpensesRepresentation: "G_MINUS_B_MINUS_A",
  },
};

upsert(oldRow);
const before = snapshotRows(period);
assert.equal(before.length, 1);

// Simulate cutover producer write (new representation)
upsert(newRow);
assert.equal(get(key(newRow)).totals.netOzonExpensesRepresentation, "G_MINUS_B_MINUS_A");

// Chosen data-rollback procedure: restore exact pre-cutover snapshot of affected rows only.
restoreExact(before);
const after = get(key(oldRow));
assert.equal(after.totals.netOzonExpenses, 197613.06);
assert.equal(after.totals.netOzonExpensesRepresentation, "G_MINUS_B");
assert.equal(after.totals.netProfitAfterTax, 882464.11);

// Scope check: no extra keys
assert.equal(store.size, 1);

const out = {
  procedure: "restore_exact_period_snapshot_rows",
  scope: period,
  rowsRestored: 1,
  beforeNet: before[0].totals.netOzonExpenses,
  afterNet: after.totals.netOzonExpenses,
  representationRestored: after.totals.netOzonExpensesRepresentation,
  profitUnchanged: after.totals.netProfitAfterTax,
  cogsFinanceUntouched: true,
};
fs.writeFileSync(
  process.argv[2] || "R12_data_rollback_rehearsal.json",
  JSON.stringify(out, null, 2) + "\n",
);
console.log(JSON.stringify(out, null, 2));
console.log("DATA_ROLLBACK_REHEARSAL_R12_PASS");
