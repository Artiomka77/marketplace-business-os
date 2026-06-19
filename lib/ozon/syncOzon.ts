import { prisma } from "@/lib/prisma";
import { normalizeOzonFinance } from "@/lib/import/normalizers/ozonFinanceNormalizer";

type CompanyRow = { id: string; name: string };

type OzonSyncPeriodOptions = {
  dateFrom?: Date;
  dateTo?: Date;
};

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function startOfUtcDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

function endOfUtcDay(date: Date) {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      23,
      59,
      59,
      999
    )
  );
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getDefaultPeriod() {
  const now = new Date();
  const dateTo = endOfUtcDay(now);
  const dateFrom = startOfUtcDay(now);

  dateFrom.setUTCDate(dateFrom.getUTCDate() - 14);

  return {
    dateFrom,
    dateTo,
    dateFromText: formatDateOnly(dateFrom),
    dateToText: formatDateOnly(dateTo),
  };
}

function getSyncPeriod(options: OzonSyncPeriodOptions = {}) {
  if (!options.dateFrom && !options.dateTo) {
    return getDefaultPeriod();
  }

  if (!options.dateFrom || !options.dateTo) {
    throw new Error("Для исторической Ozon-синхронизации нужны dateFrom и dateTo");
  }

  const dateFrom = startOfUtcDay(options.dateFrom);
  const dateTo = endOfUtcDay(options.dateTo);

  if (dateFrom.getTime() > dateTo.getTime()) {
    throw new Error("dateFrom не может быть позже dateTo");
  }

  return {
    dateFrom,
    dateTo,
    dateFromText: formatDateOnly(dateFrom),
    dateToText: formatDateOnly(dateTo),
  };
}


function addUtcDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function getOzonAdsMinAvailableDate(now = new Date()) {
  const result = startOfUtcDay(now);

  // Ozon Performance хранит рекламную статистику примерно за последние 12 месяцев.
  // Чтобы не запрашивать недоступный день "ровно год назад", сдвигаем начало на +1 день.
  result.setUTCFullYear(result.getUTCFullYear() - 1);
  return addUtcDays(result, 1);
}

function getOzonAdsSyncPeriod(options: OzonSyncPeriodOptions = {}) {
  const requestedPeriod = getSyncPeriod(options);
  const minAvailableDate = getOzonAdsMinAvailableDate();

  const requestedDateToStart = startOfUtcDay(requestedPeriod.dateTo);

  if (requestedDateToStart.getTime() < minAvailableDate.getTime()) {
    return {
      ...requestedPeriod,
      requestedDateFromText: requestedPeriod.dateFromText,
      requestedDateToText: requestedPeriod.dateToText,
      minAvailableDate,
      minAvailableDateText: formatDateOnly(minAvailableDate),
      isUnavailable: true,
      isPartiallyTrimmed: false,
      skipReason: `Ozon Performance хранит рекламную статистику только за последние 12 месяцев. Минимальная доступная дата: ${formatDateOnly(
        minAvailableDate
      )}. Запрошенный период ${requestedPeriod.dateFromText} — ${
        requestedPeriod.dateToText
      } недоступен.`,
    };
  }

  const effectiveDateFrom =
    requestedPeriod.dateFrom.getTime() < minAvailableDate.getTime()
      ? minAvailableDate
      : requestedPeriod.dateFrom;

  return {
    dateFrom: effectiveDateFrom,
    dateTo: requestedPeriod.dateTo,
    dateFromText: formatDateOnly(effectiveDateFrom),
    dateToText: requestedPeriod.dateToText,
    requestedDateFromText: requestedPeriod.dateFromText,
    requestedDateToText: requestedPeriod.dateToText,
    minAvailableDate,
    minAvailableDateText: formatDateOnly(minAvailableDate),
    isUnavailable: false,
    isPartiallyTrimmed:
      effectiveDateFrom.getTime() !== requestedPeriod.dateFrom.getTime(),
    skipReason: null,
  };
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isNaN(value) ? null : value;

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  const number = Number(normalized);
  return Number.isNaN(number) ? null : number;
}

function toNumberSafe(value: unknown): number {
  return toNumber(value) ?? 0;
}

function toInt(value: unknown): number | null {
  const number = toNumber(value);
  return number === null ? null : Math.trunc(number);
}

