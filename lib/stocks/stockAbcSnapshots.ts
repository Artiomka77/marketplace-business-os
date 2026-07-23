import type { Prisma } from "@prisma/client";

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

type StockAbcSnapshotPayload = {
  version: 1 | 2;
  companyScope: string;
  marketplace: "WB" | "OZON";
  dateFrom: string;
  dateTo: string;
  generatedAt: string;
  entries: StockAbcSnapshotEntry[];
  ozonSalesEntries: StockOzonSalesSnapshotEntry[];
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

function parsePayload(
  value: Prisma.JsonValue
): StockAbcSnapshotPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const payload = value as Record<string, unknown>;
  const version = payload.version === 2 ? 2 : payload.version === 1 ? 1 : null;

  if (!version || !Array.isArray(payload.entries)) {
    return null;
  }

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

  return {
    version,
    companyScope: normalizeKey(payload.companyScope),
    marketplace: payload.marketplace === "OZON" ? "OZON" : "WB",
    dateFrom: normalizeKey(payload.dateFrom),
    dateTo: normalizeKey(payload.dateTo),
    generatedAt: normalizeKey(payload.generatedAt),
    entries,
    ozonSalesEntries,
  };
}

export async function refreshStockAbcSnapshot(params: {
  companyScope: string;
  marketplace: "WB" | "OZON";
  dateFrom: string;
  dateTo: string;
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

    entries = buildWbEntries(
      analytics.rows as WbAnalyticsRow[],
      companyScope
    );
  } else {
    const { getProfitAnalyticsOzon } = await import(
      "@/lib/analytics/profitAnalyticsOzon"
    );
    const analytics = await getProfitAnalyticsOzon({
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      usnRate: "1",
      vatRate: "5",
      companyName,
    });
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

  const snapshot = await prisma.stockAbcSnapshot.upsert({
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
  });

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
