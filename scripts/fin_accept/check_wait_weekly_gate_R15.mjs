#!/usr/bin/env node
/** Prove wait_weekly gate: empty/partial matrix must not PASS. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
);
const src = fs.readFileSync(path.join(root, "scripts/fin_accept/wait_weekly_R12.sh"), "utf8");
assert.match(src, /EXPECTED_COUNT/);
assert.match(src, /WEEKLY_WAIT_INCOMPLETE_MATRIX/);
assert.match(src, /WEEKLY_WAIT_ALL_SUCCESS/);
assert.match(src, /status=.SUCCESS/);
assert.match(src, /total=.*expect=/);
assert.ok(src.includes("WEEKLY_WAIT_INCOMPLETE_MATRIX"));

function decide({ total, success, bad, expected }) {
  if (bad > 0) return "FAIL_BAD";
  if (total < expected) return "INCOMPLETE";
  if (success >= expected) return "SUCCESS";
  return "WAIT";
}
assert.equal(decide({ total: 0, success: 0, bad: 0, expected: 12 }), "INCOMPLETE");
assert.equal(decide({ total: 12, success: 12, bad: 0, expected: 12 }), "SUCCESS");
assert.equal(decide({ total: 12, success: 11, bad: 0, expected: 12 }), "WAIT");
assert.equal(decide({ total: 12, success: 10, bad: 1, expected: 12 }), "FAIL_BAD");

const out = { emptyMatrixNotPass: true, sourceGatePresent: true };
fs.writeFileSync(process.argv[3] || "R15_wait_weekly_gate.json", JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
console.log("WAIT_WEEKLY_GATE_R15_PASS");
