#!/usr/bin/env node
/**
 * R12: incomplete Ozon net contract on actual page calc + formatter + flags.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
);

let src = stripTypeScriptTypes(
  fs.readFileSync(path.join(root, "lib/analytics/profitAnalyticsOzon.ts"), "utf8"),
);
src = src
  .replace(/^import\s+[\s\S]*?;\s*/gm, "")
  .replace(/^export\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];?\s*/gm, "")
  .replace(/^export\s+/gm, "");
const api = vm.runInNewContext(
  src +
    "\n({resolveOzonNetExpensesForDisplay,resolveOzonNetExpensesForDisplayDetailed})",
  { console, Date, Map, Set, Number },
);

const page = fs.readFileSync(path.join(root, "app/profit-ozon/page.tsx"), "utf8");
const a = page.indexOf("  const partnerProgramsAmountDisplay =");
const b = page.indexOf("  const accountPartnerResidual =", a);
assert.ok(a > 0 && b > a);
const pageBlock = page.slice(a, b);

const fmtStart = page.indexOf("function formatOzonNetExpensesMoney(");
const fmtEnd = page.indexOf("function formatCompactMoney(", fmtStart);
assert.ok(fmtStart > 0 && fmtEnd > fmtStart);
// include formatMoney + formatOzonNetExpensesMoney
const fmtBlock = page.slice(page.indexOf("function formatMoney("), fmtEnd);
const formatOzonNet = vm.runInNewContext(
  stripTypeScriptTypes(fmtBlock) + "\nformatOzonNetExpensesMoney",
  { Intl, Number },
);

const cases = [
  {
    name: "missing_gross_and_stored_net",
    totals: { netProfitStatus: "FINAL", costCoverageIncomplete: false },
    expectFinite: false,
    expectText: "н/д",
    expectPreliminary: true,
    expectWarning: true,
  },
  {
    name: "new_canonical_stored_net_with_missing_A",
    totals: {
      grossOzonExpenses: 1000,
      discountPointsAmount: 200,
      netOzonExpenses: 700,
      netOzonExpensesRepresentation: "G_MINUS_B_MINUS_A",
      netProfitStatus: "FINAL",
    },
    expectFinite: true,
    expectValue: 700,
    expectText: null,
    expectPreliminary: false,
    expectWarning: false,
  },
  {
    name: "known_zero",
    totals: {
      grossOzonExpenses: 0,
      discountPointsAmount: 0,
      partnerProgramsAmount: 0,
      netOzonExpenses: 0,
      netOzonExpensesRepresentation: "G_MINUS_B_MINUS_A",
      netProfitStatus: "FINAL",
      costCoverageIncomplete: false,
      taxRevenueCoverageComplete: true,
      discountPointsCoverageComplete: true,
    },
    expectFinite: true,
    expectValue: 0,
    expectPreliminary: false,
    expectWarning: false,
  },
];

const results = [];
for (const c of cases) {
  const ctx = {
    totals: c.totals,
    discountPointsAmount: c.totals.discountPointsAmount ?? 0,
    resolveOzonNetExpensesForDisplay: api.resolveOzonNetExpensesForDisplay,
    resolveOzonNetExpensesForDisplayDetailed:
      api.resolveOzonNetExpensesForDisplayDetailed,
  };
  const evaled = vm.runInNewContext(
    stripTypeScriptTypes(pageBlock) +
      "\n({netOzonExpenses,netOzonExpensesComplete,isPreliminaryOzonProfit,hasOzonEconomicSourceWarning,netOzonExpensesResolution})",
    ctx,
  );
  const visible = formatOzonNet(evaled.netOzonExpenses);
  assert.equal(Number.isFinite(evaled.netOzonExpenses), c.expectFinite, c.name);
  if (c.expectFinite) assert.equal(evaled.netOzonExpenses, c.expectValue, c.name);
  if (c.expectText) assert.equal(visible, c.expectText, c.name + " text");
  if (c.expectValue === 0) assert.match(visible, /0/);
  assert.equal(evaled.isPreliminaryOzonProfit, c.expectPreliminary, c.name + " prelim");
  assert.equal(evaled.hasOzonEconomicSourceWarning, c.expectWarning, c.name + " warn");
  results.push({
    name: c.name,
    resolverFinite: Number.isFinite(evaled.netOzonExpenses),
    resolvedValue: Number.isFinite(evaled.netOzonExpenses)
      ? evaled.netOzonExpenses
      : "NaN",
    visibleText: visible,
    isPreliminaryOzonProfit: evaled.isPreliminaryOzonProfit,
    hasOzonEconomicSourceWarning: evaled.hasOzonEconomicSourceWarning,
    complete: evaled.netOzonExpensesComplete,
    reason: evaled.netOzonExpensesResolution?.reason ?? null,
  });
}

const out = {
  scope:
    "R12 incomplete Ozon net contract: page calc + formatOzonNetExpensesMoney + flags; synthetic payloads",
  cases: results,
};
const outPath = process.argv[3] || "R12_incomplete_display.json";
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
console.log("INCOMPLETE_OZON_DISPLAY_R12_PASS");