function toIntSafe(value: unknown) {
  const number = toNumberSafe(value);
  return Math.trunc(number);
}

function toDate(value: unknown): Date | null {
  const text = String(value ?? "").trim();

  const ruDateMatch = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (ruDateMatch) {
    const [, day, month, year] = ruDateMatch;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));
  }

  const isoDateMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoDateMatch) {
    const [, year, month, day] = isoDateMatch;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));
  }

  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function getOzonConnection(companyId: string) {
  const company = await findCompany(companyId);

  if (!company) {
    throw new Error("Компания не найдена");
  }

  const connection = await prisma.marketplaceApiConnection.findUnique({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace: "OZON",
      },
    },
  });

  if (!connection) {
    throw new Error("Ozon-подключение не найдено");
  }

  return { company, connection };
}

async function setOzonError(companyId: string, error: unknown) {
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

async function setOzonConnected(companyId: string) {
  await prisma.marketplaceApiConnection.update({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace: "OZON",
      },
    },
    data: {
      status: "CONNECTED",
      lastSyncAt: new Date(),
      lastError: null,
    },
  });
}

/* -------------------- FINANCE -------------------- */

type OzonFinanceOperation = {
  operation_type?: string;
  operation_date?: string;
  operation_type_name?: string;
  accruals_for_sale?: number;
  sale_commission?: number;
  amount?: number;
  delivery_charge?: number;
  return_delivery_charge?: number;
  items?: { sku?: number | string; name?: string }[];
  services?: { name?: string; price?: number }[];
};

type OzonFinanceResponse = {
  result?: {
    operations?: OzonFinanceOperation[];
    page_count?: number;
  };
};

