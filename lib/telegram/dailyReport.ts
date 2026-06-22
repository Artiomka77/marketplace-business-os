import { prisma } from "@/lib/prisma";
import { calculateFinanceMetricsForRows } from "@/lib/finance/financeMetrics";

export type DailyReportPeriodPreset =
  | "yesterday"
  | "3d"
  | "7d"
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
  salesQty: number;
  salesAmount: number;
  salesLabel: string;
  salesQtyIsReliable: boolean;
  adSpend: number;
  adSpendSource: string;
  drrByOrders: number;
  drrBySales: number;
  stockQty: number;
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

  const preset = params?.preset ?? "yesterday";

  if (preset === "3d") {
    return makeMoscowRange({
      days: 3,
      label: "Последние 3 дня",
      now: params?.now,
    });
  }

  if (preset === "7d") {
    return makeMoscowRange({
      days: 7,
      label: "Последние 7 дней",
      now: params?.now,
    });
  }

  if (preset === "30d") {
    return makeMoscowRange({
      days: 30,
      label: "Последние 30 дней",
      now: params?.now,
    });
  }

  if (preset === "90d") {
    return makeMoscowRange({
      days: 90,
      label: "Последние 3 месяца",
      now: params?.now,
    });
  }

  if (preset === "365d") {
    return makeMoscowRange({
      days: 365,
      label: "Последний год",
      now: params?.now,
    });
  }

  return makeMoscowRange({
    days: 1,
    label: "Предыдущий день",
    now: params?.now,
  });
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

async function getLatestWbStockQty(companyName: string) {
  const latestStockImport = await prisma.importSession.findFirst({
    where: {
      companyName,
      reportType: "WB_STOCK",
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  const rows = await prisma.wbStock.findMany({
    where: {
      companyName,
      ...(latestStockImport ? { importSessionId: latestStockImport.id } : {}),
      warehouseName: "__TOTAL__",
    },
  });

  return rows.reduce(
    (sum, row) =>
      sum +
      toNumber(row.inTransitToCustomer) +
      toNumber(row.inTransitReturns) +
      toNumber(row.totalStock),
    0
  );
}

async function getLatestOzonStockQty(companyName: string) {
  const latestStockImport = await prisma.importSession.findFirst({
    where: {
      companyName,
      reportType: "OZON_STOCK",
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  const rows = await prisma.ozonStock.findMany({
    where: {
      companyName,
      ...(latestStockImport ? { importSessionId: latestStockImport.id } : {}),
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
      ordersQty: true,
      ordersAmount: true,
    },
  });

  return rows.reduce(
    (acc, row) => {
      acc.ordersQty += Number(row.ordersQty ?? 0);
      acc.ordersAmount += toNumber(row.ordersAmount);
      return acc;
    },
    {
      ordersQty: 0,
      ordersAmount: 0,
    }
  );
}

function calculateDrr(adSpend: number, salesAmount: number) {
  if (salesAmount <= 0) return 0;
  return (adSpend / salesAmount) * 100;
}

async function getWbMetrics(companyName: string, range: DateRange) {
  const [orderStats, salesRows, adsRowsRaw, stockQty] = await Promise.all([
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
        paymentReason: true,
        quantity: true,
        wbRealizedAmount: true,
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
  ]);

  let salesQty = 0;
  let salesAmount = 0;

  for (const row of salesRows) {
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

  const adsRows = keepLatestWbAdsRowsPerDate(adsRowsRaw);
  const adSpend = adsRows.reduce((sum, row) => sum + toNumber(row.spend), 0);

  return {
    marketplace: "WB" as const,
    ordersQty: orderStats.ordersQty,
    ordersAmount: orderStats.ordersAmount,
    salesQty,
    salesAmount,
    salesLabel: "Продажи/выкупы",
    salesQtyIsReliable: true,
    adSpend,
    adSpendSource: "WB Ads",
    drrByOrders: calculateDrr(adSpend, orderStats.ordersAmount),
    drrBySales: calculateDrr(adSpend, salesAmount),
    stockQty,
  };
}

async function getOzonMetrics(companyName: string, range: DateRange) {
  const [orderStats, financeRows, adsRowsRaw, stockQty] = await Promise.all([
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
  ]);

  let salesQty = 0;
  let salesAmount = 0;

  for (const row of financeRows) {
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

  // Для управленческого отчёта берём фактические рекламные списания из Ozon Finance,
  // если они есть. Performance API оставляем как fallback, чтобы не задвоить CPC/CPO.
  const adSpend =
    financeAdSpend > 0 ? financeAdSpend : performanceAdSpend;
  const adSpendSource =
    financeAdSpend > 0 ? "Ozon Finance Ads" : "Ozon Performance Ads";

  return {
    marketplace: "OZON" as const,
    ordersQty: orderStats.ordersQty,
    ordersAmount: orderStats.ordersAmount,
    salesQty: 0,
    salesAmount,
    salesLabel: "Начисления",
    salesQtyIsReliable: false,
    adSpend,
    adSpendSource,
    drrByOrders: calculateDrr(adSpend, orderStats.ordersAmount),
    drrBySales: calculateDrr(adSpend, salesAmount),
    stockQty,
  };
}

function addMarketplaceTotals(
  target: DailyReport["totals"],
  source: MarketplaceDailyMetrics
) {
  target.ordersQty += source.ordersQty;
  target.ordersAmount += source.ordersAmount;
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
      `отрицательное влияние на чистую прибыль: ${formatMoney(
        report.totals.netProfitImpact
      )}`
    );
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

  for (const company of companies) {
    const [wb, ozon, finance] = await Promise.all([
      getWbMetrics(company.name, range),
      getOzonMetrics(company.name, range),
      getFinanceMetricsForCompany({
        companyName: company.name,
        range,
      }),
    ]);

    report.companies.push({
      companyName: company.name,
      wb,
      ozon,
      finance,
    });

    addMarketplaceTotals(report.totals, wb);
    addMarketplaceTotals(report.totals, ozon);

    report.totals.cashIncome += finance.cashIncome;
    report.totals.cashOutflow += finance.cashOutflow;
    report.totals.netCashFlow += finance.netCashFlow;
    report.totals.netProfitImpact += finance.netProfitImpact;
    report.totals.ownerWithdrawals += finance.ownerWithdrawals;
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
  if (metrics.salesQtyIsReliable) {
    return `${metrics.salesLabel}: ${formatNumber(metrics.salesQty)} шт / ${formatMoney(
      metrics.salesAmount
    )}`;
  }

  return `${metrics.salesLabel}: ${formatMoney(metrics.salesAmount)}`;
}

function marketplaceLine(label: string, metrics: MarketplaceDailyMetrics) {
  return [
    `${label}`,
    `Заказы: ${formatNumber(metrics.ordersQty)} шт / ${formatMoney(
      metrics.ordersAmount
    )}`,
    marketplaceSalesLine(metrics),
    `Реклама: ${formatMoney(metrics.adSpend)}`,
    `ДРР: от заказов ${formatPercent(metrics.drrByOrders)} (от продаж/начислений ${formatPercent(
      metrics.drrBySales
    )})`,
    `Остатки: ${formatNumber(metrics.stockQty)} шт`,
  ].join("\n");
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
