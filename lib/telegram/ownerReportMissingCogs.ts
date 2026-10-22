import { prisma } from "@/lib/prisma";
import { hydrateExactOzonSkus } from "@/lib/ozon/exactOzonSkuHydrate";
import type { OwnerReportCogsCoverageEvidence } from "@/lib/telegram/ownerReportCogsCoverage";
import { resolveOzonHumanIdentity } from "@/lib/telegram/ownerReportV3Loaders";

export type MissingCogsListItem = {
  key: string;
  companyName: string;
  marketplace: "WB" | "OZON";
  article: string;
  skuId: string | null;
  qty: number;
  vendorCode: string | null;
  nmId: string | null;
  /** Exact display enrichment (optional until enriched). */
  humanArticle?: string | null;
  size?: string | null;
  imageUrl?: string | null;
  mappingPath?: string | null;
  mappingConfidence?: "EXACT" | null;
};

export function listUnresolvedCogsItems(
  evidence: OwnerReportCogsCoverageEvidence,
): MissingCogsListItem[] {
  const items: MissingCogsListItem[] = [];
  for (const mp of evidence.marketplaces) {
    for (const row of mp.rows) {
      if (row.covered) continue;
      const article =
        (row.vendorCode && String(row.vendorCode).trim()) ||
        (row.nmId && String(row.nmId).trim()) ||
        row.skuKey ||
        "без артикула";
      const skuId =
        (row.nmId && String(row.nmId).trim()) ||
        (row.vendorCode && String(row.vendorCode).trim()) ||
        null;
      items.push({
        key: `${mp.companyName}|${mp.marketplace}|${row.skuKey}`,
        companyName: mp.companyName,
        marketplace: mp.marketplace,
        article,
        skuId,
        qty: Math.abs(row.netQty),
        vendorCode: row.vendorCode,
        nmId: row.nmId,
      });
    }
  }
  items.sort((a, b) => b.qty - a.qty || a.article.localeCompare(b.article, "ru"));
  return items;
}

async function resolveWbExactIdentity(params: {
  companyName: string;
  nmId: string | null;
  vendorCode: string | null;
}): Promise<{
  humanArticle: string | null;
  size: string | null;
  imageUrl: string | null;
  mappingPath: string | null;
}> {
  const nmId = String(params.nmId ?? "").trim();
  const vendor = String(params.vendorCode ?? "").trim();
  if (!nmId && !vendor) {
    return { humanArticle: null, size: null, imageUrl: null, mappingPath: null };
  }

  const card = nmId
    ? await prisma.wbProductCard.findFirst({
        where: { companyName: params.companyName, nmId },
        select: {
          vendorCode: true,
          photoSmallUrl: true,
          photoBigUrl: true,
        },
        orderBy: { updatedAt: "desc" },
      })
    : await prisma.wbProductCard.findFirst({
        where: { companyName: params.companyName, vendorCode: vendor },
        select: {
          vendorCode: true,
          photoSmallUrl: true,
          photoBigUrl: true,
        },
        orderBy: { updatedAt: "desc" },
      });

  const cardVc = card?.vendorCode?.trim() || null;
  const humanArticle =
    cardVc && cardVc !== nmId && !/^\d{6,}$/.test(cardVc) ? cardVc : null;
  return {
    humanArticle,
    size: null,
    imageUrl:
      card?.photoSmallUrl?.trim() || card?.photoBigUrl?.trim() || null,
    mappingPath: humanArticle ? "WbProductCard.vendorCode@nmId" : null,
  };
}

/**
 * Exact-only enrichment for missing COGS display / cost-entry caption.
 * Hydrates missing Ozon catalog rows via Product Info API (exact sku only),
 * then reuses resolveOzonHumanIdentity; WB via WbProductCard exact nmId/vendor.
 */
export async function enrichMissingCogsItemsForDisplay(
  items: MissingCogsListItem[],
): Promise<MissingCogsListItem[]> {
  const ozonSkusByCompany = new Map<string, string[]>();
  for (const item of items) {
    if (item.marketplace !== "OZON") continue;
    const sku = String(item.nmId || item.skuId || "").trim();
    if (!/^\d{6,}$/.test(sku)) continue;
    const list = ozonSkusByCompany.get(item.companyName) ?? [];
    list.push(sku);
    ozonSkusByCompany.set(item.companyName, list);
  }
  for (const [companyName, skus] of ozonSkusByCompany) {
    try {
      await hydrateExactOzonSkus({ companyName, skus });
    } catch {
      /* fail closed per SKU inside hydrate; keep enrich going */
    }
  }

  const out: MissingCogsListItem[] = [];
  for (const item of items) {
    if (item.marketplace === "OZON") {
      const sku = item.nmId || item.skuId;
      const offerHint = item.vendorCode || item.article || sku || "";
      const mapped = await resolveOzonHumanIdentity(
        item.companyName,
        sku,
        offerHint,
      );
      const displayOffer =
        mapped.ozonOffer &&
        mapped.ozonOffer !== sku &&
        !/^\d{6,}$/.test(mapped.ozonOffer)
          ? mapped.ozonOffer
          : null;
      out.push({
        ...item,
        humanArticle: mapped.humanArticle,
        size: mapped.size,
        imageUrl: mapped.imageUrl,
        mappingPath: mapped.mappingPath,
        mappingConfidence:
          mapped.mappingConfidence ??
          (mapped.imageUrl || displayOffer ? "EXACT" : null),
        skuId: mapped.ozonSku || item.skuId,
        // Keep ProductCost write candidate as human article when exact; else offer; else prior.
        article: mapped.humanArticle || displayOffer || item.article,
        vendorCode:
          mapped.humanArticle ||
          displayOffer ||
          item.vendorCode,
      });
      continue;
    }

    const wb = await resolveWbExactIdentity({
      companyName: item.companyName,
      nmId: item.nmId,
      vendorCode: item.vendorCode,
    });
    const human =
      wb.humanArticle ||
      (item.vendorCode && !/^\d{6,}$/.test(item.vendorCode)
        ? item.vendorCode
        : null);
    out.push({
      ...item,
      humanArticle: human,
      size: wb.size,
      imageUrl: wb.imageUrl,
      mappingPath: wb.mappingPath,
      mappingConfidence: human ? "EXACT" : null,
      article: human || item.article,
    });
  }
  return out;
}

