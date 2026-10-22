/**
 * Exact-only Ozon SKU → offer/image hydrate via /v3/product/info/list.
 * No fuzzy matching. Persists into canonical OzonProduct (+ optional SpecialSkuAlias).
 */
import { prisma } from "@/lib/prisma";
import { extractSizedOfferBaseNmId } from "@/lib/analytics/productCostResolver";

export type ExactOzonSkuHydrateEvidence = {
  companyName: string;
  sku: string;
  productId: number | null;
  offerId: string | null;
  productName: string | null;
  size: string | null;
  imageUrl: string | null;
  barcode: string | null;
  source: "OZON_PRODUCT_INFO_API" | "OZON_PRODUCT_DB" | "UNRESOLVED";
  mappingConfidence: "EXACT" | null;
  persistedOzonProduct: boolean;
  persistedAlias: boolean;
  rawProof: Record<string, unknown>;
};

type OzonProductInfoItem = {
  id?: number;
  product_id?: number;
  offer_id?: string;
  name?: string;
  sku?: number | string;
  fbo_sku?: number | string;
  fbs_sku?: number | string;
  primary_image?: string | string[];
  images?: string[];
  barcodes?: string[];
};

function firstImage(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const hit = value.find((v) => typeof v === "string" && v.trim());
    return typeof hit === "string" ? hit.trim() : null;
  }
  return null;
}

function extractSizeFromOffer(offer: string): string | null {
  const m = String(offer).trim().match(/^(\d{6,})-(\d{2,4})$/);
  return m ? m[2] : null;
}

function itemSku(item: OzonProductInfoItem): string | null {
  const raw = item.sku ?? item.fbo_sku ?? item.fbs_sku ?? null;
  if (raw == null) return null;
  const s = String(raw).trim();
  return s || null;
}

async function getOzonCredentials(companyName: string): Promise<{
  clientId: string;
  apiKey: string;
} | null> {
  const company = await prisma.company.findFirst({
    where: { name: companyName },
    select: { id: true },
  });
  if (!company) return null;
  const connection = await prisma.marketplaceApiConnection.findUnique({
    where: {
      companyId_marketplace: { companyId: company.id, marketplace: "OZON" },
    },
    select: { ozonClientId: true, ozonApiKey: true },
  });
  const clientId = connection?.ozonClientId?.trim() || "";
  const apiKey = connection?.ozonApiKey?.trim() || "";
  if (!clientId || !apiKey) return null;
  return { clientId, apiKey };
}

