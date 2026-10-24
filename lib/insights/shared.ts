import "server-only";

import {
  getDefaultV6PeriodReadModelRepository,
} from "@/lib/dashboard/v6PeriodReadModel";
import {
  createPrismaProfitReadModelRepository,
  createWaveBProfitTargetPrismaClient,
  formulaForMarketplace,
} from "@/lib/profitReadModel";

export function getAmount(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

/** Sum numeric fields without treating null/missing as 0. */
export function sumNullable(
  rows: Array<Record<string, unknown>>,
  key: string,
): number | null {
  let sum = 0;
  for (const row of rows) {
    const raw = row[key];
    if (raw == null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    sum += n;
  }
  return sum;
}

export function asFiniteNumberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function dayStartUtc(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function marginOrNull(
  revenue: number | null,
  profit: number | null,
): number | null {
  if (revenue == null || profit == null) return null;
  if (!(revenue > 0)) return null;
  return (profit / revenue) * 100;
}

export function normalizeVendorCode(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[‐-‒–—−]/g, "-")
    .replace(/\s+/g, "")
    .trim();
}

export function formatGeneratedAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return null;
  }
}

function monthPartitionForDateTo(dateTo: string): { dateFrom: string; dateTo: string } {
  const [y, m] = dateTo.split("-").map(Number);
  const dateFrom = `${y}-${String(m).padStart(2, "0")}-01`;
  return { dateFrom, dateTo };
}

function isLongJan1Span(dateFrom: string, dateTo: string): boolean {
  if (!/^\d{4}-01-01$/.test(dateFrom)) return false;
  const from = new Date(`${dateFrom}T00:00:00.000Z`).getTime();
  const to = new Date(`${dateTo}T00:00:00.000Z`).getTime();
  return (to - from) / 86_400_000 >= 60;
}

export async function enqueueV6PeriodRebuild(params: {
  dateFrom: string;
  dateTo: string;
  companyScope: string;
}): Promise<{ enqueued: boolean; detail: string }> {
  try {
    const repository = getDefaultV6PeriodReadModelRepository();
    if (!repository.requestRebuild) {
      return { enqueued: false, detail: "NO_REQUEST_REBUILD_API" };
    }
    const scope =
      !params.companyScope || params.companyScope === "ALL"
        ? "ALL"
        : params.companyScope;
    const details: string[] = [];
    let enqueued = false;

    // YTD compose needs the current month partition first (pool-safe path).
    if (isLongJan1Span(params.dateFrom, params.dateTo)) {
      const part = monthPartitionForDateTo(params.dateTo);
      const monthResult = await repository.requestRebuild({
        companyScope: scope,
        dateFrom: part.dateFrom,
        dateTo: part.dateTo,
        priority: 90,
      });
      details.push(`V6_MONTH_${part.dateFrom}_${part.dateTo}:${monthResult}`);
      if (monthResult === "queued_prisma" || monthResult === "queued_local") {
        enqueued = true;
      }
    }

    const result = await repository.requestRebuild({
      companyScope: scope,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      priority: 80,
    });
    details.push(`V6:${result}`);
    if (result === "queued_prisma" || result === "queued_local") {
      enqueued = true;
    }

    // Exhausted ERROR jobs are not reopened by ordinary requestRebuild.
    // Soft-reopen only the YTD partition-compose failure class so Insights can
    // complete MISS→HIT after month partitions land.
    if (result === "keep_existing" && isLongJan1Span(params.dateFrom, params.dateTo)) {
      try {
        const { prisma } = await import("@/lib/prisma");
        const { FINANCIAL_CORE_V6_PERIOD_READMODEL_V2 } = await import(
          "@/lib/dashboard/v6PeriodReadModel"
        );
        const dateFrom = new Date(`${params.dateFrom}T00:00:00.000Z`);
        const dateTo = new Date(`${params.dateTo}T00:00:00.000Z`);
        const existing = await prisma.dashboardPeriodSnapshotJob.findFirst({
          where: {
            companyScope: scope,
            dateFrom,
            dateTo,
            formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
          },
        });
        const err = String(existing?.lastError ?? "");
        if (
          existing &&
          existing.status === "ERROR" &&
          existing.attempts >= existing.maxAttempts &&
          err.includes("YTD_MONTH_PARTITIONS_INCOMPLETE")
        ) {
          const now = new Date();
          await prisma.dashboardPeriodSnapshotJob.update({
            where: { id: existing.id },
            data: {
              status: "PENDING",
              attempts: 0,
              nextAttemptAt: now,
              lockedAt: null,
              lockedBy: null,
              startedAt: null,
              finishedAt: null,
              lastError: null,
              updatedAt: now,
              priority: 80,
            },
          });
          details.push("V6_REOPEN_EXHAUSTED_YTD_COMPOSE");
          enqueued = true;
        }
      } catch (reopenError) {
        details.push(
          `V6_REOPEN_ERR:${reopenError instanceof Error ? reopenError.message : String(reopenError)}`,
        );
      }
    }

    return {
      enqueued,
      detail: details.join("|"),
    };
  } catch (error) {
    return {
      enqueued: false,
      detail: `V6_ENQUEUE_ERR:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function enqueueWaveBProfitRebuild(params: {
  dateFrom: string;
  dateTo: string;
  companyScope: string;
  marketplace: "WB" | "OZON";
}): Promise<{ enqueued: boolean; detail: string }> {
  try {
    const repository = createPrismaProfitReadModelRepository(
      createWaveBProfitTargetPrismaClient(),
    );
    const enq = await repository.enqueueRebuild({
      companyScope:
        !params.companyScope || params.companyScope === "ALL"
          ? "ALL"
          : params.companyScope,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      formulaVersion: formulaForMarketplace(params.marketplace),
      priority: 55,
    });
    const enqueued =
      enq.action === "create" ||
      enq.action === "reopen_success" ||
      enq.action === "keep_existing";
    return {
      enqueued,
      detail: `WAVE_B_${params.marketplace}:${enq.action}`,
    };
  } catch (error) {
    return {
      enqueued: false,
      detail: `WAVE_B_ENQUEUE_ERR:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
