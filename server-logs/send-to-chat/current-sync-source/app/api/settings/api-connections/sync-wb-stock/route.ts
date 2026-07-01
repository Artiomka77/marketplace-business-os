import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";

type CompanyRow = {
  id: string;
  name: string;
};

type WbStockApiItem = {
  nmId?: number | string;
  chrtId?: number | string;
  warehouseName?: string;
  quantity?: number | string;
  inWayToClient?: number | string;
  inWayFromClient?: number | string;
};

type WbStockApiResponse = {
  data?: {
    items?: WbStockApiItem[];
  };
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function toInt(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isNaN(number) ? 0 : Math.trunc(number);
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

async function fetchWbStock(token: string) {
  const allItems: WbStockApiItem[] = [];
  const limit = 1000;
  let offset = 0;

  while (true) {
    const response = await fetch(
      "https://seller-analytics-api.wildberries.ru/api/analytics/v1/stocks-report/wb-warehouses",
      {
        method: "POST",
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          nmIds: [],
          chrtIds: [],
          limit,
          offset,
        }),
        cache: "no-store",
      }
    );

    if (response.status === 204) {
      break;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`WB Stock API: ${response.status} ${text}`.trim());
    }

    const json = (await response.json()) as WbStockApiResponse;
    const items = json.data?.items ?? [];

    allItems.push(...items);

    if (items.length < limit) {
      break;
    }

    offset += limit;
  }

  return allItems;
}

function mapWbStockRows(items: WbStockApiItem[], importSessionId: string, companyName: string) {
  return items
    .filter((item) => item.nmId || item.chrtId)
    .map((item) => {
      const warehouseQty = toInt(item.quantity);
      const inTransitToCustomer = toInt(item.inWayToClient);
      const inTransitReturns = toInt(item.inWayFromClient);

      return {
        importSessionId,
        companyName,

        brand: null,
        subject: null,
        vendorCode: null,
        barcode: null,
        size: null,

        nmId: item.nmId ? String(item.nmId) : null,
        chrtId: item.chrtId ? String(item.chrtId) : null,

        warehouseName: item.warehouseName ?? null,
        warehouseQty,
        totalStock: warehouseQty,
        inTransitToCustomer,
        inTransitReturns,
      };
    });
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
        marketplace: "WB",
      },
    },
  });

  if (!connection?.wbToken) {
    await prisma.marketplaceApiConnection.upsert({
      where: {
        companyId_marketplace: {
          companyId,
          marketplace: "WB",
        },
      },
      create: {
        companyId,
        marketplace: "WB",
        status: "ERROR",
        lastError: "WB token не сохранён",
      },
      update: {
        status: "ERROR",
        lastError: "WB token не сохранён",
      },
    });

    redirect("/settings/api-connections");
  }

  try {
    const items = await fetchWbStock(connection.wbToken);

    const importSession = await prisma.importSession.create({
      data: {
        fileName: `WB API Stock ${company.name}`,
        reportType: "WB_STOCK",
        marketplace: "WILDBERRIES",
        companyName: company.name,
        rowsCount: items.length,
        previewJson: items.slice(0, 10),
        sheetName: "WB Stock API",
        headerRow: 1,
        status: "SUCCESS",
      },
    });

    const rows = mapWbStockRows(items, importSession.id, company.name);

    await prisma.wbStock.deleteMany({
      where: {
        companyName: company.name,
      },
    });

    await prisma.wbStock.createMany({
      data: rows,
      skipDuplicates: true,
    });

    await prisma.importSession.update({
      where: {
        id: importSession.id,
      },
      data: {
        rowsCount: rows.length,
      },
    });

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
        id: connection.id,
      },
      data: {
        status: "ERROR",
        lastError: getErrorMessage(error).slice(0, 1000),
      },
    });
  }

  redirect("/settings/api-connections");
}