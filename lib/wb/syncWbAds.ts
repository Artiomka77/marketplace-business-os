import { prisma } from "@/lib/prisma";
import { normalizeWbAds } from "@/lib/import/normalizers/wbAdsNormalizer";

type CompanyRow = {
  id: string;
  name: string;
};

type WbAdsSyncOptions = {
  dateFrom?: Date;
  dateTo?: Date;
  cursorOffset?: number | null;
  mode?: "FULL" | "CHUNK";
};

type WbAdsExpenseItem = {
  updNum?: number | null;
  updTime?: string | null;
  updSum?: number | null;
  advertId?: number | null;
  campName?: string | null;
  advertType?: number | null;
  paymentType?: string | null;
  advertStatus?: number | null;
};

const WB_ADS_REQUEST_TIMEOUT_MS = 45_000;
const DEFAULT_WB_ADS_MIN_AVAILABLE_DATE_TEXT = "2025-01-01";
const COMPANY_WB_ADS_MIN_AVAILABLE_DATES: Record<string, string> = {
  "ИП Лебедева": "2025-03-01",
};

function startOfUtcDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getDefaultPeriod() {
  const dateTo = new Date();
  const dateFrom = new Date();

  dateFrom.setDate(dateFrom.getDate() - 7);

  return {
    dateFrom: startOfUtcDay(dateFrom),
    dateTo: startOfUtcDay(dateTo),
  };
}

function getWbAdsMinAvailableDateText(companyName: string) {
  return (
    COMPANY_WB_ADS_MIN_AVAILABLE_DATES[companyName] ??
    DEFAULT_WB_ADS_MIN_AVAILABLE_DATE_TEXT
  );
}

function getWbAdsMinAvailableDate(companyName: string) {
  return startOfUtcDay(
    new Date(`${getWbAdsMinAvailableDateText(companyName)}T00:00:00Z`)
  );
}

function getAvailableWbAdsPeriod(
  companyName: string,
  dateFrom: Date,
  dateTo: Date
) {
  const minAvailableDateText = getWbAdsMinAvailableDateText(companyName);
  const minAvailableDate = getWbAdsMinAvailableDate(companyName);

  if (dateTo.getTime() < minAvailableDate.getTime()) {
    return {
      skipped: true as const,
      dateFrom,
      dateTo,
      effectiveDateFrom: dateFrom,
      effectiveDateTo: dateTo,
      message: `WB Ads за период ${formatDateOnly(dateFrom)} — ${formatDateOnly(
        dateTo
      )} пропущены для ${companyName}: рекламная статистика WB доступна с ${minAvailableDateText}.`,
    };
  }

  const effectiveDateFrom =
    dateFrom.getTime() < minAvailableDate.getTime()
      ? minAvailableDate
      : dateFrom;

  return {
    skipped: false as const,
    dateFrom,
    dateTo,
    effectiveDateFrom,
    effectiveDateTo: dateTo,
    message:
      effectiveDateFrom.getTime() !== dateFrom.getTime()
        ? `dateFrom для ${companyName} обрезан до ${minAvailableDateText}, так как более ранняя рекламная статистика WB недоступна.`
        : null,
  };
}

function createSkippedWbAdsResult(params: {
  dateFrom: Date;
  dateTo: Date;
  message: string;
}) {
  return {
    name: "WB Ads",
    rows: 0,
    totalCampaigns: 0,
    processedCampaigns: 0,
    skippedCampaigns: 0,
    dateFrom: formatDateOnly(params.dateFrom),
    dateTo: formatDateOnly(params.dateTo),
    done: true,
    nextCursorOffset: null,
    skipped: true,
    message: params.message,
  };
}

function getSyncPeriod(options: WbAdsSyncOptions = {}) {
  if (!options.dateFrom && !options.dateTo) {
    return getDefaultPeriod();
  }

  if (!options.dateFrom || !options.dateTo) {
    throw new Error("Для WB Ads синхронизации нужны dateFrom и dateTo");
  }

  const dateFrom = startOfUtcDay(options.dateFrom);
  const dateTo = startOfUtcDay(options.dateTo);

  if (dateFrom.getTime() > dateTo.getTime()) {
    throw new Error("dateFrom не может быть позже dateTo");
  }

  return {
    dateFrom,
    dateTo,
  };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  label: string
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    WB_ADS_REQUEST_TIMEOUT_MS
  );

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${label}: timeout after ${WB_ADS_REQUEST_TIMEOUT_MS}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
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