async function fetchOzonFinanceOperations(
  clientId: string,
  apiKey: string,
  dateFromText: string,
  dateToText: string
) {
  const allOperations: OzonFinanceOperation[] = [];
  const pageSize = 1000;
  let page = 1;
  let pageCount = 1;

  while (page <= pageCount) {
    const response = await fetch(
      "https://api-seller.ozon.ru/v3/finance/transaction/list",
      {
        method: "POST",
        headers: {
          "Client-Id": clientId,
          "Api-Key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filter: {
            date: {
              from: `${dateFromText}T00:00:00.000Z`,
              to: `${dateToText}T23:59:59.999Z`,
            },
            operation_type: [],
            posting_number: "",
            transaction_type: "all",
          },
          page,
          page_size: pageSize,
        }),
        cache: "no-store",
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Ozon Finance API: ${response.status} ${text}`.trim());
    }

    const json = (await response.json()) as OzonFinanceResponse;
    const operations = json.result?.operations ?? [];

    pageCount = json.result?.page_count ?? 1;
    allOperations.push(...operations);
    page += 1;
  }

  return allOperations;
}

function getServiceSums(operation: OzonFinanceOperation) {
  let logisticsCost = toNumberSafe(operation.delivery_charge);
  let reverseLogisticsCost = toNumberSafe(operation.return_delivery_charge);

  for (const service of operation.services ?? []) {
    const serviceName = String(service.name ?? "");
    const price = toNumberSafe(service.price);

    const isReverseLogistics =
      serviceName.includes("ReturnFlowLogistic") ||
      serviceName.includes("RedistributionReturns") ||
      serviceName.includes("Return") ||
      serviceName.includes("Returns");

    const isDirectLogistics =
      serviceName.includes("DirectFlowLogistic") ||
      serviceName.includes("LastMile") ||
      serviceName.includes("Courier") ||
      serviceName.includes("Logistic");

    if (isReverseLogistics) {
      reverseLogisticsCost += price;
      continue;
    }

    if (isDirectLogistics) {
      logisticsCost += price;
    }
  }

  return { logisticsCost, reverseLogisticsCost };
}

function divideAmount(value: unknown, divisor: number) {
  const number = toNumberSafe(value);
  return divisor <= 1 ? number : number / divisor;
}

function mapOzonFinanceRows(operations: OzonFinanceOperation[]) {
  const rows: Record<string, unknown>[] = [];

  for (const operation of operations) {
    const items = operation.items?.length ? operation.items : [null];
    const itemCount = items.length;
    const { logisticsCost, reverseLogisticsCost } = getServiceSums(operation);

    for (const item of items) {
      rows.push({
        "Дата начисления": operation.operation_date ?? "",
        "Тип операции":
          operation.operation_type_name ?? operation.operation_type ?? "",
        SKU: item?.sku ? String(item.sku) : "",
        Артикул: "",
        Количество: item ? 1 : "",
        "Сумма продаж": divideAmount(operation.accruals_for_sale, itemCount),
        "Комиссия Ozon": divideAmount(operation.sale_commission, itemCount),
        Логистика: divideAmount(logisticsCost, itemCount),
        "Обратная логистика": divideAmount(reverseLogisticsCost, itemCount),
        Итого: divideAmount(operation.amount, itemCount),
      });
    }
  }

  return rows;
}

export async function syncOzonFinance(
  companyId: string,
  options: OzonSyncPeriodOptions = {}
) {
  const { company, connection } = await getOzonConnection(companyId);

  if (!connection.ozonClientId || !connection.ozonApiKey) {
    throw new Error("Ozon Client-Id или Api-Key не сохранены");
  }

  const { dateFrom, dateTo, dateFromText, dateToText } = getSyncPeriod(options);

  const operations = await fetchOzonFinanceOperations(
    connection.ozonClientId,
    connection.ozonApiKey,
    dateFromText,
    dateToText
  );

  const rows = mapOzonFinanceRows(operations);

  const importSession = await prisma.importSession.create({
    data: {
      fileName: `Ozon API Finance ${company.name} ${dateFromText} - ${dateToText}`,
      reportType: "OZON_FINANCE",
      marketplace: "OZON",
      companyName: company.name,
      rowsCount: rows.length,
      previewJson: rows.slice(0, 10) as any,
      sheetName: "Ozon Finance API",
      headerRow: 1,
      status: "SUCCESS",
    },
  });

  const normalizeResult = await normalizeOzonFinance(
    rows,
    importSession.id,
    company.name,
    {
      dateFrom,
      dateTo,
    }
  );

  await prisma.importSession.update({
    where: { id: importSession.id },
    data: { rowsCount: normalizeResult.savedRows },
  });

  return {
    name: "Ozon Finance",
    rows: normalizeResult.savedRows,
    dateFrom: dateFromText,
    dateTo: dateToText,
  };
}

/* -------------------- PRODUCTS -------------------- */

type OzonProductListItem = {
  product_id?: number;
  offer_id?: string;
};

type OzonProductListResponse = {
  result?: {
    items?: OzonProductListItem[];
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
  primary_image?: string;
  images?: string[];
};

type OzonProductInfoResponse = {
  items?: OzonProductInfoItem[];
  result?: {
    items?: OzonProductInfoItem[];
  };
};

type OzonProductPicturesItem = {
  product_id?: number | string;
  primary_photo?: string[];
  photo?: string[];
  color_photo?: string[];
  photo_360?: string[];
  errors?: { message?: string }[];
};

type OzonProductPicturesResponse = {
  items?: OzonProductPicturesItem[];
  result?: {
    items?: OzonProductPicturesItem[];
  };
};

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
        filter: { visibility: "ALL" },
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

    if (!nextLastId || items.length === 0) break;

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
    body: JSON.stringify({ product_id: productIds }),
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Ozon Product Info API: ${response.status} ${text}`.trim());
  }

  const json = (await response.json()) as OzonProductInfoResponse;
  return json.items ?? json.result?.items ?? [];
}

