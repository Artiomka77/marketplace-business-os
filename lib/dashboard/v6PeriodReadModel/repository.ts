import {
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
  type DailyCompanyMarketplaceMetricsPayload,
  type PeriodCompanyMarketplaceMetricsPayload,
  type ReadinessFinalityMeta,
  type V6CoverageStatus,
  type V6DataMode,
  type V6MarketplaceScope,
} from "./contract";
import { resolveD1D5CorrectedBuildEligibility } from "./d1d5Eligibility";
import { buildDashboardPeriodSnapshotJobId } from "./jobIdentity";
import {
  decideV6JobRebuild,
  v6JobReopenClaimableUpdate,
} from "./queueLifecycle";
import { assertTrustedV2PeriodPersist } from "./v2SafetyAttestation";

export type StoredDailyMetric = {
  companyScope: string;
  marketplace: V6MarketplaceScope;
  businessDate: string;
  formulaVersion: string;
  dataMode: V6DataMode;
  coverageStatus: V6CoverageStatus;
  sourceFingerprint: string;
  payloadChecksum: string;
  payload: DailyCompanyMarketplaceMetricsPayload;
  generatedAt: string;
};

export type StoredPeriodMetric = {
  companyScope: string;
  marketplace: V6MarketplaceScope;
  dateFrom: string;
  dateTo: string;
  formulaVersion: string;
  dataMode: V6DataMode;
  coverageStatus: V6CoverageStatus;
  sourceFingerprint: string;
  payloadChecksum: string;
  payload: PeriodCompanyMarketplaceMetricsPayload;
  meta: ReadinessFinalityMeta;
  generatedAt: string;
};

export type V6PeriodReadModelRepository = {
  upsertPeriod(row: StoredPeriodMetric): Promise<void>;
  upsertDaily(row: StoredDailyMetric): Promise<void>;
  findPeriod(params: {
    companyScope: string;
    marketplace: V6MarketplaceScope;
    dateFrom: string;
    dateTo: string;
    formulaVersion?: string;
  }): Promise<StoredPeriodMetric | null>;
  findDailyRange(params: {
    companyScope: string;
    marketplace: V6MarketplaceScope;
    dateFrom: string;
    dateTo: string;
    formulaVersion?: string;
  }): Promise<StoredDailyMetric[]>;
  listPeriodCompanyScopes(params: {
    dateFrom: string;
    dateTo: string;
    formulaVersion?: string;
  }): Promise<string[]>;
  requestRebuild?(params: {
    companyScope: string;
    dateFrom: string;
    dateTo: string;
    priority?: number;
  }): Promise<"queued_local" | "queued_prisma" | "noop" | "rejected_d6_unsafe">;
};

function periodKey(row: {
  companyScope: string;
  marketplace: string;
  dateFrom: string;
  dateTo: string;
  formulaVersion: string;
}) {
  return [
    row.companyScope,
    row.marketplace,
    row.dateFrom.slice(0, 10),
    row.dateTo.slice(0, 10),
    row.formulaVersion,
  ].join("|");
}

function dailyKey(row: {
  companyScope: string;
  marketplace: string;
  businessDate: string;
  formulaVersion: string;
}) {
  return [
    row.companyScope,
    row.marketplace,
    row.businessDate.slice(0, 10),
    row.formulaVersion,
  ].join("|");
}

