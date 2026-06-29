import { prisma } from "@/lib/prisma";
import { calculateFinanceMetricsForRows } from "@/lib/finance/financeMetrics";

export type DailyReportPeriodPreset =
  | "yesterday"
  | "day_before_yesterday"
  | "3d"
  | "current_week"
  | "7d"
  | "15d"
  | "month"
  | "3m"
  | "6m"
  | "year"
  | "30d"
  | "90d"
  | "365d";

type DateRange = {
  dateLabel: string;
  periodLabel: string;
  dateFrom: Date;
  dateToExclusive: Date;
};

type MarketplaceDailyMetrics = {
  marketplace: "WB" | "OZON";
  ordersQty: number;
  ordersAmount: number;
  orderDataLoadedDays: number;
  orderDataExpectedDays: number;
  ordersDataMissing: boolean;
  ordersDataIncomplete: boolean;
  ordersDataMissingReason: string | null;
  salesQty: number;
  salesAmount: number;
  salesLabel: string;
  salesQtyIsReliable: boolean;
  salesDataMissing: boolean;
  salesDataMissingReason: string | null;
  adSpend: number;
  adSpendSource: string;
  adDataMissing: boolean;
  adDataMissingReason: string | null;
  drrByOrders: number;
  drrBySales: number;
  stockQty: number;
  netProfitAfterTax: number;
};

type CompanyDailyReport = {
  companyName: string;
  wb: MarketplaceDailyMetrics;
  ozon: MarketplaceDailyMetrics;
  finance: {
    cashIncome: number;
    cashOutflow: number;
    netCashFlow: number;
    netProfitImpact: number;
    ownerWithdrawals: number;
  };
};

type DailyReport = {
  dateLabel: string;
  periodLabel: string;
  companies: CompanyDailyReport[];
  totals: {
    ordersQty: number;
    ordersAmount: number;
    orderDataLoadedDays: number;
    orderDataExpectedDays: number;
    salesQty: number;
    salesAmount: number;
    adSpend: number;
    drrByOrders: number;
    drrBySales: number;
    stockQty: number;
    cashIncome: number;
    cashOutflow: number;
    netCashFlow: number;
    netProfitImpact: number;
    ownerWithdrawals: number;
  };
  warnings: string[];
};

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;

  if (typeof value === "object" && "toNumber" in value) {
    const number = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(number) ? number : 0;
  }

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function normalizeText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function formatDateInput(date: Date) {
  return date.toISOString().slice(0, 10);
}

function makeMoscowRange(params: {
  days: number;
  label: string;
  now?: Date;
}): DateRange {
  const now = params.now ?? new Date();
  const moscowNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);

  const year = moscowNow.getUTCFullYear();
  const month = moscowNow.getUTCMonth();
  const day = moscowNow.getUTCDate();

  const dateToExclusive = new Date(Date.UTC(year, month, day, -3, 0, 0));
  const dateFrom = new Date(
    Date.UTC(year, month, day - params.days, -3, 0, 0)
  );

  const dateFromLabel = formatDateInput(
    new Date(Date.UTC(year, month, day - params.days, 12))
  );
  const dateToLabel = formatDateInput(
    new Date(Date.UTC(year, month, day - 1, 12))
  );

  return {
    dateLabel:
      params.days === 1 ? dateToLabel : `${dateFromLabel} — ${dateToLabel}`,
    periodLabel: params.label,
    dateFrom,
    dateToExclusive,
  };
}


function makeMoscowDayRange(params: {
  offsetDays: number;
  label: string;
  now?: Date;
}): DateRange {
  const now = params.now ?? new Date();
  const moscowNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);

  const year = moscowNow.getUTCFullYear();
  const month = moscowNow.getUTCMonth();
  const day = moscowNow.getUTCDate() - params.offsetDays;

  const dateFrom = new Date(Date.UTC(year, month, day, -3, 0, 0));
  const dateToExclusive = new Date(Date.UTC(year, month, day + 1, -3, 0, 0));
  const dateLabel = formatDateInput(new Date(Date.UTC(year, month, day, 12)));

  return {
    dateLabel,
    periodLabel: params.label,
    dateFrom,
    dateToExclusive,
  };
}

function makeCurrentMoscowWeekRange(now?: Date): DateRange {
  const currentNow = now ?? new Date();
  const moscowNow = new Date(currentNow.getTime() + 3 * 60 * 60 * 1000);

  const year = moscowNow.getUTCFullYear();
  const month = moscowNow.getUTCMonth();
  const day = moscowNow.getUTCDate();
  const dayOfWeek = moscowNow.getUTCDay();
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const mondayNoon = new Date(Date.UTC(year, month, day - daysFromMonday, 12));
  const yesterdayNoon = new Date(Date.UTC(year, month, day - 1, 12));

  const dateFrom = new Date(
    Date.UTC(year, month, day - daysFromMonday, -3, 0, 0)
  );
  const dateToExclusive = new Date(Date.UTC(year, month, day, -3, 0, 0));

  return {
    dateLabel:
      dateFrom.getTime() >= dateToExclusive.getTime()
        ? formatDateInput(mondayNoon)
        : `${formatDateInput(mondayNoon)} — ${formatDateInput(yesterdayNoon)}`,
    periodLabel: "Текущая неделя",
    dateFrom,
    dateToExclusive,
  };
}

function normalizeReportPreset(
  preset: DailyReportPeriodPreset | undefined
): DailyReportPeriodPreset {
  if (preset === "30d") return "month";
  if (preset === "90d") return "3m";
  if (preset === "365d") return "year";

  return preset ?? "yesterday";
}

