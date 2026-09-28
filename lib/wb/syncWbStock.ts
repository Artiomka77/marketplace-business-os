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

type WbCardPhoto = {
  big?: string;
  c516x688?: string;
  c246x328?: string;
  square?: string;
  tm?: string;
};

type WbCardSize = {
  chrtID?: number | string;
  chrtId?: number | string;
  techSize?: string;
  wbSize?: string;
  skus?: Array<string | number>;
};

type WbCardItem = {
  nmID?: number | string;
  nmId?: number | string;
  vendorCode?: string;
  title?: string;
  brand?: string;
  subjectName?: string;
  subject?: string;
  photos?: WbCardPhoto[];
  sizes?: WbCardSize[];
};

type WbCardsListResponse = {
  cards?: WbCardItem[];
  data?: {
    cards?: WbCardItem[];
  };
  cursor?: {
    updatedAt?: string;
    nmID?: number;
    nmId?: number;
    total?: number;
  };
};

type WbCardLookup = {
  byNmId: Map<string, WbCardItem>;
  byChrtId: Map<
    string,
    {
      card: WbCardItem;
      size: WbCardSize;
    }
  >;
};

function toInt(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isNaN(number) ? 0 : Math.trunc(number);
}

function normalizeKey(value: unknown) {
  return String(value ?? "").trim();
}

function getCardNmId(card: WbCardItem) {
  return normalizeKey(card.nmID ?? card.nmId);
}

function getSizeChrtId(size: WbCardSize) {
  return normalizeKey(size.chrtID ?? size.chrtId);
}

function getSizeValue(size: WbCardSize | null | undefined) {
  return normalizeKey(size?.techSize) || normalizeKey(size?.wbSize) || null;
}

function getSizeBarcode(size: WbCardSize | null | undefined) {
  const sku = size?.skus?.find((value) => normalizeKey(value));

  return sku ? normalizeKey(sku) : null;
}

function getFirstCardPhoto(card: WbCardItem) {
  const photo = card.photos?.[0];

  return (
    normalizeKey(photo?.c246x328) ||
    normalizeKey(photo?.c516x688) ||
    normalizeKey(photo?.big) ||
    normalizeKey(photo?.square) ||
    normalizeKey(photo?.tm) ||
    null
  );
}

function getWbCardsFromResponse(json: WbCardsListResponse) {
  return json.cards ?? json.data?.cards ?? [];
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

async function fetchWbCards(token: string) {
  const cards: WbCardItem[] = [];
  const limit = 100;
  let updatedAt: string | undefined;
  let nmID: number | undefined;

  while (true) {
    const response = await fetch(
      "https://content-api.wildberries.ru/content/v2/get/cards/list",
      {
        method: "POST",
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          settings: {
            cursor: {
              limit,
              ...(updatedAt ? { updatedAt } : {}),
              ...(nmID ? { nmID } : {}),
            },
            filter: {
              withPhoto: -1,
            },
          },
        }),
        cache: "no-store",
      }
    );

    if (response.status === 204) {
      break;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`WB Product Cards API: ${response.status} ${text}`.trim());
    }

    const json = (await response.json()) as WbCardsListResponse;
    const batch = getWbCardsFromResponse(json);
    const cursor = json.cursor;
    const total = Number(cursor?.total ?? batch.length);

    cards.push(...batch);

    if (batch.length === 0 || batch.length < limit || total < limit) {
      break;
    }

    updatedAt = cursor?.updatedAt;
    nmID = cursor?.nmID ?? cursor?.nmId;

    if (!updatedAt || !nmID) {
      break;
    }
  }

  return cards;
}

function buildWbCardLookup(cards: WbCardItem[]): WbCardLookup {
  const byNmId = new Map<string, WbCardItem>();
  const byChrtId = new Map<
    string,
    {
      card: WbCardItem;
      size: WbCardSize;
    }
  >();

  for (const card of cards) {
    const nmId = getCardNmId(card);

    if (nmId && !byNmId.has(nmId)) {
      byNmId.set(nmId, card);
    }

    for (const size of card.sizes ?? []) {
      const chrtId = getSizeChrtId(size);

      if (chrtId && !byChrtId.has(chrtId)) {
        byChrtId.set(chrtId, {
          card,
          size,
        });
      }
    }
  }

  return {
    byNmId,
    byChrtId,
  };
}

async function syncWbProductCardsFromCards(
  cards: WbCardItem[],
  companyName: string
) {
  for (const card of cards) {
    const nmId = getCardNmId(card);

    if (!nmId) continue;

    await prisma.wbProductCard.upsert({
      where: {
        companyName_nmId: {
          companyName,
          nmId,
        },
      },
      update: {
        vendorCode: normalizeKey(card.vendorCode) || null,
        title: normalizeKey(card.title) || null,
        brand: normalizeKey(card.brand) || null,
        subjectName:
          normalizeKey(card.subjectName) || normalizeKey(card.subject) || null,
        photoSmallUrl: getFirstCardPhoto(card),
        photoBigUrl: getFirstCardPhoto(card),
        updatedAtFromApi: new Date(),
        lastSyncedAt: new Date(),
      },
      create: {
        companyName,
        nmId,
        vendorCode: normalizeKey(card.vendorCode) || null,
        title: normalizeKey(card.title) || null,
        brand: normalizeKey(card.brand) || null,
        subjectName:
          normalizeKey(card.subjectName) || normalizeKey(card.subject) || null,
        photoSmallUrl: getFirstCardPhoto(card),
        photoBigUrl: getFirstCardPhoto(card),
        updatedAtFromApi: new Date(),
      },
    });
  }
}

function mapWbStockRows(
  items: WbStockApiItem[],
  importSessionId: string,
  companyName: string,
  cards: WbCardLookup
) {
  return items
    .filter((item) => item.nmId || item.chrtId)
    .map((item) => {
      const warehouseQty = toInt(item.quantity);
      const inTransitToCustomer = toInt(item.inWayToClient);
      const inTransitReturns = toInt(item.inWayFromClient);

      const nmId = normalizeKey(item.nmId);
      const chrtId = normalizeKey(item.chrtId);
      const sizeCard = chrtId ? cards.byChrtId.get(chrtId) : null;
      const card = sizeCard?.card ?? (nmId ? cards.byNmId.get(nmId) : null);
      const size = getSizeValue(sizeCard?.size);
      const barcode = getSizeBarcode(sizeCard?.size);

      return {
        importSessionId,
        companyName,

        brand: normalizeKey(card?.brand) || null,
        subject:
          normalizeKey(card?.subjectName) || normalizeKey(card?.subject) || null,
        vendorCode: normalizeKey(card?.vendorCode) || null,
        barcode,
        size,

        nmId: nmId || null,
        chrtId: chrtId || null,

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

let cards: WbCardItem[] = [];
let cardLookup: WbCardLookup = {
  byNmId: new Map(),
  byChrtId: new Map(),
};

try {
  cards = await fetchWbCards(wbToken);
  cardLookup = buildWbCardLookup(cards);
  await syncWbProductCardsFromCards(cards, company.name);
} catch (error) {
  // Если у токена нет доступа к Content API или WB временно не отдал карточки,
  // не ломаем загрузку остатков. Просто сохраним остатки без размера и артикула.
  console.warn("WB Product Cards API skipped:", error);
}

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

  const rows = mapWbStockRows(items, importSession.id, company.name, cardLookup);

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