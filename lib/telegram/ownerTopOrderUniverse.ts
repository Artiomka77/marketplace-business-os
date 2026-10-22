/**
 * Complete period product-order universe for Telegram TOP rankings.
 * Uses the same canonical APIs as MarketplaceDailyOrderStat sync
 * (WB Sales Funnel / Ozon analytics dimension=sku) — never the daily top50 shortlist.
 */
import { prisma } from "@/lib/prisma";
import {
  mergeOrderUniverseExactFamily,
  type OrderUniverseRow,
} from "@/lib/telegram/ownerTopOrderRankMath";
import { resolveOzonHumanIdentity } from "@/lib/telegram/ownerReportV3Loaders";

export type { OrderUniverseRow };
export { mergeOrderUniverseExactFamily, sortOrderUniverse } from "@/lib/telegram/ownerTopOrderRankMath";


export type OrderUniverseResult = {
  rows: OrderUniverseRow[];
  source: "WB_SALES_FUNNEL_PERIOD" | "OZON_ANALYTICS_SKU_PERIOD" | "MIXED";
  productCount: number;
  sumQty: number;
  sumAmount: number;
  headlineQty: number;
  headlineAmount: number;
  residualQty: number;
  residualAmount: number;
  timezone: "Europe/Moscow businessDate via UTC date keys";
  excludedCancelledNote: string;
};

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

function listIsoDays(from: string, to: string): string[] {
  const out: string[] = [];
  let d = parseIsoDate(from);
  const end = parseIsoDate(to);
  while (d.getTime() <= end.getTime()) {
    out.push(formatDateOnly(d));
    d = addUtcDays(d, 1);
  }
  return out;
}

async function headlineOrders(params: {
  from: string;
  to: string;
  companyName: string;
  marketplace: "WB" | "OZON";
}): Promise<{ qty: number; amount: number }> {
  const days = listIsoDays(params.from, params.to);
  let qty = 0;
  let amount = 0;
  for (const iso of days) {
    const day = parseIsoDate(iso);
    const row = await prisma.marketplaceDailyOrderStat.findFirst({
      where: {
        companyName: params.companyName,
        marketplace: params.marketplace,
        orderDate: { gte: day, lt: addUtcDays(day, 1) },
      },
      select: { ordersQty: true, ordersAmount: true },
    });
    if (row) {
      qty += Number(row.ordersQty ?? 0);
      amount += toNumber(row.ordersAmount);
    }
  }
  return { qty, amount };
}

type FunnelProduct = {
  product?: { nmId?: number | string; vendorCode?: string };
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

async function fetchWbPeriodUniverse(
  companyName: string,
  wbToken: string,
  from: string,
  to: string,
): Promise<OrderUniverseRow[]> {
  const past = formatDateOnly(addUtcDays(parseIsoDate(from), -1));
  const limit = 1000;
  let offset = 0;
  const raw: Array<{
    nmId: string | null;
    vendorCode: string;
    qty: number;
    amount: number;
  }> = [];

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
          selectedPeriod: { start: from, end: to },
          pastPeriod: { start: past, end: past },
          nmIds: [],
          brandNames: [],
          subjectIds: [],
          tagIds: [],
          skipDeletedNm: false,
          limit,
          offset,
        }),
        cache: "no-store",
      },
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
        toNumber(selected?.orderCount ?? selected?.ordersCount),
      );
      const amount = toNumber(selected?.orderSum ?? selected?.ordersSumRub);
      const nmId =
        String(product.product?.nmId ?? product.nmId ?? "").trim() || null;
      const vendorCode = String(
        product.product?.vendorCode ?? product.vendorCode ?? "",
      ).trim();
      if (!nmId && !vendorCode && qty === 0 && amount === 0) continue;
      raw.push({ nmId, vendorCode, qty, amount });
    }
    if (products.length < limit) break;
    offset += limit;
  }

  const nmIds = raw.map((r) => r.nmId).filter((x): x is string => Boolean(x));
  const cards =
    nmIds.length > 0
      ? await prisma.wbProductCard.findMany({
          where: { companyName, nmId: { in: nmIds } },
          select: {
            nmId: true,
            vendorCode: true,
            photoSmallUrl: true,
            photoBigUrl: true,
          },
        })
      : [];
  const byNm = new Map(cards.map((c) => [c.nmId, c]));

  return raw.map((r) => {
    const card = r.nmId ? byNm.get(r.nmId) : null;
    const vendor =
      card?.vendorCode?.trim() || r.vendorCode || (r.nmId ? `WB ${r.nmId}` : "UNKNOWN");
    // WB vendorCode from card/funnel is the approved seller article identity for that nmId.
    const exactFamily =
      vendor && !/^\d{6,}$/.test(vendor) ? vendor.trim().toUpperCase() : null;
    const identityKey = `WB|${companyName}|${r.nmId || vendor.toUpperCase()}`;
    return {
      identityKey,
      exactFamilyKey: exactFamily,
      label: vendor,
      companyName,
      marketplace: "WB" as const,
      qty: r.qty,
      amount: r.amount,
      sku: r.nmId,
      imageUrl: card?.photoSmallUrl || card?.photoBigUrl || null,
    };
  });
}