export function getDailyReportRange(params?: {
  preset?: DailyReportPeriodPreset;
  date?: string;
  from?: string;
  to?: string;
  now?: Date;
}): DateRange {
  if (params?.from && params?.to) {
    const [fromYear, fromMonth, fromDay] = params.from.split("-").map(Number);
    const [toYear, toMonth, toDay] = params.to.split("-").map(Number);

    if (fromYear && fromMonth && fromDay && toYear && toMonth && toDay) {
      return {
        dateLabel: `${params.from} — ${params.to}`,
        periodLabel: "Выбранный период",
        dateFrom: new Date(Date.UTC(fromYear, fromMonth - 1, fromDay, -3, 0, 0)),
        dateToExclusive: new Date(
          Date.UTC(toYear, toMonth - 1, toDay + 1, -3, 0, 0)
        ),
      };
    }
  }

  if (params?.date) {
    const [year, month, day] = params.date.split("-").map(Number);

    if (year && month && day) {
      return {
        dateLabel: params.date,
        periodLabel: "Выбранный день",
        dateFrom: new Date(Date.UTC(year, month - 1, day, -3, 0, 0)),
        dateToExclusive: new Date(Date.UTC(year, month - 1, day + 1, -3, 0, 0)),
      };
    }
  }

  const preset = normalizeReportPreset(params?.preset);

  if (preset === "day_before_yesterday") {
    return makeMoscowDayRange({
      offsetDays: 2,
      label: "Позавчера",
      now: params?.now,
    });
  }

  if (preset === "3d") {
    return makeMoscowRange({
      days: 3,
      label: "Последние 3 дня",
      now: params?.now,
    });
  }

  if (preset === "current_week") {
    return makeCurrentMoscowWeekRange(params?.now);
  }

  if (preset === "7d") {
    return makeMoscowRange({
      days: 7,
      label: "Последние 7 дней",
      now: params?.now,
    });
  }

  if (preset === "15d") {
    return makeMoscowRange({
      days: 15,
      label: "Последние 15 дней",
      now: params?.now,
    });
  }

  if (preset === "month") {
    return makeMoscowRange({
      days: 30,
      label: "Последний месяц",
      now: params?.now,
    });
  }

  if (preset === "3m") {
    return makeMoscowRange({
      days: 90,
      label: "Последние 3 месяца",
      now: params?.now,
    });
  }

  if (preset === "6m") {
    return makeMoscowRange({
      days: 183,
      label: "Последние 6 месяцев",
      now: params?.now,
    });
  }

  if (preset === "year") {
    return makeMoscowRange({
      days: 365,
      label: "Последний год",
      now: params?.now,
    });
  }

  return makeMoscowDayRange({
    offsetDays: 1,
    label: "Вчера",
    now: params?.now,
  });
}

function getExpectedOrderDays(range: DateRange) {
  const diff = range.dateToExclusive.getTime() - range.dateFrom.getTime();
  return Math.max(1, Math.round(diff / 86_400_000));
}

