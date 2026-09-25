import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

function read(rel: string) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function hasPreliminaryTax(totals: Record<string, unknown>) {
  return (
    totals.taxesUnavailable === true || totals.taxesEstimated === true
  );
}

function hasPreliminaryProfitOrCogs(totals: Record<string, unknown>) {
  return (
    totals.costCoverageIncomplete === true ||
    totals.dataMode === "PRELIMINARY" ||
    totals.netProfitStatus === "PRELIMINARY"
  );
}

test("plan-fact tax finality ignores COGS/dataMode/netProfitStatus", () => {
  const src = read("app/finance/plan-fact/page.tsx");
  assert.match(src, /function hasPreliminaryTax\(/);
  assert.match(src, /function hasPreliminaryProfitOrCogs\(/);
  assert.doesNotMatch(src, /hasPreliminaryTaxOrCoverage/);
  assert.match(src, /taxesUnavailable === true/);
  assert.match(src, /taxesEstimated === true/);

  // Tax-only helper must not key off COGS/generic finality.
  const taxFn = src.slice(
    src.indexOf("function hasPreliminaryTax("),
    src.indexOf("function hasPreliminaryProfitOrCogs("),
  );
  assert.doesNotMatch(taxFn, /costCoverageIncomplete/);
  assert.doesNotMatch(taxFn, /dataMode/);
  assert.doesNotMatch(taxFn, /netProfitStatus/);

  const incompleteCogsFinalTax = {
    costCoverageIncomplete: true,
    dataMode: "PRELIMINARY",
    netProfitStatus: "PRELIMINARY",
    taxesUnavailable: false,
    taxesEstimated: false,
  };
  assert.equal(hasPreliminaryTax(incompleteCogsFinalTax), false);
  assert.equal(hasPreliminaryProfitOrCogs(incompleteCogsFinalTax), true);

  const taxPreliminaryOnly = {
    costCoverageIncomplete: false,
    dataMode: "FINAL",
    netProfitStatus: "FINAL",
    taxesUnavailable: false,
    taxesEstimated: true,
  };
  assert.equal(hasPreliminaryTax(taxPreliminaryOnly), true);
  assert.equal(hasPreliminaryProfitOrCogs(taxPreliminaryOnly), false);
});

test("profit WB/Ozon expose preliminary when cost coverage incomplete", () => {
  const wb = read("app/profit-wb/page.tsx");
  const ozon = read("app/profit-ozon/page.tsx");
  assert.match(wb, /costCoverageIncomplete/);
  assert.match(wb, /data-wb-pnl-kind/);
  assert.match(wb, /data-wb-cost-coverage/);
  assert.match(ozon, /isPreliminaryOzonProfit/);
  assert.match(ozon, /costCoverageIncomplete/);
  assert.match(ozon, /data-ozon-pnl-kind/);
  assert.match(ozon, /data-ozon-cost-coverage/);
});

test("ABC excludes incomplete-cost rows and marks combined incomplete", () => {
  const src = read("app/abc/page.tsx");
  const adapter = read("lib/waveC/insightsAbcAdapter.ts");
  assert.match(adapter, /costCoverageIncomplete/);
  assert.match(src, /abc-cost-incomplete/);
  assert.match(src, /data-abc-combined-complete/);
  assert.match(src, /Прибыль после налогов/);
  assert.match(adapter, /costCoverageIncomplete !== true/);
});

test("Insights forces PRELIMINARY on incomplete cost", () => {
  const src = read("app/insights/page.tsx");
  const adapter = read("lib/waveC/insightsAbcAdapter.ts");
  assert.match(adapter, /costCoverageIncomplete/);
  assert.match(src, /insights-cost-incomplete/);
  assert.match(src, /data-insights-combined-complete/);
  assert.match(src, /Прибыль маркетплейсов после налогов/);
});

test("analytics API exposes profitFinality metadata", () => {
  const src = read("app/api/analytics/profit/route.ts");
  assert.match(src, /profitFinality/);
  assert.match(src, /costCoverageIncomplete/);
  assert.match(src, /PRELIMINARY/);
});

test("Dashboard loan payment label is not ambiguous Кредиты", () => {
  const src = read("app/page.tsx");
  assert.match(src, /Платежи по кредитам/);
  // payment-flow label must not be bare "Кредиты"
  assert.doesNotMatch(src, /label:\s*"Кредиты"/);
});

test("loan calendar/forecast future unpaid requires active debt", () => {
  const cal = read("app/finance/calendar/page.tsx");
  const fc = read("app/finance/forecast/page.tsx");
  assert.match(cal, /currentDebt:\s*\{\s*gt:\s*0,?\s*\}/);
  assert.match(fc, /currentDebt:\s*\{\s*gt:\s*0,?\s*\}/);
  assert.match(fc, /paid:\s*false/);
});

test("Telegram render uses preliminary wording; no send APIs added in render path markers", () => {
  const src = read("lib/telegram/dailyReport.ts");
  assert.match(src, /Предварительная чистая прибыль|netProfitStatus === "PRELIMINARY"/);
  assert.match(src, /companyPreliminary/);
  // Guard: render builder must not call Telegram Bot send APIs.
  assert.doesNotMatch(src, /api\.telegram\.org|sendMessage\(/);
});

test("WB and Ozon analytics use positive-only cost lookups", () => {
  const wb = read("lib/analytics/profitAnalytics.ts");
  const ozon = read("lib/analytics/profitAnalyticsOzon.ts");
  assert.match(wb, /buildCanonicalPositiveCostLookups/);
  assert.match(ozon, /buildCanonicalPositiveCostLookups/);
  assert.match(wb, /costCoverageIncomplete/);
  assert.match(ozon, /costCoverageIncomplete/);
});
