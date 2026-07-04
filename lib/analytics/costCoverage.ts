import { prisma } from "@/lib/prisma";

type CostRecord = {
  vendorCode: string;
  nmId: string | null;
  costPrice: unknown;
};

type WbProductCardRecord = {
  nmId: string;
  vendorCode: string | null;
};

type OzonProductRecord = {
  sku: string | null;
  vendorCode: string | null;
};

export type MissingCostItem = {
  marketplace: "WB" | "OZON";
  companyName: string;
  vendorCode: string;
  externalId: string;
  productName: string;
  quantity: number;
  amount: number;
  issueType?: "MISSING_COST" | "MISSING_OZON_MAPPING";
};

export type CostCoverageSummary = {
  companyName: string | null;
  dateFrom: string;
  dateTo: string;
  checkedItemsCount: number;
  missingItemsCount: number;
  missingWbItemsCount: number;
  missingOzonItemsCount: number;
  missingQuantity: number;
  missingAmount: number;
  examples: MissingCostItem[];
  hasMissingCosts: boolean;
  technicalWbItemsCount: number;
  technicalWbQuantity: number;
  technicalWbAmount: number;
  unmappedOzonItemsCount: number;
  missingRealCostItemsCount: number;
};

function normalizeText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[–—−]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function toNumber(value: unknown) {
  if (value === null || value === undefined) return 0;

  const number = Number(value);

  return Number.isFinite(number) ? number : 0;
}