async function fetchExpenseHistory(
  token: string,
  dateFromText: string,
  dateToText: string
) {
  const url = new URL("https://advert-api.wildberries.ru/adv/v1/upd");

  url.searchParams.set("from", dateFromText);
  url.searchParams.set("to", dateToText);

  const response = await fetchWithTimeout(
    url.toString(),
    {
      method: "GET",
      headers: {
        Authorization: token,
      },
      cache: "no-store",
    },
    "WB Ads Expense History API"
  );

  if (response.status === 204) {
    return [];
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `WB Ads Expense History API: ${response.status} ${text}`.trim()
    );
  }

  const json = await response.json().catch(() => null);

  if (!Array.isArray(json)) {
    return [];
  }

  return json as WbAdsExpenseItem[];
}

function getExpenseDateText(item: WbAdsExpenseItem, fallbackDateText: string) {
  if (!item.updTime) {
    return fallbackDateText;
  }

  const isoDate = String(item.updTime).slice(0, 10);

  if (/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    return isoDate;
  }

  return fallbackDateText;
}

function mapWbAdsExpenseRows(
  expenses: WbAdsExpenseItem[],
  fallbackDateText: string
) {
  return expenses.map((item) => ({
    Дата: getExpenseDateText(item, fallbackDateText),
    "ID кампании":
      item.advertId === null || item.advertId === undefined
        ? ""
        : String(item.advertId),
    Кампания: item.campName ?? "",
    "Тип рекламы":
      item.advertType === null || item.advertType === undefined
        ? ""
        : String(item.advertType),
    "Тип оплаты": item.paymentType ?? "",
    "Статус кампании":
      item.advertStatus === null || item.advertStatus === undefined
        ? ""
        : String(item.advertStatus),
    Расход: item.updSum ?? 0,
  }));
}

async function createImportSession(params: {
  companyName: string;
  dateFromText: string;
  dateToText: string;
  rows: Record<string, unknown>[];
}) {
  return prisma.importSession.create({
    data: {
      fileName: `WB API Ads Expense History ${params.companyName} ${params.dateFromText} - ${params.dateToText}`,
      reportType: "WB_ADS_STATS",
      marketplace: "WILDBERRIES",
      companyName: params.companyName,
      rowsCount: params.rows.length,
      previewJson: params.rows.slice(0, 10) as any,
      sheetName: "WB Ads Expense History API",
      headerRow: 1,
      status: "SUCCESS",
    },
  });
}

async function syncWbAdsExpenseHistory(
  companyId: string,
  options: WbAdsSyncOptions = {}
) {
  const { company, connection } = await getWbConnection(companyId);
  const requestedPeriod = getSyncPeriod(options);
  const availablePeriod = getAvailableWbAdsPeriod(
    company.name,
    requestedPeriod.dateFrom,
    requestedPeriod.dateTo
  );

  if (availablePeriod.skipped) {
    return createSkippedWbAdsResult({
      dateFrom: requestedPeriod.dateFrom,
      dateTo: requestedPeriod.dateTo,
      message: availablePeriod.message,
    });
  }

  const { effectiveDateFrom: dateFrom, effectiveDateTo: dateTo } =
    availablePeriod;

  const dateFromText = formatDateOnly(dateFrom);
  const dateToText = formatDateOnly(dateTo);

  const wbToken = connection.wbToken;

  if (!wbToken) {
    throw new Error("WB token не сохранён");
  }

  const expenses = await fetchExpenseHistory(wbToken, dateFromText, dateToText);
  const rows = mapWbAdsExpenseRows(expenses, dateFromText);

  const importSession = await createImportSession({
    companyName: company.name,
    dateFromText,
    dateToText,
    rows,
  });

  const normalizeResult = await normalizeWbAds(
    rows,
    importSession.id,
    dateFrom,
    dateTo,
    company.name,
    {
      replaceMode: "PERIOD",
    }
  );

  await prisma.importSession.update({
    where: { id: importSession.id },
    data: { rowsCount: normalizeResult.savedRows },
  });

  return {
    name: "WB Ads",
    source: "WB Ads Expense History API",
    rows: normalizeResult.savedRows,
    totalCampaigns: expenses.length,
    processedCampaigns: expenses.length,
    skippedCampaigns: 0,
    cursorOffset: options.cursorOffset ?? 0,
    nextCursorOffset: null,
    dateFrom: dateFromText,
    dateTo: dateToText,
    done: true,
    periodAdjusted: availablePeriod.message,
  };
}

export async function syncWbAds(
  companyId: string,
  options: WbAdsSyncOptions = {}
) {
  return syncWbAdsExpenseHistory(companyId, options);
}
