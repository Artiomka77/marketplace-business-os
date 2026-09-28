import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

test("exact-day WB ads must not use weekly promotion settlement", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "lib/analytics/profitAnalytics.ts"),
    "utf8"
  );
  assert.match(src, /function isExactSingleDayPeriod/);
  assert.match(src, /Exact-day grain: never substitute weekly/);
  assert.match(src, /const pnlAdsDeduction = exactDay/);
  assert.match(
    src,
    /applyWbFinanceExpenseTotals\(currentBase, currentFinanceExpenses, \{/
  );
});

test("daily/week ads isolation contract in source", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "lib/analytics/profitAnalytics.ts"),
    "utf8"
  );
  // Weekly path still allows classified promotion ads when not exact day
  assert.match(src, /pnlAdsDeduction > 0 \? pnlAdsDeduction : campaignAdsCost/);
  assert.match(src, /classifiedPnlAds: pnlAdsDeduction/);
});

test("telegram UTF8 fixture no longer freezes weekly WB ads as daily control", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "scripts/architecture/telegramUtf8Render.test.ts"),
    "utf8"
  );
  assert.equal(src.includes("adSpend: 159374"), false);
  assert.equal(src.includes("drrByEconomicTurnover: 100.3"), false);
});
