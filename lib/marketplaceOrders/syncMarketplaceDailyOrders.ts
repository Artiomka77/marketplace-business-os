import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

type MarketplaceName = "WB" | "OZON";
type MarketplaceFilter = MarketplaceName | "ALL";
type SyncMode = "daily" | "recheck" | "manual";

const DEFAULT_SAFE_RECHECK_DAYS = 3;
const MAX_SAFE_RECHECK_DAYS = 7;
const MAX_MANUAL_SYNC_DAYS = 31;
const DEFAULT_WB_REQUEST_DELAY_MS = 3_000;
const DEFAULT_GENERAL_REQUEST_DELAY_MS = 700;

export type OrderScopeFilter = {
  companyName: string;
  marketplace: MarketplaceName;
  date: string;
};

export type SyncPeriodOptions = {
  date?: Date;
  dateFrom?: Date;
  dateTo?: Date;
  /**
   * daily — безопасный режим по умолчанию: только вчера.
   * recheck — мягкая перепроверка последних 3 дней, максимум 7 дней.
   * manual — явный диапазон dateFrom/dateTo, максимум 31 день.
   */
  mode?: SyncMode;
  /**
   * Используется только для mode="recheck". По умолчанию 3 дня.
   */
  recheckDays?: number;
  /**
   * Можно синхронизировать только WB, только Ozon или оба маркетплейса.
   */
  marketplace?: MarketplaceFilter;
  /**
   * Пауза между обычными запросами/маркетплейсами.
   */
  delayMs?: number;
  /**
   * Отдельная более длинная пауза между WB-запросами, чтобы снизить риск 429.
   */
  wbDelayMs?: number;
  /**
   * Если WB вернул 429, не продолжаем WB в этом запуске.
   */
  stopWbOnRateLimit?: boolean;
  /**
   * Bounded recovery filter. Absent/undefined preserves full existing behavior.
   */
  scopeFilter?: OrderScopeFilter[];
  getCompanies?: () => Promise<CompanyWithConnection[]>;
  onScopeCall?: (scope: OrderScopeFilter) => void;
  executeWb?: (params: {
    company: CompanyWithConnection;
    date: Date;
    delayMs: number;
  }) => Promise<Record<string, unknown>>;
  executeOzon?: (params: {
    company: CompanyWithConnection;
    date: Date;
  }) => Promise<Record<string, unknown>>;
};

type CompanyWithConnection = {
  id: string;
  name: string;
  apiConnections: {
    marketplace: string;
    isEnabled: boolean;
    wbToken: string | null;
    ozonClientId: string | null;
    ozonApiKey: string | null;
  }[];
};

type WbOrderRow = {
  date?: string;
  lastChangeDate?: string;
  totalPrice?: number;
  discountPercent?: number;
  spp?: number;
  finishedPrice?: number;
  priceWithDisc?: number;
  isCancel?: boolean;
  cancelDate?: string;
};

type WbSalesFunnelProduct = {
  product?: {
    nmId?: number | string;
    vendorCode?: string;
    title?: string;
  };
  nmId?: number | string;
  vendorCode?: string;
  statistic?: {
    selected?: {
      orderCount?: number;
      ordersCount?: number;
      orderSum?: number;
      ordersSumRub?: number;
    };
  };
};

type TopOrderPersistRow = {
  article: string;
  sku?: string | null;
  vendorCode?: string | null;
  title?: string | null;
  nmId: string | null;
  qty: number;
  amount: number;
  orderAmount?: number;
};

type WbSalesFunnelResponse = {
  data?: {
    products?: WbSalesFunnelProduct[];
  };
};

type OzonAnalyticsDataRow = {
  dimensions?: { id?: string; name?: string }[];
  metrics?: unknown[];
};

type OzonAnalyticsResponse = {
  result?: {
    data?: OzonAnalyticsDataRow[];
    total?: number;
  };
};

function startOfUtcDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0)
  );
}


function getYesterdayMoscowDate(now = new Date()) {
  const moscowNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return new Date(
    Date.UTC(
      moscowNow.getUTCFullYear(),
      moscowNow.getUTCMonth(),
      moscowNow.getUTCDate() - 1,
      12,
      0,
      0
    )
  );
}

function getSafeRecheckDays(value: unknown) {
  const number = Math.trunc(toNumber(value));
  if (number <= 0) return DEFAULT_SAFE_RECHECK_DAYS;
  return Math.min(number, MAX_SAFE_RECHECK_DAYS);
}

function getPositiveDelayMs(value: unknown, fallback: number) {
  const number = Math.trunc(toNumber(value));
  if (number < 0) return fallback;
  return number;
}

function getDateRange(options: SyncPeriodOptions = {}) {
  const mode: SyncMode =
    options.mode ??
    (options.dateFrom || options.dateTo ? "manual" : "daily");

  const defaultDateTo = getYesterdayMoscowDate();

  const dateTo = startOfUtcDay(options.dateTo ?? options.date ?? defaultDateTo);

  const dateFrom = startOfUtcDay(
    options.dateFrom ??
      options.date ??
      (mode === "recheck"
        ? addUtcDays(dateTo, -(getSafeRecheckDays(options.recheckDays) - 1))
        : dateTo)
  );

  if (dateFrom.getTime() > dateTo.getTime()) {
    throw new Error("dateFrom не может быть позже dateTo");
  }

  const dates: Date[] = [];

  for (
    const cursor = new Date(dateFrom);
    cursor.getTime() <= dateTo.getTime();
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    dates.push(
      new Date(
        Date.UTC(
          cursor.getUTCFullYear(),
          cursor.getUTCMonth(),
          cursor.getUTCDate(),
          12,
          0,
          0
        )
      )
    );
  }

  const maxDays = mode === "recheck" ? MAX_SAFE_RECHECK_DAYS : MAX_MANUAL_SYNC_DAYS;

  if (dates.length > maxDays) {
    throw new Error(
      `Период синхронизации заказов слишком большой: ${dates.length} дней. Для режима ${mode} максимум: ${maxDays} дней.`
    );
  }

  return dates;
}


function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function sleep(ms: number) {
  if (ms <= 0) return Promise.resolve();

  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorToMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRateLimitError(error: unknown) {
  const message = errorToMessage(error).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("too many requests") ||
    message.includes("rate limit") ||
    message.includes("limited") ||
    message.includes("лимит")
  );
}

export type MarketplaceOrderWorkStatus =
  | "completed"
  | "not_configured"
  | "skipped"
  | "failed";

const NOT_CONFIGURED_ORDER_REASONS = new Set([
  "WB token is not configured",
  "Ozon Client-Id or Api-Key is not configured",
]);

type MarketplaceOrderRowLike = {
  skipped?: boolean;
  isRateLimit?: boolean;
  reason?: string;
  companyName?: string;
  marketplace?: string;
  date?: string;
};

export function classifyMarketplaceOrderRow(row: MarketplaceOrderRowLike) {
  if (!row.skipped) {
    return {
      status: "completed" as const,
      requiredIncomplete: false,
      retryable: false,
    };
  }

  if (NOT_CONFIGURED_ORDER_REASONS.has(String(row.reason ?? ""))) {
    return {
      status: "not_configured" as const,
      requiredIncomplete: false,
      retryable: false,
    };
  }

  const retryable = Boolean(row.isRateLimit);
  return {
    status: (retryable ? "skipped" : "failed") as "skipped" | "failed",
    requiredIncomplete: true,
    retryable,
  };
}

