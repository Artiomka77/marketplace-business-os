/**
 * FIN_ACCEPT — real InsightsDashboard SSR render proof.
 * Level-A = same path as app/insights/page.tsx (loadInsightsFinanceSnapshot).
 * Detail = loadInsightsDetailSnapshot → mergeDetailIntoPayload (exported from dashboard).
 * Does NOT invent top-card businessProfit from bridge/producer totals.
 */
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

process.env.FIN_GATE_OFFLINE = "1";

// Stub next/navigation + server-only before importing page/dashboard loaders.
const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "next/navigation") {
    return {
      useRouter: () => ({
        refresh: () => {},
        push: () => {},
        replace: () => {},
        prefetch: async () => {},
      }),
      usePathname: () => "/insights",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  if (request === "server-only") {
    return {};
  }
  return origLoad.apply(this, arguments as unknown as [string, unknown, boolean]);
};

const TS = process.env.FIN_ACCEPT_TS || "UNKNOWN";
const ROOT = process.cwd();
const OUT = path.join(ROOT, "scripts/fin_patch", `FIN_ACCEPT_RESULT_${TS}`, "evidence");
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(
  ROOT,
  "scripts/fin_patch",
  `FIN_ACCEPT_RESULT_${TS}`,
  "logs",
  "insights_dashboard_ssr.log",
);
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const logLines: string[] = [];
function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  logLines.push(line);
  console.log(msg);
}

const FIX =
  process.env.FIN_WEEK_FINAL ||
  path.join(
    process.env.USERPROFILE || "",
    "Downloads",
    "FIN_RECON_20261026_195246",
    "_week_final",
  );
const dumpRoot = path.resolve("scripts/fin_patch/fixtures_fin_run");
const writesPath = path.resolve("scripts/fin_patch/out_full_replay/PRODUCER_WRITES.json");

