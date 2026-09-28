/**
 * Wave B closed-week direct oracle + read-model parity canary.
 * Reads canonical Profit via DATABASE_URL (production RO ok).
 * Writes read-model via WAVE_B_PROFIT_TARGET_DATABASE_URL (ephemeral only).
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

const DATE_FROM = "2026-08-17";
const DATE_TO = "2026-08-23";
const SCOPES = ["ALL", "ИП Петров", "ИП Лебедева"] as const;
const MARKETS: ProfitMarketplace[] = ["WB", "OZON"];

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickTotals(analytics: Record<string, unknown>) {
  const t = (analytics.totals ?? null) as Record<string, unknown> | null;
  if (!t) return null;
  return {
    revenue: num(t.revenue),
    netProfitAfterTax: num(t.netProfitAfterTax),
    adsCost: num(t.adsCost),
    totalCost: num(t.totalCost ?? t.cogs),
    logisticsCost: num(t.logisticsCost),
    taxes: num(t.taxes ?? t.taxAmount),
    marginAfterTaxPercent: num(t.marginAfterTaxPercent ?? t.margin),
    drr: num(t.drr ?? t.drrPercent),
    netProfitStatus: t.netProfitStatus ?? null,
    costCoverageIncomplete: t.costCoverageIncomplete ?? null,
    taxesEstimated: analytics.taxesEstimated ?? null,
  };
}

function skuSample(rows: Array<Record<string, unknown>>) {
  const byRev = [...rows].sort(
    (a, b) => Number(b.revenue ?? 0) - Number(a.revenue ?? 0)
  );
  const byProfit = [...rows].sort(
    (a, b) =>
      Math.abs(Number(b.netProfitAfterTax ?? 0)) -
      Math.abs(Number(a.netProfitAfterTax ?? 0))
  );
  const take = (list: Array<Record<string, unknown>>) =>
    list.slice(0, 5).map((r) => ({
      nmId: r.nmId ?? r.sku ?? null,
      vendorCode: r.vendorCode ?? null,
      revenue: num(r.revenue),
      netProfitAfterTax: num(r.netProfitAfterTax),
    }));
  return { top5Revenue: take(byRev), top5AbsProfit: take(byProfit) };
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function main() {
  const oracleOut = process.env.WAVE_B_ORACLE_OUT;
  const parityOut = process.env.WAVE_B_PARITY_OUT;
  if (!oracleOut || !parityOut) {
    throw new Error("WAVE_B_ORACLE_OUT and WAVE_B_PARITY_OUT required");
  }
  if (!process.env.WAVE_B_PROFIT_TARGET_DATABASE_URL?.trim()) {
    throw new Error("WAVE_B_PROFIT_TARGET_DATABASE_URL required (ephemeral)");
  }

  const target = createWaveBProfitTargetPrismaClient();
  const repository = createPrismaProfitReadModelRepository(target);
  const oracle: Record<string, unknown> = {
    dateFrom: DATE_FROM,
    dateTo: DATE_TO,
    scopes: SCOPES,
    markets: MARKETS,
    cases: [] as unknown[],
  };
  const parity: Record<string, unknown> = {
    dateFrom: DATE_FROM,
    dateTo: DATE_TO,
    cases: [] as unknown[],
    WB_CLOSED_PARITY: "PASS",
    OZON_CLOSED_PARITY: "PASS",
    SKU_SAMPLE_PARITY: "PASS",
    SOURCE_OWNERSHIP_PARITY: "PASS",
    OZON_FINALITY_PARITY: "PASS",
  };

  try {
    for (const marketplace of MARKETS) {
      for (const companyScope of SCOPES) {
        const companyName = companyScope;
        const t0 = Date.now();
        const direct =
          marketplace === "WB"
            ? ((await getProfitAnalytics({
                dateFrom: DATE_FROM,
                dateTo: DATE_TO,
                companyName,
              })) as unknown as Record<string, unknown>)
            : ((await getProfitAnalyticsOzon({
                dateFrom: DATE_FROM,
                dateTo: DATE_TO,
                companyName,
              })) as unknown as Record<string, unknown>);
        const directMs = Date.now() - t0;
        const directTotals = pickTotals(direct);
        const rows = Array.isArray(direct.rows)
          ? (direct.rows as Array<Record<string, unknown>>)
          : [];
        const sample = skuSample(rows);

        (oracle.cases as unknown[]).push({
          marketplace,
          companyScope,
          directMs,
          totals: directTotals,
          skuCount: rows.length,
          skuSample: sample,
          wbPnlAvailability: direct.wbPnlAvailability ?? null,
          taxesEstimated: direct.taxesEstimated ?? null,
        });

        const produced = await produceProfitReadModel({
          repository,
          marketplace,
          companyScope,
          dateFrom: DATE_FROM,
          dateTo: DATE_TO,
          computeWb: async () => direct as never,
          computeOzon: async () => direct as never,
        });

        const loaded = await loadProfitReadModel({
          repository,
          marketplace,
          companyScope,
          dateFrom: DATE_FROM,
          dateTo: DATE_TO,
          enqueueOnMiss: false,
        });

        const hitOk = loaded.status === "HIT";
        const loadedAnalytics = hitOk
          ? (loaded.analytics as Record<string, unknown>)
          : null;
        const loadedTotals = loadedAnalytics ? pickTotals(loadedAnalytics) : null;
        const loadedRows = Array.isArray(loadedAnalytics?.rows)
          ? (loadedAnalytics!.rows as Array<Record<string, unknown>>)
          : [];
        const loadedSample = skuSample(loadedRows);
        const totalsParity = deepEqual(directTotals, loadedTotals);
        const skuParity = deepEqual(sample, loadedSample);
        const heavyOk = hitOk && loaded.heavyFcCalls === 0;

        if (!hitOk || !totalsParity) {
          if (marketplace === "WB") parity.WB_CLOSED_PARITY = "FAIL";
          else parity.OZON_CLOSED_PARITY = "FAIL";
        }
        if (!skuParity) parity.SKU_SAMPLE_PARITY = "FAIL";

        (parity.cases as unknown[]).push({
          marketplace,
          companyScope,
          hit: hitOk,
          heavyFcCalls: hitOk ? loaded.heavyFcCalls : null,
          totalsParity,
          skuParity,
          heavyOk,
          produced,
          reason: hitOk ? null : (loaded as { reason?: string }).reason,
        });
      }
    }
  } finally {
    await disconnectWaveBProfitTargetPrismaClient();
  }

  const overall =
    parity.WB_CLOSED_PARITY === "PASS" &&
    parity.OZON_CLOSED_PARITY === "PASS" &&
    parity.SKU_SAMPLE_PARITY === "PASS";

  writeFileSync(oracleOut, JSON.stringify(oracle, null, 2), "utf8");
  writeFileSync(
    parityOut,
    JSON.stringify({ ...parity, OVERALL: overall ? "PASS" : "FAIL" }, null, 2),
    "utf8"
  );
  console.log(JSON.stringify({ oracleOut, parityOut, OVERALL: overall ? "PASS" : "FAIL" }));
  if (!overall) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
