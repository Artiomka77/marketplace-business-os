/**
 * Loaders for Owner Report V3 Message 2 — TOP-3 true orders + ad funnel from durable sources.
 */
import { prisma } from "@/lib/prisma";
import type { DailyReport } from "@/lib/telegram/dailyReport";
import type {
  CabinetAdFunnel,
  OwnerReportV3Extras,
  TopOrderItem,
} from "@/lib/telegram/ownerReportV3";
import { sortCompaniesOwnerOrder } from "@/lib/telegram/ownerReportV3";

function parseIsoDate(iso: string): Date {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error(`Invalid date: ${iso}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "object" && value && "toNumber" in value) {
    const n = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(String(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function primaryDateIso(report: DailyReport): string {
  const m = String(report.dateLabel ?? "").match(/\d{4}-\d{2}-\d{2}/);
  return m?.[0] ?? "";
}

function rangeForExactDay(dateIso: string) {
  const dateFrom = parseIsoDate(dateIso);
  const dateToExclusive = addUtcDays(dateFrom, 1);
  return { dateFrom, dateToExclusive, dateText: dateIso };
}

export function aggregateTop3(items: TopOrderItem[]): TopOrderItem[] {
  const map = new Map<string, TopOrderItem>();
  for (const it of items) {
    const key = it.article.trim().toUpperCase() || "UNKNOWN";
    const prev = map.get(key);
    if (prev) {
      prev.qty += it.qty;
      prev.amount += it.amount;
    } else {
      map.set(key, { ...it, article: it.article || key });
    }
  }
  return [...map.values()]
    .filter((x) => x.amount > 0 || x.qty > 0)
    .sort((a, b) => b.amount - a.amount || b.qty - a.qty)
    .slice(0, 3);
}

function extractTopFromRawJson(raw: unknown): TopOrderItem[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const candidates = [
    obj.topByOrderAmount,
    (obj.funnelResult as Record<string, unknown> | undefined)?.topByOrderAmount,
    (obj.ozonSkuOrders as Record<string, unknown> | undefined)?.topByOrderAmount,
  ];
  for (const c of candidates) {
    if (!Array.isArray(c) || c.length === 0) continue;
    const items: TopOrderItem[] = [];
    for (const row of c) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const article = String(
        r.article ?? r.vendorCode ?? r.sku ?? r.offer_id ?? r.nmId ?? ""
      ).trim();
      const qty = Number(r.qty ?? r.orderCount ?? r.ordersQty ?? 0);
      const amount = Number(
        r.amount ?? r.orderSum ?? r.ordersAmount ?? r.revenue ?? 0
      );
      if (!article && qty === 0 && amount === 0) continue;
      items.push({
        article: article || String(r.nmId ?? "UNKNOWN"),
        qty: Number.isFinite(qty) ? qty : 0,
        amount: Number.isFinite(amount) ? amount : 0,
      });
    }
    if (items.length > 0) return aggregateTop3(items);
  }
  return [];
}

type FunnelProduct = {
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

async function fetchWbFunnelTop3(
  wbToken: string,
  date: Date
): Promise<TopOrderItem[]> {
  const dateText = formatDateOnly(date);
  const pastDateText = formatDateOnly(addUtcDays(date, -1));
  const limit = 1000;
  let offset = 0;
  const items: TopOrderItem[] = [];

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
          selectedPeriod: { start: dateText, end: dateText },
          pastPeriod: { start: pastDateText, end: pastDateText },
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
    const json = (await response.json()) as {
      data?: { products?: FunnelProduct[] };
    };
    const products = json.data?.products ?? [];
    for (const product of products) {
      const selected = product.statistic?.selected;
      const qty = Math.trunc(
        toNumber(selected?.orderCount ?? selected?.ordersCount)
      );
      const amount = toNumber(selected?.orderSum ?? selected?.ordersSumRub);
      const article = String(
        product.product?.vendorCode ??
          product.vendorCode ??
          product.product?.nmId ??
          product.nmId ??
          ""
      ).trim();
      if (!article && qty === 0 && amount === 0) continue;
      items.push({
        article: article || "UNKNOWN",
        qty,
        amount,
      });
    }
    if (products.length < limit) break;
    offset += limit;
  }
  return aggregateTop3(items);
}

async function fetchOzonSkuTop3(
  clientId: string,
  apiKey: string,
  date: Date
): Promise<TopOrderItem[]> {
  const dateText = formatDateOnly(date);
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
      metrics: ["ordered_units", "revenue"],
      dimension: ["sku"],
      filters: [],
      sort: [{ key: "revenue", order: "DESC" }],
      limit: 1000,
      offset: 0,
    }),
    cache: "no-store",
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Ozon Analytics API: ${response.status} ${text}`.trim());
  }
  const json = (await response.json()) as {
    result?: {
      data?: {
        dimensions?: { id?: string; name?: string }[];
        metrics?: unknown[];
      }[];
    };
  };
  const items: TopOrderItem[] = [];
  for (const row of json.result?.data ?? []) {
    const dims = row.dimensions ?? [];
    const article = String(
      dims.find((d) => d.id === "sku")?.name ??
        dims[0]?.name ??
        dims[0]?.id ??
        ""
    ).trim();
    const qty = Math.trunc(toNumber(row.metrics?.[0]));
    const amount = toNumber(row.metrics?.[1]);
    if (!article && qty === 0 && amount === 0) continue;
    items.push({
      article: article || "UNKNOWN",
      qty,
      amount,
    });
  }
  return aggregateTop3(items);
}