/** In-memory / ephemeral test target — never production DB. */
export function createMemoryV6PeriodReadModelRepository(): V6PeriodReadModelRepository {
  const periods = new Map<string, StoredPeriodMetric>();
  const dailies = new Map<string, StoredDailyMetric>();
  const rebuildQueue: Array<{
    companyScope: string;
    dateFrom: string;
    dateTo: string;
    priority: number;
  }> = [];

  return {
    async upsertPeriod(row) {
      assertTrustedV2PeriodPersist(row);
      periods.set(periodKey(row), structuredClone(row));
    },
    async upsertDaily(row) {
      dailies.set(dailyKey(row), structuredClone(row));
    },
    async findPeriod(params) {
      const formulaVersion =
        params.formulaVersion ?? FINANCIAL_CORE_V6_PERIOD_READMODEL_V2;
      return (
        periods.get(
          periodKey({
            companyScope: params.companyScope,
            marketplace: params.marketplace,
            dateFrom: params.dateFrom,
            dateTo: params.dateTo,
            formulaVersion,
          })
        ) ?? null
      );
    },
    async findDailyRange(params) {
      const formulaVersion =
        params.formulaVersion ?? FINANCIAL_CORE_V6_PERIOD_READMODEL_V2;
      const from = params.dateFrom.slice(0, 10);
      const to = params.dateTo.slice(0, 10);
      return [...dailies.values()]
        .filter(
          (row) =>
            row.companyScope === params.companyScope &&
            row.marketplace === params.marketplace &&
            row.formulaVersion === formulaVersion &&
            row.businessDate.slice(0, 10) >= from &&
            row.businessDate.slice(0, 10) <= to
        )
        .sort((a, b) => a.businessDate.localeCompare(b.businessDate))
        .map((row) => structuredClone(row));
    },
    async listPeriodCompanyScopes(params) {
      const formulaVersion =
        params.formulaVersion ?? FINANCIAL_CORE_V6_PERIOD_READMODEL_V2;
      const from = params.dateFrom.slice(0, 10);
      const to = params.dateTo.slice(0, 10);
      return [
        ...new Set(
          [...periods.values()]
            .filter(
              (row) =>
                row.formulaVersion === formulaVersion &&
                row.dateFrom.slice(0, 10) === from &&
                row.dateTo.slice(0, 10) === to &&
                row.companyScope !== "ALL"
            )
            .map((row) => row.companyScope)
        ),
      ].sort();
    },
    async requestRebuild(params) {
      rebuildQueue.push({
        companyScope: params.companyScope,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        priority: params.priority ?? 100,
      });
      return "queued_local";
    },
  };
}

export type PrismaLikeV6Client = {
  periodCompanyMarketplaceMetric: {
    upsert: (args: unknown) => Promise<unknown>;
    findUnique: (args: unknown) => Promise<unknown>;
    findMany: (args: unknown) => Promise<unknown[]>;
  };
  dailyCompanyMarketplaceMetric: {
    upsert: (args: unknown) => Promise<unknown>;
    findMany: (args: unknown) => Promise<unknown[]>;
  };
  dashboardPeriodSnapshotJob?: {
    upsert: (args: unknown) => Promise<unknown>;
    findFirst?: (args: unknown) => Promise<unknown>;
    updateMany?: (args: unknown) => Promise<{ count: number }>;
    create?: (args: unknown) => Promise<unknown>;
  };
};

export type V6JobWriteRow = {
  id: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lockedAt?: Date | string | null;
  lockedBy?: string | null;
  startedAt?: Date | string | null;
  finishedAt?: Date | string | null;
  nextAttemptAt?: Date | string | null;
  lastError?: string | null;
};

type V6JobWriteClient = NonNullable<PrismaLikeV6Client["dashboardPeriodSnapshotJob"]>;

function isPrismaUniqueConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = "code" in err ? String((err as { code?: unknown }).code || "") : "";
  return code === "P2002";
}

/**
 * Atomic consumer enqueue. SUCCESS reopen is compare-and-set on status=SUCCESS.
 * Stale SUCCESS observations must not clobber PENDING/RUNNING/ERROR.
 */
