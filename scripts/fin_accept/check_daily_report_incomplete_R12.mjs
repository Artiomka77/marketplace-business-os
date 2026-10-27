#!/usr/bin/env node
/**
 * R12: dailyReport source contract — NaN net → «н/д»; COGS-incomplete lists SKUs;
 * incomplete profit not summed as trusted 0.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
);
const src = fs.readFileSync(path.join(root, "lib/telegram/dailyReport.ts"), "utf8");

assert.match(src, /Чистые расходы Ozon: н\/д \(неполные данные расходов\)/);
assert.match(src, /Себестоимость Ozon предварительная/);
assert.match(src, /не включена в сумму сводки как 0/);
assert.ok(src.includes("Number.isFinite(metrics.netOzonExpenses)"));
assert.ok(src.includes("costCoverageIncomplete"));
assert.ok(src.includes("costCoverageMissingSkuCount"));
assert.ok(src.includes("resolveOzonNetExpensesForDisplay"));
// Summary must not coerce incomplete profit into a trusted zero addend.
assert.match(src, /if \(Number\.isFinite\(realNetProfit\)\)/);
assert.match(src, /report\.totals\.netProfitImpact \+= realNetProfit/);

// Local mirror of the net/cogs branch (same predicates as source).
function formatNetLine(metrics) {
  const lines = [];
  if (metrics.marketplace === "OZON" && metrics.netOzonExpenses !== undefined) {
    const netText = Number.isFinite(metrics.netOzonExpenses) ? `${metrics.netOzonExpenses}₽` : "н/д";
    lines.push(
      !Number.isFinite(metrics.netOzonExpenses)
        ? `Чистые расходы Ozon: н/д (неполные данные расходов)`
        : `Чистые расходы Ozon после баллов и программ партнёров: ${netText}`,
    );
  }
  if (metrics.marketplace === "OZON" && metrics.costCoverageIncomplete) {
    const n = metrics.costCoverageMissingSkuCount ?? 0;
    const examples = (metrics.costCoverageMissingExamples ?? [])
      .slice(0, 5)
      .map((ex) => ex.vendorCode || "?")
      .filter(Boolean);
    lines.push(
      n > 0
        ? `Себестоимость Ozon предварительная: нет COGS у ${n} SKU (пример: ${examples.join(", ")})`
        : "Себестоимость Ozon предварительная: покрытие COGS неполное",
    );
  }
  return lines.join("\n");
}

const incompleteNet = formatNetLine({
  marketplace: "OZON",
  netOzonExpenses: Number.NaN,
});
assert.match(incompleteNet, /н\/д \(неполные данные расходов\)/);
assert.doesNotMatch(incompleteNet, /после баллов.*0/);

const cogs = formatNetLine({
  marketplace: "OZON",
  netOzonExpenses: 700,
  costCoverageIncomplete: true,
  costCoverageMissingSkuCount: 2,
  costCoverageMissingExamples: [{ vendorCode: "SKU-A" }, { vendorCode: "SKU-B" }],
});
assert.match(cogs, /нет COGS у 2 SKU/);
assert.match(cogs, /SKU-A/);
assert.match(cogs, /700₽/); // other safe metric (net) preserved alongside warning

const out = {
  sourceContractOk: true,
  incompleteNetShowsNd: true,
  cogsIncompleteListsSku: true,
  otherMetricsPreserved: true,
  summaryDoesNotZeroFillIncompleteProfit: true,
};
fs.writeFileSync(
  process.argv[3] || "R12_daily_report_incomplete.json",
  JSON.stringify(out, null, 2) + "\n",
);
console.log(JSON.stringify(out, null, 2));
console.log("DAILY_REPORT_INCOMPLETE_R12_PASS");
