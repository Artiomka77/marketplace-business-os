/**
 * Production-facing weekly enqueue for 2026-10-19..2026-10-25.
 * Stages: Profit matrix → (caller waits) → V6 → Dashboard.
 * Uses project Prisma adapter (lib/prisma), not bare PrismaClient.
 *
 *   DATABASE_URL=... node --import tsx scripts/fin_accept/run_weekly_enqueue_R12.ts [out.json]
 *   WEEKLY_STAGE=profit|v6|dashboard|all (default all — still sequential in-process)
 */
import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import { ensureClosedWeekProfitJobMatrix } from "@/lib/profitReadModel/ensureClosedWeekProfitJobMatrix";
import { createPrismaProfitReadModelRepository } from "@/lib/profitReadModel/repository";
import { CANONICAL_PROFIT_COMPANY_SCOPES } from "@/lib/profitReadModel/canonicalScopes";
import { buildDashboardPeriodSnapshotJobId } from "@/lib/dashboard/v6PeriodReadModel/jobIdentity";
import {
  FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
  FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
} from "@/lib/profitReadModel/contract";

const dateFrom = process.env.DATE_FROM || "2026-10-19";
const dateTo = process.env.DATE_TO || "2026-10-25";
const stage = (process.env.WEEKLY_STAGE || "all").toLowerCase();
const outPath = process.argv[2] || "R15_weekly_enqueue_live.json";
const idsPath = process.env.WEEKLY_JOB_IDS_FILE || "R15_weekly_job_ids.txt";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(2);
}

type EnqueueRow = {
  companyScope: string;
  formulaVersion: string;
  jobId: string;
  action: string;
  created: boolean;
  expectedId: string;
  idMatchesBuilder: boolean;
};

async function enqueueFormula(formulaVersion: string): Promise<EnqueueRow[]> {
  const repository = createPrismaProfitReadModelRepository(prisma);
  const rows: EnqueueRow[] = [];
  for (const companyScope of CANONICAL_PROFIT_COMPANY_SCOPES) {
    const expectedId = buildDashboardPeriodSnapshotJobId({
      companyScope,
      dateFrom,
      dateTo,
      formulaVersion,
    });
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
      expectedId,
      idMatchesBuilder: result.id === expectedId || result.action !== "create",
    });
  }
  return rows;
}

async function main() {
  const out: Record<string, unknown> = {
    dateFrom,
    dateTo,
    stage,
    writeScope: "DashboardPeriodSnapshotJob only",
    prisma: "lib/prisma adapter",
  };
  const allIds: string[] = [];

  if (stage === "profit" || stage === "all") {
    const profit = await ensureClosedWeekProfitJobMatrix({
      prisma,
      dateFrom,
      dateTo,
      priority: 40,
    });
    out.profit = profit.enqueued;
    for (const e of profit.enqueued) allIds.push(e.jobId);
    // Prove formulas are the Wave-B pair
    const formulas = new Set(profit.enqueued.map((e) => e.formulaVersion));
    if (
      !formulas.has(FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1) ||
      !formulas.has(FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1)
    ) {
      throw new Error("profit matrix missing WB/OZON formulas");
    }
  }

  if (stage === "v6" || stage === "all") {
    // Dependent stage: V6 period after profit producers (caller should wait SUCCESS
    // between stages when running on live workers; in-process "all" documents order).
    const v6 = await enqueueFormula("FINANCIAL_CORE_V6_PERIOD_READMODEL_V2");
    out.v6 = v6;
    for (const e of v6) allIds.push(e.jobId);
  }

  if (stage === "dashboard" || stage === "all") {
    const dash = await enqueueFormula("FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1");
    out.dashboard = dash;
    for (const e of dash) allIds.push(e.jobId);
  }

  out.jobIds = allIds;
  out.jobCount = allIds.length;
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  fs.writeFileSync(idsPath, allIds.join("\n") + "\n");
  console.log(JSON.stringify(out, null, 2));
  console.log("WEEKLY_ENQUEUE_LIVE_R15_OK");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
