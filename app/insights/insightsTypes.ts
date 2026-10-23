export type MarketplaceCode = "WB" | "Ozon";

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
  marketplace: MarketplaceCode;
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
   * Not Dashboard economic turnover.
   */
  skuRevenue: number;
  /** Total SKU netProfitAfterTax including adjustments */
  skuProfit: number;
  /** profit attributable to rows with revenue > 0 */
  soldProfit: number;
  /** Margin on economic turnover when available; else on skuRevenue */
  marginPercent: number | null;
  /** SKU rows with revenue=0 and non-zero profit (adjustments) */
  adjustmentProfit: number;
  adjustmentSkuCount: number;
};

export type InsightsPayload = {
  company: string;
  dateFrom: string;
  dateTo: string;
  companies: Array<{ id: string; name: string }>;
  generatedAtLabel: string;
  dataModes: string[];
  kpi: {
    /** Canonical WB+Ozon economic turnover (management). Null if incomplete. */
    economicTurnover: number | null;
    economicTurnoverWb: number | null;
    economicTurnoverOzon: number | null;
    /** Dashboard business netProfit: MP after tax + Finance INCLUDE, before owner. */
    businessNetProfit: number | null;
    marketplaceNetProfit: number | null;
    financeNetProfitImpact: number | null;
    /** businessNetProfit / economicTurnover when both known */
    businessMarginPercent: number | null;
    /** Unique product identities with negative attributed profit (rows if not unique). */
    lossSkuCount: number;
    lossCountIsUniqueIdentity: boolean;
    /** Stock × ProductCost on deduped current snapshot */
    stockAtCost: number | null;
    frozenCoveragePartial: boolean;
    frozenAsOfLabel: string;
    /** Transparent SKU analytics (not top-row business KPIs) */
    skuDetail: {
      skuRevenue: number;
      soldProfit: number;
      adjustmentProfit: number;
      skuProfitTotal: number;
      salesMarginPercent: number | null;
    };
    /** Provenance for Ozon MP net (Wave B vs live) */
    ozonProfitSource: string;
    ozonTotalCost: number;
    wbTotalCost: number;
  };
  attention: {
    lossSkuCount: number;
    lowMarginSkuCount: number;
    profitableSkuCount: number;
    stockAtCost: number | null;
  };
  drivers: MarketplaceSlice[];
  problems: {
    uniqueProblemSkuCount: number;
    lossSkuCount: number;
    lowMarginSkuCount: number;
    noMovementSkuCount: number | null;
    excessStockSkuCount: number | null;
  };
  profitablePreview: InsightSkuRow[];
  profitableAll: InsightSkuRow[];
  lossPreview: InsightSkuRow[];
  lossAll: InsightSkuRow[];
  adjustments: InsightSkuRow[];
  adjustmentSummary: {
    skuCount: number;
    profitSum: number;
  };
  /** Positive margin strictly below 5% (excludes убыточные — они в ТОП убыточных) */
  lowMarginPreview: InsightSkuRow[];
  lowMarginAll: InsightSkuRow[];
  frozenPreview: InsightStockRow[];
  frozenAll: InsightStockRow[];
};