async function loadWbTop3Live(
  companyName: string,
  date: Date
): Promise<TopOrderItem[]> {
  const company = await prisma.company.findFirst({
    where: { name: companyName },
    include: {
      apiConnections: { where: { marketplace: "WB", isEnabled: true } },
    },
  });
  const token = company?.apiConnections[0]?.wbToken;
  if (!token) return [];
  try {
    return await fetchWbFunnelTop3(token, date);
  } catch {
    return [];
  }
}

async function loadOzonTop3Live(
  companyName: string,
  date: Date
): Promise<TopOrderItem[]> {
  const company = await prisma.company.findFirst({
    where: { name: companyName },
    include: {
      apiConnections: { where: { marketplace: "OZON", isEnabled: true } },
    },
  });
  const conn = company?.apiConnections[0];
  if (!conn?.ozonClientId || !conn?.ozonApiKey) return [];
  try {
    return await fetchOzonSkuTop3(conn.ozonClientId, conn.ozonApiKey, date);
  } catch {
    return [];
  }
}

async function loadCabinetTop3(
  companyName: string,
  marketplace: "WB" | "OZON",
  dateIso: string
): Promise<{ items: TopOrderItem[]; source: "TRUE_ORDERS" | "UNAVAILABLE" }> {
  const date = parseIsoDate(dateIso);
  const row = await prisma.marketplaceDailyOrderStat.findUnique({
    where: {
      companyName_marketplace_orderDate: {
        companyName,
        marketplace,
        orderDate: date,
      },
    },
  });
  const fromDb = extractTopFromRawJson(row?.rawJson);
  if (fromDb.length > 0) {
    return { items: fromDb, source: "TRUE_ORDERS" };
  }
  const live =
    marketplace === "WB"
      ? await loadWbTop3Live(companyName, date)
      : await loadOzonTop3Live(companyName, date);
  if (live.length > 0) {
    return { items: live, source: "TRUE_ORDERS" };
  }
  return { items: [], source: "UNAVAILABLE" };
}

/**
 * Exact-day WB ads funnel. Prefer rows whose dateFrom/dateTo span equals the report day.
 * Never invent cart/organic.
 */
async function loadWbAdFunnel(
  companyName: string,
  dateIso: string,
  economicTurnover: number,
  spendFallback: number
): Promise<
  Pick<
    CabinetAdFunnel,
    | "spend"
    | "impressions"
    | "clicks"
    | "ctr"
    | "cpc"
    | "adOrders"
    | "cpo"
    | "drr"
  >
