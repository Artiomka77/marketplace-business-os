#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
);
const names = [
  "applyOzonFinancialCategoryFactsToTotals",
  "calculateOzonGrossExpenses",
  "calculateOzonNetExpensesAfterDiscountPoints",
  "resolveOzonNetExpensesForDisplay",
  "resolveOzonNetExpensesForDisplayDetailed",
  "resolveOzonDiscountPointsAmount",
  "OZON_NET_EXPENSES_REPRESENTATION_G_MINUS_B",
  "OZON_NET_EXPENSES_REPRESENTATION_G_MINUS_B_MINUS_A",
];
let s = stripTypeScriptTypes(
  fs.readFileSync(path.join(root, "lib/analytics/profitAnalyticsOzon.ts"), "utf8"),
);
s = s
  .replace(/^import\s+[\s\S]*?;\s*/gm, "")
  .replace(/^export\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];?\s*/gm, "")
  .replace(/^export\s+/gm, "");
const fn = vm.runInNewContext(s + "\n({" + names.join(",") + "})", {
  console,
  Date,
  Map,
  Set,
  Number,
});
const bindings = { assert, test, console };
for (const n of names) {
  const alias = n.startsWith("OZON_") ? n + "_FOR_TEST" : n + "ForTest";
  bindings[alias] = fn[n];
  bindings[n] = fn[n];
}
let tests = stripTypeScriptTypes(
  fs.readFileSync(path.join(root, "lib/analytics/ozonUnclassifiedAndPoints.test.ts"), "utf8"),
);
tests = tests.replace(/^import\s+[\s\S]*?;\s*/gm, "");
vm.runInNewContext(tests, bindings, { filename: "ozonUnclassifiedAndPoints.test.ts" });
