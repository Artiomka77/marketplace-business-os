export type MarketplaceCode = "WB" | "Ozon";

export type InsightSkuRow = {
  companyName: string;
  marketplace: MarketplaceCode;
  sku: string;
  vendorCode: string;
  subject: string;
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
  quantity: number;
  unitCost: number | null;
  frozenMoney: number | null;
  costCoverage: "FULL" | "MISSING";
  imageUrl?: string | null;
};

export type MarketplaceSlice = {
  marketplace: MarketplaceCode;
  /** Sum of SKU revenue (sales only; adjustments have revenue 0) */
  revenue: number;
  /** Total SKU netProfitAfterTax including adjustments */
  profit: number;
  /** profit attributable to rows with revenue > 0 */
  soldProfit: number;
  marginPercent: number | null;
  /** SKU rows with revenue=0 and non-zero profit (adjustments), same marketplace */
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
    /** Sum of SKU `revenue` (WB+Ozon). Not Dashboard sales/accruals. */
    revenue: number;
    /** Sum of SKU `netProfitAfterTax` including adjustments without sales. */
    netProfit: number;
    /** soldProfit only (revenue>0 rows) — for transparency */
    soldProfit: number;
    /** adjustment profit sum (revenue=0 rows) */
    adjustmentProfit: number;
    /** Operational: soldProfit / revenue (без корректировок) */
    salesMarginPercent: number | null;
    /** Full SKU margin: netProfit / revenue (может включать корректировки → >100%) */
    netMarginPercent: number | null;
    lossSkuCount: number;
    frozenMoney: number | null;
    frozenCoveragePartial: boolean;
    frozenAsOfLabel: string;
  };
  attention: {
    lossSkuCount: number;
    lowMarginSkuCount: number;
    profitableSkuCount: number;
    frozenMoney: number | null;
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
