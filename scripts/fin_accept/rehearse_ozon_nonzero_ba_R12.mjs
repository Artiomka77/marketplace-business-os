#!/usr/bin/env node
/**
 * R12: nonzero B/A path — fixture totals → "producer" stored read-model →
 * consumer/page resolver. Covers legacy G−B, new G−B−A, incomplete.
 * Does not mutate source payloads; profit checked against fixed expected.
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
    "../marketplace-business-os/_fin_accept_r12/FIN_ACCEPT_20261027_R12/checks/legacy_ozon_totals_R11.json",
  );

let src = stripTypeScriptTypes(
  fs.readFileSync(path.join(root, "lib/analytics/profitAnalyticsOzon.ts"), "utf8"),
);
src = src
  .replace(/^import\s+[\s\S]*?;\s*/gm, "")
  .replace(/^export\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];?\s*/gm, "")
  .replace(/^export\s+/gm, "");
const fn = vm.runInNewContext(
  src +
    "\n({resolveOzonNetExpensesForDisplay,resolveOzonNetExpensesForDisplayDetailed,calculateOzonNetExpensesAfterDiscountPoints,OZON_NET_EXPENSES_REPRESENTATION_G_MINUS_B_MINUS_A})",
  { console, Date, Map, Set, Number },
);

const writes = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
const all = writes.find((w) => w.meta.companyScope === "ALL" && w.meta.marketplace === "OZON");
assert.ok(all);
const source = structuredClone(all.totals);
const profitExpected = 882464.11;
const nExpected = 173948.64;

// --- Producer simulation: persist new representation from components ---
const produced = {
  ...source,
  netOzonExpenses: fn.calculateOzonNetExpensesAfterDiscountPoints({
    grossOzonExpenses: source.grossOzonExpenses,
    discountPointsCompensation: source.discountPointsCompensation,
    partnerProgramsAmount: source.partnerProgramsAmount,
  }),
  netOzonExpensesRepresentation: "G_MINUS_B_MINUS_A",
  partnerTaxPolicy: "OWNER_CONFIRMED_SAME_AS_DISCOUNT_POINTS",
};
assert.equal(Number(produced.netOzonExpenses.toFixed(2)), nExpected);
assert.equal(Number(produced.netProfitAfterTax.toFixed(2)), profitExpected);

// Consumer on NEW stored payload must not subtract A again
const consumerNew = fn.resolveOzonNetExpensesForDisplay(produced);
assert.equal(Number(consumerNew.toFixed(2)), nExpected);

// Consumer on LEGACY stored (G−B, no representation) with A present
const legacyStored = {
  ...source,
  netOzonExpenses: source.netOzonExpenses, // G−B
  netOzonExpensesRepresentation: "G_MINUS_B",
};
const consumerLegacy = fn.resolveOzonNetExpensesForDisplay(legacyStored);
assert.equal(Number(consumerLegacy.toFixed(2)), nExpected);

// Incomplete: new rep missing A but with stored N → use stored
const incompleteA = {
  grossOzonExpenses: 1000,
  discountPointsAmount: 200,
  netOzonExpenses: 700,
  netOzonExpensesRepresentation: "G_MINUS_B_MINUS_A",
};
assert.equal(fn.resolveOzonNetExpensesForDisplay(incompleteA), 700);

// Prove source payload not mutated
assert.equal(all.totals.netOzonExpenses, source.netOzonExpenses);
assert.equal(all.totals.netProfitAfterTax, source.netProfitAfterTax);

const out = {
  ok: true,
  nonzeroBA: {
    partnerProgramsAmount: source.partnerProgramsAmount,
    discountPointsCompensation: source.discountPointsCompensation,
  },
  producerStoredN: produced.netOzonExpenses,
  consumerNewN: consumerNew,
  consumerLegacyN: consumerLegacy,
  profitExpected,
  profitActual: produced.netProfitAfterTax,
  sourcePayloadMutated: false,
};
const outPath = process.argv[4] || "R12_nonzero_ba_rehearsal.json";
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
console.log("NONZERO_BA_REHEARSAL_R12_PASS");
