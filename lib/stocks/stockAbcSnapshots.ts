import type { Prisma } from "@prisma/client";

import { assertWbFinancialDataFinal } from "@/lib/analytics/wbFinality";
import {
  applyOzonCanonicalIngestFinality,
  resolveOzonPeriodFinality,
} from "@/lib/finance/canonicalPeriodFinality";
import type { OzonAccrualDayStatusRecord } from "@/lib/ozon/accrualDayStatus";
import { loadOzonAccrualDayStatuses } from "@/lib/ozon/accrualDayStatusStore";
import { listExpectedOzonCompanyNames } from "@/lib/ozon/expectedOzonCompanies";
import { prisma } from "@/lib/prisma";

export type StockAbcCategory = "A" | "B" | "C";

export type StockAbcSnapshotEntry = {
  companyName: string;
  article: string;
  abcByRevenue: StockAbcCategory;
  abcByProfit: StockAbcCategory;
};

export type StockOzonSalesSnapshotEntry = {
  companyName: string;
  vendorCode: string;
  netSalesQty: number;
  revenue: number;
};

export type StockWbGeoSalesSnapshotEntry = {
  companyName: string;
  vendorCode: string;
  nmId: string;
  barcode: string;
  size: string | null;
  warehouseName: string;
  countryNames: string[];
  oblastNames: string[];
  regionNames: string[];
  observedDays: number;
  grossSalesQty: number;
  returnsQty: number;
  netSalesQty: number;
  salesAmount: number;
};

export const STOCK_PLANNING_SNAPSHOT_FORMULA_VERSION =
  "STOCK_PLANNING_SNAPSHOT_V3";

type StockAbcSnapshotPayload = {
  version: 1 | 2;
  planningVersion?: 3 | null;
  companyScope: string;
  marketplace: "WB" | "OZON";
  dateFrom: string;
  dateTo: string;
  generatedAt: string;
  entries: StockAbcSnapshotEntry[];
  ozonSalesEntries: StockOzonSalesSnapshotEntry[];
  wbGeoSalesEntries?: StockWbGeoSalesSnapshotEntry[];
};

type ParsedStockAbcSnapshotPayload = {
  version: 1 | 2;
  planningVersion: 3 | null;
  companyScope: string;
  marketplace: "WB" | "OZON";
  dateFrom: string;
  dateTo: string;
  generatedAt: string;
  entries: StockAbcSnapshotEntry[];
  ozonSalesEntries: StockOzonSalesSnapshotEntry[];
  wbGeoSalesEntries: StockWbGeoSalesSnapshotEntry[];
};

export type PreparedStockAbcSnapshot = {
  companyScope: string;
  marketplace: "WB" | "OZON";
  dateFrom: string;
  dateTo: string;
  payload: StockAbcSnapshotPayload;
  rowsCount: number;
  ozonSalesRowsCount: number;
  wbGeoSalesRowsCount: number;
  generatedAt: Date;
};

export type SnapshotJobClaim = {
  id: string;
  lockedBy: string;
  attempts: number;
};

type SnapshotJobDb = {
  dashboardPeriodSnapshotJob: {
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
  stockAbcSnapshot: {
    upsert: (args: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => Promise<{ id: string }>;
  };
};

type WbDailySaleSnapshotSourceRow = {
  companyName?: string | null;
  vendorCode?: string | null;
  nmId?: string | null;
  barcode?: string | null;
  size?: string | null;
  warehouseName?: string | null;
  countryName?: string | null;
  oblastOkrugName?: string | null;
  regionName?: string | null;
  saleDate?: Date | null;
  quantity?: number | null;
  wbRealizedAmount?: unknown;
};

type WbAnalyticsRow = {
  companyName?: string | null;
  revenue: number;
  abcByProfit?: unknown;
  nmId?: string | null;
  vendorCode?: string | null;
};

type OzonAnalyticsRow = {
  companyName?: string | null;
  revenue: number;
  netProfitAfterTax: number;
  netSalesQty?: number | null;
  nmId?: string | null;
  vendorCode?: string | null;
};

const SNAPSHOT_VERSION = 2 as const;
const PLANNING_SNAPSHOT_VERSION = 3 as const;
const MARKETPLACES = ["WB", "OZON"] as const;

function normalizeKey(value: unknown) {
  return String(value ?? "").trim();
}

function toFiniteNumber(value: unknown) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toAbcCategory(value: unknown): StockAbcCategory {
  return value === "A" || value === "B" || value === "C" ? value : "C";
}

function getMarketplaceBaseArticle(value: unknown) {
  const article = normalizeKey(value);

  if (!article) return "";

  const baseArticle = article.split("-")[0]?.trim() ?? article;

  return /^\d+$/.test(baseArticle) ? baseArticle : "";
}

function getDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function getEndOfDate(value: string) {
  return new Date(`${value}T23:59:59.999Z`);
}

function inferSizeFromVendorCode(value: unknown) {
  const vendorCode = normalizeKey(value);

  if (!vendorCode || !vendorCode.includes("-")) return null;

  const parts = vendorCode
    .split("-")
    .map((part) => part.trim())
    .filter(Boolean);
  const numericTail: string[] = [];

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];

    if (!/^\d{2,3}$/.test(part)) break;

    numericTail.unshift(part);

    if (numericTail.length >= 2) break;
  }

  return numericTail.length > 0 ? numericTail.join(" / ") : null;
}