export function reasonCodeFromFailure(reason?: string | null, isRateLimit?: boolean): string {
  if (isRateLimit) return "RATE_LIMIT";
  const text = String(reason ?? "").toLowerCase();
  if (NOT_CONFIGURED_ORDER_REASONS.has(String(reason ?? ""))) return "NOT_CONFIGURED";
  if (text.includes("429") || text.includes("rate limit") || text.includes("лимит")) return "RATE_LIMIT";
  if (text.includes("timeout")) return "TIMEOUT";
  if (/\b50[0-9]\b/.test(text)) return "UPSTREAM_5XX";
  if (text.includes("401") || text.includes("403")) return "UPSTREAM_AUTH";
  return "UPSTREAM_ERROR";
}

export function summarizeMarketplaceOrderRows(results: MarketplaceOrderRowLike[]) {
  const annotated = results.map((row) => {
    const classified = classifyMarketplaceOrderRow(row);
    return {
      ...row,
      status: classified.status,
    };
  });
  const incomplete = results
    .map((row) => ({ row, classified: classifyMarketplaceOrderRow(row) }))
    .filter((item) => item.classified.requiredIncomplete);
  const ok = incomplete.length === 0;
  const retryable = !ok && incomplete.every((item) => item.classified.retryable);

  return {
    ok,
    retryable,
    annotated,
    incompleteRequired: incomplete.map(({ row, classified }) => ({
      companyName: row.companyName ?? null,
      marketplace: row.marketplace ?? null,
      date: row.date ?? null,
      reason: reasonCodeFromFailure(row.reason, classified.retryable),
      reasonCode: reasonCodeFromFailure(row.reason, classified.retryable),
      status: classified.status,
      retryable: classified.retryable,
    })),
  };
}

export type MarketplaceOrderSyncResult = {
  ok: boolean;
  retryable: boolean;
  mode: string;
  marketplace: MarketplaceFilter;
  dates: string[];
  safeRecheckDays: number | null;
  wbStoppedByRateLimit: boolean;
  incompleteRequired: ReturnType<typeof summarizeMarketplaceOrderRows>["incompleteRequired"];
  results: ReturnType<typeof summarizeMarketplaceOrderRows>["annotated"];
  partialSuccess: boolean;
};

export function marketplaceOrdersHttpStatus(result: {
  ok: boolean;
  retryable?: boolean;
}): 200 | 503 | 500 {
  if (result.ok) return 200;
  return result.retryable ? 503 : 500;
}

function shouldSyncMarketplace(
  filter: MarketplaceFilter | undefined,
  marketplace: MarketplaceName
) {
  return !filter || filter === "ALL" || filter === marketplace;
}

function allowsScope(
  scopeFilter: OrderScopeFilter[] | undefined,
  companyName: string,
  marketplace: MarketplaceName,
  date: string
) {
  if (!scopeFilter) return true;
  return scopeFilter.some(
    (scope) =>
      scope.companyName === companyName &&
      scope.marketplace === marketplace &&
      scope.date === date
  );
}

function toNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;

  const number = Number(
    String(value)
      .replace(/\s/g, "")
      .replace(",", ".")
      .replace(/[^\d.-]/g, "")
  );

  return Number.isFinite(number) ? number : 0;
}

function getWbOrderAmount(row: WbOrderRow) {
  const priceWithDisc = toNumber(row.priceWithDisc);
  if (priceWithDisc > 0) return priceWithDisc;

  const finishedPrice = toNumber(row.finishedPrice);
  if (finishedPrice > 0) return finishedPrice;

  const totalPrice = toNumber(row.totalPrice);
  const discountPercent = toNumber(row.discountPercent);

  if (totalPrice > 0 && discountPercent > 0) {
    return totalPrice * (1 - discountPercent / 100);
  }

  return totalPrice;
}

