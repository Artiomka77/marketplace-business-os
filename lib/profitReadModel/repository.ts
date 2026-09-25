import { Prisma, type PrismaClient } from "@prisma/client";
import {
  type ProfitCoverageStatus,
  type ProfitDataMode,
  type ProfitMarketplace,
  type ProfitPeriodMeta,
  type WaveBProfitFormulaVersion,
  formulaForMarketplace,
} from "./contract";
import { isoDateOnly } from "./fingerprint";
import {
  applyAtomicV6JobRebuildWrite,
  buildDashboardPeriodSnapshotJobId,
  decideV6JobRebuild,
} from "./queueLifecycle";

export type ProfitPeriodRow = {
  companyScope: string;
  marketplace: string;
  dateFrom: Date;
  dateTo: Date;
  formulaVersion: string;
  dataMode: string;
  coverageStatus: string;
  sourceFingerprint: string;
  payloadChecksum: string;
  totals: unknown;
  comparison: unknown;
  meta: unknown;
  analyticsPayload: unknown;
  generatedAt: Date;
  staleAfterMs: number | null;
};

export type ProfitSkuRow = {
  companyScope: string;
  marketplace: string;
  dateFrom: Date;
  dateTo: Date;
  formulaVersion: string;
  productKey: string;
  payload: unknown;
  generatedAt: Date;
};

export type ProfitEnqueueResult = {
  id: string;
  created: boolean;
  action: "create" | "keep_existing" | "reopen_success";
};

export type ProfitReadModelRepository = {
  findPeriod(params: {
    companyScope: string;
    marketplace: ProfitMarketplace;
    dateFrom: string;
    dateTo: string;
    formulaVersion: WaveBProfitFormulaVersion;
  }): Promise<ProfitPeriodRow | null>;
  replacePeriod(params: {
    period: Omit<ProfitPeriodRow, "generatedAt"> & { generatedAt?: Date };
    skus: Array<Omit<ProfitSkuRow, "generatedAt"> & { generatedAt?: Date }>;
  }): Promise<void>;
  countSkus(params: {
    companyScope: string;
    marketplace: ProfitMarketplace;
    dateFrom: string;
    dateTo: string;
    formulaVersion: WaveBProfitFormulaVersion;
  }): Promise<number>;
  enqueueRebuild(params: {
    companyScope: string;
    dateFrom: string;
    dateTo: string;
    formulaVersion: WaveBProfitFormulaVersion;
    priority?: number;
  }): Promise<ProfitEnqueueResult>;
};

