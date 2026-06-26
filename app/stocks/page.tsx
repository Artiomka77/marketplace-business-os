import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getProfitAnalytics } from "@/lib/analytics/profitAnalytics";
import { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";
import MarketplaceNav from "@/components/marketplaces/MarketplaceNav";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type StockSearchParams = {
  companyName?: string;
  source?: string;
  rows?: string;
  sort?: string;
  dir?: string;
  product?: string;
  q?: string;
  sizeRows?: string;
  sizeSort?: string;
  sizeOpen?: string;
  dateFrom?: string;
  dateTo?: string;
  supplyOpen?: string;
  supplyMarketplace?: string;
  supplyTarget?: string;
  supplyAbc?: string;
  supplyPriority?: string;
  supplyRows?: string;
  supplyQ?: string;
  productionOpen?: string;
  productionBufferDays?: string;
  productionRows?: string;
  productionAbc?: string;
  productionSelectionMode?: string;
  productionSelected?: string | string[];
};

type StockSource = "ALL" | "WB" | "OZON" | "OWN";
type SortKey = "product" | "vendorCode" | "qty" | "costPrice" | "totalCost" | "availableForSupplyQty";
type AbcCategory = "A" | "B" | "C";

type WbProfitAnalyticsResult = Awaited<ReturnType<typeof getProfitAnalytics>>;
type WbProfitRow = WbProfitAnalyticsResult["rows"][number];

type OzonProfitAnalyticsResult = Awaited<ReturnType<typeof getProfitAnalyticsOzon>>;
type OzonProfitRow = OzonProfitAnalyticsResult["rows"][number];

type StockAbcInfo = {
  abcByRevenue: AbcCategory;
  abcByProfit: AbcCategory;
};

type ProductVisual = {
  name: string | null;
  imageUrl: string | null;
};

type CostLookup = {
  bySupplierArticle: Map<string, number>;
  bySupplierArticleCompact: Map<string, number>;
  byNmId: Map<string, number>;
  bySupplierArticleRoot: Map<string, number>;
  bySupplierArticleRootCompact: Map<string, number>;
  supplierArticleByCompanyAndWbArticle: Map<string, string>;
  supplierArticleByWbArticle: Map<string, string>;
};

type CompanyStockSummary = {
  companyName: string;
  totalQty: number;
  totalCost: number;
  lastUpdate: string;
  wb: {
    totalQty: number;
    totalCost: number;
    stockQty: number;
    inTransitToCustomerQty: number;
    inTransitReturnsQty: number;
  };
  ozon: {
    totalQty: number;
    totalCost: number;
    availableQty: number;
    preparingQty: number;
    inTransitQty: number;
  };
  warehouse: {
    warehouseQty: number;
    totalCost: number;
    reservedQty: number;
    availableForSupplyQty: number;
    availableForSupplyCost: number;
    rowsCount: number;
  };
};

type UnifiedStockRow = {
  key: string;
  companyName: string;
  source: "WB" | "OZON" | "OWN";
  vendorCode: string;
  sku: string | null;
  nmId: string | null;
  barcode: string | null;
  size: string | null;
  warehouseName: string | null;
  clusterName: string | null;
  qty: number;
  reservedQty: number;
  availableForSupplyQty: number;
  costPrice: number;
  totalCost: number;
  productName: string | null;
  imageUrl: string | null;
  abc: StockAbcInfo | null;
};

type ProductSizeRow = {
  size: string;
  qty: number;
  totalCost: number;
};

type ProductSizeSourceSummary = {
  totalQty: number;
  totalCost: number;
  sizes: ProductSizeRow[];
  abc: StockAbcInfo | null;
};

type ProductSizeSummary = {
  groupKey: string;
  marketplaceArticle: string;
  vendorCode: string;
  productName: string | null;
  imageUrl: string | null;
  companyName: string;
  wb: ProductSizeSourceSummary;
  ozon: ProductSizeSourceSummary;
  own: ProductSizeSourceSummary;
  lowSizeCount: number;
  missingSizeCount: number;
};

type SupplyPlanMarketplace = "WB" | "OZON";
type SupplyPlanPriority = "HIGH" | "MEDIUM" | "LOW";

type OwnSupplyItem = {
  key: string;
  companyName: string;
  companyKey: string;
  articleKeys: Set<string>;
  sizeKey: string;
  availableQty: number;
  productName: string | null;
  imageUrl: string | null;
};

type SupplyPlanCandidate = {
  key: string;
  marketplace: SupplyPlanMarketplace;
  priority: SupplyPlanPriority;
  companyName: string;
  vendorCode: string;
  sku: string | null;
  size: string | null;
  productName: string | null;
  imageUrl: string | null;
  targetName: string;
  currentQty: number;
  ownItemKey: string | null;
  wantedQty: number;
  ownInitialQty: number;
  avgDailySalesQty: number | null;
  daysWithoutStock: number | null;
  abc: StockAbcInfo | null;
  reason: string;
  details: string[];
};

type SupplyPlanRow = SupplyPlanCandidate & {
  ownAvailableQty: number;
  recommendedQty: number;
};

type SizeSummarySortKey =
  | "totalDesc"
  | "totalAsc"
  | "wbDesc"
  | "ozonDesc"
  | "ownDesc"
  | "lowDesc"
  | "nameAsc";

function formatNumber(value: number) {
  return Math.round(value).toLocaleString("ru-RU");
}

function formatMoney(value: number) {
  return `${Math.round(value).toLocaleString("ru-RU")} ₽`;
}

function formatDate(value?: Date | null) {
  return value ? value.toLocaleDateString("ru-RU") : "Нет данных";
}

function extractStockDate(fileName?: string | null, fallback?: Date | null) {
  const match = fileName?.match(/\d{4}_\d{1,2}_\d{1,2}/)?.[0];

  if (match) {
    const [year, month, day] = match.split("_");
    return `${day.padStart(2, "0")}.${month.padStart(2, "0")}.${year}`;
  }

  return formatDate(fallback);
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function toNumber(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function formatDateInput(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function getDefaultAbcPeriod() {
  const now = new Date();
  const dateTo = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const dateFrom = addUtcDays(dateTo, -30);

  return {
    dateFrom: formatDateInput(dateFrom),
    dateTo: formatDateInput(dateTo),
  };
}

function calculateAbcByPositiveValue<T>(
  rows: T[],
  getValue: (row: T) => number
): Map<T, AbcCategory> {
  const result = new Map<T, AbcCategory>();

  const sorted = [...rows].sort(
    (a, b) => Math.max(0, getValue(b)) - Math.max(0, getValue(a))
  );

  const total = sorted.reduce((sum, row) => sum + Math.max(0, getValue(row)), 0);

  if (total <= 0) {
    for (const row of rows) result.set(row, "C");
    return result;
  }

  let cumulative = 0;

  for (const row of sorted) {
    const positive = Math.max(0, getValue(row));

    if (positive <= 0) {
      result.set(row, "C");
      continue;
    }

    const shareBefore = cumulative / total;
    cumulative += positive;

    if (shareBefore < 0.8) {
      result.set(row, "A");
    } else if (shareBefore < 0.95) {
      result.set(row, "B");
    } else {
      result.set(row, "C");
    }
  }

  return result;
}

function abcBadgeClass(value: AbcCategory) {
  if (value === "A") return "bg-emerald-100 text-emerald-700 ring-emerald-200";
  if (value === "B") return "bg-amber-100 text-amber-700 ring-amber-200";

  return "bg-red-100 text-red-700 ring-red-200";
}

function toAbcCategory(value: unknown): AbcCategory {
  return value === "A" || value === "B" || value === "C" ? value : "C";
}

function AbcBadge({
  value,
  label,
  compact = false,
}: {
  value: AbcCategory;
  label?: string;
  compact?: boolean;
}) {
  return (
    <span
      title="ABC по прибыли за выбранный период"
      className={`inline-flex items-center justify-center rounded-full font-black ring-1 ${abcBadgeClass(
        value
      )} ${
        compact
          ? "h-6 min-w-6 px-1.5 text-[11px]"
          : "h-7 min-w-7 px-2 text-xs"
      }`}
    >
      {label ? `${label} ${value}` : value}
    </span>
  );
}

function getStockAbcMapKey(companyName: unknown, article: unknown) {
  const company = normalizeKey(companyName);
  const normalizedArticle = normalizeKey(article);

  return company && normalizedArticle ? `${company}::${normalizedArticle}` : "";
}

function registerStockAbc(
  map: Map<string, StockAbcInfo>,
  params: {
    companyName?: string | null;
    article?: string | null;
    abc: StockAbcInfo;
  }
) {
  const article = normalizeKey(params.article);

  if (!article) return;

  const companyKey = getStockAbcMapKey(params.companyName, article);

  if (companyKey && !map.has(companyKey)) {
    map.set(companyKey, params.abc);
  }

  if (!map.has(article)) {
    map.set(article, params.abc);
  }
}

function findStockAbc(
  map: Map<string, StockAbcInfo>,
  params: {
    companyName?: string | null;
    articles: Array<string | null | undefined>;
  }
) {
  for (const article of params.articles) {
    const normalizedArticle = normalizeKey(article);

    if (!normalizedArticle) continue;

    const companyKey = getStockAbcMapKey(params.companyName, normalizedArticle);
    const companyValue = companyKey ? map.get(companyKey) : null;

    if (companyValue) return companyValue;

    const globalValue = map.get(normalizedArticle);

    if (globalValue) return globalValue;
  }

  return null;
}

function rowCompanyName(value: unknown, fallback: string | null) {
  return normalizeKey((value as { companyName?: string | null })?.companyName) || fallback;
}



function normalizeKey(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeArticleForMatch(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[\s\-_/\\.]+/g, "")
    .trim();
}

function getSupplierArticleRoot(value: unknown) {
  const vendorCode = normalizeKey(value);

  if (!vendorCode) return "";

  return vendorCode.split("-")[0]?.trim() ?? vendorCode;
}

function getSupplierArticleCandidates(value: unknown) {
  const vendorCode = normalizeKey(value);

  if (!vendorCode) return [];

  const candidates = new Set<string>();
  candidates.add(vendorCode);

  const parts = vendorCode.split("-").map((part) => part.trim()).filter(Boolean);

  if (parts.length > 1) {
    for (let length = parts.length - 1; length >= 1; length--) {
      candidates.add(parts.slice(0, length).join("-"));
    }
  }

  candidates.add(getSupplierArticleRoot(vendorCode));

  return Array.from(candidates).filter(Boolean);
}

function findCostBySupplierArticle(value: unknown, costs: CostLookup) {
  const candidates = getSupplierArticleCandidates(value);

  for (const candidate of candidates) {
    const exact = costs.bySupplierArticle.get(candidate);

    if (exact !== undefined) return exact;

    const compact = costs.bySupplierArticleCompact.get(normalizeArticleForMatch(candidate));

    if (compact !== undefined) return compact;

    const root = getSupplierArticleRoot(candidate);
    const rootExact = costs.bySupplierArticleRoot.get(root);

    if (rootExact !== undefined) return rootExact;

    const rootCompact = costs.bySupplierArticleRootCompact.get(normalizeArticleForMatch(root));

    if (rootCompact !== undefined) return rootCompact;
  }

  return undefined;
}

function getCompanyArticleKey(companyName: unknown, wbArticle: unknown) {
  const company = normalizeKey(companyName);
  const article = normalizeKey(wbArticle);

  return company && article ? `${company}::${article}` : "";
}

function getMarketplaceBaseArticle(value: unknown) {
  const article = normalizeKey(value);

  if (!article) return "";

  const baseArticle = article.split("-")[0]?.trim() ?? article;

  return /^\d+$/.test(baseArticle) ? baseArticle : "";
}

function registerUniqueArticleCompany(
  map: Map<string, string | null>,
  article: unknown,
  companyName: unknown
) {
  const company = normalizeKey(companyName);

  if (!company) return;

  for (const articleKey of getSupplyArticleCandidates(article)) {
    const existingCompany = map.get(articleKey);

    if (existingCompany === undefined) {
      map.set(articleKey, company);
      continue;
    }

    if (existingCompany !== company) {
      map.set(articleKey, null);
    }
  }
}

function findUniqueCompanyByArticle(
  map: Map<string, string | null>,
  article: unknown
) {
  for (const articleKey of getSupplyArticleCandidates(article)) {
    const company = map.get(articleKey);

    if (company) return company;
  }

  return null;
}

function findSupplierArticleByWbArticle(params: {
  companyName?: string | null;
  wbArticle: unknown;
  costs: CostLookup;
}) {
  const wbArticle = normalizeKey(params.wbArticle);

  if (!wbArticle) return null;

  const companyKey = getCompanyArticleKey(params.companyName, wbArticle);

  return (
    (companyKey
      ? params.costs.supplierArticleByCompanyAndWbArticle.get(companyKey)
      : undefined) ??
    params.costs.supplierArticleByWbArticle.get(wbArticle) ??
    null
  );
}

function findCostByMappedWbArticle(params: {
  companyName?: string | null;
  wbArticle: unknown;
  costs: CostLookup;
}) {
  const supplierArticle = findSupplierArticleByWbArticle({
    companyName: params.companyName,
    wbArticle: params.wbArticle,
    costs: params.costs,
  });

  if (!supplierArticle) return undefined;

  return findCostBySupplierArticle(supplierArticle, params.costs);
}

function getCostPrice(params: {
  companyName?: string | null;
  vendorCode: string | null | undefined;
  nmId?: string | null;
  sku?: string | null;
  ownCostPrice?: unknown;
  costs: CostLookup;
}) {
  const ownCostPrice = toNumber(params.ownCostPrice);

  if (ownCostPrice > 0) return ownCostPrice;

  // 1) Для WB vendorCode обычно является артикулом поставщика WB.
  const supplierArticleCost = findCostBySupplierArticle(
    params.vendorCode,
    params.costs
  );

  if (supplierArticleCost !== undefined) return supplierArticleCost;

  const nmId = normalizeKey(params.nmId);
  const sku = normalizeKey(params.sku);
  const marketplaceBaseArticle = getMarketplaceBaseArticle(params.vendorCode);

  // 2) Если есть WB-артикул / nmId, ищем артикул поставщика WB и через него себестоимость.
  const costByNmIdMapping = findCostByMappedWbArticle({
    companyName: params.companyName,
    wbArticle: nmId,
    costs: params.costs,
  });

  if (costByNmIdMapping !== undefined) return costByNmIdMapping;

  // 3) Для Ozon-артикулов вида 914803449-134 или 233693455-152-44
  // берём базу до первого тире и сопоставляем её с WB-артикулом.
  const costByOzonBaseMapping = findCostByMappedWbArticle({
    companyName: params.companyName,
    wbArticle: marketplaceBaseArticle,
    costs: params.costs,
  });

  if (costByOzonBaseMapping !== undefined) return costByOzonBaseMapping;

  return (
    (nmId ? params.costs.byNmId.get(nmId) : undefined) ??
    (sku ? params.costs.byNmId.get(sku) : undefined) ??
    findCostBySupplierArticle(nmId, params.costs) ??
    findCostBySupplierArticle(sku, params.costs) ??
    0
  );
}

function normalizeSearchValue(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[\s\-_/\\.]+/g, "")
    .trim();
}

function rowMatchesSearch(row: UnifiedStockRow, query: string) {
  const normalizedQuery = normalizeSearchValue(query);

  if (!normalizedQuery) return true;

  const fields = [
    row.productName,
    row.vendorCode,
    row.sku,
    row.nmId,
    row.barcode,
    row.size,
    row.companyName,
    row.source,
    row.warehouseName,
    row.clusterName,
  ];

  const textHaystack = fields
    .map((field) => String(field ?? "").toLowerCase().replaceAll("ё", "е"))
    .join(" ");

  const compactHaystack = normalizeSearchValue(fields.join(" "));

  return (
    textHaystack.includes(String(query).toLowerCase().replaceAll("ё", "е")) ||
    compactHaystack.includes(normalizedQuery)
  );
}

function normalizeSupplyArticle(value: unknown) {
  return normalizeArticleForMatch(value);
}

function normalizeSupplySize(value: unknown) {
  return normalizeSearchValue(value);
}

function getSupplyArticleCandidates(value: unknown) {
  const vendorCode = normalizeKey(value);

  if (!vendorCode) return [];

  const candidates = new Set<string>();
  candidates.add(vendorCode);

  const baseArticle = getMarketplaceBaseArticle(vendorCode);
  if (baseArticle) candidates.add(baseArticle);

  const rootArticle = getSupplierArticleRoot(vendorCode);
  if (rootArticle) candidates.add(rootArticle);

  return Array.from(candidates)
    .map((candidate) => normalizeSupplyArticle(candidate))
    .filter(Boolean);
}
function getOzonSupplyCoverageKey(params: {
  companyName?: string | null;
  article?: string | null;
}) {
  const companyKey = normalizeSearchValue(params.companyName);
  const articleKey = normalizeSupplyArticle(params.article);

  return companyKey && articleKey ? `${companyKey}::${articleKey}` : "";
}

function getInclusiveDateRangeDays(dateFrom: string, dateTo: string) {
  const fromTime = new Date(`${dateFrom}T00:00:00.000Z`).getTime();
  const toTime = new Date(`${dateTo}T00:00:00.000Z`).getTime();

  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime)) return 28;

  const days = Math.floor((toTime - fromTime) / (24 * 60 * 60 * 1000)) + 1;

  return Math.max(1, days);
}

function getOzonCalculatedTargetDays(abc: AbcCategory) {
  if (abc === "A") return 21;
  if (abc === "B") return 14;
  return 7;
}

function getWbConservativeTargetQty(abc: AbcCategory) {
  if (abc === "A") return 36;
  if (abc === "B") return 20;
  return 0;
}

function getWbGeoTargetDays(abc: AbcCategory) {
  if (abc === "A") return 14;
  if (abc === "B") return 7;
  return 0;
}

function getWbGeoConfidenceMultiplier(observedDays: number) {
  if (observedDays >= 30) return 1;
  if (observedDays >= 14) return 0.85;
  if (observedDays >= 7) return 0.7;
  return 0.5;
}

function getWbGeoSupplyKey(params: {
  companyName?: string | null;
  article?: string | null;
  size?: string | null;
  warehouseName?: string | null;
}) {
  const companyKey = normalizeSearchValue(params.companyName);
  const articleKey = normalizeSupplyArticle(params.article);
  const sizeKey = normalizeSupplySize(params.size);
  const warehouseKey = normalizeSearchValue(params.warehouseName);

  return companyKey && articleKey && warehouseKey
    ? `${companyKey}::${articleKey}::${sizeKey}::${warehouseKey}`
    : "";
}

function compactList(values: Iterable<string>, limit = 5) {
  const list = Array.from(values).filter(Boolean);

  if (list.length === 0) return "нет данных";

  const shown = list.slice(0, limit).join(", ");
  const hidden = list.length - limit;

  return hidden > 0 ? `${shown} + ещё ${hidden}` : shown;
}

function formatDecimal(value: number) {
  return value.toLocaleString("ru-RU", {
    maximumFractionDigits: 2,
  });
}


function supplyPriorityWeight(priority: SupplyPlanPriority) {
  if (priority === "HIGH") return 3;
  if (priority === "MEDIUM") return 2;
  return 1;
}

function getSupplyPriority(params: {
  wantedQty: number;
  ownAvailableQty: number;
  currentQty: number;
  abc: StockAbcInfo | null;
  daysWithoutStock?: number | null;
}) {
  if (params.wantedQty <= 0) return "LOW";

  const abc = params.abc?.abcByProfit ?? "C";

  if (params.ownAvailableQty <= 0) {
    return abc === "A" && params.currentQty <= 2 ? "MEDIUM" : "LOW";
  }

  if (
    abc === "A" ||
    params.currentQty <= 2 ||
    toNumber(params.daysWithoutStock) > 0
  ) {
    return "HIGH";
  }

  if (abc === "B") return "MEDIUM";

  return "LOW";
}

function priorityBadgeClass(priority: SupplyPlanPriority) {
  if (priority === "HIGH") return "bg-red-50 text-red-700 ring-red-100";
  if (priority === "MEDIUM") return "bg-amber-50 text-amber-700 ring-amber-100";

  return "bg-slate-50 text-slate-600 ring-slate-200";
}

function priorityLabel(priority: SupplyPlanPriority) {
  if (priority === "HIGH") return "Высокий";
  if (priority === "MEDIUM") return "Средний";

  return "Низкий";
}

function marketplaceSupplyClass(marketplace: SupplyPlanMarketplace) {
  if (marketplace === "WB") return "bg-violet-50 text-violet-700 ring-violet-100";

  return "bg-blue-50 text-blue-700 ring-blue-100";
}

function getSelectedProduct(value?: string) {
  if (!value || value === "ALL") return "";
  return normalizeKey(value);
}

function getSelectedSource(value?: string): StockSource {
  if (value === "WB" || value === "OZON" || value === "OWN") return value;
  return "ALL";
}

function getRowsLimit(value?: string) {
  const parsed = Number(value ?? 20);
  return [20, 50, 100, 200].includes(parsed) ? parsed : 20;
}

function getSortKey(value?: string): SortKey {
  if (
    value === "product" ||
    value === "vendorCode" ||
    value === "qty" ||
    value === "costPrice" ||
    value === "totalCost" ||
    value === "availableForSupplyQty"
  ) {
    return value;
  }

  return "qty";
}

function getSortDir(value?: string) {
  if (value === "asc" || value === "desc") return value;

  return "desc";
}

function getLatestImportDateByCompany(params: {
  companyName: string;
  reportType: string;
  imports: Array<{
    companyName: string | null;
    reportType: string;
    fileName: string;
    createdAt: Date;
  }>;
}) {
  const latest = params.imports.find((item) => {
    return (
      item.companyName === params.companyName &&
      item.reportType === params.reportType
    );
  });

  if (!latest) return "Нет данных";

  return params.reportType === "WB_STOCK"
    ? extractStockDate(latest.fileName, latest.createdAt)
    : formatDate(latest.createdAt);
}

function getProductVisual(params: {
  vendorCode: string;
  sku: string | null;
  nmId: string | null;
  ozonProductByVendorCode: Map<string, ProductVisual>;
  ozonProductBySku: Map<string, ProductVisual>;
  wbProductByVendorCode: Map<string, ProductVisual>;
  wbProductByNmId: Map<string, ProductVisual>;
  warehouseProductByVendorCode: Map<string, ProductVisual>;
}) {
  const vendorCode = normalizeKey(params.vendorCode);
  const sku = normalizeKey(params.sku);
  const nmId = normalizeKey(params.nmId);

  return (
    (sku ? params.ozonProductBySku.get(sku) : null) ??
    (nmId ? params.wbProductByNmId.get(nmId) : null) ??
    params.ozonProductByVendorCode.get(vendorCode) ??
    params.wbProductByVendorCode.get(vendorCode) ??
    params.warehouseProductByVendorCode.get(vendorCode) ?? {
      name: null,
      imageUrl: null,
    }
  );
}

function sourceLabel(source: UnifiedStockRow["source"]) {
  if (source === "WB") return "WB";
  if (source === "OZON") return "Ozon";
  return "Склад";
}

function sourceClass(source: UnifiedStockRow["source"]) {
  if (source === "WB") return "bg-violet-50 text-violet-700 ring-violet-100";
  if (source === "OZON") return "bg-blue-50 text-blue-700 ring-blue-100";
  return "bg-emerald-50 text-emerald-700 ring-emerald-100";
}

function productTitle(row: UnifiedStockRow) {
  return row.productName ?? row.vendorCode;
}

function rawStockPlace(row: UnifiedStockRow) {
  return row.clusterName ?? row.warehouseName ?? "—";
}

function compactStockPlace(row: UnifiedStockRow) {
  const place = rawStockPlace(row);

  if (place === "SHIPMENT_TYPE_GENERAL") return "Ozon · общий";
  if (place === "SHIPMENT_TYPE_CROSSDOCK") return "Ozon · кросс-док";
  if (place === "SHIPMENT_TYPE_DIRECT") return "Ozon · прямой";
  if (place === "__TOTAL__") return "WB";

  return place;
}

function inferSizeFromVendorCode(value: unknown) {
  const vendorCode = normalizeKey(value);

  if (!vendorCode || !vendorCode.includes("-")) return null;

  const parts = vendorCode
    .split("-")
    .map((part) => part.trim())
    .filter(Boolean);

  const numericTail: string[] = [];

  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];

    if (!/^\d{2,3}$/.test(part)) break;

    numericTail.unshift(part);

    if (numericTail.length >= 2) break;
  }

  if (numericTail.length === 0) return null;

  return numericTail.join(" / ");
}

