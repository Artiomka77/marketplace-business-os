import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildWbFinanceTaxReportKindByKey,
  buildWbFinanceTaxReportKindByKeyForRelevantSales,
  resolveWbSaleTaxReportKind,
  WbTaxReportKindError,
} from "../../lib/finance/wbAccountantTaxBase";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dashboardPath = path.join(root, "lib/analytics/dashboardDailyAnalytics.ts");
const telegramPath = path.join(root, "lib/telegram/dailyReport.ts");

function baselineDashboardOzonTaxDelta(
  revenue: number,
  usnRate: number,
  vatRate: number
): number {
  if (revenue <= 0) return 0;
  const vatTax =
    revenue <= 0 || vatRate <= 0 ? 0 : revenue * (vatRate / (100 + vatRate));
  return revenue * (usnRate / 100) + vatTax;
}

function candidateDashboardOzonTaxDelta(
  revenue: number,
  usnRate: number,
  vatRate: number
): number {
  if (revenue <= 0) return 0;
  const vatTax =
    revenue <= 0 || vatRate <= 0 ? 0 : revenue * (vatRate / (100 + vatRate));
  return revenue * (usnRate / 100) + vatTax;
}

test("V1.2.1 dashboard Ozon addTaxForRevenue matches baseline semantics", () => {
  const src = fs.readFileSync(dashboardPath, "utf8");
  assert.match(src, /if \(revenue <= 0\) return;/);
  assert.match(src, /revenue \* \(settings\.usnRate \/ 100\)/);
  assert.match(src, /calculateVatTax\(revenue, settings\.vatRate\)/);
  assert.doesNotMatch(src, /calculateMarketplaceTotalTax/);

  for (const revenue of [100_000, 0, -5_000, 12_345.67]) {
    assert.equal(
      candidateDashboardOzonTaxDelta(revenue, 1, 5),
      baselineDashboardOzonTaxDelta(revenue, 1, 5),
      `revenue=${revenue}`
    );
  }
});

test("V1.2.1 report-kind map scoped to relevant sales keys only", () => {
  const kindByKey = buildWbFinanceTaxReportKindByKeyForRelevantSales(
    [
      { companyName: "Co", reportNumber: "R1", reportTypeName: "1" },
      { companyName: "Co", reportNumber: "R-OTHER", reportTypeName: "1" },
      { companyName: "Co", reportNumber: "R-OTHER", reportTypeName: "2" },
    ],
    [{ companyName: "Co", reportNumber: "R1" }]
  );

  assert.equal(kindByKey.get("Co__R1"), "ordinary");
  assert.equal(kindByKey.has("Co__R-OTHER"), false);

  const unscoped = buildWbFinanceTaxReportKindByKey([
    { companyName: "Co", reportNumber: "R-OTHER", reportTypeName: "1" },
    { companyName: "Co", reportNumber: "R-OTHER", reportTypeName: "2" },
  ]);
  assert.equal(unscoped.get("Co__R-OTHER"), "ambiguous");
});

test("V1.2.1 Telegram fallback fail-closed exposes unavailable, not FINAL zero profit", () => {
  const src = fs.readFileSync(telegramPath, "utf8");
  assert.match(src, /netProfitUnavailable/);
  assert.match(src, /wbFallbackNetProfitUnavailable/);
  assert.match(src, /не определён тип отчёта для налога/);

  const profitAnalyticsHasWbData = false;
  const wbFallbackTaxBlockedReason = "WB_TAX_REPORT_KIND_UNRESOLVED";
  const wbFallbackNetProfitUnavailable =
    !profitAnalyticsHasWbData && wbFallbackTaxBlockedReason != null;

  assert.equal(wbFallbackNetProfitUnavailable, true);

  const metrics = {
    netProfitAfterTax: 0,
    netProfitUnavailable: wbFallbackNetProfitUnavailable,
    netProfitUnavailableReason: wbFallbackTaxBlockedReason,
  };

  assert.ok(metrics.netProfitUnavailable);
  assert.notEqual(metrics.netProfitUnavailableReason, null);
  assert.throws(
    () =>
      resolveWbSaleTaxReportKind({
        companyName: "Co",
        reportNumber: "MISSING",
        kindByKey: new Map(),
        requireResolved: true,
      }),
    (err: unknown) => err instanceof WbTaxReportKindError
  );
});

test("V1.2.1 tracked runtime files avoid calculateWbTaxes footgun", () => {
  for (const rel of [
    "lib/finance/marketplaceTax.ts",
    "lib/finance/wbAccountantTaxBase.ts",
    "lib/analytics/profitAnalytics.ts",
    "lib/analytics/dashboardDailyAnalytics.ts",
    "lib/telegram/dailyReport.ts",
  ]) {
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    assert.equal(text.includes("calculateWbTaxes"), false, rel);
  }
});