function dateOnly(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

export function createPrismaProfitReadModelRepository(
  prisma: PrismaClient
): ProfitReadModelRepository {
  return {
    async findPeriod(params) {
      const row = await prisma.profitPeriodMetric.findUnique({
        where: {
          companyScope_marketplace_dateFrom_dateTo_formulaVersion: {
            companyScope: params.companyScope,
            marketplace: params.marketplace,
            dateFrom: dateOnly(params.dateFrom),
            dateTo: dateOnly(params.dateTo),
            formulaVersion: params.formulaVersion,
          },
        },
      });
      return row as ProfitPeriodRow | null;
    },

    async replacePeriod({ period, skus }) {
      const generatedAt = period.generatedAt ?? new Date();
      await prisma.$transaction(async (tx) => {
        await tx.profitSkuPeriodMetric.deleteMany({
          where: {
            companyScope: period.companyScope,
            marketplace: period.marketplace,
            dateFrom: period.dateFrom,
            dateTo: period.dateTo,
            formulaVersion: period.formulaVersion,
          },
        });
        await tx.profitPeriodMetric.upsert({
          where: {
            companyScope_marketplace_dateFrom_dateTo_formulaVersion: {
              companyScope: period.companyScope,
              marketplace: period.marketplace,
              dateFrom: period.dateFrom,
              dateTo: period.dateTo,
              formulaVersion: period.formulaVersion,
            },
          },
          create: {
            ...period,
            generatedAt,
            totals: period.totals as Prisma.InputJsonValue,
            comparison:
              period.comparison == null
                ? Prisma.DbNull
                : (period.comparison as Prisma.InputJsonValue),
            meta: period.meta as Prisma.InputJsonValue,
            analyticsPayload: period.analyticsPayload as Prisma.InputJsonValue,
          },
          update: {
            dataMode: period.dataMode,
            coverageStatus: period.coverageStatus,
            sourceFingerprint: period.sourceFingerprint,
            payloadChecksum: period.payloadChecksum,
            totals: period.totals as Prisma.InputJsonValue,
            comparison:
              period.comparison == null
                ? Prisma.DbNull
                : (period.comparison as Prisma.InputJsonValue),
            meta: period.meta as Prisma.InputJsonValue,
            analyticsPayload: period.analyticsPayload as Prisma.InputJsonValue,
            generatedAt,
            staleAfterMs: period.staleAfterMs,
          },
        });
        if (skus.length > 0) {
          await tx.profitSkuPeriodMetric.createMany({
            data: skus.map(
              (s: Omit<ProfitSkuRow, "generatedAt"> & { generatedAt?: Date }) => ({
                ...s,
                generatedAt: s.generatedAt ?? generatedAt,
                payload: s.payload as Prisma.InputJsonValue,
              })
            ),
          });
        }
      });
    },

    async countSkus(params) {
      return prisma.profitSkuPeriodMetric.count({
        where: {
          companyScope: params.companyScope,
          marketplace: params.marketplace,
          dateFrom: dateOnly(params.dateFrom),
          dateTo: dateOnly(params.dateTo),
          formulaVersion: params.formulaVersion,
        },
      });
    },

    async enqueueRebuild(params) {
      const dateFrom = dateOnly(params.dateFrom);
      const dateTo = dateOnly(params.dateTo);
      const priority = params.priority ?? 50;
      const now = new Date();
      const id = buildDashboardPeriodSnapshotJobId({
        formulaVersion: params.formulaVersion,
        companyScope: params.companyScope,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
      });

      const existing = await prisma.dashboardPeriodSnapshotJob.findUnique({
        where: {
          companyScope_dateFrom_dateTo_formulaVersion: {
            companyScope: params.companyScope,
            dateFrom,
            dateTo,
            formulaVersion: params.formulaVersion,
          },
        },
      });

      const decision = decideV6JobRebuild(existing);
      if (!existing && decision.action === "create") {
        // fall through to atomic write
      }

      await applyAtomicV6JobRebuildWrite({
        jobs: prisma.dashboardPeriodSnapshotJob as unknown as Parameters<
          typeof applyAtomicV6JobRebuildWrite
        >[0]["jobs"],
        existing: existing
          ? {
              id: existing.id,
              status: existing.status,
              attempts: existing.attempts,
              maxAttempts: existing.maxAttempts,
              lockedAt: existing.lockedAt,
              lockedBy: existing.lockedBy,
              startedAt: existing.startedAt,
              finishedAt: existing.finishedAt,
              nextAttemptAt: existing.nextAttemptAt,
              lastError: existing.lastError,
            }
          : null,
        id: existing?.id ?? id,
        formula: params.formulaVersion,
        companyScope: params.companyScope,
        dateFrom,
        dateTo,
        now,
        priority,
        dateFromRaw: params.dateFrom,
        dateToRaw: params.dateTo,
      });

      return {
        id: existing?.id ?? id,
        created: decision.action === "create",
        action: decision.action,
      };
    },
  };
}

export function asMeta(row: ProfitPeriodRow): ProfitPeriodMeta {
  return row.meta as ProfitPeriodMeta;
}

export function periodKeyParts(params: {
  companyScope: string;
  marketplace: ProfitMarketplace;
  dateFrom: string;
  dateTo: string;
}) {
  const formulaVersion = formulaForMarketplace(params.marketplace);
  return {
    companyScope: params.companyScope,
    marketplace: params.marketplace,
    dateFrom: isoDateOnly(params.dateFrom),
    dateTo: isoDateOnly(params.dateTo),
    formulaVersion,
  };
}

export type { ProfitCoverageStatus, ProfitDataMode };