function sortedText(values: Set<string>) {
  return Array.from(values).sort((left, right) =>
    left.localeCompare(right, "ru")
  );
}

function calculateAbcByPositiveValue<T>(
  rows: T[],
  getValue: (row: T) => number
) {
  const sorted = [...rows].sort(
    (left, right) =>
      Math.max(0, getValue(right)) - Math.max(0, getValue(left))
  );
  const total = sorted.reduce(
    (sum, row) => sum + Math.max(0, getValue(row)),
    0
  );
  const result = new Map<T, StockAbcCategory>();

  if (total <= 0) {
    for (const row of sorted) result.set(row, "C");
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

function registerEntry(
  map: Map<string, StockAbcSnapshotEntry>,
  params: {
    companyName?: string | null;
    article?: string | null;
    abcByRevenue: StockAbcCategory;
    abcByProfit: StockAbcCategory;
  }
) {
  const companyName = normalizeKey(params.companyName);
  const article = normalizeKey(params.article);

  if (!article) return;

  const key = `${companyName}::${article}`;

  if (!map.has(key)) {
    map.set(key, {
      companyName,
      article,
      abcByRevenue: params.abcByRevenue,
      abcByProfit: params.abcByProfit,
    });
  }
}

function buildWbEntries(
  rows: WbAnalyticsRow[],
  companyScope: string
) {
  const abcByRevenue = calculateAbcByPositiveValue(
    rows,
    (row) => row.revenue
  );
  const entries = new Map<string, StockAbcSnapshotEntry>();

  for (const row of rows) {
    const companyName =
      normalizeKey(row.companyName) ||
      (companyScope === "ALL" ? "" : companyScope);
    const abcRevenue = abcByRevenue.get(row) ?? "C";
    const abcProfit = toAbcCategory(row.abcByProfit);

    for (const article of [row.nmId, row.vendorCode]) {
      registerEntry(entries, {
        companyName,
        article,
        abcByRevenue: abcRevenue,
        abcByProfit: abcProfit,
      });
    }
  }

  return Array.from(entries.values());
}

export function buildStockWbGeoSalesSnapshotEntries(
  rows: WbDailySaleSnapshotSourceRow[]
): StockWbGeoSalesSnapshotEntry[] {
  const groups = new Map<
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
    }
  >();

  for (const row of rows) {
    const companyName = normalizeKey(row.companyName) || "Без компании";
    const vendorCode = normalizeKey(row.vendorCode);
    const nmId = normalizeKey(row.nmId);
    const article = nmId || vendorCode;
    const size =
      normalizeKey(row.size) || inferSizeFromVendorCode(vendorCode);
    const warehouseName = normalizeKey(row.warehouseName);
    const quantity = toFiniteNumber(row.quantity);

    if (!article || !warehouseName || quantity === 0) continue;

    const key = [
      companyName,
      article,
      normalizeKey(size),
      warehouseName,
    ].join("::");
    const group = groups.get(key) ?? {
      companyName,
      vendorCode,
      nmId,
      barcode: normalizeKey(row.barcode),
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
    };

    if (!group.vendorCode && vendorCode) group.vendorCode = vendorCode;
    if (!group.nmId && nmId) group.nmId = nmId;
    if (!group.barcode && row.barcode) {
      group.barcode = normalizeKey(row.barcode);
    }
    if (!group.size && size) group.size = size;

    const countryName = normalizeKey(row.countryName);
    const oblastName = normalizeKey(row.oblastOkrugName);
    const regionName = normalizeKey(row.regionName);

    if (countryName) group.countryNames.add(countryName);
    if (oblastName) group.oblastNames.add(oblastName);
    if (regionName) group.regionNames.add(regionName);

    if (row.saleDate) {
      group.days.add(row.saleDate.toISOString().slice(0, 10));
    }

    if (quantity > 0) group.grossSalesQty += quantity;
    if (quantity < 0) group.returnsQty += Math.abs(quantity);

    group.netSalesQty += quantity;
    group.salesAmount += toFiniteNumber(row.wbRealizedAmount);
    groups.set(key, group);
  }

  return Array.from(groups.values())
    .map((group) => ({
      companyName: group.companyName,
      vendorCode: group.vendorCode,
      nmId: group.nmId,
      barcode: group.barcode,
      size: group.size,
      warehouseName: group.warehouseName,
      countryNames: sortedText(group.countryNames),
      oblastNames: sortedText(group.oblastNames),
      regionNames: sortedText(group.regionNames),
      observedDays: Math.max(1, group.days.size),
      grossSalesQty: group.grossSalesQty,
      returnsQty: group.returnsQty,
      netSalesQty: group.netSalesQty,
      salesAmount: group.salesAmount,
    }))
    .sort((left, right) =>
      [
        left.companyName,
        left.vendorCode,
        left.nmId,
        left.size ?? "",
        left.warehouseName,
      ]
        .join("::")
        .localeCompare(
          [
            right.companyName,
            right.vendorCode,
            right.nmId,
            right.size ?? "",
            right.warehouseName,
          ].join("::"),
          "ru"
        )
    );
}

function buildOzonSnapshot(
  rows: OzonAnalyticsRow[],
  companyScope: string
) {
  const abcGroups = new Map<
    string,
    {
      companyName: string;
      baseArticle: string;
      revenue: number;
      netProfitAfterTax: number;
      rows: OzonAnalyticsRow[];
    }
  >();
  const salesGroups = new Map<string, StockOzonSalesSnapshotEntry>();

  for (const row of rows) {
    const companyName =
      normalizeKey(row.companyName) ||
      (companyScope === "ALL" ? "" : companyScope);
    const vendorCode = normalizeKey(row.vendorCode);
    const baseArticle =
      getMarketplaceBaseArticle(vendorCode) || vendorCode;

    if (baseArticle) {
      const abcKey = `${companyName}::${baseArticle}`;
      const current = abcGroups.get(abcKey) ?? {
        companyName,
        baseArticle,
        revenue: 0,
        netProfitAfterTax: 0,
        rows: [],
      };

      current.revenue += toFiniteNumber(row.revenue);
      current.netProfitAfterTax += toFiniteNumber(row.netProfitAfterTax);
      current.rows.push(row);
      abcGroups.set(abcKey, current);
    }

    const netSalesQty = Math.max(0, toFiniteNumber(row.netSalesQty));

    if (vendorCode && netSalesQty > 0) {
      const salesKey = `${companyName}::${vendorCode}`;
      const currentSales = salesGroups.get(salesKey) ?? {
        companyName,
        vendorCode,
        netSalesQty: 0,
        revenue: 0,
      };

      currentSales.netSalesQty += netSalesQty;
      currentSales.revenue += toFiniteNumber(row.revenue);
      salesGroups.set(salesKey, currentSales);
    }
  }

  const groupedRows = Array.from(abcGroups.values());
  const abcByRevenue = calculateAbcByPositiveValue(
    groupedRows,
    (row) => row.revenue
  );
  const abcByProfit = calculateAbcByPositiveValue(
    groupedRows,
    (row) => row.netProfitAfterTax
  );
  const entries = new Map<string, StockAbcSnapshotEntry>();

  for (const group of groupedRows) {
    const abcRevenue = abcByRevenue.get(group) ?? "C";
    const abcProfit = abcByProfit.get(group) ?? "C";

    registerEntry(entries, {
      companyName: group.companyName,
      article: group.baseArticle,
      abcByRevenue: abcRevenue,
      abcByProfit: abcProfit,
    });

    for (const row of group.rows) {
      for (const article of [row.vendorCode, row.nmId]) {
        registerEntry(entries, {
          companyName: group.companyName,
          article,
          abcByRevenue: abcRevenue,
          abcByProfit: abcProfit,
        });
      }
    }
  }

  return {
    entries: Array.from(entries.values()),
    ozonSalesEntries: Array.from(salesGroups.values()),
  };
}

/** Exported for focused producer/reader tests. */
export function parsePayload(
  value: Prisma.JsonValue
): ParsedStockAbcSnapshotPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const payload = value as Record<string, unknown>;
  const version = payload.version === 2 ? 2 : payload.version === 1 ? 1 : null;

  if (!version || !Array.isArray(payload.entries)) {
    return null;
  }

  const planningVersion = payload.planningVersion === 3 ? 3 : null;

  const entries = payload.entries
    .filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) &&
        typeof entry === "object" &&
        !Array.isArray(entry)
    )
    .map((entry) => ({
      companyName: normalizeKey(entry.companyName),
      article: normalizeKey(entry.article),
      abcByRevenue: toAbcCategory(entry.abcByRevenue),
      abcByProfit: toAbcCategory(entry.abcByProfit),
    }))
    .filter((entry) => entry.article);

  const ozonSalesEntries = Array.isArray(payload.ozonSalesEntries)
    ? payload.ozonSalesEntries
        .filter(
          (entry): entry is Record<string, unknown> =>
            Boolean(entry) &&
            typeof entry === "object" &&
            !Array.isArray(entry)
        )
        .map((entry) => ({
          companyName: normalizeKey(entry.companyName),
          vendorCode: normalizeKey(entry.vendorCode),
          netSalesQty: Math.max(0, toFiniteNumber(entry.netSalesQty)),
          revenue: toFiniteNumber(entry.revenue),
        }))
        .filter((entry) => entry.vendorCode && entry.netSalesQty > 0)
    : [];

  const wbGeoSalesEntries =
    planningVersion === 3 && Array.isArray(payload.wbGeoSalesEntries)
      ? payload.wbGeoSalesEntries
          .filter(
            (entry): entry is Record<string, unknown> =>
              Boolean(entry) &&
              typeof entry === "object" &&
              !Array.isArray(entry)
          )
          .map((entry) => ({
            companyName:
              normalizeKey(entry.companyName) || "Без компании",
            vendorCode: normalizeKey(entry.vendorCode),
            nmId: normalizeKey(entry.nmId),
            barcode: normalizeKey(entry.barcode),
            size: normalizeKey(entry.size) || null,
            warehouseName: normalizeKey(entry.warehouseName),
            countryNames: Array.isArray(entry.countryNames)
              ? entry.countryNames.map(normalizeKey).filter(Boolean)
              : [],
            oblastNames: Array.isArray(entry.oblastNames)
              ? entry.oblastNames.map(normalizeKey).filter(Boolean)
              : [],
            regionNames: Array.isArray(entry.regionNames)
              ? entry.regionNames.map(normalizeKey).filter(Boolean)
              : [],
            observedDays: Math.max(
              1,
              Math.round(toFiniteNumber(entry.observedDays))
            ),
            grossSalesQty: toFiniteNumber(entry.grossSalesQty),
            returnsQty: toFiniteNumber(entry.returnsQty),
            netSalesQty: toFiniteNumber(entry.netSalesQty),
            salesAmount: toFiniteNumber(entry.salesAmount),
          }))
          .filter(
            (entry) =>
              Boolean(entry.nmId || entry.vendorCode) &&
              Boolean(entry.warehouseName)
          )
      : [];

  return {
    version,
    planningVersion,
    companyScope: normalizeKey(payload.companyScope),
    marketplace: payload.marketplace === "OZON" ? "OZON" : "WB",
    dateFrom: normalizeKey(payload.dateFrom),
    dateTo: normalizeKey(payload.dateTo),
    generatedAt: normalizeKey(payload.generatedAt),
    entries,
    ozonSalesEntries,
    wbGeoSalesEntries,
  };
}