function getDisplaySize(row: UnifiedStockRow) {
  return normalizeKey(row.size) || inferSizeFromVendorCode(row.vendorCode);
}

function getUnifiedMarketplaceArticle(row: UnifiedStockRow) {
  if (row.source === "WB") {
    const nmId = normalizeKey(row.nmId);

    if (nmId) return nmId;
  }

  const marketplaceBaseArticle = getMarketplaceBaseArticle(row.vendorCode);

  if (marketplaceBaseArticle) return marketplaceBaseArticle;

  const vendorCode = normalizeKey(row.vendorCode);

  if (vendorCode && vendorCode !== "—") return vendorCode;

  return normalizeKey(row.productName);
}

function getProductGroupKey(row: UnifiedStockRow) {
  const company = normalizeKey(row.companyName);
  const unifiedArticle = getUnifiedMarketplaceArticle(row);

  return `${company}::${unifiedArticle}`;
}

function getProductSizeLabel(row: UnifiedStockRow) {
  return getDisplaySize(row) ?? "Без размера";
}

function emptyProductSizeSourceSummary(): ProductSizeSourceSummary {
  return {
    totalQty: 0,
    totalCost: 0,
    sizes: [],
    abc: null,
  };
}

function addSizeToSourceSummary(
  source: ProductSizeSourceSummary,
  params: {
    size: string;
    qty: number;
    totalCost: number;
  }
) {
  source.totalQty += params.qty;
  source.totalCost += params.totalCost;

  let sizeRow = source.sizes.find((item) => item.size === params.size);

  if (!sizeRow) {
    sizeRow = {
      size: params.size,
      qty: 0,
      totalCost: 0,
    };

    source.sizes.push(sizeRow);
  }

  sizeRow.qty += params.qty;
  sizeRow.totalCost += params.totalCost;
}

function sortSizeRows(rows: ProductSizeRow[]) {
  return rows.sort((a, b) => {
    const aNumber = Number(String(a.size).match(/\d+/)?.[0] ?? 0);
    const bNumber = Number(String(b.size).match(/\d+/)?.[0] ?? 0);

    if (a.size === "Без размера") return 1;
    if (b.size === "Без размера") return -1;
    if (aNumber !== bNumber) return aNumber - bNumber;

    return a.size.localeCompare(b.size, "ru", {
      numeric: true,
      sensitivity: "base",
    });
  });
}

function getProductSummaryTotal(group: ProductSizeSummary) {
  return group.wb.totalQty + group.ozon.totalQty + group.own.totalQty;
}

function buildProductSizeSummaries(rows: UnifiedStockRow[]) {
  const groups = new Map<string, ProductSizeSummary>();

  for (const row of rows) {
    const key = getProductGroupKey(row);
    const size = getProductSizeLabel(row);
    const marketplaceArticle = getUnifiedMarketplaceArticle(row);

    const current =
      groups.get(key) ??
      ({
        groupKey: key,
        marketplaceArticle,
        vendorCode:
          row.source === "OZON" && marketplaceArticle
            ? marketplaceArticle
            : row.vendorCode,
        productName: row.productName,
        imageUrl: row.imageUrl,
        companyName: row.companyName,
        wb: emptyProductSizeSourceSummary(),
        ozon: emptyProductSizeSourceSummary(),
        own: emptyProductSizeSourceSummary(),
        lowSizeCount: 0,
        missingSizeCount: 0,
      } satisfies ProductSizeSummary);

    if (!current.productName && row.productName) {
      current.productName = row.productName;
    }

    if (!current.imageUrl && row.imageUrl) {
      current.imageUrl = row.imageUrl;
    }

    if (!current.marketplaceArticle && marketplaceArticle) {
      current.marketplaceArticle = marketplaceArticle;
    }

    if (!getDisplaySize(row)) {
      current.missingSizeCount += 1;
    }

    const source =
      row.source === "WB"
        ? current.wb
        : row.source === "OZON"
          ? current.ozon
          : current.own;

    if (!source.abc && row.abc) {
      source.abc = row.abc;
    }

    addSizeToSourceSummary(source, {
      size,
      qty: row.qty,
      totalCost: row.totalCost,
    });

    groups.set(key, current);
  }

  return Array.from(groups.values()).map((group) => {
    const wbSizes = sortSizeRows(group.wb.sizes);
    const ozonSizes = sortSizeRows(group.ozon.sizes);
    const ownSizes = sortSizeRows(group.own.sizes);
    const allSourceSizes = [...wbSizes, ...ozonSizes, ...ownSizes];

    return {
      ...group,
      wb: {
        ...group.wb,
        sizes: wbSizes,
      },
      ozon: {
        ...group.ozon,
        sizes: ozonSizes,
      },
      own: {
        ...group.own,
        sizes: ownSizes,
      },
      lowSizeCount: allSourceSizes.filter(
        (size) => size.size !== "Без размера" && size.qty > 0 && size.qty < 10
      ).length,
    };
  });
}

function getSizeSummaryRowsLimit(value: string | undefined, totalRows: number) {
  if (value === "ALL") return totalRows;

  const parsed = Number(value ?? 20);

  return [8, 20, 50, 100, 200].includes(parsed) ? parsed : 20;
}

function getSizeSummarySort(value?: string): SizeSummarySortKey {
  if (
    value === "totalDesc" ||
    value === "totalAsc" ||
    value === "wbDesc" ||
    value === "ozonDesc" ||
    value === "ownDesc" ||
    value === "lowDesc" ||
    value === "nameAsc"
  ) {
    return value;
  }

  return "totalDesc";
}

function sortProductSizeSummaries(
  groups: ProductSizeSummary[],
  sortKey: SizeSummarySortKey
) {
  return [...groups].sort((a, b) => {
    if (sortKey === "totalAsc") {
      return getProductSummaryTotal(a) - getProductSummaryTotal(b);
    }

    if (sortKey === "wbDesc") {
      return b.wb.totalQty - a.wb.totalQty;
    }

    if (sortKey === "ozonDesc") {
      return b.ozon.totalQty - a.ozon.totalQty;
    }

    if (sortKey === "ownDesc") {
      return b.own.totalQty - a.own.totalQty;
    }

    if (sortKey === "lowDesc") {
      return b.lowSizeCount - a.lowSizeCount;
    }

    if (sortKey === "nameAsc") {
      return (a.productName ?? a.vendorCode).localeCompare(
        b.productName ?? b.vendorCode,
        "ru",
        {
          numeric: true,
          sensitivity: "base",
        }
      );
    }

    return getProductSummaryTotal(b) - getProductSummaryTotal(a);
  });
}


type StockFallbackAbcGroup = {
  source: "WB" | "OZON";
  companyName: string;
  article: string;
  value: number;
  rows: UnifiedStockRow[];
};

function buildFallbackStockAbcMap(rows: UnifiedStockRow[]) {
  const map = new Map<string, StockAbcInfo>();
  const groups = new Map<string, StockFallbackAbcGroup>();

  for (const row of rows) {
    if (row.source !== "WB" && row.source !== "OZON") continue;
    if (row.abc) continue;

    const article = getUnifiedMarketplaceArticle(row);
    const companyName = normalizeKey(row.companyName);

    if (!article || !companyName) continue;

    const key = `${row.source}::${companyName}::${article}`;
    const current =
      groups.get(key) ??
      ({
        source: row.source,
        companyName,
        article,
        value: 0,
        rows: [],
      } satisfies StockFallbackAbcGroup);

    current.value += Math.max(0, row.totalCost || row.qty || 0);
    current.rows.push(row);

    groups.set(key, current);
  }

  for (const source of ["WB", "OZON"] as const) {
    const sourceGroups = Array.from(groups.values()).filter(
      (group) => group.source === source
    );

    const abcByValue = calculateAbcByPositiveValue(
      sourceGroups,
      (group) => group.value
    );

    for (const group of sourceGroups) {
      const abc = {
        abcByRevenue: abcByValue.get(group) ?? "C",
        abcByProfit: abcByValue.get(group) ?? "C",
      } satisfies StockAbcInfo;

      registerStockAbc(map, {
        companyName: group.companyName,
        article: group.article,
        abc,
      });

      for (const row of group.rows) {
        registerStockAbc(map, {
          companyName: row.companyName,
          article: row.vendorCode,
          abc,
        });

        registerStockAbc(map, {
          companyName: row.companyName,
          article: row.sku,
          abc,
        });

        registerStockAbc(map, {
          companyName: row.companyName,
          article: row.nmId,
          abc,
        });
      }
    }
  }

  return map;
}

function sizeChipClass(qty: number, size: string) {
  if (size === "Без размера") {
    return "bg-amber-50 text-amber-700 ring-amber-100";
  }

  if (qty <= 0) {
    return "bg-rose-50 text-rose-700 ring-rose-100";
  }

  if (qty < 10) {
    return "bg-amber-50 text-amber-700 ring-amber-100";
  }

  return "bg-white text-slate-700 ring-slate-200";
}

function sourcePanelClass(source: "WB" | "OZON" | "OWN") {
  if (source === "WB") return "bg-violet-50 ring-violet-100";
  if (source === "OZON") return "bg-blue-50 ring-blue-100";

  return "bg-emerald-50 ring-emerald-100";
}

function sourceTitleClass(source: "WB" | "OZON" | "OWN") {
  if (source === "WB") return "text-violet-700";
  if (source === "OZON") return "text-blue-700";

  return "text-emerald-700";
}

