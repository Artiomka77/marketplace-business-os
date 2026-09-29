/**
 * Loaders for Owner Report V3.1 — TOP-3 (all 4 cabinets) + ad funnel with counter semantics.
 */
import { prisma } from "@/lib/prisma";
import type { DailyReport } from "@/lib/telegram/dailyReport";
import type {
  AdSpendSemantics,
  CabinetAdFunnel,
  CounterStatus,
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

/** Single day or inclusive range from dateLabel. */
export function reportDateIsos(report: DailyReport): string[] {
  const label = String(report.dateLabel ?? "");
  const range = label.match(
    /(\d{4}-\d{2}-\d{2})\s*[—\-]\s*(\d{4}-\d{2}-\d{2})/
  );
  if (range) {
    const from = parseIsoDate(range[1]);
    const to = parseIsoDate(range[2]);
    const out: string[] = [];
    for (let d = from; d.getTime() <= to.getTime(); d = addUtcDays(d, 1)) {
      out.push(formatDateOnly(d));
    }
    return out;
  }
  const one = label.match(/\d{4}-\d{2}-\d{2}/);
  return one ? [one[0]] : [];
}

function primaryDateIso(report: DailyReport): string {
  return reportDateIsos(report)[0] ?? "";
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
      const vendorCode = String(r.vendorCode ?? "").trim();
      const sku = String(r.sku ?? r.nmId ?? "").trim();
      const article = String(
        vendorCode ||
          r.article ||
          (sku ? `Ozon SKU ${sku}` : "") ||
          ""
      ).trim();
      const qty = Number(r.qty ?? r.orderCount ?? r.ordersQty ?? 0);
      const amount = Number(
        r.orderAmount ?? r.amount ?? r.orderSum ?? r.ordersAmount ?? r.revenue ?? 0
      );
      if (!article && qty === 0 && amount === 0) continue;
      items.push({
        article: article || "UNKNOWN",
        qty: Number.isFinite(qty) ? qty : 0,
        amount: Number.isFinite(amount) ? amount : 0,
        sku: sku || null,
        secondaryTitle: r.title ? String(r.title).slice(0, 80) : null,
      });
    }
    if (items.length > 0) return aggregateTop3(items);
  }
  return [];
}

type FunnelProduct = {
  product?: { nmId?: number | string; vendorCode?: string; title?: string };
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
        secondaryTitle: product.product?.title
          ? String(product.product.title).slice(0, 80)
          : null,
      });
    }
    if (products.length < limit) break;
    offset += limit;
  }
  return aggregateTop3(items);
}

async function resolveOzonVendorCodes(
  companyName: string,
  skus: string[]
): Promise<Map<string, { vendorCode: string | null; title: string | null }>> {
  const map = new Map<
    string,
    { vendorCode: string | null; title: string | null }
  >();
  if (skus.length === 0) return map;
  const rows = await prisma.ozonProduct.findMany({
    where: { companyName, sku: { in: skus } },
    select: { sku: true, vendorCode: true, productName: true },
  });
  for (const r of rows) {
    map.set(String(r.sku), {
      vendorCode: r.vendorCode?.trim() || null,
      title: r.productName ? String(r.productName).slice(0, 80) : null,
    });
  }
  return map;
}