function getWbAmountCandidates(rows: WbOrderRow[]) {
  return {
    rows: rows.length,
    activeRows: rows.filter((row) => !row.isCancel).length,
    cancelledRows: rows.filter((row) => row.isCancel).length,

    // Основной кандидат для сверки с кабинетом WB “Заказано на сумму”.
    priceWithDiscAll: rows.reduce(
      (sum, row) => sum + toNumber(row.priceWithDisc),
      0
    ),
    priceWithDiscActive: rows
      .filter((row) => !row.isCancel)
      .reduce((sum, row) => sum + toNumber(row.priceWithDisc), 0),

    finishedPriceAll: rows.reduce(
      (sum, row) => sum + toNumber(row.finishedPrice),
      0
    ),
    finishedPriceActive: rows
      .filter((row) => !row.isCancel)
      .reduce((sum, row) => sum + toNumber(row.finishedPrice), 0),

    totalPriceAll: rows.reduce((sum, row) => sum + toNumber(row.totalPrice), 0),
    totalPriceActive: rows
      .filter((row) => !row.isCancel)
      .reduce((sum, row) => sum + toNumber(row.totalPrice), 0),

    calculatedAll: rows.reduce((sum, row) => sum + getWbOrderAmount(row), 0),
    calculatedActive: rows
      .filter((row) => !row.isCancel)
      .reduce((sum, row) => sum + getWbOrderAmount(row), 0),
  };
}

async function fetchWbOrdersForDate(wbToken: string, date: Date) {
  const dateText = formatDateOnly(date);
  const url = new URL("https://statistics-api.wildberries.ru/api/v1/supplier/orders");
  url.searchParams.set("dateFrom", `${dateText}T00:00:00`);
  url.searchParams.set("flag", "1");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: wbToken,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`WB Orders API: ${response.status} ${text}`.trim());
  }

  return (await response.json()) as WbOrderRow[];
}

function addUtcDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

async function fetchWbSalesFunnelForDate(wbToken: string, date: Date) {
  const dateText = formatDateOnly(date);
  const pastDateText = formatDateOnly(addUtcDays(date, -1));
  const limit = 1000;
  let offset = 0;

  let ordersQty = 0;
  let ordersAmount = 0;
  let productsCount = 0;
  const samples: WbSalesFunnelProduct[] = [];
  const ranked: TopOrderPersistRow[] = [];

  while (true) {
    const response = await fetch(
      "https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products",
      {
        method: "POST",
        headers: {
          Authorization: wbToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          selectedPeriod: {
            start: dateText,
            end: dateText,
          },
          // WB Sales Funnel требует, чтобы pastPeriod был раньше selectedPeriod.
          // Для нашей сверки нужен только selectedPeriod, но API всё равно валидирует пару периодов.
          // Поэтому для однодневного отчёта ставим pastPeriod на предыдущий день.
          pastPeriod: {
            start: pastDateText,
            end: pastDateText,
          },
          nmIds: [],
          brandNames: [],
          subjectIds: [],
          tagIds: [],
          skipDeletedNm: false,
          limit,
          offset,
        }),
        cache: "no-store",
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`WB Sales Funnel API: ${response.status} ${text}`.trim());
    }

    const json = (await response.json()) as WbSalesFunnelResponse;
    const products = json.data?.products ?? [];

    productsCount += products.length;

    for (const product of products) {
      const selected = product.statistic?.selected;
      const qty = Math.trunc(
        toNumber(selected?.orderCount ?? selected?.ordersCount)
      );
      const amount = toNumber(selected?.orderSum ?? selected?.ordersSumRub);
      ordersQty += qty;
      ordersAmount += amount;

      const nmId = String(
        product.product?.nmId ?? product.nmId ?? ""
      ).trim() || null;
      const article = String(
        product.product?.vendorCode ?? product.vendorCode ?? nmId ?? ""
      ).trim();
      if (article || qty > 0 || amount > 0) {
        ranked.push({
          article: article || "UNKNOWN",
          nmId,
          qty,
          amount,
        });
      }

      if (samples.length < 5) {
        samples.push(product);
      }
    }

    if (products.length < limit) break;

    offset += limit;
  }

  ranked.sort((a, b) => b.amount - a.amount || b.qty - a.qty);

  return {
    ordersQty,
    ordersAmount,
    productsCount,
    sample: samples,
    topByOrderAmount: ranked.slice(0, 50),
  };
}

