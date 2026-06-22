import { prisma } from "@/lib/prisma";

type MarketplaceName = "WB" | "OZON";

type SyncPeriodOptions = {
  date?: Date;
  dateFrom?: Date;
  dateTo?: Date;
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

function addUtcDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
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

function getDateRange(options: SyncPeriodOptions = {}) {
  const dateFrom = startOfUtcDay(
    options.dateFrom ?? options.date ?? getYesterdayMoscowDate()
  );
  const dateTo = startOfUtcDay(options.dateTo ?? options.date ?? dateFrom);

  if (dateFrom.getTime() > dateTo.getTime()) {
    throw new Error("dateFrom не может быть позже dateTo");
  }

  const dates: Date[] = [];

  for (
    const cursor = new Date(dateFrom);
    cursor.getTime() <= dateTo.getTime();
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    dates.push(new Date(Date.UTC(
      cursor.getUTCFullYear(),
      cursor.getUTCMonth(),
      cursor.getUTCDate(),
      12,
      0,
      0
    )));
  }

  return dates;
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
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

  return {
    ordersQty,
    ordersAmount,
    rawData,
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
      rawJson: params.rawJson as any,
    },
    update: {
      ordersQty: params.ordersQty,
      ordersAmount: params.ordersAmount,
      source: "API",
      rawJson: params.rawJson as any,
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

  // В кабинете WB показатель “Заказано на сумму” показывает заказы,
  // оформленные за день. Поэтому для сверки с кабинетом считаем все строки
  // orders API за дату, а не только неотменённые.
  const ordersQty = rows.length;
  const ordersAmount = rows.reduce(
    (sum, row) => sum + getWbOrderAmount(row),
    0
  );

  await upsertDailyOrderStat({
    companyName: params.company.name,
    marketplace: "WB",
    orderDate: params.date,
    ordersQty,
    ordersAmount,
    rawJson: {
      ...amountCandidates,
      sourceRule:
        "WB ordered amount uses all supplier/orders rows for the day, including rows later marked as cancelled, to match Seller dashboard ordered amount.",
      sample: rows.slice(0, 5),
    },
  });

  return {
    marketplace: "WB",
    companyName: params.company.name,
    date: formatDateOnly(params.date),
    ordersQty,
    ordersAmount,
    amountCandidates,
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

  await upsertDailyOrderStat({
    companyName: params.company.name,
    marketplace: "OZON",
    orderDate: params.date,
    ordersQty: result.ordersQty,
    ordersAmount: result.ordersAmount,
    rawJson: {
      sample: result.rawData.slice(0, 10),
      rows: result.rawData.length,
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

export async function syncMarketplaceDailyOrders(
  options: SyncPeriodOptions = {}
) {
  const dates = getDateRange(options);
  const companies = await getCompaniesWithConnections();
  const results = [];

  for (const date of dates) {
    for (const company of companies) {
      results.push(
        await syncWbDailyOrdersForCompany({
          company,
          date,
        })
      );

      results.push(
        await syncOzonDailyOrdersForCompany({
          company,
          date,
        })
      );
    }
  }

  return {
    ok: true,
    dates: dates.map(formatDateOnly),
    results,
  };
}