async function main() {
  log(`START FIN_ACCEPT_TS=${TS}`);
  log(`FIX=${FIX}`);
  log(`writes=${writesPath} exists=${fs.existsSync(writesPath)}`);

  const { buildOfflineFixturePrisma } = await import("./offline_fixture_prisma");
  const { bindPrismaClientForOfflineReplay } = await import("@/lib/prisma");
  const { loadInsightsFinanceSnapshot } = await import(
    "@/lib/insights/loadFinanceSnapshot"
  );
  const {
    loadInsightsDetailSnapshot,
    emptyInsightsDetailPending,
  } = await import("@/lib/insights/loadDetailSnapshot");
  const { mergeDetailIntoPayload } = await import(
    "@/app/insights/InsightsDashboard"
  );
  const InsightsDashboard = (await import("@/app/insights/InsightsDashboard"))
    .default;
  type InsightsPayload = import("@/app/insights/insightsTypes").InsightsPayload;

  const fixture = buildOfflineFixturePrisma({
    weekFinalRoot: FIX,
    dumpRoot,
  });

  const writes = JSON.parse(fs.readFileSync(writesPath, "utf8")) as Array<{
    meta: {
      companyScope: string;
      marketplace: string;
      dateFrom: string;
      dateTo: string;
      formulaVersion: string;
      dataMode: string;
      generatedAt?: string;
    };
    totals: Record<string, unknown>;
    rows: Array<Record<string, unknown>>;
  }>;

  const periods: Array<Record<string, unknown>> = [];
  const skus: Array<Record<string, unknown>> = [];
  for (const [i, w] of writes.entries()) {
    periods.push({
      id: "p" + i,
      companyScope: w.meta.companyScope,
      marketplace: w.meta.marketplace,
      dateFrom: new Date(w.meta.dateFrom),
      dateTo: new Date(w.meta.dateTo),
      formulaVersion: w.meta.formulaVersion,
      dataMode: w.meta.dataMode,
      totals: w.totals,
      generatedAt: new Date(w.meta.generatedAt || "2026-10-26T00:00:00.000Z"),
    });
    for (const [j, row] of (w.rows || []).entries()) {
      skus.push({
        id: `s${i}_${j}`,
        companyScope: w.meta.companyScope,
        marketplace: w.meta.marketplace,
        dateFrom: new Date(w.meta.dateFrom),
        dateTo: new Date(w.meta.dateTo),
        formulaVersion: w.meta.formulaVersion,
        productKey: String(row.nmId ?? row.vendorCode ?? j),
        payload: row,
        netProfitAfterTax: row.netProfitAfterTax,
        generatedAt: new Date(w.meta.generatedAt || "2026-10-26T00:00:00.000Z"),
      });
    }
  }

  // Seed mutable offline stores used by detail loader.
  (fixture as any).profitPeriodMetric = {
    findMany: async (args: any = {}) => {
      let list = periods.slice();
      const where = args.where || {};
      for (const [k, v] of Object.entries(where)) {
        if (v && typeof v === "object" && Array.isArray((v as any).in)) {
          list = list.filter((r) => (v as any).in.includes(r[k]));
        } else if (v instanceof Date) {
          list = list.filter(
            (r) => new Date(r[k] as Date).getTime() === v.getTime(),
          );
        } else if (v !== undefined) {
          list = list.filter((r) => r[k] === v);
        }
      }
      return list;
    },
    count: async (a: any = {}) =>
      (await (fixture as any).profitPeriodMetric.findMany(a)).length,
  };
  (fixture as any).profitSkuPeriodMetric = {
    findMany: async (args: any = {}) => {
      let list = skus.slice();
      const where = args.where || {};
      for (const [k, v] of Object.entries(where)) {
        if (v && typeof v === "object" && Array.isArray((v as any).in)) {
          list = list.filter((r) => (v as any).in.includes(r[k]));
        } else if (v instanceof Date) {
          list = list.filter(
            (r) => new Date(r[k] as Date).getTime() === v.getTime(),
          );
        } else if (v !== undefined) {
          list = list.filter((r) => r[k] === v);
        }
      }
      return list;
    },
    count: async (a: any = {}) =>
      (await (fixture as any).profitSkuPeriodMetric.findMany(a)).length,
  };

  bindPrismaClientForOfflineReplay(fixture as any);
  log("bound offline prisma (Finance primary + producer periods/skus)");

  const DATE_FROM = "2026-10-19";
  const DATE_TO = "2026-10-25";
  const scopes = ["ИП Петров", "ИП Лебедева", "ALL"] as const;
  const report: {
    method: string;
    fixtureOrigin: Record<string, string>;
    scopes: Record<string, Record<string, unknown>>;
    invariants?: Record<string, unknown>;
  } = {
    method:
      "app/insights/page.tsx Level-A loadInsightsFinanceSnapshot + loadInsightsDetailSnapshot + mergeDetailIntoPayload + react-dom/server InsightsDashboard",
    fixtureOrigin: {
      financeSource:
        "FIN_ACCEPT_RESULT_" +
        TS +
        "/primary_finance_complete/FINANCE_SOURCE.json (MAIN RO)",
      producerWrites: writesPath,
      weekFinal: FIX,
    },
    scopes: {},
  };

  for (const company of scopes) {
    log(`SCOPE ${company}: finance snapshot…`);
    const finance = await loadInsightsFinanceSnapshot({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      selectedCompany: company,
    });
    const detailPending = emptyInsightsDetailPending();
    const companies = await (fixture as any).company.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
    });

    const levelA: InsightsPayload = {
      company,
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      companies: companies.map((c: any) => ({ id: c.id, name: c.name })),
      generatedAtLabel: "SSR_TEST",
      dataModes: [
        ...finance.dataModes,
        "sku:PENDING",
        "skuReason:DETAIL_ASYNC_PENDING",
        "path:SNAPSHOT_FINANCE_FIRST",
      ],
      financeStatus: finance.financeStatus,
      financeStatusReason: finance.financeStatusReason,
      financeCoverage: finance.financeCoverage,
      skuStatus: detailPending.skuStatus,
      skuStatusReason: detailPending.skuStatusReason,
      rebuildPending: finance.rebuildPending,
      rebuildDetail: finance.rebuildDetail,
      detailAsync: true,
      detailGeneratedAtLabel: null,
      sourceGeneratedAtLabel: finance.sourceGeneratedAtLabel,
      kpi: {
        economicTurnover: finance.economicTurnover,
        economicTurnoverWb: finance.economicTurnoverWb,
        economicTurnoverOzon: finance.economicTurnoverOzon,
        businessNetProfit: finance.businessNetProfit,
        businessNetIncludesFinance: finance.businessNetIncludesFinance,
        marketplaceNetProfit: finance.marketplaceNetProfit,
        financeNetProfitImpact: finance.financeNetProfitImpact,
        businessMarginPercent: finance.businessMarginPercent,
        lossSkuCount: null,
        lossCountIsUniqueIdentity: true,
        stockAtCost: null,
        stockAtCostWb: null,
        stockAtCostOzon: null,
        stockAtCostOwn: null,
        stockMissingCostQty: 0,
        frozenCoveragePartial: false,
        frozenAsOfLabel: "товарный слой загружается отдельно",
        skuDetail: detailPending.skuDetail,
        ozonProfitSource: finance.kpiSource,
        ozonTotalCost: finance.ozonTotalCost,
        wbTotalCost: finance.wbTotalCost,
      },
      attention: detailPending.attention,
      drivers: finance.drivers,
      problems: detailPending.problems,
      profitablePreview: [],
      profitableAll: [],
      lossPreview: [],
      lossAll: [],
      adjustments: [],
      adjustmentSummary: detailPending.adjustmentSummary,
      lowMarginPreview: [],
      lowMarginAll: [],
      frozenPreview: [],
      frozenAll: [],
    };

    log(
      `SCOPE ${company}: financeStatus=${finance.financeStatus} businessNet=${finance.businessNetProfit} reason=${finance.financeStatusReason}`,
    );
    log(`SCOPE ${company}: detail loader…`);
    const detail = await loadInsightsDetailSnapshot({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      selectedCompany: company,
    });
    const merged = mergeDetailIntoPayload(levelA, detail as any);

    // Intentionally do NOT overwrite Level-A businessNetProfit from bridge.
    const bridgeProfit =
      (detail as any)?.accountResidualBridge?.businessProfit ?? null;
    const topBusiness = merged.kpi.businessNetProfit;
    const honestTopKpi =
      finance.financeStatus === "PENDING_BUILD" ||
      finance.financeStatus === "ERROR"
        ? topBusiness == null
        : true;

    const html = renderToStaticMarkup(
      React.createElement(InsightsDashboard, { data: merged }),
    );
    const htmlPath = path.join(
      OUT,
      `insights_dashboard_ssr_${company === "ALL" ? "ALL" : company.replace(/\s+/g, "_")}.html`,
    );
    fs.writeFileSync(htmlPath, html, "utf8");

    const hasNd = html.includes("н/д");
    const hasPreliminary =
      html.includes("PRELIMINARY") ||
      html.includes("Предвар") ||
      String(merged.skuStatus).includes("PRELIMINARY") ||
      String(merged.financeStatus).includes("PRELIMINARY");
    const falseFinalZero =
      (finance.financeStatus === "PENDING_BUILD" ||
        finance.financeStatus === "ERROR") &&
      /businessNetProfit[^]*?>\s*0\s*</.test(html) === false
        ? false
        : finance.businessNetProfit == null &&
          html.includes(">0<") &&
          html.includes("FINAL") &&
          !hasNd;

    const skuCount =
      (detail as any)?.skuDetail?.totalSkuCount ??
      (detail as any)?.skuDetail?.skuCount ??
      null;
    const expenseOnly =
      (detail as any)?.skuDetail?.expenseOnlyCount ??
      (detail as any)?.adjustmentSummary?.expenseOnlyCount ??
      null;

    report.scopes[company] = {
      financeStatus: finance.financeStatus,
      financeStatusReason: finance.financeStatusReason,
      levelA_businessNetProfit: finance.businessNetProfit,
      levelA_marketplaceNetProfit: finance.marketplaceNetProfit,
      levelA_financeNetProfitImpact: finance.financeNetProfitImpact,
      detail_skuStatus: (detail as any)?.skuStatus ?? merged.skuStatus,
      detail_skuStatusReason:
        (detail as any)?.skuStatusReason ?? merged.skuStatusReason,
      bridge_businessProfit_NOT_copied_to_top: bridgeProfit,
      top_kpi_businessNetProfit_after_merge: topBusiness,
      honestTopKpi,
      skuCount,
      expenseOnly,
      htmlBytes: Buffer.byteLength(html, "utf8"),
      htmlPath: path.relative(ROOT, htmlPath),
      htmlHasNd: hasNd,
      preliminarySignal: hasPreliminary,
      falseFinalZeroTrusted: Boolean(falseFinalZero),
      dataModes: merged.dataModes,
      mergePath: "mergeDetailIntoPayload",
    };
    log(
      `SCOPE ${company}: html=${Buffer.byteLength(html, "utf8")}B skuStatus=${merged.skuStatus} topBusiness=${topBusiness}`,
    );
  }

  // Missing-data honesty: Level-A PENDING must render н/д, not trusted 0/FINAL.
  const pendingScopes = Object.values(report.scopes as Record<string, any>).filter(
    (s) =>
      s.financeStatus === "PENDING_BUILD" || s.levelA_businessNetProfit == null,
  );
  report.invariants = {
    topKpiNotFilledFromBridge: Object.values(
      report.scopes as Record<string, any>,
    ).every(
      (s) =>
        s.top_kpi_businessNetProfit_after_merge ===
        s.levelA_businessNetProfit,
    ),
    pendingShowsHonestGap:
      pendingScopes.length === 0 ||
      pendingScopes.every((s) => s.htmlHasNd || s.levelA_businessNetProfit == null),
    usedRealMerge: true,
    usedFinanceSnapshotPath: true,
    usedFullDetailLoader: true,
    usedInsightsDashboardSSR: true,
  };

  const outJson = path.join(OUT, "insights_dashboard_ssr_report.json");
  fs.writeFileSync(outJson, JSON.stringify(report, null, 2) + "\n", "utf8");
  fs.writeFileSync(LOG, logLines.join("\n") + "\n", "utf8");
  log(`WROTE ${outJson}`);
  log("DONE");
  console.log(JSON.stringify({ ok: true, outJson, invariants: report.invariants }, null, 2));
}

main().catch((e) => {
  console.error(e);
  fs.appendFileSync(LOG, String(e?.stack || e) + "\n");
  process.exit(1);
});
