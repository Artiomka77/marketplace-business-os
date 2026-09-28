import { createHash } from "node:crypto";

import { getDashboardDailyAnalytics } from "@/lib/analytics/dashboardDailyAnalytics";
import { getProfitAnalytics, isProfitAnalyticsUnavailable } from "@/lib/analytics/profitAnalytics";
import { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";
import { calculateFinanceMetricsForRows } from "@/lib/finance/financeMetrics";
import { prisma } from "@/lib/prisma";
import { buildDailyReport } from "@/lib/telegram/dailyReport";
import {
  marketplaceManagementRevenue,
  snapshotCombinedProfit,
} from "@/lib/dashboard/managementRevenue";

export const DASHBOARD_PERIOD_SNAPSHOT_FORMULA_VERSION =
  "FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1";

export type DashboardSnapshotCompanyRow = {
  companyName: string;
  ordersQty: number;
  ordersAmount: number;
  orderDataLoadedDays: number;
  orderDataExpectedDays: number;
  wbRevenue: number | null;
  ozonRevenue: number | null;
  totalRevenue: number | null;
  operatingProfitAfterTax: number | null;
  netProfit: number | null;
  profitAfterOwnerWithdrawal: number | null;
  cashFlowResult: number;
  adsCost: number;
  wbAdsCost: number;
  ozonAdsCost: number;
  drr: number | null;
  drrByOrders: number | null;
  loanPayments: number;
  creditPrincipal: number;
  creditInterest: number;
  personalExpenses: number;
  financialExpenses: number;
  cashOnlyExpenses: number;
  wbStockQty: number;
  ozonStockQty: number;
  warehouseStockQty: number;
  wbAbcA: number;
  wbAbcB: number;
  wbAbcC: number;
  ozonAbcA: number;
  ozonAbcB: number;
  ozonAbcC: number;
};

export type DashboardSnapshotSummary = {
  companyRows: DashboardSnapshotCompanyRow[];
  ordersQty: number;
  ordersAmount: number;
  orderDataLoadedDays: number;
  orderDataExpectedDays: number;
  totalRevenue: number | null;
  wbRevenue: number;
  ozonRevenue: number | null;
  operatingProfitAfterTax: number | null;
  netProfit: number | null;
  profitAfterOwnerWithdrawal: number | null;
  cashFlowResult: number;
  adsCost: number;
  drr: number | null;
  drrByOrders: number | null;
  loanPayments: number;
  creditPrincipal: number;
  creditInterest: number;
  personalExpenses: number;
  financialExpenses: number;
  cashOnlyExpenses: number;
  wbStockQty: number;
  ozonStockQty: number;
  warehouseStockQty: number;
  wbAbc: { A: number; B: number; C: number };
  ozonAbc: { A: number; B: number; C: number };
  totalAbc: { A: number; B: number; C: number };
};


export const DASHBOARD_PERIOD_SNAPSHOT_INSIGHTS_VERSION =
  "INSIGHTS_PERIOD_SNAPSHOT_V1";

export type DashboardSnapshotInsightRow = {
  companyName: string;
  marketplace: "WB" | "Ozon";
  sku: string;
  vendorCode: string;
  salesQty: number;
  revenue: number;
  profit: number;
  marginPercent: number;
};

export type DashboardSnapshotStockRow = {
  companyName: string;
  marketplace: "WB" | "Ozon";
  sku: string;
  vendorCode: string;
  quantity: number;
  unitCost: number;
  frozenMoney: number;
};

export type DashboardSnapshotInsights = {
  version: string;
  rows: DashboardSnapshotInsightRow[];
  stockRows: DashboardSnapshotStockRow[];
};


export const DASHBOARD_PERIOD_SNAPSHOT_PROFIT_WB_VERSION =
  "PROFIT_WB_PERIOD_SNAPSHOT_V1";

type ProfitAnalyticsResult = Awaited<ReturnType<typeof getProfitAnalytics>>;

export type DashboardSnapshotProfitWbProductMeta = {
  productName: string;
  subject: string;
  nmId: string;
  vendorCode: string;
  imageUrl?: string | null;
};

export type DashboardSnapshotProfitWbSizeRow = {
  size: string;
  barcode: string;
  revenue: number;
  sellerRetailAmount: number;
  netSalesQty: number;
  salesQty: number;
  returnsQty: number;
  expenses: number;
  netProfitAfterTax: number;
  buyoutPercent: number | null;
  marginAfterTaxPercent: number;
  abcByRevenue: "A" | "B" | "C";
  abcByProfit: "A" | "B" | "C";
};

export type DashboardSnapshotProfitWb = {
  version: string;
  companyScope: string;
  rows: ProfitAnalyticsResult["rows"];
  totals: ProfitAnalyticsResult["totals"];
  comparison: ProfitAnalyticsResult["comparison"];
  productMeta: Array<{
    vendorKey: string;
    value: DashboardSnapshotProfitWbProductMeta;
  }>;
  sizeRows: Array<{
    vendorKey: string;
    rows: DashboardSnapshotProfitWbSizeRow[];
  }>;
};


export const DASHBOARD_PERIOD_SNAPSHOT_PROFIT_OZON_VERSION =
  "PROFIT_OZON_PERIOD_SNAPSHOT_V1";

type OzonAnalyticsResult = Awaited<
  ReturnType<typeof getProfitAnalyticsOzon>
>;

export type DashboardSnapshotProfitOzonProductMeta = {
  productName: string;
  subject: string;
  sku: string;
  vendorCode: string;
  imageUrl?: string | null;
};

export type DashboardSnapshotProfitOzonSkuRow = {
  sku: string;
  vendorCode: string;
  sizeLabel: string;
  revenue: number;
  netSalesQty: number;
  salesQty: number;
  returnsQty: number;
  expenses: number;
  netProfitAfterTax: number;
  buyoutPercent: number | null;
  marginAfterTaxPercent: number;
  abcByRevenue: "A" | "B" | "C";
  abcByProfit: "A" | "B" | "C";
};

export type DashboardSnapshotProfitOzon = {
  version: string;
  companyScope: string;
  rows: OzonAnalyticsResult["rows"];
  totals: OzonAnalyticsResult["totals"];
  comparison: OzonAnalyticsResult["comparison"];
  productMeta: Array<{
    vendorKey: string;
    value: DashboardSnapshotProfitOzonProductMeta;
  }>;
  skuRows: Array<{
    vendorKey: string;
    rows: DashboardSnapshotProfitOzonSkuRow[];
  }>;
};

export type DashboardPeriodSnapshotPayload = {
  formulaVersion: string;
  companyScope: string;
  dateFrom: string;
  dateTo: string;
  generatedAt: string;
  periodLabel: string;
  dateLabel: string;
  companyRows: DashboardSnapshotCompanyRow[];
  summary: DashboardSnapshotSummary;
  dailyPoints: Awaited<ReturnType<typeof getDashboardDailyAnalytics>>;
  insights: DashboardSnapshotInsights;
  profitWb: DashboardSnapshotProfitWb;
  profitOzon: DashboardSnapshotProfitOzon;
  warnings: string[];
  dataReadiness: unknown;
};

function startOfDay(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function nextDayStart(value: string) {
  const date = startOfDay(value);
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function hasAnyCompanyMetric(row: DashboardSnapshotCompanyRow) {
  return (
    row.ordersQty !== 0 ||
    row.ordersAmount !== 0 ||
    row.wbRevenue !== 0 ||
    row.ozonRevenue !== 0 ||
    row.totalRevenue !== 0 ||
    row.operatingProfitAfterTax !== 0 ||
    row.netProfit !== 0 ||
    row.profitAfterOwnerWithdrawal !== 0 ||
    row.cashFlowResult !== 0 ||
    row.adsCost !== 0 ||
    row.loanPayments !== 0 ||
    row.creditPrincipal !== 0 ||
    row.creditInterest !== 0 ||
    row.personalExpenses !== 0 ||
    row.financialExpenses !== 0 ||
    row.cashOnlyExpenses !== 0 ||
    row.wbStockQty !== 0 ||
    row.ozonStockQty !== 0 ||
    row.warehouseStockQty !== 0
  );
}

async function getFinanceCashResult(params: {
  companyName: string;
  dateFrom: string;
  dateTo: string;
}) {
  const from = startOfDay(params.dateFrom);
  const toExclusive = nextDayStart(params.dateTo);

  const [rows, categories] = await Promise.all([
    prisma.financeTransaction.findMany({
      where: {
        companyName: params.companyName,
        transactionStatus: "FACT",
        operationDate: {
          gte: from,
          lt: toExclusive,
        },
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
    transactions: rows,
    categories,
  });

  return {
    cashFlowResult: metrics.netCashFlow,
    loanPayments: metrics.creditPrincipal + metrics.creditInterest,
    creditPrincipal: metrics.creditPrincipal,
    creditInterest: metrics.creditInterest,
    personalExpenses: metrics.ownerWithdrawals,
    financialExpenses: Math.max(
      0,
      metrics.netProfitExpense - metrics.creditInterest
    ),
    cashOnlyExpenses: metrics.cashOnlyTotal,
    netProfitIncludedIncome: metrics.netProfitIncome,
    netProfitIncludedExpenses: metrics.netProfitExpense,
  };
}

function summarizeDashboardRows(
  rows: DashboardSnapshotCompanyRow[]
): DashboardSnapshotSummary {
  const companyRows = rows.filter(hasAnyCompanyMetric);
  const sum = (selector: (row: DashboardSnapshotCompanyRow) => number) =>
    companyRows.reduce((total, row) => total + selector(row), 0);

  const ordersQty = sum((row) => row.ordersQty);
  const ordersAmount = sum((row) => row.ordersAmount);
  const orderDataLoadedDays = sum((row) => row.orderDataLoadedDays);
  const orderDataExpectedDays = sum((row) => row.orderDataExpectedDays);
  const revenueKnown = companyRows.every(
    (row) => row.totalRevenue != null && row.ozonRevenue != null && row.wbRevenue != null
  );
  const totalRevenue = revenueKnown
    ? companyRows.reduce((total, row) => total + (row.totalRevenue ?? 0), 0)
    : null;
  const wbRevenue = companyRows.reduce((total, row) => total + (row.wbRevenue ?? 0), 0);
  const ozonRevenue = revenueKnown
    ? companyRows.reduce((total, row) => total + (row.ozonRevenue ?? 0), 0)
    : null;
  const profitKnown = companyRows.every(
    (row) =>
      row.operatingProfitAfterTax != null &&
      row.netProfit != null &&
      row.profitAfterOwnerWithdrawal != null
  );
  const operatingProfitAfterTax = profitKnown
    ? companyRows.reduce((total, row) => total + (row.operatingProfitAfterTax ?? 0), 0)
    : null;
  const netProfit = profitKnown
    ? companyRows.reduce((total, row) => total + (row.netProfit ?? 0), 0)
    : null;
  const profitAfterOwnerWithdrawal = profitKnown
    ? companyRows.reduce((total, row) => total + (row.profitAfterOwnerWithdrawal ?? 0), 0)
    : null;
  const cashFlowResult = sum((row) => row.cashFlowResult);
  const adsCost = sum((row) => row.adsCost);
  const loanPayments = sum((row) => row.loanPayments);
  const creditPrincipal = sum((row) => row.creditPrincipal);
  const creditInterest = sum((row) => row.creditInterest);
  const personalExpenses = sum((row) => row.personalExpenses);
  const financialExpenses = sum((row) => row.financialExpenses);
  const cashOnlyExpenses = sum((row) => row.cashOnlyExpenses);
  const wbStockQty = sum((row) => row.wbStockQty);
  const ozonStockQty = sum((row) => row.ozonStockQty);
  const warehouseStockQty = sum((row) => row.warehouseStockQty);

  const wbAbc = {
    A: sum((row) => row.wbAbcA),
    B: sum((row) => row.wbAbcB),
    C: sum((row) => row.wbAbcC),
  };
  const ozonAbc = {
    A: sum((row) => row.ozonAbcA),
    B: sum((row) => row.ozonAbcB),
    C: sum((row) => row.ozonAbcC),
  };

  return {
    companyRows,
    ordersQty,
    ordersAmount,
    orderDataLoadedDays,
    orderDataExpectedDays,
    totalRevenue,
    wbRevenue,
    ozonRevenue,
    operatingProfitAfterTax,
    netProfit,
    profitAfterOwnerWithdrawal,
    cashFlowResult,
    adsCost,
    drr: totalRevenue != null && totalRevenue > 0 ? (adsCost / totalRevenue) * 100 : null,
    drrByOrders: ordersAmount > 0 ? (adsCost / ordersAmount) * 100 : null,
    loanPayments,
    creditPrincipal,
    creditInterest,
    personalExpenses,
    financialExpenses,
    cashOnlyExpenses,
    wbStockQty,
    ozonStockQty,
    warehouseStockQty,
    wbAbc,
    ozonAbc,
    totalAbc: {
      A: wbAbc.A + ozonAbc.A,
      B: wbAbc.B + ozonAbc.B,
      C: wbAbc.C + ozonAbc.C,
    },
  };
}

function createDailyExpectedTotals(summary: DashboardSnapshotSummary) {
  if (
    summary.wbRevenue == null ||
    summary.ozonRevenue == null ||
    summary.totalRevenue == null ||
    summary.operatingProfitAfterTax == null ||
    summary.netProfit == null
  ) {
    return undefined;
  }
  return {
    wbRevenue: summary.wbRevenue,
    ozonRevenue: summary.ozonRevenue,
    revenue: summary.totalRevenue,
    adsCost: summary.adsCost,
    operatingProfitAfterTax: summary.operatingProfitAfterTax,
    netProfit: summary.netProfit,
    cashFlowResult: summary.cashFlowResult,
    loanPayments: summary.loanPayments,
    creditPrincipal: summary.creditPrincipal,
    creditInterest: summary.creditInterest,
  };
}


function getAmount(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function normalizeVendorCode(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[‐-‒–—−]/g, "-")
    .replace(/\s+/g, "")
    .trim();
}

function getAnyNumber(
  row: Record<string, unknown>,
  keys: string[]
) {
  for (const key of keys) {
    const value = getAmount(row[key]);

    if (value !== 0) {
      return value;
    }
  }

  return 0;
}

function getAnyString(
  row: Record<string, unknown>,
  keys: string[]
) {
  for (const key of keys) {
    const value = String(row[key] ?? "").trim();

    if (value) {
      return value;
    }
  }

  return "";
}

async function buildInsightsSnapshot(params: {
  companyNames: string[];
  companyScope: string;
  dateFrom: string;
  dateTo: string;
}): Promise<DashboardSnapshotInsights> {
  const rows: DashboardSnapshotInsightRow[] = [];

  // Deliberately sequential: the worker may calculate long periods,
  // so it must not create a burst of competing Prisma queries.
  for (const companyName of params.companyNames) {
    const wb = await getProfitAnalytics({
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      companyName,
    });

    const ozon = await getProfitAnalyticsOzon({
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      companyName,
    });

    if (!isProfitAnalyticsUnavailable(wb)) {
    for (const row of wb.rows) {
      const revenue = getAmount(row.revenue);
      const profit = getAmount(row.netProfitAfterTax);

      rows.push({
        companyName,
        marketplace: "WB",
        sku: String(row.nmId ?? ""),
        vendorCode: String(row.vendorCode ?? ""),
        salesQty: getAmount(row.netSalesQty),
        revenue,
        profit,
        marginPercent: revenue ? (profit / revenue) * 100 : 0,
      });
    }
    }

    for (const row of ozon.rows) {
      const revenue = getAmount(row.revenue);
      const profit = getAmount(row.netProfitAfterTax);

      rows.push({
        companyName,
        marketplace: "Ozon",
        sku: String(row.nmId ?? ""),
        vendorCode: String(row.vendorCode ?? ""),
        salesQty: getAmount(row.netSalesQty),
        revenue,
        profit,
        marginPercent: revenue ? (profit / revenue) * 100 : 0,
      });
    }
  }

  const productCosts = await prisma.productCost.findMany({
    orderBy: [{ costDate: "desc" }, { createdAt: "desc" }],
  });

  const costByVendorCode = new Map<string, number>();

  for (const cost of productCosts) {
    const key = normalizeVendorCode(cost.vendorCode);

    if (key && !costByVendorCode.has(key)) {
      costByVendorCode.set(key, getAmount(cost.costPrice));
    }
  }

  const stockWhere =
    params.companyScope === "ALL"
      ? {}
      : { companyName: params.companyScope };

  const wbStocks = await prisma.wbStock.findMany({
    where: stockWhere,
  });

  const ozonStocks = await prisma.ozonStock.findMany({
    where: stockWhere,
  });

  const stockRows: DashboardSnapshotStockRow[] = [
    ...wbStocks.map((stock) => {
      const row = stock as unknown as Record<string, unknown>;
      const vendorCode = getAnyString(row, [
        "vendorCode",
        "supplierArticle",
        "article",
        "sku",
      ]);
      const quantity = getAnyNumber(row, [
        "quantity",
        "qty",
        "stockQty",
        "availableQty",
        "available",
        "quantityFull",
      ]);
      const unitCost =
        costByVendorCode.get(normalizeVendorCode(vendorCode)) ?? 0;

      return {
        companyName: getAnyString(row, ["companyName"]) || "—",
        marketplace: "WB" as const,
        sku: getAnyString(row, ["nmId", "sku", "barcode"]),
        vendorCode,
        quantity,
        unitCost,
        frozenMoney: quantity * unitCost,
      };
    }),
    ...ozonStocks.map((stock) => {
      const row = stock as unknown as Record<string, unknown>;
      const vendorCode = getAnyString(row, [
        "vendorCode",
        "offerId",
        "article",
        "sku",
      ]);
      const quantity = getAnyNumber(row, [
        "quantity",
        "qty",
        "stockQty",
        "availableQty",
        "available",
        "availableToSell",
      ]);
      const unitCost =
        costByVendorCode.get(normalizeVendorCode(vendorCode)) ?? 0;

      return {
        companyName: getAnyString(row, ["companyName"]) || "—",
        marketplace: "Ozon" as const,
        sku: getAnyString(row, ["sku", "productId", "barcode"]),
        vendorCode,
        quantity,
        unitCost,
        frozenMoney: quantity * unitCost,
      };
    }),
  ]
    .filter((row) => row.quantity > 0 && row.unitCost > 0)
    .sort((left, right) => right.frozenMoney - left.frozenMoney);

  return {
    version: DASHBOARD_PERIOD_SNAPSHOT_INSIGHTS_VERSION,
    rows,
    stockRows,
  };
}


type ProfitWbSnapshotRawSizeMetric = {
  size: string;
  barcode: string;
  revenue: number;
  salesQty: number;
  returnsQty: number;
  netSalesQty: number;
};

function toProfitWbNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;

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

function normalizeProfitWbText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[–—−]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function createProfitWbDateFilter(
  dateFrom?: string | null,
  dateTo?: string | null
) {
  return dateFrom || dateTo
    ? {
        OR: [
          {
            dateFrom: {
              ...(dateFrom ? { gte: startOfDay(dateFrom) } : {}),
              ...(dateTo ? { lt: nextDayStart(dateTo) } : {}),
            },
          },
          {
            dateTo: {
              ...(dateFrom ? { gte: startOfDay(dateFrom) } : {}),
              ...(dateTo ? { lt: nextDayStart(dateTo) } : {}),
            },
          },
        ],
      }
    : {};
}

function isProfitWbSaleOperation(reason: string) {
  const value = normalizeProfitWbText(reason);
  return value === "продажа" || value === "сторно возвратов";
}

function calculateProfitWbAbcByPositiveValue<T>(
  rows: T[],
  getValue: (row: T) => number
): Map<T, "A" | "B" | "C"> {
  const result = new Map<T, "A" | "B" | "C">();

  const sorted = [...rows].sort(
    (a, b) => Math.max(0, getValue(b)) - Math.max(0, getValue(a))
  );

  const total = sorted.reduce(
    (sum, row) => sum + Math.max(0, getValue(row)),
    0
  );

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

function getProfitWbRowExpenses(
  row: ProfitAnalyticsResult["rows"][number]
) {
  return row.revenue - row.netProfitAfterTax;
}

async function findWbSaleRowsForProfitWbSnapshot(params: {
  dateFrom?: string | null;
  dateTo?: string | null;
  companyName?: string | null;
}) {
  const dateFilter = createProfitWbDateFilter(
    params.dateFrom,
    params.dateTo
  );

  const financeRows = await prisma.wbFinance.findMany({
    where: {
      ...dateFilter,
      ...(params.companyName
        ? { companyName: params.companyName }
        : {}),
    },
    select: {
      reportNumber: true,
    },
  });

  const reportNumbers = Array.from(
    new Set(
      financeRows
        .map((row) => String(row.reportNumber ?? "").trim())
        .filter(Boolean)
    )
  );

  if (reportNumbers.length > 0) {
    const importSessions = await prisma.importSession.findMany({
      where: {
        ...(params.companyName
          ? { companyName: params.companyName }
          : {}),
        reportType: "WB_SALES",
        OR: reportNumbers.map((reportNumber) => ({
          fileName: {
            contains: reportNumber,
          },
        })),
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const latestSessionByFileName = new Map<string, string>();

    for (const session of importSessions) {
      if (!latestSessionByFileName.has(session.fileName)) {
        latestSessionByFileName.set(session.fileName, session.id);
      }
    }

    const latestImportSessionIds = Array.from(
      latestSessionByFileName.values()
    );

    if (latestImportSessionIds.length > 0) {
      return prisma.wbSale.findMany({
        where: {
          ...(params.companyName
            ? { companyName: params.companyName }
            : {}),
          importSessionId: {
            in: latestImportSessionIds,
          },
        },
        select: {
          productName: true,
          subject: true,
          size: true,
          nmId: true,
          vendorCode: true,
          barcode: true,
          paymentReason: true,
          quantity: true,
          wbRealizedAmount: true,
          saleDate: true,
        },
        orderBy: {
          saleDate: "desc",
        },
      });
    }
  }

  return prisma.wbSale.findMany({
    where: {
      ...(params.companyName
        ? { companyName: params.companyName }
        : {}),
      ...(params.dateFrom || params.dateTo
        ? {
            saleDate: {
              ...(params.dateFrom
                ? { gte: startOfDay(params.dateFrom) }
                : {}),
              ...(params.dateTo
                ? { lt: nextDayStart(params.dateTo) }
                : {}),
            },
          }
        : {}),
    },
    select: {
      productName: true,
      subject: true,
      size: true,
      nmId: true,
      vendorCode: true,
      barcode: true,
      paymentReason: true,
      quantity: true,
      wbRealizedAmount: true,
      saleDate: true,
    },
    orderBy: {
      saleDate: "desc",
    },
  });
}

export async function buildProfitWbSnapshotSection(params: {
  companyScope: string;
  dateFrom: string;
  dateTo: string;
  analytics?: ProfitAnalyticsResult;
}): Promise<DashboardSnapshotProfitWb> {
  const companyName =
    params.companyScope === "ALL" ? null : params.companyScope;

  const analytics =
    params.analytics ??
    (await getProfitAnalytics({
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      companyName: params.companyScope,
    }));

  if (isProfitAnalyticsUnavailable(analytics)) {
    return normalizeJson<DashboardSnapshotProfitWb>({
      version: DASHBOARD_PERIOD_SNAPSHOT_PROFIT_WB_VERSION,
      companyScope: params.companyScope,
      rows: [],
      totals: null,
      comparison: null,
      productMeta: [],
      sizeRows: [],
    });
  }

  const rowNmIds = Array.from(
    new Set(
      analytics.rows
        .map((row) => String(row.nmId ?? "").trim())
        .filter(Boolean)
    )
  );

  const rowVendorCodes = Array.from(
    new Set(
      analytics.rows
        .map((row) => String(row.vendorCode ?? "").trim())
        .filter(Boolean)
    )
  );

  const productCardWhere =
    rowNmIds.length > 0 || rowVendorCodes.length > 0
      ? {
          ...(companyName ? { companyName } : {}),
          OR: [
            ...(rowNmIds.length > 0
              ? [{ nmId: { in: rowNmIds } }]
              : []),
            ...(rowVendorCodes.length > 0
              ? [{ vendorCode: { in: rowVendorCodes } }]
              : []),
          ],
        }
      : {
          ...(companyName ? { companyName } : {}),
        };

  const [salesRows, productCosts, productCards] = await Promise.all([
    findWbSaleRowsForProfitWbSnapshot({
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      companyName,
    }),
    prisma.productCost.findMany({
      select: {
        vendorCode: true,
        nmId: true,
        name: true,
      },
      orderBy: {
        costDate: "desc",
      },
    }),
    prisma.wbProductCard.findMany({
      where: productCardWhere,
      orderBy: {
        lastSyncedAt: "desc",
      },
    }),
  ]);

  const metaByVendorCode = new Map<
    string,
    DashboardSnapshotProfitWbProductMeta
  >();
  const rawSizesByVendorCode = new Map<
    string,
    Map<string, ProfitWbSnapshotRawSizeMetric>
  >();

  for (const card of productCards) {
    const key = normalizeProfitWbText(
      card.vendorCode || card.nmId
    );

    if (!key) continue;

    metaByVendorCode.set(key, {
      productName:
        card.title ?? card.vendorCode ?? card.nmId,
      subject: card.subjectName ?? "",
      nmId: card.nmId,
      vendorCode: card.vendorCode ?? "",
      imageUrl:
        card.photoSmallUrl ?? card.photoBigUrl,
    });
  }

  for (const cost of productCosts) {
    const key = normalizeProfitWbText(cost.vendorCode);
    if (!key) continue;

    const current = metaByVendorCode.get(key);

    if (!current) {
      metaByVendorCode.set(key, {
        productName: cost.name ?? cost.vendorCode,
        subject: "",
        nmId: cost.nmId ?? "",
        vendorCode: cost.vendorCode,
      });
    }
  }

  for (const sale of salesRows) {
    const vendorCode = sale.vendorCode ?? "";
    const vendorKey = normalizeProfitWbText(vendorCode);
    if (!vendorKey) continue;

    const currentMeta = metaByVendorCode.get(vendorKey);

    metaByVendorCode.set(vendorKey, {
      productName:
        currentMeta?.productName &&
        currentMeta.productName !== currentMeta.vendorCode
          ? currentMeta.productName
          : sale.productName ||
            sale.subject ||
            vendorCode,
      subject:
        currentMeta?.subject || sale.subject || "",
      nmId:
        currentMeta?.nmId || sale.nmId || "",
      vendorCode:
        currentMeta?.vendorCode ||
        sale.vendorCode ||
        vendorCode,
      imageUrl: currentMeta?.imageUrl ?? null,
    });

    const size =
      String(sale.size ?? "Без размера").trim() ||
      "Без размера";
    const barcode = String(sale.barcode ?? "").trim();
    const sizeKey = `${size}__${barcode}`;

    const sizeMap =
      rawSizesByVendorCode.get(vendorKey) ??
      new Map<string, ProfitWbSnapshotRawSizeMetric>();

    const current =
      sizeMap.get(sizeKey) ??
      {
        size,
        barcode,
        revenue: 0,
        salesQty: 0,
        returnsQty: 0,
        netSalesQty: 0,
      };

    const paymentReason = normalizeProfitWbText(
      sale.paymentReason
    );
    const quantity = Math.abs(Number(sale.quantity ?? 0));
    const revenue = toProfitWbNumber(
      sale.wbRealizedAmount
    );

    if (isProfitWbSaleOperation(paymentReason)) {
      current.salesQty += quantity;
      current.netSalesQty += quantity;
      current.revenue += revenue;
    }

    if (paymentReason === "возврат") {
      current.returnsQty += quantity;
      current.netSalesQty -= quantity;
      current.revenue -= revenue;
    }

    sizeMap.set(sizeKey, current);
    rawSizesByVendorCode.set(vendorKey, sizeMap);
  }

  const sizeRowsByVendorCode = new Map<
    string,
    DashboardSnapshotProfitWbSizeRow[]
  >();

  for (const row of analytics.rows) {
    const vendorKey = normalizeProfitWbText(
      row.vendorCode
    );
    const sizeMap = rawSizesByVendorCode.get(vendorKey);

    if (!sizeMap || sizeMap.size === 0) {
      continue;
    }

    const rawSizes = Array.from(sizeMap.values())
      .filter(
        (size) =>
          size.salesQty > 0 ||
          size.revenue > 0 ||
          size.netSalesQty > 0
      )
      .sort((a, b) => b.revenue - a.revenue);

    const rawRevenueTotal = rawSizes.reduce(
      (sum, size) => sum + Math.max(0, size.revenue),
      0
    );

    const rawQtyTotal = rawSizes.reduce(
      (sum, size) =>
        sum + Math.max(0, size.netSalesQty),
      0
    );

    const expenses = getProfitWbRowExpenses(row);
    const abcByRevenue =
      calculateProfitWbAbcByPositiveValue(
        rawSizes,
        (size) => size.revenue
      );

    const provisionalProfitRows = rawSizes.map(
      (size) => {
        const share =
          rawRevenueTotal > 0
            ? Math.max(0, size.revenue) /
              rawRevenueTotal
            : rawQtyTotal > 0
              ? Math.max(0, size.netSalesQty) /
                rawQtyTotal
              : 1 / Math.max(1, rawSizes.length);

        return {
          size,
          value: row.netProfitAfterTax * share,
        };
      }
    );

    const abcByProfit =
      calculateProfitWbAbcByPositiveValue(
        provisionalProfitRows,
        (item) => item.value
      );

    const enrichedSizeRows =
      provisionalProfitRows.map((item) => {
        const size = item.size;
        const share =
          rawRevenueTotal > 0
            ? Math.max(0, size.revenue) /
              rawRevenueTotal
            : rawQtyTotal > 0
              ? Math.max(0, size.netSalesQty) /
                rawQtyTotal
              : 1 / Math.max(1, rawSizes.length);

        const allocatedRevenue = row.revenue * share;
        const allocatedSellerRetailAmount =
          row.sellerRetailAmount * share;
        const allocatedExpenses = expenses * share;
        const allocatedProfit =
          row.netProfitAfterTax * share;
        const denominator =
          size.salesQty + size.returnsQty;
        const buyoutPercent =
          denominator > 0
            ? (Math.max(0, size.netSalesQty) /
                denominator) *
              100
            : null;

        return {
          size: size.size,
          barcode: size.barcode,
          revenue: allocatedRevenue,
          sellerRetailAmount:
            allocatedSellerRetailAmount,
          netSalesQty: size.netSalesQty,
          salesQty: size.salesQty,
          returnsQty: size.returnsQty,
          expenses: allocatedExpenses,
          netProfitAfterTax: allocatedProfit,
          buyoutPercent,
          marginAfterTaxPercent:
            allocatedSellerRetailAmount > 0
              ? (allocatedProfit /
                  allocatedSellerRetailAmount) *
                100
              : allocatedRevenue > 0
                ? (allocatedProfit /
                    allocatedRevenue) *
                  100
                : 0,
          abcByRevenue:
            abcByRevenue.get(size) ?? "C",
          abcByProfit:
            abcByProfit.get(item) ?? "C",
        };
      });

    sizeRowsByVendorCode.set(
      vendorKey,
      enrichedSizeRows
    );
  }

  return normalizeJson<DashboardSnapshotProfitWb>({
    version:
      DASHBOARD_PERIOD_SNAPSHOT_PROFIT_WB_VERSION,
    companyScope: params.companyScope,
    rows: analytics.rows,
    totals: analytics.totals,
    comparison: analytics.comparison,
    productMeta: Array.from(
      metaByVendorCode.entries(),
      ([vendorKey, value]) => ({
        vendorKey,
        value,
      })
    ),
    sizeRows: Array.from(
      sizeRowsByVendorCode.entries(),
      ([vendorKey, rows]) => ({
        vendorKey,
        rows,
      })
    ),
  });
}


type ProfitOzonProductRecord = {
  vendorCode: string;
  sku: string;
  productName: string | null;
  imageUrl: string | null;
  imageSmallUrl: string | null;
};

type ProfitOzonFinanceBreakdownRecord = {
  accrualDate: Date | null;
  sku: string | null;
  vendorCode: string | null;
  quantity: number | null;
  salesAmount: unknown;
  totalAmount: unknown;
  importSessionId: string | null;
  createdAt: Date;
};

type ProfitOzonRawSkuMetric = {
  sku: string;
  vendorCode: string;
  revenue: number;
  salesQty: number;
  returnsQty: number;
  netSalesQty: number;
};

function toProfitOzonNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "toNumber" in value
  ) {
    return (
      value as { toNumber: () => number }
    ).toNumber();
  }

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function normalizeProfitOzonText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[–—−]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanProfitOzonText(value: unknown) {
  return String(value ?? "").trim();
}

function startOfProfitOzonDay(value: string) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function nextProfitOzonDayStart(value: string) {
  const date = startOfProfitOzonDay(value);
  date.setDate(date.getDate() + 1);
  return date;
}

function createProfitOzonDateWhere(
  dateFrom?: string | null,
  dateTo?: string | null
) {
  return dateFrom || dateTo
    ? {
        ...(dateFrom
          ? { gte: startOfProfitOzonDay(dateFrom) }
          : {}),
        ...(dateTo
          ? { lt: nextProfitOzonDayStart(dateTo) }
          : {}),
      }
    : undefined;
}

function parseProfitOzonVendorCode(vendorCode: string) {
  const clean = cleanProfitOzonText(vendorCode);
  const parts = clean.split(/[-_]+/).filter(Boolean);
  const sizeParts: string[] = [];

  if (
    parts.length >= 2 &&
    /^\d{2,4}$/.test(parts[parts.length - 1])
  ) {
    sizeParts.unshift(parts.pop() ?? "");

    if (
      parts.length >= 2 &&
      /^\d{2,4}$/.test(parts[parts.length - 1])
    ) {
      sizeParts.unshift(parts.pop() ?? "");
    }
  }

  return {
    sizeLabel:
      sizeParts.filter(Boolean).join(" / ") ||
      clean ||
      "SKU",
  };
}

function getProfitOzonSizeLabel(vendorCode: string) {
  return parseProfitOzonVendorCode(vendorCode).sizeLabel;
}

function buildProfitOzonProductLookup(
  products: ProfitOzonProductRecord[]
) {
  const normalizedVendorCodeBySku =
    new Map<string, string>();
  const displayVendorCodeBySku =
    new Map<string, string>();
  const productNameBySku =
    new Map<string, string>();
  const productNameByVendorCode =
    new Map<string, string>();

  for (const product of products) {
    const sku = normalizeProfitOzonText(product.sku);
    const normalizedVendorCode =
      normalizeProfitOzonText(product.vendorCode);
    const displayVendorCode =
      cleanProfitOzonText(product.vendorCode);
    const productName =
      cleanProfitOzonText(product.productName);

    if (sku && normalizedVendorCode) {
      normalizedVendorCodeBySku.set(
        sku,
        normalizedVendorCode
      );
      displayVendorCodeBySku.set(
        sku,
        displayVendorCode || normalizedVendorCode
      );
    }

    if (sku && productName) {
      productNameBySku.set(sku, productName);
    }

    if (normalizedVendorCode && productName) {
      productNameByVendorCode.set(
        normalizedVendorCode,
        productName
      );
    }
  }

  return {
    normalizedVendorCodeBySku,
    displayVendorCodeBySku,
    productNameBySku,
    productNameByVendorCode,
  };
}

function calculateProfitOzonAbcByPositiveValue<T>(
  rows: T[],
  getValue: (row: T) => number
): Map<T, "A" | "B" | "C"> {
  const result = new Map<T, "A" | "B" | "C">();

  const sorted = [...rows].sort(
    (left, right) =>
      Math.max(0, getValue(right)) -
      Math.max(0, getValue(left))
  );

  const total = sorted.reduce(
    (sum, row) => sum + Math.max(0, getValue(row)),
    0
  );

  if (total <= 0) {
    for (const row of rows) {
      result.set(row, "C");
    }

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

function getProfitOzonRowExpenses(
  row: OzonAnalyticsResult["rows"][number]
) {
  return row.revenue - row.netProfitAfterTax;
}

async function findProfitOzonFinanceRowsForBreakdown(
  params: {
    dateFrom?: string | null;
    dateTo?: string | null;
    companyName?: string | null;
  }
) {
  const accrualDateWhere = createProfitOzonDateWhere(
    params.dateFrom,
    params.dateTo
  );

  const latestRow = await prisma.ozonFinance.findFirst({
    where: {
      ...(accrualDateWhere
        ? { accrualDate: accrualDateWhere }
        : {}),
      ...(params.companyName
        ? { companyName: params.companyName }
        : {}),
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (!latestRow) {
    return [] as ProfitOzonFinanceBreakdownRecord[];
  }

  if (latestRow.importSessionId) {
    return prisma.ozonFinance.findMany({
      where: {
        importSessionId: latestRow.importSessionId,
        ...(accrualDateWhere
          ? { accrualDate: accrualDateWhere }
          : {}),
        ...(params.companyName
          ? { companyName: params.companyName }
          : {}),
      },
      select: {
        accrualDate: true,
        sku: true,
        vendorCode: true,
        quantity: true,
        salesAmount: true,
        totalAmount: true,
        importSessionId: true,
        createdAt: true,
      },
      orderBy: {
        accrualDate: "desc",
      },
    });
  }

  return prisma.ozonFinance.findMany({
    where: {
      ...(accrualDateWhere
        ? { accrualDate: accrualDateWhere }
        : {}),
      ...(params.companyName
        ? { companyName: params.companyName }
        : {}),
      createdAt: {
        gte: new Date(
          latestRow.createdAt.getTime() -
            10 * 60 * 1000
        ),
        lte: new Date(
          latestRow.createdAt.getTime() +
            10 * 60 * 1000
        ),
      },
    },
    select: {
      accrualDate: true,
      sku: true,
      vendorCode: true,
      quantity: true,
      salesAmount: true,
      totalAmount: true,
      importSessionId: true,
      createdAt: true,
    },
    orderBy: {
      accrualDate: "desc",
    },
  });
}

export async function buildProfitOzonSnapshotSection(
  params: {
    companyScope: string;
    dateFrom: string;
    dateTo: string;
  }
) {
  const analytics = await getProfitAnalyticsOzon({
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    companyName: params.companyScope,
  });

  const companyName =
    params.companyScope === "ALL"
      ? null
      : params.companyScope;

  const [financeRows, ozonProducts, productCosts] =
    await Promise.all([
      findProfitOzonFinanceRowsForBreakdown({
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        companyName,
      }),
      prisma.ozonProduct.findMany({
        where: {
          ...(companyName ? { companyName } : {}),
        },
        select: {
          vendorCode: true,
          sku: true,
          productName: true,
          imageUrl: true,
          imageSmallUrl: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      prisma.productCost.findMany({
        select: {
          vendorCode: true,
          nmId: true,
          name: true,
        },
        orderBy: {
          costDate: "desc",
        },
      }),
    ]);

  const lookup =
    buildProfitOzonProductLookup(ozonProducts);
  const metaByVendorCode = new Map<
    string,
    DashboardSnapshotProfitOzonProductMeta
  >();
  const rawSkuByVendorCode = new Map<
    string,
    Map<string, ProfitOzonRawSkuMetric>
  >();

  for (const cost of productCosts) {
    const vendorKey =
      normalizeProfitOzonText(cost.vendorCode);

    if (
      !vendorKey ||
      metaByVendorCode.has(vendorKey)
    ) {
      continue;
    }

    metaByVendorCode.set(vendorKey, {
      productName: cost.name ?? cost.vendorCode,
      subject: "Ozon",
      sku: cost.nmId ?? "",
      vendorCode: cost.vendorCode,
      imageUrl: null,
    });
  }

  for (const product of ozonProducts) {
    const vendorKey =
      normalizeProfitOzonText(product.vendorCode);

    if (!vendorKey) continue;

    const current = metaByVendorCode.get(vendorKey);

    metaByVendorCode.set(vendorKey, {
      productName:
        cleanProfitOzonText(product.productName) ||
        current?.productName ||
        product.vendorCode,
      subject: "Ozon",
      sku: product.sku || current?.sku || "",
      vendorCode:
        product.vendorCode ||
        current?.vendorCode ||
        vendorKey,
      imageUrl:
        product.imageSmallUrl ??
        product.imageUrl ??
        current?.imageUrl ??
        null,
    });
  }

  for (const financeRow of financeRows) {
    const skuKey =
      normalizeProfitOzonText(financeRow.sku);
    const directVendorCodeKey =
      normalizeProfitOzonText(financeRow.vendorCode);
    const mappedVendorCodeKey = skuKey
      ? lookup.normalizedVendorCodeBySku.get(
          skuKey
        ) ?? ""
      : "";

    const vendorKey =
      directVendorCodeKey ||
      mappedVendorCodeKey ||
      skuKey;

    if (!vendorKey) continue;

    const displayVendorCode =
      cleanProfitOzonText(financeRow.vendorCode) ||
      (skuKey
        ? lookup.displayVendorCodeBySku.get(skuKey)
        : "") ||
      cleanProfitOzonText(financeRow.sku) ||
      vendorKey;

    const productName =
      (skuKey
        ? lookup.productNameBySku.get(skuKey)
        : "") ||
      lookup.productNameByVendorCode.get(vendorKey) ||
      displayVendorCode;

    const currentMeta =
      metaByVendorCode.get(vendorKey);

    metaByVendorCode.set(vendorKey, {
      productName:
        currentMeta?.productName ||
        productName ||
        displayVendorCode,
      subject: currentMeta?.subject || "Ozon",
      sku:
        currentMeta?.sku ||
        cleanProfitOzonText(financeRow.sku),
      vendorCode:
        currentMeta?.vendorCode ||
        displayVendorCode,
      imageUrl: currentMeta?.imageUrl ?? null,
    });

    const sku =
      cleanProfitOzonText(financeRow.sku) ||
      displayVendorCode;

    const skuMap =
      rawSkuByVendorCode.get(vendorKey) ??
      new Map<string, ProfitOzonRawSkuMetric>();

    const current =
      skuMap.get(sku) ?? {
        sku,
        vendorCode: displayVendorCode,
        revenue: 0,
        salesQty: 0,
        returnsQty: 0,
        netSalesQty: 0,
      };

    const quantity = Math.abs(
      Number(financeRow.quantity ?? 0)
    );
    const revenue = toProfitOzonNumber(
      financeRow.salesAmount
    );
    const totalAmount = toProfitOzonNumber(
      financeRow.totalAmount
    );

    if (revenue > 0 || quantity > 0) {
      current.salesQty += quantity;
      current.netSalesQty += quantity;
      current.revenue += revenue;
    }

    if (revenue < 0 || totalAmount < 0) {
      current.returnsQty += quantity;
      current.netSalesQty -= quantity;
      current.revenue += revenue;
    }

    skuMap.set(sku, current);
    rawSkuByVendorCode.set(vendorKey, skuMap);
  }

  const skuRowsByVendorCode = new Map<
    string,
    DashboardSnapshotProfitOzonSkuRow[]
  >();

  for (const row of analytics.rows) {
    const vendorKey =
      normalizeProfitOzonText(row.vendorCode);
    const skuMap =
      rawSkuByVendorCode.get(vendorKey);

    if (!skuMap || skuMap.size === 0) {
      continue;
    }

    const rawSkuRows = Array.from(
      skuMap.values()
    )
      .filter(
        (skuRow) =>
          skuRow.salesQty > 0 ||
          skuRow.revenue !== 0
      )
      .sort(
        (left, right) =>
          right.revenue - left.revenue
      );

    const rawRevenueTotal = rawSkuRows.reduce(
      (sum, skuRow) =>
        sum + Math.max(0, skuRow.revenue),
      0
    );

    const rawQtyTotal = rawSkuRows.reduce(
      (sum, skuRow) =>
        sum + Math.max(0, skuRow.netSalesQty),
      0
    );

    const expenses =
      getProfitOzonRowExpenses(row);
    const abcByRevenue =
      calculateProfitOzonAbcByPositiveValue(
        rawSkuRows,
        (skuRow) => skuRow.revenue
      );

    const provisionalProfitRows =
      rawSkuRows.map((skuRow) => {
        const share =
          rawRevenueTotal > 0
            ? Math.max(0, skuRow.revenue) /
              rawRevenueTotal
            : rawQtyTotal > 0
              ? Math.max(
                  0,
                  skuRow.netSalesQty
                ) / rawQtyTotal
              : 1 /
                Math.max(1, rawSkuRows.length);

        return {
          skuRow,
          value: row.netProfitAfterTax * share,
        };
      });

    const abcByProfit =
      calculateProfitOzonAbcByPositiveValue(
        provisionalProfitRows,
        (item) => item.value
      );

    const enrichedSkuRows =
      provisionalProfitRows.map((item) => {
        const skuRow = item.skuRow;
        const share =
          rawRevenueTotal > 0
            ? Math.max(0, skuRow.revenue) /
              rawRevenueTotal
            : rawQtyTotal > 0
              ? Math.max(
                  0,
                  skuRow.netSalesQty
                ) / rawQtyTotal
              : 1 /
                Math.max(1, rawSkuRows.length);

        const allocatedRevenue =
          row.revenue * share;
        const allocatedExpenses =
          expenses * share;
        const allocatedProfit =
          row.netProfitAfterTax * share;
        const denominator =
          skuRow.salesQty + skuRow.returnsQty;
        const buyoutPercent =
          denominator > 0
            ? (Math.max(
                0,
                skuRow.netSalesQty
              ) /
                denominator) *
              100
            : null;

        return {
          sku: skuRow.sku,
          vendorCode: skuRow.vendorCode,
          sizeLabel: getProfitOzonSizeLabel(
            skuRow.vendorCode
          ),
          revenue: allocatedRevenue,
          netSalesQty: skuRow.netSalesQty,
          salesQty: skuRow.salesQty,
          returnsQty: skuRow.returnsQty,
          expenses: allocatedExpenses,
          netProfitAfterTax: allocatedProfit,
          buyoutPercent,
          marginAfterTaxPercent:
            allocatedRevenue > 0
              ? (allocatedProfit /
                  allocatedRevenue) *
                100
              : 0,
          abcByRevenue:
            abcByRevenue.get(skuRow) ?? "C",
          abcByProfit:
            abcByProfit.get(item) ?? "C",
        };
      });

    skuRowsByVendorCode.set(
      vendorKey,
      enrichedSkuRows
    );
  }

  return normalizeJson<DashboardSnapshotProfitOzon>({
    version:
      DASHBOARD_PERIOD_SNAPSHOT_PROFIT_OZON_VERSION,
    companyScope: params.companyScope,
    rows: analytics.rows,
    totals: analytics.totals,
    comparison: analytics.comparison,
    productMeta: Array.from(
      metaByVendorCode.entries(),
      ([vendorKey, value]) => ({
        vendorKey,
        value,
      })
    ),
    skuRows: Array.from(
      skuRowsByVendorCode.entries(),
      ([vendorKey, rows]) => ({
        vendorKey,
        rows,
      })
    ),
  });
}

function normalizeJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getCoverageStatus(dataReadiness: unknown) {
  if (!dataReadiness || typeof dataReadiness !== "object") {
    return "UNKNOWN";
  }

  const status = (dataReadiness as { status?: unknown }).status;
  return String(status ?? "UNKNOWN").toUpperCase();
}

export async function buildDashboardPeriodSnapshotPayload(params: {
  companyScope: string;
  dateFrom: string;
  dateTo: string;
}) {
  const startedAt = Date.now();
  const ownerReport = await buildDailyReport({
    from: params.dateFrom,
    to: params.dateTo,
    skipComparison: true,
  });

  const selectedCompanies =
    params.companyScope === "ALL"
      ? ownerReport.companies
      : ownerReport.companies.filter(
          (company) => company.companyName === params.companyScope
        );

  const companyRows: DashboardSnapshotCompanyRow[] = [];

  for (const companyReport of selectedCompanies) {
    const cash = await getFinanceCashResult({
      companyName: companyReport.companyName,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    });

    const ordersQty =
      companyReport.wb.ordersQty + companyReport.ozon.ordersQty;
    const ordersAmount =
      companyReport.wb.ordersAmount + companyReport.ozon.ordersAmount;
    const orderDataLoadedDays =
      companyReport.wb.orderDataLoadedDays +
      companyReport.ozon.orderDataLoadedDays;
    const orderDataExpectedDays =
      companyReport.wb.orderDataExpectedDays +
      companyReport.ozon.orderDataExpectedDays;
    const wbRevenue = marketplaceManagementRevenue(companyReport.wb);
    const wbNetProfitAfterTax = companyReport.wb.netProfitAfterTax;
    const wbAdsCost = companyReport.wb.adSpend;
    const ozonRevenue = marketplaceManagementRevenue(companyReport.ozon);
    const ozonNetProfitAfterTax = companyReport.ozon.netProfitAfterTax;
    const ozonAdsCost = companyReport.ozon.adSpend;
    const totalRevenue =
      wbRevenue == null || ozonRevenue == null ? null : wbRevenue + ozonRevenue;
    const financeImpact = companyReport.finance.netProfitImpact;
    const personalExpenses = companyReport.finance.ownerWithdrawals;
    const partialFinancial =
      companyReport.wb.financialUnavailable === true ||
      companyReport.ozon.financialUnavailable === true;
    const combinedProfit = snapshotCombinedProfit({
      wbFinancialUnavailable: companyReport.wb.financialUnavailable === true,
      ozonFinancialUnavailable: companyReport.ozon.financialUnavailable === true,
      wbNet: wbNetProfitAfterTax,
      ozonNet: ozonNetProfitAfterTax,
      financeImpact,
      ownerWithdrawals: personalExpenses,
    });
    const operatingProfitAfterTax = partialFinancial
      ? null
      : combinedProfit.operatingProfitAfterTax;
    const netProfit = partialFinancial ? null : combinedProfit.netProfit;
    const profitAfterOwnerWithdrawal = partialFinancial
      ? null
      : combinedProfit.profitAfterOwnerWithdrawal;
    const cashFlowResult = companyReport.finance.netCashFlow;
    const adsCost = wbAdsCost + ozonAdsCost;

    companyRows.push({
      companyName: companyReport.companyName,
      ordersQty,
      ordersAmount,
      orderDataLoadedDays,
      orderDataExpectedDays,
      wbRevenue,
      ozonRevenue,
      totalRevenue,
      operatingProfitAfterTax,
      netProfit,
      profitAfterOwnerWithdrawal,
      cashFlowResult,
      adsCost,
      wbAdsCost,
      ozonAdsCost,
      drr: totalRevenue != null && totalRevenue > 0 ? (adsCost / totalRevenue) * 100 : null,
      drrByOrders:
        ordersAmount > 0 ? (adsCost / ordersAmount) * 100 : null,
      loanPayments: cash.loanPayments,
      creditPrincipal: cash.creditPrincipal,
      creditInterest: cash.creditInterest,
      personalExpenses,
      financialExpenses: cash.financialExpenses,
      cashOnlyExpenses: cash.cashOnlyExpenses,
      wbStockQty: companyReport.wb.stockQty,
      ozonStockQty: companyReport.ozon.stockQty,
      warehouseStockQty: 0,
      wbAbcA: 0,
      wbAbcB: 0,
      wbAbcC: 0,
      ozonAbcA: 0,
      ozonAbcB: 0,
      ozonAbcC: 0,
    });
  }

  const summary = summarizeDashboardRows(companyRows);
  const dailyPoints = await getDashboardDailyAnalytics({
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    companyName:
      params.companyScope === "ALL" ? null : params.companyScope,
    expectedTotals: createDailyExpectedTotals(summary),
  });

  const profitWb = await buildProfitWbSnapshotSection({
    companyScope: params.companyScope,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
  });

  const profitOzon = await buildProfitOzonSnapshotSection({
    companyScope: params.companyScope,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
  });

  const activeCompanies = await prisma.company.findMany({
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

  const insights = await buildInsightsSnapshot({
    companyNames:
      params.companyScope === "ALL"
        ? activeCompanies.map((company) => company.name)
        : [params.companyScope],
    companyScope: params.companyScope,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
  });

  const payload = normalizeJson<DashboardPeriodSnapshotPayload>({
    formulaVersion: DASHBOARD_PERIOD_SNAPSHOT_FORMULA_VERSION,
    companyScope: params.companyScope,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    generatedAt: new Date().toISOString(),
    periodLabel: ownerReport.periodLabel,
    dateLabel: ownerReport.dateLabel,
    companyRows: summary.companyRows,
    summary,
    dailyPoints,
    insights,
    profitWb,
    profitOzon,
    warnings: ownerReport.warnings,
    dataReadiness: ownerReport.dataReadiness,
  });

  const serialized = JSON.stringify(payload);
  const payloadChecksum = createHash("sha256")
    .update(serialized)
    .digest("hex");

  return {
    payload,
    payloadChecksum,
    sourceFingerprint: payloadChecksum,
    coverageStatus: getCoverageStatus(ownerReport.dataReadiness),
    rowsCount: summary.companyRows.length,
    calculationMs: Date.now() - startedAt,
  };
}
