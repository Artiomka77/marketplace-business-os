import { prisma } from "@/lib/prisma";
import { buildCanonicalPositiveCostLookups } from "@/lib/analytics/productCostResolver";
import {
  extractOzonAccrualProductMovements,
  mapMovementsToCogsProductRows,
} from "@/lib/ozon/ozonAccrualProductMovements";
import { selectOzonAccrualDayOwners } from "@/lib/ozon/ozonAccrualSessionOwnership";

type CostRecord = {
  id: string;
  vendorCode: string;
  nmId: string | null;
  costPrice: unknown;
  costDate: Date | null;
  createdAt: Date;
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
  /** Product-grain Ozon movements used for COGS authority (not OzonFinance emptiness). */
  ozonProductMovementGroups: number;
  ozonFinanceFallbackGroups: number;
  ozonProductAuthorityEmpty: boolean;
  /** No product authority and no finance product sales — not "all costs found". */
  ozonSourceMissing: boolean;
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
  return buildCanonicalPositiveCostLookups(costs);
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

  const [
    costs,
    wbProductCards,
    ozonProducts,
    ozonStockMappings,
    wbRows,
    ozonFinanceRows,
    ozonRealizationRows,
    ozonAccrualSessions,
  ] = await Promise.all([
    prisma.productCost.findMany({
      select: {
        id: true,
        vendorCode: true,
        nmId: true,
        costPrice: true,
        costDate: true,
        createdAt: true,
      },
      orderBy: [
        {
          costDate: "desc",
        },
        {
          createdAt: "desc",
        },
        {
          id: "desc",
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
    // Prefer findMany (day-aware). Fall back to groupBy for harnesses that
    // only stub groupBy — missing accrualDate must NOT suppress other days.
    (async () => {
      const api = prisma.ozonFinance as {
        findMany?: (args: unknown) => Promise<unknown[]>;
        groupBy?: (args: unknown) => Promise<unknown[]>;
      };
      if (typeof api.findMany === "function") {
        return api.findMany({
          where: {
            ...companyFilter,
            accrualDate: {
              gte: dateFrom,
              lte: dateTo,
            },
          },
          select: {
            companyName: true,
            vendorCode: true,
            sku: true,
            quantity: true,
            salesAmount: true,
            totalAmount: true,
            accrualDate: true,
          },
        });
      }
      if (typeof api.groupBy === "function") {
        const groups = (await api.groupBy({
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
        })) as Array<{
          companyName?: string | null;
          vendorCode?: string | null;
          sku?: string | null;
          _sum?: {
            quantity?: unknown;
            salesAmount?: unknown;
            totalAmount?: unknown;
          };
        }>;
        return groups.map((g) => ({
          companyName: g.companyName,
          vendorCode: g.vendorCode,
          sku: g.sku,
          quantity: g._sum?.quantity,
          salesAmount: g._sum?.salesAmount,
          totalAmount: g._sum?.totalAmount,
          accrualDate: null,
        }));
      }
      throw new Error(
        "costCoverage: ozonFinance.findMany/groupBy unavailable — refuse silent empty",
      );
    })(),
    prisma.ozonRealizationRow.findMany({
      where: {
        ...companyFilter,
        sku: { not: null },
        dateFrom: { gte: dateFrom },
        dateTo: { lte: dateTo },
      },
      select: {
        companyName: true,
        vendorCode: true,
        sku: true,
        productName: true,
        realizedQty: true,
        returnedQty: true,
        realizedAmount: true,
        returnedAmount: true,
      },
    }),
    prisma.importSession.findMany({
      where: {
        ...companyFilter,
        reportType: "OZON_ACCRUAL_BY_DAY_API",
        status: { in: ["SUCCESS", "RAW_PERSISTED", "CANONICAL_PERSISTED"] },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        companyName: true,
        status: true,
        createdAt: true,
        previewJson: true,
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

  // Same physical universe as COGS: RAW accrual products first, then sku-grain
  // realization. Per-company: product authority does not suppress another
  // company's finance fallback.
  const vendorBySku = new Map<string, string>();
  for (const row of [...ozonProducts, ...ozonStockMappings]) {
    const sku = cleanText(row.sku);
    const vendor = cleanText(row.vendorCode);
    if (sku && vendor && !vendorBySku.has(sku)) vendorBySku.set(sku, vendor);
  }

  type OzonMovementAgg = {
    companyName: string;
    vendorCode: string;
    sku: string;
    productName: string;
    quantity: number;
    amount: number;
  };
  const ozonProductRows: OzonMovementAgg[] = [];
  const periodFrom = params.dateFrom.slice(0, 10);
  const periodTo = params.dateTo.slice(0, 10);
  const owners = selectOzonAccrualDayOwners({
    sessions: ozonAccrualSessions,
    dateFrom: periodFrom,
    dateTo: periodTo,
  });
  /** Proven-complete product authority keys: company|YYYY-MM-DD */
  const completeAuthorityDays = new Set(
    [...owners.values()]
      .filter((owner) => owner.complete)
      .map((owner) => `${owner.companyName}|${owner.day}`),
  );
  const seenEvents = new Set<string>();
  for (const owner of owners.values()) {
    const rawAccruals = Array.isArray(owner.preview.rawAccruals)
      ? owner.preview.rawAccruals
      : [];
    const movements = extractOzonAccrualProductMovements({
      companyName: owner.companyName,
      sessionId: owner.sessionId,
      rawAccruals,
      dateFrom: owner.day,
      dateTo: owner.day,
    });
    for (const row of mapMovementsToCogsProductRows(movements, vendorBySku)) {
      if (seenEvents.has(row.eventId)) continue;
      seenEvents.add(row.eventId);
      const quantity =
        Math.abs(row.realizedQty) + Math.abs(row.returnedQty);
      const amount =
        Math.abs(row.realizedAmount) + Math.abs(row.returnedAmount);
      if (quantity <= 0 && amount <= 0) continue;
      ozonProductRows.push({
        companyName: row.companyName,
        vendorCode: cleanText(row.vendorCode) || "—",
        sku: cleanText(row.sku) || "—",
        productName:
          cleanText(row.vendorCode) || cleanText(row.sku) || "Без названия",
        quantity,
        amount,
      });
    }
  }

  if (ozonProductRows.length === 0) {
    for (const row of ozonRealizationRows) {
      const vendorCode = cleanText(row.vendorCode);
      const sku = cleanText(row.sku);
      if (!vendorCode && !sku) continue;
      const quantity =
        Math.abs(toNumber(row.realizedQty)) + Math.abs(toNumber(row.returnedQty));
      const amount =
        Math.abs(toNumber(row.realizedAmount)) +
        Math.abs(toNumber(row.returnedAmount));
      if (quantity <= 0 && amount <= 0) continue;
      ozonProductRows.push({
        companyName: cleanText(row.companyName) || "Без компании",
        vendorCode: vendorCode || "—",
        sku: sku || "—",
        productName: cleanText(row.productName) || vendorCode || sku || "Без названия",
        quantity,
        amount,
      });
    }
  }

  // Finance fallback only for (company, day) without proven-complete product
  // authority — same universe as COGS hybrid (not company-wide suppress).
  let ozonProductMovementGroups = 0;
  let ozonFinanceFallbackGroups = 0;

  const groupedProducts = new Map<string, OzonMovementAgg>();
  for (const row of ozonProductRows) {
    const key = `${row.companyName}|${row.vendorCode}|${row.sku}`;
    const cur = groupedProducts.get(key) ?? {
      ...row,
      quantity: 0,
      amount: 0,
    };
    cur.quantity += row.quantity;
    cur.amount += row.amount;
    groupedProducts.set(key, cur);
  }
  ozonProductMovementGroups = groupedProducts.size;
  for (const row of groupedProducts.values()) {
    checkedItemsCount += 1;
    const resolved = resolveOzonCost({
      vendorCode: row.vendorCode,
      sku: row.sku,
    });
    if (resolved.hasCost) continue;
    if (!resolved.hasProductMapping) unmappedOzonItemsCount += 1;
    uniquePushMissingItem(missingByKey, {
      marketplace: "OZON",
      companyName: row.companyName,
      vendorCode: row.vendorCode || resolved.displayVendorCode || "—",
      externalId: row.sku,
      productName: row.productName,
      quantity: row.quantity,
      amount: row.amount,
      issueType: resolved.hasProductMapping
        ? "MISSING_COST"
        : "MISSING_OZON_MAPPING",
    });
  }

  type FinanceAgg = OzonMovementAgg & { day: string };
  const financeBySkuDay = new Map<string, FinanceAgg>();
  for (const row of ozonFinanceRows as Array<{
    companyName?: string | null;
    vendorCode?: string | null;
    sku?: string | null;
    quantity?: unknown;
    salesAmount?: unknown;
    totalAmount?: unknown;
    accrualDate?: Date | string | null;
  }>) {
    const companyName = cleanText(row.companyName) || "Без компании";
    const day =
      row.accrualDate instanceof Date
        ? row.accrualDate.toISOString().slice(0, 10)
        : String(row.accrualDate ?? "").slice(0, 10);
    // Suppress finance product sales only for proven-complete company+day.
    if (day && completeAuthorityDays.has(`${companyName}|${day}`)) continue;
    const vendorCode = cleanText(row.vendorCode);
    const sku = cleanText(row.sku);
    const quantity = Math.abs(toNumber(row.quantity));
    const salesAmount = Math.abs(toNumber(row.salesAmount));
    const totalAmount = Math.abs(toNumber(row.totalAmount));
    const amount = salesAmount || totalAmount;
    if (!vendorCode && !sku) continue;
    if (quantity <= 0 && amount <= 0) continue;
    // Skip money-only service rows without product sale amount.
    if (salesAmount === 0 && quantity === 0) continue;
    const key = `${companyName}|${day}|${vendorCode || "—"}|${sku || "—"}`;
    const cur = financeBySkuDay.get(key) ?? {
      companyName,
      vendorCode: vendorCode || "—",
      sku: sku || "—",
      productName: vendorCode || sku || "Без названия",
      quantity: 0,
      amount: 0,
      day,
    };
    cur.quantity += quantity;
    cur.amount += amount;
    financeBySkuDay.set(key, cur);
  }
  for (const row of financeBySkuDay.values()) {
    const vendorCode = row.vendorCode;
    const sku = row.sku;
    const quantity = row.quantity;
    const amount = row.amount;
    if ((!vendorCode || vendorCode === "—") && (!sku || sku === "—")) continue;
    if (quantity <= 0 && amount <= 0) continue;
    ozonFinanceFallbackGroups += 1;
    checkedItemsCount += 1;
    const resolved = resolveOzonCost({ vendorCode, sku });
    if (resolved.hasCost) continue;
    if (!resolved.hasProductMapping) unmappedOzonItemsCount += 1;
    uniquePushMissingItem(missingByKey, {
      marketplace: "OZON",
      companyName: row.companyName,
      vendorCode: vendorCode || resolved.displayVendorCode || "—",
      externalId: sku || "—",
      productName:
        vendorCode || resolved.displayVendorCode || sku || "Без названия",
      quantity,
      amount,
      issueType: resolved.hasProductMapping
        ? "MISSING_COST"
        : "MISSING_OZON_MAPPING",
    });
  }

  const ozonProductAuthorityEmpty = ozonProductMovementGroups === 0;
  const ozonSourceMissing =
    ozonProductAuthorityEmpty && ozonFinanceFallbackGroups === 0;

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
    hasMissingCosts: missingItems.length > 0 || ozonSourceMissing,
    technicalWbItemsCount,
    technicalWbQuantity,
    technicalWbAmount,
    unmappedOzonItemsCount,
    missingRealCostItemsCount,
    ozonProductMovementGroups,
    ozonFinanceFallbackGroups,
    ozonProductAuthorityEmpty,
    ozonSourceMissing,
  };
}
