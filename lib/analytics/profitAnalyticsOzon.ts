import { prisma } from "@/lib/prisma";

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
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function startOfDay(value: string) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function nextDayStart(value: string) {
  const date = startOfDay(value);
  date.setDate(date.getDate() + 1);
  return date;
}

function clampRate(value: unknown, allowedRates: number[], fallback: number) {
  const rate = toNumber(value);
  return allowedRates.includes(rate) ? rate : fallback;
}

function calculateVatTax(revenue: number, vatRate: number) {
  if (vatRate <= 0) return 0;
  return revenue * (vatRate / (100 + vatRate));
}

function calculatePreviousPeriod(dateFrom?: string | null, dateTo?: string | null) {
  if (!dateFrom || !dateTo) return null;

  const from = startOfDay(dateFrom);
  const to = startOfDay(dateTo);
  const diffMs = to.getTime() - from.getTime();
  const days = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)) + 1);

  const previousTo = new Date(from);
  previousTo.setDate(previousTo.getDate() - 1);

  const previousFrom = new Date(previousTo);
  previousFrom.setDate(previousFrom.getDate() - (days - 1));

  return {
    dateFrom: previousFrom,
    dateTo: previousTo,
  };
}

function createComparison(current: number, previous: number) {
  const diff = current - previous;

  return {
    current,
    previous,
    diff,
    diffPercent: previous !== 0 ? (diff / previous) * 100 : 0,
  };
}

function createDateWhere(dateFrom?: string | null, dateTo?: string | null) {
  return dateFrom || dateTo
    ? {
        ...(dateFrom ? { gte: startOfDay(dateFrom) } : {}),
        ...(dateTo ? { lt: nextDayStart(dateTo) } : {}),
      }
    : undefined;
}

function createDateWhereFromDates(dateFrom?: Date | null, dateTo?: Date | null) {
  if (!dateFrom || !dateTo) return undefined;

  const toExclusive = new Date(dateTo);
  toExclusive.setDate(toExclusive.getDate() + 1);

  return {
    gte: dateFrom,
    lt: toExclusive,
  };
}

export type OzonProfitAnalyticsRow = {
  nmId: string;
  vendorCode: string;
  subject: string;

  salesQty: number;
  returnsQty: number;
  netSalesQty: number;

  revenue: number;
  revenueSharePercent: number;

  sellerPayout: number;

  wbCommission: number;

  logisticsCost: number;
  storageCost: number;
  acceptanceCost: number;

  penaltiesAmount: number;
  deductions: number;

  paymentServiceCost: number;

  adsCost: number;
  drrPercent: number;

  costPrice: number;
  totalCost: number;

  marginProfit: number;
  marginProfitPercent: number;

  taxesAmount: number;

  netProfitAfterTax: number;
  marginAfterTaxPercent: number;

  abcByProfit: "A" | "B" | "C";
};

export type OzonProfitTotals = {
  salesQty: number;
  returnsQty: number;
  netSalesQty: number;

  revenue: number;

  sellerPayout: number;

  wbCommission: number;

  logisticsCost: number;
  storageCost: number;
  acceptanceCost: number;

  penaltiesAmount: number;
  deductions: number;

  paymentServiceCost: number;

  adsCost: number;
  drrPercent: number;
  undistributedAdsCost: number;

  totalCost: number;

  marginProfit: number;
  marginProfitPercent: number;

  taxesAmount: number;

  netProfitAfterTax: number;
  marginAfterTaxPercent: number;

  usnRate: number;
  vatRate: number;
};

type CostRecord = {
  vendorCode: string;
  costPrice: unknown;
};

type OzonFinanceRecord = {
  accrualDate: Date | null;
  sku: string | null;
  vendorCode: string | null;
  quantity: number | null;
  salesAmount: unknown;
  ozonCommission: unknown;
  logisticsCost: unknown;
  reverseLogisticsCost: unknown;
  totalAmount: unknown;
};

