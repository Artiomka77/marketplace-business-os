import { prisma } from "@/lib/prisma";

type WbDailySalesOptions = {
  date?: Date;
};

type WbDailySaleApiRow = {
  date?: string;
  lastChangeDate?: string;
  warehouseName?: string;
  countryName?: string;
  oblastOkrugName?: string;
  regionName?: string;
  supplierArticle?: string;
  nmId?: number | string;
  barcode?: string;
  category?: string;
  subject?: string;
  brand?: string;
  techSize?: string;
  incomeID?: number | string;
  isSupply?: boolean;
  isRealization?: boolean;
  totalPrice?: number | string;
  discountPercent?: number | string;
  spp?: number | string;
  paymentSaleAmount?: number | string;
  forPay?: number | string;
  finishedPrice?: number | string;
  priceWithDisc?: number | string;
  saleID?: string;
  sticker?: string;
  gNumber?: string;
  srid?: string;
};

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function startOfUtcDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function parseWbMoscowDate(value: unknown, fallbackDate: Date) {
  if (!value) return startOfUtcDay(fallbackDate);

  const text = String(value).trim();
  const match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/
  );

  if (!match) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? startOfUtcDay(fallbackDate) : parsed;
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;

  // WB Statistics API возвращает время в московской зоне UTC+3.
  // В базе храним UTC, чтобы фильтры отчёта по московскому дню работали правильно.
  return new Date(
    Date.UTC(
      Number(yearText),
      Number(monthText) - 1,
      Number(dayText),
      Number(hourText ?? 0) - 3,
      Number(minuteText ?? 0),
      Number(secondText ?? 0)
    )
  );
}

function isReturnSaleId(value: unknown) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .startsWith("R");
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableWbDailySalesStatus(status: number) {
  // 429 у WB часто означает глобальный лимитер продавца.
  // Быстрые повторы через 2–8 секунд только усиливают лимит.
  // Такие повторы должен делать внешний планировщик/ручной запуск после паузы.
  if (status === 429) return false;

  return status >= 500;
}

function getRetryDelayMs(attempt: number) {
  if (attempt <= 1) return 2000;
  if (attempt === 2) return 5000;
  return 8000;
}

async function getWbConnection(companyId: string) {
  const connection = await prisma.marketplaceApiConnection.findUnique({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace: "WB",
      },
    },
    select: {
      wbToken: true,
      company: {
        select: {
          name: true,
        },
      },
    },
  });

  if (!connection?.wbToken) {
    throw new Error("WB token не сохранён");
  }

  // Явно возвращаем wbToken как string, а не string | null,
  // чтобы TypeScript не падал на передаче токена в fetchWbDailySales.
  return {
    company: connection.company,
    wbToken: connection.wbToken,
  };
}

async function fetchWbDailySales(token: string, dateText: string) {
  const url = new URL(
    "https://statistics-api.wildberries.ru/api/v1/supplier/sales"
  );

  url.searchParams.set("dateFrom", dateText);
  url.searchParams.set("flag", "1");

  const maxAttempts = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: token,
        },
        cache: "no-store",
      });

      if (response.status === 204) {
        return [];
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const message = `WB Daily Sales API: ${response.status} ${text}`.trim();

        if (
          attempt < maxAttempts &&
          isRetryableWbDailySalesStatus(response.status)
        ) {
          lastError = new Error(
            `${message}. Повтор ${attempt + 1}/${maxAttempts}`
          );
          await sleep(getRetryDelayMs(attempt));
          continue;
        }

        throw new Error(message);
      }

      const json = await response.json().catch(() => null);

      if (!Array.isArray(json)) {
        throw new Error("WB Daily Sales API вернул неожиданный формат ответа");
      }

      return json as WbDailySaleApiRow[];
    } catch (error) {
      lastError =
        error instanceof Error ? error : new Error("Ошибка WB Daily Sales API");

      if (attempt < maxAttempts) {
        await sleep(getRetryDelayMs(attempt));
        continue;
      }

      throw lastError;
    }
  }

  throw lastError ?? new Error("WB Daily Sales API не ответил");
}