function getOrderDateKey(date: Date) {
  return new Date(date.getTime() + 3 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function hasIncompleteOrderData(report: DailyReport) {
  return (
    report.totals.orderDataExpectedDays > 0 &&
    report.totals.orderDataLoadedDays < report.totals.orderDataExpectedDays
  );
}

function isWbSaleOperation(reason: string | null | undefined) {
  const value = normalizeText(reason);
  return value === "продажа" || value === "сторно возвратов";
}

function isWbReturnOperation(reason: string | null | undefined) {
  return normalizeText(reason) === "возврат";
}

function getDateSpan(dateFrom: Date | null, dateTo: Date | null) {
  if (!dateFrom && !dateTo) return [];

  const from = new Date(dateFrom ?? dateTo ?? new Date());
  const to = new Date(dateTo ?? dateFrom ?? new Date());

  from.setHours(0, 0, 0, 0);
  to.setHours(0, 0, 0, 0);

  const dates: string[] = [];

  for (const cursor = new Date(from); cursor.getTime() <= to.getTime(); cursor.setDate(cursor.getDate() + 1)) {
    dates.push(cursor.toISOString().slice(0, 10));
  }

  return dates;
}

function keepLatestWbAdsRowsPerDate<
  T extends {
    dateFrom: Date | null;
    dateTo: Date | null;
    importSessionId: string | null;
    createdAt: Date;
  },
>(rows: T[]) {
  const latestSessionByDate = new Map<string, string | null>();

  for (const row of rows) {
    const dates = getDateSpan(row.dateFrom, row.dateTo);

    for (const date of dates) {
      if (!latestSessionByDate.has(date)) {
        latestSessionByDate.set(date, row.importSessionId ?? null);
      }
    }
  }

  return rows.filter((row) => {
    const dates = getDateSpan(row.dateFrom, row.dateTo);
    if (dates.length === 0) return false;

    return dates.some(
      (date) => latestSessionByDate.get(date) === (row.importSessionId ?? null)
    );
  });
}

function keepLatestOzonAdsRowsPerDate<
  T extends {
    reportDate: Date | null;
    importSessionId: string | null;
    createdAt: Date;
  },
>(rows: T[]) {
  const latestSessionByDate = new Map<string, string | null>();

  for (const row of rows) {
    if (!row.reportDate) continue;

    const date = row.reportDate.toISOString().slice(0, 10);

    if (!latestSessionByDate.has(date)) {
      latestSessionByDate.set(date, row.importSessionId ?? null);
    }
  }

  return rows.filter((row) => {
    if (!row.reportDate) return false;

    const date = row.reportDate.toISOString().slice(0, 10);

    return latestSessionByDate.get(date) === (row.importSessionId ?? null);
  });
}

type WbStockRowForReport = {
  warehouseName: string | null;
  vendorCode: string | null;
  barcode: string | null;
  nmId: string | null;
  chrtId: string | null;
  size: string | null;
  inTransitToCustomer: number | null;
  inTransitReturns: number | null;
  totalStock: number | null;
  warehouseQty: number | null;
};

function getWbStockProductKey(row: WbStockRowForReport) {
  return [
    row.nmId ?? "",
    row.chrtId ?? "",
    row.barcode ?? "",
    row.vendorCode ?? "",
    row.size ?? "",
  ].join("|");
}

function calculateWbStockQty(rows: WbStockRowForReport[]) {
  if (rows.length === 0) return 0;

  const totalRows = rows.filter((row) => row.warehouseName === "__TOTAL__");

  if (totalRows.length > 0) {
    return totalRows.reduce(
      (sum, row) =>
        sum +
        toNumber(row.inTransitToCustomer) +
        toNumber(row.inTransitReturns) +
        toNumber(row.totalStock),
      0
    );
  }

  const hasWarehouseQty = rows.some((row) => toNumber(row.warehouseQty) > 0);

  if (hasWarehouseQty) {
    return rows.reduce((sum, row) => sum + toNumber(row.warehouseQty), 0);
  }

  const latestByProduct = new Map<string, WbStockRowForReport>();

  for (const row of rows) {
    const key = getWbStockProductKey(row);

    if (!latestByProduct.has(key)) {
      latestByProduct.set(key, row);
    }
  }

  return Array.from(latestByProduct.values()).reduce(
    (sum, row) =>
      sum +
      toNumber(row.inTransitToCustomer) +
      toNumber(row.inTransitReturns) +
      toNumber(row.totalStock),
    0
  );
}

async function getLatestWbStockQty(companyName: string) {
  const latestStockImport = await prisma.importSession.findFirst({
    where: {
      companyName,
      reportType: "WB_STOCK",
    },
    orderBy: {
      createdAt: "desc",
    },
    select: {
      id: true,
    },
  });

  let rows = latestStockImport
    ? await prisma.wbStock.findMany({
        where: {
          companyName,
          importSessionId: latestStockImport.id,
        },
        select: {
          warehouseName: true,
          vendorCode: true,
          barcode: true,
          nmId: true,
          chrtId: true,
          size: true,
          inTransitToCustomer: true,
          inTransitReturns: true,
          totalStock: true,
          warehouseQty: true,
        },
      })
    : [];

  // Часть API-синхронизаций хранит актуальные остатки без ImportSession.
  // Поэтому если по последней сессии строк нет, берём текущие строки компании.
  if (rows.length === 0) {
    rows = await prisma.wbStock.findMany({
      where: {
        companyName,
      },
      select: {
        warehouseName: true,
        vendorCode: true,
        barcode: true,
        nmId: true,
        chrtId: true,
        size: true,
        inTransitToCustomer: true,
        inTransitReturns: true,
        totalStock: true,
        warehouseQty: true,
      },
    });
  }

  return calculateWbStockQty(rows);
}

async function getLatestOzonStockQty(companyName: string) {
  // Ozon stock sync перезаписывает текущие строки по компании и часто хранит
  // importSessionId = null. Поэтому нельзя искать только последнюю ImportSession.
  const rows = await prisma.ozonStock.findMany({
    where: {
      companyName,
    },
    select: {
      availableQty: true,
      preparingQty: true,
      supplyQty: true,
      inTransitQty: true,
      returnQty: true,
    },
  });

  return rows.reduce(
    (sum, row) =>
      sum +
      toNumber(row.availableQty) +
      toNumber(row.preparingQty) +
      toNumber(row.supplyQty) +
      toNumber(row.inTransitQty) +
      toNumber(row.returnQty),
    0
  );
}

function isOzonFinanceAdOperation(operationType: string | null | undefined) {
  const value = normalizeText(operationType);

  return (
    value.includes("оплата за клик") ||
    value.includes("продвижение с оплатой за заказ") ||
    value.includes("продвижение") ||
    value.includes("реклама") ||
    value.includes("реклам") ||
    value.includes("трафарет") ||
    value.includes("cpc") ||
    value.includes("cpo")
  );
}

function calculateOzonFinanceAdSpend(
  rows: Array<{ operationType: string | null; totalAmount: unknown }>
) {
  return rows
    .filter((row) => isOzonFinanceAdOperation(row.operationType))
    .reduce((sum, row) => sum + Math.abs(toNumber(row.totalAmount)), 0);
}

function clampRate(value: unknown, allowedRates: number[], fallback: number) {
  const rate = toNumber(value);
  return allowedRates.includes(rate) ? rate : fallback;
}

function calculateVatTax(revenue: number, vatRate: number) {
  if (vatRate <= 0) return 0;
  return revenue * (vatRate / (100 + vatRate));
}

function calculateTaxesAmount(params: {
  revenue: number;
  usnRate: number;
  vatRate: number;
}) {
  if (params.revenue <= 0) return 0;

  return (
    params.revenue * (params.usnRate / 100) +
    calculateVatTax(params.revenue, params.vatRate)
  );
}

function getCompanyTaxRates(company: {
  usnRate: unknown;
  vatRate: unknown;
} | null) {
  return {
    usnRate: clampRate(company?.usnRate, [0, 1, 2, 3, 4, 5, 6], 1),
    vatRate: clampRate(company?.vatRate, [0, 5, 7], 5),
  };
}

type ProductCostForDailyProfit = {
  vendorCode: string;
  nmId: string | null;
  costPrice: unknown;
};

type WbProductCardForDailyProfit = {
  nmId: string;
  vendorCode: string | null;
};

type OzonProductForDailyProfit = {
  sku: string;
  vendorCode: string;
};

function buildCostLookups(costs: ProductCostForDailyProfit[]) {
  const costByVendorCode = new Map<string, number>();
  const costByNmId = new Map<string, number>();

  for (const cost of costs) {
    const vendorCode = normalizeText(cost.vendorCode);
    const nmId = normalizeText(cost.nmId);
    const costPrice = toNumber(cost.costPrice);

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

function buildWbSupplierArticleByNmId(cards: WbProductCardForDailyProfit[]) {
  const supplierArticleByNmId = new Map<string, string>();

  for (const card of cards) {
    const nmId = normalizeText(card.nmId);
    const vendorCode = normalizeText(card.vendorCode);

    if (!nmId || !vendorCode || supplierArticleByNmId.has(nmId)) continue;

    supplierArticleByNmId.set(nmId, vendorCode);
  }

  return supplierArticleByNmId;
}

function buildOzonVendorCodeBySku(products: OzonProductForDailyProfit[]) {
  const vendorCodeBySku = new Map<string, string>();

  for (const product of products) {
    const sku = normalizeText(product.sku);
    const vendorCode = normalizeText(product.vendorCode);

    if (!sku || !vendorCode || vendorCodeBySku.has(sku)) continue;

    vendorCodeBySku.set(sku, vendorCode);
  }

  return vendorCodeBySku;
}

function getOzonBaseArticle(value: unknown) {
  const vendorCode = cleanText(value);
  if (!vendorCode) return "";

  return cleanText(vendorCode.split("-")[0]);
}

function getWbCostPrice(params: {
  vendorCode: unknown;
  costs: ProductCostForDailyProfit[];
}) {
  const { costByVendorCode } = buildCostLookups(params.costs);
  const vendorCode = normalizeText(params.vendorCode);

  return vendorCode ? costByVendorCode.get(vendorCode) ?? 0 : 0;
}

function createOzonCostResolver(params: {
  costs: ProductCostForDailyProfit[];
  wbProductCards: WbProductCardForDailyProfit[];
  ozonProducts: OzonProductForDailyProfit[];
}) {
  const { costByVendorCode, costByNmId } = buildCostLookups(params.costs);
  const wbSupplierArticleByNmId = buildWbSupplierArticleByNmId(
    params.wbProductCards
  );
  const ozonVendorCodeBySku = buildOzonVendorCodeBySku(params.ozonProducts);

  return function resolveOzonCostPrice(row: {
    sku: string | null;
    vendorCode: string | null;
  }) {
    const sku = normalizeText(row.sku);
    const directVendorCode = normalizeText(row.vendorCode);
    const mappedVendorCode = sku ? ozonVendorCodeBySku.get(sku) ?? "" : "";
    const vendorCode = directVendorCode || mappedVendorCode || sku;

    if (!vendorCode) return 0;

    const directCost = costByVendorCode.get(vendorCode);
    if (directCost !== undefined) return directCost;

    const baseArticle = normalizeText(getOzonBaseArticle(vendorCode));
    if (!baseArticle) return 0;

    const costByBaseNmId = costByNmId.get(baseArticle);
    if (costByBaseNmId !== undefined) return costByBaseNmId;

    const directBaseCost = costByVendorCode.get(baseArticle);
    if (directBaseCost !== undefined) return directBaseCost;

    const wbSupplierArticle = wbSupplierArticleByNmId.get(baseArticle);
    if (!wbSupplierArticle) return 0;

    return costByVendorCode.get(wbSupplierArticle) ?? 0;
  };
}

function calculateWbNetProfitAfterTax(params: {
  rows: Array<{
    paymentReason: string | null;
    quantity: number | null;
    wbRealizedAmount: unknown;
    sellerPayout: unknown;
    vendorCode: string | null;
  }>;
  costs: ProductCostForDailyProfit[];
  adSpend: number;
  usnRate: number;
  vatRate: number;
}) {
  let revenue = 0;
  let sellerPayout = 0;
  let totalCost = 0;

  for (const row of params.rows) {
    const paymentReason = normalizeText(row.paymentReason);
    const quantity = Math.abs(toNumber(row.quantity)) || 1;
    const realizedAmount = Math.abs(toNumber(row.wbRealizedAmount));
    const payout = Math.abs(toNumber(row.sellerPayout));
    const costPrice = getWbCostPrice({
      vendorCode: row.vendorCode,
      costs: params.costs,
    });

    if (isWbSaleOperation(paymentReason)) {
      revenue += realizedAmount;
      sellerPayout += payout;
      totalCost += costPrice * quantity;
      continue;
    }

    if (isWbReturnOperation(paymentReason)) {
      revenue -= realizedAmount;
      sellerPayout -= payout;
      totalCost -= costPrice * quantity;
    }
  }

  const taxesAmount = calculateTaxesAmount({
    revenue,
    usnRate: params.usnRate,
    vatRate: params.vatRate,
  });

  return sellerPayout - totalCost - params.adSpend - taxesAmount;
}

function calculateOzonNetProfitAfterTax(params: {
  rows: Array<{
    operationType: string | null;
    sku: string | null;
    vendorCode: string | null;
    quantity: number | null;
    salesAmount: unknown;
    totalAmount: unknown;
  }>;
  costs: ProductCostForDailyProfit[];
  wbProductCards: WbProductCardForDailyProfit[];
  ozonProducts: OzonProductForDailyProfit[];
  adSpend: number;
  usnRate: number;
  vatRate: number;
}) {
  const resolveCostPrice = createOzonCostResolver({
    costs: params.costs,
    wbProductCards: params.wbProductCards,
    ozonProducts: params.ozonProducts,
  });

  let revenue = 0;
  let sellerPayoutBeforeAds = 0;
  let totalCost = 0;

  for (const row of params.rows) {
    if (isOzonFinanceAdOperation(row.operationType)) {
      continue;
    }

    const salesAmount = toNumber(row.salesAmount);
    const totalAmount = toNumber(row.totalAmount);
    const quantity = Math.abs(toNumber(row.quantity));
    const costPrice = resolveCostPrice(row);

    revenue += salesAmount;
    sellerPayoutBeforeAds += totalAmount;

    if (salesAmount > 0 || quantity > 0) {
      totalCost += costPrice * quantity;
    }

    if (salesAmount < 0 || totalAmount < 0) {
      totalCost -= costPrice * quantity;
    }
  }

  const taxesAmount = calculateTaxesAmount({
    revenue,
    usnRate: params.usnRate,
    vatRate: params.vatRate,
  });

  return sellerPayoutBeforeAds - totalCost - params.adSpend - taxesAmount;
}


async function getFinanceMetricsForCompany(params: {
  companyName: string;
  range: DateRange;
}) {
  const [transactions, categories] = await Promise.all([
    prisma.financeTransaction.findMany({
      where: {
        companyName: params.companyName,
        operationDate: {
          gte: params.range.dateFrom,
          lt: params.range.dateToExclusive,
        },
      },
      select: {
        operationType: true,
        category: true,
        subcategory: true,
        amount: true,
        isInternalTransfer: true,
        transferDirection: true,
      },
    }),
    prisma.financeCategory.findMany({
      select: {
        name: true,
        categoryType: true,
        parentName: true,
        profitTreatment: true,
      },
    }),
  ]);

  const metrics = calculateFinanceMetricsForRows({
    transactions,
    categories,
  });

  return {
    cashIncome: metrics.cashIncome,
    cashOutflow: metrics.cashOutflow,
    netCashFlow: metrics.netCashFlow,
    netProfitImpact: metrics.netProfitImpact,
    ownerWithdrawals: metrics.ownerWithdrawals,
  };
}

async function getOrderStats(params: {
  companyName: string;
  marketplace: "WB" | "OZON";
  range: DateRange;
}) {
  const rows = await prisma.marketplaceDailyOrderStat.findMany({
    where: {
      companyName: params.companyName,
      marketplace: params.marketplace,
      orderDate: {
        gte: params.range.dateFrom,
        lt: params.range.dateToExclusive,
      },
    },
    select: {
      orderDate: true,
      ordersQty: true,
      ordersAmount: true,
    },
  });

  const loadedDateKeys = new Set<string>();

  return rows.reduce(
    (acc, row) => {
      acc.ordersQty += Number(row.ordersQty ?? 0);
      acc.ordersAmount += toNumber(row.ordersAmount);
      loadedDateKeys.add(getOrderDateKey(row.orderDate));
      acc.loadedDays = loadedDateKeys.size;
      return acc;
    },
    {
      ordersQty: 0,
      ordersAmount: 0,
      rowsCount: rows.length,
      loadedDays: 0,
      expectedDays: getExpectedOrderDays(params.range),
    }
  );
}

function calculateDrr(adSpend: number, salesAmount: number) {
  if (salesAmount <= 0) return 0;
  return (adSpend / salesAmount) * 100;
}


function getMoscowDateKey(date: Date | null | undefined) {
  if (!date) return "unknown";

  return new Date(date.getTime() + 3 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function isWbDailyStatisticsSaleRow(row: {
  reportNumber: string | null;
}) {
  return String(row.reportNumber ?? "").startsWith("WB_DAILY_STATISTICS_");
}

function selectPreferredWbSaleRows<
  T extends {
    reportNumber: string | null;
    saleDate: Date | null;
  },
>(rows: T[]) {
  const rowsByDay = new Map<string, T[]>();

  for (const row of rows) {
    const key = getMoscowDateKey(row.saleDate);
    const current = rowsByDay.get(key) ?? [];

    current.push(row);
    rowsByDay.set(key, current);
  }

  const preferredRows: T[] = [];

  for (const dayRows of rowsByDay.values()) {
    const finalRows = dayRows.filter((row) => !isWbDailyStatisticsSaleRow(row));
    const dailyRows = dayRows.filter((row) => isWbDailyStatisticsSaleRow(row));

    // Если за день уже есть финальный недельный WB Sales — используем его.
    // Иначе используем оперативный daily sales, чтобы не было пустоты в утреннем отчёте.
    preferredRows.push(...(finalRows.length > 0 ? finalRows : dailyRows));
  }

  return preferredRows;
}

async function getWbMetrics(companyName: string, range: DateRange) {
  const [orderStats, salesRows, adsRowsRaw, stockQty, costs, companySettings] =
    await Promise.all([
      getOrderStats({
        companyName,
        marketplace: "WB",
        range,
      }),
      prisma.wbSale.findMany({
        where: {
          companyName,
          saleDate: {
            gte: range.dateFrom,
            lt: range.dateToExclusive,
          },
        },
        select: {
          reportNumber: true,
          saleDate: true,
          paymentReason: true,
          quantity: true,
          wbRealizedAmount: true,
          sellerPayout: true,
          vendorCode: true,
        },
      }),
      prisma.wbAds.findMany({
        where: {
          companyName,
          OR: [
            {
              dateFrom: {
                gte: range.dateFrom,
                lt: range.dateToExclusive,
              },
            },
            {
              dateTo: {
                gte: range.dateFrom,
                lt: range.dateToExclusive,
              },
            },
            {
              AND: [
                {
                  dateFrom: {
                    lte: range.dateFrom,
                  },
                },
                {
                  dateTo: {
                    gte: range.dateToExclusive,
                  },
                },
              ],
            },
          ],
        },
        select: {
          dateFrom: true,
          dateTo: true,
          spend: true,
          importSessionId: true,
          createdAt: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      getLatestWbStockQty(companyName),
      prisma.productCost.findMany({
        select: {
          vendorCode: true,
          nmId: true,
          costPrice: true,
        },
        orderBy: {
          costDate: "desc",
        },
      }),
      prisma.company.findFirst({
        where: {
          name: companyName,
        },
        select: {
          usnRate: true,
          vatRate: true,
        },
      }),
    ]);

  const effectiveSalesRows = selectPreferredWbSaleRows(salesRows);

  let salesQty = 0;
  let salesAmount = 0;

  for (const row of effectiveSalesRows) {
    const qty = Math.abs(Number(row.quantity ?? 0)) || 1;
    const amount = Math.abs(toNumber(row.wbRealizedAmount));

    if (isWbSaleOperation(row.paymentReason)) {
      salesQty += qty;
      salesAmount += amount;
      continue;
    }

    if (isWbReturnOperation(row.paymentReason)) {
      salesQty -= qty;
      salesAmount -= amount;
    }
  }

  const ordersDataMissing = orderStats.rowsCount === 0;
  const ordersDataIncomplete =
    !ordersDataMissing && orderStats.loadedDays < orderStats.expectedDays;
  const ordersDataMissingReason = ordersDataMissing
    ? "WB заказы за этот период ещё не загружены в MarketplaceDailyOrderStat"
    : ordersDataIncomplete
      ? `WB заказы загружены частично: ${orderStats.loadedDays} из ${orderStats.expectedDays} дней`
      : null;

  const salesDataMissing =
    effectiveSalesRows.length === 0 && orderStats.ordersQty > 0;
  const salesDataMissingReason = salesDataMissing
    ? "WB Sales/выкупы за этот период ещё не загружены в WbSale"
    : null;

  const adsRows = keepLatestWbAdsRowsPerDate(adsRowsRaw);
  const adSpend = adsRows.reduce((sum, row) => sum + toNumber(row.spend), 0);
  const taxRates = getCompanyTaxRates(companySettings);
  const netProfitAfterTax = calculateWbNetProfitAfterTax({
    rows: effectiveSalesRows,
    costs,
    adSpend,
    usnRate: taxRates.usnRate,
    vatRate: taxRates.vatRate,
  });

  return {
    marketplace: "WB" as const,
    ordersQty: orderStats.ordersQty,
    ordersAmount: orderStats.ordersAmount,
    orderDataLoadedDays: orderStats.loadedDays,
    orderDataExpectedDays: orderStats.expectedDays,
    ordersDataMissing,
    ordersDataIncomplete,
    ordersDataMissingReason,
    salesQty,
    salesAmount,
    salesLabel: "Продажи/выкупы",
    salesQtyIsReliable: !salesDataMissing,
    salesDataMissing,
    salesDataMissingReason,
    adSpend,
    adSpendSource: "WB Ads",
    adDataMissing: false,
    adDataMissingReason: null,
    drrByOrders: ordersDataMissing ? 0 : calculateDrr(adSpend, orderStats.ordersAmount),
    drrBySales: salesDataMissing ? 0 : calculateDrr(adSpend, salesAmount),
    stockQty,
    netProfitAfterTax,
  };
}

async function getOzonMetrics(companyName: string, range: DateRange) {
  const [
    orderStats,
    financeRows,
    adsRowsRaw,
    stockQty,
    costs,
    wbProductCards,
    ozonProducts,
    companySettings,
  ] = await Promise.all([
    getOrderStats({
      companyName,
      marketplace: "OZON",
      range,
    }),
    prisma.ozonFinance.findMany({
      where: {
        companyName,
        accrualDate: {
          gte: range.dateFrom,
          lt: range.dateToExclusive,
        },
      },
      select: {
        operationType: true,
        quantity: true,
        salesAmount: true,
        totalAmount: true,
        sku: true,
        vendorCode: true,
      },
    }),
    prisma.ozonAds.findMany({
      where: {
        companyName,
        reportDate: {
          gte: range.dateFrom,
          lt: range.dateToExclusive,
        },
      },
      select: {
        reportDate: true,
        orders: true,
        spend: true,
        importSessionId: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    }),
    getLatestOzonStockQty(companyName),
    prisma.productCost.findMany({
      select: {
        vendorCode: true,
        nmId: true,
        costPrice: true,
      },
      orderBy: {
        costDate: "desc",
      },
    }),
    prisma.wbProductCard.findMany({
      where: {
        companyName,
      },
      select: {
        nmId: true,
        vendorCode: true,
      },
      orderBy: {
        lastSyncedAt: "desc",
      },
    }),
    prisma.ozonProduct.findMany({
      where: {
        companyName,
      },
      select: {
        sku: true,
        vendorCode: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    }),
    prisma.company.findFirst({
      where: {
        name: companyName,
      },
      select: {
        usnRate: true,
        vatRate: true,
      },
    }),
  ]);

  let salesQty = 0;
  let salesAmount = 0;

  for (const row of financeRows) {
    if (isOzonFinanceAdOperation(row.operationType)) {
      continue;
    }

    const amount = toNumber(row.salesAmount);
    const qty = Math.abs(Number(row.quantity ?? 0));

    if (amount === 0 && qty === 0) continue;

    salesAmount += amount;
    salesQty += qty;
  }

  const adsRows = keepLatestOzonAdsRowsPerDate(adsRowsRaw);
  const performanceAdSpend = adsRows.reduce(
    (sum, row) => sum + toNumber(row.spend),
    0
  );
  const financeAdSpend = calculateOzonFinanceAdSpend(financeRows);
  const financeAdRowsCount = financeRows.filter((row) =>
    isOzonFinanceAdOperation(row.operationType)
  ).length;
  const performanceAdRowsCount = adsRows.length;

  // Для управленческого отчёта берём фактические рекламные списания из Ozon Finance,
  // если они есть. Performance API оставляем как fallback, чтобы не задвоить CPC/CPO.
  const adSpend =
    financeAdRowsCount > 0 ? financeAdSpend : performanceAdSpend;
  const adSpendSource =
    financeAdRowsCount > 0 ? "Ozon Finance Ads" : "Ozon Performance Ads";

  const taxRates = getCompanyTaxRates(companySettings);
  const netProfitAfterTax = calculateOzonNetProfitAfterTax({
    rows: financeRows,
    costs,
    wbProductCards,
    ozonProducts,
    adSpend,
    usnRate: taxRates.usnRate,
    vatRate: taxRates.vatRate,
  });

  const ordersDataMissing = orderStats.rowsCount === 0;
  const ordersDataIncomplete =
    !ordersDataMissing && orderStats.loadedDays < orderStats.expectedDays;
  const ordersDataMissingReason = ordersDataMissing
    ? "Ozon заказы за этот период ещё не загружены в MarketplaceDailyOrderStat"
    : ordersDataIncomplete
      ? `Ozon заказы загружены частично: ${orderStats.loadedDays} из ${orderStats.expectedDays} дней`
      : null;

  const hasOzonActivity = orderStats.rowsCount > 0 || salesAmount > 0;
  const adDataMissing =
    hasOzonActivity && financeAdRowsCount === 0 && performanceAdRowsCount === 0;
  const adDataMissingReason = adDataMissing
    ? "Ozon рекламные расходы за этот период ещё не загружены из Ozon Finance/Performance"
    : null;

  return {
    marketplace: "OZON" as const,
    ordersQty: orderStats.ordersQty,
    ordersAmount: orderStats.ordersAmount,
    orderDataLoadedDays: orderStats.loadedDays,
    orderDataExpectedDays: orderStats.expectedDays,
    ordersDataMissing,
    ordersDataIncomplete,
    ordersDataMissingReason,
    salesQty: 0,
    salesAmount,
    salesLabel: "Начисления",
    salesQtyIsReliable: false,
    salesDataMissing: false,
    salesDataMissingReason: null,
    adSpend,
    adSpendSource,
    adDataMissing,
    adDataMissingReason,
    drrByOrders: ordersDataMissing ? 0 : calculateDrr(adSpend, orderStats.ordersAmount),
    drrBySales: calculateDrr(adSpend, salesAmount),
    stockQty,
    netProfitAfterTax,
  };
}

function addMarketplaceTotals(
  target: DailyReport["totals"],
  source: MarketplaceDailyMetrics
) {
  target.ordersQty += source.ordersQty;
  target.ordersAmount += source.ordersAmount;
  target.orderDataLoadedDays += source.orderDataLoadedDays;
  target.orderDataExpectedDays += source.orderDataExpectedDays;
  target.salesQty += source.salesQty;
  target.salesAmount += source.salesAmount;
  target.adSpend += source.adSpend;
  target.stockQty += source.stockQty;
}

function buildWarnings(report: DailyReport) {
  const warnings: string[] = [];

  if (report.totals.ordersQty <= 0 && report.totals.ordersAmount <= 0) {
    warnings.push("нет заказов за период");
  }

  if (hasIncompleteOrderData(report)) {
    warnings.push(
      `заказы загружены не за весь выбранный период: ${report.totals.orderDataLoadedDays} из ${report.totals.orderDataExpectedDays} дневных срезов. ДРР от заказов может быть завышен`
    );
  }

  if (report.totals.salesQty <= 0 && report.totals.salesAmount <= 0) {
    warnings.push("нет продаж/начислений за период");
  }

  if (report.totals.drrByOrders > 20) {
    warnings.push(
      `ДРР от заказов выше 20%: ${formatPercent(report.totals.drrByOrders)}`
    );
  }

  if (report.totals.netCashFlow < 0) {
    warnings.push(`отрицательный ДДС: ${formatMoney(report.totals.netCashFlow)}`);
  }

  if (report.totals.netProfitImpact < 0) {
    warnings.push(
      `отрицательная чистая прибыль: ${formatMoney(
        report.totals.netProfitImpact
      )}`
    );
  }

  for (const company of report.companies) {
    if (company.wb.ordersDataMissing) {
      warnings.push(`${company.companyName} WB: заказы ещё не загружены`);
    } else if (company.wb.ordersDataIncomplete) {
      warnings.push(
        `${company.companyName} WB: заказы загружены частично (${company.wb.orderDataLoadedDays} из ${company.wb.orderDataExpectedDays} дней)`
      );
    }

    if (company.ozon.ordersDataMissing) {
      warnings.push(`${company.companyName} Ozon: заказы ещё не загружены`);
    } else if (company.ozon.ordersDataIncomplete) {
      warnings.push(
        `${company.companyName} Ozon: заказы загружены частично (${company.ozon.orderDataLoadedDays} из ${company.ozon.orderDataExpectedDays} дней)`
      );
    }

    if (company.wb.adDataMissing) {
      warnings.push(`${company.companyName} WB: реклама ещё не загружена`);
    }

    if (company.ozon.adDataMissing) {
      warnings.push(`${company.companyName} Ozon: реклама ещё не загружена`);
    }

    if (company.wb.salesDataMissing) {
      warnings.push(
        `${company.companyName} WB: продажи/выкупы ещё не загружены`
      );
    }

    if (company.ozon.salesDataMissing) {
      warnings.push(
        `${company.companyName} Ozon: продажи/начисления ещё не загружены`
      );
    }
  }

  if (report.totals.stockQty <= 0) {
    warnings.push("не вижу остатков по последним загруженным отчётам");
  }

  return warnings;
}

export async function buildDailyReport(params?: {
  preset?: DailyReportPeriodPreset;
  date?: string;
  from?: string;
  to?: string;
  debug?: boolean;
}): Promise<DailyReport> {
  const range = getDailyReportRange(params);

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

  const report: DailyReport = {
    dateLabel: range.dateLabel,
    periodLabel: range.periodLabel,
    companies: [],
    totals: {
      ordersQty: 0,
      ordersAmount: 0,
      orderDataLoadedDays: 0,
      orderDataExpectedDays: 0,
      salesQty: 0,
      salesAmount: 0,
      adSpend: 0,
      drrByOrders: 0,
      drrBySales: 0,
      stockQty: 0,
      cashIncome: 0,
      cashOutflow: 0,
      netCashFlow: 0,
      netProfitImpact: 0,
      ownerWithdrawals: 0,
    },
    warnings: [],
  };

  const companyReports = await Promise.all(
    companies.map(async (company) => {
      const timedDailyMetric = async <T,>(
        label: string,
        task: () => Promise<T>
      ) => {
        const startedAt = Date.now();
        const result = await task();

        if (params?.debug) {
          console.log(
            `[daily-report-perf] ${range.periodLabel} company ${company.name} ${label}: ${
              Date.now() - startedAt
            }ms`
          );
        }

        return result;
      };

      const [wb, ozon, finance] = await Promise.all([
        timedDailyMetric("wb", () => getWbMetrics(company.name, range)),
        timedDailyMetric("ozon", () => getOzonMetrics(company.name, range)),
        timedDailyMetric("finance", () =>
          getFinanceMetricsForCompany({
            companyName: company.name,
            range,
          })
        ),
      ]);

      const realNetProfit =
        wb.netProfitAfterTax + ozon.netProfitAfterTax + finance.netProfitImpact;

      const financeForReport = {
        ...finance,
        netProfitImpact: realNetProfit,
      };

      return {
        companyName: company.name,
        wb,
        ozon,
        finance,
        financeForReport,
        realNetProfit,
      };
    })
  );

  for (const companyReport of companyReports) {
    report.companies.push({
      companyName: companyReport.companyName,
      wb: companyReport.wb,
      ozon: companyReport.ozon,
      finance: companyReport.financeForReport,
    });

    addMarketplaceTotals(report.totals, companyReport.wb);
    addMarketplaceTotals(report.totals, companyReport.ozon);

    report.totals.cashIncome += companyReport.finance.cashIncome;
    report.totals.cashOutflow += companyReport.finance.cashOutflow;
    report.totals.netCashFlow += companyReport.finance.netCashFlow;
    report.totals.netProfitImpact += companyReport.realNetProfit;
    report.totals.ownerWithdrawals += companyReport.finance.ownerWithdrawals;
  }

  report.totals.drrByOrders = calculateDrr(
    report.totals.adSpend,
    report.totals.ordersAmount
  );
  report.totals.drrBySales = calculateDrr(
    report.totals.adSpend,
    report.totals.salesAmount
  );

  report.warnings = buildWarnings(report);

  return report;
}

export function formatMoney(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatPercent(value: number) {
  return `${new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 1,
  }).format(value)}%`;
}

function marketplaceSalesLine(metrics: MarketplaceDailyMetrics) {
  if (metrics.salesDataMissing) {
    return `${metrics.salesLabel}: данные ещё не загружены`;
  }

  if (metrics.salesQtyIsReliable) {
    return `${metrics.salesLabel}: ${formatNumber(metrics.salesQty)} шт / ${formatMoney(
      metrics.salesAmount
    )}`;
  }

  return `${metrics.salesLabel}: ${formatMoney(metrics.salesAmount)}`;
}

function marketplaceOrdersLine(metrics: MarketplaceDailyMetrics) {
  if (metrics.ordersDataMissing) {
    return "Заказы: данные ещё не загружены";
  }

  const coverageText = metrics.ordersDataIncomplete
    ? ` · частично: ${formatNumber(metrics.orderDataLoadedDays)} из ${formatNumber(
        metrics.orderDataExpectedDays
      )} дней`
    : "";

  return `Заказы: ${formatNumber(metrics.ordersQty)} шт / ${formatMoney(
    metrics.ordersAmount
  )}${coverageText}`;
}

function marketplaceAdLine(metrics: MarketplaceDailyMetrics) {
  if (metrics.adDataMissing) {
    return "Реклама: данные ещё не загружены";
  }

  return `Реклама: ${formatMoney(metrics.adSpend)}`;
}

type MarketplaceConclusionItem = {
  label: string;
  drrByOrders: number;
  drrBySales: number;
  ordersAmount: number;
  salesAmount: number;
  adSpend: number;
  ordersDataIncomplete: boolean;
};

function getMarketplaceConclusionItems(report: DailyReport) {
  const items: MarketplaceConclusionItem[] = [];

  for (const company of report.companies) {
    items.push({
      label: `${company.companyName} WB`,
      drrByOrders: company.wb.drrByOrders,
      drrBySales: company.wb.drrBySales,
      ordersAmount: company.wb.ordersAmount,
      salesAmount: company.wb.salesAmount,
      adSpend: company.wb.adSpend,
      ordersDataIncomplete: company.wb.ordersDataIncomplete,
    });

    items.push({
      label: `${company.companyName} Ozon`,
      drrByOrders: company.ozon.drrByOrders,
      drrBySales: company.ozon.drrBySales,
      ordersAmount: company.ozon.ordersAmount,
      salesAmount: company.ozon.salesAmount,
      adSpend: company.ozon.adSpend,
      ordersDataIncomplete: company.ozon.ordersDataIncomplete,
    });
  }

  return items;
}

function getHighestDrrItem(report: DailyReport) {
  const items = getMarketplaceConclusionItems(report).filter(
    (item) =>
      item.ordersAmount > 0 && item.adSpend > 0 && !item.ordersDataIncomplete
  );

  if (items.length === 0) return null;

  return items.sort((a, b) => b.drrByOrders - a.drrByOrders)[0];
}

function getDrrConclusion(report: DailyReport) {
  const totalDrr = report.totals.drrByOrders;

  if (report.totals.ordersAmount <= 0 || report.totals.adSpend <= 0) {
    return "Реклама: нет достаточно данных для оценки ДРР.";
  }

  if (hasIncompleteOrderData(report)) {
    return `Заказы загружены частично, поэтому ДРР от заказов сейчас ориентировочный. Основной контроль пока по ДРР от продаж/начислений: ${formatPercent(
      report.totals.drrBySales
    )}.`;
  }

  if (totalDrr <= 7) {
    return `Реклама в рабочей зоне: ДРР ${formatPercent(
      totalDrr
    )} от заказов.`;
  }

  if (totalDrr <= 10) {
    return `Реклама требует контроля: ДРР ${formatPercent(
      totalDrr
    )} от заказов.`;
  }

  return `Реклама перегрета: ДРР ${formatPercent(
    totalDrr
  )} от заказов, нужно проверить кампании.`;
}

function getCashFlowConclusion(report: DailyReport) {
  if (report.totals.netCashFlow < 0) {
    return `Денежный поток отрицательный: ${formatMoney(
      report.totals.netCashFlow
    )}. Деньги из бизнеса уходят быстрее, чем заходят.`;
  }

  if (report.totals.netCashFlow > 0) {
    return `Денежный поток положительный: ${formatMoney(
      report.totals.netCashFlow
    )}. По кассе день прошёл устойчиво.`;
  }

  return "Денежный поток около нуля: касса без запаса прочности.";
}

function getProfitConclusion(report: DailyReport) {
  if (report.totals.netProfitImpact < 0) {
    return `Прибыль под давлением: ${formatMoney(
      report.totals.netProfitImpact
    )}. Нужно смотреть расходы и выводы.`;
  }

  if (report.totals.netProfitImpact > 0) {
    return `Чистая прибыль за день положительная: ${formatMoney(
      report.totals.netProfitImpact
    )}.`;
  }

  return "Чистая прибыль около нуля.";
}

function buildOwnerConclusion(report: DailyReport) {
  const lines: string[] = ["Вывод дня:"];

  lines.push(
    `Оборот заказов: ${formatMoney(report.totals.ordersAmount)} при остатках ${formatNumber(
      report.totals.stockQty
    )} шт.`
  );

  lines.push(getDrrConclusion(report));
  lines.push(getCashFlowConclusion(report));
  lines.push(getProfitConclusion(report));

  if (report.totals.ownerWithdrawals > 0 && report.totals.netCashFlow < 0) {
    lines.push(
      `Вывод собственника ${formatMoney(
        report.totals.ownerWithdrawals
      )} усилил кассовый разрыв в этот день.`
    );
  }

  const highestDrrItem = getHighestDrrItem(report);

  if (highestDrrItem && highestDrrItem.drrByOrders >= 10) {
    lines.push(
      `Самая дорогая связка по рекламе: ${
        highestDrrItem.label
      } — ДРР ${formatPercent(highestDrrItem.drrByOrders)} от заказов.`
    );
  }

  return lines;
}

function getHighDrrAction(report: DailyReport) {
  const highestDrrItem = getHighestDrrItem(report);

  if (!highestDrrItem || highestDrrItem.drrByOrders < 10) {
    return null;
  }

  if (highestDrrItem.ordersAmount < 50000) {
    return `Проверить ${highestDrrItem.label}: ДРР высокий, но объём заказов маленький — не масштабировать рекламу без проверки товаров и ставок.`;
  }

  return `Проверить ${highestDrrItem.label}: ДРР ${formatPercent(
    highestDrrItem.drrByOrders
  )} от заказов — найти кампании/товары, которые съедают бюджет.`;
}

function getSalesGapAction(report: DailyReport) {
  if (report.totals.ordersAmount <= 0 || hasIncompleteOrderData(report)) return null;

  const salesToOrdersRatio =
    (report.totals.salesAmount / report.totals.ordersAmount) * 100;

  if (salesToOrdersRatio < 55) {
    return `Проверить разрыв заказов и продаж/начислений: сейчас продажи/начисления ≈ ${formatPercent(
      salesToOrdersRatio
    )} от суммы заказов. Для одного дня это может быть нормальной задержкой, но тренд нужно смотреть за 3–7 дней.`;
  }

  return null;
}

function buildOwnerActions(report: DailyReport) {
  const actions: string[] = [];

  if (hasIncompleteOrderData(report)) {
    actions.push(
      "Не делать окончательные выводы по ДРР от заказов, пока заказы не накопятся за весь период. Сейчас главный ориентир — ДРР от продаж/начислений."
    );
  }

  if (report.totals.netCashFlow < 0) {
    actions.push(
      "Проверить крупные расходы дня и отделить обязательные платежи от тех, что можно перенести."
    );
  }

  if (report.totals.ownerWithdrawals > 0 && report.totals.netCashFlow < 0) {
    actions.push(
      "На дни с минусовым ДДС не увеличивать вывод собственника без проверки ближайших платежей."
    );
  }

  const highDrrAction = getHighDrrAction(report);

  if (highDrrAction) {
    actions.push(highDrrAction);
  }

  const salesGapAction = getSalesGapAction(report);

  if (salesGapAction) {
    actions.push(salesGapAction);
  }

  if (report.totals.stockQty > 0) {
    actions.push(
      `Остатки ${formatNumber(
        report.totals.stockQty
      )} шт: следующим шагом смотреть не общий остаток, а SKU с большим запасом и слабым спросом.`
    );
  }

  return ["Что сделать сегодня:", ...actions.slice(0, 4).map((action, index) => `${index + 1}. ${action}`)];
}

function marketplaceLine(label: string, metrics: MarketplaceDailyMetrics) {
  const lines = [`${label}`, marketplaceOrdersLine(metrics), marketplaceSalesLine(metrics)];

  if (metrics.ordersDataMissingReason) {
    lines.push(`Источник заказов: ${metrics.ordersDataMissingReason}`);
  }

  if (metrics.salesDataMissingReason) {
    lines.push(`Источник продаж: ${metrics.salesDataMissingReason}`);
  }

  if (metrics.adDataMissingReason) {
    lines.push(`Источник рекламы: ${metrics.adDataMissingReason}`);
  }

  lines.push(
    marketplaceAdLine(metrics),
    `ДРР: от заказов ${formatPercent(metrics.drrByOrders)} (от продаж/начислений ${formatPercent(
      metrics.drrBySales
    )})`,
    `Остатки: ${formatNumber(metrics.stockQty)} шт`
  );

  return lines.join("\n");
}

export function formatDailyReportForTelegram(report: DailyReport) {
  const lines: string[] = [
    `📊 AvoroFin — сводка собственника`,
    `Период: ${report.periodLabel}`,
    `Даты: ${report.dateLabel}`,
    "",
    "ИТОГО ПО БИЗНЕСУ",
    `Заказы: ${formatNumber(report.totals.ordersQty)} шт / ${formatMoney(
      report.totals.ordersAmount
    )}`,
    `Продажи/начисления: ${formatMoney(report.totals.salesAmount)}`,
    `Реклама: ${formatMoney(report.totals.adSpend)}`,
    `ДРР: от заказов ${formatPercent(
      report.totals.drrByOrders
    )} (от продаж/начислений ${formatPercent(report.totals.drrBySales)})`,
    `ДДС: ${formatMoney(report.totals.netCashFlow)}`,
    `Чистая прибыль: ${formatMoney(report.totals.netProfitImpact)}`,
    `Вывод собственника: ${formatMoney(report.totals.ownerWithdrawals)}`,
    `Остатки: ${formatNumber(report.totals.stockQty)} шт`,
  ];

  if (report.warnings.length > 0) {
    lines.push("", "Что требует внимания:");
    lines.push(...report.warnings.map((warning) => `⚠️ ${warning}`));
  }

  lines.push("", ...buildOwnerConclusion(report));
  lines.push("", ...buildOwnerActions(report));

  for (const company of report.companies) {
    lines.push(
      "",
      `━━━━━━━━━━━━━━`,
      `${company.companyName}`,
      "",
      marketplaceLine("WB", company.wb),
      "",
      marketplaceLine("Ozon", company.ozon),
      "",
      `Финансы:`,
      `ДДС: ${formatMoney(company.finance.netCashFlow)}`,
      `Чистая прибыль: ${formatMoney(company.finance.netProfitImpact)}`,
      `Вывод собственника: ${formatMoney(company.finance.ownerWithdrawals)}`
    );
  }

  return lines.join("\n");
}