type OzonAdsRecord = {
  reportDate: Date | null;
  sku: string | null;
  spend: unknown;
};

type OzonProductRecord = {
  vendorCode: string;
  sku: string;
};

function buildCostByVendorCode(costs: CostRecord[]) {
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

function buildAdsCostByVendorCode(
  adsRows: OzonAdsRecord[],
  ozonProducts: OzonProductRecord[]
) {
  const vendorCodeBySku = new Map<string, string>();

  for (const product of ozonProducts) {
    const sku = normalizeText(product.sku);
    const vendorCode = normalizeText(product.vendorCode);

    if (!sku || !vendorCode) continue;

    if (!vendorCodeBySku.has(sku)) {
      vendorCodeBySku.set(sku, vendorCode);
    }
  }

  const adsCostByVendorCode = new Map<string, number>();
  let undistributedAdsCost = 0;

  for (const ad of adsRows) {
    const sku = normalizeText(ad.sku);
    const spend = toNumber(ad.spend);

    if (!sku || spend === 0) continue;

    const vendorCode = vendorCodeBySku.get(sku);

    if (!vendorCode) {
      undistributedAdsCost += spend;
      continue;
    }

    adsCostByVendorCode.set(
      vendorCode,
      (adsCostByVendorCode.get(vendorCode) ?? 0) + spend
    );
  }

  return {
    adsCostByVendorCode,
    undistributedAdsCost,
  };
}

function createEmptyTotals(
  usnRate: number,
  vatRate: number,
  undistributedAdsCost = 0
): OzonProfitTotals {
  return {
    salesQty: 0,
    returnsQty: 0,
    netSalesQty: 0,

    revenue: 0,

    sellerPayout: 0,

    wbCommission: 0,

    logisticsCost: 0,
    storageCost: 0,
    acceptanceCost: 0,

    penaltiesAmount: 0,
    deductions: 0,

    paymentServiceCost: 0,

    adsCost: 0,
    drrPercent: 0,
    undistributedAdsCost,

    totalCost: 0,

    marginProfit: 0,
    marginProfitPercent: 0,

    taxesAmount: 0,

    netProfitAfterTax: 0,
    marginAfterTaxPercent: 0,

    usnRate,
    vatRate,
  };
}

function calculateAbcByProfit(rows: OzonProfitAnalyticsRow[]) {
  const totalPositiveProfit = rows.reduce(
    (sum, row) => sum + Math.max(0, row.marginProfit),
    0
  );

  if (totalPositiveProfit <= 0) {
    for (const row of rows) {
      row.abcByProfit = "C";
    }
    return;
  }

  let cumulativeProfit = 0;

  for (const row of rows) {
    const positiveProfit = Math.max(0, row.marginProfit);

    if (positiveProfit <= 0) {
      row.abcByProfit = "C";
      continue;
    }

    const shareBefore = cumulativeProfit / totalPositiveProfit;
    cumulativeProfit += positiveProfit;

    if (shareBefore < 0.8) {
      row.abcByProfit = "A";
    } else if (shareBefore < 0.95) {
      row.abcByProfit = "B";
    } else {
      row.abcByProfit = "C";
    }
  }
}

function calculateRowsAndTotals({
  financeRows,
  adsRows,
  costs,
  ozonProducts,
  usnRate,
  vatRate,
}: {
  financeRows: OzonFinanceRecord[];
  adsRows: OzonAdsRecord[];
  costs: CostRecord[];
  ozonProducts: OzonProductRecord[];
  usnRate: number;
  vatRate: number;
}) {
  const costByVendorCode = buildCostByVendorCode(costs);

  const { adsCostByVendorCode, undistributedAdsCost } =
    buildAdsCostByVendorCode(adsRows, ozonProducts);

  const grouped = new Map<string, OzonProfitAnalyticsRow>();

  for (const financeRow of financeRows) {
    const vendorCodeKey = normalizeText(financeRow.vendorCode);

    if (!vendorCodeKey) continue;

    const current =
      grouped.get(vendorCodeKey) ??
      {
        nmId: financeRow.sku ?? "",
        vendorCode: financeRow.vendorCode ?? "",
        subject: "",

        salesQty: 0,
        returnsQty: 0,
        netSalesQty: 0,

        revenue: 0,
        revenueSharePercent: 0,

        sellerPayout: 0,

        wbCommission: 0,

        logisticsCost: 0,
        storageCost: 0,
        acceptanceCost: 0,

        penaltiesAmount: 0,
        deductions: 0,

        paymentServiceCost: 0,

        adsCost: adsCostByVendorCode.get(vendorCodeKey) ?? 0,
        drrPercent: 0,

        costPrice: costByVendorCode.get(vendorCodeKey) ?? 0,
        totalCost: 0,

        marginProfit: 0,
        marginProfitPercent: 0,

        taxesAmount: 0,

        netProfitAfterTax: 0,
        marginAfterTaxPercent: 0,

        abcByProfit: "C" as const,
      };

    if (!current.nmId && financeRow.sku) {
      current.nmId = financeRow.sku;
    }

    if (!current.vendorCode && financeRow.vendorCode) {
      current.vendorCode = financeRow.vendorCode;
    }

    if (current.costPrice === 0 && vendorCodeKey) {
      current.costPrice = costByVendorCode.get(vendorCodeKey) ?? 0;
    }

    const quantity = Math.abs(toNumber(financeRow.quantity));
    const salesAmount = toNumber(financeRow.salesAmount);
    const totalAmount = toNumber(financeRow.totalAmount);

    if (salesAmount > 0 || quantity > 0) {
      current.salesQty += quantity;
      current.netSalesQty += quantity;
      current.totalCost += current.costPrice * quantity;
    }

    if (salesAmount < 0 || totalAmount < 0) {
      current.returnsQty += quantity;
      current.netSalesQty -= quantity;
      current.totalCost -= current.costPrice * quantity;
    }

    current.revenue += salesAmount;
    current.sellerPayout += totalAmount;

    const commission = Math.abs(toNumber(financeRow.ozonCommission));
    const directLogistics = Math.abs(toNumber(financeRow.logisticsCost));
    const reverseLogistics = Math.abs(toNumber(financeRow.reverseLogisticsCost));
    const logistics = directLogistics + reverseLogistics;

    current.wbCommission += commission;
    current.logisticsCost += logistics;

    const knownMarketplaceExpenses = commission + logistics;
    const payoutGap = salesAmount - totalAmount;
    const otherDeductions = payoutGap - knownMarketplaceExpenses;

    current.deductions += otherDeductions;

    current.marginProfit =
      current.sellerPayout - current.totalCost - current.adsCost;

    current.marginProfitPercent =
      current.revenue > 0 ? (current.marginProfit / current.revenue) * 100 : 0;

    current.drrPercent =
      current.revenue > 0 ? (current.adsCost / current.revenue) * 100 : 0;

    const usnTax = current.revenue > 0 ? current.revenue * (usnRate / 100) : 0;
    const vatTax =
      current.revenue > 0 ? calculateVatTax(current.revenue, vatRate) : 0;

    current.taxesAmount = usnTax + vatTax;
    current.netProfitAfterTax = current.marginProfit - current.taxesAmount;

    current.marginAfterTaxPercent =
      current.revenue > 0
        ? (current.netProfitAfterTax / current.revenue) * 100
        : 0;

    grouped.set(vendorCodeKey, current);
  }

  for (const [vendorCodeKey, adsCost] of adsCostByVendorCode.entries()) {
    if (grouped.has(vendorCodeKey)) continue;
    if (adsCost === 0) continue;

    grouped.set(vendorCodeKey, {
      nmId: "",
      vendorCode: vendorCodeKey,
      subject: "",

      salesQty: 0,
      returnsQty: 0,
      netSalesQty: 0,

      revenue: 0,
      revenueSharePercent: 0,

      sellerPayout: 0,

      wbCommission: 0,

      logisticsCost: 0,
      storageCost: 0,
      acceptanceCost: 0,

      penaltiesAmount: 0,
      deductions: 0,

      paymentServiceCost: 0,

      adsCost,
      drrPercent: 0,

      costPrice: costByVendorCode.get(vendorCodeKey) ?? 0,
      totalCost: 0,

      marginProfit: -adsCost,
      marginProfitPercent: 0,

      taxesAmount: 0,

      netProfitAfterTax: -adsCost,
      marginAfterTaxPercent: 0,

      abcByProfit: "C",
    });
  }

  const rows = Array.from(grouped.values())
    .filter(
      (row) =>
        row.salesQty > 0 ||
        row.revenue !== 0 ||
        row.sellerPayout !== 0 ||
        row.adsCost !== 0
    )
    .sort((a, b) => b.marginProfit - a.marginProfit);

  calculateAbcByProfit(rows);

  const totalRevenue = rows.reduce((sum, row) => sum + row.revenue, 0);

  rows.forEach((row) => {
    row.revenueSharePercent =
      totalRevenue > 0 ? (row.revenue / totalRevenue) * 100 : 0;
  });

  const totals = rows.reduce(
    (acc, row) => {
      acc.salesQty += row.salesQty;
      acc.returnsQty += row.returnsQty;
      acc.netSalesQty += row.netSalesQty;

      acc.revenue += row.revenue;
      acc.sellerPayout += row.sellerPayout;

      acc.wbCommission += row.wbCommission;
      acc.logisticsCost += row.logisticsCost;

      acc.penaltiesAmount += row.penaltiesAmount;
      acc.deductions += row.deductions;

      acc.paymentServiceCost += row.paymentServiceCost;

      acc.adsCost += row.adsCost;

      acc.totalCost += row.totalCost;

      acc.marginProfit += row.marginProfit;

      acc.taxesAmount += row.taxesAmount;

      acc.netProfitAfterTax += row.netProfitAfterTax;

      return acc;
    },
    createEmptyTotals(usnRate, vatRate, undistributedAdsCost)
  );

  totals.marginProfitPercent =
    totals.revenue > 0 ? (totals.marginProfit / totals.revenue) * 100 : 0;

  totals.marginAfterTaxPercent =
    totals.revenue > 0
      ? (totals.netProfitAfterTax / totals.revenue) * 100
      : 0;

  totals.drrPercent =
    totals.revenue > 0 ? (totals.adsCost / totals.revenue) * 100 : 0;

  return {
    rows,
    totals,
  };
}

async function findLatestOzonFinanceRowsByPeriod(params?: {
  dateFrom?: string | null;
  dateTo?: string | null;
  companyName?: string | null;
}) {
  const accrualDateWhere = createDateWhere(params?.dateFrom, params?.dateTo);

  const latestRow = await prisma.ozonFinance.findFirst({
    where: {
      ...(accrualDateWhere ? { accrualDate: accrualDateWhere } : {}),
      ...(params?.companyName ? { companyName: params.companyName } : {}),
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (!latestRow) return [];

  if (latestRow.importSessionId) {
    return prisma.ozonFinance.findMany({
      where: {
        importSessionId: latestRow.importSessionId,
        ...(accrualDateWhere ? { accrualDate: accrualDateWhere } : {}),
        ...(params?.companyName ? { companyName: params.companyName } : {}),
      },
      orderBy: {
        accrualDate: "desc",
      },
    });
  }

  return prisma.ozonFinance.findMany({
    where: {
      ...(accrualDateWhere ? { accrualDate: accrualDateWhere } : {}),
      ...(params?.companyName ? { companyName: params.companyName } : {}),
      createdAt: {
        gte: new Date(latestRow.createdAt.getTime() - 10 * 60 * 1000),
        lte: new Date(latestRow.createdAt.getTime() + 10 * 60 * 1000),
      },
    },
    orderBy: {
      accrualDate: "desc",
    },
  });
}

async function findLatestOzonFinanceRowsByDatePeriod(params?: {
  dateFrom?: Date | null;
  dateTo?: Date | null;
  companyName?: string | null;
}) {
  const accrualDateWhere = createDateWhereFromDates(
    params?.dateFrom,
    params?.dateTo
  );

  const latestRow = await prisma.ozonFinance.findFirst({
    where: {
      ...(accrualDateWhere ? { accrualDate: accrualDateWhere } : {}),
      ...(params?.companyName ? { companyName: params.companyName } : {}),
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (!latestRow) return [];

  if (latestRow.importSessionId) {
    return prisma.ozonFinance.findMany({
      where: {
        importSessionId: latestRow.importSessionId,
        ...(accrualDateWhere ? { accrualDate: accrualDateWhere } : {}),
        ...(params?.companyName ? { companyName: params.companyName } : {}),
      },
      orderBy: {
        accrualDate: "desc",
      },
    });
  }

  return prisma.ozonFinance.findMany({
    where: {
      ...(accrualDateWhere ? { accrualDate: accrualDateWhere } : {}),
      ...(params?.companyName ? { companyName: params.companyName } : {}),
      createdAt: {
        gte: new Date(latestRow.createdAt.getTime() - 10 * 60 * 1000),
        lte: new Date(latestRow.createdAt.getTime() + 10 * 60 * 1000),
      },
    },
    orderBy: {
      accrualDate: "desc",
    },
  });
}

async function findLatestOzonAdsRowsByPeriod(params?: {
  dateFrom?: string | null;
  dateTo?: string | null;
  companyName?: string | null;
}) {
  const reportDateWhere = createDateWhere(params?.dateFrom, params?.dateTo);

  const datedRows = await prisma.ozonAds.findMany({
    where: {
      ...(reportDateWhere ? { reportDate: reportDateWhere } : {}),
      ...(params?.companyName ? { companyName: params.companyName } : {}),
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  const filteredDatedRows = keepOnlyLatestAdsImportPerReportDate(datedRows);

  if (filteredDatedRows.length > 0) {
    return filteredDatedRows;
  }

  const latestRow = await prisma.ozonAds.findFirst({
    where: {
      ...(params?.companyName ? { companyName: params.companyName } : {}),
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (!latestRow) return [];

  if (latestRow.importSessionId) {
    return prisma.ozonAds.findMany({
      where: {
        importSessionId: latestRow.importSessionId,
        ...(params?.companyName ? { companyName: params.companyName } : {}),
      },
    });
  }

  return prisma.ozonAds.findMany({
    where: {
      ...(params?.companyName ? { companyName: params.companyName } : {}),
      createdAt: {
        gte: new Date(latestRow.createdAt.getTime() - 10 * 60 * 1000),
        lte: new Date(latestRow.createdAt.getTime() + 10 * 60 * 1000),
      },
    },
  });
}

async function findLatestOzonAdsRowsByDatePeriod(params?: {
  dateFrom?: Date | null;
  dateTo?: Date | null;
  companyName?: string | null;
}) {
  const reportDateWhere = createDateWhereFromDates(
    params?.dateFrom,
    params?.dateTo
  );

  const rows = await prisma.ozonAds.findMany({
    where: {
      ...(reportDateWhere ? { reportDate: reportDateWhere } : {}),
      ...(params?.companyName ? { companyName: params.companyName } : {}),
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return keepOnlyLatestAdsImportPerReportDate(rows);
}

function keepOnlyLatestAdsImportPerReportDate<
  T extends {
    reportDate: Date | null;
    importSessionId: string | null;
    createdAt: Date;
  },
>(rows: T[]) {
  const latestSessionByDate = new Map<string, string | null>();

  for (const row of rows) {
    const dateKey = row.reportDate
      ? row.reportDate.toISOString().slice(0, 10)
      : "NO_DATE";

    if (!latestSessionByDate.has(dateKey)) {
      latestSessionByDate.set(dateKey, row.importSessionId ?? null);
    }
  }

  return rows.filter((row) => {
    const dateKey = row.reportDate
      ? row.reportDate.toISOString().slice(0, 10)
      : "NO_DATE";

    return latestSessionByDate.get(dateKey) === (row.importSessionId ?? null);
  });
}

export async function getProfitAnalyticsOzon(params?: {
  dateFrom?: string | null;
  dateTo?: string | null;
  usnRate?: string | number | null;
  vatRate?: string | number | null;
  companyName?: string | null;
}) {
  const usnRate = clampRate(params?.usnRate, [0, 1, 2, 3, 4, 5, 6], 1);
  const vatRate = clampRate(params?.vatRate, [0, 5, 7], 5);
  const companyName =
    params?.companyName && params.companyName !== "ALL"
      ? params.companyName
      : null;

  const costs = await prisma.productCost.findMany({
    orderBy: {
      costDate: "desc",
    },
  });

  const ozonProducts = await prisma.ozonProduct.findMany({
    where: {
      ...(companyName ? { companyName } : {}),
    },
    select: {
      vendorCode: true,
      sku: true,
    },
  });

  const currentFinanceRows = await findLatestOzonFinanceRowsByPeriod({
    dateFrom: params?.dateFrom,
    dateTo: params?.dateTo,
    companyName,
  });

  const currentAdsRows = await findLatestOzonAdsRowsByPeriod({
    dateFrom: params?.dateFrom,
    dateTo: params?.dateTo,
    companyName,
  });

  const previousPeriod = calculatePreviousPeriod(
    params?.dateFrom,
    params?.dateTo
  );

  const previousFinanceRows = previousPeriod
    ? await findLatestOzonFinanceRowsByDatePeriod({
        dateFrom: previousPeriod.dateFrom,
        dateTo: previousPeriod.dateTo,
        companyName,
      })
    : [];

  const previousAdsRows = previousPeriod
    ? await findLatestOzonAdsRowsByDatePeriod({
        dateFrom: previousPeriod.dateFrom,
        dateTo: previousPeriod.dateTo,
        companyName,
      })
    : [];

  const current = calculateRowsAndTotals({
    financeRows: currentFinanceRows,
    adsRows: currentAdsRows,
    costs,
    ozonProducts,
    usnRate,
    vatRate,
  });

  const previous = calculateRowsAndTotals({
    financeRows: previousFinanceRows,
    adsRows: previousAdsRows,
    costs,
    ozonProducts,
    usnRate,
    vatRate,
  });

  const comparison = {
    revenue: createComparison(current.totals.revenue, previous.totals.revenue),

    sellerPayout: createComparison(
      current.totals.sellerPayout,
      previous.totals.sellerPayout
    ),

    totalCost: createComparison(
      current.totals.totalCost,
      previous.totals.totalCost
    ),

    wbCommission: createComparison(
      current.totals.wbCommission,
      previous.totals.wbCommission
    ),

    logisticsCost: createComparison(
      current.totals.logisticsCost,
      previous.totals.logisticsCost
    ),

    adsCost: createComparison(current.totals.adsCost, previous.totals.adsCost),

    taxesAmount: createComparison(
      current.totals.taxesAmount,
      previous.totals.taxesAmount
    ),

    marginProfit: createComparison(
      current.totals.marginProfit,
      previous.totals.marginProfit
    ),

    netProfitAfterTax: createComparison(
      current.totals.netProfitAfterTax,
      previous.totals.netProfitAfterTax
    ),
  };

  return {
    rows: current.rows,
    totals: current.totals,

    previousRows: previous.rows,
    previousTotals: previous.totals,

    comparison,
  };
}