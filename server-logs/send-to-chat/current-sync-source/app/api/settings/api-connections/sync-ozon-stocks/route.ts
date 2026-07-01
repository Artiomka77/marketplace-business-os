import { redirect } from "next/navigation";

import { prisma } from "@/lib/prisma";

type CompanyRow = {
  id: string;
  name: string;
};

type OzonStock = {
  type?: string;
  present?: number;
  reserved?: number;
  sku?: number;
  shipment_type?: string;
  warehouse_ids?: number[];
};

type OzonStockItem = {
  product_id?: number;
  offer_id?: string;
  stocks?: OzonStock[];
};

type OzonStocksResponse = {
  items?: OzonStockItem[];
  total?: number;
  cursor?: string;
  result?: {
    items?: OzonStockItem[];
    total?: number;
    cursor?: string;
  };
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function toInt(value: unknown) {
  if (typeof value === "number") {
    return Number.isNaN(value) ? 0 : Math.trunc(value);
  }

  const number = Number(value ?? 0);
  return Number.isNaN(number) ? 0 : Math.trunc(number);
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

async function fetchOzonStocks(clientId: string, apiKey: string) {
  const allItems: OzonStockItem[] = [];
  let cursor = "";

  while (true) {
    const response = await fetch(
      "https://api-seller.ozon.ru/v4/product/info/stocks",
      {
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
          limit: 1000,
          cursor,
        }),
        cache: "no-store",
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Ozon Stocks API: ${response.status} ${text}`.trim());
    }

    const json = (await response.json()) as OzonStocksResponse;

    const items = json.items ?? json.result?.items ?? [];
    const nextCursor = json.cursor ?? json.result?.cursor ?? "";

    allItems.push(...items);

    if (!nextCursor || items.length === 0) {
      break;
    }

    cursor = nextCursor;
  }

  return allItems;
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
    const items = await fetchOzonStocks(
      connection.ozonClientId,
      connection.ozonApiKey
    );

    const data = items.flatMap((item) => {
      const stocks = item.stocks ?? [];

      if (stocks.length === 0) {
        return [
          {
            importSessionId: null,
            companyName: company.name,
            sku: item.product_id ? String(item.product_id) : null,
            vendorCode: item.offer_id ?? null,
            warehouseName: "Ozon",
            clusterName: null,
            availableQty: 0,
            preparingQty: 0,
            supplyQty: 0,
            inTransitQty: 0,
            returnQty: 0,
          },
        ];
      }

      return stocks.map((stock) => ({
        importSessionId: null,
        companyName: company.name,
        sku: stock.sku ? String(stock.sku) : item.product_id ? String(item.product_id) : null,
        vendorCode: item.offer_id ?? null,
        warehouseName: stock.type ? `Ozon ${stock.type}` : "Ozon",
        clusterName: stock.shipment_type ?? null,
        availableQty: toInt(stock.present),
        preparingQty: toInt(stock.reserved),
        supplyQty: 0,
        inTransitQty: 0,
        returnQty: 0,
      }));
    });

    await prisma.ozonStock.deleteMany({
      where: {
        companyName: company.name,
      },
    });

    if (data.length > 0) {
      await prisma.ozonStock.createMany({
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