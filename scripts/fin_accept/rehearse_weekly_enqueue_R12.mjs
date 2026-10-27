#!/usr/bin/env node
/**
 * R12 weekly enqueue rehearsal using real decideV6JobRebuild / job-id builder.
 * Isolated in-memory jobs table — no MAIN DB writes.
 *
 * Run: node --import tsx scripts/fin_accept/rehearse_weekly_enqueue_R12.mjs [out.json]
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const { decideV6JobRebuild } = await import(
  pathToFileURL(path.join(root, "lib/dashboard/v6PeriodReadModel/queueLifecycle.ts")).href
);
const { buildDashboardPeriodSnapshotJobId } = await import(
  pathToFileURL(path.join(root, "lib/dashboard/v6PeriodReadModel/jobIdentity.ts")).href
);
const { CANONICAL_PROFIT_COMPANY_SCOPES } = await import(
  pathToFileURL(path.join(root, "lib/profitReadModel/canonicalScopes.ts")).href
);
const {
  FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
  FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
} = await import(pathToFileURL(path.join(root, "lib/profitReadModel/contract.ts")).href);

const SCOPES = [...CANONICAL_PROFIT_COMPANY_SCOPES];
const FORMULAS = [
  FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
  FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
  "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2",
  "FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1",
];
const dateFrom = "2026-10-19";
const dateTo = "2026-10-25";

/** @type {Map<string, {id:string,status:string,attempts:number,maxAttempts:number,companyScope:string,formulaVersion:string}>} */
const jobs = new Map();

function enqueue({ companyScope, formulaVersion }) {
  const id = buildDashboardPeriodSnapshotJobId({
    companyScope,
    dateFrom,
    dateTo,
    formulaVersion,
  });
  const existing = jobs.get(id) || null;
  const decision = decideV6JobRebuild(existing);
  if (decision.action === "keep_existing") {
    return { id, created: false, action: decision.action, status: existing.status };
  }
  if (decision.action === "reopen_success") {
    const row = {
      id,
      companyScope,
      dateFrom,
      dateTo,
      formulaVersion,
      status: "PENDING",
      attempts: 0,
      maxAttempts: existing.maxAttempts,
    };
    jobs.set(id, row);
    return { id, created: false, action: decision.action, status: row.status };
  }
  const row = {
    id,
    companyScope,
    dateFrom,
    dateTo,
    formulaVersion,
    status: "PENDING",
    attempts: 0,
    maxAttempts: 3,
  };
  jobs.set(id, row);
  return { id, created: true, action: decision.action, status: row.status };
}

const enqueued = [];
for (const formulaVersion of FORMULAS) {
  for (const companyScope of SCOPES) {
    enqueued.push({ formulaVersion, companyScope, ...enqueue({ companyScope, formulaVersion }) });
  }
}

const second = [];
for (const formulaVersion of FORMULAS) {
  for (const companyScope of SCOPES) {
    second.push({ formulaVersion, companyScope, ...enqueue({ companyScope, formulaVersion }) });
  }
}

assert.equal(jobs.size, FORMULAS.length * SCOPES.length);
assert.ok(second.every((r) => r.action === "keep_existing"));
assert.ok(enqueued.every((r) => r.created && r.action === "create"));
assert.ok(enqueued.every((r) => String(r.id).startsWith("v6rmj_")));

// SUCCESS reopen path (rebuild mechanism) — not a blind duplicate insert
const sampleId = enqueued[0].id;
jobs.get(sampleId).status = "SUCCESS";
const reopen = enqueue({
  companyScope: enqueued[0].companyScope,
  formulaVersion: enqueued[0].formulaVersion,
});
assert.equal(reopen.action, "reopen_success");
assert.equal(jobs.get(sampleId).status, "PENDING");
assert.equal(jobs.size, FORMULAS.length * SCOPES.length);

const out = {
  dateFrom,
  dateTo,
  jobCount: jobs.size,
  sampleIds: enqueued.slice(0, 4).map((e) => ({
    id: e.id,
    formulaVersion: e.formulaVersion,
    companyScope: e.companyScope,
  })),
  idempotentSecondPass: second.every((r) => r.action === "keep_existing"),
  reopenSuccessWorks: reopen.action === "reopen_success",
  formulas: FORMULAS,
  scopes: SCOPES,
  writeScope: "DashboardPeriodSnapshotJob matrix only (isolated Map; no Prisma/MAIN)",
};
const outPath = process.argv[2] || "R12_weekly_enqueue_rehearsal.json";
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
console.log("WEEKLY_ENQUEUE_REHEARSAL_R12_PASS");