export async function lockDashboardSnapshotJobClaim(
  db: SnapshotJobDb | Prisma.TransactionClient | typeof prisma,
  claim: SnapshotJobClaim
) {
  const updated = await db.dashboardPeriodSnapshotJob.updateMany({
    where: {
      id: claim.id,
      status: "RUNNING",
      lockedBy: claim.lockedBy,
      attempts: claim.attempts,
    },
    data: {
      lockedAt: new Date(),
    },
  });

  if (updated.count !== 1) {
    throw new Error(
      `Heartbeat lost ownership of snapshot job ${claim.id}`
    );
  }
}

export async function completeDashboardSnapshotJobClaim(
  db: SnapshotJobDb | Prisma.TransactionClient | typeof prisma,
  claim: SnapshotJobClaim
) {
  const updated = await db.dashboardPeriodSnapshotJob.updateMany({
    where: {
      id: claim.id,
      status: "RUNNING",
      lockedBy: claim.lockedBy,
      attempts: claim.attempts,
    },
    data: {
      status: "SUCCESS",
      lockedAt: null,
      lockedBy: null,
      finishedAt: new Date(),
      nextAttemptAt: null,
      lastError: null,
    },
  });

  if (updated.count !== 1) {
    throw new Error(
      `Complete lost ownership of snapshot job ${claim.id}`
    );
  }
}