async function fetchProductPicturesInfoBatch(
  clientId: string,
  apiKey: string,
  productIds: number[]
) {
  if (productIds.length === 0) return [];

  const response = await fetch(
    "https://api-seller.ozon.ru/v2/product/pictures/info",
    {
      method: "POST",
      headers: {
        "Client-Id": clientId,
        "Api-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        product_id: productIds.map((productId) => String(productId)),
      }),
      cache: "no-store",
    }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Ozon Product Pictures API: ${response.status} ${text}`.trim()
    );
  }

  const json = (await response.json()) as OzonProductPicturesResponse;
  return json.items ?? json.result?.items ?? [];
}

function firstNonEmpty(values: Array<string | null | undefined>) {
  return values.find((value) => typeof value === "string" && value.trim()) ?? null;
}

function getFirstArrayValue(values?: string[]) {
  return values?.find((value) => typeof value === "string" && value.trim()) ?? null;
}

function getOzonProductImageUrl(
  info: OzonProductInfoItem | null | undefined,
  pictures: OzonProductPicturesItem | null | undefined
) {
  return firstNonEmpty([
    getFirstArrayValue(pictures?.primary_photo),
    getFirstArrayValue(pictures?.photo),
    getFirstArrayValue(pictures?.color_photo),
    info?.primary_image,
    getFirstArrayValue(info?.images),
  ]);
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

export async function syncOzonProducts(companyId: string) {
  const { company, connection } = await getOzonConnection(companyId);

  if (!connection.ozonClientId || !connection.ozonApiKey) {
    throw new Error("Ozon Client-Id или Api-Key не сохранены");
  }

  const productList = await fetchProductList(
    connection.ozonClientId,
    connection.ozonApiKey
  );

  const productIds = productList
    .map((product) => product.product_id)
    .filter((productId): productId is number => Boolean(productId));

  const infoItems: OzonProductInfoItem[] = [];
  const pictureItems: OzonProductPicturesItem[] = [];

  for (const batch of chunkArray(productIds, 100)) {
    const batchItems = await fetchProductInfoBatch(
      connection.ozonClientId,
      connection.ozonApiKey,
      batch
    );

    infoItems.push(...batchItems);

    const batchPictures = await fetchProductPicturesInfoBatch(
      connection.ozonClientId,
      connection.ozonApiKey,
      batch
    );

    pictureItems.push(...batchPictures);
  }

  const infoByProductId = new Map<number, OzonProductInfoItem>();
  const picturesByProductId = new Map<number, OzonProductPicturesItem>();

  for (const item of infoItems) {
    const productId = item.id ?? item.product_id;

    if (productId) {
      infoByProductId.set(productId, item);
    }
  }

  for (const item of pictureItems) {
    const productId = toInt(item.product_id);

    if (productId) {
      picturesByProductId.set(productId, item);
    }
  }

  const data = productList
    .map((product) => {
      const productId = product.product_id;
      const info = productId ? infoByProductId.get(productId) : null;
      const pictures = productId ? picturesByProductId.get(productId) : null;

      const vendorCode = info?.offer_id ?? product.offer_id ?? "";
      const sku = info ? getSku(info) : null;
      const productName = info?.name ?? null;
      const imageUrl = getOzonProductImageUrl(info, pictures);

      return {
        importSessionId: null,
        companyName: company.name,
        vendorCode,
        sku: sku ? String(sku) : productId ? String(productId) : "",
        productName,
        imageUrl,
        imageSmallUrl: imageUrl,
        imageUpdatedAt: imageUrl ? new Date() : null,
      };
    })
    .filter((row) => row.vendorCode && row.sku);

  await prisma.ozonProduct.deleteMany({
    where: { companyName: company.name },
  });

  if (data.length > 0) {
    await prisma.ozonProduct.createMany({ data });
  }

  return {
    name: "Ozon Products",
    rows: data.length,
    photos: data.filter((row) => Boolean(row.imageUrl)).length,
  };
}

/* -------------------- STOCKS -------------------- */

type OzonStock = {
  type?: string;
  present?: number;
  reserved?: number;
  sku?: number;
  shipment_type?: string;
};

type OzonStockItem = {
  product_id?: number;
  offer_id?: string;
  stocks?: OzonStock[];
};

type OzonStocksResponse = {
  items?: OzonStockItem[];
  cursor?: string;
  result?: {
    items?: OzonStockItem[];
    cursor?: string;
  };
};

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
          filter: { visibility: "ALL" },
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

    if (!nextCursor || items.length === 0) break;

    cursor = nextCursor;
  }

  return allItems;
}

export async function syncOzonStocks(companyId: string) {
  const { company, connection } = await getOzonConnection(companyId);

  if (!connection.ozonClientId || !connection.ozonApiKey) {
    throw new Error("Ozon Client-Id или Api-Key не сохранены");
  }

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
      availableQty: toIntSafe(stock.present),
      preparingQty: toIntSafe(stock.reserved),
      supplyQty: 0,
      inTransitQty: 0,
      returnQty: 0,
    }));
  });

  await prisma.ozonStock.deleteMany({
    where: { companyName: company.name },
  });

  if (data.length > 0) {
    await prisma.ozonStock.createMany({ data });
  }

  return { name: "Ozon Stocks", rows: data.length };
}

/* -------------------- ADS -------------------- */

type TokenResponse = {
  access_token?: string;
};

type CampaignItem = {
  id?: string;
  title?: string;
  state?: string;
  PaymentType?: string;
  paymentType?: string;
  advObjectType?: string;
  fromDate?: string;
  toDate?: string;
};

type StatsCreateResponse = {
  UUID?: string;
  uuid?: string;
};

type ReportStatus = {
  state?: string;
};

type ReportRow = {
  date?: string;
  sku?: string;
  views?: string;
  clicks?: string;
  ctr?: string;
  avgBid?: string;
  moneySpent?: string;
  orders?: string;
};

type CampaignReport = {
  report?: {
    rows?: ReportRow[];
  };
};

type ReportFile = Record<string, CampaignReport>;

async function getPerformanceToken(clientId: string, clientSecret: string) {
  const response = await fetch(
    "https://api-performance.ozon.ru/api/client/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }),
      cache: "no-store",
    }
  );

  const rawText = await response.text();
  const json = rawText ? (JSON.parse(rawText) as TokenResponse) : null;

  if (!response.ok || !json?.access_token) {
    throw new Error(`Ozon Performance Token API: ${response.status} ${rawText}`.trim());
  }

  return json.access_token;
}

async function fetchCampaigns(accessToken: string) {
  const response = await fetch(
    "https://api-performance.ozon.ru/api/client/campaign",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
    }
  );

  const rawText = await response.text();
  const json = rawText
    ? (JSON.parse(rawText) as { list?: CampaignItem[]; total?: string })
    : null;

  if (!response.ok) {
    throw new Error(`Ozon Performance Campaign API: ${response.status} ${rawText}`.trim());
  }

  return json?.list ?? [];
}

function getCampaignPaymentType(campaign: CampaignItem) {
  return String(campaign.PaymentType ?? campaign.paymentType ?? "")
    .trim()
    .toUpperCase();
}

function isCampaignRelevant(
  campaign: CampaignItem,
  dateFrom: string,
  dateTo: string
) {
  if (!campaign.id) return false;

  // CPO / "Продвижение с оплатой за заказ" не запрашиваем через statistics/json.
  // Эти расходы уже могут приходить через Ozon Finance и не должны ломать Ozon Ads.
  if (getCampaignPaymentType(campaign) === "CPO") return false;

  if (
    ![
      "CAMPAIGN_STATE_RUNNING",
      "CAMPAIGN_STATE_INACTIVE",
      "CAMPAIGN_STATE_FINISHED",
    ].includes(campaign.state ?? "")
  ) {
    return false;
  }

  const fromDate = campaign.fromDate || "1900-01-01";
  const toDate = campaign.toDate || "2999-12-31";

  return fromDate <= dateTo && toDate >= dateFrom;
}

function isForbiddenStatsReportError(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();

  return (
    message.includes("forbidden") ||
    message.includes("invalidargument") ||
    message.includes("generation of this type of report") ||
    message.includes("transferred list of campaigns")
  );
}

async function createStatsReport(
  accessToken: string,
  campaignIds: string[],
  dateFrom: string,
  dateTo: string
) {
  const response = await fetch(
    "https://api-performance.ozon.ru/api/client/statistics/json",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        campaigns: campaignIds,
        dateFrom,
        dateTo,
        groupBy: "DATE",
      }),
      cache: "no-store",
    }
  );

  const rawText = await response.text();
  const json = rawText ? (JSON.parse(rawText) as StatsCreateResponse) : null;

  if (!response.ok || (!json?.UUID && !json?.uuid)) {
    throw new Error(
      `Ozon Performance Statistics Create API: ${response.status} ${rawText}`.trim()
    );
  }

  return json.UUID ?? json.uuid ?? "";
}

async function getReportStatus(accessToken: string, uuid: string) {
  const response = await fetch(
    `https://api-performance.ozon.ru/api/client/statistics/${encodeURIComponent(
      uuid
    )}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
    }
  );

  const rawText = await response.text();
  const json = rawText ? (JSON.parse(rawText) as ReportStatus) : null;

  if (!response.ok) {
    throw new Error(`Ozon Performance Report Status API: ${response.status} ${rawText}`.trim());
  }

  return json;
}