> {
  const { dateFrom, dateToExclusive } = rangeForExactDay(dateIso);
  const rows = await prisma.wbAds.findMany({
    where: {
      companyName,
      OR: [
        {
          dateFrom: { gte: dateFrom, lt: dateToExclusive },
          dateTo: { gte: dateFrom, lt: dateToExclusive },
        },
        {
          AND: [
            { dateFrom: { lte: dateFrom } },
            { dateTo: { gte: dateFrom } },
            { dateTo: { lt: dateToExclusive } },
          ],
        },
      ],
    },
    select: {
      dateFrom: true,
      dateTo: true,
      spend: true,
      impressions: true,
      clicks: true,
      ctr: true,
      cpc: true,
      importSessionId: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  // Prefer exact single-day rows (dateFrom == dateTo == report day)
  const exactDay = rows.filter((r) => {
    if (!r.dateFrom || !r.dateTo) return false;
    const from = formatDateOnly(r.dateFrom);
    const to = formatDateOnly(r.dateTo);
    return from === dateIso && to === dateIso;
  });
  const useRows = exactDay.length > 0 ? exactDay : [];

  let spend = 0;
  let impressions = 0;
  let clicks = 0;
  for (const r of useRows) {
    spend += toNumber(r.spend);
    impressions += Number(r.impressions ?? 0);
    clicks += Number(r.clicks ?? 0);
  }
  if (useRows.length === 0) {
    // No exact-day funnel rows — use financial spend fallback for Расход/ДРР only;
    // impressions/clicks stay 0 (do not fake from weekly rows).
    spend = spendFallback;
  }
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : null;
  const cpc = clicks > 0 ? spend / clicks : null;
  const drr =
    economicTurnover > 0.0001 ? (spend / economicTurnover) * 100 : 0;
  return {
    spend,
    impressions,
    clicks,
    ctr,
    cpc,
    adOrders: null, // WB Ads table has no orders field
    cpo: null,
    drr,
  };
}

async function loadOzonAdFunnel(
  companyName: string,
  dateIso: string,
  economicTurnover: number,
  spendFallback: number
): Promise<
  Pick<
    CabinetAdFunnel,
    | "spend"
    | "impressions"
    | "clicks"
    | "ctr"
    | "cpc"
    | "adOrders"
    | "cpo"
    | "drr"
  >
> {
  const { dateFrom, dateToExclusive } = rangeForExactDay(dateIso);
  const rows = await prisma.ozonAds.findMany({
    where: {
      companyName,
      reportDate: { gte: dateFrom, lt: dateToExclusive },
    },
    select: {
      reportDate: true,
      spend: true,
      impressions: true,
      clicks: true,
      ctr: true,
      cpc: true,
      orders: true,
      importSessionId: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  let spend = 0;
  let impressions = 0;
  let clicks = 0;
  let orders = 0;
  for (const r of rows) {
    spend += toNumber(r.spend);
    impressions += Number(r.impressions ?? 0);
    clicks += Number(r.clicks ?? 0);
    orders += Number(r.orders ?? 0);
  }
  if (rows.length === 0) {
    spend = spendFallback;
  }
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : null;
  const cpc = clicks > 0 ? spend / clicks : null;
  const adOrders = orders > 0 ? orders : null;
  const cpo = adOrders && adOrders > 0 ? spend / adOrders : null;
  const drr =
    economicTurnover > 0.0001 ? (spend / economicTurnover) * 100 : 0;
  return { spend, impressions, clicks, ctr, cpc, adOrders, cpo, drr };
}

export async function loadOwnerReportV3Extras(
  report: DailyReport
): Promise<OwnerReportV3Extras> {
  const dateIso = primaryDateIso(report);
  const cabinets: CabinetAdFunnel[] = [];
  const allTop: TopOrderItem[] = [];

  for (const company of sortCompaniesOwnerOrder(report.companies)) {
    for (const mp of ["WB", "OZON"] as const) {
      const metrics = mp === "WB" ? company.wb : company.ozon;
      const eco = metrics.economicTurnover ?? metrics.salesAmount ?? 0;
      const spendFallback = metrics.adSpend ?? 0;
      const top = dateIso
        ? await loadCabinetTop3(company.companyName, mp, dateIso)
        : { items: [] as TopOrderItem[], source: "UNAVAILABLE" as const };
      for (const t of top.items) {
        allTop.push({
          ...t,
          companyName: company.companyName,
          marketplace: mp,
        });
      }
      const ad = dateIso
        ? mp === "WB"
          ? await loadWbAdFunnel(
              company.companyName,
              dateIso,
              eco,
              spendFallback
            )
          : await loadOzonAdFunnel(
              company.companyName,
              dateIso,
              eco,
              spendFallback
            )
        : {
            spend: spendFallback,
            impressions: 0,
            clicks: 0,
            ctr: null,
            cpc: null,
            adOrders: null,
            cpo: null,
            drr: eco > 0.0001 ? (spendFallback / eco) * 100 : 0,
          };
      cabinets.push({
        companyName: company.companyName,
        marketplace: mp,
        ...ad,
        economicTurnover: eco,
        top3: top.items,
        top3Source: top.source,
      });
    }
  }

  const businessTop3 = aggregateTop3(allTop);
  return {
    businessTop3,
    businessTop3Source:
      businessTop3.length > 0 ? "TRUE_ORDERS" : "UNAVAILABLE",
    cabinets,
  };
}
