import { prisma } from "@/lib/prisma";
import { getDefaultLastCompletedWeekRange } from "@/lib/date/defaultPeriod";
import { loadInsightsFinanceSnapshot } from "@/lib/insights/loadFinanceSnapshot";
import { emptyInsightsDetailPending } from "@/lib/insights/loadDetailSnapshot";

import InsightsDashboard from "./InsightsDashboard";
import type { InsightsPayload } from "./insightsTypes";

export default async function InsightsPage({
  searchParams,
}: {
  searchParams?: Promise<{
    company?: string | string[];
    dateFrom?: string | string[];
    dateTo?: string | string[];
  }>;
}) {
  const raw = searchParams ? await searchParams : {};
  const first = (v: string | string[] | undefined, fallback: string) => {
    if (Array.isArray(v)) {
      for (const entry of v) {
        const t = String(entry ?? "").trim();
        if (t) return t;
      }
      return fallback;
    }
    if (v == null) return fallback;
    const t = String(v).trim();
    return t || fallback;
  };

  const defaultPeriod = getDefaultLastCompletedWeekRange();
  const dateFrom = first(raw.dateFrom, defaultPeriod.dateFrom);
  const dateTo = first(raw.dateTo, defaultPeriod.dateTo);
  const selectedCompany = first(raw.company, "ALL");

  // Level A only — companies + finance snapshot (no live FC, no stock/SKU).
  const companies = await prisma.company.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });

  const finance = await loadInsightsFinanceSnapshot({
    dateFrom,
    dateTo,
    selectedCompany,
  });
  const detailPending = emptyInsightsDetailPending();

  const nowLabel = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());

  const payload: InsightsPayload = {
    company: selectedCompany,
    dateFrom,
    dateTo,
    companies: companies.map((c) => ({ id: c.id, name: c.name })),
    generatedAtLabel: nowLabel,
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

  return <InsightsDashboard data={payload} />;
}