function escapeHtml(text: string) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function photoIconHtml(url: string | null | undefined) {
  if (!url) return "";
  return ` <a href="${escapeHtml(url)}">📷</a>`;
}

export function formatMissingCogsCompactBlock(
  evidence: OwnerReportCogsCoverageEvidence,
  enrichedItems?: MissingCogsListItem[] | null,
): string {
  if (evidence.coverageComplete) return "";
  const items = enrichedItems?.length
    ? enrichedItems
    : listUnresolvedCogsItems(evidence);
  const lines = [
    `⚠️ Нет себестоимости: ${evidence.unresolvedSkuCount} SKU / ${Math.round(evidence.unresolvedQty)} шт`,
  ];
  const shown = items.slice(0, 5);
  for (const item of shown) {
    const qty = `${Math.round(item.qty)} шт`;
    const photo = photoIconHtml(item.imageUrl);
    const skuId = item.skuId || item.nmId || null;
    const rawHuman = item.humanArticle?.trim() || item.article?.trim() || null;
    const looksLikeSizedOffer = /^\d{6,}-\d{2,4}$/.test(rawHuman || "");
    const human =
      rawHuman &&
      rawHuman !== skuId &&
      !/^\d{6,}$/.test(rawHuman) &&
      !looksLikeSizedOffer
        ? rawHuman
        : null;
    const size = item.size?.trim() || null;
    const skuLabel =
      item.marketplace === "OZON"
        ? `Ozon SKU ${skuId || item.article}`
        : `WB ${skuId || item.article}`;

    if (human) {
      const sizePart = size ? ` · р.${size}` : "";
      lines.push(`• ${escapeHtml(human)}${escapeHtml(sizePart)} · ${qty}${photo}`);
      lines.push(`  ${escapeHtml(skuLabel)}`);
    } else {
      lines.push(`• ${escapeHtml(skuLabel)} · ${qty}${photo}`);
    }
  }
  if (items.length > 5) {
    lines.push(`ещё ${items.length - 5}`);
  }
  return lines.join("\n");
}

export function missingCogsInlineKeyboard(businessDate: string) {
  // Prefer full morning actions when unresolved count known by caller;
  // keep cost button as minimum fallback.
  return {
    inline_keyboard: [
      [
        {
          text: "🏆 Топ товаров",
          callback_data: `top:open:${businessDate}`,
        },
        {
          text: "📊 Подробнее",
          callback_data: "report_menu",
        },
      ],
      [
        { text: "📣 Реклама", callback_data: "ads:menu" },
        {
          text: "➕ Добавить себестоимость",
          callback_data: `pcost:open:${businessDate}`,
        },
      ],
    ],
  };
}

export function isCabinetCogsIncomplete(
  evidence: OwnerReportCogsCoverageEvidence | null | undefined,
  companyName: string,
  marketplace: "WB" | "OZON",
): boolean {
  if (!evidence || evidence.coverageComplete) return false;
  const hit = evidence.marketplaces.find(
    (m) => m.companyName === companyName && m.marketplace === marketplace,
  );
  return hit ? !hit.coverageComplete : false;
}

export function formatPreliminaryProfitLine(params: {
  compactProfit: string;
  marginPct: string | null;
  incomplete: boolean;
}): string {
  if (!params.incomplete) {
    return `💰 Прибыль: ${params.compactProfit}${
      params.marginPct ? ` · ${params.marginPct}` : ""
    }`;
  }
  return `💰 Прибыль до недостающей себестоимости: ${params.compactProfit}${
    params.marginPct ? ` · ${params.marginPct}` : ""
  }`;
}

/** Shared owner cost input parser (comma/dot, >0, max 2 decimals). */
export function parseOwnerCostInput(raw: string): {
  ok: true;
  value: number;
} | {
  ok: false;
  reason: string;
} {
  const normalized = String(raw ?? "")
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");
  if (!normalized) return { ok: false, reason: "INVALID_COST" };
  const n = Number(normalized);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: "INVALID_COST" };
  const parts = normalized.split(".");
  if ((parts[1] ?? "").length > 2) return { ok: false, reason: "INVALID_COST" };
  if (n > 10_000_000) return { ok: false, reason: "COST_TOO_LARGE" };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

export function formatMissingItemCaption(item: MissingCogsListItem): string {
  const lines = [
    item.humanArticle || item.article,
    item.size ? `Размер: ${item.size}` : null,
    `${item.marketplace} SKU: ${item.skuId || item.nmId || "—"}`,
    `Qty в отчёте: ${Math.round(item.qty)} шт`,
    "Себестоимость: не указана",
  ].filter(Boolean);
  return lines.join("\n");
}

/** Canonical ProductCost write vendor: exact human article preferred over bare SKU. */
export function resolveMissingCogsProductCostVendor(
  item: MissingCogsListItem,
): string {
  const human = item.humanArticle?.trim() || "";
  if (human && !/^\d{6,}$/.test(human)) return human;
  const article = item.article?.trim() || "";
  if (article && !/^\d{6,}$/.test(article) && !article.startsWith("Ozon SKU")) {
    return article;
  }
  return item.vendorCode || item.nmId || item.article || "";
}
