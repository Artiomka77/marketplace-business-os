/**
 * FIN_MATCH: finance cover for 19–23 must not be wiped by missing 24–25 finance.
 */
import assert from "node:assert/strict";
import { planWbSourceOwnership } from "./sourceOwnership.ts";

const petrovFinance = [
  "2026-10-19",
  "2026-10-20",
  "2026-10-21",
  "2026-10-22",
  "2026-10-23",
].map((day) => ({
  companyName: "ИП Петров",
  reportNumber: `370242${day.replaceAll("-", "")}`,
  dateFrom: new Date(`${day}T00:00:00.000Z`),
  dateTo: new Date(`${day}T00:00:00.000Z`),
}));

const sessions = petrovFinance.map((row, i) => ({
  id: `sess-${i}`,
  fileName: `WB API Daily Detailed ИП Петров report ${row.reportNumber} ${String(row.dateFrom).slice(0, 10)} - ${String(row.dateTo).slice(0, 10)}`,
  companyName: "ИП Петров",
  reportType: "WB_SALES" as const,
  status: "SUCCESS",
  createdAt: new Date(`2026-10-${20 + i}T12:00:00.000Z`),
}));

const plan = planWbSourceOwnership({
  dateFrom: "2026-10-19",
  dateTo: "2026-10-25",
  companyNames: ["ИП Петров"],
  financeRows: petrovFinance,
  sessions,
});

const finalIntervals = plan.intervals.filter((iv) => iv.isFinanciallyFinal);
const prelimIntervals = plan.intervals.filter((iv) => !iv.isFinanciallyFinal);

assert.ok(finalIntervals.length >= 1, "expected finance-covered intervals");
assert.ok(
  finalIntervals.every((iv) => iv.dateTo <= "2026-10-23"),
  "finance final intervals must end by 23",
);
assert.ok(prelimIntervals.length >= 1, "expected trailing preliminary");
assert.equal(prelimIntervals[0].dateFrom, "2026-10-24");
assert.equal(prelimIntervals[0].dateTo, "2026-10-25");
assert.ok(
  prelimIntervals[0].preliminaryReasons.includes(
    "FINANCE_PREFIX_ONLY_TRAILING_PRELIMINARY",
  ),
);

console.log("sourceOwnership.prefixSplit.test.ts OK");
