import Link from "next/link";
import type { ReactNode } from "react";

import { prisma } from "@/lib/prisma";
import { getProfitAnalytics } from "@/lib/analytics/profitAnalytics";
import { getDefaultLastCompletedWeekRange } from "@/lib/date/defaultPeriod";

type SortKey =
  | "revenue"
  | "netSalesQty"
  | "expenses"
  | "netProfitAfterTax"
  | "buyoutPercent"
  | "marginAfterTaxPercent"
  | "adsCost"
  | "drrPercent";

type SortDir = "asc" | "desc";
type AbcFilter = "ALL" | "A" | "B" | "C" | "LOSS";

type ProfitAnalyticsResult = Awaited<ReturnType<typeof getProfitAnalytics>>;
type ProfitRow = ProfitAnalyticsResult["rows"][number];

type SearchParams = {
  dateFrom?: string;
  dateTo?: string;
  companyName?: string;
  sort?: string;
  dir?: string;
  q?: string;
  abc?: string;
  pageSize?: string;
};

type ProductMeta = {
  productName: string;
  subject: string;
  nmId: string;
  vendorCode: string;
  imageUrl?: string | null;
};

type SizeBreakdownRow = {
  size: string;
  barcode: string;
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

type RawSizeMetric = {
  size: string;
  barcode: string;
  revenue: number;
  salesQty: number;
  returnsQty: number;
  netSalesQty: number;
};

type EnrichedProfitRow = ProfitRow & {
  abcByRevenue: "A" | "B" | "C";
  productMeta: ProductMeta;
  sizeRows: SizeBreakdownRow[];
};

function getDefaultDateRange() {
  return getDefaultLastCompletedWeekRange();
}
const DEFAULT_PAGE_SIZE = 15;
const PAGE_SIZE_OPTIONS = [10, 15, 20, 30, 50];

const ABC_FILTERS: { key: AbcFilter; label: string }[] = [
  { key: "ALL", label: "Все" },
  { key: "A", label: "A" },
  { key: "B", label: "B" },
  { key: "C", label: "C" },
  { key: "LOSS", label: "Убыточные" },
];

function toNumber(value: unknown): number {
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

function normalizeText(value: unknown) {
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

function createDateFilterFromStrings(dateFrom?: string | null, dateTo?: string | null) {
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

function isSaleOperation(reason: string) {
  const value = normalizeText(reason);
  return value === "продажа" || value === "сторно возвратов";
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatCompactMoney(value: number) {
  const safe = Number.isFinite(value) ? value : 0;

  if (Math.abs(safe) >= 1_000_000) {
    return `${(safe / 1_000_000).toFixed(1).replace(".", ",")} млн ₽`;
  }

  if (Math.abs(safe) >= 1_000) {
    return `${Math.round(safe / 1_000).toLocaleString("ru-RU")} тыс. ₽`;
  }

  return formatMoney(safe);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}

function formatDateRu(value: string) {
  const date = new Date(`${value}T00:00:00`);
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function formatDeltaPercent(value: number, inverse = false) {
  if (!Number.isFinite(value) || value === 0) {
    return {
      text: "0.0%",
      className: "text-slate-500",
    };
  }

  const isGood = inverse ? value < 0 : value > 0;
  const sign = value > 0 ? "+" : "";

  return {
    text: `${sign}${value.toFixed(1)}%`,
    className: isGood ? "text-emerald-600" : "text-red-600",
  };
}

function formatShare(value: number, total: number, label = "от выручки") {
  if (!total || total <= 0) return `0.0% ${label}`;
  return `${((value / total) * 100).toFixed(1)}% ${label}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function profitTextColor(value: number) {
  if (value < 0) return "text-red-600";
  return "text-emerald-600";
}

function metricBarColor(value: number) {
  if (value < 0) return "bg-red-500";
  if (value < 10) return "bg-orange-400";
  return "bg-emerald-500";
}

function rowExpenses(row: ProfitRow) {
  return row.revenue - row.netProfitAfterTax;
}

function rowBuyoutPercent(row: ProfitRow) {
  const denominator = row.salesQty + row.returnsQty;
  if (denominator <= 0) return null;
  return (Math.max(0, row.netSalesQty) / denominator) * 100;
}

function calculateAbcByPositiveValue<T>(
  rows: T[],
  getValue: (row: T) => number
): Map<T, "A" | "B" | "C"> {
  const result = new Map<T, "A" | "B" | "C">();

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

function getSortValue(row: EnrichedProfitRow, sortKey: SortKey) {
  if (sortKey === "expenses") return rowExpenses(row);
  if (sortKey === "buyoutPercent") return rowBuyoutPercent(row) ?? -1;

  return Number(row[sortKey] ?? 0);
}

function buildQueryHref(
  params: SearchParams,
  patch: Partial<SearchParams & { abc: AbcFilter; sort: SortKey; dir: SortDir }>
) {
  const query = new URLSearchParams();

  const next = {
    dateFrom: params.dateFrom ?? getDefaultDateRange().dateFrom,
    dateTo: params.dateTo ?? getDefaultDateRange().dateTo,
    companyName: params.companyName ?? "ALL",
    sort: params.sort ?? "netProfitAfterTax",
    dir: params.dir ?? "desc",
    q: params.q ?? "",
    abc: params.abc ?? "ALL",
    pageSize: params.pageSize ?? String(DEFAULT_PAGE_SIZE),
    ...patch,
  };

  query.set("dateFrom", next.dateFrom);
  query.set("dateTo", next.dateTo);
  query.set("companyName", next.companyName);
  query.set("sort", next.sort);
  query.set("dir", next.dir);
  query.set("abc", next.abc);
  query.set("pageSize", next.pageSize);

  if (next.q) query.set("q", next.q);

  return `/profit-wb?${query.toString()}`;
}

function getSortLabel(sort: SortKey) {
  const labels: Record<SortKey, string> = {
    revenue: "выручке",
    netSalesQty: "количеству",
    expenses: "расходам",
    netProfitAfterTax: "прибыли",
    buyoutPercent: "проценту выкупа",
    marginAfterTaxPercent: "маржинальности",
    adsCost: "рекламе",
    drrPercent: "ДРР",
  };

  return labels[sort] ?? "прибыли";
}

function getCompanyLabel(companyName: string) {
  if (companyName === "ALL") return "Все компании";
  return companyName;
}

async function findWbSaleRowsForBreakdown(params: {
  dateFrom?: string | null;
  dateTo?: string | null;
  companyName?: string | null;
}) {
  const dateFilter = createDateFilterFromStrings(params.dateFrom, params.dateTo);

  const financeRows = await prisma.wbFinance.findMany({
    where: {
      ...dateFilter,
      ...(params.companyName ? { companyName: params.companyName } : {}),
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
        ...(params.companyName ? { companyName: params.companyName } : {}),
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

    const latestImportSessionIds = Array.from(latestSessionByFileName.values());

    if (latestImportSessionIds.length > 0) {
      return prisma.wbSale.findMany({
        where: {
          ...(params.companyName ? { companyName: params.companyName } : {}),
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
      ...(params.companyName ? { companyName: params.companyName } : {}),
      ...(params.dateFrom || params.dateTo
        ? {
            saleDate: {
              ...(params.dateFrom ? { gte: startOfDay(params.dateFrom) } : {}),
              ...(params.dateTo ? { lt: nextDayStart(params.dateTo) } : {}),
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

async function buildProductMetaAndSizeRows(params: {
  rows: ProfitRow[];
  dateFrom: string;
  dateTo: string;
  companyName: string;
}) {
  const companyName = params.companyName === "ALL" ? null : params.companyName;

  const rowNmIds = Array.from(
    new Set(
      params.rows
        .map((row) => String(row.nmId ?? "").trim())
        .filter(Boolean)
    )
  );

  const rowVendorCodes = Array.from(
    new Set(
      params.rows
        .map((row) => String(row.vendorCode ?? "").trim())
        .filter(Boolean)
    )
  );

  const productCardWhere =
    rowNmIds.length > 0 || rowVendorCodes.length > 0
      ? {
          ...(companyName ? { companyName } : {}),
          OR: [
            ...(rowNmIds.length > 0 ? [{ nmId: { in: rowNmIds } }] : []),
            ...(rowVendorCodes.length > 0
              ? [{ vendorCode: { in: rowVendorCodes } }]
              : []),
          ],
        }
      : {
          ...(companyName ? { companyName } : {}),
        };

  const [salesRows, productCosts, productCards] = await Promise.all([
    findWbSaleRowsForBreakdown({
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

  const metaByVendorCode = new Map<string, ProductMeta>();
  const rawSizesByVendorCode = new Map<string, Map<string, RawSizeMetric>>();

  for (const card of productCards) {
    const key = normalizeText(card.vendorCode || card.nmId);

    if (!key) continue;

    metaByVendorCode.set(key, {
      productName: card.title ?? card.vendorCode ?? card.nmId,
      subject: card.subjectName ?? "",
      nmId: card.nmId,
      vendorCode: card.vendorCode ?? "",
      imageUrl: card.photoSmallUrl ?? card.photoBigUrl,
    });
  }

  for (const cost of productCosts) {
    const key = normalizeText(cost.vendorCode);
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
    const vendorKey = normalizeText(vendorCode);
    if (!vendorKey) continue;

    const currentMeta = metaByVendorCode.get(vendorKey);

    metaByVendorCode.set(vendorKey, {
      productName:
        currentMeta?.productName && currentMeta.productName !== currentMeta.vendorCode
          ? currentMeta.productName
          : sale.productName || sale.subject || vendorCode,
      subject: currentMeta?.subject || sale.subject || "",
      nmId: currentMeta?.nmId || sale.nmId || "",
      vendorCode: currentMeta?.vendorCode || sale.vendorCode || vendorCode,
      imageUrl: currentMeta?.imageUrl ?? null,
    });

    const size = String(sale.size ?? "Без размера").trim() || "Без размера";
    const barcode = String(sale.barcode ?? "").trim();
    const sizeKey = `${size}__${barcode}`;

    const sizeMap = rawSizesByVendorCode.get(vendorKey) ?? new Map<string, RawSizeMetric>();

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

    const paymentReason = normalizeText(sale.paymentReason);
    const quantity = Math.abs(Number(sale.quantity ?? 0));
    const revenue = toNumber(sale.wbRealizedAmount);

    if (isSaleOperation(paymentReason)) {
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

  const sizeRowsByVendorCode = new Map<string, SizeBreakdownRow[]>();

  for (const row of params.rows) {
    const vendorKey = normalizeText(row.vendorCode);
    const sizeMap = rawSizesByVendorCode.get(vendorKey);

    if (!sizeMap || sizeMap.size === 0) {
      continue;
    }

    const rawSizes = Array.from(sizeMap.values())
      .filter((size) => size.salesQty > 0 || size.revenue > 0 || size.netSalesQty > 0)
      .sort((a, b) => b.revenue - a.revenue);

    const rawRevenueTotal = rawSizes.reduce(
      (sum, size) => sum + Math.max(0, size.revenue),
      0
    );

    const rawQtyTotal = rawSizes.reduce(
      (sum, size) => sum + Math.max(0, size.netSalesQty),
      0
    );

    const expenses = rowExpenses(row);
    const abcByRevenue = calculateAbcByPositiveValue(rawSizes, (size) => size.revenue);
    const provisionalProfitRows = rawSizes.map((size) => {
      const share =
        rawRevenueTotal > 0
          ? Math.max(0, size.revenue) / rawRevenueTotal
          : rawQtyTotal > 0
            ? Math.max(0, size.netSalesQty) / rawQtyTotal
            : 1 / Math.max(1, rawSizes.length);

      return {
        size,
        value: row.netProfitAfterTax * share,
      };
    });

    const abcByProfit = calculateAbcByPositiveValue(
      provisionalProfitRows,
      (item) => item.value
    );

    const enrichedSizeRows = provisionalProfitRows.map((item) => {
      const size = item.size;
      const share =
        rawRevenueTotal > 0
          ? Math.max(0, size.revenue) / rawRevenueTotal
          : rawQtyTotal > 0
            ? Math.max(0, size.netSalesQty) / rawQtyTotal
            : 1 / Math.max(1, rawSizes.length);

      const allocatedRevenue = row.revenue * share;
      const allocatedExpenses = expenses * share;
      const allocatedProfit = row.netProfitAfterTax * share;
      const denominator = size.salesQty + size.returnsQty;
      const buyoutPercent =
        denominator > 0 ? (Math.max(0, size.netSalesQty) / denominator) * 100 : null;

      return {
        size: size.size,
        barcode: size.barcode,
        revenue: allocatedRevenue,
        netSalesQty: size.netSalesQty,
        salesQty: size.salesQty,
        returnsQty: size.returnsQty,
        expenses: allocatedExpenses,
        netProfitAfterTax: allocatedProfit,
        buyoutPercent,
        marginAfterTaxPercent:
          allocatedRevenue > 0 ? (allocatedProfit / allocatedRevenue) * 100 : 0,
        abcByRevenue: abcByRevenue.get(size) ?? "C",
        abcByProfit: abcByProfit.get(item) ?? "C",
      };
    });

    sizeRowsByVendorCode.set(vendorKey, enrichedSizeRows);
  }

  return {
    metaByVendorCode,
    sizeRowsByVendorCode,
  };
}

function MiniTrendLine({
  points,
  tone = "indigo",
}: {
  points?: number[];
  tone?: "indigo" | "emerald" | "red" | "orange";
}) {
  const values = points && points.length >= 2 ? points : [8, 14, 10, 18, 16, 24, 20, 28];
  const width = 88;
  const height = 40;
  const padding = 4;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const linePoints = values
    .map((value, index) => {
      const x = padding + (index * (width - padding * 2)) / (values.length - 1);
      const y = height - padding - ((value - min) / range) * (height - padding * 2);
      return `${x},${y}`;
    })
    .join(" ");

  const areaPoints = `${padding},${height - padding} ${linePoints} ${width - padding},${height - padding}`;

  const stroke =
    tone === "emerald"
      ? "#10b981"
      : tone === "red"
        ? "#ef4444"
        : tone === "orange"
          ? "#f97316"
          : "#7c3aed";

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-10 w-24 shrink-0">
      <path d={`M ${areaPoints}`} fill={stroke} fillOpacity="0.08" />
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={linePoints}
      />
      {linePoints ? (
        <circle
          cx={linePoints.split(" ").slice(-1)[0].split(",")[0]}
          cy={linePoints.split(" ").slice(-1)[0].split(",")[1]}
          r="2.5"
          fill={stroke}
        />
      ) : null}
    </svg>
  );
}

function KpiCard({
  title,
  value,
  helper,
  delta,
  inverseDelta = false,
  sparkTone = "indigo",
  sparkPoints,
}: {
  title: string;
  value: ReactNode;
  helper: ReactNode;
  delta?: number;
  inverseDelta?: boolean;
  sparkTone?: "indigo" | "emerald" | "red" | "orange";
  sparkPoints?: number[];
}) {
  const formattedDelta =
    typeof delta === "number" ? formatDeltaPercent(delta, inverseDelta) : null;

  return (
    <div className="rounded-[26px] border border-slate-200 bg-white p-4 shadow-sm shadow-slate-200/40">
      <div className="flex items-center gap-1 text-sm font-black text-slate-700">
        <span>{title}</span>
        <span className="text-slate-300">ⓘ</span>
      </div>

      <div className="mt-2 text-[1.9rem] font-black leading-none tracking-tight text-slate-950">
        {value}
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          {formattedDelta ? (
            <div className={`text-sm font-black ${formattedDelta.className}`}>
              {formattedDelta.text}
            </div>
          ) : (
            <div className="text-sm font-black text-slate-400">&nbsp;</div>
          )}

          <div className="mt-1 text-xs font-semibold text-slate-500">{helper}</div>
        </div>

        <MiniTrendLine points={sparkPoints} tone={sparkTone} />
      </div>
    </div>
  );
}


function PriceBridgeCard({
  title,
  value,
  helper,
  tone = "slate",
}: {
  title: string;
  value: number;
  helper: ReactNode;
  tone?: "slate" | "emerald" | "orange" | "violet" | "red";
}) {
  const toneClassName =
    tone === "emerald"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-100"
      : tone === "orange"
        ? "bg-orange-50 text-orange-700 ring-orange-100"
        : tone === "violet"
          ? "bg-violet-50 text-violet-700 ring-violet-100"
          : tone === "red"
            ? "bg-red-50 text-red-700 ring-red-100"
            : "bg-slate-50 text-slate-700 ring-slate-100";

  return (
    <div className={`rounded-[24px] p-4 ring-1 ${toneClassName}`}>
      <div className="text-xs font-black uppercase tracking-[0.12em] opacity-75">
        {title}
      </div>
      <div className="mt-2 text-2xl font-black tracking-tight">
        {formatMoney(value)}
      </div>
      <div className="mt-2 text-xs font-semibold leading-5 opacity-80">{helper}</div>
    </div>
  );
}

function AbcBadge({ value }: { value: "A" | "B" | "C" }) {
  const className =
    value === "A"
      ? "bg-emerald-100 text-emerald-700 ring-emerald-200"
      : value === "B"
        ? "bg-amber-100 text-amber-700 ring-amber-200"
        : "bg-red-100 text-red-700 ring-red-200";

  return (
    <span
      className={`inline-flex h-7 min-w-7 items-center justify-center rounded-full px-2 text-xs font-black ring-1 ${className}`}
    >
      {value}
    </span>
  );
}

function ProductImagePlaceholder({ meta }: { meta: ProductMeta }) {
  const initials =
    meta.productName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "WB";

  return (
    <div className="flex h-16 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50 to-slate-100 text-xs font-black text-slate-400">
      {meta.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={meta.imageUrl}
          alt={meta.productName}
          className="h-full w-full object-cover"
        />
      ) : (
        initials
      )}
    </div>
  );
}

function MoneyWithShare({
  value,
  share,
  valueClassName = "text-slate-950",
}: {
  value: number;
  share: string;
  valueClassName?: string;
}) {
  return (
    <div>
      <div className={`text-base font-black ${valueClassName}`}>
        {formatMoney(value)}
      </div>
      <div className="mt-1 text-xs font-semibold text-slate-500">{share}</div>
    </div>
  );
}

function MarginBar({ value }: { value: number }) {
  const width = clamp((Math.max(0, value) / 30) * 100, 4, 100);

  return (
    <div>
      <div className={`text-base font-black ${profitTextColor(value)}`}>
        {formatPercent(value)}
      </div>
      <div className="mt-2 h-2 w-32 max-w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-full rounded-full ${metricBarColor(value)}`}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}


function InfoTooltip({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex">
      <span
        tabIndex={0}
        title={text}
        className="inline-flex h-5 w-5 cursor-help items-center justify-center rounded-full bg-slate-100 text-[11px] font-black text-slate-400 ring-1 ring-slate-200 transition hover:bg-indigo-50 hover:text-indigo-700 hover:ring-indigo-100"
      >
        ?
      </span>
      <span className="pointer-events-none absolute left-1/2 top-7 z-50 hidden w-80 -translate-x-1/2 rounded-2xl border border-slate-200 bg-white p-3 text-left text-xs font-semibold leading-5 text-slate-600 shadow-xl shadow-slate-200/70 group-hover:block group-focus-within:block">
        {text}
      </span>
    </span>
  );
}

function polarToCartesian(
  centerX: number,
  centerY: number,
  radius: number,
  angleInDegrees: number
) {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180;

  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  };
}

function describeDonutArc(
  startAngle: number,
  endAngle: number,
  outerRadius: number,
  innerRadius: number
) {
  const center = 130;
  const startOuter = polarToCartesian(center, center, outerRadius, endAngle);
  const endOuter = polarToCartesian(center, center, outerRadius, startAngle);
  const startInner = polarToCartesian(center, center, innerRadius, startAngle);
  const endInner = polarToCartesian(center, center, innerRadius, endAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";

  return [
    "M",
    startOuter.x,
    startOuter.y,
    "A",
    outerRadius,
    outerRadius,
    0,
    largeArcFlag,
    0,
    endOuter.x,
    endOuter.y,
    "L",
    startInner.x,
    startInner.y,
    "A",
    innerRadius,
    innerRadius,
    0,
    largeArcFlag,
    1,
    endInner.x,
    endInner.y,
    "Z",
  ].join(" ");
}

function ExpenseDonut({
  rows,
  revenue,
}: {
  rows: { label: string; value: number; colorHex: string }[];
  revenue: number;
}) {
  const positiveRows = rows.filter((row) => row.value > 0);
  const positiveTotal = positiveRows.reduce((sum, row) => sum + row.value, 0);

  let cursor = 0;

  const segments = positiveRows.map((row) => {
    const share = positiveTotal > 0 ? (row.value / positiveTotal) * 100 : 0;
    const size = positiveTotal > 0 ? (row.value / positiveTotal) * 360 : 0;
    const startAngle = cursor;
    const endAngle = cursor + Math.max(size, positiveRows.length === 1 ? 359.99 : 0);
    cursor += size;

    return {
      ...row,
      share,
      startAngle,
      endAngle,
      path: describeDonutArc(startAngle, endAngle, 112, 68),
    };
  });

  return (
    <div className="relative flex h-64 w-64 items-center justify-center">
      <svg
        viewBox="0 0 260 260"
        className="h-64 w-64 drop-shadow-sm"
        role="img"
        aria-label="Структура расходов WB"
      >
        <circle cx="130" cy="130" r="112" fill="#f1f5f9" />

        {segments.map((segment) => (
          <path
            key={segment.label}
            d={segment.path}
            fill={segment.colorHex}
            className="cursor-help transition hover:opacity-80"
          >
            <title>
              {`${segment.label}: ${formatMoney(segment.value)} · ${formatPercent(
                revenue > 0 ? (segment.value / revenue) * 100 : 0
              )} от выручки`}
            </title>
          </path>
        ))}

        <circle cx="130" cy="130" r="68" fill="white" />
      </svg>

      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="text-center">
          <div className="text-2xl font-black text-slate-950">
            {formatCompactMoney(revenue)}
          </div>
          <div className="mt-1 text-xs font-black uppercase tracking-[0.12em] text-slate-400">
            Выручка
          </div>
        </div>
      </div>
    </div>
  );
}

function TableHeader() {
  return (
    <div className="grid min-w-[1180px] grid-cols-[minmax(330px,1.7fr)_minmax(140px,0.8fr)_minmax(150px,0.85fr)_minmax(150px,0.85fr)_minmax(130px,0.7fr)_minmax(150px,0.8fr)] items-center border-b border-slate-200 bg-white px-5 py-4 text-sm font-black text-slate-500">
      <div>Товар</div>
      <div className="flex items-center gap-1">
        Выкупы
        <InfoTooltip text="Выкупы — сумма и количество фактически реализованных продаж по WB Sales за выбранный период. Доля показывает вклад артикула в общую выручку WB. Бейдж A/B/C — ABC по выручке/выкупам." />
      </div>
      <div className="flex items-center gap-1">
        Расходы
        <InfoTooltip text="Расходы — управленческие расходы по артикулу: себестоимость, логистика, хранение и приёмка, штрафы/прочие удержания, реклама и налоги. Комиссия/компенсация WB и СПП показываются отдельно, потому что они уже учтены внутри суммы к перечислению продавцу." />
      </div>
      <div className="flex items-center gap-1">
        Прибыль
        <InfoTooltip text="Прибыль — прибыль после налогов: к перечислению продавцу минус себестоимость, логистика, хранение, приёмка, штрафы/удержания, реклама и налоги. Налог считается с суммы ‘WB реализовал товар’." />
      </div>
      <div className="flex items-center gap-1">
        Процент выкупа
        <InfoTooltip text="Процент выкупа считается за выбранный период как выкупленные продажи / (выкупленные продажи + возвраты) по данным WB Sales. Если данных для расчёта нет, показывается прочерк." />
      </div>
      <div className="flex items-center gap-1">
        Маржинальность
        <InfoTooltip text="Маржинальность — прибыль после налогов / выручка артикула × 100% за выбранный период. Шкала помогает быстро увидеть качество маржи." />
      </div>
    </div>
  );
}

function SizeRow({
  row,
  parentRevenue,
}: {
  row: SizeBreakdownRow;
  parentRevenue: number;
}) {
  return (
    <div className="grid min-w-[1180px] grid-cols-[minmax(330px,1.7fr)_minmax(140px,0.8fr)_minmax(150px,0.85fr)_minmax(150px,0.85fr)_minmax(130px,0.7fr)_minmax(150px,0.8fr)] items-center border-t border-slate-100 bg-slate-50/50 px-5 py-4 text-sm">
      <div className="flex items-center gap-3 pl-9">
        <div className="h-8 border-l border-dashed border-slate-300" />
        <div>
          <div className="font-black text-slate-800">{row.size}</div>
          <div className="mt-1 text-xs font-semibold text-slate-400">
            {row.barcode || "Штрихкод не указан"}
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-start gap-2">
          <MoneyWithShare
            value={row.revenue}
            share={`${formatNumber(row.netSalesQty)} шт. · ${formatShare(row.revenue, parentRevenue, "от товара")}`}
          />
          <AbcBadge value={row.abcByRevenue} />
        </div>
      </div>

      <MoneyWithShare
        value={row.expenses}
        share={formatShare(row.expenses, row.revenue)}
      />

      <div className="flex items-start gap-2">
        <MoneyWithShare
          value={row.netProfitAfterTax}
          share={formatShare(row.netProfitAfterTax, row.revenue)}
          valueClassName={profitTextColor(row.netProfitAfterTax)}
        />
        <AbcBadge value={row.abcByProfit} />
      </div>

      <div className="text-base font-black text-slate-800">
        {formatPercent(row.buyoutPercent)}
      </div>

      <MarginBar value={row.marginAfterTaxPercent} />
    </div>
  );
}

function ProductRow({
  row,
  index,
  totalRevenue,
}: {
  row: EnrichedProfitRow;
  index: number;
  totalRevenue: number;
}) {
  const expenses = rowExpenses(row);
  const buyoutPercent = rowBuyoutPercent(row);
  const defaultOpen = index === 0 && row.sizeRows.length > 0;

  return (
    <details
      className="group border-t border-slate-100 first:border-t-0"
      open={defaultOpen}
    >
      <summary className="grid min-w-[1180px] cursor-pointer list-none grid-cols-[minmax(330px,1.7fr)_minmax(140px,0.8fr)_minmax(150px,0.85fr)_minmax(150px,0.85fr)_minmax(130px,0.7fr)_minmax(150px,0.8fr)] items-center px-5 py-4 transition hover:bg-slate-50">
        <div className="flex min-w-0 items-center gap-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl text-slate-500 transition group-open:rotate-180">
            ⌄
          </span>

          <ProductImagePlaceholder meta={row.productMeta} />

          <div className="min-w-0">
            <div className="max-w-[360px] truncate text-sm font-black text-slate-950">
              {row.productMeta.productName || row.vendorCode || "Товар WB"}
            </div>

            <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs font-semibold text-slate-500">
              <span>Артикул: {row.vendorCode || "—"}</span>
              <span>·</span>
              <span>Код WB: {row.nmId || row.productMeta.nmId || "—"}</span>
            </div>

            <div className="mt-1 text-xs font-semibold text-slate-400">
              {row.productMeta.subject || row.subject || "Категория не указана"}
            </div>
          </div>
        </div>

        <div>
          <div className="flex items-start gap-2">
            <MoneyWithShare
              value={row.revenue}
              share={`${formatNumber(row.netSalesQty)} шт. · ${formatShare(row.revenue, totalRevenue, "от итога")}`}
            />
            <AbcBadge value={row.abcByRevenue} />
          </div>
        </div>

        <MoneyWithShare
          value={expenses}
          share={formatShare(expenses, row.revenue)}
        />

        <div className="flex items-start gap-2">
          <MoneyWithShare
            value={row.netProfitAfterTax}
            share={formatShare(row.netProfitAfterTax, row.revenue)}
            valueClassName={profitTextColor(row.netProfitAfterTax)}
          />
          <AbcBadge value={row.abcByProfit} />
        </div>

        <div className="text-base font-black text-slate-800">
          {formatPercent(buyoutPercent)}
        </div>

        <div className="flex items-center justify-between gap-3">
          <MarginBar value={row.marginAfterTaxPercent} />
          <span className="text-xl font-black text-slate-300">⋮</span>
        </div>
      </summary>

      {row.sizeRows.length > 0 ? (
        <div>
          {row.sizeRows.map((sizeRow) => (
            <SizeRow
              key={`${row.vendorCode}-${sizeRow.size}-${sizeRow.barcode}`}
              row={sizeRow}
              parentRevenue={row.revenue}
            />
          ))}
        </div>
      ) : (
        <div className="min-w-[1180px] border-t border-slate-100 bg-slate-50 px-5 py-4 pl-24 text-sm font-semibold text-slate-400">
          Детализация по размерам пока недоступна для этого артикула.
        </div>
      )}
    </details>
  );
}

function AttentionItem({
  title,
  text,
  value,
  tone,
}: {
  title: string;
  text: string;
  value: string;
  tone: "red" | "orange" | "blue" | "violet";
}) {
  const styles =
    tone === "red"
      ? {
          row: "border-red-100 bg-red-50/70",
          icon: "bg-red-100 text-red-500 ring-red-100",
          title: "text-red-700",
          value: "text-red-600",
        }
      : tone === "orange"
        ? {
            row: "border-orange-100 bg-orange-50/70",
            icon: "bg-orange-100 text-orange-500 ring-orange-100",
            title: "text-orange-700",
            value: "text-orange-600",
          }
        : tone === "blue"
          ? {
              row: "border-sky-100 bg-sky-50/70",
              icon: "bg-sky-100 text-sky-500 ring-sky-100",
              title: "text-sky-700",
              value: "text-sky-600",
            }
          : {
              row: "border-violet-100 bg-violet-50/70",
              icon: "bg-violet-100 text-violet-500 ring-violet-100",
              title: "text-violet-700",
              value: "text-violet-600",
            };

  const icon = tone === "red" ? "!" : tone === "orange" ? "△" : tone === "blue" ? "◻" : "◔";

  return (
    <div className={`rounded-[22px] border px-4 py-4 ${styles.row}`}>
      <div className="flex items-center gap-3">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-black ring-1 ${styles.icon}`}>
          {icon}
        </span>

        <div className="min-w-0 flex-1">
          <div className={`text-base font-black ${styles.title}`}>{title}</div>
          <div className="mt-1 text-sm font-semibold text-slate-500">{text}</div>
        </div>

        <div className={`shrink-0 text-right text-xl font-black ${styles.value}`}>{value}</div>
        <span className="shrink-0 text-lg font-black text-slate-400">›</span>
      </div>
    </div>
  );
}

function StructureLegendRow({
  label,
  value,
  share,
  colorHex,
}: {
  label: string;
  value: number;
  share: number;
  colorHex: string;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_105px_62px] items-center gap-3 text-sm">
      <div className="flex min-w-0 items-center gap-3">
        <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: colorHex }} />
        <span className="truncate font-bold text-slate-600">{label}</span>
      </div>
      <div className="text-right font-black text-slate-900">{formatMoney(value)}</div>
      <div className="text-right font-bold text-slate-500">{formatPercent(share)}</div>
    </div>
  );
}

export default async function ProfitPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const params = (await searchParams) ?? {};

  const dateFrom = params.dateFrom ?? getDefaultDateRange().dateFrom;
  const dateTo = params.dateTo ?? getDefaultDateRange().dateTo;
  const companyName = params.companyName ?? "ALL";
  const sort = (params.sort ?? "netProfitAfterTax") as SortKey;
  const dir = (params.dir === "asc" ? "asc" : "desc") as SortDir;
  const q = params.q ?? "";
  const abc = (params.abc ?? "ALL") as AbcFilter;
  const requestedPageSize = Number(params.pageSize ?? DEFAULT_PAGE_SIZE);
  const pageSize = PAGE_SIZE_OPTIONS.includes(requestedPageSize)
    ? requestedPageSize
    : DEFAULT_PAGE_SIZE;

  const { rows, totals, comparison } = await getProfitAnalytics({
    dateFrom,
    dateTo,
    companyName,
  });

  const isPreliminaryWbProfit = totals.dataMode === "PRELIMINARY";

  const abcByRevenue = calculateAbcByPositiveValue(rows, (row) => row.revenue);

  const { metaByVendorCode, sizeRowsByVendorCode } =
    await buildProductMetaAndSizeRows({
      rows,
      dateFrom,
      dateTo,
      companyName,
    });

  const enrichedRows: EnrichedProfitRow[] = rows.map((row) => {
    const vendorKey = normalizeText(row.vendorCode);
    const fallbackMeta = {
      productName: row.vendorCode || row.subject || "Товар WB",
      subject: row.subject ?? "",
      nmId: row.nmId ?? "",
      vendorCode: row.vendorCode ?? "",
      imageUrl: null,
    };

    return {
      ...row,
      abcByRevenue: abcByRevenue.get(row) ?? "C",
      productMeta: metaByVendorCode.get(vendorKey) ?? fallbackMeta,
      sizeRows: sizeRowsByVendorCode.get(vendorKey) ?? [],
    };
  });

  const filteredRows = enrichedRows.filter((row) => {
    const query = normalizeText(q);
    const haystack = normalizeText(
      [
        row.vendorCode,
        row.nmId,
        row.subject,
        row.productMeta.productName,
        row.productMeta.subject,
      ].join(" ")
    );

    if (query && !haystack.includes(query)) return false;

    if (abc === "LOSS") return row.netProfitAfterTax < 0;
    if (abc === "A" || abc === "B" || abc === "C") {
      return row.abcByProfit === abc || row.abcByRevenue === abc;
    }

    return true;
  });

  const sortedRows = [...filteredRows].sort((a, b) => {
    const aValue = getSortValue(a, sort);
    const bValue = getSortValue(b, sort);

    if (dir === "asc") return aValue - bValue;
    return bValue - aValue;
  });

  const displayedRows = sortedRows.slice(0, pageSize);

  const storageAndAcceptance = totals.storageCost + totals.acceptanceCost;
  const penaltiesAndDeductions = totals.penaltiesAmount + totals.deductions;
  const excludedWbDeductions =
    totals.wbCreditDeduction + totals.wbUnknownDeduction;
  const wbInternalServices =
    totals.paymentServiceCost +
    totals.pvzCompensation +
    totals.transportCompensation +
    totals.loyaltyParticipationCost +
    totals.loyaltyPointsAmount -
    totals.loyaltyDiscountCompensation;
  const profitableSkuCount = rows.filter((row) => row.netProfitAfterTax > 0).length;
  const riskSkuCount = rows.filter(
    (row) =>
      row.netProfitAfterTax <= 0 ||
      row.drrPercent > 20 ||
      row.marginAfterTaxPercent < 10
  ).length;

  const lossRows = rows.filter((row) => row.netProfitAfterTax < 0);
  const highDrrRows = rows.filter((row) => row.drrPercent > 20);
  const lowMarginRows = rows.filter(
    (row) => row.revenue > 0 && row.marginAfterTaxPercent < 10
  );
  const cRows = rows.filter((row) => row.abcByProfit === "C");

  const structureRows = [
    {
      label: "Себестоимость товаров",
      value: totals.totalCost,
      colorClassName: "bg-indigo-500",
      colorHex: "#6366f1",
    },
    {
      label: "Комиссия / компенсация WB",
      value: totals.wbCommission,
      colorClassName: "bg-violet-500",
      colorHex: "#8b5cf6",
    },
    {
      label: "Логистика",
      value: totals.logisticsCost,
      colorClassName: "bg-sky-500",
      colorHex: "#0ea5e9",
    },
    {
      label: "Реклама WB",
      value: totals.adsCost,
      colorClassName: "bg-pink-500",
      colorHex: "#ec4899",
    },
    {
      label: "Хранение и приёмка",
      value: storageAndAcceptance,
      colorClassName: "bg-orange-400",
      colorHex: "#fb923c",
    },
    {
      label: "Штрафы и прочие удержания",
      value: penaltiesAndDeductions,
      colorClassName: "bg-red-400",
      colorHex: "#f87171",
    },
    {
      label: "Налоги",
      value: totals.taxesAmount,
      colorClassName: "bg-amber-500",
      colorHex: "#f59e0b",
    },
  ];

  const currentSortDirLabel = dir === "desc" ? "сначала высокая" : "сначала низкая";

  return (
    <main className="page-shell">
      <div className="page-container">
        <section className="panel p-5 sm:p-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
            <div>
              <div className="inline-flex rounded-full bg-violet-50 px-3 py-1 text-xs font-black uppercase tracking-[0.12em] text-violet-700 ring-1 ring-violet-100">
                WB аналитика
              </div>

              <h1 className="mt-3 text-3xl font-black tracking-tight text-slate-950 sm:text-4xl">
                Прибыль по SKU WB
              </h1>

              <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-500">
                Unit economics по WB Sales: цена продавца, СПП WB, фактическая
                реализация, комиссия/компенсация WB, себестоимость, логистика,
                реклама и налоги.
              </p>
            </div>

            <form className="grid gap-3 rounded-[28px] border border-slate-200 bg-white p-3 shadow-sm md:grid-cols-[160px_160px_190px_140px]">
              <input type="hidden" name="sort" value={sort} />
              <input type="hidden" name="dir" value={dir} />
              <input type="hidden" name="abc" value={abc} />
              <input type="hidden" name="q" value={q} />
              <input type="hidden" name="pageSize" value={pageSize} />

              <label className="block">
                <span className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                  Дата от
                </span>
                <input
                  type="date"
                  name="dateFrom"
                  defaultValue={dateFrom}
                  className="mt-1 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-700 outline-none transition focus:border-indigo-200 focus:bg-white"
                />
              </label>

              <label className="block">
                <span className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                  Дата до
                </span>
                <input
                  type="date"
                  name="dateTo"
                  defaultValue={dateTo}
                  className="mt-1 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-700 outline-none transition focus:border-indigo-200 focus:bg-white"
                />
              </label>

              <label className="block">
                <span className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                  Компания
                </span>
                <select
                  name="companyName"
                  defaultValue={companyName}
                  className="mt-1 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-700 outline-none transition focus:border-indigo-200 focus:bg-white"
                >
                  <option value="ALL">Все компании</option>
                  <option value="ИП Петров">ИП Петров</option>
                  <option value="ИП Лебедева">ИП Лебедева</option>
                </select>
              </label>

              <div className="flex items-end">
                <button className="w-full rounded-2xl bg-indigo-600 px-4 py-2.5 text-sm font-black text-white shadow-lg shadow-indigo-200 transition hover:bg-indigo-700">
                  Применить
                </button>
              </div>
            </form>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-end gap-2 text-sm">
            <span className="text-slate-500">Сравнение с предыдущим периодом</span>
            <span className="rounded-2xl bg-emerald-50 px-3 py-1 font-black text-emerald-700 ring-1 ring-emerald-100">
              {formatDateRu(dateFrom)} — {formatDateRu(dateTo)}
            </span>
            <Link
              href="/import"
              className="rounded-2xl border border-slate-200 bg-white px-4 py-2 font-black text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              Импорт данных
            </Link>
          </div>
        </section>

        {isPreliminaryWbProfit ? (
          <section className="rounded-[28px] border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900 shadow-sm">
            <div className="font-black">Финансовый результат WB предварительный</div>
            <div className="mt-1 leading-6">
              Продажи, выкупы и реклама загружены оперативно. Комиссия WB
              восстановлена по разнице между реализацией и выплатой, а
              логистика/хранение/штрафы рассчитаны оценочно по последнему
              доступному детальному отчёту WB. После появления финального
              отчёта WB система заменит оценку официальными расходами.
            </div>
          </section>
        ) : null}

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
          <KpiCard
            title="Выручка"
            value={formatMoney(totals.revenue)}
            helper="к пред. периоду"
            delta={comparison.revenue.diffPercent}
            sparkTone="indigo"
            sparkPoints={[10, 12, 18, 14, 14, 21, 19, 28]}
          />

          <KpiCard
            title="Марж. прибыль"
            value={formatMoney(totals.marginProfit)}
            helper={`${formatPercent(totals.marginProfitPercent)} от выручки`}
            delta={comparison.marginProfit.diffPercent}
            sparkTone="emerald"
            sparkPoints={[8, 12, 10, 13, 21, 19, 28, 22]}
          />

          <KpiCard
            title="Прибыль после налогов"
            value={formatMoney(totals.netProfitAfterTax)}
            helper={`${formatPercent(totals.marginAfterTaxPercent)} от выручки`}
            delta={comparison.netProfitAfterTax.diffPercent}
            sparkTone="emerald"
            sparkPoints={[7, 9, 15, 13, 18, 17, 24, 16]}
          />

          <KpiCard
            title="Реклама (ДРР)"
            value={formatMoney(totals.adsCost)}
            helper={`${formatPercent(totals.drrPercent)} от выручки`}
            delta={comparison.adsCost.diffPercent}
            inverseDelta
            sparkTone="orange"
            sparkPoints={[18, 17, 22, 16, 14, 13, 15, 23]}
          />

          <KpiCard
            title="Себестоимость"
            value={formatMoney(totals.totalCost)}
            helper={`${formatShare(totals.totalCost, totals.revenue)}`}
            delta={comparison.totalCost.diffPercent}
            inverseDelta
            sparkTone="red"
            sparkPoints={[9, 10, 12, 14, 13, 18, 20, 22]}
          />

          <KpiCard
            title="К перечислению WB"
            value={formatMoney(totals.sellerPayout)}
            helper={`${formatShare(totals.sellerPayout, totals.revenue)}`}
            delta={comparison.sellerPayout.diffPercent}
            sparkTone="emerald"
            sparkPoints={[8, 10, 9, 15, 14, 18, 23, 21]}
          />
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <PriceBridgeCard
            title="Цена продавца"
            value={totals.sellerRetailAmount}
            helper="Цена розничная с учётом согласованной скидки, до СПП WB."
            tone="violet"
          />
          <PriceBridgeCard
            title="WB реализовал"
            value={totals.revenue}
            helper="Фактическая продажа покупателю после СПП. С этой суммы считаем налог и ДРР."
            tone="emerald"
          />
          <PriceBridgeCard
            title="СПП WB"
            value={totals.sppDiscountAmount}
            helper={`${formatShare(totals.sppDiscountAmount, totals.sellerRetailAmount, "от цены продавца")}. Скидка площадки покупателю.`}
            tone="orange"
          />
          <PriceBridgeCard
            title="Комиссия / компенсация"
            value={totals.wbCommission}
            helper={`Без НДС: ${formatMoney(totals.wbCommissionBeforeVat)} · НДС: ${formatMoney(totals.wbCommissionVat)}. Отрицательное значение — компенсация WB.`}
            tone={totals.wbCommission < 0 ? "emerald" : "red"}
          />
          <PriceBridgeCard
            title="Платёжные / ПВЗ"
            value={wbInternalServices}
            helper="Расшифровка внутри выплаты WB: платёжные сервисы, ПВЗ, перевозка и лояльность. В прибыль второй раз не вычитается."
            tone="slate"
          />
        </section>

        {excludedWbDeductions > 0 ? (
          <section className="rounded-[26px] border border-amber-200 bg-amber-50/70 p-4 text-sm font-semibold leading-6 text-amber-900">
            Из удержаний WB не включено в unit-экономику: {formatMoney(excludedWbDeductions)}.
            Кредит WB и нераспознанные удержания не списываются повторно как товарный расход,
            чтобы не задваивать рекламу/кредит. Реклама WB учитывается отдельной строкой.
          </section>
        ) : null}

        <section className="grid gap-5 xl:grid-cols-[minmax(0,4fr)_minmax(340px,2fr)]">
          <section className="panel min-w-0 p-5 sm:p-6">
            <div className="flex items-center gap-2">
              <h2 className="text-[1.7rem] font-black tracking-tight text-slate-950">
                Структура экономики WB
              </h2>
              <span className="text-slate-300">ⓘ</span>
            </div>

            <div className="mt-5 grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)] lg:items-center">
              <div className="flex justify-center">
                <ExpenseDonut rows={structureRows} revenue={totals.revenue} />
              </div>

              <div className="space-y-3">
                {structureRows.map((row) => (
                  <StructureLegendRow
                    key={row.label}
                    label={row.label}
                    value={row.value}
                    share={totals.revenue > 0 ? (row.value / totals.revenue) * 100 : 0}
                    colorHex={row.colorHex}
                  />
                ))}

                <div className="grid grid-cols-[minmax(0,1fr)_105px_62px] items-center gap-3 border-t border-slate-100 pt-4">
                  <div className="font-black text-emerald-600">Прибыль после налогов</div>
                  <div className="text-right font-black text-emerald-600">
                    {formatMoney(totals.netProfitAfterTax)}
                  </div>
                  <div className="text-right font-black text-emerald-600">
                    {formatPercent(totals.marginAfterTaxPercent)}
                  </div>
                </div>
              </div>
            </div>
          </section>

          <aside className="panel min-w-0 p-5 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h2 className="text-[1.7rem] font-black tracking-tight text-slate-950">
                  Что требует внимания
                </h2>
                <span className="text-slate-300">ⓘ</span>
              </div>

              <button
                type="button"
                className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-black text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
              >
                Смотреть все
              </button>
            </div>

            <div className="mt-5 space-y-3">
              <AttentionItem
                title="Убыточные товары"
                text={`${formatNumber(lossRows.length)} SKU с отрицательной прибылью`}
                value={formatMoney(lossRows.reduce((sum, row) => sum + row.netProfitAfterTax, 0))}
                tone="red"
              />

              <AttentionItem
                title="Высокий ДРР (>20%)"
                text={`${formatNumber(highDrrRows.length)} SKU с ДРР выше 20%`}
                value={formatMoney(highDrrRows.reduce((sum, row) => sum + row.adsCost, 0))}
                tone="orange"
              />

              <AttentionItem
                title="Низкая маржинальность (<10%)"
                text={`${formatNumber(lowMarginRows.length)} SKU с маржинальностью ниже 10%`}
                value={formatMoney(lowMarginRows.reduce((sum, row) => sum + row.revenue, 0))}
                tone="blue"
              />

              <AttentionItem
                title="Товары C-класса"
                text={`${formatNumber(cRows.length)} SKU с низким вкладом в прибыль`}
                value={formatMoney(cRows.reduce((sum, row) => sum + row.revenue, 0))}
                tone="violet"
              />
            </div>
          </aside>
        </section>

        <section className="panel overflow-hidden">
          <div className="border-b border-slate-200 p-5 sm:p-6">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <div className="section-eyebrow">SKU</div>
                <h2 className="mt-1 text-2xl font-black tracking-tight text-slate-950">
                  Сводная таблица по артикулам
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-500">
                  Рабочий список товаров: фактическая реализация WB, управленческие расходы,
                  прибыль, процент выкупа и маржинальность. Стрелка раскрывает размеры.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Link
                  href="/import"
                  className="rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-black text-indigo-700 transition hover:bg-indigo-100"
                >
                  Управление себестоимостью
                </Link>

                <button
                  type="button"
                  disabled
                  className="cursor-not-allowed rounded-2xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-black text-slate-400"
                  title="Экспорт добавим отдельным шагом"
                >
                  Выгрузить список
                </button>
              </div>
            </div>

            <form className="mt-5 flex flex-col gap-3 xl:flex-row xl:items-center">
              <input type="hidden" name="dateFrom" value={dateFrom} />
              <input type="hidden" name="dateTo" value={dateTo} />
              <input type="hidden" name="companyName" value={companyName} />
              <input type="hidden" name="abc" value={abc} />

              <div className="relative w-full xl:max-w-[330px]">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400">
                  🔎
                </span>
                <input
                  type="text"
                  name="q"
                  defaultValue={q}
                  placeholder="Артикул или название"
                  className="w-full rounded-2xl border border-slate-200 bg-white py-3 pl-11 pr-10 text-sm font-bold text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-indigo-200 focus:ring-4 focus:ring-indigo-50"
                />
                {q ? (
                  <Link
                    href={buildQueryHref(params, { q: "" })}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400"
                  >
                    ×
                  </Link>
                ) : null}
              </div>

              <div className="flex flex-wrap rounded-2xl bg-slate-100 p-1">
                {ABC_FILTERS.map((filter) => {
                  const active = abc === filter.key;

                  return (
                    <Link
                      key={filter.key}
                      href={buildQueryHref(params, { abc: filter.key })}
                      className={`rounded-xl px-4 py-2 text-sm font-black transition ${
                        active
                          ? "bg-white text-slate-950 shadow-sm"
                          : "text-slate-500 hover:text-slate-950"
                      }`}
                    >
                      {filter.label}
                    </Link>
                  );
                })}
              </div>

              <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center xl:justify-end">
                <label className="flex items-center gap-2 text-sm font-black text-slate-700">
                  <span>Сортировать по</span>
                  <select
                    name="sort"
                    defaultValue={sort}
                    className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-black text-indigo-700 outline-none"
                  >
                    <option value="revenue">выручке</option>
                    <option value="netSalesQty">количеству</option>
                    <option value="expenses">расходам</option>
                    <option value="netProfitAfterTax">прибыли</option>
                    <option value="buyoutPercent">проценту выкупа</option>
                    <option value="marginAfterTaxPercent">маржинальности</option>
                    <option value="adsCost">рекламе</option>
                    <option value="drrPercent">ДРР</option>
                  </select>
                </label>

                <label className="flex items-center gap-2 text-sm font-black text-slate-700">
                  <span>порядок</span>
                  <select
                    name="dir"
                    defaultValue={dir}
                    className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-black text-indigo-700 outline-none"
                  >
                    <option value="desc">сначала высокая</option>
                    <option value="asc">сначала низкая</option>
                  </select>
                </label>



                <label className="flex items-center gap-2 text-sm font-black text-slate-700">
                  <span>строк</span>
                  <select
                    name="pageSize"
                    defaultValue={String(pageSize)}
                    className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-black text-indigo-700 outline-none"
                  >
                    {PAGE_SIZE_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>

                <button className="rounded-2xl bg-indigo-600 px-4 py-2.5 text-sm font-black text-white shadow-lg shadow-indigo-200 transition hover:bg-indigo-700">
                  Применить
                </button>
              </div>
            </form>

            <div className="mt-3 text-xs font-semibold text-slate-400">
              Сейчас: сортировка по {getSortLabel(sort)}, {currentSortDirLabel}.
              Компания: {getCompanyLabel(companyName)}. Строк на странице: {pageSize}.
            </div>
          </div>

          <div className="overflow-x-auto">
            <TableHeader />

            <div className="min-w-[1180px] bg-white">
              {displayedRows.map((row, index) => (
                <ProductRow
                  key={`${row.nmId}-${row.vendorCode}-${index}`}
                  row={row}
                  index={index}
                  totalRevenue={totals.revenue}
                />
              ))}

              {sortedRows.length === 0 ? (
                <div className="px-6 py-12 text-center">
                  <div className="text-lg font-black text-slate-950">
                    Нет данных для расчёта прибыли
                  </div>
                  <p className="mt-2 text-sm text-slate-500">
                    Загрузите WB Sales, рекламу и ProductCost или измените фильтры.
                  </p>
                  <Link
                    href="/import"
                    className="mt-5 inline-flex rounded-2xl bg-indigo-600 px-5 py-3 text-sm font-black text-white shadow-lg shadow-indigo-200"
                  >
                    Перейти к импорту
                  </Link>
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex flex-col gap-3 border-t border-slate-200 bg-slate-50 px-5 py-4 text-sm font-semibold text-slate-500 sm:flex-row sm:items-center sm:justify-between">
            <div>
              Показано {formatNumber(displayedRows.length)} из {formatNumber(sortedRows.length)} SKU после фильтров. Всего в периоде: {formatNumber(rows.length)} SKU
            </div>

            <div className="flex items-center gap-2">
              <span>Фото товаров будет подтягиваться после подключения WB API карточек.</span>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