async function fetchOzonSkuTop3(
  companyName: string,
  clientId: string,
  apiKey: string,
  dateFrom: Date,
  dateTo: Date
): Promise<{ items: TopOrderItem[]; distinctCount: number }> {
  const dateFromText = formatDateOnly(dateFrom);
  const dateToText = formatDateOnly(dateTo);
  const allRows: { sku: string; title: string; qty: number; amount: number }[] =
    [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const response = await fetch(
      "https://api-seller.ozon.ru/v1/analytics/data",
      {
        method: "POST",
        headers: {
          "Client-Id": clientId,
          "Api-Key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          date_from: dateFromText,
          date_to: dateToText,
          metrics: ["ordered_units", "revenue"],
          dimension: ["sku"],
          filters: [],
          sort: [{ key: "revenue", order: "DESC" }],
          limit,
          offset,
        }),
        cache: "no-store",
      }
    );
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
    const rows = json.result?.data ?? [];
    for (const row of rows) {
      const dims = row.dimensions ?? [];
      // Ozon sku dimension: id = SKU, name = product title (not seller article).
      const sku = String(dims[0]?.id ?? dims.find((d) => d.id)?.id ?? "").trim();
      const title = String(dims[0]?.name ?? "").trim();
      const qty = Math.trunc(toNumber(row.metrics?.[0]));
      const amount = toNumber(row.metrics?.[1]);
      if (!sku && qty === 0 && amount === 0) continue;
      allRows.push({ sku: sku || "UNKNOWN", title, qty, amount });
    }
    if (rows.length < limit) break;
    offset += limit;
  }

  const vendorMap = await resolveOzonVendorCodes(
    companyName,
    allRows.map((r) => r.sku)
  );

  const byArticle = new Map<string, TopOrderItem>();
  for (const row of allRows) {
    const mapped = vendorMap.get(row.sku);
    const vendorCode = mapped?.vendorCode?.trim() || "";
    const article = vendorCode || `Ozon SKU ${row.sku}`;
    const key = article.toUpperCase();
    const prev = byArticle.get(key);
    if (prev) {
      prev.qty += row.qty;
      prev.amount += row.amount;
    } else {
      byArticle.set(key, {
        article,
        qty: row.qty,
        amount: row.amount,
        sku: row.sku,
        secondaryTitle: mapped?.title || row.title || null,
      });
    }
  }

  const distinctCount = byArticle.size;
  const items = [...byArticle.values()]
    .filter((x) => x.amount > 0 || x.qty > 0)
    .sort((a, b) => b.amount - a.amount || b.qty - a.qty)
    .slice(0, 3);

  return { items, distinctCount };
}

async function loadWbTop3Live(
  companyName: string,
  dates: string[]
): Promise<TopOrderItem[]> {
  const company = await prisma.company.findFirst({
    where: { name: companyName },
    include: {
      apiConnections: { where: { marketplace: "WB", isEnabled: true } },
    },
  });
  const token = company?.apiConnections[0]?.wbToken;
  if (!token) return [];
  const all: TopOrderItem[] = [];
  for (const d of dates) {
    try {
      all.push(...(await fetchWbFunnelTop3(token, parseIsoDate(d))));
    } catch {
      /* keep going */
    }
  }
  return aggregateTop3(all);
}

async function loadOzonTop3Live(
  companyName: string,
  dates: string[]
): Promise<{ items: TopOrderItem[]; distinctCount: number }> {
  const company = await prisma.company.findFirst({
    where: { name: companyName },
    include: {
      apiConnections: { where: { marketplace: "OZON", isEnabled: true } },
    },
  });
  const conn = company?.apiConnections[0];
  if (!conn?.ozonClientId || !conn?.ozonApiKey) {
    return { items: [], distinctCount: 0 };
  }
  try {
    const from = parseIsoDate(dates[0]);
    const to = parseIsoDate(dates[dates.length - 1]);
    return await fetchOzonSkuTop3(
      companyName,
      conn.ozonClientId,
      conn.ozonApiKey,
      from,
      to
    );
  } catch {
    return { items: [], distinctCount: 0 };
  }
}

async function loadCabinetTop3(
  companyName: string,
  marketplace: "WB" | "OZON",
  dates: string[]
): Promise<{
  items: TopOrderItem[];
  source: "TRUE_ORDERS" | "UNAVAILABLE";
  distinctCount: number;
}> {
  const fromDbAll: TopOrderItem[] = [];
  for (const dateIso of dates) {
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
    fromDbAll.push(...extractTopFromRawJson(row?.rawJson));
  }
  const fromDb = aggregateTop3(fromDbAll);
  if (fromDb.length > 0) {
    return {
      items: fromDb,
      source: "TRUE_ORDERS",
      distinctCount: fromDbAll.length,
    };
  }
  if (marketplace === "WB") {
    const live = await loadWbTop3Live(companyName, dates);
    return {
      items: live,
      source: live.length > 0 ? "TRUE_ORDERS" : "UNAVAILABLE",
      distinctCount: live.length,
    };
  }
  const live = await loadOzonTop3Live(companyName, dates);
  return {
    items: live.items,
    source: live.items.length > 0 ? "TRUE_ORDERS" : "UNAVAILABLE",
    distinctCount: live.distinctCount,
  };
}