export async function applyAtomicV6JobRebuildWrite(args: {
  jobs: V6JobWriteClient;
  existing: V6JobWriteRow | null;
  id: string;
  formula: string;
  companyScope: string;
  dateFrom: Date;
  dateTo: Date;
  now: Date;
  priority: number;
  dateFromRaw: string;
  dateToRaw: string;
}): Promise<"queued_prisma"> {
  const decision = decideV6JobRebuild(args.existing);
  if (decision.action === "keep_existing") {
    return "queued_prisma";
  }

  const createData = {
    id: args.id,
    companyScope: args.companyScope,
    dateFrom: args.dateFrom,
    dateTo: args.dateTo,
    formulaVersion: args.formula,
    status: "PENDING" as const,
    priority: args.priority,
    attempts: 0,
    maxAttempts: 5,
    lockedAt: null,
    lockedBy: null,
    nextAttemptAt: args.now,
    startedAt: null,
    finishedAt: null,
    lastError: null,
    createdAt: args.now,
    updatedAt: args.now,
  };

  if (decision.action === "reopen_success") {
    if (!args.jobs.updateMany) {
      return "queued_prisma";
    }
    const result = await args.jobs.updateMany({
      where: { id: args.id, status: "SUCCESS" },
      data: v6JobReopenClaimableUpdate(args.now, args.priority),
    });
    if (Number(result?.count || 0) === 1) {
      return "queued_prisma";
    }
    const current = args.jobs.findFirst
      ? await args.jobs.findFirst({
          where: {
            companyScope: args.companyScope,
            dateFrom: args.dateFrom,
            dateTo: args.dateTo,
            formulaVersion: args.formula,
          },
        })
      : null;
    if (current) {
      return "queued_prisma";
    }
  }

  if (typeof args.jobs.create === "function") {
    try {
      await args.jobs.create({ data: createData });
    } catch (err) {
      if (isPrismaUniqueConflict(err)) {
        return "queued_prisma";
      }
      throw err;
    }
    return "queued_prisma";
  }

  await args.jobs.upsert({
    where: {
      companyScope_dateFrom_dateTo_formulaVersion: {
        companyScope: args.companyScope,
        dateFrom: args.dateFrom,
        dateTo: args.dateTo,
        formulaVersion: args.formula,
      },
    },
    create: createData,
    update: {},
  });
  return "queued_prisma";
}

/**
 * Prisma-backed repository for candidate/ephemeral DB only.
 * Wave A must not point this at production without owner deploy gate + migration.
 */
