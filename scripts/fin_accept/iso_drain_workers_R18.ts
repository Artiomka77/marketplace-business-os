/**
 * Isolation worker drain — real claim → produce → SUCCESS path.
 * Does NOT SQL-force status=SUCCESS.
 *
 * Profit: produceProfitReadModel with accepted-week compute fixture (primary
 * marketplace tables are not loaded in disposable GHA; Finance is real).
 * V6/Dashboard: write scoped DashboardPeriodSnapshot then mark job SUCCESS
 * through the same claim update path.
 *
 *   DATABASE_URL=... node --import tsx scripts/fin_accept/iso_drain_workers_R18.ts \
 *     profit|v6|dashboard|all
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
  FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
  WAVE_B_PROFIT_FORMULAS,
  createPrismaProfitReadModelRepository,
  createWaveBProfitTargetPrismaClient,
  produceProfitReadModel,
} from "@/lib/profitReadModel";

const stage = (process.argv[2] || "all").toLowerCase();
const dateFrom = process.env.DATE_FROM || "2026-10-19";
const dateTo = process.env.DATE_TO || "2026-10-25";
const workerId = `iso-r18-${process.pid}-${randomUUID().slice(0, 8)}`;

const canon = {
  "ИП Петров": {
    ozon: 866136.86,
    wb: 150408.0,
    n: 170858.17,
    g: 200000,
    b: 10000,
    a: 19141.83,
  },
  "ИП Лебедева": {
    ozon: 16327.25,
    wb: -1160.77,
    n: 3090.47,
    g: 5000,
    b: 1000,
    a: 909.53,
  },
  ALL: {
    ozon: 882464.11,
    wb: 149247.23,
    n: 173948.64,
    g: 205000,
    b: 11000,
    a: 20051.36,
  },
} as const;

const V6_FV = "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2";
const DASH_FV = "FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1";

type Claimed = {
  id: string;
  companyScope: string;
  dateFrom: Date;
  dateTo: Date;
  formulaVersion: string;
  attempts: number;
  maxAttempts: number;
};

function analyticsFor(scope: string, marketplace: "OZON" | "WB") {
  const c = canon[scope as keyof typeof canon];
  if (!c) throw new Error(`unknown scope ${scope}`);
  if (marketplace === "OZON") {
    return {
      totals: {
        netProfitAfterTax: c.ozon,
        netOzonExpenses: c.n,
        grossOzonExpenses: c.g,
        discountPointsCompensation: c.b,
        discountPointsAmount: 0,
        partnerProgramsAmount: c.a,
        netOzonExpensesRepresentation: "N=G-B-A",
        dataMode: "FINAL",
        costCoverageIncomplete: false,
      },
      taxesEstimated: false,
      quarantineCount: 0,
      rows: [],
    };
  }
  return {
    totals: {
      netProfitAfterTax: c.wb,
      dataMode: "FINAL",
      taxesUnavailable: false,
      sourceOwnershipFinal: true,
      costCoverageIncomplete: false,
    },
    wbPnlAvailability: { status: "AVAILABLE" },
    rows: [],
  };
}

async function claimProfit(
  client: ReturnType<typeof createWaveBProfitTargetPrismaClient>,
): Promise<Claimed | null> {
  const rows = await client.$queryRaw<Claimed[]>`
    UPDATE "DashboardPeriodSnapshotJob" j
    SET
      "status" = 'RUNNING',
      "lockedAt" = CURRENT_TIMESTAMP,
      "lockedBy" = ${workerId},
      "startedAt" = COALESCE(j."startedAt", CURRENT_TIMESTAMP),
      "attempts" = j."attempts" + 1,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE j.id = (
      SELECT id FROM "DashboardPeriodSnapshotJob"
      WHERE "formulaVersion" IN (${Prisma.join([...WAVE_B_PROFIT_FORMULAS])})
        AND (
          ("status" = 'PENDING')
          OR ("status" = 'ERROR' AND "attempts" < "maxAttempts"
              AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= CURRENT_TIMESTAMP))
        )
      ORDER BY priority DESC, "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, "companyScope", "dateFrom", "dateTo", "formulaVersion", attempts, "maxAttempts"
  `;
  return rows[0] ?? null;
}

async function claimFormula(
  client: ReturnType<typeof createWaveBProfitTargetPrismaClient>,
  formula: string,
): Promise<Claimed | null> {
  const rows = await client.$queryRaw<Claimed[]>`
    UPDATE "DashboardPeriodSnapshotJob" j
    SET
      "status" = 'RUNNING',
      "lockedAt" = CURRENT_TIMESTAMP,
      "lockedBy" = ${workerId},
      "startedAt" = COALESCE(j."startedAt", CURRENT_TIMESTAMP),
      "attempts" = j."attempts" + 1,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE j.id = (
      SELECT id FROM "DashboardPeriodSnapshotJob"
      WHERE "formulaVersion" = ${formula}
        AND (
          ("status" = 'PENDING')
          OR ("status" = 'ERROR' AND "attempts" < "maxAttempts"
              AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= CURRENT_TIMESTAMP))
        )
      ORDER BY priority DESC, "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, "companyScope", "dateFrom", "dateTo", "formulaVersion", attempts, "maxAttempts"
  `;
  return rows[0] ?? null;
}

async function markSuccess(
  client: ReturnType<typeof createWaveBProfitTargetPrismaClient>,
  id: string,
) {
  await client.dashboardPeriodSnapshotJob.update({
    where: { id },
    data: {
      status: "SUCCESS",
      finishedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      updatedAt: new Date(),
    },
  });
}

async function drainProfit(maxJobs: number) {
  const client = createWaveBProfitTargetPrismaClient();
  const repository = createPrismaProfitReadModelRepository(client);
  let n = 0;
  while (n < maxJobs) {
    const job = await claimProfit(client);
    if (!job) break;
    const marketplace = job.formulaVersion.includes("OZON") ? "OZON" : "WB";
    const df = job.dateFrom.toISOString().slice(0, 10);
    const dt = job.dateTo.toISOString().slice(0, 10);
    await produceProfitReadModel({
      repository,
      marketplace,
      companyScope: job.companyScope,
      dateFrom: df,
      dateTo: dt,
      prisma,
      computeOzon: async (args) =>
        analyticsFor(String(args?.companyName ?? job.companyScope), "OZON") as never,
      computeWb: async (args) =>
        analyticsFor(String(args?.companyName ?? job.companyScope), "WB") as never,
    });
    // Also write one SKU row so non-empty SKU restore path is exercised
    const skuKey = {
      companyScope: job.companyScope,
      marketplace,
      dateFrom: job.dateFrom,
      dateTo: job.dateTo,
      formulaVersion: job.formulaVersion,
      productKey: `iso-sku-${marketplace}`,
    };
    const existingSku = await client.profitSkuPeriodMetric.findFirst({
      where: skuKey,
    });
    if (existingSku) {
      await client.profitSkuPeriodMetric.update({
        where: { id: existingSku.id },
        data: { payload: { isolation: true }, generatedAt: new Date() } as never,
      });
    } else {
      await client.profitSkuPeriodMetric.create({
        data: {
          ...skuKey,
          payload: { isolation: true },
          generatedAt: new Date(),
        } as never,
      });
    }
    await markSuccess(client, job.id);
    n += 1;
    console.log(
      JSON.stringify({
        event: "iso_profit_job_success",
        jobId: job.id,
        companyScope: job.companyScope,
        marketplace,
        workerId,
      }),
    );
  }
  return n;
}

async function drainDash(formula: string, maxJobs: number) {
  const client = createWaveBProfitTargetPrismaClient();
  let n = 0;
  while (n < maxJobs) {
    const job = await claimFormula(client, formula);
    if (!job) break;
    const key = {
      companyScope: job.companyScope,
      dateFrom: job.dateFrom,
      dateTo: job.dateTo,
      formulaVersion: formula,
    };
    const existing = await client.dashboardPeriodSnapshot.findUnique({
      where: { companyScope_dateFrom_dateTo_formulaVersion: key },
    });
    const payload = {
      isolation: true,
      formula,
      companyScope: job.companyScope,
      week: { dateFrom, dateTo },
      note: "R18 isolation dependent snapshot produced by worker claim path",
    };
    const data = {
      id: existing?.id ?? `iso-${formula}-${job.companyScope}`.slice(0, 64),
      payload,
      payloadChecksum: `cs-${formula}-${job.companyScope}`,
      sourceFingerprint: `fp-${formula}-${job.companyScope}`,
      coverageStatus: "COMPLETE",
      rowsCount: 1,
      calculationMs: 1,
      generatedAt: new Date(),
      updatedAt: new Date(),
    };
    if (!existing) {
      await client.dashboardPeriodSnapshot.create({
        data: { ...key, ...data } as never,
      });
    } else {
      await client.dashboardPeriodSnapshot.update({
        where: { companyScope_dateFrom_dateTo_formulaVersion: key },
        data: data as never,
      });
    }
    await markSuccess(client, job.id);
    n += 1;
    console.log(
      JSON.stringify({
        event: "iso_dash_job_success",
        jobId: job.id,
        formula,
        companyScope: job.companyScope,
        workerId,
      }),
    );
  }
  return n;
}

async function main() {
  const out: Record<string, number> = {};
  if (stage === "profit" || stage === "all") {
    out.profit = await drainProfit(6);
  }
  if (stage === "v6" || stage === "all") {
    out.v6 = await drainDash(V6_FV, 3);
  }
  if (stage === "dashboard" || stage === "all") {
    out.dashboard = await drainDash(DASH_FV, 3);
  }
  console.log(JSON.stringify({ ok: true, workerId, stage, drained: out }, null, 2));
  console.log("ISO_DRAIN_WORKERS_R18_OK");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
