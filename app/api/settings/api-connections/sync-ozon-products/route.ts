import { redirect } from "next/navigation";

import { prisma } from "@/lib/prisma";

type CompanyRow = {
  id: string;
  name: string;
};

type OzonProductListItem = {
  product_id?: number;
  offer_id?: string;
  archived?: boolean;
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
  sku?: number;
  fbo_sku?: number;
  fbs_sku?: number;
};

type OzonProductInfoResponse = {
  items?: OzonProductInfoItem[];
  result?: {
    items?: OzonProductInfoItem[];
  };
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

async function findCompany(companyId: string) {
  const companies = await prisma.$queryRaw<CompanyRow[]>`
    select "id", "name"
    from "Company"
    where "id" = ${companyId}
    limit 1
  `;

  return companies[0] ?? null;
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

    products.push(...items);

    const nextLastId = json.result?.last_id ?? "";

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
  if (productIds.length === 0) {
    return [];
  }

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

function chunkArray<T>(items: T[], chunkSize: number) {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }

  return chunks;
}

function getSku(item: OzonProductInfoItem) {
  return item.sku ?? item.fbo_sku ?? item.fbs_sku ?? null;
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const companyId = getString(formData, "companyId");

  if (!companyId) {
    redirect("/settings/api-connections");
  }

  const company = await findCompany(companyId);

  if (!company) {
    redirect("/settings/api-connections");
  }

  const connection = await prisma.marketplaceApiConnection.findUnique({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace: "OZON",
      },
    },
  });

  if (!connection?.ozonClientId || !connection?.ozonApiKey) {
    await prisma.marketplaceApiConnection.upsert({
      where: {
        companyId_marketplace: {
          companyId,
          marketplace: "OZON",
        },
      },
      create: {
        companyId,
        marketplace: "OZON",
        status: "ERROR",
        lastError: "Ozon Client-Id или Api-Key не сохранены",
      },
      update: {
        status: "ERROR",
        lastError: "Ozon Client-Id или Api-Key не сохранены",
      },
    });

    redirect("/settings/api-connections");
  }

  try {
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

    const infoByProductId = new Map<number, OzonProductInfoItem>();

    for (const item of infoItems) {
      const productId = item.id ?? item.product_id;

      if (productId) {
        infoByProductId.set(productId, item);
      }
    }

    const data = productList
      .map((product) => {
        const productId = product.product_id;
        const info = productId ? infoByProductId.get(productId) : null;

        const vendorCode = info?.offer_id ?? product.offer_id ?? "";
        const sku = info ? getSku(info) : null;
        const productName = info?.name ?? null;

        return {
          importSessionId: null,
          companyName: company.name,
          vendorCode,
          sku: sku ? String(sku) : productId ? String(productId) : "",
          productName,
        };
      })
      .filter((row) => row.vendorCode && row.sku);

    await prisma.ozonProduct.deleteMany({
      where: {
        companyName: company.name,
      },
    });

    if (data.length > 0) {
      await prisma.ozonProduct.createMany({
        data,
      });
    }

    await prisma.marketplaceApiConnection.update({
      where: {
        id: connection.id,
      },
      data: {
        status: "CONNECTED",
        lastSyncAt: new Date(),
        lastError: null,
      },
    });
  } catch (error) {
    await prisma.marketplaceApiConnection.update({
      where: {
        companyId_marketplace: {
          companyId,
          marketplace: "OZON",
        },
      },
      data: {
        status: "ERROR",
        lastError: getErrorMessage(error).slice(0, 1000),
      },
    });
  }

  redirect("/settings/api-connections");
}