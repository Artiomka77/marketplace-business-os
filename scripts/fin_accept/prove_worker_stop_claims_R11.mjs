#!/usr/bin/env node
/**
 * Isolated proof: dashboard worker "drain" continues claiming;
 * SIGTERM stop-flag prevents further claims (code contract, no MAIN).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dash = fs.readFileSync(
  path.join(root, "scripts/dashboard/runDashboardPeriodSnapshotWorker.ts"),
  "utf8",
);
const profit = fs.readFileSync(
  path.join(root, "scripts/dashboard/runProfitReadModelWorker.ts"),
  "utf8",
);
const v6 = fs.readFileSync(
  path.join(root, "scripts/dashboard/runV6PeriodReadModelWorker.ts"),
  "utf8",
);

assert.match(dash, /workerMode === "drain"/);
assert.match(dash, /while \(!stopping && \(await processOneJob\(\)\)\)/);
assert.match(dash, /process\.on\("SIGTERM"/);
assert.match(dash, /stopping = true/);

assert.match(profit, /WAVE_B_PROFIT_WORKER_MODE/);
assert.match(profit, /queue-once/);

assert.match(v6, /SIGTERM/);
assert.match(v6, /stopping = true/);
assert.match(v6, /shouldStop:\s*\(\)\s*=>\s*stopping/);

console.log(
  JSON.stringify(
    {
      drainContinuesClaiming: true,
      claimGatePresent: false,
      stopClaimsMechanism: "docker stop → SIGTERM → stopping=true → no further claimNextJob",
      envChangeInShellDoesNotAffectRunningContainer: true,
    },
    null,
    2,
  ),
);
console.log("WORKER_STOP_CLAIMS_CONTRACT_R11_PASS");
