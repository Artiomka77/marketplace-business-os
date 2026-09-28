/**
 * Wave B Profit read-model invalidation.
 * Deletes overlapping period rows and V2-safe enqueue rebuild.
 * No heavy Financial Core. No exhausted ERROR reset.
 * Bound synchronous enqueues to avoid arbitrary custom-period queue explosion.
 */
import type { PrismaClient } from "@prisma/client";
import { getDefaultLastCompletedWeekRange } from "@/lib/date/defaultPeriod";
import {
  WAVE_B_PROFIT_FORMULAS,
  formulaForMarketplace,
  type ProfitMarketplace,
} from "./contract";
import { createPrismaProfitReadModelRepository } from "./repository";
import { isoDateOnly } from "./fingerprint";
import { expandProfitCompanyScopes } from "./canonicalScopes";

/** Hard bound: never enqueue unbounded arbitrary custom periods in one event. */
export const MAX_SYNCHRONOUS_INVALIDATION_ENQUEUES_PER_EVENT = 12;

type EnqueueTarget = {
  companyScope: string;
  marketplace: ProfitMarketplace;
  dateFrom: string;
  dateTo: string;
  formulaVersion: string;
};

function defaultBoundedEnqueueWindows(params: {
  markets: ProfitMarketplace[];
  scopes: string[];
}): EnqueueTarget[] {
  const week = getDefaultLastCompletedWeekRange();
  const dateFrom = isoDateOnly(week.dateFrom);
  const dateTo = isoDateOnly(week.dateTo);
  const out: EnqueueTarget[] = [];
  for (const companyScope of params.scopes) {
    for (const m of params.markets) {
      out.push({
        companyScope,
        marketplace: m,
        dateFrom,
        dateTo,
        formulaVersion: formulaForMarketplace(m),
      });
    }
  }
  return out;
}

export async function invalidateWaveBProfitReadModel(params: {
  prisma: PrismaClient;
  marketplace?: ProfitMarketplace | "BOTH";
  companyScope: string;
  dateFrom?: string;
  dateTo?: string;
  priority?: number;
  /** Optional ProductCost / mutation effective dates for narrowing. */
  affectedDateFrom?: string;
  affectedDateTo?: string;
}): Promise<{
  deletedPeriods: number;
  deletedSkus: number;
  enqueued: Array<{
    formulaVersion: string;
    companyScope: string;
    created: boolean;
    action: string;
  }>;
  enqueueBound: number;
  enqueueMode: "OVERLAPPING_CAPPED" | "DEFAULT_WEEK_BOUNDED" | "NONE";
}> {
  const marketplace = params.marketplace ?? "BOTH";
  const markets: ProfitMarketplace[] =
    marketplace === "BOTH" ? ["WB", "OZON"] : [marketplace];
  const scopes = expandProfitCompanyScopes(params.companyScope);

  const dateFromRaw = params.dateFrom ?? params.affectedDateFrom;
  const dateToRaw = params.dateTo ?? params.affectedDateTo;
  const dateFrom = dateFromRaw ? isoDateOnly(dateFromRaw) : null;
  const dateTo = dateToRaw ? isoDateOnly(dateToRaw) : null;
  const hasExactWindow = Boolean(dateFrom && dateTo);

  const periodWhere = {
    marketplace: { in: markets },
    companyScope: { in: scopes },
    formulaVersion: { in: [...WAVE_B_PROFIT_FORMULAS] },
    ...(hasExactWindow
      ? {
          dateFrom: { lte: new Date(`${dateTo}T00:00:00.000Z`) },
          dateTo: { gte: new Date(`${dateFrom}T00:00:00.000Z`) },
        }
      : {}),
  };

  const overlapping = await params.prisma.profitPeriodMetric.findMany({
    where: periodWhere,
    select: {
      companyScope: true,
      marketplace: true,
      dateFrom: true,
      dateTo: true,
      formulaVersion: true,
    },
  });

  const deletedSkus = await params.prisma.profitSkuPeriodMetric.deleteMany({
    where: periodWhere,
  });
  const deletedPeriods = await params.prisma.profitPeriodMetric.deleteMany({
    where: periodWhere,
  });

  const repository = createPrismaProfitReadModelRepository(params.prisma);
  const enqueued: Array<{
    formulaVersion: string;
    companyScope: string;
    created: boolean;
    action: string;
  }> = [];

  let targets: EnqueueTarget[] = [];
  let enqueueMode: "OVERLAPPING_CAPPED" | "DEFAULT_WEEK_BOUNDED" | "NONE" =
    "NONE";

  if (hasExactWindow && dateFrom && dateTo) {
    // Exact window: enqueue overlapping keys or the provided window, capped.
    targets =
      overlapping.length > 0
        ? overlapping.map((row) => ({
            companyScope: row.companyScope,
            marketplace: row.marketplace as ProfitMarketplace,
            dateFrom: row.dateFrom.toISOString().slice(0, 10),
            dateTo: row.dateTo.toISOString().slice(0, 10),
            formulaVersion: row.formulaVersion,
          }))
        : scopes.flatMap((companyScope) =>
            markets.map((m) => ({
              companyScope,
              marketplace: m,
              dateFrom,
              dateTo,
              formulaVersion: formulaForMarketplace(m),
            }))
          );
    enqueueMode = "OVERLAPPING_CAPPED";
  } else {
    // No exact dates (e.g. ProductCost / tax): delete all affected cached rows
    // fail-closed, but enqueue ONLY a small deterministic default week set.
    // Other deleted periods rebuild lazily on demand.
    targets = defaultBoundedEnqueueWindows({ markets, scopes });
    enqueueMode = "DEFAULT_WEEK_BOUNDED";
  }

  const seen = new Set<string>();
  let enqueueCount = 0;
  for (const t of targets) {
    if (enqueueCount >= MAX_SYNCHRONOUS_INVALIDATION_ENQUEUES_PER_EVENT) break;
    const key = `${t.formulaVersion}|${t.companyScope}|${t.dateFrom}|${t.dateTo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const result = await repository.enqueueRebuild({
      companyScope: t.companyScope,
      dateFrom: t.dateFrom,
      dateTo: t.dateTo,
      formulaVersion: formulaForMarketplace(t.marketplace),
      priority: params.priority ?? 40,
    });
    enqueued.push({
      formulaVersion: formulaForMarketplace(t.marketplace),
      companyScope: t.companyScope,
      created: result.created,
      action: result.action,
    });
    enqueueCount += 1;
  }

  return {
    deletedPeriods: deletedPeriods.count,
    deletedSkus: deletedSkus.count,
    enqueued,
    enqueueBound: MAX_SYNCHRONOUS_INVALIDATION_ENQUEUES_PER_EVENT,
    enqueueMode,
  };
}

/** Fire-and-forget safe wrapper for import/API commit paths. */
export async function safeInvalidateWaveBProfitReadModel(
  params: Parameters<typeof invalidateWaveBProfitReadModel>[0]
): Promise<void> {
  try {
    await invalidateWaveBProfitReadModel(params);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "wave_b_profit_invalidate_failed",
        companyScope: params.companyScope,
        marketplace: params.marketplace ?? "BOTH",
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }
}
