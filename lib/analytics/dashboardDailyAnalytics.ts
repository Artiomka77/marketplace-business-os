import { prisma } from "@/lib/prisma";
import { calculateFinanceMetricsForRows } from "@/lib/finance/financeMetrics";

export type DashboardDailyPoint = {
  date: string;
  wbRevenue: number;
  ozonRevenue: number;
  revenue: number;
  adsCost: number;
  drr: number | null;
  operatingProfitAfterTax: number;
  netProfit: number;
  cashFlowResult: number;
  loanPayments: number;
  creditPrincipal: number;
  creditInterest: number;
};

type InternalDailyPoint = DashboardDailyPoint & {
  marketplaceProfitBeforeTax: number;
  taxesAmount: number;
  financeNetProfitIncome: number;
  financeNetProfitExpense: number;
};

type CompanyTaxSettings = {
  usnRate: number;
  vatRate: number;
};

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;

  if (typeof value === "object" && "toNumber" in value) {
    return (value as { toNumber: () => number }).toNumber();
  }

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function startOfDay(value: string | Date) {
  const date = typeof value === "string" ? new Date(`${value}T00:00:00`) : new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function nextDayStart(value: string | Date) {
  const date = startOfDay(value);
  date.setDate(date.getDate() + 1);
  return date;
}

function toIsoDate(value: string | Date) {
  return startOfDay(value).toISOString().slice(0, 10);
}

function addDays(value: Date, days: number) {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

function inclusiveIsoDates(dateFrom: string, dateTo: string) {
  const start = startOfDay(dateFrom);
  const end = startOfDay(dateTo);
  const dates: string[] = [];

  for (let cursor = start; cursor.getTime() <= end.getTime(); cursor = addDays(cursor, 1)) {
    dates.push(toIsoDate(cursor));
  }

  return dates;
}

function createEmptyPoint(date: string): InternalDailyPoint {
  return {
    date,
    wbRevenue: 0,
    ozonRevenue: 0,
    revenue: 0,
    adsCost: 0,
    drr: null,
    operatingProfitAfterTax: 0,
    netProfit: 0,
    cashFlowResult: 0,
    loanPayments: 0,
    creditPrincipal: 0,
    creditInterest: 0,
    marketplaceProfitBeforeTax: 0,
    taxesAmount: 0,
    financeNetProfitIncome: 0,
    financeNetProfitExpense: 0,
  };
}

function calculateVatTax(revenue: number, vatRate: number) {
  if (revenue <= 0 || vatRate <= 0) return 0;
  return revenue * (vatRate / (100 + vatRate));
}

function getCompanyTaxes(
  companyName: string | null | undefined,
  taxByCompany: Map<string, CompanyTaxSettings>
) {
  return taxByCompany.get(cleanText(companyName)) ?? { usnRate: 1, vatRate: 5 };
}

function addTaxForRevenue(
  point: InternalDailyPoint,
  revenue: number,
  companyName: string | null | undefined,
  taxByCompany: Map<string, CompanyTaxSettings>
) {
  if (revenue <= 0) return;

  const settings = getCompanyTaxes(companyName, taxByCompany);
  point.taxesAmount += revenue * (settings.usnRate / 100) + calculateVatTax(revenue, settings.vatRate);
}

function buildCostByVendorCode(
  costs: Array<{ vendorCode: string; costPrice: unknown }>
) {
  const costByVendorCode = new Map<string, number>();

  for (const cost of costs) {
    const vendorCode = normalizeText(cost.vendorCode);
    if (!vendorCode) continue;

    if (!costByVendorCode.has(vendorCode)) {
      costByVendorCode.set(vendorCode, toNumber(cost.costPrice));
    }
  }

  return costByVendorCode;
}

function isWbSaleOperation(reason: string | null) {
  const value = normalizeText(reason);
  return value === "продажа" || value === "сторно возвратов";
}

function isWbReturnOperation(reason: string | null) {
  return normalizeText(reason) === "возврат";
}

function getDateSpan(dateFrom: Date | null, dateTo: Date | null) {
  if (!dateFrom && !dateTo) return [];

  const from = startOfDay(dateFrom ?? dateTo ?? new Date());
  const to = startOfDay(dateTo ?? dateFrom ?? new Date());
  const dates: string[] = [];

  for (let cursor = from; cursor.getTime() <= to.getTime(); cursor = addDays(cursor, 1)) {
    dates.push(toIsoDate(cursor));
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
    const date = toIsoDate(row.reportDate);

    if (!latestSessionByDate.has(date)) {
      latestSessionByDate.set(date, row.importSessionId ?? null);
    }
  }

  return rows.filter((row) => {
    if (!row.reportDate) return false;
    const date = toIsoDate(row.reportDate);

    return latestSessionByDate.get(date) === (row.importSessionId ?? null);
  });
}

async function getTaxByCompany() {
  const companies = await prisma.company.findMany({
    select: {
      name: true,
      usnRate: true,
      vatRate: true,
    },
  });

  return new Map(
    companies.map((company) => [
      cleanText(company.name),
      {
        usnRate: toNumber(company.usnRate) || 1,
        vatRate: toNumber(company.vatRate) || 5,
      },
    ])
  );
}

async function getOzonVendorCodeBySku() {
  const products = await prisma.ozonProduct.findMany({
    select: {
      sku: true,
      vendorCode: true,
    },
  });

  const vendorCodeBySku = new Map<string, string>();

  for (const product of products) {
    const sku = normalizeText(product.sku);
    const vendorCode = normalizeText(product.vendorCode);

    if (!sku || !vendorCode) continue;
    if (!vendorCodeBySku.has(sku)) vendorCodeBySku.set(sku, vendorCode);
  }

  return vendorCodeBySku;
}

function pointValues(pointsByDate: Map<string, InternalDailyPoint>) {
  for (const point of pointsByDate.values()) {
    point.revenue = point.wbRevenue + point.ozonRevenue;
    point.drr = point.revenue > 0 ? (point.adsCost / point.revenue) * 100 : null;
    point.operatingProfitAfterTax =
      point.marketplaceProfitBeforeTax - point.adsCost - point.taxesAmount;
    point.netProfit =
      point.operatingProfitAfterTax +
      point.financeNetProfitIncome -
      point.financeNetProfitExpense;
  }
}

export async function getDashboardDailyAnalytics(params: {
  dateFrom: string;
  dateTo: string;
  companyName?: string | null;
}): Promise<DashboardDailyPoint[]> {
  const companyName =
    params.companyName && params.companyName !== "ALL" ? params.companyName : null;
  const from = startOfDay(params.dateFrom);
  const toExclusive = nextDayStart(params.dateTo);
  const dateKeys = inclusiveIsoDates(params.dateFrom, params.dateTo);
  const pointsByDate = new Map<string, InternalDailyPoint>(
    dateKeys.map((date) => [date, createEmptyPoint(date)])
  );

  const [costs, taxByCompany, ozonVendorCodeBySku] = await Promise.all([
    prisma.productCost.findMany({
      select: {
        vendorCode: true,
        costPrice: true,
      },
      orderBy: {
        costDate: "desc",
      },
    }),
    getTaxByCompany(),
    getOzonVendorCodeBySku(),
  ]);

  const costByVendorCode = buildCostByVendorCode(costs);

  const [wbSales, wbAdsRaw, ozonFinance, ozonAdsRaw, financeTransactions, financeCategories] =
    await Promise.all([
      prisma.wbSale.findMany({
        where: {
          saleDate: {
            gte: from,
            lt: toExclusive,
          },
          ...(companyName ? { companyName } : {}),
        },
        select: {
          saleDate: true,
          companyName: true,
          vendorCode: true,
          paymentReason: true,
          quantity: true,
          wbRealizedAmount: true,
          sellerPayout: true,
          wbReward: true,
          logisticsCost: true,
          storageCost: true,
          acceptanceCost: true,
          penaltiesAmount: true,
          deductions: true,
          paymentServiceCost: true,
        },
      }),
      prisma.wbAds.findMany({
        where: {
          OR: [
            {
              dateFrom: {
                gte: from,
                lt: toExclusive,
              },
            },
            {
              dateTo: {
                gte: from,
                lt: toExclusive,
              },
            },
          ],
          ...(companyName ? { companyName } : {}),
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
      prisma.ozonFinance.findMany({
        where: {
          accrualDate: {
            gte: from,
            lt: toExclusive,
          },
          ...(companyName ? { companyName } : {}),
        },
        select: {
          accrualDate: true,
          companyName: true,
          sku: true,
          vendorCode: true,
          quantity: true,
          salesAmount: true,
          totalAmount: true,
          ozonCommission: true,
          logisticsCost: true,
          reverseLogisticsCost: true,
        },
      }),
      prisma.ozonAds.findMany({
        where: {
          reportDate: {
            gte: from,
            lt: toExclusive,
          },
          ...(companyName ? { companyName } : {}),
        },
        select: {
          reportDate: true,
          spend: true,
          importSessionId: true,
          createdAt: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      prisma.financeTransaction.findMany({
        where: {
          operationDate: {
            gte: from,
            lt: toExclusive,
          },
          ...(companyName ? { companyName } : {}),
        },
        select: {
          operationDate: true,
          operationType: true,
          category: true,
          amount: true,
          subcategory: true,
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

  for (const row of wbSales) {
    if (!row.saleDate) continue;
    const date = toIsoDate(row.saleDate);
    const point = pointsByDate.get(date);
    if (!point) continue;

    const quantity = Math.abs(toNumber(row.quantity));
    const vendorCode = normalizeText(row.vendorCode);
    const costPrice = vendorCode ? costByVendorCode.get(vendorCode) ?? 0 : 0;
    const rowCost = costPrice * quantity;
    const realizedAmount = toNumber(row.wbRealizedAmount);
    const isSale = isWbSaleOperation(row.paymentReason);
    const isReturn = isWbReturnOperation(row.paymentReason);

    let revenueDelta = 0;
    let costDelta = 0;

    if (isSale) {
      revenueDelta = realizedAmount;
      costDelta = rowCost;
    }

    if (isReturn) {
      revenueDelta = -realizedAmount;
      costDelta = -rowCost;
    }

    const marketplaceExpenses =
      Math.abs(toNumber(row.wbReward)) +
      Math.abs(toNumber(row.logisticsCost)) +
      Math.abs(toNumber(row.storageCost)) +
      Math.abs(toNumber(row.acceptanceCost)) +
      toNumber(row.penaltiesAmount) +
      toNumber(row.deductions) +
      Math.abs(toNumber(row.paymentServiceCost));

    point.wbRevenue += revenueDelta;
    point.marketplaceProfitBeforeTax += revenueDelta - costDelta - marketplaceExpenses;
    addTaxForRevenue(point, revenueDelta, row.companyName, taxByCompany);
  }

  for (const row of keepLatestWbAdsRowsPerDate(wbAdsRaw)) {
    const dates = getDateSpan(row.dateFrom, row.dateTo).filter((date) => pointsByDate.has(date));
    if (dates.length === 0) continue;

    const spendPerDay = toNumber(row.spend) / dates.length;

    for (const date of dates) {
      const point = pointsByDate.get(date);
      if (!point) continue;
      point.adsCost += spendPerDay;
    }
  }

  for (const row of ozonFinance) {
    if (!row.accrualDate) continue;
    const date = toIsoDate(row.accrualDate);
    const point = pointsByDate.get(date);
    if (!point) continue;

    const sku = normalizeText(row.sku);
    const vendorCode = normalizeText(row.vendorCode) || ozonVendorCodeBySku.get(sku) || sku;
    const costPrice = vendorCode ? costByVendorCode.get(vendorCode) ?? 0 : 0;
    const quantity = Math.abs(toNumber(row.quantity));
    const salesAmount = toNumber(row.salesAmount);
    const totalAmount = toNumber(row.totalAmount);
    const rowCost = costPrice * quantity;

    const costDelta = salesAmount < 0 || totalAmount < 0 ? -rowCost : rowCost;

    point.ozonRevenue += salesAmount;
    point.marketplaceProfitBeforeTax += totalAmount - costDelta;
    addTaxForRevenue(point, salesAmount, row.companyName, taxByCompany);
  }

  for (const row of keepLatestOzonAdsRowsPerDate(ozonAdsRaw)) {
    if (!row.reportDate) continue;
    const date = toIsoDate(row.reportDate);
    const point = pointsByDate.get(date);
    if (!point) continue;

    point.adsCost += toNumber(row.spend);
  }

  const financeRowsByDate = new Map<string, typeof financeTransactions>();

  for (const transaction of financeTransactions) {
    const date = toIsoDate(transaction.operationDate);
    const currentRows = financeRowsByDate.get(date) ?? [];
    currentRows.push(transaction);
    financeRowsByDate.set(date, currentRows);
  }

  for (const [date, rows] of financeRowsByDate.entries()) {
    const point = pointsByDate.get(date);
    if (!point) continue;

    const metrics = calculateFinanceMetricsForRows({
      transactions: rows,
      categories: financeCategories,
    });

    point.cashFlowResult = metrics.netCashFlow;
    point.creditPrincipal = metrics.creditPrincipal;
    point.creditInterest = metrics.creditInterest;
    point.loanPayments = metrics.creditPrincipal + metrics.creditInterest;
    point.financeNetProfitIncome = metrics.netProfitIncome;
    point.financeNetProfitExpense = metrics.netProfitExpense;
  }

  pointValues(pointsByDate);

  return Array.from(pointsByDate.values()).map((point) => ({
    date: point.date,
    wbRevenue: point.wbRevenue,
    ozonRevenue: point.ozonRevenue,
    revenue: point.revenue,
    adsCost: point.adsCost,
    drr: point.drr,
    operatingProfitAfterTax: point.operatingProfitAfterTax,
    netProfit: point.netProfit,
    cashFlowResult: point.cashFlowResult,
    loanPayments: point.loanPayments,
    creditPrincipal: point.creditPrincipal,
    creditInterest: point.creditInterest,
  }));
}
