/**
 * Production-facing weekly enqueue for 2026-10-19..2026-10-25.
 * Writes ONLY DashboardPeriodSnapshotJob rows via real repository APIs.
 * Requires DATABASE_URL. Does not touch COGS/Finance source tables.
 *
 *   DATABASE_URL=... node --import tsx scripts/fin_accept/run_weekly_enqueue_R12.ts
 */
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { ensureClosedWeekProfitJobMatrix } from "@/lib/profitReadModel/ensureClosedWeekProfitJobMatrix";
import { createPrismaProfitReadModelRepository } from "@/lib/profitReadModel/repository";
import { CANONICAL_PROFIT_COMPANY_SCOPES } from "@/lib/profitReadModel/canonicalScopes";
import { buildDashboardPeriodSnapshotJobId } from "@/lib/dashboard/v6PeriodReadModel/jobIdentity";

const dateFrom = process.env.DATE_FROM || "2026-10-19";
const dateTo = process.env.DATE_TO || "2026-10-25";
const outPath = process.argv[2] || "R12_weekly_enqueue_live.json";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(2);
}

const prisma = new PrismaClient();

async function enqueueFormula(formulaVersion: string) {
  // Reuse Wave-B repository enqueue for any formulaVersion string identity
  // (same DashboardPeriodSnapshotJob table / decideV6JobRebuild contract).
  const repository = createPrismaProfitReadModelRepository(prisma);
  const rows = [];
  for (const companyScope of CANONICAL_PROFIT_COMPANY_SCOPES) {
    const result = await repository.enqueueRebuild({
      companyScope,
      dateFrom,
      dateTo,
      formulaVersion: formulaVersion as never,
      priority: 40,
    });
    rows.push({
      companyScope,
      formulaVersion,
      jobId: result.id,
      action: result.action,
      created: result.created,
      expectedId: buildDashboardPeriodSnapshotJobId({
        companyScope,
        dateFrom,
        dateTo,
        formulaVersion,
      }),
    });
  }
  return rows;
}

async function main() {
  const profit = await ensureClosedWeekProfitJobMatrix({
    prisma,
    dateFrom,
    dateTo,
    priority: 40,
  });
  const v6 = await enqueueFormula("FINANCIAL_CORE_V6_PERIOD_READMODEL_V2");
  const dash = await enqueueFormula("FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1");

  const out = {
    dateFrom,
    dateTo,
    writeScope: "DashboardPeriodSnapshotJob only",
    profit: profit.enqueued,
    v6,
    dashboard: dash,
    jobIds: [
      ...profit.enqueued.map((e) => e.jobId),
      ...v6.map((e) => e.jobId),
      ...dash.map((e) => e.jobId),
    ],
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
  console.log("WEEKLY_ENQUEUE_LIVE_R12_OK");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