export async function failDashboardSnapshotJobClaim(
  db: SnapshotJobDb | Prisma.TransactionClient | typeof prisma,
  claim: SnapshotJobClaim,
  params: {
    finishedAt: Date;
    nextAttemptAt: Date | null;
    lastError: string;
  }
): Promise<boolean> {
  const updated = await db.dashboardPeriodSnapshotJob.updateMany({
    where: {
      id: claim.id,
      status: "RUNNING",
      lockedBy: claim.lockedBy,
      attempts: claim.attempts,
    },
    data: {
      status: "ERROR",
      lockedAt: null,
      lockedBy: null,
      finishedAt: params.finishedAt,
      nextAttemptAt: params.nextAttemptAt,
      lastError: params.lastError,
    },
  });

  return updated.count === 1;
}

export type OzonProfitTotalsForStockPlanning = {
  netProfitStatus?: "FINAL" | "PRELIMINARY" | string | null;
  costCoverageIncomplete?: boolean | null;
};

/**
 * Producer-only Ozon profit finality gate for STOCK_PLANNING_SNAPSHOT_V3.
 * Fail closed when profit is PRELIMINARY or COGS coverage is incomplete.
 * Does not invent a second financial formula — reads analytics.totals only.
 */
export function assertOzonProfitSafeForStockPlanningSnapshot(
  totals: OzonProfitTotalsForStockPlanning | null | undefined,
  context = "STOCK_PLANNING_SNAPSHOT"
) {
  const netProfitStatus = totals?.netProfitStatus;
  const costCoverageIncomplete = totals?.costCoverageIncomplete === true;

  if (netProfitStatus !== "FINAL" || costCoverageIncomplete) {
    throw new Error(
      `${context}: Ozon profit not safe for stock planning snapshot ` +
        `(netProfitStatus=${String(netProfitStatus ?? "missing")}, ` +
        `costCoverageIncomplete=${String(Boolean(costCoverageIncomplete))})`
    );
  }
}

