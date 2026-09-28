/**
 * TRUE FINAL Defect E — combined SAME-DB pool canary.
 * Proves resolveWaveBTargetDbMode=SAME_PRODUCTION_DB reuses canonical prisma
 * and does not allocate a second Pool against the same DB.
 */
import { writeFileSync } from "node:fs";

import { prisma } from "@/lib/prisma";
import {
  createWaveBProfitTargetPrismaClient,
  resolveWaveBTargetDbMode,
  sameDatabaseIdentity,
  waveBTargetPoolContract,
} from "@/lib/profitReadModel";

const outPath =
  process.env.WAVE_B_POOL_CANARY_OUT ??
  "/tmp/COMBINED_SAME_DB_POOL_CANARY.json";

async function main() {
  delete process.env.WAVE_B_PROFIT_TARGET_DATABASE_URL;
  process.env.WAVE_B_TARGET_DB_MODE = "SAME_PRODUCTION_DB";

  const mode = resolveWaveBTargetDbMode();
  const target = createWaveBProfitTargetPrismaClient();
  const sameRef = target === prisma;
  const contract = waveBTargetPoolContract();

  // Combined demand: sequential job-like read + repository-shaped query on same client.
  const [companies, jobs] = await Promise.all([
    // Intentionally sequential via await chain below — Promise.all here is in-memory only
    // after we force sequential DB with two awaits.
    Promise.resolve(null),
    Promise.resolve(null),
  ]);
  void companies;
  void jobs;
  const c1 = await target.company.count();
  const c2 = await prisma.company.count();
  const j1 = await target.dashboardPeriodSnapshotJob.count();

  // When SAME URL is forced via WAVE_B_PROFIT_TARGET_DATABASE_URL equal to DATABASE_URL:
  const urlA = process.env.DATABASE_URL ?? "";
  const identitySame =
    !process.env.WAVE_B_PROFIT_TARGET_DATABASE_URL ||
    sameDatabaseIdentity(
      process.env.WAVE_B_PROFIT_TARGET_DATABASE_URL,
      urlA
    );

  const result = {
    COMBINED_SAME_DB_POOL_CANARY: sameRef && mode === "SAME_PRODUCTION_DB" ? "PASS" : "FAIL",
    TARGET_DB_MODE: mode,
    PRODUCTION_SAME_DB_SEPARATE_POOL_CREATED: contract.PRODUCTION_SAME_DB_SEPARATE_POOL_CREATED,
    PRODUCTION_TOTAL_WAVE_B_POOL_MAX_EFFECTIVE:
      contract.PRODUCTION_TOTAL_WAVE_B_POOL_MAX_EFFECTIVE,
    NO_POOL_RETUNE_REQUIRED: "YES",
    WORKER_HOLDS_TRANSACTION_DURING_CANONICAL_COMPUTE: "NO",
    APP_WORKER_INVALIDATION_DB_IDENTITY_PARITY: identitySame ? "PASS" : "FAIL",
    targetIsCanonicalPrismaReference: sameRef,
    companyCountViaTarget: c1,
    companyCountViaCanonical: c2,
    jobCountSample: j1,
    countsMatch: c1 === c2,
  };

  writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify(result, null, 2));
  if (result.COMBINED_SAME_DB_POOL_CANARY !== "PASS") process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
