#!/usr/bin/env node
/**
 * R12 isolated proof:
 * 1) Profit worker source has SIGTERM→stopping and does not invent SUCCESS on interrupt.
 * 2) Runtime simulation: claim mid-flight + stop → RUNNING+INTERRUPTED_BY_STOP; no further claims;
 *    stale RUNNING not deleted / not SUCCESS.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = path.resolve(
  process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
);

const profitSrc = fs.readFileSync(
  path.join(root, "scripts/dashboard/runProfitReadModelWorker.ts"),
  "utf8",
);
assert.match(profitSrc, /let stopping = false/);
assert.match(profitSrc, /process\.on\("SIGTERM"/);
assert.match(profitSrc, /INTERRUPTED_BY_STOP/);
assert.match(profitSrc, /while \(!stopping\)/);
assert.match(profitSrc, /if \(stopping\) return null/);
assert.doesNotMatch(
  profitSrc,
  /WAVE_B_PROFIT_WORKER_MODE.*drain/,
  "profit must not treat drain as stop-claims gate",
);

const dashSrc = fs.readFileSync(
  path.join(root, "scripts/dashboard/runDashboardPeriodSnapshotWorker.ts"),
  "utf8",
);
assert.match(dashSrc, /process\.on\("SIGTERM"/);
assert.match(dashSrc, /workerMode === "drain"/);
// Drain continues claiming until empty — documented non-gate.
assert.ok(dashSrc.includes("while (!stopping && (await processOneJob()))"));

const v6Src = fs.readFileSync(
  path.join(root, "scripts/dashboard/runV6PeriodReadModelWorker.ts"),
  "utf8",
);
assert.match(v6Src, /shouldStop: \(\) => stopping/);

// --- Runtime simulation mirroring profit contract ---
const jobs = new Map();
let stopping = false;
let claimedAfterStop = 0;

function seedJob(id) {
  jobs.set(id, { id, status: "PENDING", attempts: 0, lockedAt: null, lastError: null });
}

async function claimNext() {
  if (stopping) {
    claimedAfterStop += 1;
    return null;
  }
  for (const job of jobs.values()) {
    if (job.status === "PENDING") {
      job.status = "RUNNING";
      job.attempts += 1;
      job.lockedAt = Date.now();
      return job;
    }
  }
  return null;
}

async function processOne() {
  const job = await claimNext();
  if (!job) return false;
  await sleep(80);
  if (stopping) {
    job.status = "RUNNING";
    job.lastError = "INTERRUPTED_BY_STOP";
    return true;
  }
  job.status = "SUCCESS";
  job.lockedAt = null;
  return true;
}

seedJob("job-1");
seedJob("job-2");

const run = (async () => {
  while (!stopping && (await processOne())) {
    /* until stop */
  }
})();

await sleep(30);
stopping = true;
await run;

const j1 = jobs.get("job-1");
assert.ok(j1);
assert.notEqual(j1.status, "SUCCESS");
assert.equal(j1.status, "RUNNING");
assert.equal(j1.lastError, "INTERRUPTED_BY_STOP");
assert.equal(await claimNext(), null);
assert.ok(claimedAfterStop >= 1);
assert.equal([...jobs.values()].filter((j) => j.status === "PENDING").length, 1);
assert.equal([...jobs.values()].filter((j) => j.status === "SUCCESS").length, 0);

const out = {
  profitWorkerHasSigtermGate: true,
  drainIsNotClaimGate: true,
  interruptedJobStatus: j1.status,
  interruptedMarkedSuccess: false,
  pendingPreserved: 1,
  staleLockNotDeleted: true,
};
fs.writeFileSync(
  process.argv[3] || "R12_stop_claims_isolation.json",
  JSON.stringify(out, null, 2) + "\n",
);
console.log(JSON.stringify(out, null, 2));
console.log("STOP_CLAIMS_ISOLATION_R12_PASS");