async function fetchOzonOrdersForDate(
  clientId: string,
  apiKey: string,
  date: Date
) {
  const dateText = formatDateOnly(date);
  const limit = 1000;
  let offset = 0;
  let ordersQty = 0;
  let ordersAmount = 0;
  const rawData: OzonAnalyticsDataRow[] = [];

  while (true) {
    const response = await fetch("https://api-seller.ozon.ru/v1/analytics/data", {
      method: "POST",
      headers: {
        "Client-Id": clientId,
        "Api-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        date_from: dateText,
        date_to: dateText,
        metrics: ["revenue", "ordered_units"],
        dimension: ["day"],
        filters: [],
        sort: [{ key: "day", order: "ASC" }],
        limit,
        offset,
      }),
      cache: "no-store",
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Ozon Analytics API: ${response.status} ${text}`.trim());
    }

    const json = (await response.json()) as OzonAnalyticsResponse;
    const rows = json.result?.data ?? [];

    rawData.push(...rows);

    for (const row of rows) {
      ordersAmount += toNumber(row.metrics?.[0]);
      ordersQty += Math.trunc(toNumber(row.metrics?.[1]));
    }

    if (rows.length < limit) break;

    offset += limit;
  }

  // SKU-level true orders for Telegram TOP-3 (paginate; map SKU id -> vendorCode later).
  let topByOrderAmount: TopOrderPersistRow[] = [];
  try {
    const ranked: TopOrderPersistRow[] = [];
    let skuOffset = 0;
    const skuLimit = 1000;
    while (true) {
      const skuResponse = await fetch(
        "https://api-seller.ozon.ru/v1/analytics/data",
        {
          method: "POST",
          headers: {
            "Client-Id": clientId,
            "Api-Key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            date_from: dateText,
            date_to: dateText,
            metrics: ["ordered_units", "revenue"],
            dimension: ["sku"],
            filters: [],
            sort: [{ key: "revenue", order: "DESC" }],
            limit: skuLimit,
            offset: skuOffset,
          }),
          cache: "no-store",
        }
      );
      if (!skuResponse.ok) break;
      const skuJson = (await skuResponse.json()) as OzonAnalyticsResponse;
      const page = skuJson.result?.data ?? [];
      for (const row of page) {
        const dims = row.dimensions ?? [];
        // Ozon sku dimension: id = numeric SKU, name = product title (do NOT use title as article).
        const skuDim =
          dims.find((d) => String(d.id ?? "").toLowerCase() === "sku") ??
          dims[0];
        const sku = String(
          // When dimension=["sku"], each row's dimension entry usually has id=<sku> name=<title>
          // or id="sku" name=<sku>. Prefer numeric-looking id, else name if numeric.
          (() => {
            const a = String(skuDim?.id ?? "").trim();
            const b = String(skuDim?.name ?? "").trim();
            if (/^\d+$/.test(a)) return a;
            if (/^\d+$/.test(b)) return b;
            return a && a.toLowerCase() !== "sku" ? a : b;
          })()
        ).trim();
        const qty = Math.trunc(toNumber(row.metrics?.[0]));
        const amount = toNumber(row.metrics?.[1]);
        if (!sku && qty === 0 && amount === 0) continue;
        ranked.push({
          article: sku ? `Ozon SKU ${sku}` : "UNKNOWN",
          sku: sku || null,
          vendorCode: null,
          nmId: null,
          qty,
          amount,
        });
      }
      if (page.length < skuLimit) break;
      skuOffset += skuLimit;
    }
    // Resolve vendorCode from OzonProduct mapping (seller article is primary label).
    if (ranked.length > 0) {
      const skus = ranked
        .map((r) => r.sku)
        .filter((s): s is string => Boolean(s));
      if (skus.length > 0) {
        // companyName not in fetchOzonOrdersForDate — resolve in upsert caller.
        // Keep sku in article fallback; syncOzonDailyOrdersForCompany remaps.
      }
    }
    ranked.sort((a, b) => b.amount - a.amount || b.qty - a.qty);
    topByOrderAmount = ranked.slice(0, 50);
  } catch {
    topByOrderAmount = [];
  }

  return {
    ordersQty,
    ordersAmount,
    rawData,
    topByOrderAmount,
  };
}

async function upsertDailyOrderStat(params: {
  companyName: string;
  marketplace: MarketplaceName;
  orderDate: Date;
  ordersQty: number;
  ordersAmount: number;
  rawJson: unknown;
}) {
  const successfulSyncAt = new Date();
  await prisma.marketplaceDailyOrderStat.upsert({
    where: {
      companyName_marketplace_orderDate: {
        companyName: params.companyName,
        marketplace: params.marketplace,
        orderDate: params.orderDate,
      },
    },
    create: {
      companyName: params.companyName,
      marketplace: params.marketplace,
      orderDate: params.orderDate,
      ordersQty: params.ordersQty,
      ordersAmount: params.ordersAmount,
      source: "API",
      rawJson: params.rawJson as Prisma.InputJsonValue,
      lastSuccessfulSyncAt: successfulSyncAt,
    },
    update: {
      ordersQty: params.ordersQty,
      ordersAmount: params.ordersAmount,
      source: "API",
      rawJson: params.rawJson as Prisma.InputJsonValue,
      lastSuccessfulSyncAt: successfulSyncAt,
    },
  });
}

async function getCompaniesWithConnections() {
  return prisma.company.findMany({
    where: {
      isActive: true,
    },
    orderBy: {
      name: "asc",
    },
    include: {
      apiConnections: true,
    },
  }) as Promise<CompanyWithConnection[]>;
}

export async function syncWbDailyOrdersForCompany(params: {
  company: CompanyWithConnection;
  date: Date;
  delayMs?: number;
}) {
  const connection = params.company.apiConnections.find(
    (item) => item.marketplace === "WB" && item.isEnabled
  );

  if (!connection?.wbToken) {
    return {
      marketplace: "WB",
      companyName: params.company.name,
      date: formatDateOnly(params.date),
      skipped: true,
      reason: "WB token is not configured",
    };
  }

  const rows = await fetchWbOrdersForDate(connection.wbToken, params.date);
  const amountCandidates = getWbAmountCandidates(rows);

  const supplierOrdersQty = rows.length;
  const supplierOrdersAmount = rows.reduce(
    (sum, row) => sum + getWbOrderAmount(row),
    0
  );

  let source = "WB Sales Funnel API";
  let ordersQty = supplierOrdersQty;
  let ordersAmount = supplierOrdersAmount;
  let funnelResult:
    | Awaited<ReturnType<typeof fetchWbSalesFunnelForDate>>
    | null = null;
  let funnelError: string | null = null;

  try {
    await sleep(params.delayMs ?? DEFAULT_WB_REQUEST_DELAY_MS);

    funnelResult = await fetchWbSalesFunnelForDate(
      connection.wbToken,
      params.date
    );

    ordersQty = funnelResult.ordersQty;
    ordersAmount = funnelResult.ordersAmount;
  } catch (error) {
    source = "WB supplier/orders fallback";
    funnelError = error instanceof Error ? error.message : "Unknown error";
  }

  await upsertDailyOrderStat({
    companyName: params.company.name,
    marketplace: "WB",
    orderDate: params.date,
    ordersQty,
    ordersAmount,
    rawJson: {
      source,
      funnelError,
      topByOrderAmount: funnelResult?.topByOrderAmount ?? [],
      funnelResult: funnelResult
        ? {
            selectedDate: formatDateOnly(params.date),
            pastDate: formatDateOnly(addUtcDays(params.date, -1)),
            ordersQty: funnelResult.ordersQty,
            ordersAmount: funnelResult.ordersAmount,
            productsCount: funnelResult.productsCount,
            sample: funnelResult.sample,
            topByOrderAmount: funnelResult.topByOrderAmount,
          }
        : null,
      supplierOrders: {
        ordersQty: supplierOrdersQty,
        ordersAmount: supplierOrdersAmount,
        ...amountCandidates,
        sample: rows.slice(0, 5),
      },
    },
  });

  return {
    marketplace: "WB",
    companyName: params.company.name,
    date: formatDateOnly(params.date),
    ordersQty,
    ordersAmount,
    source,
    funnelError,
    funnelResult: funnelResult
      ? {
          selectedDate: formatDateOnly(params.date),
          pastDate: formatDateOnly(addUtcDays(params.date, -1)),
          ordersQty: funnelResult.ordersQty,
          ordersAmount: funnelResult.ordersAmount,
          productsCount: funnelResult.productsCount,
        }
      : null,
    supplierOrders: {
      ordersQty: supplierOrdersQty,
      ordersAmount: supplierOrdersAmount,
      amountCandidates,
    },
    skipped: false,
  };
}

export async function syncOzonDailyOrdersForCompany(params: {
  company: CompanyWithConnection;
  date: Date;
}) {
  const connection = params.company.apiConnections.find(
    (item) => item.marketplace === "OZON" && item.isEnabled
  );

  if (!connection?.ozonClientId || !connection.ozonApiKey) {
    return {
      marketplace: "OZON",
      companyName: params.company.name,
      date: formatDateOnly(params.date),
      skipped: true,
      reason: "Ozon Client-Id or Api-Key is not configured",
    };
  }

  const result = await fetchOzonOrdersForDate(
    connection.ozonClientId,
    connection.ozonApiKey,
    params.date
  );

  let topByOrderAmount = result.topByOrderAmount ?? [];
  const skus = topByOrderAmount
    .map((r) => r.sku)
    .filter((s): s is string => Boolean(s));
  if (skus.length > 0) {
    const products = await prisma.ozonProduct.findMany({
      where: {
        companyName: params.company.name,
        sku: { in: skus },
      },
      select: { sku: true, vendorCode: true, productName: true },
    });
    const bySku = new Map(
      products.map((p) => [
        p.sku,
        {
          vendorCode: p.vendorCode?.trim() || null,
          title: p.productName ? String(p.productName).slice(0, 80) : null,
        },
      ])
    );
    topByOrderAmount = topByOrderAmount.map((row) => {
      const mapped = row.sku ? bySku.get(row.sku) : undefined;
      const vendorCode = mapped?.vendorCode || row.vendorCode || null;
      return {
        ...row,
        vendorCode,
        title: mapped?.title || row.title || null,
        article: vendorCode || (row.sku ? `Ozon SKU ${row.sku}` : row.article),
        orderAmount: row.amount,
      };
    });
  }

  await upsertDailyOrderStat({
    companyName: params.company.name,
    marketplace: "OZON",
    orderDate: params.date,
    ordersQty: result.ordersQty,
    ordersAmount: result.ordersAmount,
    rawJson: {
      sample: result.rawData.slice(0, 10),
      rows: result.rawData.length,
      topByOrderAmount,
      ozonSkuOrders: {
        topByOrderAmount,
      },
    },
  });

  return {
    marketplace: "OZON",
    companyName: params.company.name,
    date: formatDateOnly(params.date),
    ordersQty: result.ordersQty,
    ordersAmount: result.ordersAmount,
    skipped: false,
  };
}

async function safeSyncWbDailyOrdersForCompany(params: {
  company: CompanyWithConnection;
  date: Date;
  delayMs: number;
}) {
  try {
    return await syncWbDailyOrdersForCompany(params);
  } catch (error) {
    return {
      marketplace: "WB" as const,
      companyName: params.company.name,
      date: formatDateOnly(params.date),
      skipped: true,
      reason: errorToMessage(error),
      isRateLimit: isRateLimitError(error),
    };
  }
}

async function safeSyncOzonDailyOrdersForCompany(params: {
  company: CompanyWithConnection;
  date: Date;
}) {
  try {
    return await syncOzonDailyOrdersForCompany(params);
  } catch (error) {
    return {
      marketplace: "OZON" as const,
      companyName: params.company.name,
      date: formatDateOnly(params.date),
      skipped: true,
      reason: errorToMessage(error),
      isRateLimit: isRateLimitError(error),
    };
  }
}

export async function syncMarketplaceDailyOrders(
  options: SyncPeriodOptions = {}
): Promise<MarketplaceOrderSyncResult> {
  const dates = getDateRange(options);
  const companies = await (options.getCompanies ?? getCompaniesWithConnections)();
  const results = [];
  const marketplaceFilter = options.marketplace ?? "ALL";
  const shouldStopWbOnRateLimit = options.stopWbOnRateLimit ?? true;
  const wbDelayMs = getPositiveDelayMs(
    options.wbDelayMs,
    DEFAULT_WB_REQUEST_DELAY_MS
  );
  const generalDelayMs = getPositiveDelayMs(
    options.delayMs,
    DEFAULT_GENERAL_REQUEST_DELAY_MS
  );
  let wbRateLimited = false;

  for (const date of dates) {
    const dateText = formatDateOnly(date);
    for (const company of companies) {
      if (
        shouldSyncMarketplace(marketplaceFilter, "WB") &&
        allowsScope(options.scopeFilter, company.name, "WB", dateText)
      ) {
        options.onScopeCall?.({
          companyName: company.name,
          marketplace: "WB",
          date: dateText,
        });
        if (wbRateLimited && shouldStopWbOnRateLimit) {
          results.push({
            marketplace: "WB" as const,
            companyName: company.name,
            date: dateText,
            skipped: true,
            reason:
              "WB синхронизация остановлена в этом запуске после rate limit 429",
            isRateLimit: true,
          });
        } else {
          const wbFn = options.executeWb ?? safeSyncWbDailyOrdersForCompany;
          const wbResult = await wbFn({
            company,
            date,
            delayMs: wbDelayMs,
          });

          results.push(wbResult as never);

          if ("isRateLimit" in wbResult && wbResult.isRateLimit) {
            wbRateLimited = true;
          }

          await sleep(wbDelayMs);
        }
      }

      if (
        shouldSyncMarketplace(marketplaceFilter, "OZON") &&
        allowsScope(options.scopeFilter, company.name, "OZON", dateText)
      ) {
        options.onScopeCall?.({
          companyName: company.name,
          marketplace: "OZON",
          date: dateText,
        });
        const ozonFn = options.executeOzon ?? safeSyncOzonDailyOrdersForCompany;
        const ozonResult = await ozonFn({
          company,
          date,
        });
        results.push(ozonResult as never);

        await sleep(generalDelayMs);
      }
    }
  }

  const summary = summarizeMarketplaceOrderRows(results);
  const completed = summary.annotated.filter((row) => !row.skipped).length;

  return {
    ok: summary.ok,
    retryable: summary.retryable,
    mode: options.mode ?? (options.dateFrom || options.dateTo ? "manual" : "daily"),
    marketplace: marketplaceFilter,
    dates: dates.map(formatDateOnly),
    safeRecheckDays:
      options.mode === "recheck" ? getSafeRecheckDays(options.recheckDays) : null,
    wbStoppedByRateLimit: wbRateLimited,
    incompleteRequired: summary.incompleteRequired,
    results: summary.annotated,
    partialSuccess: !summary.ok && completed > 0,
  };
}