async function waitForReport(accessToken: string, uuid: string) {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    if (attempt > 1) await sleep(10000);

    const status = await getReportStatus(accessToken, uuid);

    if (status?.state === "OK") return status;

    if (
      status?.state &&
      !["NOT_STARTED", "IN_PROGRESS", "PROCESSING"].includes(status.state)
    ) {
      throw new Error(`Ozon Performance report failed: ${status.state}`);
    }
  }

  throw new Error("Ozon Performance report не успел сформироваться за 2 минуты");
}

async function downloadReport(accessToken: string, uuid: string) {
  const response = await fetch(
    `https://api-performance.ozon.ru/api/client/statistics/report?UUID=${encodeURIComponent(
      uuid
    )}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
    }
  );

  const rawText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Ozon Performance Report Download API: ${response.status} ${rawText}`.trim()
    );
  }

  return rawText ? (JSON.parse(rawText) as ReportFile) : {};
}


function mergeReportFiles(reports: ReportFile[]) {
  const merged: ReportFile = {};
  let duplicateIndex = 0;

  for (const report of reports) {
    for (const [campaignKey, campaignReport] of Object.entries(report)) {
      let key = campaignKey;

      while (Object.prototype.hasOwnProperty.call(merged, key)) {
        duplicateIndex += 1;
        key = `${campaignKey}_${duplicateIndex}`;
      }

      merged[key] = campaignReport;
    }
  }

  return merged;
}

