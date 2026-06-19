import { prisma } from "@/lib/prisma";
import { requestWithRetry } from "@/lib/wbApi/requestWithRetry";

type CompanyRow = {
  id: string;
  name: string;
};

type WbProductCardsCursor = {
  updatedAt?: string;
  nmID?: number;
  total?: number;
};

type WbProductCardPhoto = {
  big?: string;
  c246x328?: string;
  c516x688?: string;
  square?: string;
  tm?: string;
};

type WbProductCardApiRow = {
  nmID?: number | string;
  nmId?: number | string;
  vendorCode?: string;
  subjectName?: string;
  brand?: string;
  title?: string;
  photos?: WbProductCardPhoto[];
  updatedAt?: string;
};

type WbProductCardsApiResponse = {
  cards?: WbProductCardApiRow[];
  cursor?: WbProductCardsCursor;
};

const WB_CONTENT_CARDS_URL =
  "https://content-api.wildberries.ru/content/v2/get/cards/list";

const WB_PRODUCT_CARDS_LIMIT = 100;
const WB_PRODUCT_CARDS_MAX_PAGES = 100;
const WB_PRODUCT_CARDS_DELAY_MS = 750;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function normalizeString(value: unknown) {
  return String(value ?? "").trim();
}

function getNmId(row: WbProductCardApiRow) {
  return normalizeString(row.nmID ?? row.nmId);
}

function getPhotoSmallUrl(row: WbProductCardApiRow) {
  const photo = row.photos?.[0];

  return (
    photo?.c246x328 ??
    photo?.c516x688 ??
    photo?.big ??
    photo?.square ??
    photo?.tm ??
    null
  );
}

function getPhotoBigUrl(row: WbProductCardApiRow) {
  const photo = row.photos?.[0];

  return (
    photo?.big ??
    photo?.c516x688 ??
    photo?.c246x328 ??
    photo?.square ??
    photo?.tm ??
    null
  );
}

function parseDate(value: unknown) {
  if (!value) return null;

  const date = new Date(String(value));

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
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

async function fetchWbProductCardsPage(
  token: string,
  cursor?: WbProductCardsCursor
) {
  const body = {
    settings: {
      cursor: {
        limit: WB_PRODUCT_CARDS_LIMIT,
        ...(cursor?.updatedAt ? { updatedAt: cursor.updatedAt } : {}),
        ...(cursor?.nmID ? { nmID: cursor.nmID } : {}),
      },
      filter: {
        withPhoto: -1,
      },
    },
  };

  const response = await requestWithRetry({
    url: WB_CONTENT_CARDS_URL,
    label: "WB Product Cards API",
    timeoutMs: 45_000,
    init: {
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    },
  });

  if (response.status === 204) {
    return {
      cards: [] as WbProductCardApiRow[],
      cursor: null as WbProductCardsCursor | null,
    };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");

    throw new Error(
      `WB Product Cards API: ${response.status} ${text}`.trim()
    );
  }

  const json = (await response.json()) as WbProductCardsApiResponse;

  if (!json || !Array.isArray(json.cards)) {
    throw new Error("WB Product Cards API вернул неожиданный формат ответа");
  }

  return {
    cards: json.cards,
    cursor: json.cursor ?? null,
  };
}

export async function syncWbProductCards(companyId: string) {
  const { company, connection } = await getWbConnection(companyId);

  const token = connection.wbToken;

  if (!token) {
    throw new Error("WB token не сохранён");
  }

  let cursor: WbProductCardsCursor | undefined;
  let page = 0;
  let savedRows = 0;
  let skippedRows = 0;
  let lastCursor: WbProductCardsCursor | null = null;

  while (page < WB_PRODUCT_CARDS_MAX_PAGES) {
    const result = await fetchWbProductCardsPage(token, cursor);
    const cards = result.cards;

    lastCursor = result.cursor;

    if (cards.length === 0) {
      break;
    }

    for (const card of cards) {
      const nmId = getNmId(card);

      if (!nmId) {
        skippedRows += 1;
        continue;
      }

      const vendorCode = normalizeString(card.vendorCode);
      const photoSmallUrl = getPhotoSmallUrl(card);
      const photoBigUrl = getPhotoBigUrl(card);

      await prisma.wbProductCard.upsert({
        where: {
          companyName_nmId: {
            companyName: company.name,
            nmId,
          },
        },
        create: {
          companyName: company.name,
          nmId,
          vendorCode: vendorCode || null,
          title: normalizeString(card.title) || null,
          brand: normalizeString(card.brand) || null,
          subjectName: normalizeString(card.subjectName) || null,
          photoSmallUrl,
          photoBigUrl,
          updatedAtFromApi: parseDate(card.updatedAt),
          lastSyncedAt: new Date(),
        },
        update: {
          vendorCode: vendorCode || null,
          title: normalizeString(card.title) || null,
          brand: normalizeString(card.brand) || null,
          subjectName: normalizeString(card.subjectName) || null,
          photoSmallUrl,
          photoBigUrl,
          updatedAtFromApi: parseDate(card.updatedAt),
          lastSyncedAt: new Date(),
        },
      });

      savedRows += 1;
    }

    page += 1;

    const nextUpdatedAt = result.cursor?.updatedAt;
    const nextNmId = result.cursor?.nmID;

    if (!nextUpdatedAt || !nextNmId) {
      break;
    }

    if (cards.length < WB_PRODUCT_CARDS_LIMIT) {
      break;
    }

    cursor = {
      updatedAt: nextUpdatedAt,
      nmID: nextNmId,
    };

    await sleep(WB_PRODUCT_CARDS_DELAY_MS);
  }

  if (page >= WB_PRODUCT_CARDS_MAX_PAGES) {
    throw new Error(
      `WB Product Cards API: остановлено после ${WB_PRODUCT_CARDS_MAX_PAGES} страниц, чтобы не уйти в бесконечную пагинацию`
    );
  }

  await prisma.marketplaceApiConnection.update({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace: "WB",
      },
    },
    data: {
      status: "CONNECTED",
      lastSyncAt: new Date(),
      lastAttemptAt: new Date(),
      lastError: null,
      retryCount: 0,
    },
  });

  return {
    name: "WB Product Cards",
    rows: savedRows,
    savedRows,
    skippedRows,
    pages: page,
    lastCursor,
  };
}

export function isWbProductCardsApiError(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();

  return (
    message.includes("wb product cards api") ||
    message.includes("content-api.wildberries")
  );
}
