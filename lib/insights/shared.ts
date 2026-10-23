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
    const result = await repository.requestRebuild({
      companyScope:
        !params.companyScope || params.companyScope === "ALL"
          ? "ALL"
          : params.companyScope,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      priority: 80,
    });
    return {
      enqueued: result === "queued_prisma" || result === "queued_local",
      detail: `V6:${result}`,
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
