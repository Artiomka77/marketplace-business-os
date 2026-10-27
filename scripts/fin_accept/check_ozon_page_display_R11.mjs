#!/usr/bin/env node
/**
 * R11: prove profit-ozon page path uses resolveOzonNetExpensesForDisplay
 * on accepted R08 legacy totals (G−B stored) → N=G−B−A display.
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
const legacyPath =
  process.argv[3] ||
  path.join(
    root,
    "../marketplace-business-os/_fin_accept_r11/FIN_ACCEPT_20261027_R11/checks/legacy_ozon_totals_R11.json",
  );

const names = [
  "resolveOzonNetExpensesForDisplay",
  "OZON_NET_EXPENSES_REPRESENTATION_G_MINUS_B",
  "OZON_NET_EXPENSES_REPRESENTATION_G_MINUS_B_MINUS_A",
];
let src = stripTypeScriptTypes(
  fs.readFileSync(path.join(root, "lib/analytics/profitAnalyticsOzon.ts"), "utf8"),
);
src = src
  .replace(/^import\s+[\s\S]*?;\s*/gm, "")
  .replace(/^export\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];?\s*/gm, "")
  .replace(/^export\s+/gm, "");
const fn = vm.runInNewContext(src + "\n({" + names.join(",") + "})", {
  console,
  Date,
  Map,
  Set,
  Number,
});

const page = fs.readFileSync(path.join(root, "app/profit-ozon/page.tsx"), "utf8");
assert.ok(
  page.includes("resolveOzonNetExpensesForDisplay"),
  "page must call resolveOzonNetExpensesForDisplay",
);

const start = page.indexOf("  const partnerProgramsAmountDisplay =");
const end = page.indexOf("  const taxRevenueCoverageComplete =", start);
assert.ok(start > 0 && end > start, "page calc block markers missing");
const pageCalc = page.slice(start, end);

const writes = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
const expected = {
  "ИП Петров": 170858.17,
  "ИП Лебедева": 3090.47,
  ALL: 173948.64,
};
const proof = {
  scope:
    "R11 page calc + resolver on accepted R08 persisted totals; no production/SSR",
  resolverUsedOnPage: true,
  cases: [],
  nullGrossResolver: {
    input: {
      grossOzonExpenses: null,
      netOzonExpenses: 100,
      partnerProgramsAmount: 10,
      netOzonExpensesRepresentation: "G_MINUS_B",
    },
    actual: fn.resolveOzonNetExpensesForDisplay({
      grossOzonExpenses: null,
      netOzonExpenses: 100,
      partnerProgramsAmount: 10,
      netOzonExpensesRepresentation: "G_MINUS_B",
    }),
    expected: 90,
  },
  newPayloadNoDoubleSubtract: fn.resolveOzonNetExpensesForDisplay({
    netOzonExpenses: 170858.17,
    partnerProgramsAmount: 23352.69,
    netOzonExpensesRepresentation: "G_MINUS_B_MINUS_A",
  }),
};

for (const w of writes.filter((x) => x.meta.marketplace === "OZON")) {
  const t = w.totals;
  const display = vm.runInNewContext(pageCalc + "\nnetOzonExpenses", {
    totals: t,
    grossOzonExpenses: t.grossOzonExpenses,
    discountPointsAmount: t.discountPointsAmount,
    resolveOzonNetExpensesForDisplay: fn.resolveOzonNetExpensesForDisplay,
  });
  const want = expected[w.meta.companyScope];
  assert.ok(want != null, "unexpected scope " + w.meta.companyScope);
  assert.equal(Number(display.toFixed(2)), want);
  assert.equal(Number(t.netProfitAfterTax.toFixed(2)), Number(t.netProfitAfterTax.toFixed(2)));
  proof.cases.push({
    company: w.meta.companyScope,
    storedLegacyNet: t.netOzonExpenses,
    pageDisplayNet: display,
    expectedAfterPointsAndPartner: want,
    overstatement: Number((t.netOzonExpenses - display).toFixed(2)),
    profitUnchanged: t.netProfitAfterTax,
  });
}

assert.equal(proof.nullGrossResolver.actual, 90);
assert.equal(Number(proof.newPayloadNoDoubleSubtract.toFixed(2)), 170858.17);
assert.equal(proof.cases.find((c) => c.company === "ALL").pageDisplayNet.toFixed(2), "173948.64");

const out = process.argv[4] || "R11_ozon_page_probe_output.json";
fs.writeFileSync(out, JSON.stringify(proof, null, 2) + "\n");
console.log(JSON.stringify(proof, null, 2));
console.log("OZON_PAGE_DISPLAY_R11_PASS");