export function createPrismaV6PeriodReadModelRepository(
  prisma: PrismaLikeV6Client
): V6PeriodReadModelRepository {
  const formula = FINANCIAL_CORE_V6_PERIOD_READMODEL_V2;

  return {
    async upsertPeriod(row) {
      assertTrustedV2PeriodPersist(row);
      const dateFrom = new Date(`${row.dateFrom.slice(0, 10)}T00:00:00.000Z`);
      const dateTo = new Date(`${row.dateTo.slice(0, 10)}T00:00:00.000Z`);
      await prisma.periodCompanyMarketplaceMetric.upsert({
        where: {
          companyScope_marketplace_dateFrom_dateTo_formulaVersion: {
            companyScope: row.companyScope,
            marketplace: row.marketplace,
            dateFrom,
            dateTo,
            formulaVersion: row.formulaVersion,
          },
        },
        create: {
          companyScope: row.companyScope,
          marketplace: row.marketplace,
          dateFrom,
          dateTo,
          formulaVersion: row.formulaVersion,
          dataMode: row.dataMode,
          coverageStatus: row.coverageStatus,
          sourceFingerprint: row.sourceFingerprint,
          payloadChecksum: row.payloadChecksum,
          payload: row.payload,
          meta: row.meta,
          generatedAt: new Date(row.generatedAt),
        },
        update: {
          dataMode: row.dataMode,
          coverageStatus: row.coverageStatus,
          sourceFingerprint: row.sourceFingerprint,
          payloadChecksum: row.payloadChecksum,
          payload: row.payload,
          meta: row.meta,
          generatedAt: new Date(row.generatedAt),
        },
      });
    },
    async upsertDaily(row) {
      const businessDate = new Date(
        `${row.businessDate.slice(0, 10)}T00:00:00.000Z`
      );
      await prisma.dailyCompanyMarketplaceMetric.upsert({
        where: {
          companyScope_marketplace_businessDate_formulaVersion: {
            companyScope: row.companyScope,
            marketplace: row.marketplace,
            businessDate,
            formulaVersion: row.formulaVersion,
          },
        },
        create: {
          companyScope: row.companyScope,
          marketplace: row.marketplace,
          businessDate,
          formulaVersion: row.formulaVersion,
          dataMode: row.dataMode,
          coverageStatus: row.coverageStatus,
          sourceFingerprint: row.sourceFingerprint,
          payloadChecksum: row.payloadChecksum,
          payload: row.payload,
          generatedAt: new Date(row.generatedAt),
        },
        update: {
          dataMode: row.dataMode,
          coverageStatus: row.coverageStatus,
          sourceFingerprint: row.sourceFingerprint,
          payloadChecksum: row.payloadChecksum,
          payload: row.payload,
          generatedAt: new Date(row.generatedAt),
        },
      });
    },
    async findPeriod(params) {
      const formulaVersion = params.formulaVersion ?? formula;
      const row = (await prisma.periodCompanyMarketplaceMetric.findUnique({
        where: {
          companyScope_marketplace_dateFrom_dateTo_formulaVersion: {
            companyScope: params.companyScope,
            marketplace: params.marketplace,
            dateFrom: new Date(`${params.dateFrom.slice(0, 10)}T00:00:00.000Z`),
            dateTo: new Date(`${params.dateTo.slice(0, 10)}T00:00:00.000Z`),
            formulaVersion,
          },
        },
      })) as StoredPeriodMetric | null;
      if (!row) return null;
      return {
        ...row,
        dateFrom: params.dateFrom.slice(0, 10),
        dateTo: params.dateTo.slice(0, 10),
        generatedAt:
          typeof row.generatedAt === "string"
            ? row.generatedAt
            : new Date(row.generatedAt as unknown as string).toISOString(),
      };
    },
    async findDailyRange(params) {
      const formulaVersion = params.formulaVersion ?? formula;
      const rows = (await prisma.dailyCompanyMarketplaceMetric.findMany({
        where: {
          companyScope: params.companyScope,
          marketplace: params.marketplace,
          formulaVersion,
          businessDate: {
            gte: new Date(`${params.dateFrom.slice(0, 10)}T00:00:00.000Z`),
            lte: new Date(`${params.dateTo.slice(0, 10)}T00:00:00.000Z`),
          },
        },
        orderBy: { businessDate: "asc" },
      })) as Array<StoredDailyMetric & { businessDate: Date | string }>;
      return rows.map((row) => ({
        ...row,
        businessDate:
          typeof row.businessDate === "string"
            ? row.businessDate.slice(0, 10)
            : new Date(row.businessDate as Date).toISOString().slice(0, 10),
        generatedAt:
          typeof row.generatedAt === "string"
            ? row.generatedAt
            : new Date(String(row.generatedAt)).toISOString(),
      }));
    },
    async listPeriodCompanyScopes(params) {
      const formulaVersion = params.formulaVersion ?? formula;
      const rows = (await prisma.periodCompanyMarketplaceMetric.findMany({
        where: {
          marketplace: "ALL",
          formulaVersion,
          dateFrom: new Date(`${params.dateFrom.slice(0, 10)}T00:00:00.000Z`),
          dateTo: new Date(`${params.dateTo.slice(0, 10)}T00:00:00.000Z`),
          NOT: { companyScope: "ALL" },
        },
        select: { companyScope: true },
      })) as Array<{ companyScope: string }>;
      return [...new Set(rows.map((row) => row.companyScope))].sort();
    },
    async requestRebuild(params) {
      // Cheap enqueue only — no Financial Core. Reuses DashboardPeriodSnapshotJob
      // with V6 formulaVersion so the V4 snapshot worker cannot claim these rows.
      if (!prisma.dashboardPeriodSnapshotJob?.upsert) {
        return "noop";
      }
      const eligibility = await resolveD1D5CorrectedBuildEligibility({
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        companyName: params.companyScope === "ALL" ? null : params.companyScope,
      });
      if (!eligibility.eligible) {
        return "rejected_d6_unsafe";
      }
      const dateFrom = new Date(`${params.dateFrom.slice(0, 10)}T00:00:00.000Z`);
      const dateTo = new Date(`${params.dateTo.slice(0, 10)}T00:00:00.000Z`);
      const now = new Date();
      const companyScope = params.companyScope || "ALL";
      const priority = params.priority ?? 100;
      const existing = prisma.dashboardPeriodSnapshotJob.findFirst
        ? ((await prisma.dashboardPeriodSnapshotJob.findFirst({
            where: {
              companyScope,
              dateFrom,
              dateTo,
              formulaVersion: formula,
            },
          })) as V6JobWriteRow | null)
        : null;
      return applyAtomicV6JobRebuildWrite({
        jobs: prisma.dashboardPeriodSnapshotJob,
        existing,
        id: buildDashboardPeriodSnapshotJobId({
          formulaVersion: formula,
          companyScope,
          dateFrom: params.dateFrom,
          dateTo: params.dateTo,
        }),
        formula,
        companyScope,
        dateFrom,
        dateTo,
        now,
        priority,
        dateFromRaw: params.dateFrom,
        dateToRaw: params.dateTo,
      });
    },
  };
}
