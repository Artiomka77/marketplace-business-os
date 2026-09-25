import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");

test("snapshotWorkerEntrypointPresent: V6 worker entry exists", () => {
  const worker = path.join(
    root,
    "scripts/dashboard/runV6PeriodReadModelWorker.ts"
  );
  assert.equal(fs.existsSync(worker), true);
  const text = fs.readFileSync(worker, "utf8");
  assert.match(text, /FINANCIAL_CORE_V6_PERIOD_READMODEL_V2/);
  assert.match(text, /V6_PERIOD_READMODEL_WORKER_CONCURRENCY/);
});
