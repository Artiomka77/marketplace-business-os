import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

type ProductListResponse = {
  result?: {
    items?: Array<{
      product_id?: number;
      offer_id?: string;
      archived?: boolean;
    }>;
    last_id?: string;
    total?: number;
  };
};

function sanitizeHeaders(headers: Headers) {
  return {
    contentType: headers.get("content-type"),
    requestId: headers.get("x-o3-request-id") ?? headers.get("x-request-id"),
  };
}

async function readJsonOrText(response: Response) {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

async function ozonPost({
  url,
  clientId,
  apiKey,
  body,
}: {
  url: string;
  clientId: string;
  apiKey: string;
  body: unknown;
}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Client-Id": clientId,
      "Api-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const payload = await readJsonOrText(response);

  return {
    ok: response.ok,
    status: response.status,
    headers: sanitizeHeaders(response.headers),
    body,
    payload,
  };
}

function getPayloadKeys(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];

  return Object.keys(value as Record<string, unknown>);
}

function getFirstItem(value: unknown) {
  if (!value || typeof value !== "object") return null;

  const root = value as Record<string, unknown>;
  const directItems = root.items;

  if (Array.isArray(directItems)) {
    return directItems[0] ?? null;
  }

  const result = root.result;

  if (result && typeof result === "object") {
    const resultItems = (result as Record<string, unknown>).items;

    if (Array.isArray(resultItems)) {
      return resultItems[0] ?? null;
    }
  }

  return null;
}

function summarizeResponse(response: Awaited<ReturnType<typeof ozonPost>>) {
  const firstItem = getFirstItem(response.payload);

  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    requestBody: response.body,
    rootKeys: getPayloadKeys(response.payload),
    resultKeys:
      response.payload &&
      typeof response.payload === "object" &&
      !Array.isArray(response.payload) &&
      "result" in response.payload &&
      typeof (response.payload as { result?: unknown }).result === "object" &&
      (response.payload as { result?: unknown }).result
        ? Object.keys(
            (response.payload as { result: Record<string, unknown> }).result
          )
        : [],
    firstItemKeys:
      firstItem && typeof firstItem === "object" && !Array.isArray(firstItem)
        ? Object.keys(firstItem as Record<string, unknown>)
        : [],
    firstItem,
    rawPayloadPreview: response.payload,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const companyId = url.searchParams.get("companyId");

  const connection = companyId
    ? await prisma.marketplaceApiConnection.findUnique({
        where: {
          companyId_marketplace: {
            companyId,
            marketplace: "OZON",
          },
        },
        include: {
          company: true,
        },
      })
    : await prisma.marketplaceApiConnection.findFirst({
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

  if (!connection?.ozonClientId || !connection?.ozonApiKey) {
    return NextResponse.json(
      {
        ok: false,
        error: "Ozon Client-Id или Api-Key не найдены",
      },
      { status: 400 }
    );
  }

  const productListResponse = await ozonPost({
    url: "https://api-seller.ozon.ru/v3/product/list",
    clientId: connection.ozonClientId,
    apiKey: connection.ozonApiKey,
    body: {
      filter: {
        visibility: "ALL",
      },
      last_id: "",
      limit: 5,
    },
  });

  const productListPayload = productListResponse.payload as ProductListResponse;
  const productItems = productListPayload?.result?.items ?? [];

  const productIds = productItems
    .map((item) => item.product_id)
    .filter((productId): productId is number => Boolean(productId))
    .slice(0, 5);

  const offerIds = productItems
    .map((item) => item.offer_id)
    .filter((offerId): offerId is string => Boolean(offerId))
    .slice(0, 5);

  const infoByProductIdNumbers =
    productIds.length > 0
      ? await ozonPost({
          url: "https://api-seller.ozon.ru/v3/product/info/list",
          clientId: connection.ozonClientId,
          apiKey: connection.ozonApiKey,
          body: {
            product_id: productIds,
          },
        })
      : null;

  const infoByProductIdStrings =
    productIds.length > 0
      ? await ozonPost({
          url: "https://api-seller.ozon.ru/v3/product/info/list",
          clientId: connection.ozonClientId,
          apiKey: connection.ozonApiKey,
          body: {
            product_id: productIds.map(String),
          },
        })
      : null;

  const infoByOfferId =
    offerIds.length > 0
      ? await ozonPost({
          url: "https://api-seller.ozon.ru/v3/product/info/list",
          clientId: connection.ozonClientId,
          apiKey: connection.ozonApiKey,
          body: {
            offer_id: offerIds,
          },
        })
      : null;

  const picturesByProductId =
    productIds.length > 0
      ? await ozonPost({
          url: "https://api-seller.ozon.ru/v2/product/pictures/info",
          clientId: connection.ozonClientId,
          apiKey: connection.ozonApiKey,
          body: {
            product_id: productIds.map(String),
          },
        })
      : null;

  return NextResponse.json(
    {
      ok: true,
      company: {
        id: connection.companyId,
        name: connection.company?.name,
      },
      productList: summarizeResponse(productListResponse),
      productIds,
      offerIds,
      infoByProductIdNumbers: infoByProductIdNumbers
        ? summarizeResponse(infoByProductIdNumbers)
        : null,
      infoByProductIdStrings: infoByProductIdStrings
        ? summarizeResponse(infoByProductIdStrings)
        : null,
      infoByOfferId: infoByOfferId ? summarizeResponse(infoByOfferId) : null,
      picturesByProductId: picturesByProductId
        ? summarizeResponse(picturesByProductId)
        : null,
    },
    {
      status: 200,
    }
  );
}
