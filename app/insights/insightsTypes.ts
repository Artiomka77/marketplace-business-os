export type MarketplaceCode = "WB" | "Ozon";

/** Stock channel: marketplace FBO or own warehouse. */
export type StockChannel = MarketplaceCode | "OWN";

export type InsightSizePart = {
  sizeLabel: string;
  salesQty: number | null;
  revenue: number | null;
  /** Allocated / ledger profit — null when not proven per size */
  profit: number | null;
  note?: string;
};

export type InsightSkuRow = {
  companyName: string;
  marketplace: MarketplaceCode;
  sku: string;
  vendorCode: string;
  subject: string;
  /** Visible size label: exact size, «Все размеры», or «н/д» */
  sizeLabel: string;
  sizeStatus: "EXACT" | "FAMILY_ALL" | "UNKNOWN";
  sizeParts: InsightSizePart[];
  salesQty: number;
  revenue: number;
  profit: number;
  /** null when revenue is 0 — never invent 0% or 100% margin */
  marginPercent: number | null;
  anomaly: "NONE" | "PROFIT_WITHOUT_REVENUE" | "LOSS_WITHOUT_REVENUE";
  imageUrl?: string | null;
};

export type InsightStockRow = {
  companyName: string;
  marketplace: StockChannel;
  sku: string;
  vendorCode: string;
  sizeLabel: string;
  quantity: number;
  unitCost: number | null;
  frozenMoney: number | null;
  costCoverage: "FULL" | "MISSING";
  imageUrl?: string | null;
};

export type MarketplaceSlice = {
  marketplace: MarketplaceCode;
  /**
   * Canonical management economic turnover for this MP
   * (WB sellerRetailAmount / Ozon economicTurnover).
   */
  economicTurnover: number | null;
  /** Marketplace netProfitAfterTax from analytics totals (P&L after tax). */
  marketplaceNetProfit: number | null;
  /**
   * Sum of SKU `revenue` field (sales attribution only; adjustments have 0).
   * Not Dashboard economic turnover. Null when SKU layer unavailable.
   */
  skuRevenue: number | null;
  /** Total SKU netProfitAfterTax including adjustments. Null when SKU unavailable. */
  skuProfit: number | null;
  /** profit attributable to rows with revenue > 0 */
  soldProfit: number | null;
  /** Margin on economic turnover when available; else on skuRevenue */
  marginPercent: number | null;
  /** SKU rows with revenue=0 and non-zero profit (adjustments) */
  adjustmentProfit: number | null;
  adjustmentSkuCount: number | null;
};

export type InsightsFinanceStatus =
  | "VERIFIED_READY"
  | "PRELIMINARY_WITH_VALUE"
  | "PENDING_BUILD"
  | "SOURCE_MISSING"
  | "ERROR";

export type InsightsSkuStatus =
  | "READY"
  | "PRELIMINARY"
  | "PENDING"
  | "UNAVAILABLE";

export type InsightsPayload = {
  company: string;
  dateFrom: string;
  dateTo: string;
  companies: Array<{ id: string; name: string }>;
  generatedAtLabel: string;
  dataModes: string[];
  /** Readiness of management KPIs (never invent 0 ₽ on miss). */
  financeStatus: InsightsFinanceStatus;
  financeStatusReason: string;
  /** Readiness of SKU rankings / adjustments strip. */
  skuStatus: InsightsSkuStatus;
  skuStatusReason: string;
  /** True when a cheap read-model rebuild was requested this render. */
  rebuildPending: boolean;
  rebuildDetail: string;
  sourceGeneratedAtLabel: string | null;
  kpi: {
    /** Canonical WB+Ozon economic turnover (management). Null if incomplete. */
    economicTurnover: number | null;
    economicTurnoverWb: number | null;
    economicTurnoverOzon: number | null;
    /** Dashboard business netProfit: MP after tax + Finance INCLUDE, before owner. */
    businessNetProfit: number | null;
    /** True only when businessNetProfit includes Finance INCLUDE (V6 / short live). */
    businessNetIncludesFinance: boolean;
    marketplaceNetProfit: number | null;
    financeNetProfitImpact: number | null;
    /** businessNetProfit / economicTurnover when both known */
    businessMarginPercent: number | null;
    /** Unique product identities with negative attributed profit. Null if SKU layer unavailable. */
    lossSkuCount: number | null;
    lossCountIsUniqueIdentity: boolean;
    /** Stock × ProductCost on deduped current snapshot (known-cost rows only). */
    stockAtCost: number | null;
    stockAtCostWb: number | null;
    stockAtCostOzon: number | null;
    stockAtCostOwn: number | null;
    stockMissingCostQty: number;
    frozenCoveragePartial: boolean;
    frozenAsOfLabel: string;
    /** Transparent SKU analytics (not top-row business KPIs) */
    skuDetail: {
      skuRevenue: number | null;
      soldProfit: number | null;
      adjustmentProfit: number | null;
      skuProfitTotal: number | null;
      salesMarginPercent: number | null;
      truncated: boolean;
      totalSkuRows: number | null;
    };
    /** Provenance for Ozon MP net (Wave B vs live) */
    ozonProfitSource: string;
    ozonTotalCost: number | null;
    wbTotalCost: number | null;
  };
  attention: {
    lossSkuCount: number | null;
    lowMarginSkuCount: number | null;
    profitableSkuCount: number | null;
    stockAtCost: number | null;
  };
  drivers: MarketplaceSlice[];
  problems: {
    uniqueProblemSkuCount: number | null;
    lossSkuCount: number | null;
    lowMarginSkuCount: number | null;
    noMovementSkuCount: number | null;
    excessStockSkuCount: number | null;
  };
  profitablePreview: InsightSkuRow[];
  profitableAll: InsightSkuRow[];
  lossPreview: InsightSkuRow[];
  lossAll: InsightSkuRow[];
  adjustments: InsightSkuRow[];
  adjustmentSummary: {
    skuCount: number | null;
    profitSum: number | null;
    status: "READY" | "PENDING" | "EMPTY";
  };
  /** Positive margin strictly below 5% (excludes убыточные — они в ТОП убыточных) */
  lowMarginPreview: InsightSkuRow[];
  lowMarginAll: InsightSkuRow[];
  frozenPreview: InsightStockRow[];
  frozenAll: InsightStockRow[];
};
