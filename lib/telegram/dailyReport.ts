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
  adSpend: number;
  drr: number;
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
    drr: number;
    stockQty: number;
    cashIncome: number;
    cashOutflow: number;
    netCashFlow: number;
    netProfitImpact: number;
    ownerWithdrawals: number;
  };
  warnings: string[];
};

const MARKETPLACE_TABLES = {
  wbSales: "WbSale",
  wbAds: "WbAds",
  wbStock: "WbStock",
  ozonFinance: "OzonFinance",
  ozonAds: "OzonAds",
  ozonStock: "OzonStock",
};

const DATE_COLUMN_CANDIDATES = [
  "operationDate",
  "date",
  "reportDate",
  "saleDate",
  "dateSale",
  "orderDate",
  "createdAt",
  "dateFrom",
  "accrualDate",
  "postingDate",
  "day",
];

const WB_SALES_AMOUNT_CANDIDATES = [
  "forPay",
  "forPaySum",
  "retailAmount",
  "retailPriceWithDiscRub",
  "finishedPrice",
  "priceWithDisc",
  "totalPrice",
  "amount",
  "sum",
];

const OZON_SALES_AMOUNT_CANDIDATES = [
  "total",
  "amount",
  "sellerAmount",
  "accrualAmount",
  "payout",
  "totalAmount",
  "price",
  "rub",
];

const ADS_AMOUNT_CANDIDATES = [
  "cost",
  "spent",
  "expense",
  "expenses",
  "adSpend",
  "sum",
  "amount",
  "moneySpent",
  "spentRub",
];

const WB_STOCK_CANDIDATES = [
  "totalStock",
  "inTransitToCustomer",
  "inTransitReturns",
  "quantity",
  "qty",
  "stock",
];

const OZON_STOCK_CANDIDATES = [
  "availableStock",
  "availableQty",
  "stock",
  "quantity",
  "qty",
  "available",
  "present",
];

function safeNumber(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
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

async function getTableColumns(tableName: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
    `
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = $1
    `,
    tableName
  );

  return rows.map((row) => row.column_name);
}

async function tableExists(tableName: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `
      select exists (
        select 1
        from information_schema.tables
        where table_schema = 'public'
          and table_name = $1
      ) as "exists"
    `,
    tableName
  );

  return Boolean(rows[0]?.exists);
}

function pickColumn(columns: string[], candidates: string[]) {
  const normalized = new Map(
    columns.map((column) => [column.toLowerCase(), column])
  );

  for (const candidate of candidates) {
    const exact = columns.find((column) => column === candidate);
    if (exact) return exact;

    const lower = normalized.get(candidate.toLowerCase());
    if (lower) return lower;
  }

  return null;
}

function numericExpression(columnName: string) {
  const column = quoteIdentifier(columnName);

  return `
    coalesce(
      nullif(
        regexp_replace(
          replace(cast(${column} as text), ',', '.'),
          '[^0-9\\.-]',
          '',
          'g'
        ),
        ''
      )::numeric,
      0
    )
  `;
}

async function queryDailyTableMetrics(params: {
  tableName: string;
  companyName: string;
  range: DateRange;
  amountCandidates: string[];
}) {
  const exists = await tableExists(params.tableName);

  if (!exists) {
    return {
      qty: 0,
      amount: 0,
      usedDateColumn: null as string | null,
      usedAmountColumn: null as string | null,
    };
  }

  const columns = await getTableColumns(params.tableName);
  const dateColumn = pickColumn(columns, DATE_COLUMN_CANDIDATES);
  const amountColumn = pickColumn(columns, params.amountCandidates);
  const companyColumn = pickColumn(columns, ["companyName"]);

  if (!dateColumn || !companyColumn) {
    return {
      qty: 0,
      amount: 0,
      usedDateColumn: dateColumn,
      usedAmountColumn: amountColumn,
    };
  }

  const amountSql = amountColumn ? `sum(${numericExpression(amountColumn)})` : "0";

  const rows = await prisma.$queryRawUnsafe<Array<{ qty: unknown; amount: unknown }>>(
    `
      select
        count(*)::int as qty,
        ${amountSql} as amount
      from ${quoteIdentifier(params.tableName)}
      where ${quoteIdentifier(companyColumn)} = $1
        and ${quoteIdentifier(dateColumn)} >= $2
        and ${quoteIdentifier(dateColumn)} < $3
    `,
    params.companyName,
    params.range.dateFrom,
    params.range.dateToExclusive
  );

  return {
    qty: safeNumber(rows[0]?.qty),
    amount: safeNumber(rows[0]?.amount),
    usedDateColumn: dateColumn,
    usedAmountColumn: amountColumn,
  };
}

