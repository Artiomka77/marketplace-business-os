import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");

test("periodReadModelModulePresent: Wave A module tree present", () => {
  for (const rel of [
    "lib/dashboard/v6PeriodReadModel/contract.ts",
    "lib/dashboard/v6PeriodReadModel/consumer.ts",
    "lib/dashboard/v6PeriodReadModel/producer.ts",
    "lib/dashboard/v6PeriodReadModel/repository.ts",
    "lib/dashboard/v6PeriodReadModel/index.ts",
    "lib/dashboard/v6PeriodReadModel/d1d5Eligibility.ts",
  ]) {
    assert.equal(fs.existsSync(path.join(root, rel)), true, rel);
  }
});