export async function syncWbDailySales(
  companyId: string,
  options: WbDailySalesOptions = {}
) {
  const connection = await getWbConnection(companyId);
  const date = startOfUtcDay(options.date ?? new Date());
  const dateText = formatDateOnly(date);
  const companyName = connection.company.name;
  const reportNumber = `WB_DAILY_STATISTICS_${dateText}`;

  const rows = await fetchWbDailySales(connection.wbToken, dateText);

  const importSession = await prisma.importSession.create({
    data: {
      fileName: `WB Daily Sales ${companyName} ${dateText}`,
      reportType: "WB_SALES_DAILY",
      marketplace: "WILDBERRIES",
      companyName,
      rowsCount: rows.length,
      previewJson: rows.slice(0, 10) as any,
      sheetName: "WB Statistics Sales API",
      headerRow: 1,
      status: "SUCCESS",
    },
  });

  // Перезаписываем только оперативную дневную выгрузку.
  // Финальные недельные отчёты WB Sales с другими reportNumber не трогаем.
  await prisma.wbSale.deleteMany({
    where: {
      companyName,
      reportNumber,
    },
  });

  if (rows.length === 0) {
    await prisma.importSession.update({
      where: {
        id: importSession.id,
      },
      data: {
        rowsCount: 0,
      },
    });

    return {
      name: "WB Daily Sales",
      rows: 0,
      date: dateText,
      reportNumber,
      message: "WB Statistics Sales API вернул 0 строк за день.",
    };
  }

  const data = rows.map((row) => {
    const isReturn = isReturnSaleId(row.saleID);
    const quantity = isReturn ? -1 : 1;
    const amount =
      toNumber(row.priceWithDisc) ||
      toNumber(row.finishedPrice) ||
      toNumber(row.totalPrice);

    return {
      importSessionId: importSession.id,
      companyName,
      reportNumber,
      supplyNumber: row.incomeID ? String(row.incomeID) : null,

      brand: row.brand ?? null,
      subject: row.subject ?? row.category ?? null,
      productName: null,
      size: row.techSize ?? null,

      nmId: row.nmId === undefined || row.nmId === null ? null : String(row.nmId),
      vendorCode: row.supplierArticle ?? null,
      barcode: row.barcode ?? null,

      // География WB Statistics API.
      // Эти поля нужны для будущей безопасной модели поставок по регионам/складам.
      warehouseName: row.warehouseName ?? null,
      countryName: row.countryName ?? null,
      oblastOkrugName: row.oblastOkrugName ?? null,
      regionName: row.regionName ?? null,

      paymentReason: isReturn ? "Возврат" : "Продажа",
      documentType: isReturn ? "Возврат" : "Продажа",

      saleDate: parseWbMoscowDate(row.date, date),

      quantity,

      retailPrice: toNumber(row.totalPrice),
      wbRealizedAmount: amount,
      sellerPayout: toNumber(row.forPay),

      wbReward: 0,

      logisticsCost: 0,

      deliveriesCount: 0,
      returnsCount: isReturn ? 1 : 0,

      storageCost: 0,
      deductions: 0,
      acceptanceCost: 0,

      penaltiesAmount: 0,

      paymentServiceCost: 0,

      pvzCompensation: 0,
      transportCompensation: 0,
      wbRewardCorrection: 0,
    };
  });

  await prisma.wbSale.createMany({
    data,
  });

  // Данные уже сохранены. Служебные обновления статусов не должны превращать
  // успешную загрузку в ошибку, если Supabase кратковременно оборвал соединение.
  let statusUpdateError: string | null = null;

  try {
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
        lastError: null,
        retryCount: 0,
      },
    });
  } catch (error) {
    statusUpdateError = getErrorMessage(error);
    console.warn("WB Daily Sales status update skipped:", statusUpdateError);
  }

  try {
    await prisma.importSession.update({
      where: {
        id: importSession.id,
      },
      data: {
        rowsCount: data.length,
      },
    });
  } catch (error) {
    statusUpdateError = statusUpdateError ?? getErrorMessage(error);
    console.warn("WB Daily Sales import session update skipped:", getErrorMessage(error));
  }

  return {
    name: "WB Daily Sales",
    rows: data.length,
    date: dateText,
    reportNumber,
    salesRows: data.length,
    statusUpdateError,
  };
}

export function getWbDailySalesErrorMessage(error: unknown) {
  return getErrorMessage(error);
}
