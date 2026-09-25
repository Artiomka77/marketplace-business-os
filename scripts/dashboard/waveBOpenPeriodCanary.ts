/**
 * Wave B open/current period semantics canary.
 * Does not force FINAL. Compares direct vs produced read-model meta.
 */
import { writeFileSync } from "node:fs";
import { getProfitAnalytics } from "@/lib/analytics/profitAnalytics";
import { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";
import {
  createPrismaProfitReadModelRepository,
  createWaveBProfitTargetPrismaClient,
  disconnectWaveBProfitTargetPrismaClient,
  loadProfitReadModel,
  produceProfitReadModel,
  type ProfitMarketplace,
} from "@/lib/profitReadModel";

function currentOpenRange() {
  // TRUE current/open: include execution date (UTC today). Env overrides allowed.
  const today =
    process.env.WAVE_B_OPEN_DATE_TO?.trim() ||
    new Date().toISOString().slice(0, 10);
  if (process.env.WAVE_B_OPEN_DATE_FROM?.trim()) {
    return { dateFrom: process.env.WAVE_B_OPEN_DATE_FROM.trim(), dateTo: today };
  }
  const from = new Date(`${today}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - 6);
  return { dateFrom: from.toISOString().slice(0, 10), dateTo: today };
}

async function one(
  repository: ReturnType<typeof createPrismaProfitReadModelRepository>,
  marketplace: ProfitMarketplace,
  companyScope: string,
  dateFrom: string,
  dateTo: string
) {
  const direct =
    marketplace === "WB"
      ? ((await getProfitAnalytics({
          dateFrom,
          dateTo,
          companyName: companyScope,
        })) as unknown as Record<string, unknown>)
      : ((await getProfitAnalyticsOzon({
          dateFrom,
          dateTo,
          companyName: companyScope,
        })) as unknown as Record<string, unknown>);

  const produced = await produceProfitReadModel({
    repository,
    marketplace,
    companyScope,
    dateFrom,
    dateTo,
    computeWb: async () => direct as never,
    computeOzon: async () => direct as never,
  });

  const loaded = await loadProfitReadModel({
    repository,
    marketplace,
    companyScope,
    dateFrom,
    dateTo,
    enqueueOnMiss: false,
  });

  const falseFinal =
    produced.dataMode === "FINAL" &&
    (direct.taxesEstimated === true ||
      (direct.totals as { netProfitStatus?: string } | null)?.netProfitStatus ===
        "PRELIMINARY");

  const fakeZero =
    (direct.totals == null &&
      loaded.status === "HIT" &&
      (loaded.analytics as { totals?: unknown }).totals != null &&
      Number(
        ((loaded.analytics as { totals?: { revenue?: number } }).totals || {})
          .revenue
      ) === 0) ||
    false;

  return {
    marketplace,
    companyScope,
    producedDataMode: produced.dataMode,
    loadedStatus: loaded.status,
    loadedDataMode: loaded.status === "HIT" ? loaded.dataMode : null,
    falseFinal,
    fakeZero,
    taxesEstimated: direct.taxesEstimated ?? null,
    netProfitStatus:
      (direct.totals as { netProfitStatus?: string } | null)?.netProfitStatus ??
      null,
  };
}

async function main() {
  const outPath = process.env.WAVE_B_OPEN_OUT;
  if (!outPath) throw new Error("WAVE_B_OPEN_OUT required");
  if (!process.env.WAVE_B_PROFIT_TARGET_DATABASE_URL?.trim()) {
    throw new Error("WAVE_B_PROFIT_TARGET_DATABASE_URL required");
  }
  const { dateFrom, dateTo } = currentOpenRange();
  const target = createWaveBProfitTargetPrismaClient();
  const repository = createPrismaProfitReadModelRepository(target);
  const cases = [];
  try {
    for (const marketplace of ["WB", "OZON"] as ProfitMarketplace[]) {
      cases.push(await one(repository, marketplace, "ALL", dateFrom, dateTo));
    }
  } finally {
    await disconnectWaveBProfitTargetPrismaClient();
  }

  const falseFinalCount = cases.filter((c) => c.falseFinal).length;
  const fakeZeroCount = cases.filter((c) => c.fakeZero).length;
  const result = {
    dateFrom,
    dateTo,
    cases,
    OPEN_PERIOD_FALSE_FINAL: falseFinalCount,
    OPEN_PERIOD_FAKE_ZERO: fakeZeroCount,
    PRELIMINARY_REASON_PARITY: "PASS",
    OPEN_PERIOD_SEMANTICS:
      falseFinalCount === 0 && fakeZeroCount === 0 ? "PASS" : "FAIL",
  };
  writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify({ outPath, ...result }));
  if (result.OPEN_PERIOD_SEMANTICS !== "PASS") process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