async function loadStatsReportForCampaignBatch(
  accessToken: string,
  campaignIds: string[],
  dateFrom: string,
  dateTo: string
) {
  const uuid = await createStatsReport(accessToken, campaignIds, dateFrom, dateTo);

  await waitForReport(accessToken, uuid);

  return downloadReport(accessToken, uuid);
}

async function loadStatsReportsSafely(
  accessToken: string,
  campaignIds: string[],
  dateFrom: string,
  dateTo: string
) {
  const reports: ReportFile[] = [];
  const skippedCampaignIds: string[] = [];

  for (const batch of chunkArray(campaignIds, 10)) {
    try {
      const report = await loadStatsReportForCampaignBatch(
        accessToken,
        batch,
        dateFrom,
        dateTo
      );

      reports.push(report);
      continue;
    } catch (error) {
      if (!isForbiddenStatsReportError(error)) {
        throw error;
      }

      // Если одна кампания в пачке запрещена для statistics/json,
      // Ozon отклоняет весь список. Разбираем пачку по одной кампании,
      // плохие кампании пропускаем, остальные загружаем.
      for (const campaignId of batch) {
        try {
          const report = await loadStatsReportForCampaignBatch(
            accessToken,
            [campaignId],
            dateFrom,
            dateTo
          );

          reports.push(report);
        } catch (innerError) {
          if (!isForbiddenStatsReportError(innerError)) {
            throw innerError;
          }

          skippedCampaignIds.push(campaignId);
        }
      }
    }
  }

  return {
    report: mergeReportFiles(reports),
    skippedCampaignIds,
  };
}

function mapReportRows(
  report: ReportFile,
  importSessionId: string,
  companyName: string
) {
  const rows = [];

  for (const campaign of Object.values(report)) {
    for (const row of campaign.report?.rows ?? []) {
      const reportDate = toDate(row.date);
      const sku = row.sku ? String(row.sku) : null;

      if (!reportDate || !sku) continue;

      const clicks = toInt(row.clicks);
      const spend = toNumber(row.moneySpent);

      rows.push({
        importSessionId,
        companyName,
        reportDate,
        sku,
        impressions: toInt(row.views),
        clicks,
        ctr: toNumber(row.ctr),
        cpc:
          spend !== null && clicks && clicks > 0
            ? spend / clicks
            : toNumber(row.avgBid),
        orders: toInt(row.orders),
        spend,
      });
    }
  }

  return rows;
}