async function fetchProductInfoByExactSkus(params: {
  clientId: string;
  apiKey: string;
  skus: string[];
}): Promise<OzonProductInfoItem[]> {
  const numeric = params.skus
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (numeric.length === 0) return [];

  const response = await fetch("https://api-seller.ozon.ru/v3/product/info/list", {
    method: "POST",
    headers: {
      "Client-Id": params.clientId,
      "Api-Key": params.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sku: numeric }),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Ozon product/info/list: ${response.status} ${text}`.trim());
  }
  const json = (await response.json()) as {
    items?: OzonProductInfoItem[];
    result?: { items?: OzonProductInfoItem[] };
  };
  return json.items ?? json.result?.items ?? [];
}

async function upsertOzonProduct(params: {
  companyName: string;
  sku: string;
  offerId: string;
  size: string | null;
  productName: string | null;
  imageUrl: string | null;
}) {
  const existing = await prisma.ozonProduct.findFirst({
    where: { companyName: params.companyName, sku: params.sku },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  const data = {
    companyName: params.companyName,
    vendorCode: params.offerId,
    sku: params.sku,
    size: params.size,
    productName: params.productName,
    imageUrl: params.imageUrl,
    imageSmallUrl: params.imageUrl,
    imageUpdatedAt: params.imageUrl ? new Date() : null,
  };
  if (existing) {
    await prisma.ozonProduct.update({ where: { id: existing.id }, data });
  } else {
    await prisma.ozonProduct.create({ data });
  }
}

async function upsertSpecialAlias(params: {
  companyName: string;
  sku: string;
  offerId: string;
  baseNmId: string | null;
  productName: string | null;
  barcode: string | null;
  evidence: string;
}) {
  try {
    const id = `ozalias_${params.sku}`;
    await prisma.ozonSpecialSkuAlias.upsert({
      where: {
        companyName_ozonSku: {
          companyName: params.companyName,
          ozonSku: params.sku,
        },
      },
      create: {
        id,
        companyName: params.companyName,
        ozonSku: params.sku,
        canonicalVendorCode: params.offerId,
        baseNmId: params.baseNmId,
        offerId: params.offerId,
        productName: params.productName,
        barcode: params.barcode,
        mappingEvidence: params.evidence,
        source: "OZON_PRODUCT_INFO_API",
      },
      update: {
        canonicalVendorCode: params.offerId,
        baseNmId: params.baseNmId,
        offerId: params.offerId,
        productName: params.productName,
        barcode: params.barcode,
        mappingEvidence: params.evidence,
        source: "OZON_PRODUCT_INFO_API",
      },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Exact hydrate for company-local Ozon SKUs missing from OzonProduct.
 * Queries Product Info API by exact sku only; persists catalog rows.
 */
export async function hydrateExactOzonSkus(params: {
  companyName: string;
  skus: string[];
}): Promise<ExactOzonSkuHydrateEvidence[]> {
  const skus = [
    ...new Set(
      params.skus
        .map((s) => String(s ?? "").trim())
        .filter((s) => /^\d{6,}$/.test(s)),
    ),
  ];
  const results: ExactOzonSkuHydrateEvidence[] = [];
  if (skus.length === 0) return results;

  // Skip SKUs already present with offer+image.
  const need: string[] = [];
  for (const sku of skus) {
    const row = await prisma.ozonProduct.findFirst({
      where: { companyName: params.companyName, sku },
      select: {
        vendorCode: true,
        size: true,
        productName: true,
        imageUrl: true,
        imageSmallUrl: true,
      },
      orderBy: { createdAt: "desc" },
    });
    const offer = row?.vendorCode?.trim() || "";
    const image =
      row?.imageSmallUrl?.trim() || row?.imageUrl?.trim() || null;
    if (offer && !/^\d{6,}$/.test(offer) && image) {
      results.push({
        companyName: params.companyName,
        sku,
        productId: null,
        offerId: offer,
        productName: row?.productName ?? null,
        size: row?.size ?? extractSizeFromOffer(offer),
        imageUrl: image,
        barcode: null,
        source: "OZON_PRODUCT_DB",
        mappingConfidence: "EXACT",
        persistedOzonProduct: false,
        persistedAlias: false,
        rawProof: { vendorCode: offer, from: "OzonProduct" },
      });
    } else {
      need.push(sku);
    }
  }

  if (need.length === 0) return results;

  const creds = await getOzonCredentials(params.companyName);
  if (!creds) {
    for (const sku of need) {
      results.push({
        companyName: params.companyName,
        sku,
        productId: null,
        offerId: null,
        productName: null,
        size: null,
        imageUrl: null,
        barcode: null,
        source: "UNRESOLVED",
        mappingConfidence: null,
        persistedOzonProduct: false,
        persistedAlias: false,
        rawProof: { reason: "NO_OZON_CREDENTIALS" },
      });
    }
    return results;
  }

  let items: OzonProductInfoItem[] = [];
  try {
    items = await fetchProductInfoByExactSkus({
      clientId: creds.clientId,
      apiKey: creds.apiKey,
      skus: need,
    });
  } catch (error) {
    for (const sku of need) {
      results.push({
        companyName: params.companyName,
        sku,
        productId: null,
        offerId: null,
        productName: null,
        size: null,
        imageUrl: null,
        barcode: null,
        source: "UNRESOLVED",
        mappingConfidence: null,
        persistedOzonProduct: false,
        persistedAlias: false,
        rawProof: {
          reason: "API_ERROR",
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
    return results;
  }

  const bySku = new Map<string, OzonProductInfoItem>();
  for (const item of items) {
    const sku = itemSku(item);
    if (sku) bySku.set(sku, item);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  for (const sku of need) {
    const item = bySku.get(sku);
    if (!item) {
      results.push({
        companyName: params.companyName,
        sku,
        productId: null,
        offerId: null,
        productName: null,
        size: null,
        imageUrl: null,
        barcode: null,
        source: "UNRESOLVED",
        mappingConfidence: null,
        persistedOzonProduct: false,
        persistedAlias: false,
        rawProof: { reason: "PRODUCT_INFO_EMPTY_FOR_SKU" },
      });
      continue;
    }

    const offerId = String(item.offer_id ?? "").trim();
    if (!offerId) {
      results.push({
        companyName: params.companyName,
        sku,
        productId: item.id ?? item.product_id ?? null,
        offerId: null,
        productName: item.name ?? null,
        size: null,
        imageUrl: firstImage(item.primary_image) || firstImage(item.images),
        barcode: item.barcodes?.[0] ?? null,
        source: "UNRESOLVED",
        mappingConfidence: null,
        persistedOzonProduct: false,
        persistedAlias: false,
        rawProof: { reason: "NO_OFFER_ID", productId: item.id ?? item.product_id },
      });
      continue;
    }

    const imageUrl =
      firstImage(item.primary_image) || firstImage(item.images);
    const size = extractSizeFromOffer(offerId);
    const baseNmId = extractSizedOfferBaseNmId(offerId);
    const productName = item.name?.trim() || null;
    const barcode = item.barcodes?.[0] ?? null;
    const productId = item.id ?? item.product_id ?? null;

    await upsertOzonProduct({
      companyName: params.companyName,
      sku,
      offerId,
      size,
      productName,
      imageUrl,
    });

    const evidence = `OZON /v3/product/info/list exact sku→offer_id ${stamp}`;
    const persistedAlias = await upsertSpecialAlias({
      companyName: params.companyName,
      sku,
      offerId,
      baseNmId,
      productName,
      barcode,
      evidence,
    });

    results.push({
      companyName: params.companyName,
      sku,
      productId,
      offerId,
      productName,
      size,
      imageUrl,
      barcode,
      source: "OZON_PRODUCT_INFO_API",
      mappingConfidence: "EXACT",
      persistedOzonProduct: true,
      persistedAlias,
      rawProof: {
        product_id: productId,
        offer_id: offerId,
        sku: item.sku,
        name: productName,
        primary_image: imageUrl,
        barcode,
      },
    });
  }

  return results;
}
