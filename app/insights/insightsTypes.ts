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
};

export type MarketplaceSlice = {
  marketplace: MarketplaceCode;
  revenue: number;
  profit: number;
  marginPercent: number | null;
};

export type InsightsPayload = {
  company: string;
  dateFrom: string;
  dateTo: string;
  companies: Array<{ id: string; name: string }>;
  generatedAtLabel: string;
  dataModes: string[];
  kpi: {
    revenue: number;
    netProfit: number;
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
  lowMarginPreview: InsightSkuRow[];
  lowMarginAll: InsightSkuRow[];
  frozenPreview: InsightStockRow[];
  frozenAll: InsightStockRow[];
};
