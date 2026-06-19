import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

type OzonConnection = {
  companyId: string;
  ozonClientId: string | null;
  ozonApiKey: string | null;
  company: {
    name: string;
  } | null;
};

type OzonProductListItem = {
  product_id?: number;
  offer_id?: string;
};

type OzonProductListResponse = {
  result?: {
    items?: OzonProductListItem[];
    total?: number;
    last_id?: string;
  };
};

type OzonProductInfoItem = {
  id?: number;
  product_id?: number;
  offer_id?: string;
  name?: string;
  sku?: number | string;
  fbo_sku?: number | string;
  fbs_sku?: number | string;
  primary_image?: unknown;
  images?: unknown;
  color_image?: unknown;
  sources?: Array<{
    sku?: number | string;
  }>;
};

type OzonProductInfoResponse = {
  items?: OzonProductInfoItem[];
  result?: {
    items?: OzonProductInfoItem[];
  };
};

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function chunkArray<T>(items: T[], chunkSize: number) {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }

  return chunks;
}

function getFirstImageValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (Array.isArray(value)) {
    const image = value.find(
      (item) => typeof item === "string" && item.trim()
    );

    return typeof image === "string" ? image.trim() : null;
  }

  return null;
}

function firstNonEmpty(values: unknown[]) {
  for (const value of values) {
    const image = getFirstImageValue(value);

    if (image) {
      return image;
    }
  }

  return null;
}

function getSku(item: OzonProductInfoItem) {
  return (
    item.sku ??
    item.fbo_sku ??
    item.fbs_sku ??
    item.sources?.find((source) => source.sku)?.sku ??
    null
  );
}

function getImageUrl(item: OzonProductInfoItem) {
  return firstNonEmpty([item.primary_image, item.images, item.color_image]);
}

async function fetchProductList(clientId: string, apiKey: string) {
  const products: OzonProductListItem[] = [];
  let lastId = "";

  while (true) {
    const response = await fetch("https://api-seller.ozon.ru/v3/product/list", {
      method: "POST",
      headers: {
        "Client-Id": clientId,
        "Api-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: {
          visibility: "ALL",
        },
        last_id: lastId,
        limit: 1000,
      }),
      cache: "no-store",
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Ozon Product List API: ${response.status} ${text}`.trim());
    }

    const json = (await response.json()) as OzonProductListResponse;
    const items = json.result?.items ?? [];
    const nextLastId = json.result?.last_id ?? "";

    products.push(...items);

    if (!nextLastId || items.length === 0) {
      break;
    }

    lastId = nextLastId;
  }

  return products;
}

async function fetchProductInfoBatch(
  clientId: string,
  apiKey: string,
  productIds: number[]
) {
  if (productIds.length === 0) return [];

  const response = await fetch("https://api-seller.ozon.ru/v3/product/info/list", {
    method: "POST",
    headers: {
      "Client-Id": clientId,
      "Api-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      product_id: productIds,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Ozon Product Info API: ${response.status} ${text}`.trim());
  }

  const json = (await response.json()) as OzonProductInfoResponse;

  return json.items ?? json.result?.items ?? [];
}

async function backfillCompanyPhotos(connection: OzonConnection) {
  if (!connection.ozonClientId || !connection.ozonApiKey || !connection.company?.name) {
    return {
      companyName: connection.company?.name ?? connection.companyId,
      totalProductsFromApi: 0,
      infoItems: 0,
      photosFound: 0,
      updatedRows: 0,
      skipped: true,
      error: "Нет Ozon Client-Id / Api-Key или компании",
    };
  }

  const companyName = connection.company.name;

  const productList = await fetchProductList(
    connection.ozonClientId,
    connection.ozonApiKey
  );

  const productIds = productList
    .map((product) => product.product_id)
    .filter((productId): productId is number => Boolean(productId));

  const infoItems: OzonProductInfoItem[] = [];

  for (const batch of chunkArray(productIds, 100)) {
    const batchItems = await fetchProductInfoBatch(
      connection.ozonClientId,
      connection.ozonApiKey,
      batch
    );

    infoItems.push(...batchItems);
  }

  let photosFound = 0;
  let updatedRows = 0;

  for (const item of infoItems) {
    const imageUrl = getImageUrl(item);
    const vendorCode = String(item.offer_id ?? "").trim();
    const sku = getSku(item);
    const productName = String(item.name ?? "").trim() || null;

    if (!imageUrl || (!vendorCode && !sku)) {
      continue;
    }

    photosFound += 1;

    const whereVariants = [];

    if (vendorCode) {
      whereVariants.push({
        companyName,
        vendorCode,
      });
    }

    if (sku) {
      whereVariants.push({
        companyName,
        sku: String(sku),
      });
    }

    if (whereVariants.length === 0) {
      continue;
    }

    const result = await prisma.ozonProduct.updateMany({
      where: {
        OR: whereVariants,
      },
      data: {
        ...(productName ? { productName } : {}),
        imageUrl,
        imageSmallUrl: imageUrl,
        imageUpdatedAt: new Date(),
      },
    });

    updatedRows += result.count;
  }

  return {
    companyName,
    totalProductsFromApi: productList.length,
    infoItems: infoItems.length,
    photosFound,
    updatedRows,
    skipped: false,
  };
}

export async function GET() {
  const connections = await prisma.marketplaceApiConnection.findMany({
    where: {
      marketplace: "OZON",
      ozonClientId: {
        not: null,
      },
      ozonApiKey: {
        not: null,
      },
    },
    include: {
      company: true,
    },
    orderBy: {
      updatedAt: "desc",
    },
  });

  const results = [];

  for (const connection of connections) {
    try {
      results.push(await backfillCompanyPhotos(connection));
    } catch (error) {
      results.push({
        companyName: connection.company?.name ?? connection.companyId,
        skipped: false,
        error: getErrorMessage(error),
      });
    }
  }

  const totals = await prisma.ozonProduct.aggregate({
    _count: {
      id: true,
      imageUrl: true,
      imageSmallUrl: true,
    },
  });

  return NextResponse.json({
    ok: true,
    results,
    totals: {
      products: totals._count.id,
      imageUrl: totals._count.imageUrl,
      imageSmallUrl: totals._count.imageSmallUrl,
    },
  });
}