/**
 * Apply authoritative OzonAccrualDayStatus finality onto bare analytics totals
 * before any stock snapshot write gate. Fail-closed via apply + assert.
 */
export async function overlayOzonAnalyticsWithAccrualDayFinality(params: {
  analytics: {
    totals: OzonProfitTotalsForStockPlanning & {
      taxRevenueCoverageComplete?: boolean;
      discountPointsCoverageComplete?: boolean;
      [key: string]: unknown;
    };
    rows: OzonAnalyticsRow[];
    [key: string]: unknown;
  };
  companyName: string;
  dateFrom: string;
  dateTo: string;
  __testLoadOzonDayStatuses?: (args: {
    companyName?: string | null;
    dateFrom: string;
    dateTo: string;
  }) => Promise<OzonAccrualDayStatusRecord[]>;
  __testExpectedOzonCompanies?: string[] | null;
}) {
  const days = params.__testLoadOzonDayStatuses
    ? await params.__testLoadOzonDayStatuses({
        companyName: params.companyName,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
      })
    : await loadOzonAccrualDayStatuses(
        {
          companyName: params.companyName,
          dateFrom: params.dateFrom,
          dateTo: params.dateTo,
        },
        prisma,
      );

  let expectedCompanyNames: string[] | null | undefined;
  if (params.companyName === "ALL") {
    if (params.__testExpectedOzonCompanies != null) {
      expectedCompanyNames = params.__testExpectedOzonCompanies;
    } else {
      expectedCompanyNames = await listExpectedOzonCompanyNames(prisma);
    }
  }

  const ozonFinality = resolveOzonPeriodFinality({
    companyName: params.companyName,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    days,
    expectedCompanyNames:
      params.companyName === "ALL" ? expectedCompanyNames ?? null : undefined,
  });

  const totals = {
    ...params.analytics.totals,
    netProfitStatus:
      params.analytics.totals?.netProfitStatus === "FINAL"
        ? ("FINAL" as const)
        : ("PRELIMINARY" as const),
  };
  const bareStatus = totals.netProfitStatus;
  applyOzonCanonicalIngestFinality(totals, ozonFinality);
  // Never upgrade bare PRELIMINARY to FINAL via day overlay alone.
  if (bareStatus === "PRELIMINARY") {
    totals.netProfitStatus = "PRELIMINARY";
  }

  return {
    ...params.analytics,
    totals,
  };
}