function ProductSizeSourcePanel({
  title,
  source,
  sourceKey,
}: {
  title: string;
  source: ProductSizeSourceSummary;
  sourceKey: "WB" | "OZON" | "OWN";
}) {
  return (
    <div
      className={`rounded-2xl px-3 py-2.5 ring-1 ${sourcePanelClass(
        sourceKey
      )}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div
          className={`text-[10px] font-black uppercase tracking-[0.12em] ${sourceTitleClass(
            sourceKey
          )}`}
        >
          {title}
        </div>

        <div className="flex items-center gap-2">
          {source.abc && source.totalQty > 0 ? (
            <AbcBadge value={source.abc.abcByProfit} compact />
          ) : null}

          <div className="text-right">
            <div className="text-sm font-black text-slate-950">
              {formatNumber(source.totalQty)} шт.
            </div>
            <div className="mt-0.5 text-[11px] font-black text-slate-500">
              {formatMoney(source.totalCost)}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {source.sizes.length > 0 ? (
          source.sizes.slice(0, 12).map((size) => (
            <span
              key={`${sourceKey}-${size.size}`}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-black ring-1 ${sizeChipClass(
                size.qty,
                size.size
              )}`}
              title={`${title}: ${size.size} — ${formatNumber(size.qty)} шт.`}
            >
              <span>{size.size}</span>
              <span>·</span>
              <span>{formatNumber(size.qty)}</span>
            </span>
          ))
        ) : (
          <span className="inline-flex rounded-full bg-white px-2 py-1 text-[11px] font-black text-slate-400 ring-1 ring-slate-200">
            нет остатка
          </span>
        )}

        {source.sizes.length > 12 ? (
          <span className="inline-flex rounded-full bg-white px-2 py-1 text-[11px] font-black text-slate-500 ring-1 ring-slate-200">
            +{formatNumber(source.sizes.length - 12)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ProductSizeSummaryCard({ group }: { group: ProductSizeSummary }) {
  return (
    <article className="rounded-[22px] border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex items-start gap-3">
        <ProductPhoto
          imageUrl={group.imageUrl}
          title={group.productName ?? group.vendorCode}
        />

        <div className="min-w-0 flex-1">
          <div className="line-clamp-1 text-sm font-black leading-5 text-slate-950">
            {group.productName ?? "Название не загружено"}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-black text-slate-500">
            <span className="break-all">Связка: {group.marketplaceArticle}</span>
            <span>{group.companyName}</span>
          </div>
        </div>
      </div>

      <div className="mt-3 grid gap-2 lg:grid-cols-3">
        <ProductSizeSourcePanel title="WB" source={group.wb} sourceKey="WB" />
        <ProductSizeSourcePanel
          title="Ozon"
          source={group.ozon}
          sourceKey="OZON"
        />
        <ProductSizeSourcePanel
          title="Склад"
          source={group.own}
          sourceKey="OWN"
        />
      </div>

      {group.lowSizeCount > 0 || group.missingSizeCount > 0 ? (
        <div className="mt-2 rounded-2xl bg-amber-50 px-3 py-2 text-[11px] font-bold leading-4 text-amber-800 ring-1 ring-amber-100">
          {group.lowSizeCount > 0
            ? `Низкий остаток: ${formatNumber(group.lowSizeCount)} размер(а).`
            : null}{" "}
          {group.missingSizeCount > 0
            ? `Без размера: ${formatNumber(group.missingSizeCount)} строк.`
            : null}
        </div>
      ) : null}
    </article>
  );
}

function makeUrl(params: StockSearchParams, patch: Record<string, string | null | undefined>) {
  const next = new URLSearchParams();

  const merged: Record<string, string | undefined> = {
    companyName: params.companyName,
    source: params.source,
    rows: params.rows,
    sort: params.sort,
    dir: params.dir,
    product: params.product,
    q: params.q,
    sizeRows: params.sizeRows,
    sizeSort: params.sizeSort,
    sizeOpen: params.sizeOpen,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    supplyOpen: params.supplyOpen,
    supplyMarketplace: params.supplyMarketplace,
    supplyTarget: params.supplyTarget,
    supplyAbc: params.supplyAbc,
    supplyPriority: params.supplyPriority,
    supplyRows: params.supplyRows,
    supplyQ: params.supplyQ,
    productionOpen: params.productionOpen,
    productionBufferDays: params.productionBufferDays,
    productionRows: params.productionRows,
    productionAbc: params.productionAbc,
  };

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
    } else if (value !== undefined) {
      merged[key] = value;
    }
  }

  for (const [key, value] of Object.entries(merged)) {
    if (value && value !== "ALL") {
      next.set(key, value);
    }
  }

  const query = next.toString();
  return query ? `/stocks?${query}` : "/stocks";
}

function sortHref(params: StockSearchParams, key: SortKey) {
  const currentKey = getSortKey(params.sort);
  const currentDir = getSortDir(params.dir);
  const nextDir = currentKey === key && currentDir === "asc" ? "desc" : "asc";

  return makeUrl(params, {
    sort: key,
    dir: nextDir,
  });
}

function SortHeader({
  params,
  sortKey,
  children,
  align = "left",
}: {
  params: StockSearchParams;
  sortKey: SortKey;
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  const active = getSortKey(params.sort) === sortKey;
  const dir = getSortDir(params.dir);

  return (
    <Link
      href={sortHref(params, sortKey)}
      className={`inline-flex items-center gap-1 ${
        align === "right" ? "justify-end" : "justify-start"
      } ${active ? "text-slate-950" : "text-slate-400"}`}
    >
      <span>{children}</span>
      <span className="text-[10px]">{active ? (dir === "asc" ? "↑" : "↓") : "↕"}</span>
    </Link>
  );
}

function MetricCard({
  title,
  value,
  money,
  hint,
  tone,
  icon,
}: {
  title: string;
  value: string;
  money: string;
  hint: string;
  tone: "violet" | "blue" | "emerald" | "amber";
  icon: string;
}) {
  const classes = {
    violet: "border-violet-100 bg-violet-50 text-violet-700",
    blue: "border-blue-100 bg-blue-50 text-blue-700",
    emerald: "border-emerald-100 bg-emerald-50 text-emerald-700",
    amber: "border-amber-100 bg-amber-50 text-amber-700",
  };

  return (
    <div className={`rounded-[26px] border p-5 shadow-sm ${classes[tone]}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs font-black uppercase tracking-[0.12em]">
            {title}
          </div>
          <div className="mt-3 text-3xl font-black tracking-tight text-slate-950">
            {value}
          </div>
          <div className="mt-2 text-base font-black text-slate-800">
            {money}
          </div>
        </div>

        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/70 text-base font-black ring-1 ring-white/70">
          {icon}
        </div>
      </div>

      <div className="mt-3 text-sm font-semibold leading-5 text-slate-600">
        {hint}
      </div>
    </div>
  );
}

function ProductPhoto({ imageUrl, title }: { imageUrl: string | null; title: string }) {
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={title}
        className="h-14 w-14 rounded-2xl border border-slate-200 bg-slate-50 object-cover"
      />
    );
  }

  return (
    <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-xs font-black text-slate-400">
      фото
    </div>
  );
}

function CompactAttention({
  lowStockCount,
  ownWarehouseMissingCount,
  reservedQty,
}: {
  lowStockCount: number;
  ownWarehouseMissingCount: number;
  reservedQty: number;
}) {
  return (
    <aside className="rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-amber-50 text-base ring-1 ring-amber-100">
          ⚠️
        </div>
        <div>
          <h2 className="text-lg font-black text-slate-950">
            Что требует внимания
          </h2>
          <p className="text-xs font-semibold text-slate-500">
            Короткие подсказки
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <div className="rounded-2xl bg-amber-50 p-3 ring-1 ring-amber-100">
          <div className="text-sm font-black text-slate-950">Низкий остаток</div>
          <p className="mt-1 text-xs font-semibold leading-5 text-slate-600">
            {lowStockCount > 0
              ? `${formatNumber(lowStockCount)} позиций меньше 10 шт.`
              : "Критичных низких остатков в выборке нет."}
          </p>
        </div>

        <div className="rounded-2xl bg-blue-50 p-3 ring-1 ring-blue-100">
          <div className="text-sm font-black text-slate-950">Собственный склад</div>
          <p className="mt-1 text-xs font-semibold leading-5 text-slate-600">
            {ownWarehouseMissingCount > 0
              ? `${formatNumber(
                  ownWarehouseMissingCount
                )} компаний без загруженного своего склада.`
              : "Складские остатки загружены."}
          </p>
        </div>

        <div className="rounded-2xl bg-violet-50 p-3 ring-1 ring-violet-100">
          <div className="text-sm font-black text-slate-950">Резерв</div>
          <p className="mt-1 text-xs font-semibold leading-5 text-slate-600">
            В резерве {formatNumber(reservedQty)} шт. Проверьте, не блокирует ли
            он поставки.
          </p>
        </div>
      </div>
    </aside>
  );
}

function getSupplyMarketplaceFilter(value?: string): "ALL" | SupplyPlanMarketplace {
  if (value === "WB" || value === "OZON") return value;
  return "ALL";
}

function getSupplyPriorityFilter(value?: string): "ALL" | SupplyPlanPriority {
  if (value === "HIGH" || value === "MEDIUM" || value === "LOW") return value;
  return "ALL";
}

function getSupplyAbcFilter(value?: string): "ALL" | AbcCategory {
  if (value === "A" || value === "B" || value === "C") return value;
  return "ALL";
}

function getSupplyRowsLimit(value: string | undefined, totalRows: number) {
  if (value === "ALL") return totalRows;

  const parsed = Number(value ?? 20);

  return [20, 50, 100, 200].includes(parsed) ? parsed : 20;
}

function supplyPlanMatchesSearch(row: SupplyPlanRow, query: string) {
  const normalizedQuery = normalizeSearchValue(query);

  if (!normalizedQuery) return true;

  const fields = [
    row.productName,
    row.vendorCode,
    row.sku,
    row.size,
    row.companyName,
    row.targetName,
    row.marketplace,
    row.priority,
    row.abc?.abcByProfit,
    row.reason,
    ...row.details,
  ];

  const textHaystack = fields
    .map((field) => String(field ?? "").toLowerCase().replaceAll("ё", "е"))
    .join(" ");

  const compactHaystack = normalizeSearchValue(fields.join(" "));

  return (
    textHaystack.includes(String(query).toLowerCase().replaceAll("ё", "е")) ||
    compactHaystack.includes(normalizedQuery)
  );
}

function getSupplyTargetOptions(
  rows: SupplyPlanRow[],
  marketplaceFilter: "ALL" | SupplyPlanMarketplace
) {
  const filteredRows =
    marketplaceFilter === "ALL"
      ? rows
      : rows.filter((row) => row.marketplace === marketplaceFilter);

  return Array.from(
    new Set(filteredRows.map((row) => row.targetName).filter(Boolean))
  ).sort((a, b) =>
    a.localeCompare(b, "ru", {
      numeric: true,
      sensitivity: "base",
    })
  );
}

function supplySummaryQty(rows: SupplyPlanRow[]) {
  return rows.reduce((sum, row) => sum + Math.max(0, row.recommendedQty), 0);
}

function supplyWantedQty(rows: SupplyPlanRow[]) {
  return rows.reduce((sum, row) => sum + Math.max(0, row.wantedQty), 0);
}

const PRODUCTION_BUFFER_DAY_OPTIONS = [15, 20, 30, 60] as const;
const DEFAULT_PRODUCTION_BUFFER_DAYS = 15;


function getProductionBufferDays(value?: string | null) {
  const parsed = Number(value ?? DEFAULT_PRODUCTION_BUFFER_DAYS);

  return PRODUCTION_BUFFER_DAY_OPTIONS.includes(
    parsed as (typeof PRODUCTION_BUFFER_DAY_OPTIONS)[number]
  )
    ? parsed
    : DEFAULT_PRODUCTION_BUFFER_DAYS;
}

function getProductionRowsLimit(value: string | undefined, totalRows: number) {
  if (value === "ALL") return totalRows;

  const parsed = Number(value ?? 8);

  return [8, 20, 50, 100, 200].includes(parsed) ? parsed : 8;
}

function getProductionAbcFilter(value?: string | string[] | null): "ALL" | AbcCategory {
  const current = Array.isArray(value) ? value[0] : value;

  if (current === "ALL" || current === "A" || current === "B" || current === "C") {
    return current;
  }

  // По умолчанию оставляем самый безопасный режим: к пошиву попадают только ABC A.
  return "A";
}

function getProductionSelectedKeys(value?: string | string[] | null) {
  const rawValues = Array.isArray(value) ? value : value ? [value] : [];

  return new Set(
    rawValues
      .flatMap((item) => String(item).split(","))
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

type ProductionPlanRow = {
  key: string;
  companyName: string;
  vendorCode: string;
  sku: string | null;
  size: string | null;
  productName: string | null;
  imageUrl: string | null;
  marketplaces: SupplyPlanMarketplace[];
  targets: string[];
  abc: StockAbcInfo | null;
  wantedQty: number;
  recommendedQty: number;
  deficitQty: number;
  leadTimeBufferQty: number;
  productionQty: number;
  avgDailySalesQty: number;
};

function getProductionArticleKey(row: SupplyPlanRow) {
  const baseArticle = getMarketplaceBaseArticle(row.vendorCode);
  const rootArticle = getSupplierArticleRoot(row.vendorCode);

  return normalizeSupplyArticle(baseArticle || rootArticle || row.vendorCode || row.sku);
}

function getProductionPlanRows(
  rows: SupplyPlanRow[],
  bufferDays: number,
  abcFilter: "ALL" | AbcCategory = "A"
) {
  const groups = new Map<
    string,
    ProductionPlanRow & {
      marketplaceSet: Set<SupplyPlanMarketplace>;
      targetSet: Set<string>;
    }
  >();

  for (const row of rows) {
    const abcByProfit = row.abc?.abcByProfit ?? "C";

    // По умолчанию план пошива строится по ABC A.
    // При необходимости пользователь может включить B, C или все категории.
    if (abcFilter !== "ALL" && abcByProfit !== abcFilter) continue;

    const deficitQty = Math.max(0, row.wantedQty - row.recommendedQty);

    if (deficitQty <= 0) continue;

    const articleKey = getProductionArticleKey(row);
    const sizeKey = normalizeSupplySize(row.size);

    if (!articleKey) continue;

    const groupKey = `${normalizeSearchValue(row.companyName)}::${articleKey}::${sizeKey}`;
    const avgDailySalesQty = Math.max(0, row.avgDailySalesQty ?? 0);
    const leadTimeBufferQty = Math.ceil(avgDailySalesQty * bufferDays);
    const productionQty = deficitQty + leadTimeBufferQty;
    const current =
      groups.get(groupKey) ??
      ({
        key: groupKey,
        companyName: row.companyName,
        vendorCode: row.vendorCode,
        sku: row.sku,
        size: row.size,
        productName: row.productName,
        imageUrl: row.imageUrl,
        marketplaces: [],
        targets: [],
        abc: row.abc,
        wantedQty: 0,
        recommendedQty: 0,
        deficitQty: 0,
        leadTimeBufferQty: 0,
        productionQty: 0,
        avgDailySalesQty: 0,
        marketplaceSet: new Set<SupplyPlanMarketplace>(),
        targetSet: new Set<string>(),
      } satisfies ProductionPlanRow & {
        marketplaceSet: Set<SupplyPlanMarketplace>;
        targetSet: Set<string>;
      });

    current.marketplaceSet.add(row.marketplace);
    current.targetSet.add(row.targetName);
    current.wantedQty += Math.max(0, row.wantedQty);
    current.recommendedQty += Math.max(0, row.recommendedQty);
    current.deficitQty += deficitQty;
    current.leadTimeBufferQty += leadTimeBufferQty;
    current.productionQty += productionQty;
    current.avgDailySalesQty += avgDailySalesQty;

    if (!current.productName && row.productName) current.productName = row.productName;
    if (!current.imageUrl && row.imageUrl) current.imageUrl = row.imageUrl;
    if (!current.sku && row.sku) current.sku = row.sku;
    if (!current.size && row.size) current.size = row.size;

    groups.set(groupKey, current);
  }

  return Array.from(groups.values())
    .map((row) => ({
      ...row,
      marketplaces: Array.from(row.marketplaceSet).sort(),
      targets: Array.from(row.targetSet).sort((a, b) =>
        a.localeCompare(b, "ru", {
          numeric: true,
          sensitivity: "base",
        })
      ),
    }))
    .sort((a, b) => {
      const bothDiff =
        Number(b.marketplaces.length > 1) - Number(a.marketplaces.length > 1);

      if (bothDiff !== 0) return bothDiff;

      if (b.productionQty !== a.productionQty) {
        return b.productionQty - a.productionQty;
      }

      return b.deficitQty - a.deficitQty;
    });
}

function productionPlanSummaryQty(rows: ProductionPlanRow[]) {
  return rows.reduce((sum, row) => sum + Math.max(0, row.productionQty), 0);
}

function ProductionPlanningBlock({
  rows,
  params,
  companyNames,
}: {
  rows: SupplyPlanRow[];
  params: StockSearchParams;
  companyNames: string[];
}) {
  const productionOpen = params.productionOpen === "1";
  const marketplaceFilter = getSupplyMarketplaceFilter(params.supplyMarketplace);
  const priorityFilter = getSupplyPriorityFilter(params.supplyPriority);
  const supplyAbcFilter = getSupplyAbcFilter(params.supplyAbc);
  const targetFilter = normalizeKey(params.supplyTarget);
  const query = normalizeKey(params.supplyQ);

  const targetOptions = getSupplyTargetOptions(rows, marketplaceFilter);
  const safeTargetFilter =
    targetFilter && targetFilter !== "ALL" && targetOptions.includes(targetFilter)
      ? targetFilter
      : "ALL";

  const filteredRows = rows.filter((row) => {
    if (marketplaceFilter !== "ALL" && row.marketplace !== marketplaceFilter) {
      return false;
    }

    if (priorityFilter !== "ALL" && row.priority !== priorityFilter) {
      return false;
    }

    if (supplyAbcFilter !== "ALL" && row.abc?.abcByProfit !== supplyAbcFilter) {
      return false;
    }

    if (
      safeTargetFilter &&
      safeTargetFilter !== "ALL" &&
      row.targetName !== safeTargetFilter
    ) {
      return false;
    }

    return supplyPlanMatchesSearch(row, query);
  });

  const productionBufferDays = getProductionBufferDays(params.productionBufferDays);
  const productionAbcFilter = getProductionAbcFilter(params.productionAbc);
  const allProductionPlanRows = getProductionPlanRows(
    filteredRows,
    productionBufferDays,
    productionAbcFilter
  );
  const hasCustomProductionSelection = params.productionSelectionMode === "custom";
  const selectedProductionKeys = getProductionSelectedKeys(params.productionSelected);
  const productionPlanRows = hasCustomProductionSelection
    ? allProductionPlanRows.filter((row) => selectedProductionKeys.has(row.key))
    : allProductionPlanRows;
  const productionRowsLimit = getProductionRowsLimit(
    params.productionRows,
    productionPlanRows.length
  );
  const visibleProductionPlanRows = productionPlanRows.slice(0, productionRowsLimit);
  const productionPlanQty = productionPlanSummaryQty(productionPlanRows);
  const topDeficitQty = productionPlanRows
    .slice(0, 10)
    .reduce((sum, row) => sum + Math.max(0, row.productionQty), 0);
  const riskQty = productionPlanRows
    .filter((row) => row.leadTimeBufferQty > 0 && row.leadTimeBufferQty <= row.deficitQty)
    .reduce((sum, row) => sum + Math.max(0, row.productionQty), 0);

  const exportParams = new URLSearchParams();

  if (params.companyName && params.companyName !== "ALL") {
    exportParams.set("companyName", params.companyName);
  }

  if (marketplaceFilter !== "ALL") {
    exportParams.set("supplyMarketplace", marketplaceFilter);
  }

  if (safeTargetFilter && safeTargetFilter !== "ALL") {
    exportParams.set("supplyTarget", safeTargetFilter);
  }

  if (supplyAbcFilter !== "ALL") {
    exportParams.set("supplyAbc", supplyAbcFilter);
  }

  if (priorityFilter !== "ALL") {
    exportParams.set("supplyPriority", priorityFilter);
  }

  if (query) {
    exportParams.set("supplyQ", query);
  }

  if (params.dateFrom) {
    exportParams.set("dateFrom", params.dateFrom);
  }

  if (params.dateTo) {
    exportParams.set("dateTo", params.dateTo);
  }

  function makeProductionExportHref(bufferDays: number) {
    const productionExportParams = new URLSearchParams(exportParams);
    productionExportParams.set("bufferDays", String(bufferDays));
    productionExportParams.set("productionAbc", productionAbcFilter);

    if (hasCustomProductionSelection) {
      productionExportParams.set("productionSelectionMode", "custom");

      for (const key of selectedProductionKeys) {
        productionExportParams.append("productionSelected", key);
      }
    }

    const queryString = productionExportParams.toString();

    return queryString
      ? `/api/stocks/production-plan/export?${queryString}`
      : `/api/stocks/production-plan/export?bufferDays=${bufferDays}`;
  }

  return (
    <section
      id="production-plan"
      className="overflow-hidden rounded-[28px] border border-amber-200 bg-white shadow-sm ring-1 ring-amber-50"
    >
      <div className="p-4 sm:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={makeUrl(params, { productionOpen: productionOpen ? "0" : "1" })}
                className="inline-flex items-center gap-2 rounded-full bg-amber-50 px-3 py-1 text-xs font-black uppercase tracking-[0.12em] text-amber-700 ring-1 ring-amber-100 transition hover:bg-amber-100"
              >
                <span>Пошив</span>
                <span className="text-sm">{productionOpen ? "▲" : "▼"}</span>
              </Link>

              <span className="rounded-full bg-slate-50 px-3 py-1 text-xs font-black text-slate-500 ring-1 ring-slate-200">
                {productionOpen ? "развернут" : "свернут"}
              </span>
            </div>

            <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
              Что нужно заказать в пошив
            </h2>
            <p className="mt-2 max-w-3xl text-sm font-bold leading-6 text-slate-500">
              Рекомендация по дефициту с учётом срока пошива. Буфер можно менять: 15, 20, 30 или 60 дней.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2 sm:min-w-[520px]">
            <div className="rounded-2xl bg-violet-50 p-3 text-center ring-1 ring-violet-100">
              <div className="text-xs font-black uppercase text-violet-600">К пошиву</div>
              <div className="mt-1 text-xl font-black text-slate-950">
                {formatNumber(productionPlanQty)}
              </div>
              <div className="text-[11px] font-bold text-slate-500">шт.</div>
            </div>
            <div className="rounded-2xl bg-blue-50 p-3 text-center ring-1 ring-blue-100">
              <div className="text-xs font-black uppercase text-blue-600">Позиций</div>
              <div className="mt-1 text-xl font-black text-slate-950">
                {formatNumber(productionPlanRows.length)}
              </div>
              <div className="text-[11px] font-bold text-slate-500">товар/размер</div>
            </div>
            <div className="rounded-2xl bg-emerald-50 p-3 text-center ring-1 ring-emerald-100">
              <div className="text-xs font-black uppercase text-emerald-700">Буфер</div>
              <div className="mt-1 text-xl font-black text-slate-950">
                {formatNumber(productionBufferDays)}
              </div>
              <div className="text-[11px] font-bold text-slate-500">дней</div>
            </div>
          </div>
        </div>

        {!productionOpen ? (
          <div className="mt-4 grid gap-2 md:grid-cols-3">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-600">
              Топ-10 дефицитных: <b className="text-slate-950">{formatNumber(topDeficitQty)} шт.</b>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-600">
              Под риском: <b className="text-slate-950">{formatNumber(riskQty)} шт.</b>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-600">
              В норме: <b className="text-slate-950">{formatNumber(Math.max(0, productionPlanQty - topDeficitQty))} шт.</b>
            </div>
          </div>
        ) : null}
      </div>

      {productionOpen ? (
        <div className="border-t border-amber-100 bg-amber-50/60">
          <form
            id="production-plan-form"
            action="/stocks"
            method="GET"
            className="grid gap-3 border-b border-amber-100 p-4 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_1fr_auto_auto] xl:items-end"
          >
            <input type="hidden" name="productionOpen" value="1" />
            <input type="hidden" name="supplyOpen" value={params.supplyOpen ?? "0"} />
            {params.companyName ? <input type="hidden" name="companyName" value={params.companyName} /> : null}
            {params.supplyMarketplace ? <input type="hidden" name="supplyMarketplace" value={params.supplyMarketplace} /> : null}
            {params.supplyTarget ? <input type="hidden" name="supplyTarget" value={params.supplyTarget} /> : null}
            {params.supplyPriority ? <input type="hidden" name="supplyPriority" value={params.supplyPriority} /> : null}
            {params.supplyQ ? <input type="hidden" name="supplyQ" value={params.supplyQ} /> : null}
            {params.dateFrom ? <input type="hidden" name="dateFrom" value={params.dateFrom} /> : null}
            {params.dateTo ? <input type="hidden" name="dateTo" value={params.dateTo} /> : null}

            <label className="block">
              <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.12em] text-amber-500">
                Буфер пошива
              </span>
              <select
                name="productionBufferDays"
                defaultValue={String(productionBufferDays)}
                className="h-11 w-full rounded-2xl border border-amber-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none transition focus:border-amber-300 focus:ring-4 focus:ring-amber-50"
              >
                {PRODUCTION_BUFFER_DAY_OPTIONS.map((days) => (
                  <option key={days} value={days}>
                    {days} дней
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.12em] text-amber-500">
                ABC
              </span>
              <select
                name="productionAbc"
                defaultValue={productionAbcFilter}
                className="h-11 w-full rounded-2xl border border-amber-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none transition focus:border-amber-300 focus:ring-4 focus:ring-amber-50"
              >
                <option value="A">ABC A</option>
                <option value="B">ABC B</option>
                <option value="C">ABC C</option>
                <option value="ALL">Все ABC</option>
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.12em] text-amber-500">
                Строк
              </span>
              <select
                name="productionRows"
                defaultValue={params.productionRows ?? "8"}
                className="h-11 w-full rounded-2xl border border-amber-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none transition focus:border-amber-300 focus:ring-4 focus:ring-amber-50"
              >
                <option value="8">8 строк</option>
                <option value="20">20 строк</option>
                <option value="50">50 строк</option>
                <option value="100">100 строк</option>
                <option value="200">200 строк</option>
                <option value="ALL">Все</option>
              </select>
            </label>

            <button className="h-11 rounded-2xl bg-amber-600 px-5 text-sm font-black text-white shadow-lg shadow-amber-100 transition hover:bg-amber-700">
              Применить
            </button>

            <div className="flex flex-wrap gap-2 xl:col-span-2 xl:justify-end">
              {PRODUCTION_BUFFER_DAY_OPTIONS.map((days) => (
                <Link
                  key={days}
                  href={makeProductionExportHref(days)}
                  className="inline-flex h-11 items-center justify-center rounded-2xl border border-amber-200 bg-white px-4 text-sm font-black text-amber-700 transition hover:bg-amber-50"
                  title={`Скачать Excel-план пошива с фото и буфером ${days} дней`}
                >
                  Excel {days} дн.
                </Link>
              ))}
            </div>
          </form>

          {productionPlanRows.length > 0 ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full table-fixed border-collapse text-left text-xs">
                  <thead className="bg-white/70 text-[10px] font-black uppercase tracking-[0.08em] text-slate-400">
                    <tr>
                      <th className="w-[5%] px-4 py-3">Выбор</th>
                      <th className="w-[27%] px-3 py-3">Товар</th>
                      <th className="w-[8%] px-3 py-3">Размер</th>
                      <th className="w-[12%] px-3 py-3">Каналы</th>
                      <th className="w-[18%] px-3 py-3">Направления</th>
                      <th className="w-[10%] px-3 py-3 text-right">Дефицит</th>
                      <th className="w-[10%] px-3 py-3 text-right">Буфер {productionBufferDays} дн.</th>
                      <th className="w-[8%] px-3 py-3 text-right">К пошиву</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-amber-100 bg-white/40">
                    {visibleProductionPlanRows.map((row) => {
                      const tooltip = [
                        `Компания: ${row.companyName}`,
                        `Артикул: ${row.vendorCode}`,
                        row.sku ? `SKU: ${row.sku}` : null,
                        `Размер: ${row.size ?? "—"}`,
                        `Каналы: ${row.marketplaces.join(" + ")}`,
                        `Дефицит к отгрузке: ${formatNumber(row.deficitQty)} шт.`,
                        `Среднесуточный спрос: ${formatDecimal(row.avgDailySalesQty)} шт/день`,
                        `Буфер на ${formatNumber(productionBufferDays)} дней: ${formatNumber(row.leadTimeBufferQty)} шт.`,
                        `Рекомендация к пошиву: ${formatNumber(row.productionQty)} шт.`,
                      ]
                        .filter(Boolean)
                        .join("\n");

                      return (
                        <tr key={row.key} className="align-middle hover:bg-white/70" title={tooltip}>
                          <td className="px-4 py-3 text-center">
                            <input
                              form="production-plan-form"
                              type="checkbox"
                              name="productionSelected"
                              value={row.key}
                              defaultChecked={!hasCustomProductionSelection || selectedProductionKeys.has(row.key)}
                              className="h-4 w-4 rounded border-amber-300 text-amber-600 focus:ring-amber-500"
                              aria-label={`Выбрать в пошив ${row.vendorCode} ${row.size ?? ""}`}
                            />
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex min-w-0 items-center gap-3">
                              {row.imageUrl ? (
                                <img
                                  src={row.imageUrl}
                                  alt="Фото товара"
                                  className="h-10 w-10 shrink-0 rounded-2xl border border-amber-100 bg-white object-cover"
                                />
                              ) : (
                                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-amber-100 bg-white text-[10px] font-black text-slate-300">
                                  фото
                                </div>
                              )}
                              <div className="min-w-0">
                                <div className="line-clamp-1 font-black text-slate-950">
                                  {row.companyName}
                                </div>
                                <div className="line-clamp-1 break-all text-xs font-black text-slate-600">
                                  {row.vendorCode}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-3 font-black text-slate-700">{row.size ?? "—"}</td>
                          <td className="px-3 py-3">
                            <div className="flex flex-wrap gap-1">
                              {row.marketplaces.map((marketplace) => (
                                <span
                                  key={marketplace}
                                  className={`inline-flex rounded-full px-2 py-1 text-[10px] font-black ring-1 ${marketplaceSupplyClass(marketplace)}`}
                                >
                                  {marketplace === "OZON" ? "Ozon" : "WB"}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            <div className="line-clamp-2 text-xs font-bold leading-4 text-slate-600">
                              {row.targets.slice(0, 3).join(", ")}
                              {row.targets.length > 3 ? ` +${row.targets.length - 3}` : ""}
                            </div>
                          </td>
                          <td className="px-3 py-3 text-right font-black text-slate-800">
                            {formatNumber(row.deficitQty)}
                          </td>
                          <td className="px-3 py-3 text-right font-black text-slate-800">
                            {formatNumber(row.leadTimeBufferQty)}
                          </td>
                          <td className="px-3 py-3 text-right text-base font-black text-amber-700">
                            {formatNumber(row.productionQty)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-col gap-2 border-t border-amber-100 bg-white/50 px-4 py-3 text-xs font-bold text-slate-500 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  Выбрано к пошиву: {formatNumber(productionPlanRows.length)} из {formatNumber(allProductionPlanRows.length)} позиций. По умолчанию все найденные позиции отмечены галками; лишние можно снять и нажать “Применить выбор”.
                </div>
                <button
                  form="production-plan-form"
                  name="productionSelectionMode"
                  value="custom"
                  className="inline-flex h-10 items-center justify-center rounded-2xl border border-amber-200 bg-white px-4 text-sm font-black text-amber-700 transition hover:bg-amber-50"
                >
                  Применить выбор
                </button>
              </div>

              {productionPlanRows.length > visibleProductionPlanRows.length ? (
                <div className="border-t border-amber-100 bg-white/50 px-4 py-3 text-xs font-bold text-slate-500">
                  Показаны первые {formatNumber(visibleProductionPlanRows.length)} позиций из {formatNumber(productionPlanRows.length)}. Измените фильтр “Строк” в блоке пошива или скачайте Excel, чтобы получить полный список.
                </div>
              ) : null}
            </>
          ) : (
            <div className="p-4">
              <h3 className="text-lg font-black text-slate-950">
                Заказывать в пошив пока нечего
              </h3>
              <p className="mt-1 max-w-4xl text-xs font-bold leading-5 text-slate-500">
                По текущим фильтрам система не нашла товары выбранной ABC-категории, где есть рекомендация к поставке и при этом не хватает собственного склада. Если нужно проверить дефицит сразу по WB и Ozon, выберите источник “WB + Ozon”, ABC “A” и все направления.
              </p>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function SupplyPlanningBlock({
  rows,
  params,
  companyNames,
}: {
  rows: SupplyPlanRow[];
  params: StockSearchParams;
  companyNames: string[];
}) {
  const isOpen = params.supplyOpen === "1";
  const marketplaceFilter = getSupplyMarketplaceFilter(params.supplyMarketplace);
  const priorityFilter = getSupplyPriorityFilter(params.supplyPriority);
  const abcFilter = getSupplyAbcFilter(params.supplyAbc);
  const targetFilter = normalizeKey(params.supplyTarget);
  const query = normalizeKey(params.supplyQ);

  const targetOptions = getSupplyTargetOptions(rows, marketplaceFilter);
  const safeTargetFilter =
    targetFilter && targetFilter !== "ALL" && targetOptions.includes(targetFilter)
      ? targetFilter
      : "ALL";

  const filteredRows = rows.filter((row) => {
    if (marketplaceFilter !== "ALL" && row.marketplace !== marketplaceFilter) {
      return false;
    }

    if (priorityFilter !== "ALL" && row.priority !== priorityFilter) {
      return false;
    }

    if (abcFilter !== "ALL" && row.abc?.abcByProfit !== abcFilter) {
      return false;
    }

    if (
      safeTargetFilter &&
      safeTargetFilter !== "ALL" &&
      row.targetName !== safeTargetFilter
    ) {
      return false;
    }

    return supplyPlanMatchesSearch(row, query);
  });

  const rowsLimit = getSupplyRowsLimit(params.supplyRows, filteredRows.length);
  const visibleRows = filteredRows.slice(0, rowsLimit);

  const exportParams = new URLSearchParams();

  if (params.companyName && params.companyName !== "ALL") {
    exportParams.set("companyName", params.companyName);
  }

  if (marketplaceFilter !== "ALL") {
    exportParams.set("supplyMarketplace", marketplaceFilter);
  }

  if (safeTargetFilter && safeTargetFilter !== "ALL") {
    exportParams.set("supplyTarget", safeTargetFilter);
  }

  if (abcFilter !== "ALL") {
    exportParams.set("supplyAbc", abcFilter);
  }

  if (priorityFilter !== "ALL") {
    exportParams.set("supplyPriority", priorityFilter);
  }

  if (params.supplyRows && params.supplyRows !== "20") {
    exportParams.set("supplyRows", params.supplyRows);
  }

  if (query) {
    exportParams.set("supplyQ", query);
  }

  if (params.dateFrom) {
    exportParams.set("dateFrom", params.dateFrom);
  }

  if (params.dateTo) {
    exportParams.set("dateTo", params.dateTo);
  }

  const exportQuery = exportParams.toString();
  const exportHref = exportQuery
    ? `/api/stocks/supply-plan/export?${exportQuery}`
    : "/api/stocks/supply-plan/export";

  const ozonRows = rows.filter((row) => row.marketplace === "OZON");
  const wbRows = rows.filter((row) => row.marketplace === "WB");
  const criticalRows = filteredRows.filter((row) => row.priority === "HIGH");
  const productionOpen = params.productionOpen !== "0";
  const productionBufferDays = getProductionBufferDays(params.productionBufferDays);
  const productionAbcFilter = getProductionAbcFilter(params.productionAbc);
  const allProductionPlanRows = getProductionPlanRows(
    filteredRows,
    productionBufferDays,
    productionAbcFilter
  );
  const hasCustomProductionSelection = params.productionSelectionMode === "custom";
  const selectedProductionKeys = getProductionSelectedKeys(params.productionSelected);
  const productionPlanRows = hasCustomProductionSelection
    ? allProductionPlanRows.filter((row) => selectedProductionKeys.has(row.key))
    : allProductionPlanRows;
  const productionRowsLimit = getProductionRowsLimit(
    params.productionRows,
    productionPlanRows.length
  );
  const visibleProductionPlanRows = productionPlanRows.slice(0, productionRowsLimit);
  const productionPlanQty = productionPlanSummaryQty(productionPlanRows);

  function makeProductionExportHref(bufferDays: number) {
    const productionExportParams = new URLSearchParams(exportParams);
    productionExportParams.delete("supplyRows");
    productionExportParams.set("bufferDays", String(bufferDays));
    productionExportParams.set("productionAbc", productionAbcFilter);

    if (hasCustomProductionSelection) {
      productionExportParams.set("productionSelectionMode", "custom");

      for (const key of selectedProductionKeys) {
        productionExportParams.append("productionSelected", key);
      }
    }

    const queryString = productionExportParams.toString();

    return queryString
      ? `/api/stocks/production-plan/export?${queryString}`
      : `/api/stocks/production-plan/export?bufferDays=${bufferDays}`;
  }

  return (
    <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
      <div className="p-4 sm:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={makeUrl(params, { supplyOpen: isOpen ? null : "1" })}
                className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-black uppercase tracking-[0.12em] text-emerald-700 ring-1 ring-emerald-100 transition hover:bg-emerald-100"
              >
                <span>План поставок</span>
                <span className="text-sm">{isOpen ? "▲" : "▼"}</span>
              </Link>

              <span className="rounded-full bg-slate-50 px-3 py-1 text-xs font-black text-slate-500 ring-1 ring-slate-200">
                {isOpen ? "развернут" : "свернут"}
              </span>
            </div>

            <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
              План поставок по спросу
            </h2>

          </div>

          <div className="grid grid-cols-2 gap-2 sm:min-w-[520px] sm:grid-cols-4">
            <div className="rounded-2xl bg-blue-50 p-3 text-center ring-1 ring-blue-100">
              <div className="text-xs font-black uppercase text-blue-600">Ozon</div>
              <div className="mt-1 text-xl font-black text-slate-950">
                {formatNumber(supplyWantedQty(ozonRows))}
              </div>
              <div className="text-[11px] font-bold text-slate-500">реком. системой</div>
              <div className="mt-1 text-[11px] font-black text-blue-700">
                к отгрузке: {formatNumber(supplySummaryQty(ozonRows))} шт.
              </div>
            </div>
            <div className="rounded-2xl bg-violet-50 p-3 text-center ring-1 ring-violet-100">
              <div className="text-xs font-black uppercase text-violet-600">WB</div>
              <div className="mt-1 text-xl font-black text-slate-950">
                {formatNumber(supplyWantedQty(wbRows))}
              </div>
              <div className="text-[11px] font-bold text-slate-500">реком. системой</div>
              <div className="mt-1 text-[11px] font-black text-violet-700">
                к отгрузке: {formatNumber(supplySummaryQty(wbRows))} шт.
              </div>
            </div>
            <div className="rounded-2xl bg-emerald-50 p-3 text-center ring-1 ring-emerald-100">
              <div className="text-xs font-black uppercase text-emerald-700">Всего</div>
              <div className="mt-1 text-xl font-black text-slate-950">
                {formatNumber(supplyWantedQty(rows))}
              </div>
              <div className="text-[11px] font-bold text-slate-500">реком. системой</div>
              <div className="mt-1 text-[11px] font-black text-emerald-700">
                к отгрузке: {formatNumber(supplySummaryQty(rows))} шт.
              </div>
            </div>
            <div className="rounded-2xl bg-red-50 p-3 text-center ring-1 ring-red-100">
              <div className="text-xs font-black uppercase text-red-600">Критично</div>
              <div className="mt-1 text-xl font-black text-slate-950">
                {formatNumber(rows.filter((row) => row.priority === "HIGH").length)}
              </div>
              <div className="text-[11px] font-bold text-slate-500">строк</div>
              <div className="mt-1 text-[11px] font-black text-red-700">
                реком.: {formatNumber(supplyWantedQty(rows.filter((row) => row.priority === "HIGH")))} шт.
              </div>
            </div>
          </div>
        </div>
      </div>

      {isOpen ? (
        <div className="border-t border-slate-100 p-4 sm:p-5">
          <form
            action="/stocks"
            method="GET"
            className="rounded-[24px] border border-slate-200 bg-slate-50/70 p-3 ring-1 ring-white"
          >
            <input type="hidden" name="supplyOpen" value="1" />
            <input type="hidden" name="productionOpen" value={productionOpen ? "1" : "0"} />
            <input type="hidden" name="productionBufferDays" value={String(productionBufferDays)} />
            <input type="hidden" name="productionRows" value={params.productionRows ?? "8"} />
            {params.dateFrom ? <input type="hidden" name="dateFrom" value={params.dateFrom} /> : null}
            {params.dateTo ? <input type="hidden" name="dateTo" value={params.dateTo} /> : null}
            {params.sizeOpen ? <input type="hidden" name="sizeOpen" value={params.sizeOpen} /> : null}
            {params.sizeRows ? <input type="hidden" name="sizeRows" value={params.sizeRows} /> : null}
            {params.sizeSort ? <input type="hidden" name="sizeSort" value={params.sizeSort} /> : null}

            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-[1.1fr_1fr_1.3fr_0.8fr_0.9fr_0.8fr_1.5fr_auto]">
              <label className="block">
                <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
                  Компания
                </span>
                <select
                  name="companyName"
                  defaultValue={params.companyName ?? "ALL"}
                  className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none transition focus:border-violet-200 focus:ring-4 focus:ring-violet-50"
                >
                  <option value="ALL">Все компании</option>
                  {companyNames.map((companyName) => (
                    <option key={companyName} value={companyName}>
                      {companyName}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
                  Источник
                </span>
                <select
                  name="supplyMarketplace"
                  defaultValue={marketplaceFilter}
                  className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none transition focus:border-violet-200 focus:ring-4 focus:ring-violet-50"
                >
                  <option value="ALL">WB + Ozon</option>
                  <option value="WB">WB</option>
                  <option value="OZON">Ozon</option>
                </select>
              </label>

              <label className="block">
                <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
                  Куда
                </span>
                <select
                  name="supplyTarget"
                  defaultValue={safeTargetFilter || "ALL"}
                  className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none transition focus:border-violet-200 focus:ring-4 focus:ring-violet-50"
                >
                  <option value="ALL">Все направления</option>
                  {targetOptions.map((target) => (
                    <option key={target} value={target}>
                      {target}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
                  ABC
                </span>
                <select
                  name="supplyAbc"
                  defaultValue={abcFilter}
                  className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none transition focus:border-violet-200 focus:ring-4 focus:ring-violet-50"
                >
                  <option value="ALL">Все</option>
                  <option value="A">A</option>
                  <option value="B">B</option>
                  <option value="C">C</option>
                </select>
              </label>

              <label className="block">
                <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
                  Приоритет
                </span>
                <select
                  name="supplyPriority"
                  defaultValue={priorityFilter}
                  className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none transition focus:border-violet-200 focus:ring-4 focus:ring-violet-50"
                >
                  <option value="ALL">Все</option>
                  <option value="HIGH">Высокий</option>
                  <option value="MEDIUM">Средний</option>
                  <option value="LOW">Низкий</option>
                </select>
              </label>

              <label className="block">
                <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
                  Строк
                </span>
                <select
                  name="supplyRows"
                  defaultValue={params.supplyRows ?? "20"}
                  className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none transition focus:border-violet-200 focus:ring-4 focus:ring-violet-50"
                >
                  <option value="20">20</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                  <option value="200">200</option>
                  <option value="ALL">Все</option>
                </select>
              </label>

              <label className="block">
                <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
                  Поиск
                </span>
                <input
                  name="supplyQ"
                  defaultValue={params.supplyQ ?? ""}
                  placeholder="Артикул, SKU, товар, размер"
                  className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none transition placeholder:text-slate-300 focus:border-violet-200 focus:ring-4 focus:ring-violet-50"
                />
              </label>

              <div className="flex items-end">
                <button className="h-11 w-full rounded-2xl bg-slate-950 px-5 text-sm font-black text-white shadow-sm transition hover:bg-slate-800">
                  Применить
                </button>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs font-bold text-slate-500">
              <div>
                Найдено {formatNumber(filteredRows.length)} строк · реком. {formatNumber(supplyWantedQty(filteredRows))} шт. · к отгрузке {formatNumber(supplySummaryQty(filteredRows))} шт. · критичных {formatNumber(criticalRows.length)}
              </div>
              <div className="flex flex-wrap gap-2">
                <Link
                  href={makeUrl(params, {
                    supplyOpen: "1",
                    supplyMarketplace: null,
                    supplyTarget: null,
                    supplyAbc: null,
                    supplyPriority: null,
                    supplyRows: null,
                    supplyQ: null,
                    companyName: null,
                  })}
                  className="inline-flex rounded-full bg-white px-3 py-1.5 font-black text-slate-600 ring-1 ring-slate-200 transition hover:bg-slate-100"
                >
                  Сбросить фильтры
                </Link>
              </div>
            </div>
          </form>

          <div className="mt-4 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="max-w-3xl text-sm font-bold leading-6 text-slate-500">
              Что и куда отгрузить со своего склада с учётом спроса, остатков маркетплейсов и доступного товара. Официальный файл Ozon “Планирование поставок” можно загрузить здесь же.
            </div>

            <div className="flex flex-wrap gap-2">
              <Link
                href="/import?reportType=OZON_SUPPLY_RECOMMENDATION"
                className="inline-flex items-center justify-center rounded-2xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm font-black text-blue-700 transition hover:bg-blue-100"
                title="Загрузить Excel-файл Ozon из личного кабинета: FBO → Планирование поставок → Доступность товаров"
              >
                Загрузить рекомендации Ozon
              </Link>

              <Link
                href={exportHref}
                className="inline-flex items-center justify-center rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm font-black text-emerald-700 transition hover:bg-emerald-100"
                title="Скачать Excel-файл по текущим фильтрам плана поставок"
              >
                Экспорт Excel
              </Link>

              <button
                type="button"
                disabled
                className="inline-flex cursor-not-allowed items-center justify-center rounded-2xl border border-slate-200 bg-slate-100 px-4 py-2.5 text-sm font-black text-slate-400"
                title="После Excel добавим сохранение черновика поставки внутри системы"
              >
                Запланировать поставку · позже
              </button>
            </div>
          </div>

          {visibleRows.length > 0 ? (
            <div className="mt-4 overflow-hidden rounded-[24px] border border-slate-200 bg-white">
              <div className="overflow-x-auto">
                <table className="w-full table-fixed border-collapse text-left text-xs xl:text-sm">
                  <thead className="bg-slate-50 text-[10px] font-black uppercase tracking-[0.08em] text-slate-400 xl:text-[11px]">
                    <tr>
                      <th className="w-[23%] px-3 py-3">Товар</th>
                      <th className="w-[5%] px-2 py-3">Размер</th>
                      <th className="w-[24%] px-3 py-3">Куда</th>
                      <th className="w-[7%] px-2 py-3">Источник</th>
                      <th className="w-[5%] px-2 py-3">ABC</th>
                      <th className="w-[7%] px-2 py-3 text-right">Остаток</th>
                      <th className="w-[7%] px-2 py-3 text-right">Реком.</th>
                      <th className="w-[7%] px-2 py-3 text-right">Доступно</th>
                      <th className="w-[9%] px-2 py-3 text-right">К отгрузке</th>
                      <th className="w-[6%] px-2 py-3">Приор.</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {visibleRows.map((row) => {
                      const tooltipDetails = row.details.filter((detail) => {
                        const normalizedDetail = String(detail).trim().toLowerCase();

                        return (
                          !normalizedDetail.startsWith("цель:") &&
                          !normalizedDetail.startsWith("сейчас:")
                        );
                      });

                      const targetTooltip = [
                        row.targetName,
                        `Цель: ${formatNumber(row.wantedQty)} шт.`,
                        `Сейчас: ${formatNumber(row.currentQty)} шт.`,
                        row.reason,
                        ...tooltipDetails,
                      ]
                        .filter(Boolean)
                        .join("\n");

                      return (
                        <tr key={row.key} className="align-middle transition hover:bg-slate-50/70">
                          <td className="px-3 py-3">
                            <div
                              className="flex min-w-0 items-center gap-3"
                              title={`Компания: ${row.companyName}
Артикул: ${row.vendorCode}${
                                row.sku ? `
SKU: ${row.sku}` : ""
                              }`}
                            >
                              {row.imageUrl ? (
                                <img
                                  src={row.imageUrl}
                                  alt="Фото товара"
                                  className="h-11 w-11 shrink-0 rounded-2xl border border-slate-200 bg-slate-50 object-cover"
                                />
                              ) : (
                                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-[10px] font-black text-slate-400">
                                  фото
                                </div>
                              )}

                              <div className="min-w-0">
                                <div className="line-clamp-1 text-sm font-black leading-5 text-slate-950">
                                  {row.companyName}
                                </div>

                                <div className="mt-0.5 line-clamp-1 break-all text-xs font-black leading-4 text-slate-700">
                                  {row.vendorCode}
                                </div>

                                {row.sku ? (
                                  <div className="mt-0.5 line-clamp-1 break-all text-[10px] font-bold leading-4 text-slate-400">
                                    SKU {row.sku}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          </td>

                          <td className="px-2 py-3 font-black text-slate-700">
                            {row.size ?? "—"}
                          </td>

                          <td className="px-3 py-3" title={targetTooltip}>
                            <div className="line-clamp-1 font-black text-slate-900">
                              {row.targetName}
                            </div>

                            <div className="mt-1 text-[11px] font-black leading-4 text-slate-500">
                              Цель: {formatNumber(row.wantedQty)} шт. · Сейчас: {formatNumber(row.currentQty)} шт.
                            </div>

                            <div className="mt-1 line-clamp-2 text-[11px] font-bold leading-4 text-slate-400">
                              {row.reason}
                            </div>
                          </td>

                          <td className="px-2 py-3">
                            <span
                              className={`inline-flex rounded-full px-2 py-1 text-[10px] font-black ring-1 ${marketplaceSupplyClass(
                                row.marketplace
                              )}`}
                            >
                              {row.marketplace === "WB" ? "WB" : "Ozon"}
                            </span>
                          </td>

                          <td className="px-2 py-3">
                            {row.abc ? (
                              <AbcBadge value={row.abc.abcByProfit} compact />
                            ) : (
                              <span className="text-xs font-bold text-slate-400">—</span>
                            )}
                          </td>

                          <td className="px-2 py-3 text-right font-black text-slate-700">
                            {formatNumber(row.currentQty)}
                          </td>
                          <td className="px-2 py-3 text-right font-black text-slate-700">
                            {formatNumber(row.wantedQty)}
                          </td>
                          <td className="px-2 py-3 text-right font-black text-emerald-700">
                            {formatNumber(row.ownAvailableQty)}
                          </td>
                          <td className="px-2 py-3 text-right">
                            <input
                              defaultValue={row.recommendedQty}
                              inputMode="numeric"
                              className="h-9 w-full min-w-14 rounded-xl border border-slate-200 bg-white px-2 text-right text-sm font-black text-slate-900 outline-none transition focus:border-violet-200 focus:ring-4 focus:ring-violet-50"
                              aria-label={`К отгрузке ${row.vendorCode}`}
                            />
                          </td>
                          <td className="px-2 py-3">
                            <span
                              className={`inline-flex rounded-full px-2 py-1 text-[10px] font-black ring-1 ${priorityBadgeClass(
                                row.priority
                              )}`}
                            >
                              {priorityLabel(row.priority)}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-col gap-2 border-t border-slate-100 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-500 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  Показано {formatNumber(visibleRows.length)} из {formatNumber(filteredRows.length)} строк.
                </div>
                <div>
                  Отредактированные значения “К отгрузке” пока не сохраняются. Сохранение черновика — следующий этап.
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-4 rounded-2xl border border-dashed border-slate-300 p-6 text-center text-sm font-bold leading-6 text-slate-500">
              {marketplaceFilter === "OZON"
                ? "По Ozon рекомендаций не найдено. Проверьте, что загружен файл “Ozon — Планирование поставок”, в нём есть рекомендуемое количество к поставке, и фильтры не ограничивают выборку."
                : marketplaceFilter === "WB"
                  ? "По WB рекомендаций не найдено. Проверьте остатки WB по складам, собственный склад и выбранные фильтры."
                  : "По выбранным фильтрам рекомендаций нет. Проверьте собственный склад, Ozon “Планирование поставок”, остатки WB по складам и фильтры."}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

export default async function StocksPage({
  searchParams,
}: {
  searchParams?: Promise<StockSearchParams>;
}) {
  const params = searchParams ? await searchParams : {};
  const selectedSource = getSelectedSource(params.source);
  const rowsLimit = getRowsLimit(params.rows);
  const sortKey = getSortKey(params.sort);
  const sortDir = getSortDir(params.dir);
  const selectedProduct = getSelectedProduct(params.product);
  const searchQuery = normalizeKey(params.q);
  const defaultAbcPeriod = getDefaultAbcPeriod();
  const abcDateFrom = params.dateFrom ?? defaultAbcPeriod.dateFrom;
  const abcDateTo = params.dateTo ?? defaultAbcPeriod.dateTo;

  const companies = await prisma.company.findMany({
    where: {
      isActive: true,
    },
    orderBy: {
      name: "asc",
    },
    select: {
      name: true,
    },
  });

  const companyNames = companies.map((company) => company.name);
  const selectedCompanyName =
    params.companyName && params.companyName !== "ALL"
      ? params.companyName
      : null;

  const visibleCompanyNames = selectedCompanyName
    ? companyNames.filter((companyName) => companyName === selectedCompanyName)
    : companyNames;

  const companyWhere =
    visibleCompanyNames.length > 0
      ? {
          in: visibleCompanyNames,
        }
      : undefined;

  const [wbProfitAnalytics, ozonProfitAnalytics] = await Promise.all([
    getProfitAnalytics({
      dateFrom: abcDateFrom,
      dateTo: abcDateTo,
      companyName: selectedCompanyName ?? "ALL",
    }),
    getProfitAnalyticsOzon({
      dateFrom: abcDateFrom,
      dateTo: abcDateTo,
      usnRate: "1",
      vatRate: "5",
      companyName: selectedCompanyName ?? "ALL",
    }),
  ]);

  const wbAbcByRevenue = calculateAbcByPositiveValue(
    wbProfitAnalytics.rows,
    (row: WbProfitRow) => row.revenue
  );
  const wbAbcMap = new Map<string, StockAbcInfo>();

  for (const row of wbProfitAnalytics.rows) {
    const abc = {
      abcByRevenue: wbAbcByRevenue.get(row) ?? "C",
      abcByProfit: toAbcCategory(row.abcByProfit),
    } satisfies StockAbcInfo;

    const companyName = rowCompanyName(row, selectedCompanyName);

    registerStockAbc(wbAbcMap, {
      companyName,
      article: row.nmId,
      abc,
    });

    registerStockAbc(wbAbcMap, {
      companyName,
      article: row.vendorCode,
      abc,
    });
  }

  const ozonAbcMap = new Map<string, StockAbcInfo>();
  const ozonGroupsForAbc = new Map<
    string,
    {
      companyName: string | null;
      baseArticle: string;
      revenue: number;
      netProfitAfterTax: number;
      rows: OzonProfitRow[];
    }
  >();

  for (const row of ozonProfitAnalytics.rows) {
    const companyName = rowCompanyName(row, selectedCompanyName);
    const baseArticle = getMarketplaceBaseArticle(row.vendorCode) || row.vendorCode;
    const key = `${companyName ?? ""}::${baseArticle}`;
    const current =
      ozonGroupsForAbc.get(key) ??
      ({
        companyName,
        baseArticle,
        revenue: 0,
        netProfitAfterTax: 0,
        rows: [],
      } satisfies {
        companyName: string | null;
        baseArticle: string;
        revenue: number;
        netProfitAfterTax: number;
        rows: OzonProfitRow[];
      });

    current.revenue += row.revenue;
    current.netProfitAfterTax += row.netProfitAfterTax;
    current.rows.push(row);

    ozonGroupsForAbc.set(key, current);
  }

  const ozonGroupedRowsForAbc = Array.from(ozonGroupsForAbc.values());
  const ozonGroupedAbcByRevenue = calculateAbcByPositiveValue(
    ozonGroupedRowsForAbc,
    (row) => row.revenue
  );
  const ozonGroupedAbcByProfit = calculateAbcByPositiveValue(
    ozonGroupedRowsForAbc,
    (row) => row.netProfitAfterTax
  );

  for (const group of ozonGroupedRowsForAbc) {
    const abc = {
      abcByRevenue: ozonGroupedAbcByRevenue.get(group) ?? "C",
      abcByProfit: ozonGroupedAbcByProfit.get(group) ?? "C",
    } satisfies StockAbcInfo;

    registerStockAbc(ozonAbcMap, {
      companyName: group.companyName,
      article: group.baseArticle,
      abc,
    });

    for (const row of group.rows) {
      registerStockAbc(ozonAbcMap, {
        companyName: group.companyName,
        article: row.vendorCode,
        abc,
      });

      registerStockAbc(ozonAbcMap, {
        companyName: group.companyName,
        article: row.nmId,
        abc,
      });
    }
  }

  const wbDailySaleDateFrom = new Date(`${abcDateFrom}T00:00:00.000Z`);
  const wbDailySaleDateTo = new Date(`${abcDateTo}T23:59:59.999Z`);

  const [
    rawWbStocks,
    ozonStocks,
    warehouseStocks,
    ozonSupplyRecommendations,
    wbDailySalesRows,
    stockImports,
    productCosts,
  ] = await Promise.all([
      prisma.wbStock.findMany({
        where: {
          companyName: companyWhere,
        },
        orderBy: [
          { companyName: "asc" },
          { vendorCode: "asc" },
          { size: "asc" },
          { warehouseName: "asc" },
        ],
      }),
      prisma.ozonStock.findMany({
        where: {
          companyName: companyWhere,
        },
        orderBy: [
          { companyName: "asc" },
          { vendorCode: "asc" },
          { warehouseName: "asc" },
        ],
      }),
      prisma.ozonWarehouseStock.findMany({
        where: {
          companyName: companyWhere,
        },
        orderBy: [{ companyName: "asc" }, { vendorCode: "asc" }, { size: "asc" }],
      }),
      prisma.ozonSupplyRecommendation.findMany({
        where: {
          companyName: companyWhere,
        },
        orderBy: [
          { companyName: "asc" },
          { clusterName: "asc" },
          { vendorCode: "asc" },
        ],
      }),
      prisma.wbSale.findMany({
        where: {
          companyName: companyWhere,
          reportNumber: {
            startsWith: "WB_DAILY_STATISTICS_",
          },
          saleDate: {
            gte: wbDailySaleDateFrom,
            lte: wbDailySaleDateTo,
          },
        },
        orderBy: [{ saleDate: "asc" }],
        select: {
          companyName: true,
          vendorCode: true,
          nmId: true,
          barcode: true,
          size: true,
          warehouseName: true,
          countryName: true,
          oblastOkrugName: true,
          regionName: true,
          saleDate: true,
          quantity: true,
          wbRealizedAmount: true,
        },
      }),
      prisma.importSession.findMany({
        where: {
          reportType: {
            in: ["WB_STOCK", "OZON_STOCK", "OZON_WAREHOUSE_STOCK"],
          },
          ...(visibleCompanyNames.length > 0
            ? {
                companyName: {
                  in: visibleCompanyNames,
                },
              }
            : {}),
        },
        orderBy: {
          createdAt: "desc",
        },
        select: {
          companyName: true,
          reportType: true,
          fileName: true,
          createdAt: true,
        },
      }),
      prisma.productCost.findMany({
        orderBy: [{ costDate: "desc" }, { createdAt: "desc" }],
        select: {
          vendorCode: true,
          nmId: true,
          name: true,
          costPrice: true,
        },
      }),
    ]);

  const companiesWithWbTotalRows = new Set(
    rawWbStocks
      .filter((stock) => stock.warehouseName === "__TOTAL__")
      .map((stock) => normalizeKey(stock.companyName))
      .filter(Boolean)
  );

  const wbStocks =
    companiesWithWbTotalRows.size > 0
      ? rawWbStocks.filter((stock) => {
          const stockCompanyName = normalizeKey(stock.companyName);

          if (!companiesWithWbTotalRows.has(stockCompanyName)) {
            return true;
          }

          return stock.warehouseName === "__TOTAL__";
        })
      : rawWbStocks;

  const vendorCodes = Array.from(
    new Set(
      [
        ...wbStocks.map((stock) => stock.vendorCode),
        ...ozonStocks.map((stock) => stock.vendorCode),
        ...warehouseStocks.map((stock) => stock.vendorCode),
        ...ozonSupplyRecommendations.map((row) => row.vendorCode),
      ]
        .map((value) => normalizeKey(value))
        .filter(Boolean)
    )
  );

  const skus = Array.from(
    new Set(
      [
        ...ozonStocks.map((stock) => stock.sku),
        ...warehouseStocks.map((stock) => stock.sku),
        ...ozonSupplyRecommendations.map((row) => row.sku),
      ]
        .map((value) => normalizeKey(value))
        .filter(Boolean)
    )
  );

  const nmIds = Array.from(
    new Set(
      wbStocks
        .map((stock) => stock.nmId)
        .map((value) => normalizeKey(value))
        .filter(Boolean)
    )
  );

  const ozonProductWhere =
    vendorCodes.length > 0 || skus.length > 0
      ? {
          ...(visibleCompanyNames.length > 0
            ? {
                companyName: {
                  in: visibleCompanyNames,
                },
              }
            : {}),
          OR: [
            ...(vendorCodes.length > 0
              ? [
                  {
                    vendorCode: {
                      in: vendorCodes,
                    },
                  },
                ]
              : []),
            ...(skus.length > 0
              ? [
                  {
                    sku: {
                      in: skus,
                    },
                  },
                ]
              : []),
          ],
        }
      : {
          id: "__NO_PRODUCTS__",
        };

  const wbProductWhere =
    vendorCodes.length > 0 || nmIds.length > 0
      ? {
          OR: [
            ...(vendorCodes.length > 0
              ? [
                  {
                    vendorCode: {
                      in: vendorCodes,
                    },
                  },
                ]
              : []),
            ...(nmIds.length > 0
              ? [
                  {
                    nmId: {
                      in: nmIds,
                    },
                  },
                ]
              : []),
          ],
        }
      : {
          id: "__NO_PRODUCTS__",
        };

  const [ozonProducts, wbProductCards] = await Promise.all([
    prisma.ozonProduct.findMany({
      where: ozonProductWhere,
      orderBy: {
        createdAt: "desc",
      },
      select: {
        companyName: true,
        vendorCode: true,
        sku: true,
        productName: true,
        imageUrl: true,
        imageSmallUrl: true,
      },
    }),
    prisma.wbProductCard.findMany({
      where: wbProductWhere,
      orderBy: {
        lastSyncedAt: "desc",
      },
      select: {
        companyName: true,
        nmId: true,
        vendorCode: true,
        title: true,
        photoSmallUrl: true,
        photoBigUrl: true,
      },
    }),
  ]);

  const costByVendorCode = new Map<string, number>();
  const costByVendorCodeCompact = new Map<string, number>();
  const costByNmId = new Map<string, number>();
  const costByVendorRoot = new Map<string, number>();
  const costByVendorRootCompact = new Map<string, number>();
  const costNameByVendorCode = new Map<string, string>();
  const supplierArticleByCompanyAndWbArticle = new Map<string, string>();
  const supplierArticleByWbArticle = new Map<string, string>();

  for (const cost of productCosts) {
    const vendorCode = normalizeKey(cost.vendorCode);
    const nmId = normalizeKey(cost.nmId);
    const costPrice = toNumber(cost.costPrice);

    if (vendorCode) {
      const candidates = getSupplierArticleCandidates(vendorCode);

      for (const candidate of candidates) {
        if (!costByVendorCode.has(candidate)) {
          costByVendorCode.set(candidate, costPrice);
        }

        const compactCandidate = normalizeArticleForMatch(candidate);

        if (compactCandidate && !costByVendorCodeCompact.has(compactCandidate)) {
          costByVendorCodeCompact.set(compactCandidate, costPrice);
        }
      }

      if (!costNameByVendorCode.has(vendorCode)) {
        costNameByVendorCode.set(vendorCode, normalizeKey(cost.name));
      }

      const vendorRoot = getSupplierArticleRoot(vendorCode);

      if (vendorRoot && !costByVendorRoot.has(vendorRoot)) {
        costByVendorRoot.set(vendorRoot, costPrice);
      }

      const compactRoot = normalizeArticleForMatch(vendorRoot);

      if (compactRoot && !costByVendorRootCompact.has(compactRoot)) {
        costByVendorRootCompact.set(compactRoot, costPrice);
      }
    }

    if (nmId && !costByNmId.has(nmId)) {
      costByNmId.set(nmId, costPrice);
    }
  }

  const registerWbSupplierArticleMapping = (params: {
    companyName?: string | null;
    wbArticle?: string | null;
    supplierArticle?: string | null;
  }) => {
    const wbArticle = normalizeKey(params.wbArticle);
    const supplierArticle = normalizeKey(params.supplierArticle);

    if (!wbArticle || !supplierArticle) return;

    const companyKey = getCompanyArticleKey(params.companyName, wbArticle);

    if (companyKey && !supplierArticleByCompanyAndWbArticle.has(companyKey)) {
      supplierArticleByCompanyAndWbArticle.set(companyKey, supplierArticle);
    }

    if (!supplierArticleByWbArticle.has(wbArticle)) {
      supplierArticleByWbArticle.set(wbArticle, supplierArticle);
    }
  };

  for (const stock of wbStocks) {
    registerWbSupplierArticleMapping({
      companyName: stock.companyName,
      wbArticle: stock.nmId,
      supplierArticle: stock.vendorCode,
    });
  }

  for (const product of wbProductCards) {
    registerWbSupplierArticleMapping({
      companyName: product.companyName,
      wbArticle: product.nmId,
      supplierArticle: product.vendorCode,
    });
  }

  const costs: CostLookup = {
    bySupplierArticle: costByVendorCode,
    bySupplierArticleCompact: costByVendorCodeCompact,
    byNmId: costByNmId,
    bySupplierArticleRoot: costByVendorRoot,
    bySupplierArticleRootCompact: costByVendorRootCompact,
    supplierArticleByCompanyAndWbArticle,
    supplierArticleByWbArticle,
  };

  const ozonProductByVendorCode = new Map<string, ProductVisual>();
  const ozonProductBySku = new Map<string, ProductVisual>();

  for (const product of ozonProducts) {
    const visual = {
      name: product.productName ?? null,
      imageUrl: product.imageSmallUrl ?? product.imageUrl ?? null,
    };

    const vendorCode = normalizeKey(product.vendorCode);
    const sku = normalizeKey(product.sku);
    const companyName = normalizeKey(product.companyName);
    const baseArticle = getMarketplaceBaseArticle(vendorCode);

    if (vendorCode && !ozonProductByVendorCode.has(vendorCode)) {
      ozonProductByVendorCode.set(vendorCode, visual);
    }

    if (sku && !ozonProductBySku.has(sku)) {
      ozonProductBySku.set(sku, visual);
    }

    const abc = findStockAbc(ozonAbcMap, {
      companyName,
      articles: [sku, vendorCode, baseArticle],
    });

    if (abc) {
      registerStockAbc(ozonAbcMap, {
        companyName,
        article: sku,
        abc,
      });

      registerStockAbc(ozonAbcMap, {
        companyName,
        article: vendorCode,
        abc,
      });

      registerStockAbc(ozonAbcMap, {
        companyName,
        article: baseArticle,
        abc,
      });
    }
  }

  const wbProductByVendorCode = new Map<string, ProductVisual>();
  const wbProductByNmId = new Map<string, ProductVisual>();

  for (const product of wbProductCards) {
    const visual = {
      name: product.title ?? null,
      imageUrl: product.photoSmallUrl ?? product.photoBigUrl ?? null,
    };

    const vendorCode = normalizeKey(product.vendorCode);
    const nmId = normalizeKey(product.nmId);

    if (vendorCode && !wbProductByVendorCode.has(vendorCode)) {
      wbProductByVendorCode.set(vendorCode, visual);
    }

    if (nmId && !wbProductByNmId.has(nmId)) {
      wbProductByNmId.set(nmId, visual);
    }
  }

  const warehouseProductByVendorCode = new Map<string, ProductVisual>();

  for (const stock of warehouseStocks) {
    const vendorCode = normalizeKey(stock.vendorCode);

    if (!vendorCode || warehouseProductByVendorCode.has(vendorCode)) continue;

    warehouseProductByVendorCode.set(vendorCode, {
      name: stock.productName ?? costNameByVendorCode.get(vendorCode) ?? null,
      imageUrl: null,
    });
  }

  const makeRowVisual = (params: {
    vendorCode: string;
    sku: string | null;
    nmId: string | null;
  }) =>
    getProductVisual({
      vendorCode: params.vendorCode,
      sku: params.sku,
      nmId: params.nmId,
      ozonProductByVendorCode,
      ozonProductBySku,
      wbProductByVendorCode,
      wbProductByNmId,
      warehouseProductByVendorCode,
    });

  const summaries: CompanyStockSummary[] = visibleCompanyNames.map(
    (companyName) => {
      const companyWbStocks = wbStocks.filter(
        (stock) => stock.companyName === companyName
      );
      const companyOzonStocks = ozonStocks.filter(
        (stock) => stock.companyName === companyName
      );
      const companyWarehouseStocks = warehouseStocks.filter(
        (stock) => stock.companyName === companyName
      );

      const wbStockQty = sum(
        companyWbStocks.map((stock) => toNumber(stock.totalStock))
      );
      const wbTransitToCustomerQty = sum(
        companyWbStocks.map((stock) => toNumber(stock.inTransitToCustomer))
      );
      const wbTransitReturnsQty = sum(
        companyWbStocks.map((stock) => toNumber(stock.inTransitReturns))
      );
      const wbTotalQty =
        wbStockQty + wbTransitToCustomerQty + wbTransitReturnsQty;
      const wbTotalCost = sum(
        companyWbStocks.map((stock) => {
          const qty =
            toNumber(stock.totalStock) +
            toNumber(stock.inTransitToCustomer) +
            toNumber(stock.inTransitReturns);

          return (
            qty *
            getCostPrice({
              companyName,
              vendorCode: stock.vendorCode,
              nmId: stock.nmId,
              costs,
            })
          );
        })
      );

      const ozonAvailableQty = sum(
        companyOzonStocks.map((stock) => toNumber(stock.availableQty))
      );
      const ozonPreparingQty = sum(
        companyOzonStocks.map((stock) => toNumber(stock.preparingQty))
      );
      const ozonSupplyQty = sum(
        companyOzonStocks.map((stock) => toNumber(stock.supplyQty))
      );
      const ozonInTransitQty = sum(
        companyOzonStocks.map((stock) => toNumber(stock.inTransitQty))
      );
      const ozonReturnQty = sum(
        companyOzonStocks.map((stock) => toNumber(stock.returnQty))
      );
      const ozonTotalQty =
        ozonAvailableQty +
        ozonPreparingQty +
        ozonSupplyQty +
        ozonInTransitQty +
        ozonReturnQty;
      const ozonTotalCost = sum(
        companyOzonStocks.map((stock) => {
          const qty =
            toNumber(stock.availableQty) +
            toNumber(stock.preparingQty) +
            toNumber(stock.supplyQty) +
            toNumber(stock.inTransitQty) +
            toNumber(stock.returnQty);

          return (
            qty *
            getCostPrice({
              companyName,
              vendorCode: stock.vendorCode,
              sku: stock.sku,
              costs,
            })
          );
        })
      );

      const warehouseQty = sum(
        companyWarehouseStocks.map((stock) => toNumber(stock.warehouseQty))
      );
      const reservedQty = sum(
        companyWarehouseStocks.map((stock) => toNumber(stock.reservedQty))
      );
      const availableForSupplyQty = sum(
        companyWarehouseStocks.map((stock) => toNumber(stock.availableForSupplyQty))
      );
      const warehouseTotalCost = sum(
        companyWarehouseStocks.map((stock) => {
          const costPrice = getCostPrice({
            companyName,
            vendorCode: stock.vendorCode,
            sku: stock.sku,
            ownCostPrice: stock.costPrice,
            costs,
          });

          return toNumber(stock.warehouseQty) * costPrice;
        })
      );
      const availableForSupplyCost = sum(
        companyWarehouseStocks.map((stock) => {
          const costPrice = getCostPrice({
            companyName,
            vendorCode: stock.vendorCode,
            sku: stock.sku,
            ownCostPrice: stock.costPrice,
            costs,
          });

          return toNumber(stock.availableForSupplyQty) * costPrice;
        })
      );

      const latestDates = [
        getLatestImportDateByCompany({
          companyName,
          reportType: "WB_STOCK",
          imports: stockImports,
        }),
        getLatestImportDateByCompany({
          companyName,
          reportType: "OZON_STOCK",
          imports: stockImports,
        }),
        getLatestImportDateByCompany({
          companyName,
          reportType: "OZON_WAREHOUSE_STOCK",
          imports: stockImports,
        }),
      ].filter((date) => date !== "Нет данных");

      return {
        companyName,
        totalQty: wbTotalQty + ozonTotalQty + warehouseQty,
        totalCost: wbTotalCost + ozonTotalCost + warehouseTotalCost,
        lastUpdate: latestDates[0] ?? "Нет данных",
        wb: {
          totalQty: wbTotalQty,
          totalCost: wbTotalCost,
          stockQty: wbStockQty,
          inTransitToCustomerQty: wbTransitToCustomerQty,
          inTransitReturnsQty: wbTransitReturnsQty,
        },
        ozon: {
          totalQty: ozonTotalQty,
          totalCost: ozonTotalCost,
          availableQty: ozonAvailableQty,
          preparingQty: ozonPreparingQty,
          inTransitQty: ozonInTransitQty,
        },
        warehouse: {
          warehouseQty,
          totalCost: warehouseTotalCost,
          reservedQty,
          availableForSupplyQty,
          availableForSupplyCost,
          rowsCount: companyWarehouseStocks.length,
        },
      };
    }
  );

  const totalWbQty = sum(summaries.map((summary) => summary.wb.totalQty));
  const totalWbCost = sum(summaries.map((summary) => summary.wb.totalCost));
  const totalOzonQty = sum(summaries.map((summary) => summary.ozon.totalQty));
  const totalOzonCost = sum(summaries.map((summary) => summary.ozon.totalCost));
  const totalWarehouseQty = sum(
    summaries.map((summary) => summary.warehouse.warehouseQty)
  );
  const totalWarehouseCost = sum(
    summaries.map((summary) => summary.warehouse.totalCost)
  );
  const totalAvailableForSupplyQty = sum(
    summaries.map((summary) => summary.warehouse.availableForSupplyQty)
  );
  const totalAvailableForSupplyCost = sum(
    summaries.map((summary) => summary.warehouse.availableForSupplyCost)
  );
  const totalReservedQty = sum(
    summaries.map((summary) => summary.warehouse.reservedQty)
  );

  const allRows: UnifiedStockRow[] = [
    ...wbStocks.map((stock) => {
      const vendorCode = stock.vendorCode ?? "—";
      const qty =
        toNumber(stock.totalStock) +
        toNumber(stock.inTransitToCustomer) +
        toNumber(stock.inTransitReturns);
      const costPrice = getCostPrice({
        companyName: stock.companyName,
        vendorCode,
        nmId: stock.nmId,
        costs,
      });
      const visual = makeRowVisual({
        vendorCode,
        sku: null,
        nmId: stock.nmId,
      });

      return {
        key: `wb-${stock.id}`,
        companyName: stock.companyName ?? "Без компании",
        source: "WB" as const,
        vendorCode,
        sku: null,
        nmId: stock.nmId,
        barcode: stock.barcode,
        size: stock.size,
        warehouseName:
          stock.warehouseName && stock.warehouseName !== "__TOTAL__"
            ? stock.warehouseName
            : "WB",
        clusterName: null,
        qty,
        reservedQty: 0,
        availableForSupplyQty: qty,
        costPrice,
        totalCost: qty * costPrice,
        productName:
          visual.name ?? costNameByVendorCode.get(normalizeKey(vendorCode)) ?? null,
        imageUrl: visual.imageUrl,
        abc: findStockAbc(wbAbcMap, {
          companyName: stock.companyName,
          articles: [stock.nmId, vendorCode],
        }),
      };
    }),
    ...ozonStocks.map((stock) => {
      const vendorCode = stock.vendorCode ?? "—";
      const qty =
        toNumber(stock.availableQty) +
        toNumber(stock.preparingQty) +
        toNumber(stock.supplyQty) +
        toNumber(stock.inTransitQty) +
        toNumber(stock.returnQty);
      const costPrice = getCostPrice({
        companyName: stock.companyName,
        vendorCode,
        sku: stock.sku,
        costs,
      });
      const visual = makeRowVisual({
        vendorCode,
        sku: stock.sku,
        nmId: null,
      });

      return {
        key: `ozon-${stock.id}`,
        companyName: stock.companyName ?? "Без компании",
        source: "OZON" as const,
        vendorCode,
        sku: stock.sku,
        nmId: null,
        barcode: null,
        size: stock.size,
        warehouseName: stock.warehouseName,
        clusterName: stock.clusterName,
        qty,
        reservedQty: 0,
        availableForSupplyQty: toNumber(stock.availableQty),
        costPrice,
        totalCost: qty * costPrice,
        productName:
          visual.name ?? costNameByVendorCode.get(normalizeKey(vendorCode)) ?? null,
        imageUrl: visual.imageUrl,
        abc: findStockAbc(ozonAbcMap, {
          companyName: stock.companyName,
          articles: [getMarketplaceBaseArticle(vendorCode), vendorCode, stock.sku],
        }),
      };
    }),
    ...warehouseStocks.map((stock) => {
      const vendorCode = stock.vendorCode;
      const costPrice = getCostPrice({
        companyName: stock.companyName,
        vendorCode: stock.vendorCode,
        sku: stock.sku,
        ownCostPrice: stock.costPrice,
        costs,
      });
      const visual = makeRowVisual({
        vendorCode,
        sku: stock.sku,
        nmId: null,
      });

      return {
        key: `warehouse-${stock.id}`,
        companyName: stock.companyName,
        source: "OWN" as const,
        vendorCode,
        sku: stock.sku,
        nmId: null,
        barcode: stock.barcode,
        size: stock.size,
        warehouseName: "Собственный склад",
        clusterName: null,
        qty: toNumber(stock.warehouseQty),
        reservedQty: toNumber(stock.reservedQty),
        availableForSupplyQty: toNumber(stock.availableForSupplyQty),
        costPrice,
        totalCost: toNumber(stock.warehouseQty) * costPrice,
        productName:
          stock.productName ??
          visual.name ??
          costNameByVendorCode.get(normalizeKey(vendorCode)) ??
          null,
        imageUrl: visual.imageUrl,
        abc: null,
      };
    }),
  ].filter((row) => row.qty > 0 || row.availableForSupplyQty > 0);

  const fallbackStockAbcMap = buildFallbackStockAbcMap(allRows);

  for (const row of allRows) {
    if (row.abc || row.source === "OWN") continue;

    row.abc = findStockAbc(fallbackStockAbcMap, {
      companyName: row.companyName,
      articles: [
        getUnifiedMarketplaceArticle(row),
        getMarketplaceBaseArticle(row.vendorCode),
        row.vendorCode,
        row.sku,
        row.nmId,
      ],
    });
  }

  const ownSupplyItems: OwnSupplyItem[] = warehouseStocks
    .map((stock) => {
      const vendorCode = normalizeKey(stock.vendorCode);
      const sku = normalizeKey(stock.sku);
      const size = normalizeKey(stock.size) || inferSizeFromVendorCode(vendorCode);
      const visual = makeRowVisual({
        vendorCode,
        sku,
        nmId: null,
      });

      const articleKeys = new Set<string>();

      for (const article of [
        vendorCode,
        sku,
        getMarketplaceBaseArticle(vendorCode),
        getSupplierArticleRoot(vendorCode),
      ]) {
        const normalizedArticle = normalizeSupplyArticle(article);
        if (normalizedArticle) articleKeys.add(normalizedArticle);
      }

      return {
        key: `own-${stock.id}`,
        companyName: stock.companyName,
        companyKey: normalizeKey(stock.companyName),
        articleKeys,
        sizeKey: normalizeSupplySize(size),
        availableQty: toNumber(stock.availableForSupplyQty),
        productName:
          stock.productName ??
          visual.name ??
          costNameByVendorCode.get(normalizeKey(vendorCode)) ??
          null,
        imageUrl: visual.imageUrl,
      } satisfies OwnSupplyItem;
    })
    .filter((item) => item.availableQty > 0 && item.articleKeys.size > 0);

  function findOwnSupplyItem(params: {
    companyName?: string | null;
    articles: Array<string | null | undefined>;
    size?: string | null;
  }) {
    const companyKey = normalizeKey(params.companyName);
    const articleKeys = new Set<string>();

    for (const article of params.articles) {
      for (const candidate of getSupplyArticleCandidates(article)) {
        articleKeys.add(candidate);
      }
    }

    const sizeKey = normalizeSupplySize(params.size);

    if (!companyKey || articleKeys.size === 0) return null;

    const sameCompanyItems = ownSupplyItems.filter(
      (item) =>
        item.companyKey === companyKey &&
        [...articleKeys].some((articleKey) => item.articleKeys.has(articleKey))
    );

    if (sameCompanyItems.length === 0) return null;

    const exactSizeItem = sizeKey
      ? sameCompanyItems.find((item) => item.sizeKey && item.sizeKey === sizeKey)
      : null;

    if (sizeKey) {
      return exactSizeItem ?? sameCompanyItems.find((item) => !item.sizeKey) ?? null;
    }

    return sameCompanyItems[0] ?? null;
  }

  const supplyPlanCandidates: SupplyPlanCandidate[] = [];
  const officialOzonSupplyKeys = new Set<string>();

  for (const row of ozonSupplyRecommendations) {
    const vendorCode = normalizeKey(row.vendorCode);
    const sku = normalizeKey(row.sku);
    const size = inferSizeFromVendorCode(vendorCode);
    const wantedQty = Math.max(0, toNumber(row.recommendedSupplyQty));

    if (!vendorCode) continue;

    for (const article of [vendorCode, sku, getMarketplaceBaseArticle(vendorCode)]) {
      const coverageKey = getOzonSupplyCoverageKey({
        companyName: row.companyName,
        article,
      });

      if (coverageKey) officialOzonSupplyKeys.add(coverageKey);
    }

    if (wantedQty <= 0) continue;

    const abc = findStockAbc(ozonAbcMap, {
      companyName: row.companyName,
      articles: [getMarketplaceBaseArticle(vendorCode), vendorCode, sku],
    });

    const baseArticle = getMarketplaceBaseArticle(vendorCode);
    const mappedSupplierArticle = findSupplierArticleByWbArticle({
      companyName: row.companyName,
      wbArticle: baseArticle,
      costs,
    });
    const ownItem = findOwnSupplyItem({
      companyName: row.companyName,
      articles: [vendorCode, sku, baseArticle, mappedSupplierArticle],
      size,
    });

    const currentQty =
      toNumber(row.fboStockQty) +
      toNumber(row.fbsStockQty) +
      toNumber(row.inTransitToOzonQty);

    const visual = makeRowVisual({
      vendorCode,
      sku,
      nmId: null,
    });

    const ownInitialQty = ownItem?.availableQty ?? 0;
    const priority = getSupplyPriority({
      wantedQty,
      ownAvailableQty: ownInitialQty,
      currentQty,
      abc,
      daysWithoutStock: toNumber(row.daysWithoutStock28),
    });

    supplyPlanCandidates.push({
      key: `ozon-supply-${row.id}`,
      marketplace: "OZON",
      priority,
      companyName: row.companyName ?? "Без компании",
      vendorCode,
      sku: sku || null,
      size,
      productName:
        row.productName ??
        visual.name ??
        ownItem?.productName ??
        costNameByVendorCode.get(vendorCode) ??
        null,
      imageUrl: visual.imageUrl ?? ownItem?.imageUrl ?? null,
      targetName: row.clusterName ? `Кластер: ${row.clusterName}` : "Кластер Ozon",
      currentQty,
      ownItemKey: ownItem?.key ?? null,
      wantedQty,
      ownInitialQty,
      avgDailySalesQty:
        row.avgDailySalesQty28 === null || row.avgDailySalesQty28 === undefined
          ? null
          : toNumber(row.avgDailySalesQty28),
      daysWithoutStock:
        row.daysWithoutStock28 === null || row.daysWithoutStock28 === undefined
          ? null
          : toNumber(row.daysWithoutStock28),
      abc,
      reason:
        normalizeKey(row.recommendation) ||
        `Ozon рекомендует поставить ${formatNumber(wantedQty)} шт. в кластер.`,
      details: [
        row.recommendationPeriodDays
          ? `Период: ${formatNumber(row.recommendationPeriodDays)} дн.`
          : "",
        row.avgDailySalesQty28 !== null && row.avgDailySalesQty28 !== undefined
          ? `Продажи: ${formatNumber(toNumber(row.avgDailySalesQty28))} шт/день`
          : "",
        row.daysWithoutStock28 !== null && row.daysWithoutStock28 !== undefined
          ? `Без остатка: ${formatNumber(toNumber(row.daysWithoutStock28))} дн.`
          : "",
      ].filter(Boolean),
    });
  }

  const ozonArticleCompanyByArticleKey = new Map<string, string | null>();

  for (const stock of ozonStocks) {
    registerUniqueArticleCompany(
      ozonArticleCompanyByArticleKey,
      stock.vendorCode,
      stock.companyName
    );
    registerUniqueArticleCompany(
      ozonArticleCompanyByArticleKey,
      stock.sku,
      stock.companyName
    );
  }

  for (const stock of warehouseStocks) {
    registerUniqueArticleCompany(
      ozonArticleCompanyByArticleKey,
      stock.vendorCode,
      stock.companyName
    );
    registerUniqueArticleCompany(
      ozonArticleCompanyByArticleKey,
      stock.sku,
      stock.companyName
    );
  }

  const ozonStockQtyByArticleKey = new Map<string, number>();

  for (const stock of ozonStocks) {
    const currentQty =
      toNumber(stock.availableQty) +
      toNumber(stock.preparingQty) +
      toNumber(stock.supplyQty) +
      toNumber(stock.inTransitQty);

    if (currentQty <= 0) continue;

    for (const article of [stock.vendorCode, stock.sku]) {
      const stockKey = getOzonSupplyCoverageKey({
        companyName: stock.companyName,
        article,
      });

      if (!stockKey) continue;

      ozonStockQtyByArticleKey.set(
        stockKey,
        (ozonStockQtyByArticleKey.get(stockKey) ?? 0) + currentQty
      );
    }
  }

  const ozonCalculatedGroups = new Map<
    string,
    {
      companyName: string;
      vendorCode: string;
      netSalesQty: number;
      revenue: number;
      rows: OzonProfitRow[];
    }
  >();

  for (const row of ozonProfitAnalytics.rows) {
    const vendorCode = normalizeKey(row.vendorCode);
    const inferredCompanyName =
      findUniqueCompanyByArticle(ozonArticleCompanyByArticleKey, vendorCode) ??
      findUniqueCompanyByArticle(
        ozonArticleCompanyByArticleKey,
        getMarketplaceBaseArticle(vendorCode)
      );
    const companyName =
      rowCompanyName(row, selectedCompanyName) ??
      inferredCompanyName ??
      "Без компании";
    const netSalesQty = Math.max(0, toNumber(row.netSalesQty));

    if (!vendorCode || netSalesQty <= 0) continue;

    const groupKey = `${normalizeSearchValue(companyName)}::${normalizeSupplyArticle(
      vendorCode
    )}`;
    const currentGroup =
      ozonCalculatedGroups.get(groupKey) ??
      ({
        companyName,
        vendorCode,
        netSalesQty: 0,
        revenue: 0,
        rows: [],
      } satisfies {
        companyName: string;
        vendorCode: string;
        netSalesQty: number;
        revenue: number;
        rows: OzonProfitRow[];
      });

    currentGroup.netSalesQty += netSalesQty;
    currentGroup.revenue += toNumber(row.revenue);
    currentGroup.rows.push(row);

    ozonCalculatedGroups.set(groupKey, currentGroup);
  }

  const ozonSalesPeriodDays = getInclusiveDateRangeDays(abcDateFrom, abcDateTo);

  for (const group of ozonCalculatedGroups.values()) {
    const baseArticle = getMarketplaceBaseArticle(group.vendorCode);
    const hasOfficialRecommendation = [group.vendorCode, baseArticle].some((article) => {
      const coverageKey = getOzonSupplyCoverageKey({
        companyName: group.companyName,
        article,
      });

      return coverageKey ? officialOzonSupplyKeys.has(coverageKey) : false;
    });

    if (hasOfficialRecommendation) continue;

    const abc = findStockAbc(ozonAbcMap, {
      companyName: group.companyName,
      articles: [baseArticle, group.vendorCode],
    });
    const abcByProfit = abc?.abcByProfit ?? "C";
    const targetDays = getOzonCalculatedTargetDays(abcByProfit);
    const avgDailySalesQty = group.netSalesQty / ozonSalesPeriodDays;
    const targetQty = Math.ceil(avgDailySalesQty * targetDays);
    const currentQty =
      ozonStockQtyByArticleKey.get(
        getOzonSupplyCoverageKey({
          companyName: group.companyName,
          article: group.vendorCode,
        })
      ) ?? 0;
    const wantedQty = Math.max(0, targetQty - currentQty);

    if (wantedQty <= 0) continue;

    const size = inferSizeFromVendorCode(group.vendorCode);
    const mappedSupplierArticle = findSupplierArticleByWbArticle({
      companyName: group.companyName,
      wbArticle: baseArticle,
      costs,
    });
    const ownItem = findOwnSupplyItem({
      companyName: group.companyName,
      articles: [group.vendorCode, baseArticle, mappedSupplierArticle],
      size,
    });
    const visual = makeRowVisual({
      vendorCode: group.vendorCode,
      sku: null,
      nmId: null,
    });
    const ownInitialQty = ownItem?.availableQty ?? 0;
    const priority = getSupplyPriority({
      wantedQty,
      ownAvailableQty: ownInitialQty,
      currentQty,
      abc,
    });

    supplyPlanCandidates.push({
      key: `ozon-calculated-${normalizeSearchValue(group.companyName)}-${normalizeSupplyArticle(
        group.vendorCode
      )}`,
      marketplace: "OZON",
      priority,
      companyName: group.companyName,
      vendorCode: group.vendorCode,
      sku: null,
      size,
      productName:
        visual.name ??
        ownItem?.productName ??
        costNameByVendorCode.get(normalizeKey(group.vendorCode)) ??
        null,
      imageUrl: visual.imageUrl ?? ownItem?.imageUrl ?? null,
      targetName: "Ozon API / общий остаток",
      currentQty,
      ownItemKey: ownItem?.key ?? null,
      wantedQty,
      ownInitialQty,
      avgDailySalesQty,
      daysWithoutStock: currentQty <= 0 ? ozonSalesPeriodDays : null,
      abc,
      reason: `Расчётная рекомендация: продажи за ${formatNumber(
        ozonSalesPeriodDays
      )} дн. — ${formatNumber(group.netSalesQty)} шт., целевой запас для ABC ${abcByProfit} — ${formatNumber(
        targetDays
      )} дн.`,
      details: [
        "Источник: расчёт системы по Ozon API, не официальный файл Ozon из ЛК",
        `Целевой запас: ${formatNumber(targetDays)} дн.`,
        `Продажи за период: ${formatNumber(group.netSalesQty)} шт.`,
        `Среднесуточные продажи: ${formatDecimal(avgDailySalesQty)} шт/день`,
        `Текущий остаток Ozon: ${formatNumber(currentQty)} шт.`,
        "Кластеры Ozon API не отдал — направление показано общим Ozon.",
      ],
    });
  }

  const wbStockQtyByWarehouseKey = new Map<string, number>();

  function registerWbStockQty(params: {
    companyName?: string | null;
    article?: string | null;
    size?: string | null;
    warehouseName?: string | null;
    qty: number;
  }) {
    const key = getWbGeoSupplyKey(params);

    if (!key) return;

    wbStockQtyByWarehouseKey.set(key, (wbStockQtyByWarehouseKey.get(key) ?? 0) + params.qty);
  }

  for (const stock of rawWbStocks) {
    if (!stock.warehouseName || stock.warehouseName === "__TOTAL__") continue;

    const stockCompanyName = normalizeKey(stock.companyName) || "Без компании";
    const vendorCode = normalizeKey(stock.vendorCode);
    const nmId = normalizeKey(stock.nmId);
    const size = normalizeKey(stock.size) || inferSizeFromVendorCode(vendorCode);
    const qty = toNumber(stock.warehouseQty);

    for (const article of [nmId, vendorCode]) {
      registerWbStockQty({
        companyName: stockCompanyName,
        article,
        size,
        warehouseName: stock.warehouseName,
        qty,
      });
    }
  }

  const wbGeoDemandGroups = new Map<
    string,
    {
      companyName: string;
      vendorCode: string;
      nmId: string;
      size: string | null;
      warehouseName: string;
      countryNames: Set<string>;
      oblastNames: Set<string>;
      regionNames: Set<string>;
      days: Set<string>;
      grossSalesQty: number;
      returnsQty: number;
      netSalesQty: number;
      salesAmount: number;
      currentQty: number;
      abc: StockAbcInfo | null;
    }
  >();

  for (const sale of wbDailySalesRows) {
    const companyName = normalizeKey(sale.companyName) || "Без компании";
    const vendorCode = normalizeKey(sale.vendorCode);
    const nmId = normalizeKey(sale.nmId);
    const articleKey = nmId || vendorCode;
    const size = normalizeKey(sale.size) || inferSizeFromVendorCode(vendorCode);
    const warehouseName = normalizeKey(sale.warehouseName);
    const quantity = toNumber(sale.quantity);

    if (!articleKey || !warehouseName || quantity === 0) continue;

    const groupKey = getWbGeoSupplyKey({
      companyName,
      article: articleKey,
      size,
      warehouseName,
    });

    if (!groupKey) continue;

    const currentGroup =
      wbGeoDemandGroups.get(groupKey) ??
      ({
        companyName,
        vendorCode,
        nmId,
        size,
        warehouseName,
        countryNames: new Set<string>(),
        oblastNames: new Set<string>(),
        regionNames: new Set<string>(),
        days: new Set<string>(),
        grossSalesQty: 0,
        returnsQty: 0,
        netSalesQty: 0,
        salesAmount: 0,
        currentQty:
          wbStockQtyByWarehouseKey.get(
            getWbGeoSupplyKey({
              companyName,
              article: articleKey,
              size,
              warehouseName,
            })
          ) ?? 0,
        abc: findStockAbc(wbAbcMap, {
          companyName,
          articles: [nmId, vendorCode],
        }),
      } satisfies {
        companyName: string;
        vendorCode: string;
        nmId: string;
        size: string | null;
        warehouseName: string;
        countryNames: Set<string>;
        oblastNames: Set<string>;
        regionNames: Set<string>;
        days: Set<string>;
        grossSalesQty: number;
        returnsQty: number;
        netSalesQty: number;
        salesAmount: number;
        currentQty: number;
        abc: StockAbcInfo | null;
      });

    if (!currentGroup.vendorCode && vendorCode) currentGroup.vendorCode = vendorCode;
    if (!currentGroup.nmId && nmId) currentGroup.nmId = nmId;
    if (!currentGroup.size && size) currentGroup.size = size;

    const countryName = normalizeKey(sale.countryName);
    const oblastName = normalizeKey(sale.oblastOkrugName);
    const regionName = normalizeKey(sale.regionName);

    if (countryName) currentGroup.countryNames.add(countryName);
    if (oblastName) currentGroup.oblastNames.add(oblastName);
    if (regionName) currentGroup.regionNames.add(regionName);

    if (sale.saleDate) {
      currentGroup.days.add(formatDateInput(sale.saleDate));
    }

    if (quantity > 0) currentGroup.grossSalesQty += quantity;
    if (quantity < 0) currentGroup.returnsQty += Math.abs(quantity);

    currentGroup.netSalesQty += quantity;
    currentGroup.salesAmount += toNumber(sale.wbRealizedAmount);

    wbGeoDemandGroups.set(groupKey, currentGroup);
  }

  for (const group of wbGeoDemandGroups.values()) {
    const abcByProfit = group.abc?.abcByProfit ?? "C";
    const targetDays = getWbGeoTargetDays(abcByProfit);

    if (targetDays <= 0) continue;

    const observedDays = Math.max(1, group.days.size);
    const demandQty = Math.max(0, group.netSalesQty);

    if (demandQty <= 0) continue;

    const avgDailySalesQty = demandQty / observedDays;
    const confidenceMultiplier = getWbGeoConfidenceMultiplier(observedDays);
    const targetQty = Math.ceil(avgDailySalesQty * targetDays * confidenceMultiplier);
    const rawWantedQty = Math.max(0, targetQty - group.currentQty);

    if (rawWantedQty <= 0) continue;

    const mappedSupplierArticle = findSupplierArticleByWbArticle({
      companyName: group.companyName,
      wbArticle: group.nmId || group.vendorCode,
      costs,
    });
    const ownItem = findOwnSupplyItem({
      companyName: group.companyName,
      articles: [
        group.vendorCode,
        group.nmId,
        mappedSupplierArticle,
        getMarketplaceBaseArticle(mappedSupplierArticle ?? group.vendorCode),
        getSupplierArticleRoot(mappedSupplierArticle ?? group.vendorCode),
      ],
      size: group.size,
    });
    const ownInitialQty = ownItem?.availableQty ?? 0;

    if (ownInitialQty <= 0) continue;

    const wantedQty = Math.min(rawWantedQty, ownInitialQty);
    const visual = makeRowVisual({
      vendorCode: group.vendorCode || group.nmId,
      sku: null,
      nmId: group.nmId,
    });
    const priority = getSupplyPriority({
      wantedQty,
      ownAvailableQty: ownInitialQty,
      currentQty: group.currentQty,
      abc: group.abc,
    });

    supplyPlanCandidates.push({
      key: `wb-geo-${normalizeSearchValue(group.companyName)}-${normalizeSupplyArticle(
        group.nmId || group.vendorCode
      )}-${normalizeSupplySize(group.size)}-${normalizeSearchValue(group.warehouseName)}`,
      marketplace: "WB",
      priority,
      companyName: group.companyName,
      vendorCode: group.vendorCode || group.nmId,
      sku: null,
      size: group.size,
      productName:
        visual.name ??
        ownItem?.productName ??
        costNameByVendorCode.get(group.vendorCode) ??
        null,
      imageUrl: visual.imageUrl ?? ownItem?.imageUrl ?? null,
      targetName: `WB / ${group.warehouseName}`,
      currentQty: group.currentQty,
      ownItemKey: ownItem?.key ?? null,
      wantedQty,
      ownInitialQty,
      avgDailySalesQty,
      daysWithoutStock: group.currentQty <= 0 ? observedDays : null,
      abc: group.abc,
      reason: `WB география спроса: за ${formatNumber(observedDays)} дн. чистые продажи ${formatNumber(
        demandQty
      )} шт., текущий остаток на складе ${formatNumber(group.currentQty)} шт.`,
      details: [
        `Направление: склад WB “${group.warehouseName}”.`,
        `Регионы спроса: ${compactList(group.regionNames.size > 0 ? group.regionNames : group.oblastNames)}.`,
        `Страны: ${compactList(group.countryNames, 3)}.`,
        `Продажи: ${formatNumber(group.grossSalesQty)} шт.; возвраты: ${formatNumber(group.returnsQty)} шт.; чистый спрос: ${formatNumber(demandQty)} шт.`,
        `Среднесуточный спрос: ${formatDecimal(avgDailySalesQty)} шт/день.`,
        `Целевой запас для ABC ${abcByProfit}: ${formatNumber(targetDays)} дн.`,
        `Коэффициент осторожности по периоду ${formatNumber(observedDays)} дн.: ${formatDecimal(confidenceMultiplier)}.`,
        "Если по направлению нет продаж/выкупов, рекомендация WB не создаётся.",
      ],
    });
  }

  const ownSupplyRemaining = new Map(
    ownSupplyItems.map((item) => [item.key, item.availableQty])
  );

  const supplyPlanRows: SupplyPlanRow[] = supplyPlanCandidates
    .sort((a, b) => {
      const priorityDiff =
        supplyPriorityWeight(b.priority) - supplyPriorityWeight(a.priority);

      if (priorityDiff !== 0) return priorityDiff;

      if (b.ownInitialQty !== a.ownInitialQty) {
        return b.ownInitialQty - a.ownInitialQty;
      }

      return b.wantedQty - a.wantedQty;
    })
    .map((candidate) => {
      const ownAvailableQty = candidate.ownItemKey
        ? ownSupplyRemaining.get(candidate.ownItemKey) ?? 0
        : 0;
      const recommendedQty = Math.min(candidate.wantedQty, ownAvailableQty);

      if (candidate.ownItemKey) {
        ownSupplyRemaining.set(
          candidate.ownItemKey,
          Math.max(0, ownAvailableQty - recommendedQty)
        );
      }

      return {
        ...candidate,
        ownAvailableQty,
        recommendedQty,
      };
    })
    .filter((row) => row.wantedQty > 0);

  const productOptionsMap = new Map<
    string,
    {
      vendorCode: string;
      label: string;
    }
  >();

  for (const row of allRows) {
    if (!row.vendorCode || row.vendorCode === "—") continue;

    if (!productOptionsMap.has(row.vendorCode)) {
      productOptionsMap.set(row.vendorCode, {
        vendorCode: row.vendorCode,
        label: row.vendorCode,
      });
    }
  }

  const productOptions = Array.from(productOptionsMap.values()).sort((a, b) =>
    a.vendorCode.localeCompare(b.vendorCode, "ru", {
      numeric: true,
      sensitivity: "base",
    })
  );

  const filteredRows = allRows
    .filter((row) => {
      if (selectedSource !== "ALL" && row.source !== selectedSource) return false;
      if (selectedProduct && row.vendorCode !== selectedProduct) return false;

      if (searchQuery && !rowMatchesSearch(row, searchQuery)) return false;

      return true;
    })
    .sort((a, b) => {
      const direction = sortDir === "asc" ? 1 : -1;

      if (sortKey === "product") {
        return productTitle(a).localeCompare(productTitle(b), "ru") * direction;
      }

      if (sortKey === "vendorCode") {
        return a.vendorCode.localeCompare(b.vendorCode, "ru") * direction;
      }

      return (toNumber(a[sortKey]) - toNumber(b[sortKey])) * direction;
    });

  const visibleRows = filteredRows.slice(0, rowsLimit);
  const sizeSummarySort = getSizeSummarySort(params.sizeSort);
  const allProductSizeSummaries = sortProductSizeSummaries(
    buildProductSizeSummaries(filteredRows),
    sizeSummarySort
  );
  const sizeSummaryLimit = getSizeSummaryRowsLimit(
    params.sizeRows,
    allProductSizeSummaries.length
  );
  const productSizeSummaries = allProductSizeSummaries.slice(0, sizeSummaryLimit);
  const sizeSummaryOpen = params.sizeOpen === "1";

  const lowStockCount = filteredRows.filter((row) => row.qty > 0 && row.qty < 10).length;
  const ownWarehouseMissingCount = summaries.filter(
    (summary) => summary.warehouse.rowsCount === 0
  ).length;

  const selectedCompanySummary = selectedCompanyName
    ? summaries.find((summary) => summary.companyName === selectedCompanyName)
    : null;

  const dashboardProductionRows = getProductionPlanRows(supplyPlanRows, 20, "ALL");
  const dashboardProductionQty = productionPlanSummaryQty(dashboardProductionRows);
  const dashboardSupplyQty = supplySummaryQty(supplyPlanRows);
  const dashboardCriticalRows = supplyPlanRows.filter(
    (row) => row.priority === "HIGH"
  );
  const dashboardCriticalQty = supplyWantedQty(dashboardCriticalRows);
  const quickSizePreviewRows = productSizeSummaries.slice(0, 4);

  return (
    <main className="min-h-screen bg-slate-100">
      <MarketplaceNav />

      <div className="p-4 sm:p-6 lg:p-8">
        <div className="mx-auto max-w-7xl space-y-4">
          <section className="rounded-[30px] border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div>
                <h1 className="text-3xl font-black tracking-tight text-slate-950">
                  Остатки, поставки и пошив
                </h1>
                <p className="mt-1 max-w-4xl text-sm font-semibold leading-6 text-slate-500">
                  Управляйте остатками, рекомендациями к поставке и планом пошива в одном рабочем экране.
                </p>
              </div>

              <div className="flex flex-wrap gap-2 xl:justify-end">
                <Link
                  href="/import?reportType=OZON_WAREHOUSE_STOCK"
                  className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-black text-slate-700 transition hover:bg-slate-50"
                >
                  Импорт
                </Link>

                <Link
                  href="/api/templates/ozon-warehouse-stock"
                  className="inline-flex items-center justify-center rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm font-black text-emerald-700 transition hover:bg-emerald-100"
                >
                  Скачать шаблон
                </Link>

                <Link
                  href={selectedCompanyName ? `/stocks?companyName=${encodeURIComponent(selectedCompanyName)}` : "/stocks"}
                  className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-black text-slate-700 transition hover:bg-slate-50"
                >
                  Сбросить
                </Link>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-1 rounded-[22px] bg-slate-50 p-1 ring-1 ring-slate-100">
              {[
                ["Обзор", "#overview"],
                ["Размеры", "#sizes"],
                ["Поставки", "#supply-plan"],
                ["Пошив", "#production-plan"],
                ["Детализация", "#details"],
              ].map(([label, href]) => (
                <a
                  key={label}
                  href={href}
                  className={`rounded-2xl px-4 py-2 text-sm font-black transition ${
                    href === "#supply-plan"
                      ? "bg-white text-blue-700 shadow-sm ring-1 ring-blue-100"
                      : "text-slate-600 hover:bg-white hover:text-slate-950"
                  }`}
                >
                  {label}
                </a>
              ))}
            </div>

            <form className="mt-4 grid gap-3 rounded-[24px] border border-slate-200 bg-white p-3 md:grid-cols-2 xl:grid-cols-[minmax(180px,1fr)_minmax(180px,1fr)_150px_minmax(260px,1.3fr)_140px]">
              <input type="hidden" name="dateFrom" value={abcDateFrom} />
              <input type="hidden" name="dateTo" value={abcDateTo} />
              <select
                name="companyName"
                defaultValue={selectedCompanyName ?? "ALL"}
                className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none transition focus:border-blue-200 focus:ring-4 focus:ring-blue-50"
                aria-label="Компания"
              >
                <option value="ALL">Все компании</option>
                {companyNames.map((companyName) => (
                  <option key={companyName} value={companyName}>
                    {companyName}
                  </option>
                ))}
              </select>

              <select
                name="source"
                defaultValue={selectedSource}
                className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none transition focus:border-blue-200 focus:ring-4 focus:ring-blue-50"
              >
                <option value="ALL">Маркетплейс: все</option>
                <option value="WB">WB</option>
                <option value="OZON">Ozon</option>
                <option value="OWN">Свой склад</option>
              </select>

              <select
                name="rows"
                defaultValue={String(rowsLimit)}
                className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none transition focus:border-blue-200 focus:ring-4 focus:ring-blue-50"
              >
                <option value="20">20 строк</option>
                <option value="50">50 строк</option>
                <option value="100">100 строк</option>
                <option value="200">200 строк</option>
              </select>

              <input
                name="q"
                defaultValue={params.q ?? ""}
                placeholder="Поиск по артикулу, SKU, названию"
                className="h-11 rounded-2xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none transition placeholder:text-slate-300 focus:border-blue-200 focus:ring-4 focus:ring-blue-50"
              />

              <button className="h-11 rounded-2xl bg-slate-950 px-5 text-sm font-black text-white shadow-lg shadow-slate-200 transition hover:bg-slate-800">
                Применить
              </button>
            </form>
          </section>

          <section id="overview" className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              title="Остатки всего"
              value={`${formatNumber(totalWbQty + totalOzonQty + totalWarehouseQty)} шт`}
              money={formatMoney(totalWbCost + totalOzonCost + totalWarehouseCost)}
              hint="WB + Ozon + собственный склад"
              tone="blue"
              icon="□"
            />
            <MetricCard
              title="К отгрузке"
              value={`${formatNumber(dashboardSupplyQty)} шт`}
              money="по плану поставок"
              hint="С учётом спроса и доступного склада"
              tone="emerald"
              icon="⇄"
            />
            <MetricCard
              title="К пошиву"
              value={`${formatNumber(dashboardProductionQty)} шт`}
              money="буфер 20 дней"
              hint={`${formatNumber(dashboardProductionRows.length)} товар/размер`}
              tone="violet"
              icon="♢"
            />
            <MetricCard
              title="Критичный дефицит"
              value={`${formatNumber(dashboardCriticalRows.length)} строк`}
              money={`${formatNumber(dashboardCriticalQty)} шт`}
              hint="Высокий приоритет в плане поставок"
              tone="amber"
              icon="!"
            />
          </section>

          <section id="sizes" className="rounded-[26px] border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <h2 className="text-xl font-black tracking-tight text-slate-950">
                  Остатки по компаниям
                </h2>
                <p className="mt-1 text-sm font-semibold leading-6 text-slate-500">
                  Консолидированная картина остатков по компаниям и каналам: WB, Ozon и собственный склад.
                </p>
              </div>
              <a
                href="#details"
                className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-black text-slate-700 transition hover:bg-slate-50"
              >
                Открыть детально →
              </a>
            </div>

            {summaries.length > 0 ? (
              <div className="mt-4 space-y-2">
                {summaries.map((summary) => (
                  <article
                    key={summary.companyName}
                    className="grid gap-3 rounded-[22px] border border-slate-200 bg-white p-3 shadow-sm xl:grid-cols-[1.25fr_0.85fr_0.85fr_1fr_0.8fr_0.9fr_auto] xl:items-center"
                  >
                    <div className="min-w-0">
                      <div className="text-lg font-black text-slate-950">
                        {summary.companyName}
                      </div>
                      <div className="mt-0.5 text-xs font-bold text-slate-400">
                        Обновление: {summary.lastUpdate}
                      </div>
                    </div>

                    <div className="rounded-2xl bg-violet-50 px-4 py-3 ring-1 ring-violet-100">
                      <div className="text-xs font-black uppercase text-violet-600">WB</div>
                      <div className="mt-1 text-base font-black text-slate-950">
                        {formatNumber(summary.wb.totalQty)} шт
                      </div>
                    </div>

                    <div className="rounded-2xl bg-blue-50 px-4 py-3 ring-1 ring-blue-100">
                      <div className="text-xs font-black uppercase text-blue-600">Ozon</div>
                      <div className="mt-1 text-base font-black text-slate-950">
                        {formatNumber(summary.ozon.totalQty)} шт
                      </div>
                    </div>

                    <div className="rounded-2xl bg-emerald-50 px-4 py-3 ring-1 ring-emerald-100">
                      <div className="text-xs font-black uppercase text-emerald-700">Собственный склад</div>
                      <div className="mt-1 text-base font-black text-slate-950">
                        {formatNumber(summary.warehouse.warehouseQty)} шт
                      </div>
                    </div>

                    <div>
                      <div className="text-xs font-bold text-slate-400">Всего</div>
                      <div className="mt-1 text-lg font-black text-slate-950">
                        {formatNumber(summary.totalQty)} шт
                      </div>
                    </div>

                    <div>
                      <div className="text-xs font-bold text-slate-400">Стоимость</div>
                      <div className="mt-1 text-lg font-black text-slate-950">
                        {formatMoney(summary.totalCost)}
                      </div>
                    </div>

                    <Link
                      href={`/stocks?companyName=${encodeURIComponent(summary.companyName)}`}
                      className="inline-flex h-11 items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 text-sm font-black text-slate-700 transition hover:bg-slate-50"
                    >
                      →
                    </Link>
                  </article>
                ))}
              </div>
            ) : (
              <div className="mt-4 rounded-2xl border border-dashed border-slate-200 p-4 text-sm font-bold text-slate-500">
                Остатки по компаниям пока не найдены.
              </div>
            )}
          </section>

          <section className="hidden gap-4 xl:grid-cols-4">
            <section className="rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm xl:col-span-3">
              <div>
                <h2 className="text-xl font-black tracking-tight text-slate-950">
                  {selectedCompanyName
                    ? `Компания: ${selectedCompanyName}`
                    : "Остатки по компаниям"}
                </h2>
                <p className="mt-1 text-sm font-semibold text-slate-500">
                  Общий остаток по всем источникам: WB + Ozon + собственный склад.
                </p>
              </div>

              <div
                className={`mt-3 grid gap-3 ${
                  selectedCompanyName ? "grid-cols-1" : "xl:grid-cols-2"
                }`}
              >
                {summaries.map((summary) => (
                  <article
                    key={summary.companyName}
                    className="rounded-[24px] border border-slate-200 bg-white p-3 shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-violet-600 text-sm font-black text-white">
                          {summary.companyName.slice(0, 1)}
                        </div>
                        <div>
                          <h3 className="text-base font-black text-slate-950">
                            {summary.companyName}
                          </h3>
                          <p className="text-[11px] font-bold text-slate-400">
                            Обновление: {summary.lastUpdate}
                          </p>
                        </div>
                      </div>

                      {!selectedCompanyName ? (
                        <Link
                          href={`/stocks?companyName=${encodeURIComponent(
                            summary.companyName
                          )}`}
                          className="rounded-2xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-black text-slate-700 transition hover:bg-slate-50"
                        >
                          Подробнее →
                        </Link>
                      ) : (
                        <Link
                          href="/stocks"
                          className="rounded-2xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-black text-slate-700 transition hover:bg-slate-50"
                        >
                          Все компании
                        </Link>
                      )}
                    </div>

                    <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                      <div className="rounded-2xl bg-slate-50 p-2 ring-1 ring-slate-100">
                        <div className="text-[11px] font-black uppercase text-slate-400">
                          Итого
                        </div>
                        <div className="mt-1 whitespace-nowrap text-sm font-black text-slate-950">
                          {formatNumber(summary.totalQty)} шт
                        </div>
                        <div className="mt-0.5 whitespace-nowrap text-[11px] font-bold text-slate-500">
                          {formatMoney(summary.totalCost)}
                        </div>
                      </div>

                      <div className="rounded-2xl bg-violet-50 p-2 ring-1 ring-violet-100">
                        <div className="text-[11px] font-black uppercase text-violet-500">
                          WB
                        </div>
                        <div className="mt-1 whitespace-nowrap text-sm font-black text-slate-950">
                          {formatNumber(summary.wb.totalQty)} шт
                        </div>
                        <div className="mt-0.5 whitespace-nowrap text-[11px] font-bold text-slate-500">
                          {formatMoney(summary.wb.totalCost)}
                        </div>
                      </div>

                      <div className="rounded-2xl bg-blue-50 p-2 ring-1 ring-blue-100">
                        <div className="text-[11px] font-black uppercase text-blue-500">
                          Ozon
                        </div>
                        <div className="mt-1 whitespace-nowrap text-sm font-black text-slate-950">
                          {formatNumber(summary.ozon.totalQty)} шт
                        </div>
                        <div className="mt-0.5 whitespace-nowrap text-[11px] font-bold text-slate-500">
                          {formatMoney(summary.ozon.totalCost)}
                        </div>
                      </div>

                      <div className="rounded-2xl bg-emerald-50 p-2 ring-1 ring-emerald-100">
                        <div className="text-[11px] font-black uppercase text-emerald-500">
                          Склад
                        </div>
                        <div className="mt-1 whitespace-nowrap text-sm font-black text-slate-950">
                          {formatNumber(summary.warehouse.warehouseQty)} шт
                        </div>
                        <div className="mt-0.5 whitespace-nowrap text-[11px] font-bold text-slate-500">
                          {formatMoney(summary.warehouse.totalCost)}
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
              </div>

              {summaries.length === 0 ? (
                <div className="mt-3 rounded-2xl border border-dashed border-slate-300 p-5 text-center text-sm font-bold text-slate-500">
                  Компании пока не найдены.
                </div>
              ) : null}
            </section>

            <CompactAttention
              lowStockCount={lowStockCount}
              ownWarehouseMissingCount={ownWarehouseMissingCount}
              reservedQty={totalReservedQty}
            />
          </section>

          {selectedCompanySummary ? (
            <section className="hidden gap-4 xl:grid-cols-3">
              <div className="rounded-[26px] border border-violet-100 bg-violet-50 p-5 shadow-sm">
                <div className="text-xs font-black uppercase tracking-[0.12em] text-violet-600">
                  Wildberries
                </div>
                <div className="mt-3 text-3xl font-black text-slate-950">
                  {formatNumber(selectedCompanySummary.wb.totalQty)} шт
                </div>
                <div className="mt-1 text-lg font-black text-slate-700">
                  {formatMoney(selectedCompanySummary.wb.totalCost)}
                </div>
                <div className="mt-4 grid gap-2 text-sm font-bold text-slate-600">
                  <div>
                    На складах: {formatNumber(selectedCompanySummary.wb.stockQty)} шт
                  </div>
                  <div>
                    К покупателям:{" "}
                    {formatNumber(
                      selectedCompanySummary.wb.inTransitToCustomerQty
                    )}{" "}
                    шт
                  </div>
                  <div>
                    Возвраты:{" "}
                    {formatNumber(selectedCompanySummary.wb.inTransitReturnsQty)} шт
                  </div>
                </div>
              </div>

              <div className="rounded-[26px] border border-blue-100 bg-blue-50 p-5 shadow-sm">
                <div className="text-xs font-black uppercase tracking-[0.12em] text-blue-600">
                  Ozon
                </div>
                <div className="mt-3 text-3xl font-black text-slate-950">
                  {formatNumber(selectedCompanySummary.ozon.totalQty)} шт
                </div>
                <div className="mt-1 text-lg font-black text-slate-700">
                  {formatMoney(selectedCompanySummary.ozon.totalCost)}
                </div>
                <div className="mt-4 grid gap-2 text-sm font-bold text-slate-600">
                  <div>
                    Доступно: {formatNumber(selectedCompanySummary.ozon.availableQty)} шт
                  </div>
                  <div>
                    Готовится: {formatNumber(selectedCompanySummary.ozon.preparingQty)} шт
                  </div>
                  <div>
                    В пути: {formatNumber(selectedCompanySummary.ozon.inTransitQty)} шт
                  </div>
                </div>
              </div>

              <div className="rounded-[26px] border border-emerald-100 bg-emerald-50 p-5 shadow-sm">
                <div className="text-xs font-black uppercase tracking-[0.12em] text-emerald-600">
                  Собственный склад
                </div>
                <div className="mt-3 text-3xl font-black text-slate-950">
                  {formatNumber(selectedCompanySummary.warehouse.warehouseQty)} шт
                </div>
                <div className="mt-1 text-lg font-black text-slate-700">
                  {formatMoney(selectedCompanySummary.warehouse.totalCost)}
                </div>
                <div className="mt-4 grid gap-2 text-sm font-bold text-slate-600">
                  <div>
                    К поставке:{" "}
                    {formatNumber(
                      selectedCompanySummary.warehouse.availableForSupplyQty
                    )}{" "}
                    шт
                  </div>
                  <div>
                    Резерв: {formatNumber(selectedCompanySummary.warehouse.reservedQty)} шт
                  </div>
                  <div>
                    Себест. к поставке:{" "}
                    {formatMoney(
                      selectedCompanySummary.warehouse.availableForSupplyCost
                    )}
                  </div>
                </div>
              </div>
            </section>
          ) : null}

          <section id="supply-plan" className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
            <div className="min-w-0 space-y-4">
              <SupplyPlanningBlock rows={supplyPlanRows} params={params} companyNames={companyNames} />
              <ProductionPlanningBlock rows={supplyPlanRows} params={params} companyNames={companyNames} />
            </div>

            <aside className="space-y-3">
              <div className="rounded-[26px] border border-slate-200 bg-white p-4 shadow-sm">
                <div className="text-xs font-black uppercase tracking-[0.12em] text-blue-600">
                  Быстрые рекомендации
                </div>
                <div className="mt-3 space-y-3">
                  <div className="rounded-2xl bg-red-50 p-3 ring-1 ring-red-100">
                    <div className="text-sm font-black text-red-700">
                      Товары ABC A с нулевым остатком
                    </div>
                    <p className="mt-1 text-xs font-bold leading-5 text-slate-600">
                      Найдено {formatNumber(dashboardCriticalRows.length)} критичных строк. Проверьте поставку и пошив перед следующей закупкой.
                    </p>
                  </div>

                  <div className="rounded-2xl bg-blue-50 p-3 ring-1 ring-blue-100">
                    <div className="text-sm font-black text-blue-700">
                      География WB обновляется ежедневно
                    </div>
                    <p className="mt-1 text-xs font-bold leading-5 text-slate-600">
                      План WB строится по складам и регионам спроса. Чем больше истории, тем точнее рекомендации.
                    </p>
                  </div>

                  <div className="rounded-2xl bg-amber-50 p-3 ring-1 ring-amber-100">
                    <div className="text-sm font-black text-amber-800">
                      Короткий сезон
                    </div>
                    <p className="mt-1 text-xs font-bold leading-5 text-slate-600">
                      Для футболок и шорт проверяйте ABC и буфер пошива. В конце сезона лучше снижать буфер.
                    </p>
                  </div>
                </div>
              </div>
            </aside>
          </section>

          <section id="details" className="rounded-[30px] border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div>
                <h2 className="text-2xl font-black tracking-tight text-slate-950">
                  Детализация по товарам
                </h2>
                <p className="mt-1 max-w-3xl text-sm font-semibold leading-6 text-slate-500">
                  Выберите товар, чтобы увидеть все размеры и остатки по
                  маркетплейсам и складам.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Link
                  href={makeUrl(params, {})}
                  className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 transition hover:bg-slate-50"
                >
                  Экспорт в Excel
                </Link>
              </div>
            </div>

            <form className="mt-5 grid gap-3 xl:grid-cols-[minmax(240px,1fr)_220px_170px_160px_140px]">
              <input
                type="hidden"
                name="companyName"
                value={selectedCompanyName ?? "ALL"}
              />
              <input type="hidden" name="dateFrom" value={abcDateFrom} />
              <input type="hidden" name="dateTo" value={abcDateTo} />

              <input
                name="q"
                defaultValue={params.q ?? ""}
                placeholder="Поиск по названию, артикулу, SKU"
                className="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-bold text-slate-700 outline-none transition focus:border-violet-200 focus:ring-4 focus:ring-violet-50"
              />

              <select
                name="product"
                defaultValue={selectedProduct || "ALL"}
                className="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-bold text-slate-700 outline-none"
              >
                <option value="ALL">Товар: все</option>
                {productOptions.map((product) => (
                  <option key={product.vendorCode} value={product.vendorCode}>
                    {product.label.length > 34
                      ? `${product.label.slice(0, 34)}...`
                      : product.label}
                  </option>
                ))}
              </select>

              <select
                name="source"
                defaultValue={selectedSource}
                className="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-bold text-slate-700 outline-none"
              >
                <option value="ALL">Источник: все</option>
                <option value="WB">WB</option>
                <option value="OZON">Ozon</option>
                <option value="OWN">Свой склад</option>
              </select>

              <select
                name="rows"
                defaultValue={String(rowsLimit)}
                className="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-bold text-slate-700 outline-none"
              >
                <option value="20">Показывать: 20</option>
                <option value="50">Показывать: 50</option>
                <option value="100">Показывать: 100</option>
                <option value="200">Показывать: 200</option>
              </select>

              <button className="rounded-2xl bg-slate-950 px-4 py-2.5 text-sm font-black text-white shadow-lg shadow-slate-300 transition hover:bg-slate-800">
                Применить
              </button>
            </form>

            <div className="mt-3">
              <Link
                href={
                  selectedCompanyName
                    ? `/stocks?companyName=${encodeURIComponent(selectedCompanyName)}`
                    : "/stocks"
                }
                className="inline-flex rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-black text-slate-600 transition hover:bg-slate-50"
              >
                Сбросить фильтры
              </Link>
            </div>

            {allProductSizeSummaries.length > 0 ? (
              <details
                open={sizeSummaryOpen}
                className="mt-5 rounded-[26px] border border-slate-200 bg-slate-50 p-4 shadow-sm"
              >
                <summary className="cursor-pointer list-none outline-none">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                      <h3 className="text-lg font-black tracking-tight text-slate-950">
                        Быстрый разбор по размерам
                      </h3>
                      <p className="mt-1 max-w-4xl text-sm font-semibold leading-6 text-slate-500">
                        WB, Ozon и склад разделены по размерам. ABC считается по свежим данным продаж.
                      </p>
                    </div>

                    <div className="inline-flex items-center justify-center rounded-2xl bg-white px-4 py-2 text-sm font-black text-slate-600 ring-1 ring-slate-200">
                      Показано {formatNumber(productSizeSummaries.length)} из{" "}
                      {formatNumber(allProductSizeSummaries.length)}
                    </div>
                  </div>
                </summary>

                <form className="mt-4 grid gap-2 rounded-[22px] border border-slate-200 bg-white p-3 md:grid-cols-[minmax(0,1fr)_190px_220px_180px_130px]">
                  <select
                    name="companyName"
                    defaultValue={selectedCompanyName ?? "ALL"}
                    className="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-bold text-slate-700 outline-none"
                  >
                    <option value="ALL">Все компании</option>
                    {companyNames.map((companyName) => (
                      <option key={companyName} value={companyName}>
                        {companyName}
                      </option>
                    ))}
                  </select>
                  {selectedSource !== "ALL" ? (
                    <input type="hidden" name="source" value={selectedSource} />
                  ) : null}
                  {selectedProduct ? (
                    <input type="hidden" name="product" value={selectedProduct} />
                  ) : null}
                  {searchQuery ? <input type="hidden" name="q" value={searchQuery} /> : null}
                  <input type="hidden" name="rows" value={String(rowsLimit)} />
                  <input type="hidden" name="sort" value={sortKey} />
                  <input type="hidden" name="dir" value={sortDir} />
                  <input type="hidden" name="sizeOpen" value="1" />
                  <input type="hidden" name="dateFrom" value={abcDateFrom} />
                  <input type="hidden" name="dateTo" value={abcDateTo} />

                  <div className="flex items-center rounded-2xl bg-slate-50 px-3 py-2.5 text-sm font-black text-slate-600 ring-1 ring-slate-200">
                    Группировка
                  </div>

                  <select
                    name="sizeSort"
                    defaultValue={sizeSummarySort}
                    className="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-bold text-slate-700 outline-none"
                  >
                    <option value="totalDesc">Сначала больше всего</option>
                    <option value="totalAsc">Сначала меньше всего</option>
                    <option value="wbDesc">Больше всего на WB</option>
                    <option value="ozonDesc">Больше всего на Ozon</option>
                    <option value="ownDesc">Больше всего на складе</option>
                    <option value="lowDesc">Сначала проблемные размеры</option>
                    <option value="nameAsc">По названию А–Я</option>
                  </select>

                  <select
                    name="sizeRows"
                    defaultValue={params.sizeRows ?? "20"}
                    className="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-bold text-slate-700 outline-none"
                  >
                    <option value="8">Показать 8</option>
                    <option value="20">Показать 20</option>
                    <option value="50">Показать 50</option>
                    <option value="100">Показать 100</option>
                    <option value="200">Показать 200</option>
                    <option value="ALL">Показать все</option>
                  </select>

                  <button className="rounded-2xl bg-slate-950 px-4 py-2.5 text-sm font-black text-white shadow-lg shadow-slate-300 transition hover:bg-slate-800">
                    Применить
                  </button>
                </form>

                <div className="mt-4 grid gap-3">
                  {productSizeSummaries.map((group) => (
                    <ProductSizeSummaryCard
                      key={group.groupKey}
                      group={group}
                    />
                  ))}
                </div>
              </details>
            ) : null}

            <div className="mt-5 overflow-hidden rounded-[26px] border border-slate-200">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] table-fixed text-left">
                  <thead className="bg-slate-50 text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                    <tr>
                      <th className="sticky left-0 z-20 w-[330px] bg-slate-50 px-4 py-4 shadow-[1px_0_0_0_rgba(226,232,240,1)]">
                        <SortHeader params={params} sortKey="product">
                          Товар
                        </SortHeader>
                      </th>
                      <th className="w-[180px] px-3 py-4">
                        <SortHeader params={params} sortKey="vendorCode">
                          Артикул / SKU / размер
                        </SortHeader>
                      </th>
                      <th className="w-[190px] px-3 py-4">Источник / склад</th>
                      <th className="w-[110px] px-3 py-4 text-right">
                        <SortHeader params={params} sortKey="qty" align="right">
                          Остаток
                        </SortHeader>
                      </th>
                      <th className="w-[120px] px-3 py-4 text-right">
                        <SortHeader params={params} sortKey="costPrice" align="right">
                          Себест.
                        </SortHeader>
                      </th>
                      <th className="w-[190px] px-4 py-4 text-right">
                        <SortHeader params={params} sortKey="totalCost" align="right">
                          Стоимость / поставка
                        </SortHeader>
                      </th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-slate-100 bg-white text-sm">
                    {visibleRows.map((row) => (
                      <tr key={row.key} className="group hover:bg-slate-50">
                        <td className="sticky left-0 z-10 bg-white px-4 py-3 shadow-[1px_0_0_0_rgba(241,245,249,1)] transition group-hover:bg-slate-50">
                          <div className="flex items-center gap-3">
                            <ProductPhoto
                              imageUrl={row.imageUrl}
                              title={productTitle(row)}
                            />

                            <div className="min-w-0">
                              <div className="line-clamp-2 text-sm font-black leading-5 text-slate-950">
                                {row.productName ?? "Название не загружено"}
                              </div>
                              <div className="mt-1 truncate text-xs font-bold text-slate-400">
                                {row.companyName}
                              </div>
                            </div>
                          </div>
                        </td>

                        <td className="px-3 py-3 align-middle">
                          <div className="break-words text-sm font-black leading-5 text-slate-950">
                            {row.vendorCode && row.vendorCode !== "—"
                              ? row.vendorCode
                              : row.source === "WB" && row.nmId
                                ? `WB: ${row.nmId}`
                                : "—"}
                          </div>

                          <div className="mt-1 break-all text-xs font-bold leading-4 text-slate-500">
                            {row.sku
                              ? `SKU: ${row.sku}`
                              : row.nmId
                                ? `NM ID: ${row.nmId}`
                                : "SKU / NM ID: —"}
                          </div>

                          <div
                            className={`mt-1 inline-flex rounded-full px-2.5 py-1 text-xs font-black ring-1 ${
                              getDisplaySize(row)
                                ? "bg-slate-50 text-slate-700 ring-slate-200"
                                : "bg-amber-50 text-amber-700 ring-amber-100"
                            }`}
                          >
                            Размер: {getDisplaySize(row) ?? "не загружен"}
                          </div>

                          {!getDisplaySize(row) && row.barcode ? (
                            <div className="mt-1 break-all text-[11px] font-bold leading-4 text-slate-400">
                              ШК: {row.barcode}
                            </div>
                          ) : null}
                        </td>

                        <td className="px-3 py-3 align-middle">
                          <span
                            className={`inline-flex rounded-full px-3 py-1 text-xs font-black ring-1 ${sourceClass(
                              row.source
                            )}`}
                          >
                            {sourceLabel(row.source)}
                          </span>
                          <div
                            className="mt-2 truncate text-xs font-bold leading-4 text-slate-500"
                            title={rawStockPlace(row)}
                          >
                            {compactStockPlace(row)}
                          </div>
                          {row.abc ? (
                            <div className="mt-2 flex items-center gap-1.5">
                              <span className="text-[11px] font-black text-slate-400">
                                ABC
                              </span>
                              <AbcBadge value={row.abc.abcByProfit} compact />
                            </div>
                          ) : null}
                        </td>

                        <td className="px-3 py-3 text-right align-middle">
                          <div className="text-base font-black text-slate-950">
                            {formatNumber(row.qty)}
                          </div>
                          <div className="mt-1 text-[11px] font-bold text-slate-400">
                            шт.
                          </div>
                        </td>

                        <td className="px-3 py-3 text-right align-middle">
                          <div className="font-black text-slate-700">
                            {formatMoney(row.costPrice)}
                          </div>
                          <div className="mt-1 text-[11px] font-bold text-slate-400">
                            за ед.
                          </div>
                        </td>

                        <td className="px-4 py-3 text-right align-middle">
                          <div className="font-black text-slate-950">
                            {formatMoney(row.totalCost)}
                          </div>
                          <div className="mt-1 text-xs font-bold text-emerald-700">
                            К поставке: {formatNumber(row.availableForSupplyQty)}
                          </div>
                          {row.reservedQty > 0 ? (
                            <div className="mt-1 text-xs font-bold text-amber-600">
                              Резерв: {formatNumber(row.reservedQty)}
                            </div>
                          ) : (
                            <div className="mt-1 text-xs font-bold text-slate-400">
                              Резерв: 0
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}

                    {visibleRows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={6}
                          className="px-4 py-12 text-center text-sm font-bold text-slate-500"
                        >
                          По выбранным фильтрам остатков нет.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="mt-4 flex flex-col gap-3 text-sm font-bold text-slate-500 sm:flex-row sm:items-center sm:justify-between">
              <div>
                Показано {formatNumber(visibleRows.length)} из{" "}
                {formatNumber(filteredRows.length)} строк
              </div>

              <div className="rounded-2xl bg-slate-50 px-4 py-2 ring-1 ring-slate-200">
                По умолчанию: больше остатков → меньше. Можно сортировать по клику
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
