/**
 * Imports the real production coverage merge helper — no local mirror fallback.
 */
import assert from "node:assert/strict";
import { mergeOzonCoverageFlags } from "./ozonCoverageMerge.ts";

const petrov = {
  quantityCoverageComplete: true,
  productCostCoverageComplete: true,
  cogsCoverageComplete: true,
  costCoverageIncomplete: false,
  quantityMissingDays: [] as string[],
  taxRevenueCoverageComplete: true,
  discountPointsCoverageComplete: true,
  taxRevenueMissingDays: [] as string[],
  discountPointsMissingDays: [] as string[],
  netProfitStatus: "FINAL" as const,
};

const lebedevaIncomplete = {
  ...petrov,
  quantityCoverageComplete: false,
  cogsCoverageComplete: false,
  costCoverageIncomplete: true,
  quantityMissingDays: ["2026-10-24"],
  netProfitStatus: "PRELIMINARY" as const,
};

const merged = mergeOzonCoverageFlags([petrov, lebedevaIncomplete]);
assert.equal(merged.quantityCoverageComplete, false);
assert.equal(merged.costCoverageIncomplete, true);
assert.equal(merged.cogsCoverageComplete, false);
assert.ok(merged.quantityMissingDays?.includes("2026-10-24"));
assert.equal(merged.netProfitStatus, "PRELIMINARY");

console.log("ozonMergeCoverageFlags.test.ts OK");
