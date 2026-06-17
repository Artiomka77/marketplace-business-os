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

function toInt(value: unknown) {
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

async function getWbConnection(companyId: string) {
  const company = await findCompany(companyId);

  if (!company) {
    throw new Error("Компания не найдена");
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
    throw new Error("WB token не сохранён");
  }

  return { company, connection };
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

function mapWbStockRows(
  items: WbStockApiItem[],
  importSessionId: string,
  companyName: string
) {
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

export async function syncWbStock(companyId: string) {
 const { company, connection } = await getWbConnection(companyId);

const wbToken = connection.wbToken;

if (!wbToken) {
  throw new Error("WB token не сохранён");
}

const items = await fetchWbStock(wbToken);

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

  if (rows.length > 0) {
    await prisma.wbStock.createMany({
      data: rows,
      skipDuplicates: true,
    });
  }

  await prisma.importSession.update({
    where: { id: importSession.id },
    data: { rowsCount: rows.length },
  });

  return {
    name: "WB Stock",
    rows: rows.length,
  };
}