async function getLatestStockQty(params: {
  tableName: string;
  reportType: string;
  companyName: string;
  stockCandidates: string[];
  wbTotalOnly?: boolean;
}) {
  const exists = await tableExists(params.tableName);

  if (!exists) return 0;

  const latestStockImport = await prisma.importSession.findFirst({
    where: {
      companyName: params.companyName,
      reportType: params.reportType,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (!latestStockImport) return 0;

  const columns = await getTableColumns(params.tableName);
  const importSessionColumn = pickColumn(columns, ["importSessionId"]);
  const companyColumn = pickColumn(columns, ["companyName"]);
  const stockColumns = params.stockCandidates.filter((candidate) =>
    columns.some((column) => column.toLowerCase() === candidate.toLowerCase())
  );

  if (!importSessionColumn || !companyColumn || stockColumns.length === 0) {
    return 0;
  }

  const stockExpression = stockColumns
    .map((column) => numericExpression(column))
    .join(" + ");

  const warehouseColumn = pickColumn(columns, ["warehouseName"]);
  const totalFilter =
    params.wbTotalOnly && warehouseColumn
      ? `and ${quoteIdentifier(warehouseColumn)} = '__TOTAL__'`
      : "";

  const rows = await prisma.$queryRawUnsafe<Array<{ qty: unknown }>>(
    `
      select sum(${stockExpression}) as qty
      from ${quoteIdentifier(params.tableName)}
      where ${quoteIdentifier(companyColumn)} = $1
        and ${quoteIdentifier(importSessionColumn)} = $2
        ${totalFilter}
    `,
    params.companyName,
    latestStockImport.id
  );

  return safeNumber(rows[0]?.qty);
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

function calculateDrr(adSpend: number, salesAmount: number) {
  if (salesAmount <= 0) return 0;
  return (adSpend / salesAmount) * 100;
}

async function getWbMetrics(companyName: string, range: DateRange) {
  const [sales, ads, stockQty] = await Promise.all([
    queryDailyTableMetrics({
      tableName: MARKETPLACE_TABLES.wbSales,
      companyName,
      range,
      amountCandidates: WB_SALES_AMOUNT_CANDIDATES,
    }),
    queryDailyTableMetrics({
      tableName: MARKETPLACE_TABLES.wbAds,
      companyName,
      range,
      amountCandidates: ADS_AMOUNT_CANDIDATES,
    }),
    getLatestStockQty({
      tableName: MARKETPLACE_TABLES.wbStock,
      reportType: "WB_STOCK",
      companyName,
      stockCandidates: WB_STOCK_CANDIDATES,
      wbTotalOnly: true,
    }),
  ]);

  return {
    marketplace: "WB" as const,
    ordersQty: sales.qty,
    ordersAmount: sales.amount,
    salesQty: sales.qty,
    salesAmount: sales.amount,
    adSpend: ads.amount,
    drr: calculateDrr(ads.amount, sales.amount),
    stockQty,
  };
}

async function getOzonMetrics(companyName: string, range: DateRange) {
  const [sales, ads, stockQty] = await Promise.all([
    queryDailyTableMetrics({
      tableName: MARKETPLACE_TABLES.ozonFinance,
      companyName,
      range,
      amountCandidates: OZON_SALES_AMOUNT_CANDIDATES,
    }),
    queryDailyTableMetrics({
      tableName: MARKETPLACE_TABLES.ozonAds,
      companyName,
      range,
      amountCandidates: ADS_AMOUNT_CANDIDATES,
    }),
    getLatestStockQty({
      tableName: MARKETPLACE_TABLES.ozonStock,
      reportType: "OZON_STOCK",
      companyName,
      stockCandidates: OZON_STOCK_CANDIDATES,
    }),
  ]);

  return {
    marketplace: "OZON" as const,
    ordersQty: sales.qty,
    ordersAmount: sales.amount,
    salesQty: sales.qty,
    salesAmount: sales.amount,
    adSpend: ads.amount,
    drr: calculateDrr(ads.amount, sales.amount),
    stockQty,
  };
}

function addMarketplaceTotals(target: DailyReport["totals"], source: MarketplaceDailyMetrics) {
  target.ordersQty += source.ordersQty;
  target.ordersAmount += source.ordersAmount;
  target.salesQty += source.salesQty;
  target.salesAmount += source.salesAmount;
  target.adSpend += source.adSpend;
  target.stockQty += source.stockQty;
}

function buildWarnings(report: DailyReport) {
  const warnings: string[] = [];

  if (report.totals.salesAmount <= 0) {
    warnings.push("нет продаж/выкупов за день");
  }

  if (report.totals.drr > 20) {
    warnings.push(`ДРР выше 20%: ${formatPercent(report.totals.drr)}`);
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
      drr: 0,
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

  report.totals.drr = calculateDrr(
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

function marketplaceLine(label: string, metrics: MarketplaceDailyMetrics) {
  return [
    `${label}`,
    `Заказы: ${formatNumber(metrics.ordersQty)} шт / ${formatMoney(
      metrics.ordersAmount
    )}`,
    `Продажи: ${formatNumber(metrics.salesQty)} шт / ${formatMoney(
      metrics.salesAmount
    )}`,
    `Реклама: ${formatMoney(metrics.adSpend)} · ДРР ${formatPercent(metrics.drr)}`,
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
    `Продажи: ${formatNumber(report.totals.salesQty)} шт / ${formatMoney(
      report.totals.salesAmount
    )}`,
    `Реклама: ${formatMoney(report.totals.adSpend)} · ДРР ${formatPercent(
      report.totals.drr
    )}`,
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