function classifySpendSemantics(
  funnelSpend: number,
  financialSpend: number
): AdSpendSemantics {
  if (Math.abs(funnelSpend - financialSpend) <= 1) return "SAME_AS_PNL";
  if (financialSpend > 0.5 && funnelSpend + 1 < financialSpend * 0.95) {
    return "PERFORMANCE_PARTIAL";
  }
  return "SAME_AS_PNL";
}

async function loadWbAdFunnel(
  companyName: string,
  dates: string[],
  economicTurnover: number,
  financialSpend: number
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
    | "counterStatus"
    | "spendSemantics"
    | "financialSpend"
    | "financialDrr"
  >
> {
  let spend = 0;
  let impressionsSum = 0;
  let clicksSum = 0;
  let counterRows = 0;
  let nullCounterRows = 0;

  for (const dateIso of dates) {
    const dateFrom = parseIsoDate(dateIso);
    const dateToExclusive = addUtcDays(dateFrom, 1);
    const rows = await prisma.wbAds.findMany({
      where: {
        companyName,
        dateFrom: { gte: dateFrom, lt: dateToExclusive },
        dateTo: { gte: dateFrom, lt: dateToExclusive },
      },
      select: {
        spend: true,
        impressions: true,
        clicks: true,
        ctr: true,
        cpc: true,
      },
    });
    const exactDay = rows.filter((r) => true);
    for (const r of exactDay) {
      spend += toNumber(r.spend);
      if (r.impressions == null && r.clicks == null) {
        nullCounterRows++;
      } else {
        counterRows++;
        impressionsSum += Number(r.impressions ?? 0);
        clicksSum += Number(r.clicks ?? 0);
      }
    }
  }

  const financialDrr =
    economicTurnover > 0.0001
      ? (financialSpend / economicTurnover) * 100
      : 0;

  if (counterRows === 0) {
    // Unknown counters — never render as 0.
    const useSpend = spend > 0.5 ? spend : financialSpend;
    return {
      spend: useSpend,
      impressions: null,
      clicks: null,
      ctr: null,
      cpc: null,
      adOrders: null,
      cpo: null,
      drr:
        economicTurnover > 0.0001 ? (useSpend / economicTurnover) * 100 : 0,
      counterStatus: "COUNTERS_MISSING",
      spendSemantics: classifySpendSemantics(useSpend, financialSpend),
      financialSpend,
      financialDrr,
    };
  }

  const status: CounterStatus =
    impressionsSum > 0 || clicksSum > 0
      ? "COUNTERS_AVAILABLE_NONZERO"
      : "COUNTERS_TRUE_ZERO";
  const useSpend = spend > 0.5 ? spend : financialSpend;
  const ctr =
    impressionsSum > 0 ? (clicksSum / impressionsSum) * 100 : null;
  const cpc = clicksSum > 0 ? useSpend / clicksSum : null;
  void nullCounterRows;
  return {
    spend: useSpend,
    impressions: impressionsSum,
    clicks: clicksSum,
    ctr,
    cpc,
    adOrders: null,
    cpo: null,
    drr: economicTurnover > 0.0001 ? (useSpend / economicTurnover) * 100 : 0,
    counterStatus: status,
    spendSemantics: classifySpendSemantics(useSpend, financialSpend),
    financialSpend,
    financialDrr,
  };
}

async function loadOzonAdFunnel(
  companyName: string,
  dates: string[],
  economicTurnover: number,
  financialSpend: number
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
    | "counterStatus"
    | "spendSemantics"
    | "financialSpend"
    | "financialDrr"
  >
> {
  let spend = 0;
  let impressions = 0;
  let clicks = 0;
  let orders = 0;
  let rowsFound = 0;

  for (const dateIso of dates) {
    const dateFrom = parseIsoDate(dateIso);
    const dateToExclusive = addUtcDays(dateFrom, 1);
    const rows = await prisma.ozonAds.findMany({
      where: {
        companyName,
        reportDate: { gte: dateFrom, lt: dateToExclusive },
      },
      select: {
        spend: true,
        impressions: true,
        clicks: true,
        orders: true,
      },
    });
    for (const r of rows) {
      rowsFound++;
      spend += toNumber(r.spend);
      impressions += Number(r.impressions ?? 0);
      clicks += Number(r.clicks ?? 0);
      orders += Number(r.orders ?? 0);
    }
  }

  const financialDrr =
    economicTurnover > 0.0001
      ? (financialSpend / economicTurnover) * 100
      : 0;

  if (rowsFound === 0) {
    return {
      spend: financialSpend,
      impressions: null,
      clicks: null,
      ctr: null,
      cpc: null,
      adOrders: null,
      cpo: null,
      drr: financialDrr,
      counterStatus: "COUNTERS_MISSING",
      spendSemantics: "SAME_AS_PNL",
      financialSpend,
      financialDrr,
    };
  }

  const status: CounterStatus =
    impressions > 0 || clicks > 0
      ? "COUNTERS_AVAILABLE_NONZERO"
      : "COUNTERS_TRUE_ZERO";
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : null;
  const cpc = clicks > 0 ? spend / clicks : null;
  const adOrders = orders > 0 ? orders : null;
  const cpo = adOrders && adOrders > 0 ? spend / adOrders : null;
  const semantics = classifySpendSemantics(spend, financialSpend);
  return {
    spend,
    impressions,
    clicks,
    ctr,
    cpc,
    adOrders,
    cpo,
    drr: economicTurnover > 0.0001 ? (spend / economicTurnover) * 100 : 0,
    counterStatus: status,
    spendSemantics: semantics,
    financialSpend,
    financialDrr,
  };
}

export async function loadOwnerReportV3Extras(
  report: DailyReport
): Promise<OwnerReportV3Extras> {
  const dates = reportDateIsos(report);
  const cabinets: CabinetAdFunnel[] = [];
  const allTop: TopOrderItem[] = [];
  let availableCabinets = 0;

  for (const company of sortCompaniesOwnerOrder(report.companies)) {
    for (const mp of ["WB", "OZON"] as const) {
      const metrics = mp === "WB" ? company.wb : company.ozon;
      const eco = metrics.economicTurnover ?? metrics.salesAmount ?? 0;
      const financialSpend = metrics.adSpend ?? 0;
      const top =
        dates.length > 0
          ? await loadCabinetTop3(company.companyName, mp, dates)
          : {
              items: [] as TopOrderItem[],
              source: "UNAVAILABLE" as const,
              distinctCount: 0,
            };
      if (top.source === "TRUE_ORDERS") availableCabinets += 1;
      for (const t of top.items) {
        allTop.push({
          ...t,
          companyName: company.companyName,
          marketplace: mp,
        });
      }
      const ad =
        dates.length > 0
          ? mp === "WB"
            ? await loadWbAdFunnel(
                company.companyName,
                dates,
                eco,
                financialSpend
              )
            : await loadOzonAdFunnel(
                company.companyName,
                dates,
                eco,
                financialSpend
              )
          : {
              spend: financialSpend,
              impressions: null as number | null,
              clicks: null as number | null,
              ctr: null as number | null,
              cpc: null as number | null,
              adOrders: null as number | null,
              cpo: null as number | null,
              drr: eco > 0.0001 ? (financialSpend / eco) * 100 : 0,
              counterStatus: "COUNTERS_MISSING" as CounterStatus,
              spendSemantics: "SAME_AS_PNL" as AdSpendSemantics,
              financialSpend,
              financialDrr: eco > 0.0001 ? (financialSpend / eco) * 100 : 0,
            };
      cabinets.push({
        companyName: company.companyName,
        marketplace: mp,
        ...ad,
        economicTurnover: eco,
        top3: top.items,
        top3Source: top.source,
        distinctOrderedArticles: top.distinctCount,
      });
    }
  }

  const businessTop3 = aggregateTop3(allTop);
  const complete = availableCabinets >= 4;
  return {
    businessTop3: complete ? businessTop3 : businessTop3,
    businessTop3Source: complete
      ? "TRUE_ORDERS"
      : availableCabinets > 0
        ? "INCOMPLETE"
        : "UNAVAILABLE",
    businessTop3CabinetCount: availableCabinets,
    businessTop3Complete: complete,
    cabinets,
  };
}