async function gatherStockAbcSnapshotData(params: {
  companyScope: string;
  marketplace: "WB" | "OZON";
  dateFrom: string;
  dateTo: string;
  assertWbFinality: boolean;
  assertOzonFinality: boolean;
  __testGetProfitAnalyticsOzon?: (args: {
    dateFrom: string;
    dateTo: string;
    usnRate: string;
    vatRate: string;
    companyName: string;
  }) => Promise<{
    totals: OzonProfitTotalsForStockPlanning;
    rows: OzonAnalyticsRow[];
  }>;
  __testLoadOzonDayStatuses?: (args: {
    companyName?: string | null;
    dateFrom: string;
    dateTo: string;
  }) => Promise<OzonAccrualDayStatusRecord[]>;
  __testExpectedOzonCompanies?: string[] | null;
}) {
  const companyScope = normalizeKey(params.companyScope) || "ALL";
  const companyName = companyScope === "ALL" ? "ALL" : companyScope;
  let entries: StockAbcSnapshotEntry[] = [];
  let ozonSalesEntries: StockOzonSalesSnapshotEntry[] = [];
  let wbGeoSalesEntries: StockWbGeoSalesSnapshotEntry[] = [];

  if (params.marketplace === "WB") {
    const { getProfitAnalytics } = await import(
      "@/lib/analytics/profitAnalytics"
    );
    const analytics = await getProfitAnalytics({
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      companyName,
    });

    if (params.assertWbFinality) {
      assertWbFinancialDataFinal(
        analytics.totals,
        "STOCK_ABC_SNAPSHOT"
      );
    }

    entries = buildWbEntries(
      analytics.rows as WbAnalyticsRow[],
      companyScope
    );

    const wbDailyRows = await prisma.wbSale.findMany({
      where: {
        ...(companyScope === "ALL"
          ? {}
          : { companyName: companyScope }),
        reportNumber: {
          startsWith: "WB_DAILY_STATISTICS_",
        },
        saleDate: {
          gte: getDate(params.dateFrom),
          lte: getEndOfDate(params.dateTo),
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
    });

    wbGeoSalesEntries =
      buildStockWbGeoSalesSnapshotEntries(wbDailyRows);
  } else {
    const loadOzon =
      params.__testGetProfitAnalyticsOzon ??
      (async (args: {
        dateFrom: string;
        dateTo: string;
        usnRate: string;
        vatRate: string;
        companyName: string;
      }) => {
        const { getProfitAnalyticsOzon } = await import(
          "@/lib/analytics/profitAnalyticsOzon"
        );
        return getProfitAnalyticsOzon(args);
      });
    const bareAnalytics = await loadOzon({
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      usnRate: "1",
      vatRate: "5",
      companyName,
    });

    const analytics = await overlayOzonAnalyticsWithAccrualDayFinality({
      analytics: bareAnalytics as {
        totals: OzonProfitTotalsForStockPlanning & {
          taxRevenueCoverageComplete?: boolean;
          discountPointsCoverageComplete?: boolean;
        };
        rows: OzonAnalyticsRow[];
      },
      companyName,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      __testLoadOzonDayStatuses: params.__testLoadOzonDayStatuses,
      __testExpectedOzonCompanies: params.__testExpectedOzonCompanies,
    });

    if (params.assertOzonFinality) {
      assertOzonProfitSafeForStockPlanningSnapshot(
        analytics.totals,
        "STOCK_PLANNING_SNAPSHOT"
      );
    }

    const snapshot = buildOzonSnapshot(
      analytics.rows as OzonAnalyticsRow[],
      companyScope
    );

    entries = snapshot.entries;
    ozonSalesEntries = snapshot.ozonSalesEntries;
  }

  return {
    companyScope,
    entries,
    ozonSalesEntries,
    wbGeoSalesEntries,
  };
}

export async function prepareStockAbcSnapshot(params: {
  companyScope: string;
  marketplace: "WB" | "OZON";
  dateFrom: string;
  dateTo: string;
  allowEmpty?: boolean;
  /** @internal test-only Ozon analytics stub */
  __testGetProfitAnalyticsOzon?: (args: {
    dateFrom: string;
    dateTo: string;
    usnRate: string;
    vatRate: string;
    companyName: string;
  }) => Promise<{
    totals: OzonProfitTotalsForStockPlanning;
    rows: OzonAnalyticsRow[];
  }>;
  /** @internal test-only day-status stub */
  __testLoadOzonDayStatuses?: (args: {
    companyName?: string | null;
    dateFrom: string;
    dateTo: string;
  }) => Promise<OzonAccrualDayStatusRecord[]>;
  __testExpectedOzonCompanies?: string[] | null;
}): Promise<PreparedStockAbcSnapshot> {
  const gathered = await gatherStockAbcSnapshotData({
    companyScope: params.companyScope,
    marketplace: params.marketplace,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    assertWbFinality: true,
    assertOzonFinality: true,
    __testGetProfitAnalyticsOzon: params.__testGetProfitAnalyticsOzon,
    __testLoadOzonDayStatuses: params.__testLoadOzonDayStatuses,
    __testExpectedOzonCompanies: params.__testExpectedOzonCompanies,
  });

  if (gathered.entries.length === 0 && !params.allowEmpty) {
    throw new Error(
      `ABC snapshot ${params.marketplace}/${gathered.companyScope} contains no entries`
    );
  }

  const generatedAt = new Date();
  const payload: StockAbcSnapshotPayload = {
    version: SNAPSHOT_VERSION,
    planningVersion: PLANNING_SNAPSHOT_VERSION,
    companyScope: gathered.companyScope,
    marketplace: params.marketplace,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    generatedAt: generatedAt.toISOString(),
    entries: gathered.entries,
    ozonSalesEntries: gathered.ozonSalesEntries,
    wbGeoSalesEntries: gathered.wbGeoSalesEntries,
  };

  return {
    companyScope: gathered.companyScope,
    marketplace: params.marketplace,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    payload,
    rowsCount: gathered.entries.length,
    ozonSalesRowsCount: gathered.ozonSalesEntries.length,
    wbGeoSalesRowsCount: gathered.wbGeoSalesEntries.length,
    generatedAt,
  };
}

export async function persistPreparedStockAbcSnapshot(
  db: SnapshotJobDb | Prisma.TransactionClient | typeof prisma,
  prepared: PreparedStockAbcSnapshot
) {
  const snapshot = await db.stockAbcSnapshot.upsert({
    where: {
      companyScope_marketplace_dateFrom_dateTo: {
        companyScope: prepared.companyScope,
        marketplace: prepared.marketplace,
        dateFrom: getDate(prepared.dateFrom),
        dateTo: getDate(prepared.dateTo),
      },
    },
    create: {
      companyScope: prepared.companyScope,
      marketplace: prepared.marketplace,
      dateFrom: getDate(prepared.dateFrom),
      dateTo: getDate(prepared.dateTo),
      payload: prepared.payload as Prisma.InputJsonValue,
      rowsCount: prepared.rowsCount,
      generatedAt: prepared.generatedAt,
    },
    update: {
      payload: prepared.payload as Prisma.InputJsonValue,
      rowsCount: prepared.rowsCount,
      generatedAt: prepared.generatedAt,
    },
  });

  return {
    id: snapshot.id,
    companyScope: prepared.companyScope,
    marketplace: prepared.marketplace,
    dateFrom: prepared.dateFrom,
    dateTo: prepared.dateTo,
    rowsCount: prepared.rowsCount,
    ozonSalesRowsCount: prepared.ozonSalesRowsCount,
    wbGeoSalesRowsCount: prepared.wbGeoSalesRowsCount,
    generatedAt: prepared.generatedAt.toISOString(),
  };
}

export async function refreshStockAbcSnapshot(params: {
  companyScope: string;
  marketplace: "WB" | "OZON";
  dateFrom: string;
  dateTo: string;
  /** @internal test-only Ozon analytics stub */
  __testGetProfitAnalyticsOzon?: (args: {
    dateFrom: string;
    dateTo: string;
    usnRate: string;
    vatRate: string;
    companyName: string;
  }) => Promise<{
    totals: OzonProfitTotalsForStockPlanning;
    rows: OzonAnalyticsRow[];
  }>;
  /** @internal test-only day-status stub */
  __testLoadOzonDayStatuses?: (args: {
    companyName?: string | null;
    dateFrom: string;
    dateTo: string;
  }) => Promise<OzonAccrualDayStatusRecord[]>;
  __testExpectedOzonCompanies?: string[] | null;
  /** @internal test-only upsert hook to prove no write on fail-closed */
  __testUpsertStockAbcSnapshot?: (args: unknown) => Promise<{ id: string }>;
}) {
  const companyScope = normalizeKey(params.companyScope) || "ALL";
  const companyName = companyScope === "ALL" ? "ALL" : companyScope;
  let entries: StockAbcSnapshotEntry[] = [];
  let ozonSalesEntries: StockOzonSalesSnapshotEntry[] = [];

  if (params.marketplace === "WB") {
    const { getProfitAnalytics } = await import(
      "@/lib/analytics/profitAnalytics"
    );
    const analytics = await getProfitAnalytics({
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      companyName,
    });
    assertWbFinancialDataFinal(
      analytics.totals,
      "STOCK_ABC_SNAPSHOT"
    );

    entries = buildWbEntries(
      analytics.rows as WbAnalyticsRow[],
      companyScope
    );
  } else {
    const loadOzon =
      params.__testGetProfitAnalyticsOzon ??
      (async (args: {
        dateFrom: string;
        dateTo: string;
        usnRate: string;
        vatRate: string;
        companyName: string;
      }) => {
        const { getProfitAnalyticsOzon } = await import(
          "@/lib/analytics/profitAnalyticsOzon"
        );
        return getProfitAnalyticsOzon(args);
      });
    const bareAnalytics = await loadOzon({
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      usnRate: "1",
      vatRate: "5",
      companyName,
    });
    const analytics = await overlayOzonAnalyticsWithAccrualDayFinality({
      analytics: bareAnalytics as {
        totals: OzonProfitTotalsForStockPlanning & {
          taxRevenueCoverageComplete?: boolean;
          discountPointsCoverageComplete?: boolean;
        };
        rows: OzonAnalyticsRow[];
      },
      companyName,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      __testLoadOzonDayStatuses: params.__testLoadOzonDayStatuses,
      __testExpectedOzonCompanies: params.__testExpectedOzonCompanies,
    });
    assertOzonProfitSafeForStockPlanningSnapshot(
      analytics.totals,
      "STOCK_ABC_SNAPSHOT_REFRESH"
    );
    const snapshot = buildOzonSnapshot(
      analytics.rows as OzonAnalyticsRow[],
      companyScope
    );

    entries = snapshot.entries;
    ozonSalesEntries = snapshot.ozonSalesEntries;
  }

  if (entries.length === 0) {
    throw new Error(
      `ABC snapshot ${params.marketplace}/${companyScope} contains no entries`
    );
  }

  const generatedAt = new Date();
  const payload: StockAbcSnapshotPayload = {
    version: SNAPSHOT_VERSION,
    companyScope,
    marketplace: params.marketplace,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    generatedAt: generatedAt.toISOString(),
    entries,
    ozonSalesEntries,
  };

  const snapshot = await (params.__testUpsertStockAbcSnapshot
    ? params.__testUpsertStockAbcSnapshot({
        where: {
          companyScope_marketplace_dateFrom_dateTo: {
            companyScope,
            marketplace: params.marketplace,
            dateFrom: getDate(params.dateFrom),
            dateTo: getDate(params.dateTo),
          },
        },
        create: {
          companyScope,
          marketplace: params.marketplace,
          dateFrom: getDate(params.dateFrom),
          dateTo: getDate(params.dateTo),
          payload: payload as Prisma.InputJsonValue,
          rowsCount: entries.length,
          generatedAt,
        },
        update: {
          payload: payload as Prisma.InputJsonValue,
          rowsCount: entries.length,
          generatedAt,
        },
      })
    : prisma.stockAbcSnapshot.upsert({
        where: {
          companyScope_marketplace_dateFrom_dateTo: {
            companyScope,
            marketplace: params.marketplace,
            dateFrom: getDate(params.dateFrom),
            dateTo: getDate(params.dateTo),
          },
        },
        create: {
          companyScope,
          marketplace: params.marketplace,
          dateFrom: getDate(params.dateFrom),
          dateTo: getDate(params.dateTo),
          payload: payload as Prisma.InputJsonValue,
          rowsCount: entries.length,
          generatedAt,
        },
        update: {
          payload: payload as Prisma.InputJsonValue,
          rowsCount: entries.length,
          generatedAt,
        },
      }));

  return {
    id: snapshot.id,
    companyScope,
    marketplace: params.marketplace,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    rowsCount: entries.length,
    ozonSalesRowsCount: ozonSalesEntries.length,
    generatedAt: generatedAt.toISOString(),
  };
}

async function findSnapshot(params: {
  companyScope: string;
  marketplace: "WB" | "OZON";
  dateFrom: string;
  dateTo: string;
}) {
  const exact = await prisma.stockAbcSnapshot.findUnique({
    where: {
      companyScope_marketplace_dateFrom_dateTo: {
        companyScope: params.companyScope,
        marketplace: params.marketplace,
        dateFrom: getDate(params.dateFrom),
        dateTo: getDate(params.dateTo),
      },
    },
  });

  if (exact) return { snapshot: exact, exact: true };

  if (params.companyScope !== "ALL") {
    const allExact = await prisma.stockAbcSnapshot.findUnique({
      where: {
        companyScope_marketplace_dateFrom_dateTo: {
          companyScope: "ALL",
          marketplace: params.marketplace,
          dateFrom: getDate(params.dateFrom),
          dateTo: getDate(params.dateTo),
        },
      },
    });

    if (allExact) return { snapshot: allExact, exact: false };
  }

  const latest = await prisma.stockAbcSnapshot.findFirst({
    where: {
      companyScope: params.companyScope,
      marketplace: params.marketplace,
    },
    orderBy: [{ generatedAt: "desc" }, { updatedAt: "desc" }],
  });

  if (latest) return { snapshot: latest, exact: false };

  if (params.companyScope !== "ALL") {
    const latestAll = await prisma.stockAbcSnapshot.findFirst({
      where: {
        companyScope: "ALL",
        marketplace: params.marketplace,
      },
      orderBy: [{ generatedAt: "desc" }, { updatedAt: "desc" }],
    });

    if (latestAll) return { snapshot: latestAll, exact: false };
  }

  return { snapshot: null, exact: false };
}

export async function readStockAbcSnapshots(params: {
  companyScope: string;
  dateFrom: string;
  dateTo: string;
}) {
  const companyScope = normalizeKey(params.companyScope) || "ALL";
  const results = await Promise.all(
    MARKETPLACES.map(async (marketplace) => ({
      marketplace,
      ...(await findSnapshot({
        companyScope,
        marketplace,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
      })),
    }))
  );

  const entries = {
    WB: [] as StockAbcSnapshotEntry[],
    OZON: [] as StockAbcSnapshotEntry[],
  };
  let ozonSalesEntries: StockOzonSalesSnapshotEntry[] = [];
  const metadata: Array<{
    marketplace: "WB" | "OZON";
    exact: boolean;
    dateFrom: string | null;
    dateTo: string | null;
    generatedAt: string | null;
    rowsCount: number;
  }> = [];

  for (const result of results) {
    const payload = result.snapshot
      ? parsePayload(result.snapshot.payload)
      : null;
    const filterCompany = <T extends { companyName: string }>(rows: T[]) =>
      companyScope === "ALL"
        ? rows
        : rows.filter((row) => row.companyName === companyScope);

    if (payload) {
      entries[result.marketplace] = filterCompany(payload.entries);

      if (result.marketplace === "OZON") {
        ozonSalesEntries = filterCompany(payload.ozonSalesEntries);
      }
    }

    metadata.push({
      marketplace: result.marketplace,
      exact: Boolean(result.exact && payload),
      dateFrom:
        result.snapshot?.dateFrom.toISOString().slice(0, 10) ?? null,
      dateTo:
        result.snapshot?.dateTo.toISOString().slice(0, 10) ?? null,
      generatedAt:
        result.snapshot?.generatedAt.toISOString() ?? null,
      rowsCount:
        result.marketplace === "OZON"
          ? entries.OZON.length
          : entries.WB.length,
    });
  }

  return {
    companyScope,
    requestedDateFrom: params.dateFrom,
    requestedDateTo: params.dateTo,
    wbEntries: entries.WB,
    ozonEntries: entries.OZON,
    ozonSalesEntries,
    metadata,
    isExact: metadata.every((item) => item.exact),
    hasAnySnapshot: metadata.some((item) => item.rowsCount > 0),
  };
}