async function fetchOzonPeriodUniverse(
  companyName: string,
  clientId: string,
  apiKey: string,
  from: string,
  to: string,
): Promise<OrderUniverseRow[]> {
  const allRows: { sku: string; qty: number; amount: number }[] = [];
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
          date_from: from,
          date_to: to,
          metrics: ["ordered_units", "revenue"],
          dimension: ["sku"],
          filters: [],
          sort: [{ key: "revenue", order: "DESC" }],
          limit,
          offset,
        }),
        cache: "no-store",
      },
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
    const page = json.result?.data ?? [];
    for (const row of page) {
      const dims = row.dimensions ?? [];
      const skuDim = dims[0];
      const a = String(skuDim?.id ?? "").trim();
      const b = String(skuDim?.name ?? "").trim();
      const sku = /^\d+$/.test(a)
        ? a
        : /^\d+$/.test(b)
          ? b
          : a && a.toLowerCase() !== "sku"
            ? a
            : b;
      const qty = Math.trunc(toNumber(row.metrics?.[0]));
      const amount = toNumber(row.metrics?.[1]);
      if (!sku && qty === 0 && amount === 0) continue;
      allRows.push({ sku: sku || "UNKNOWN", qty, amount });
    }
    if (page.length < limit) break;
    offset += limit;
  }

  const out: OrderUniverseRow[] = [];
  for (const row of allRows) {
    const id = await resolveOzonHumanIdentity(companyName, row.sku, "");
    const label =
      id.humanArticle ||
      id.ozonOffer ||
      (row.sku ? `Ozon SKU ${row.sku}` : "UNKNOWN");
    const exactFamily =
      id.mappingConfidence === "EXACT" && id.humanArticle
        ? id.humanArticle.trim().toUpperCase()
        : null;
    out.push({
      identityKey: `OZON|${companyName}|${row.sku}`,
      exactFamilyKey: exactFamily,
      label,
      companyName,
      marketplace: "OZON",
      qty: row.qty,
      amount: row.amount,
      sku: row.sku,
      imageUrl: id.imageUrl,
    });
  }
  return out;
}

async function loadCabinetUniverse(params: {
  companyName: string;
  marketplace: "WB" | "OZON";
  from: string;
  to: string;
}): Promise<{
  rows: OrderUniverseRow[];
  source: "WB_SALES_FUNNEL_PERIOD" | "OZON_ANALYTICS_SKU_PERIOD";
  headlineQty: number;
  headlineAmount: number;
}> {
  const company = await prisma.company.findFirst({
    where: { name: params.companyName },
    include: {
      apiConnections: {
        where: { marketplace: params.marketplace, isEnabled: true },
      },
    },
  });
  const conn = company?.apiConnections[0];
  const headline = await headlineOrders(params);

  if (params.marketplace === "WB") {
    if (!conn?.wbToken) {
      return {
        rows: [],
        source: "WB_SALES_FUNNEL_PERIOD",
        headlineQty: headline.qty,
        headlineAmount: headline.amount,
      };
    }
    const rows = await fetchWbPeriodUniverse(
      params.companyName,
      conn.wbToken,
      params.from,
      params.to,
    );
    return {
      rows,
      source: "WB_SALES_FUNNEL_PERIOD",
      headlineQty: headline.qty,
      headlineAmount: headline.amount,
    };
  }

  if (!conn?.ozonClientId || !conn?.ozonApiKey) {
    return {
      rows: [],
      source: "OZON_ANALYTICS_SKU_PERIOD",
      headlineQty: headline.qty,
      headlineAmount: headline.amount,
    };
  }
  const rows = await fetchOzonPeriodUniverse(
    params.companyName,
    conn.ozonClientId,
    conn.ozonApiKey,
    params.from,
    params.to,
  );
  return {
    rows,
    source: "OZON_ANALYTICS_SKU_PERIOD",
    headlineQty: headline.qty,
    headlineAmount: headline.amount,
  };
}

export async function loadCompleteOrderUniverse(params: {
  from: string;
  to: string;
  companyName: string | null;
  marketplace: "WB" | "OZON" | null;
  mergeAllExactFamily?: boolean;
}): Promise<OrderUniverseResult> {
  const companies = params.companyName
    ? [params.companyName]
    : ["ИП Петров", "ИП Лебедева"];
  const marketplaces = (
    params.marketplace ? [params.marketplace] : ["WB", "OZON"]
  ) as Array<"WB" | "OZON">;

  const allRows: OrderUniverseRow[] = [];
  let headlineQty = 0;
  let headlineAmount = 0;
  const sources = new Set<string>();

  for (const companyName of companies) {
    for (const marketplace of marketplaces) {
      const part = await loadCabinetUniverse({
        companyName,
        marketplace,
        from: params.from,
        to: params.to,
      });
      allRows.push(...part.rows);
      headlineQty += part.headlineQty;
      headlineAmount += part.headlineAmount;
      sources.add(part.source);
    }
  }

  const merged =
    params.mergeAllExactFamily && !params.companyName && !params.marketplace
      ? mergeOrderUniverseExactFamily(allRows)
      : allRows;

  const active = merged.filter((r) => r.qty !== 0 || r.amount !== 0);
  const sumQty = active.reduce((s, r) => s + r.qty, 0);
  const sumAmount = active.reduce((s, r) => s + r.amount, 0);

  return {
    rows: active,
    source:
      sources.size === 1
        ? ([...sources][0] as OrderUniverseResult["source"])
        : "MIXED",
    productCount: active.length,
    sumQty,
    sumAmount,
    headlineQty,
    headlineAmount,
    residualQty: headlineQty - sumQty,
    residualAmount: headlineAmount - sumAmount,
    timezone: "Europe/Moscow businessDate via UTC date keys",
    excludedCancelledNote:
      "WB Sales Funnel selectedPeriod + Ozon analytics ordered_units/revenue (same as daily sync semantics). Daily topByOrderAmount shortlist is NOT used.",
  };
}
