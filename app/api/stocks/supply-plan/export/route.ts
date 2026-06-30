import { NextResponse } from "next/server";
import ExcelJS from "exceljs";

import { prisma } from "@/lib/prisma";
import { getProfitAnalytics } from "@/lib/analytics/profitAnalytics";
import { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type AbcCategory = "A" | "B" | "C";
type Marketplace = "WB" | "OZON";
type Priority = "HIGH" | "MEDIUM" | "LOW";
type SupplyReservationMode =
  | "OZON_FIRST"
  | "WB_FIRST"
  | "OZON_ONLY"
  | "WB_ONLY"
  | "OZON_CANCELLED_TO_WB"
  | "WB_CANCELLED_TO_OZON";

type StockAbcInfo = {
  abcByRevenue: AbcCategory;
  abcByProfit: AbcCategory;
};

type OwnSupplyItem = {
  key: string;
  companyName: string;
  companyKey: string;
  articleKeys: Set<string>;
  ownArticle: string | null;
  sizeKey: string;
  availableQty: number;
  productName: string | null;
};

type SupplyPlanCandidate = {
  key: string;
  marketplace: Marketplace;
  priority: Priority;
  companyName: string;
  vendorCode: string;
  sku: string | null;
  barcode: string | null;
  ownArticle?: string | null;
  size: string | null;
  productName: string | null;
  targetName: string;
  targetAliases?: string[];
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

function normalizeKey(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeSearchValue(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[\s\-_/\\.]+/g, "")
    .trim();
}

function normalizeArticleForMatch(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[\s\-_/\\.]+/g, "")
    .trim();
}

function normalizeSupplyArticle(value: unknown) {
  return normalizeArticleForMatch(value);
}

function normalizeSupplySize(value: unknown) {
  return normalizeSearchValue(value);
}

function toNumber(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function formatNumber(value: number) {
  return Math.round(value).toLocaleString("ru-RU");
}

function addUtcDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function formatDateInput(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getDefaultPeriod() {
  const now = new Date();
  const dateTo = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );

  return {
    dateFrom: formatDateInput(addUtcDays(dateTo, -30)),
    dateTo: formatDateInput(dateTo),
  };
}

function toAbcCategory(value: unknown): AbcCategory {
  return value === "A" || value === "B" || value === "C" ? value : "C";
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

function getSupplierArticleRoot(value: unknown) {
  const vendorCode = normalizeKey(value);

  if (!vendorCode) return "";

  return vendorCode.split("-")[0]?.trim() ?? vendorCode;
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

function getWbRecommendationDays(value: string) {
  const parsed = Number(value || 14);

  return [14, 21, 28, 56].includes(parsed) ? parsed : 14;
}

function getOzonRecommendationDays(value: string) {
  const parsed = Number(value || 14);

  return [14, 21, 28, 56].includes(parsed) ? parsed : 14;
}

function getOzonRecommendationQty(
  row: {
    recommendationPeriodDays?: number | null;
    recommendedSupplyQty?: number | null;
  },
  targetDays: number
) {
  const baseQty = Math.max(0, toNumber(row.recommendedSupplyQty));
  const sourceDays = getOzonRecommendationDays(String(row.recommendationPeriodDays ?? 14));

  if (baseQty <= 0) return 0;
  if (sourceDays === targetDays) return baseQty;

  return Math.ceil((baseQty / sourceDays) * targetDays);
}

function getWbRecommendationQty(
  row: {
    recommendedQty14?: number | null;
    recommendedQty21?: number | null;
    recommendedQty28?: number | null;
    recommendedQty56?: number | null;
  },
  days: number
) {
  if (days === 21) return toNumber(row.recommendedQty21);
  if (days === 28) return toNumber(row.recommendedQty28);
  if (days === 56) return toNumber(row.recommendedQty56);

  return toNumber(row.recommendedQty14);
}

function isAllRegionsName(value: unknown) {
  const text = normalizeSearchValue(value);

  return text === normalizeSearchValue("Все регионы");
}

function getWbOfficialCoverageKey(params: {
  companyName?: string | null;
  article?: string | null;
  size?: string | null;
}) {
  const companyKey = normalizeSearchValue(params.companyName);
  const articleKey = normalizeSupplyArticle(params.article);
  const sizeKey = normalizeSupplySize(params.size);

  return companyKey && articleKey ? `${companyKey}::${articleKey}::${sizeKey}` : "";
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


function splitWbWarehouseNames(value: unknown) {
  const text = normalizeKey(value);

  if (!text) return [];

  return text
    .split(/[,;|\n]+/g)
    .map((part) => part.replace(/^\s*\u0441\u043a\u043b\u0430\u0434\s*/i, "").trim())
    .filter(Boolean);
}

function formatWbSupplyDirectionName(params: {
  warehouseName?: string | null;
  regionName?: string | null;
  fallback?: string;
}) {
  const warehouseName = normalizeKey(params.warehouseName);
  const regionName = normalizeKey(params.regionName);
  const fallback = normalizeKey(params.fallback) || "WB / \u043d\u0430\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u0438\u0435";

  if (warehouseName && regionName) return `WB / ${warehouseName} / ${regionName}`;
  if (warehouseName) return `WB / ${warehouseName}`;
  if (regionName) return `WB / ${regionName}`;

  return fallback;
}

function formatWbOfficialDirectionName(warehousesText: unknown, regionName: unknown) {
  const warehouses = splitWbWarehouseNames(warehousesText);
  const primaryWarehouse = warehouses[0] ?? "";
  const extraCount = Math.max(0, warehouses.length - 1);
  const warehouseLabel =
    primaryWarehouse && extraCount > 0
      ? `${primaryWarehouse} + \u0435\u0449\u0451 ${extraCount}`
      : primaryWarehouse;

  return formatWbSupplyDirectionName({
    warehouseName: warehouseLabel || "\u0421\u043a\u043b\u0430\u0434\u044b \u0440\u0435\u0433\u0438\u043e\u043d\u0430",
    regionName: normalizeKey(regionName),
    fallback: "WB / \u0440\u0435\u0433\u0438\u043e\u043d",
  });
}

function formatWbGeoDirectionName(group: {
  warehouseName: string;
  oblastNames: Set<string>;
  regionNames: Set<string>;
}) {
  const regionName = Array.from(group.oblastNames.size > 0 ? group.oblastNames : group.regionNames)
    .filter(Boolean)
    .join(", ");

  return formatWbSupplyDirectionName({
    warehouseName: group.warehouseName,
    regionName,
    fallback: `WB / ${group.warehouseName}`,
  });
}

function formatOzonSupplyDirectionName(clusterName: unknown) {
  const cluster = normalizeKey(clusterName);

  return cluster
    ? `Ozon / \u041a\u043b\u0430\u0441\u0442\u0435\u0440: ${cluster}`
    : "Ozon / \u041a\u043b\u0430\u0441\u0442\u0435\u0440";
}

function formatDecimal(value: number) {
  return value.toLocaleString("ru-RU", {
    maximumFractionDigits: 2,
  });
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

function supplyPriorityWeight(priority: Priority) {
  if (priority === "HIGH") return 3;
  if (priority === "MEDIUM") return 2;
  return 1;
}

function getSupplyReservationMode(value?: string): SupplyReservationMode {
  if (
    value === "OZON_FIRST" ||
    value === "WB_FIRST" ||
    value === "OZON_ONLY" ||
    value === "WB_ONLY" ||
    value === "OZON_CANCELLED_TO_WB" ||
    value === "WB_CANCELLED_TO_OZON"
  ) {
    return value;
  }

  return "OZON_FIRST";
}

function shouldReserveMarketplace(
  marketplace: Marketplace,
  mode: SupplyReservationMode
) {
  if (mode === "OZON_ONLY" || mode === "WB_CANCELLED_TO_OZON") {
    return marketplace === "OZON";
  }

  if (mode === "WB_ONLY" || mode === "OZON_CANCELLED_TO_WB") {
    return marketplace === "WB";
  }

  return true;
}

function supplyMarketplaceAllocationWeight(
  marketplace: Marketplace,
  mode: SupplyReservationMode
) {
  if (
    mode === "WB_FIRST" ||
    mode === "WB_ONLY" ||
    mode === "OZON_CANCELLED_TO_WB"
  ) {
    return marketplace === "WB" ? 2 : 1;
  }

  return marketplace === "OZON" ? 2 : 1;
}

function getSupplyPriority(params: {
  wantedQty: number;
  ownAvailableQty: number;
  currentQty: number;
  abc: StockAbcInfo | null;
  daysWithoutStock?: number | null;
}): Priority {
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

function priorityLabel(priority: Priority) {
  if (priority === "HIGH") return "Высокий";
  if (priority === "MEDIUM") return "Средний";
  return "Низкий";
}


function getUniqueSupplyTargets(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(values.map((value) => normalizeKey(value)).filter(Boolean))
  );
}

function getWbOfficialDirectionNames(warehousesText: unknown, regionName: unknown) {
  const warehouses = splitWbWarehouseNames(warehousesText);
  const region = normalizeKey(regionName);

  if (warehouses.length === 0) {
    return [
      formatWbSupplyDirectionName({
        warehouseName: "\u0421\u043a\u043b\u0430\u0434\u044b \u0440\u0435\u0433\u0438\u043e\u043d\u0430",
        regionName: region,
        fallback: "WB / \u0440\u0435\u0433\u0438\u043e\u043d",
      }),
    ];
  }

  return getUniqueSupplyTargets(
    warehouses.map((warehouseName) =>
      formatWbSupplyDirectionName({
        warehouseName,
        regionName: region,
        fallback: `WB / ${warehouseName}`,
      })
    )
  );
}

function getSupplyTargetValues(row: { targetName: string; targetAliases?: string[] | null }) {
  return getUniqueSupplyTargets([row.targetName, ...(row.targetAliases ?? [])]);
}

function supplyRowMatchesTargetFilter(
  row: { targetName: string; targetAliases?: string[] | null },
  targetFilters: Set<string>
) {
  return getSupplyTargetValues(row).some((target) => targetFilters.has(target));
}

function supplyPlanMatchesSearch(row: SupplyPlanRow, query: string) {
  const normalizedQuery = normalizeSearchValue(query);

  if (!normalizedQuery) return true;

  const fields = [
    row.companyName,
    row.marketplace,
    row.targetName,
    row.vendorCode,
    row.sku,
    row.barcode,
    row.size,
    row.productName,
    row.reason,
    row.abc?.abcByProfit,
    priorityLabel(row.priority),
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

function getQueryValue(url: URL, name: string) {
  return normalizeKey(url.searchParams.get(name));
}

function getMarketplaceFilter(value: string): "ALL" | Marketplace {
  if (value === "WB" || value === "OZON") return value;
  return "ALL";
}

function getPriorityFilter(value: string): "ALL" | Priority {
  if (value === "HIGH" || value === "MEDIUM" || value === "LOW") return value;
  return "ALL";
}

function getAbcFilter(value: string): "ALL" | AbcCategory {
  if (value === "A" || value === "B" || value === "C") return value;
  return "ALL";
}

function getRowsLimit(value: string, totalRows: number) {
  if (value === "ALL") return totalRows;

  const parsed = Number(value || 0);

  return [20, 50, 100, 200].includes(parsed) ? parsed : totalRows;
}

function getSelectedKeys(url: URL, name: string) {
  return new Set(
    url.searchParams
      .getAll(name)
      .flatMap((item) => String(item).split(","))
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function getExportMarketplace(value: string): "ALL" | Marketplace {
  if (value === "WB" || value === "OZON") return value;
  return "ALL";
}


function getExportMode(value: string): "management" | "uploadZip" {
  return value === "uploadZip" ? "uploadZip" : "management";
}

function applyHeaderStyle(row: ExcelJS.Row) {
  row.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "111827" },
    };
    cell.font = {
      bold: true,
      color: { argb: "FFFFFF" },
    };
    cell.alignment = {
      vertical: "middle",
      horizontal: "center",
      wrapText: true,
    };
    cell.border = {
      top: { style: "thin", color: { argb: "CBD5E1" } },
      left: { style: "thin", color: { argb: "CBD5E1" } },
      bottom: { style: "thin", color: { argb: "CBD5E1" } },
      right: { style: "thin", color: { argb: "CBD5E1" } },
    };
  });
}

function applyBodyStyle(row: ExcelJS.Row) {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.alignment = {
      vertical: "middle",
      wrapText: true,
    };
    cell.border = {
      top: { style: "thin", color: { argb: "E2E8F0" } },
      left: { style: "thin", color: { argb: "E2E8F0" } },
      bottom: { style: "thin", color: { argb: "E2E8F0" } },
      right: { style: "thin", color: { argb: "E2E8F0" } },
    };
  });
}

async function buildSupplyPlanRows(url: URL) {
  const defaultPeriod = getDefaultPeriod();
  const dateFrom = getQueryValue(url, "dateFrom") || defaultPeriod.dateFrom;
  const dateTo = getQueryValue(url, "dateTo") || defaultPeriod.dateTo;
  const selectedCompanyName = getQueryValue(url, "companyName");
  const companyName =
    selectedCompanyName && selectedCompanyName !== "ALL" ? selectedCompanyName : null;

  const companyWhere = companyName ? companyName : undefined;

  const [wbProfitAnalytics, ozonProfitAnalytics] = await Promise.all([
    getProfitAnalytics({
      dateFrom,
      dateTo,
      companyName: companyName ?? "ALL",
    }),
    getProfitAnalyticsOzon({
      dateFrom,
      dateTo,
      usnRate: "1",
      vatRate: "5",
      companyName: companyName ?? "ALL",
    }),
  ]);

  const wbAbcByRevenue = calculateAbcByPositiveValue(
    wbProfitAnalytics.rows,
    (row) => toNumber(row.revenue)
  );
  const wbAbcMap = new Map<string, StockAbcInfo>();

  for (const row of wbProfitAnalytics.rows) {
    const abc = {
      abcByRevenue: wbAbcByRevenue.get(row) ?? "C",
      abcByProfit: toAbcCategory(row.abcByProfit),
    } satisfies StockAbcInfo;

    const rowCompany = rowCompanyName(row, companyName);

    registerStockAbc(wbAbcMap, {
      companyName: rowCompany,
      article: row.nmId,
      abc,
    });

    registerStockAbc(wbAbcMap, {
      companyName: rowCompany,
      article: row.vendorCode,
      abc,
    });
  }

  const ozonGroupsForAbc = new Map<
    string,
    {
      companyName: string | null;
      baseArticle: string;
      revenue: number;
      netProfitAfterTax: number;
      rows: typeof ozonProfitAnalytics.rows;
    }
  >();

  for (const row of ozonProfitAnalytics.rows) {
    const rowCompany = rowCompanyName(row, companyName);
    const baseArticle = getMarketplaceBaseArticle(row.vendorCode) || row.vendorCode;
    const key = `${rowCompany ?? ""}::${baseArticle}`;
    const current =
      ozonGroupsForAbc.get(key) ??
      ({
        companyName: rowCompany,
        baseArticle,
        revenue: 0,
        netProfitAfterTax: 0,
        rows: [],
      } satisfies {
        companyName: string | null;
        baseArticle: string;
        revenue: number;
        netProfitAfterTax: number;
        rows: typeof ozonProfitAnalytics.rows;
      });

    current.revenue += toNumber(row.revenue);
    current.netProfitAfterTax += toNumber(row.netProfitAfterTax);
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
  const ozonAbcMap = new Map<string, StockAbcInfo>();

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

  const wbDailySaleDateFrom = new Date(`${dateFrom}T00:00:00.000Z`);
  const wbDailySaleDateTo = new Date(`${dateTo}T23:59:59.999Z`);

  const [
    rawWbStocks,
    ozonStocks,
    ozonSupplyRecommendations,
    wbSupplyRecommendations,
    wbDailySalesRows,
    warehouseStocks,
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
        select: {
          id: true,
          companyName: true,
          vendorCode: true,
          nmId: true,
          barcode: true,
          size: true,
          warehouseName: true,
          warehouseQty: true,
          totalStock: true,
        },
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
        select: {
          companyName: true,
          vendorCode: true,
          sku: true,
          availableQty: true,
          preparingQty: true,
          supplyQty: true,
          inTransitQty: true,
        },
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
        select: {
          id: true,
          companyName: true,
          sku: true,
          vendorCode: true,
          productName: true,
          recommendationPeriodDays: true,
          recommendedSupplyQty: true,
          recommendation: true,
          clusterName: true,
          daysWithoutStock28: true,
          avgDailySalesQty28: true,
          fboStockQty: true,
          fbsStockQty: true,
          inTransitToOzonQty: true,
        },
      }),
      prisma.wbSupplyRecommendation.findMany({
        where: {
          companyName: companyWhere,
        },
        orderBy: [
          { companyName: "asc" },
          { regionName: "asc" },
          { vendorCode: "asc" },
          { size: "asc" },
        ],
        select: {
          id: true,
          companyName: true,
          recommendationDate: true,
          regionName: true,
          warehousesText: true,
          vendorCode: true,
          size: true,
          productName: true,
          nmId: true,
          barcode: true,
          regionStockQty: true,
          avgOrdersPerDay: true,
          forecastOrdersPerDay: true,
          stockDays: true,
          stockLevel: true,
          recommendation: true,
          potentialLostRevenue28: true,
          plannedSupplyQty: true,
          recommendedQty14: true,
          recommendedQty21: true,
          recommendedQty28: true,
          recommendedQty56: true,
          isAllRegions: true,
        },
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
      prisma.ozonWarehouseStock.findMany({
        where: {
          companyName: companyWhere,
        },
        orderBy: [{ companyName: "asc" }, { vendorCode: "asc" }, { size: "asc" }],
        select: {
          id: true,
          companyName: true,
          vendorCode: true,
          sku: true,
          productName: true,
          size: true,
          barcode: true,
          availableForSupplyQty: true,
        },
      }),
    ]);

  const supplierArticleByCompanyAndWbArticle = new Map<string, string>();
  const supplierArticleByWbArticle = new Map<string, string>();

  function getCompanyArticleKey(companyName: unknown, article: unknown) {
    const company = normalizeKey(companyName);
    const normalizedArticle = normalizeKey(article);

    return company && normalizedArticle ? `${company}::${normalizedArticle}` : "";
  }

  function registerWbSupplierArticleMapping(params: {
    companyName?: string | null;
    wbArticle?: string | null;
    supplierArticle?: string | null;
  }) {
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
  }

  function findSupplierArticleByWbArticle(params: {
    companyName?: string | null;
    wbArticle?: string | null;
  }) {
    const wbArticle = normalizeKey(params.wbArticle);

    if (!wbArticle) return null;

    const companyKey = getCompanyArticleKey(params.companyName, wbArticle);

    return (
      (companyKey ? supplierArticleByCompanyAndWbArticle.get(companyKey) : undefined) ??
      supplierArticleByWbArticle.get(wbArticle) ??
      null
    );
  }

  for (const stock of rawWbStocks) {
    registerWbSupplierArticleMapping({
      companyName: stock.companyName,
      wbArticle: stock.nmId,
      supplierArticle: stock.vendorCode,
    });
  }

  const ownSupplyItems: OwnSupplyItem[] = warehouseStocks
    .map((stock) => {
      const vendorCode = normalizeKey(stock.vendorCode);
      const sku = normalizeKey(stock.sku);
      const size = normalizeKey(stock.size) || inferSizeFromVendorCode(vendorCode);
      const articleKeys = new Set<string>();

      for (const article of [
        vendorCode,
        sku,
        stock.barcode,
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
        ownArticle: vendorCode || sku || normalizeKey(stock.barcode) || null,
        sizeKey: normalizeSupplySize(size),
        availableQty: toNumber(stock.availableForSupplyQty),
        productName: stock.productName ?? null,
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

    const exactSize = sizeKey
      ? sameCompanyItems.find((item) => item.sizeKey && item.sizeKey === sizeKey)
      : null;

    if (sizeKey) {
      return exactSize ?? sameCompanyItems.find((item) => !item.sizeKey) ?? null;
    }

    return sameCompanyItems[0] ?? null;
  }

  const supplyPlanCandidates: SupplyPlanCandidate[] = [];
  const ozonRecommendationDays = getOzonRecommendationDays(getQueryValue(url, "supplyOzonDays"));
  const officialOzonSupplyKeys = new Set<string>();

  for (const row of ozonSupplyRecommendations) {
    const vendorCode = normalizeKey(row.vendorCode);
    const sku = normalizeKey(row.sku);
    const size = inferSizeFromVendorCode(vendorCode);
    const wantedQty = Math.max(0, getOzonRecommendationQty(row, ozonRecommendationDays));

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
      barcode: null,
      size,
      productName: row.productName ?? ownItem?.productName ?? null,
      targetName: formatOzonSupplyDirectionName(row.clusterName),
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
        `Ozon рекомендует поставить ${formatNumber(wantedQty)} шт. в кластер на ${formatNumber(ozonRecommendationDays)} дн.`,
      details: [
        `Период выгрузки: ${formatNumber(ozonRecommendationDays)} дн.`,
        row.recommendationPeriodDays
          ? `Исходная рекомендация Ozon: ${formatNumber(row.recommendationPeriodDays)} дн.`
          : "Исходная рекомендация Ozon: 14 дн. по умолчанию",
        row.avgDailySalesQty28 !== null && row.avgDailySalesQty28 !== undefined
          ? `Продажи: ${formatNumber(toNumber(row.avgDailySalesQty28))} шт/день`
          : "",
        row.daysWithoutStock28 !== null && row.daysWithoutStock28 !== undefined
          ? `Без остатка: ${formatNumber(toNumber(row.daysWithoutStock28))} дн.`
          : "",
      ].filter(Boolean),
    });
  }

  const wbRecommendationDays = getWbRecommendationDays(getQueryValue(url, "supplyWbDays"));
  const officialWbSupplyKeys = new Set<string>();

  for (const row of wbSupplyRecommendations) {
    const company = normalizeKey(row.companyName) || "Без компании";
    const vendorCode = normalizeKey(row.vendorCode);
    const nmId = normalizeKey(row.nmId);
    const barcode = normalizeKey(row.barcode);
    const size = normalizeKey(row.size) || inferSizeFromVendorCode(vendorCode);

    for (const article of [vendorCode, nmId, barcode]) {
      const coverageKey = getWbOfficialCoverageKey({
        companyName: company,
        article,
        size,
      });

      if (coverageKey) officialWbSupplyKeys.add(coverageKey);
    }

    if (row.isAllRegions || isAllRegionsName(row.regionName)) {
      continue;
    }

    const wantedQty = Math.max(0, getWbRecommendationQty(row, wbRecommendationDays));

    if (!vendorCode && !nmId && !barcode) continue;
    if (wantedQty <= 0) continue;

    const mappedSupplierArticle = findSupplierArticleByWbArticle({
      companyName: company,
      wbArticle: nmId,
    });
    const ownItem = findOwnSupplyItem({
      companyName: company,
      articles: [vendorCode, nmId, barcode, mappedSupplierArticle],
      size,
    });
    const abc = findStockAbc(wbAbcMap, {
      companyName: company,
      articles: [nmId, vendorCode, mappedSupplierArticle],
    });
    const currentQty = toNumber(row.regionStockQty) + toNumber(row.plannedSupplyQty);
    const ownInitialQty = ownItem?.availableQty ?? 0;
    const stockLevel = normalizeKey(row.stockLevel);
    const recommendation = normalizeKey(row.recommendation);
    const isCritical =
      normalizeSearchValue(stockLevel).includes("критич") ||
      normalizeSearchValue(stockLevel).includes("мало") ||
      normalizeSearchValue(recommendation).includes("срочно");
    const priority = isCritical
      ? "HIGH"
      : getSupplyPriority({
          wantedQty,
          ownAvailableQty: ownInitialQty,
          currentQty,
          abc,
          daysWithoutStock: currentQty <= 0 ? 1 : null,
        });

    supplyPlanCandidates.push({
      key: `wb-official-${row.id}`,
      marketplace: "WB",
      priority,
      companyName: company,
      vendorCode: vendorCode || nmId || barcode,
      sku: nmId || null,
      barcode: barcode || null,
      ownArticle: ownItem?.ownArticle ?? null,
      size,
      productName: row.productName ?? ownItem?.productName ?? null,
      targetName:
        getWbOfficialDirectionNames(row.warehousesText, row.regionName)[0] ??
        formatWbOfficialDirectionName(row.warehousesText, row.regionName),
      targetAliases: getWbOfficialDirectionNames(row.warehousesText, row.regionName),
      currentQty,
      ownItemKey: ownItem?.key ?? null,
      wantedQty,
      ownInitialQty,
      avgDailySalesQty:
        row.forecastOrdersPerDay === null || row.forecastOrdersPerDay === undefined
          ? row.avgOrdersPerDay === null || row.avgOrdersPerDay === undefined
            ? null
            : toNumber(row.avgOrdersPerDay)
          : toNumber(row.forecastOrdersPerDay),
      daysWithoutStock:
        row.stockDays === null || row.stockDays === undefined
          ? null
          : toNumber(row.stockDays),
      abc,
      reason:
        recommendation ||
        `WB рекомендует отгрузить ${formatNumber(wantedQty)} шт. на ${formatNumber(
          wbRecommendationDays
        )} дн.`,
      details: [
        "Источник: официальный файл WB “Рекомендации по поставке” из личного кабинета.",
        `Период рекомендации: ${formatNumber(wbRecommendationDays)} дн.`,
        row.warehousesText ? `Склады в регионе: ${row.warehousesText}` : "",
        stockLevel ? `Уровень остатка: ${stockLevel}` : "",
        row.stockDays !== null && row.stockDays !== undefined
          ? `Остатков хватит на ${formatDecimal(toNumber(row.stockDays))} дн.`
          : "",
        row.forecastOrdersPerDay !== null && row.forecastOrdersPerDay !== undefined
          ? `Прогноз заказов: ${formatDecimal(toNumber(row.forecastOrdersPerDay))} шт/день`
          : "",
        row.potentialLostRevenue28 !== null && row.potentialLostRevenue28 !== undefined
          ? `Потенциальная потеря выручки за 28 дн.: ${formatDecimal(
              toNumber(row.potentialLostRevenue28)
            )} ₽`
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
    const rowCompany =
      rowCompanyName(row, companyName) ??
      inferredCompanyName ??
      "Без компании";
    const netSalesQty = Math.max(0, toNumber(row.netSalesQty));

    if (!vendorCode || netSalesQty <= 0) continue;

    const groupKey = `${normalizeSearchValue(rowCompany)}::${normalizeSupplyArticle(
      vendorCode
    )}`;
    const currentGroup =
      ozonCalculatedGroups.get(groupKey) ??
      ({
        companyName: rowCompany,
        vendorCode,
        netSalesQty: 0,
        revenue: 0,
      } satisfies {
        companyName: string;
        vendorCode: string;
        netSalesQty: number;
        revenue: number;
      });

    currentGroup.netSalesQty += netSalesQty;
    currentGroup.revenue += toNumber(row.revenue);

    ozonCalculatedGroups.set(groupKey, currentGroup);
  }

  const ozonSalesPeriodDays = getInclusiveDateRangeDays(dateFrom, dateTo);

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
    });
    const ownItem = findOwnSupplyItem({
      companyName: group.companyName,
      articles: [group.vendorCode, baseArticle, mappedSupplierArticle],
      size,
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
      barcode: null,
      size,
      productName: ownItem?.productName ?? null,
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
      barcode: string;
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
        barcode: normalizeKey(sale.barcode),
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
        barcode: string;
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
    if (!currentGroup.barcode && sale.barcode) currentGroup.barcode = normalizeKey(sale.barcode);
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
    const hasOfficialWbRecommendation = [group.vendorCode, group.nmId, group.barcode].some((article) => {
      const coverageKey = getWbOfficialCoverageKey({
        companyName: group.companyName,
        article,
        size: group.size,
      });

      return coverageKey ? officialWbSupplyKeys.has(coverageKey) : false;
    });

    if (hasOfficialWbRecommendation) continue;

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
    });
    const ownItem = findOwnSupplyItem({
      companyName: group.companyName,
      articles: [
        group.vendorCode,
        group.nmId,
        group.barcode,
        mappedSupplierArticle,
        getMarketplaceBaseArticle(mappedSupplierArticle ?? group.vendorCode),
        getSupplierArticleRoot(mappedSupplierArticle ?? group.vendorCode),
      ],
      size: group.size,
    });
    const ownInitialQty = ownItem?.availableQty ?? 0;

    if (ownInitialQty <= 0) continue;

    const wantedQty = Math.min(rawWantedQty, ownInitialQty);
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
      vendorCode: group.vendorCode || group.nmId || group.barcode,
      sku: group.nmId || null,
      barcode: group.barcode || null,
      ownArticle: ownItem?.ownArticle ?? null,
      size: group.size,
      productName: ownItem?.productName ?? null,
      targetName: formatWbGeoDirectionName(group),
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
  const supplyReservationMode = getSupplyReservationMode(
    getQueryValue(url, "supplyReservationMode")
  );

  const rows: SupplyPlanRow[] = supplyPlanCandidates
    .sort((a, b) => {
      // Важно: распределяем один и тот же собственный склад единым планом.
      // По умолчанию резервируем сначала Ozon, потом WB. Режимы отмены
      // исключают отменённый маркетплейс из резерва и отдают остаток второму.
      const marketplaceDiff =
        supplyMarketplaceAllocationWeight(b.marketplace, supplyReservationMode) -
        supplyMarketplaceAllocationWeight(a.marketplace, supplyReservationMode);

      if (marketplaceDiff !== 0) return marketplaceDiff;

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
      const shouldReserve = shouldReserveMarketplace(
        candidate.marketplace,
        supplyReservationMode
      );
      const recommendedQty = shouldReserve
        ? Math.min(candidate.wantedQty, ownAvailableQty)
        : 0;

      if (candidate.ownItemKey && shouldReserve) {
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

  const exportMarketplaceForFilter = getExportMarketplace(
    getQueryValue(url, "exportMarketplace")
  );
  const marketplaceFilter =
    exportMarketplaceForFilter === "ALL"
      ? getMarketplaceFilter(getQueryValue(url, "supplyMarketplace"))
      : exportMarketplaceForFilter;
  const priorityFilter = getPriorityFilter(getQueryValue(url, "supplyPriority"));
  const abcFilter = getAbcFilter(getQueryValue(url, "supplyAbc"));
  const targetFilters = new Set(
    Array.from(getSelectedKeys(url, "supplyTarget")).filter(
      (target) => target && target !== "ALL"
    )
  );
  const query = getQueryValue(url, "supplyQ");

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

    if (targetFilters.size > 0 && !supplyRowMatchesTargetFilter(row, targetFilters)) {
      return false;
    }

    return supplyPlanMatchesSearch(row, query);
  });

  const exportMarketplace = getExportMarketplace(getQueryValue(url, "exportMarketplace"));
  const marketplaceRows =
    exportMarketplace === "ALL"
      ? filteredRows
      : filteredRows.filter((row) => row.marketplace === exportMarketplace);

  const selectedKeys = getSelectedKeys(url, "supplySelected");
  const hasCustomSelection = getQueryValue(url, "supplySelectionMode") === "custom";
  const selectedRows = hasCustomSelection
    ? marketplaceRows.filter((row) => selectedKeys.has(row.key))
    : marketplaceRows;

  const shouldApplyRowsLimit = getExportMode(getQueryValue(url, "exportMode")) !== "uploadZip";

  if (!shouldApplyRowsLimit) {
    return selectedRows;
  }

  const rowsLimit = getRowsLimit(getQueryValue(url, "supplyRows"), selectedRows.length);

  return selectedRows.slice(0, rowsLimit);
}


function addGeneralSupplySheet(workbook: ExcelJS.Workbook, rows: SupplyPlanRow[]) {
  const sheet = workbook.addWorksheet("План поставок", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = [
    { header: "Компания", key: "companyName", width: 18 },
    { header: "Маркетплейс", key: "marketplace", width: 14 },
    { header: "Куда / склад / кластер", key: "targetName", width: 28 },
    { header: "Артикул", key: "vendorCode", width: 24 },
    { header: "SKU / nmId", key: "sku", width: 18 },
    { header: "Баркод", key: "barcode", width: 22 },
    { header: "Размер", key: "size", width: 12 },
    { header: "Название", key: "productName", width: 34 },
    { header: "ABC", key: "abc", width: 10 },
    { header: "Приоритет", key: "priority", width: 14 },
    { header: "Остаток там", key: "currentQty", width: 14 },
    { header: "Рекомендовано системой", key: "wantedQty", width: 22 },
    { header: "Доступно на своём складе", key: "ownAvailableQty", width: 24 },
    { header: "К отгрузке", key: "recommendedQty", width: 14 },
    { header: "Средние продажи, шт/день", key: "avgDailySalesQty", width: 22 },
    { header: "Дней без остатка", key: "daysWithoutStock", width: 18 },
    { header: "Причина", key: "reason", width: 48 },
    { header: "Детали", key: "details", width: 42 },
  ];

  applyHeaderStyle(sheet.getRow(1));
  sheet.getRow(1).height = 34;

  for (const row of rows) {
    sheet.addRow({
      companyName: row.companyName,
      marketplace: row.marketplace === "OZON" ? "Ozon" : "WB",
      targetName: row.targetName,
      vendorCode: row.vendorCode,
      sku: row.sku ?? "",
      barcode: row.barcode ?? "",
      size: row.size ?? "",
      productName: row.productName ?? "",
      abc: row.abc?.abcByProfit ?? "C",
      priority: priorityLabel(row.priority),
      currentQty: row.currentQty,
      wantedQty: row.wantedQty,
      ownAvailableQty: row.ownAvailableQty,
      recommendedQty: row.recommendedQty,
      avgDailySalesQty: row.avgDailySalesQty ?? "",
      daysWithoutStock: row.daysWithoutStock ?? "",
      reason: row.reason,
      details: row.details.join("; "),
    });
  }

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    applyBodyStyle(row);

    row.getCell(11).numFmt = "0";
    row.getCell(12).numFmt = "0";
    row.getCell(13).numFmt = "0";
    row.getCell(14).numFmt = "0";
    row.getCell(15).numFmt = "0.00";
    row.getCell(16).numFmt = "0";
  }

  sheet.autoFilter = {
    from: "A1",
    to: "R1",
  };

  if (rows.length === 0) {
    const row = sheet.addRow({
      companyName: "Нет строк по выбранным фильтрам",
    });

    sheet.mergeCells(`A${row.number}:R${row.number}`);
    row.getCell(1).alignment = { vertical: "middle", horizontal: "center" };
    row.getCell(1).font = { bold: true, color: { argb: "64748B" } };
  }
}

function addMarketplaceUploadSheet(workbook: ExcelJS.Workbook, rows: SupplyPlanRow[]) {
  const sheet = workbook.addWorksheet("Для загрузки", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = [
    { header: "Компания", key: "companyName", width: 18 },
    { header: "Маркетплейс", key: "marketplace", width: 14 },
    { header: "Склад / кластер / направление", key: "targetName", width: 34 },
    { header: "Артикул продавца", key: "vendorCode", width: 24 },
    { header: "SKU / nmId", key: "sku", width: 18 },
    { header: "Баркод", key: "barcode", width: 22 },
    { header: "Размер", key: "size", width: 12 },
    { header: "Количество к поставке", key: "recommendedQty", width: 22 },
    { header: "Название товара", key: "productName", width: 34 },
    { header: "Комментарий", key: "comment", width: 58 },
  ];

  applyHeaderStyle(sheet.getRow(1));
  sheet.getRow(1).height = 34;

  for (const row of rows) {
    sheet.addRow({
      companyName: row.companyName,
      marketplace: row.marketplace === "OZON" ? "Ozon" : "WB",
      targetName: row.targetName,
      vendorCode: row.vendorCode,
      sku: row.sku ?? "",
      barcode: row.barcode ?? "",
      size: row.size ?? "",
      recommendedQty: row.recommendedQty,
      productName: row.productName ?? "",
      comment: `${priorityLabel(row.priority)} приоритет. ${row.reason}`,
    });
  }

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    applyBodyStyle(row);
    row.getCell(8).numFmt = "0";
  }

  sheet.autoFilter = {
    from: "A1",
    to: "J1",
  };

  if (rows.length === 0) {
    const row = sheet.addRow({
      companyName: "Нет строк по выбранным фильтрам",
    });

    sheet.mergeCells(`A${row.number}:J${row.number}`);
    row.getCell(1).alignment = { vertical: "middle", horizontal: "center" };
    row.getCell(1).font = { bold: true, color: { argb: "64748B" } };
  }
}


function safeFileNamePart(value: unknown) {
  const text = normalizeKey(value) || "без-названия";

  return text
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "без-названия";
}

function cleanTargetName(row: SupplyPlanRow) {
  const target = normalizeKey(row.targetName)
    .replace(/^WB\s*\/\s*/i, "")
    .replace(/^Ozon\s*\/\s*/i, "")
    .replace(/^OZON\s*\/\s*/i, "")
    .replace(/^\u041a\u043b\u0430\u0441\u0442\u0435\u0440:\s*/i, "")
    .trim();

  return target || "\u041e\u0431\u0449\u0435\u0435 \u043d\u0430\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u0438\u0435";
}

function groupRowsForUpload(rows: SupplyPlanRow[], marketplace: Marketplace) {
  const groups = new Map<string, { companyName: string; targetName: string; rows: SupplyPlanRow[] }>();

  for (const row of rows) {
    if (row.marketplace !== marketplace) continue;
    if (row.recommendedQty <= 0) continue;

    const companyName = normalizeKey(row.companyName) || "Без компании";
    const targetName = cleanTargetName(row);
    const key = `${companyName}::${targetName}`;
    const current = groups.get(key) ?? { companyName, targetName, rows: [] };

    current.rows.push(row);
    groups.set(key, current);
  }

  return Array.from(groups.values()).sort((a, b) => {
    const companyCompare = a.companyName.localeCompare(b.companyName, "ru");
    return companyCompare !== 0
      ? companyCompare
      : a.targetName.localeCompare(b.targetName, "ru");
  });
}


async function createWbSummaryWorkbook(rows: SupplyPlanRow[]) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Marketplace Business OS";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Sheet1", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = [
    { header: "\u0410\u0440\u0442\u0438\u043a\u0443\u043b \u0441\u043a\u043b\u0430\u0434\u0430", key: "ownArticle", width: 24 },
    { header: "\u0411\u0430\u0440\u043a\u043e\u0434", key: "barcode", width: 22 },
    { header: "\u041a\u043e\u043b\u0438\u0447\u0435\u0441\u0442\u0432\u043e", key: "qty", width: 14 },
  ];

  sheet.getRow(1).font = { bold: true };

  const groupedByBarcodeAndArticle = new Map<
    string,
    { ownArticle: string; barcode: string; qty: number }
  >();

  for (const row of rows) {
    const barcode = normalizeKey(row.barcode);
    if (!barcode) continue;

    const ownArticle = normalizeKey(row.ownArticle) || normalizeKey(row.vendorCode);
    const groupKey = `${barcode}::${ownArticle}`;
    const current = groupedByBarcodeAndArticle.get(groupKey) ?? {
      ownArticle,
      barcode,
      qty: 0,
    };

    current.qty += Math.max(0, Math.trunc(row.recommendedQty));
    groupedByBarcodeAndArticle.set(groupKey, current);
  }

  for (const item of groupedByBarcodeAndArticle.values()) {
    if (item.qty <= 0) continue;
    sheet.addRow(item);
  }

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    sheet.getRow(rowNumber).getCell(3).numFmt = "0";
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function createWbUploadWorkbook(rows: SupplyPlanRow[]) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Marketplace Business OS";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Sheet1", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = [
    { header: "Баркод", key: "barcode", width: 22 },
    { header: "Количество", key: "qty", width: 14 },
  ];

  sheet.getRow(1).font = { bold: true };

  const groupedByBarcode = new Map<string, number>();

  for (const row of rows) {
    const barcode = normalizeKey(row.barcode);
    if (!barcode) continue;

    groupedByBarcode.set(
      barcode,
      (groupedByBarcode.get(barcode) ?? 0) + Math.max(0, Math.trunc(row.recommendedQty))
    );
  }

  for (const [barcode, qty] of groupedByBarcode.entries()) {
    if (qty <= 0) continue;
    sheet.addRow({ barcode, qty });
  }

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    sheet.getRow(rowNumber).getCell(2).numFmt = "0";
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function createOzonUploadWorkbook(rows: SupplyPlanRow[]) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Marketplace Business OS";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Sheet1", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = [
    { header: "артикул", key: "vendorCode", width: 24 },
    { header: "имя (необязательно)", key: "productName", width: 38 },
    { header: "количество", key: "qty", width: 14 },
  ];

  sheet.getRow(1).font = { bold: true };

  const groupedByArticle = new Map<string, { productName: string; qty: number }>();

  for (const row of rows) {
    const vendorCode = normalizeKey(row.vendorCode);
    if (!vendorCode) continue;

    const current = groupedByArticle.get(vendorCode) ?? {
      productName: normalizeKey(row.productName) || "",
      qty: 0,
    };

    if (!current.productName && row.productName) current.productName = row.productName;
    current.qty += Math.max(0, Math.trunc(row.recommendedQty));
    groupedByArticle.set(vendorCode, current);
  }

  for (const [vendorCode, item] of groupedByArticle.entries()) {
    if (item.qty <= 0) continue;
    sheet.addRow({ vendorCode, productName: item.productName, qty: item.qty });
  }

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    sheet.getRow(rowNumber).getCell(3).numFmt = "0";
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const crcTable = (() => {
  const table: number[] = [];

  for (let n = 0; n < 256; n++) {
    let c = n;

    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }

    table[n] = c >>> 0;
  }

  return table;
})();

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function getDosDateTime(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

  return { dosTime, dosDate };
}

function createZipArchive(files: Array<{ name: string; buffer: Buffer }>) {
  const now = new Date();
  const { dosTime, dosDate } = getDosDateTime(now);
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, "utf8");
    const checksum = crc32(file.buffer);
    const localHeader = Buffer.alloc(30);

    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(file.buffer.length, 18);
    localHeader.writeUInt32LE(file.buffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, file.buffer);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(file.buffer.length, 20);
    centralHeader.writeUInt32LE(file.buffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + file.buffer.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function createMarketplaceUploadZip(rows: SupplyPlanRow[], marketplace: Marketplace) {
  const groups = groupRowsForUpload(rows, marketplace);
  const files: Array<{ name: string; buffer: Buffer }> = [];
  const summaryRows = rows.filter((row) => {
    if (row.marketplace !== marketplace || row.recommendedQty <= 0) return false;
    if (marketplace === "WB") return Boolean(normalizeKey(row.barcode));
    return Boolean(normalizeKey(row.vendorCode));
  });

  if (summaryRows.length > 0) {
    const summaryBuffer =
      marketplace === "WB"
        ? await createWbSummaryWorkbook(summaryRows)
        : await createOzonUploadWorkbook(summaryRows);

    files.push({
      name: `${marketplace}/00-${marketplace.toLowerCase()}-summary.xlsx`,
      buffer: summaryBuffer,
    });
  }

  for (const group of groups) {
    const buffer =
      marketplace === "WB"
        ? await createWbUploadWorkbook(group.rows)
        : await createOzonUploadWorkbook(group.rows);
    const hasRows = group.rows.some((row) => {
      if (marketplace === "WB") return Boolean(normalizeKey(row.barcode)) && row.recommendedQty > 0;
      return Boolean(normalizeKey(row.vendorCode)) && row.recommendedQty > 0;
    });

    if (!hasRows) continue;

    files.push({
      name: `${marketplace}/${safeFileNamePart(group.companyName)}/${safeFileNamePart(
        group.targetName
      )}.xlsx`,
      buffer,
    });
  }

  if (files.length === 0) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Нет данных");
    sheet.getCell("A1").value =
      marketplace === "WB"
        ? "Нет строк WB с баркодом и количеством к отгрузке по выбранным фильтрам."
        : "Нет строк Ozon с артикулом и количеством к отгрузке по выбранным фильтрам.";
    sheet.getCell("A1").font = { bold: true };
    sheet.getColumn(1).width = 90;
    files.push({
      name: `${marketplace}/нет-данных.xlsx`,
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    });
  }

  return createZipArchive(files);
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const rows = await buildSupplyPlanRows(url);

    const now = new Date();
    const fileStamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
      2,
      "0"
    )}-${String(now.getDate()).padStart(2, "0")}`;
    const exportMarketplace = getExportMarketplace(getQueryValue(url, "exportMarketplace"));
    const exportMode = getExportMode(getQueryValue(url, "exportMode"));
    const marketplaceSuffix =
      exportMarketplace === "ALL" ? "all" : exportMarketplace.toLowerCase();

    if (exportMode === "uploadZip") {
      const zipMarketplace = exportMarketplace === "ALL" ? "WB" : exportMarketplace;
      const zipBuffer = await createMarketplaceUploadZip(rows, zipMarketplace);

      return new NextResponse(zipBuffer, {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="supply-upload-${zipMarketplace.toLowerCase()}-${fileStamp}.zip"`,
          "Cache-Control": "no-store",
        },
      });
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Marketplace Business OS";
    workbook.created = new Date();

    addGeneralSupplySheet(workbook, rows);
    addMarketplaceUploadSheet(workbook, rows);

    const buffer = await workbook.xlsx.writeBuffer();

    return new NextResponse(Buffer.from(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="supply-plan-${marketplaceSuffix}-${fileStamp}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("SUPPLY_PLAN_EXPORT_ERROR", error);

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Ошибка экспорта плана поставок",
      },
      { status: 500 }
    );
  }
}