function startOfDayUtc(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function endOfDayUtc(value: string) {
  return new Date(`${value}T23:59:59.999Z`);
}

function buildCostLookups(costs: CostRecord[]) {
  const costByVendorCode = new Map<string, number>();
  const costByNmId = new Map<string, number>();

  for (const cost of costs) {
    const vendorCode = normalizeText(cost.vendorCode);
    const nmId = normalizeText(cost.nmId);
    const costPrice = toNumber(cost.costPrice);

    if (costPrice <= 0) continue;

    if (vendorCode && !costByVendorCode.has(vendorCode)) {
      costByVendorCode.set(vendorCode, costPrice);
    }

    if (nmId && !costByNmId.has(nmId)) {
      costByNmId.set(nmId, costPrice);
    }
  }

  return {
    costByVendorCode,
    costByNmId,
  };
}

function buildWbSupplierArticleByNmId(cards: WbProductCardRecord[]) {
  const supplierArticleByNmId = new Map<string, string>();

  for (const card of cards) {
    const nmId = normalizeText(card.nmId);
    const vendorCode = normalizeText(card.vendorCode);

    if (!nmId || !vendorCode || supplierArticleByNmId.has(nmId)) continue;

    supplierArticleByNmId.set(nmId, vendorCode);
  }

  return supplierArticleByNmId;
}

function buildOzonProductLookup(products: OzonProductRecord[]) {
  const normalizedVendorCodeBySku = new Map<string, string>();
  const displayVendorCodeBySku = new Map<string, string>();

  for (const product of products) {
    const sku = normalizeText(product.sku);
    const normalizedVendorCode = normalizeText(product.vendorCode);
    const displayVendorCode = cleanText(product.vendorCode);

    if (!sku || !normalizedVendorCode || normalizedVendorCodeBySku.has(sku)) {
      continue;
    }

    normalizedVendorCodeBySku.set(sku, normalizedVendorCode);
    displayVendorCodeBySku.set(sku, displayVendorCode || normalizedVendorCode);
  }

  return {
    normalizedVendorCodeBySku,
    displayVendorCodeBySku,
  };
}

function getBaseArticle(value: unknown) {
  const text = cleanText(value);
  if (!text) return "";

  return cleanText(text.split("-")[0]);
}

function createCostResolvers(params: {
  costs: CostRecord[];
  wbProductCards: WbProductCardRecord[];
  ozonProducts: OzonProductRecord[];
}) {
  const { costByVendorCode, costByNmId } = buildCostLookups(params.costs);
  const wbSupplierArticleByNmId = buildWbSupplierArticleByNmId(
    params.wbProductCards
  );
  const ozonProductLookup = buildOzonProductLookup(params.ozonProducts);

  function hasCostByAnyKey(keys: string[]) {
    for (const key of keys) {
      const normalizedKey = normalizeText(key);
      if (!normalizedKey) continue;

      if (costByVendorCode.has(normalizedKey)) return true;
      if (costByNmId.has(normalizedKey)) return true;

      const baseArticle = normalizeText(getBaseArticle(normalizedKey));
      if (baseArticle && costByVendorCode.has(baseArticle)) return true;
      if (baseArticle && costByNmId.has(baseArticle)) return true;

      const wbSupplierArticle = wbSupplierArticleByNmId.get(normalizedKey);
      if (wbSupplierArticle && costByVendorCode.has(wbSupplierArticle)) return true;

      const wbSupplierArticleByBase = baseArticle
        ? wbSupplierArticleByNmId.get(baseArticle)
        : "";
      if (wbSupplierArticleByBase && costByVendorCode.has(wbSupplierArticleByBase)) {
        return true;
      }
    }

    return false;
  }

  function hasWbCost(row: { vendorCode: unknown; nmId: unknown }) {
    const vendorCode = normalizeText(row.vendorCode);
    const nmId = normalizeText(row.nmId);

    return hasCostByAnyKey([vendorCode, nmId]);
  }

  function resolveOzonCost(row: { sku: unknown; vendorCode: unknown }) {
    const sku = normalizeText(row.sku);
    const directVendorCode = normalizeText(row.vendorCode);
    const mappedVendorCode = sku
      ? ozonProductLookup.normalizedVendorCodeBySku.get(sku) ?? ""
      : "";
    const mappedDisplayVendorCode = sku
      ? ozonProductLookup.displayVendorCodeBySku.get(sku) ?? ""
      : "";

    const hasProductMapping = Boolean(directVendorCode || mappedVendorCode);
    const resolvedVendorCode = directVendorCode || mappedVendorCode || sku;
    const displayVendorCode =
      cleanText(row.vendorCode) || mappedDisplayVendorCode || cleanText(row.sku) || "—";

    const keys = [directVendorCode, mappedVendorCode, sku, getBaseArticle(resolvedVendorCode)];

    return {
      hasCost: hasCostByAnyKey(keys),
      hasProductMapping,
      resolvedVendorCode,
      displayVendorCode,
    };
  }

  return {
    hasWbCost,
    resolveOzonCost,
  };
}

function uniquePushMissingItem(
  missingByKey: Map<string, MissingCostItem>,
  item: MissingCostItem
) {
  const key = [
    item.marketplace,
    item.companyName,
    item.issueType ?? "MISSING_COST",
    normalizeText(item.vendorCode),
    normalizeText(item.externalId),
  ].join("|");

  const current = missingByKey.get(key);

  if (!current) {
    missingByKey.set(key, item);
    return;
  }

  current.quantity += item.quantity;
  current.amount += item.amount;
}

export async function getCostCoverageSummary(params: {
  dateFrom: string;
  dateTo: string;
  companyName?: string | null;
  examplesLimit?: number;
}): Promise<CostCoverageSummary> {
  const dateFrom = startOfDayUtc(params.dateFrom);
  const dateTo = endOfDayUtc(params.dateTo);
  const companyFilter = params.companyName
    ? {
        companyName: params.companyName,
      }
    : {};

  const [costs, wbProductCards, ozonProducts, ozonStockMappings, wbRows, ozonRows] = await Promise.all([
    prisma.productCost.findMany({
      select: {
        vendorCode: true,
        nmId: true,
        costPrice: true,
      },
      orderBy: [
        {
          costDate: "desc",
        },
        {
          createdAt: "desc",
        },
      ],
    }),
    prisma.wbProductCard.findMany({
      where: companyFilter,
      select: {
        nmId: true,
        vendorCode: true,
      },
    }),
    prisma.ozonProduct.findMany({
      where: companyFilter,
      select: {
        sku: true,
        vendorCode: true,
      },
    }),
    prisma.ozonStock.findMany({
      where: companyFilter,
      select: {
        sku: true,
        vendorCode: true,
      },
    }),
    prisma.wbSale.groupBy({
      by: ["companyName", "vendorCode", "nmId", "productName"],
      where: {
        ...companyFilter,
        saleDate: {
          gte: dateFrom,
          lte: dateTo,
        },
      },
      _sum: {
        quantity: true,
        wbRealizedAmount: true,
        sellerPayout: true,
      },
    }),
    prisma.ozonFinance.groupBy({
      by: ["companyName", "vendorCode", "sku"],
      where: {
        ...companyFilter,
        accrualDate: {
          gte: dateFrom,
          lte: dateTo,
        },
      },
      _sum: {
        quantity: true,
        salesAmount: true,
        totalAmount: true,
      },
    }),
  ]);

  const { hasWbCost, resolveOzonCost } = createCostResolvers({
    costs,
    wbProductCards,
    ozonProducts: [...ozonProducts, ...ozonStockMappings],
  });

  const missingByKey = new Map<string, MissingCostItem>();
  let checkedItemsCount = 0;
  let technicalWbItemsCount = 0;
  let technicalWbQuantity = 0;
  let technicalWbAmount = 0;
  let unmappedOzonItemsCount = 0;

  for (const row of wbRows) {
    const vendorCode = cleanText(row.vendorCode);
    const nmId = cleanText(row.nmId);
    const quantity = Math.abs(toNumber(row._sum.quantity));
    const amount = Math.abs(
      toNumber(row._sum.wbRealizedAmount) || toNumber(row._sum.sellerPayout)
    );

    if (!vendorCode && !nmId) continue;
    if (quantity <= 0 && amount <= 0) continue;

    // WB sometimes contains technical/unrecognized rows with qty but zero turnover.
    // They should not be mixed with real missing cost because they do not overstate profit by revenue.
    if (amount <= 0) {
      if (!hasWbCost({ vendorCode, nmId })) {
        technicalWbItemsCount += 1;
        technicalWbQuantity += quantity;
        technicalWbAmount += amount;
      }
      continue;
    }

    checkedItemsCount += 1;

    if (hasWbCost({ vendorCode, nmId })) continue;

    uniquePushMissingItem(missingByKey, {
      marketplace: "WB",
      companyName: cleanText(row.companyName) || "Без компании",
      vendorCode: vendorCode || "—",
      externalId: nmId || "—",
      productName: cleanText(row.productName) || vendorCode || nmId || "Без названия",
      quantity,
      amount,
      issueType: "MISSING_COST",
    });
  }

  for (const row of ozonRows) {
    const vendorCode = cleanText(row.vendorCode);
    const sku = cleanText(row.sku);
    const quantity = Math.abs(toNumber(row._sum.quantity));
    const salesAmount = Math.abs(toNumber(row._sum.salesAmount));
    const totalAmount = Math.abs(toNumber(row._sum.totalAmount));
    const amount = salesAmount || totalAmount;

    if (!vendorCode && !sku) continue;

    // Cost coverage should check product movements, not marketplace service rows.
    if (quantity <= 0 && salesAmount <= 0) continue;

    checkedItemsCount += 1;

    const resolved = resolveOzonCost({ vendorCode, sku });

    if (resolved.hasCost) continue;

    if (!resolved.hasProductMapping) {
      unmappedOzonItemsCount += 1;
    }

    uniquePushMissingItem(missingByKey, {
      marketplace: "OZON",
      companyName: cleanText(row.companyName) || "Без компании",
      vendorCode: vendorCode || resolved.displayVendorCode || "—",
      externalId: sku || "—",
      productName: vendorCode || resolved.displayVendorCode || sku || "Без названия",
      quantity,
      amount,
      issueType: resolved.hasProductMapping ? "MISSING_COST" : "MISSING_OZON_MAPPING",
    });
  }

  const missingItems = Array.from(missingByKey.values()).sort((a, b) => {
    const amountDelta = b.amount - a.amount;
    if (amountDelta !== 0) return amountDelta;
    return b.quantity - a.quantity;
  });

  const missingWbItemsCount = missingItems.filter(
    (item) => item.marketplace === "WB"
  ).length;
  const missingOzonItemsCount = missingItems.filter(
    (item) => item.marketplace === "OZON"
  ).length;
  const missingRealCostItemsCount = missingItems.filter(
    (item) => item.issueType !== "MISSING_OZON_MAPPING"
  ).length;
  const missingQuantity = missingItems.reduce((sum, item) => sum + item.quantity, 0);
  const missingAmount = missingItems.reduce((sum, item) => sum + item.amount, 0);

  return {
    companyName: params.companyName ?? null,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    checkedItemsCount,
    missingItemsCount: missingItems.length,
    missingWbItemsCount,
    missingOzonItemsCount,
    missingQuantity,
    missingAmount,
    examples: missingItems.slice(0, params.examplesLimit ?? 8),
    hasMissingCosts: missingItems.length > 0,
    technicalWbItemsCount,
    technicalWbQuantity,
    technicalWbAmount,
    unmappedOzonItemsCount,
    missingRealCostItemsCount,
  };
}