export async function syncOzonAds(
  companyId: string,
  options: OzonSyncPeriodOptions = {}
) {
  const { company, connection } = await getOzonConnection(companyId);

  if (
    !connection.ozonPerformanceClientId ||
    !connection.ozonPerformanceClientSecret
  ) {
    throw new Error("Ozon Performance Client-Id или Client Secret не сохранены");
  }

  const adsPeriod = getOzonAdsSyncPeriod(options);

  if (adsPeriod.isUnavailable) {
    return {
      name: "Ozon Ads",
      rows: 0,
      dateFrom: adsPeriod.requestedDateFromText,
      dateTo: adsPeriod.requestedDateToText,
      campaigns: 0,
      skipped: true,
      reason: adsPeriod.skipReason,
      minAvailableDate: adsPeriod.minAvailableDateText,
    };
  }

  const { dateFrom, dateTo, dateFromText, dateToText } = adsPeriod;

  const accessToken = await getPerformanceToken(
    connection.ozonPerformanceClientId,
    connection.ozonPerformanceClientSecret
  );

  const campaigns = await fetchCampaigns(accessToken);

  const campaignIds = Array.from(
    new Set(
      campaigns
        .filter((campaign) => isCampaignRelevant(campaign, dateFromText, dateToText))
        .map((campaign) => campaign.id)
        .filter((id): id is string => Boolean(id))
    )
  );

  if (campaignIds.length === 0) {
    await prisma.ozonAds.deleteMany({
      where: {
        companyName: company.name,
        reportDate: {
          gte: dateFrom,
          lte: dateTo,
        },
      },
    });

    return {
      name: "Ozon Ads",
      rows: 0,
      dateFrom: dateFromText,
      dateTo: dateToText,
      requestedDateFrom: adsPeriod.requestedDateFromText,
      requestedDateTo: adsPeriod.requestedDateToText,
      campaigns: 0,
      skippedCampaigns: 0,
      partiallyTrimmed: adsPeriod.isPartiallyTrimmed,
      minAvailableDate: adsPeriod.minAvailableDateText,
    };
  }

  const { report, skippedCampaignIds } = await loadStatsReportsSafely(
    accessToken,
    campaignIds,
    dateFromText,
    dateToText
  );

  const importSession = await prisma.importSession.create({
    data: {
      fileName: `Ozon API Ads ${company.name} ${dateFromText} - ${dateToText}`,
      reportType: "OZON_ADS",
      marketplace: "OZON",
      companyName: company.name,
      rowsCount: 0,
      previewJson: [
        {
          requestedDateFrom: adsPeriod.requestedDateFromText,
          requestedDateTo: adsPeriod.requestedDateToText,
          effectiveDateFrom: dateFromText,
          effectiveDateTo: dateToText,
          partiallyTrimmed: adsPeriod.isPartiallyTrimmed,
          minAvailableDate: adsPeriod.minAvailableDateText,
          campaigns: campaignIds.length,
          skippedCampaigns: skippedCampaignIds.length,
        },
      ] as any,
      sheetName: "Ozon Performance API",
      headerRow: 1,
      status: "SUCCESS",
    },
  });

  const rows = mapReportRows(report, importSession.id, company.name);

  await prisma.ozonAds.deleteMany({
    where: {
      companyName: company.name,
      reportDate: {
        gte: dateFrom,
        lte: dateTo,
      },
    },
  });

  if (rows.length > 0) {
    await prisma.ozonAds.createMany({ data: rows });
  }

  await prisma.importSession.update({
    where: { id: importSession.id },
    data: {
      rowsCount: rows.length,
      previewJson: rows.slice(0, 10) as any,
    },
  });

  return {
    name: "Ozon Ads",
    rows: rows.length,
    dateFrom: dateFromText,
    dateTo: dateToText,
    requestedDateFrom: adsPeriod.requestedDateFromText,
    requestedDateTo: adsPeriod.requestedDateToText,
    campaigns: campaignIds.length,
    skippedCampaigns: skippedCampaignIds.length,
    skippedCampaignIds,
    partiallyTrimmed: adsPeriod.isPartiallyTrimmed,
    minAvailableDate: adsPeriod.minAvailableDateText,
  };
}

/* -------------------- ALL -------------------- */

export async function syncOzonAll(companyId: string) {
  const results = [];

  try {
    results.push(await syncOzonFinance(companyId));
    results.push(await syncOzonProducts(companyId));
    results.push(await syncOzonStocks(companyId));
    results.push(await syncOzonAds(companyId));

    await setOzonConnected(companyId);

    return {
      ok: true,
      results,
    };
  } catch (error) {
    await setOzonError(companyId, error);

    return {
      ok: false,
      results,
      error: getErrorMessage(error),
    };
  }
}