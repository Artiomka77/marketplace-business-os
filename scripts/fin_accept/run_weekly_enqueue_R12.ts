/**
 * Production-facing weekly enqueue for 2026-10-19..2026-10-25.
 * Stages: Profit → (wait) → V6 → (wait) → Dashboard → (wait) → final.
 * Writes stage-scoped job ID files (no overwrite of prior stages) + execution manifest.
 *
 * Targets:
 *   profit    → Wave-B profit target client (SAME_PRODUCTION_DB or proven EPHEMERAL)
 *   v6        → V6 read-model target client
 *   dashboard → canonical @/lib/prisma (DATABASE_URL)
 *
 * Unsupported: split targets without identity proof — reject before mutate when
 * WEEKLY_REQUIRE_SAME_TARGETS=1 (default for entrypoint).
 *
 *   DATABASE_URL=... WEEKLY_STAGE=profit|v6|dashboard|all \
 *     node --import tsx scripts/fin_accept/run_weekly_enqueue_R12.ts [out.json]
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { ensureClosedWeekProfitJobMatrix } from "@/lib/profitReadModel/ensureClosedWeekProfitJobMatrix";
import { createPrismaProfitReadModelRepository } from "@/lib/profitReadModel/repository";
import { CANONICAL_PROFIT_COMPANY_SCOPES } from "@/lib/profitReadModel/canonicalScopes";
import { buildDashboardPeriodSnapshotJobId } from "@/lib/dashboard/v6PeriodReadModel/jobIdentity";
import {
  FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
  FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
} from "@/lib/profitReadModel/contract";
import {
  resolveWaveBTargetDbMode,
  createWaveBProfitTargetPrismaClient,
  sameDatabaseIdentity,
} from "@/lib/profitReadModel/targetClient";
import {
  createV6ReadModelTargetPrismaClient,
  disconnectV6ReadModelTargetPrismaClient,
} from "@/lib/dashboard/v6PeriodReadModel/targetClient";

const dateFrom = process.env.DATE_FROM || "2026-10-19";
const dateTo = process.env.DATE_TO || "2026-10-25";
const stage = (process.env.WEEKLY_STAGE || "all").toLowerCase();
const outPath = process.argv[2] || "R16_weekly_enqueue_live.json";
const idsDir =
  process.env.WEEKLY_JOB_IDS_DIR ||
  path.dirname(process.env.WEEKLY_JOB_IDS_FILE || path.resolve("R16_weekly_ids"));
const requireSame =
  (process.env.WEEKLY_REQUIRE_SAME_TARGETS || "1") === "1";

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
  dbTargetMode: string;
};

function proveTargetsOrDie() {
  const db = process.env.DATABASE_URL!.trim();
  const profit = (process.env.WAVE_B_PROFIT_TARGET_DATABASE_URL || db).trim();
  const v6 = (process.env.V6_READMODEL_TARGET_DATABASE_URL || db).trim();
  const profitSame = sameDatabaseIdentity(profit, db);
  const v6Same = sameDatabaseIdentity(v6, db);
  const waveMode = resolveWaveBTargetDbMode();
  const report = {
    waveBTargetDbMode: waveMode,
    profitSameAsDatabaseUrl: profitSame,
    v6SameAsDatabaseUrl: v6Same,
    requireSame,
  };
  if (requireSame && (!profitSame || !v6Same)) {
    console.error(
      JSON.stringify({
        error: "WEEKLY_ENQUEUE_UNSUPPORTED_SPLIT_TARGETS",
        ...report,
        note: "Set WEEKLY_REQUIRE_SAME_TARGETS=0 only with dedicated stage runners that poll the real target",
      }),
    );
    process.exit(5);
  }
  if (waveMode === "EPHEMERAL_SEPARATE_DB" && requireSame) {
    console.error(
      JSON.stringify({
        error: "WEEKLY_ENQUEUE_EPHEMERAL_REQUIRES_EXPLICIT_SPLIT_RUNNERS",
        ...report,
      }),
    );
    process.exit(5);
  }
  return report;
}

async function enqueueFormula(
  formulaVersion: string,
  client: typeof prisma,
  dbTargetMode: string,
): Promise<EnqueueRow[]> {
  const repository = createPrismaProfitReadModelRepository(client);
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
      dbTargetMode,
    });
  }
  return rows;
}

function writeStageIds(stageName: string, ids: string[]) {
  fs.mkdirSync(idsDir, { recursive: true });
  const stagePath = path.join(idsDir, `weekly_ids_${stageName}.txt`);
  fs.writeFileSync(stagePath, ids.join("\n") + (ids.length ? "\n" : ""));
  // Convenience pointer for wait script (current stage only)
  const pointer = process.env.WEEKLY_JOB_IDS_FILE;
  if (pointer) {
    fs.mkdirSync(path.dirname(pointer), { recursive: true });
    fs.writeFileSync(pointer, ids.join("\n") + (ids.length ? "\n" : ""));
  }
  return stagePath;
}

async function main() {
  const targetProof = proveTargetsOrDie();
  const out: Record<string, unknown> = {
    dateFrom,
    dateTo,
    stage,
    writeScope: "DashboardPeriodSnapshotJob only",
    targetProof,
    generatedAt: new Date().toISOString(),
  };
  const stageIds: Record<string, string[]> = {};

  if (stage === "profit" || stage === "all") {
    const profitClient = createWaveBProfitTargetPrismaClient();
    const mode = resolveWaveBTargetDbMode();
    const profit = await ensureClosedWeekProfitJobMatrix({
      prisma: profitClient,
      dateFrom,
      dateTo,
      priority: 40,
    });
    out.profit = profit.enqueued;
    const ids = profit.enqueued.map((e) => e.jobId);
    stageIds.profit = ids;
    writeStageIds("profit", ids);
    const formulas = new Set(profit.enqueued.map((e) => e.formulaVersion));
    if (
      !formulas.has(FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1) ||
      !formulas.has(FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1)
    ) {
      throw new Error("profit matrix missing WB/OZON formulas");
    }
    out.profitTargetMode = mode;
  }

  if (stage === "v6" || stage === "all") {
    const v6Client = createV6ReadModelTargetPrismaClient();
    const v6 = await enqueueFormula(
      "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2",
      v6Client as never,
      process.env.V6_READMODEL_TARGET_DATABASE_URL
        ? "V6_READMODEL_TARGET_DATABASE_URL"
        : "DATABASE_URL",
    );
    out.v6 = v6;
    const ids = v6.map((e) => e.jobId);
    stageIds.v6 = ids;
    writeStageIds("v6", ids);
  }

  if (stage === "dashboard" || stage === "all") {
    const dash = await enqueueFormula(
      "FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1",
      prisma,
      "DATABASE_URL",
    );
    out.dashboard = dash;
    const ids = dash.map((e) => e.jobId);
    stageIds.dashboard = ids;
    writeStageIds("dashboard", ids);
  }

  // Combined manifest (append-safe): all known stage id files
  const allIds: string[] = [];
  for (const s of ["profit", "v6", "dashboard"] as const) {
    const p = path.join(idsDir, `weekly_ids_${s}.txt`);
    if (fs.existsSync(p)) {
      for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
        if (line.trim()) allIds.push(line.trim());
      }
    } else if (stageIds[s]) {
      allIds.push(...stageIds[s]);
    }
  }
  out.stageIds = stageIds;
  out.jobIds = allIds;
  out.jobCount = allIds.length;
  out.idsDir = idsDir;
  const manifestPath = path.join(idsDir, "weekly_execution_manifest.json");
  fs.mkdirSync(idsDir, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(out, null, 2) + "\n");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
  console.log("WEEKLY_ENQUEUE_LIVE_R16_OK");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await disconnectV6ReadModelTargetPrismaClient();
  });
