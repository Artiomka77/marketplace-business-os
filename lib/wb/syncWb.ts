import { prisma } from "@/lib/prisma";
import { normalizeWbFinance } from "@/lib/import/normalizers/wbFinanceNormalizer";
import { normalizeWbSales } from "@/lib/import/normalizers/wbSalesNormalizer";
import { sleep } from "@/lib/sleep";
import { requestWithRetry } from "@/lib/wbApi/requestWithRetry";

type CompanyRow = {
  id: string;
  name: string;
};

type WbFinanceReport = {
  reportId?: number | string;
  sellerFinanceName?: string;
  dateFrom?: string;
  dateTo?: string;
  reportType?: number | string;
  retailAmountSum?: string | number;
  forPaySum?: string | number;
  deliveryServiceSum?: string | number;
  paidStorageSum?: string | number;
  paidAcceptanceSum?: string | number;
  deductionSum?: string | number;
  penaltySum?: string | number;
  bankPaymentSum?: string | number;
};

type WbSalesDetailedRow = {
  reportId?: number | string;
  giId?: number | string;
  brandName?: string;
  subjectName?: string;
  title?: string;
  techSize?: string;
  nmId?: number | string;
  vendorCode?: string;
  sku?: string;
  sellerOperName?: string;
  docTypeName?: string;
  saleDt?: string;
  rrDate?: string;
  quantity?: number | string;
  retailPrice?: number | string;
  retailAmount?: number | string;
  forPay?: number | string;
  vw?: number | string;
  deliveryAmount?: number | string;
  returnAmount?: number | string;
  deliveryService?: number | string;
  paidStorage?: number | string;
  paidAcceptance?: number | string;
  deduction?: number | string;
  penalty?: number | string;
  acquiringFee?: number | string;
  ppvzReward?: number | string;
  rebillLogisticCost?: number | string;
};

const WB_COOLDOWN_MS = 60 * 60 * 1000;
const WB_REQUEST_DELAY_MS = 70 * 1000;

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function isWbRateLimitError(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();

  return (
    message.includes("429") ||
    message.includes("too many requests") ||
    message.includes("limited by global limiter") ||
    message.includes("rate limit")
  );
}

function getWbRateLimitMessage() {
  return "WB временно ограничил запросы (429). Это лимит Finance API на кабинет продавца. Повторная синхронизация будет выполнена автоматически позже.";
}

function getCooldownMessage(updatedAt: Date) {
  const nextTryAt = new Date(updatedAt.getTime() + WB_COOLDOWN_MS);

  return `WB Finance API недавно вернул 429. Чтобы не усиливать блокировку, повторный запуск временно остановлен. Повторить можно после ${nextTryAt.toLocaleString("ru-RU")}.`;
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getDefaultPeriod() {
  const dateTo = new Date();
  const dateFrom = new Date();

  dateFrom.setDate(dateFrom.getDate() - 14);

  return {
    dateFrom: formatDateOnly(dateFrom),
    dateTo: formatDateOnly(dateTo),
  };
}

function mapWbFinanceApiRows(rows: WbFinanceReport[]) {
  return rows.map((row) => ({
    "№ отчета": row.reportId ? String(row.reportId) : "",
    "Юридическое лицо": row.sellerFinanceName ?? "",
    "Дата начала": row.dateFrom ?? "",
    "Дата конца": row.dateTo ?? "",
    "Тип отчета": row.reportType ? String(row.reportType) : "API WB Finance",

    Продажа: row.retailAmountSum ?? "",
    "К перечислению за товар": row.forPaySum ?? "",
    "Стоимость логистики": row.deliveryServiceSum ?? "",
    "Стоимость хранения": row.paidStorageSum ?? "",
    "Стоимость операций на приемке": row.paidAcceptanceSum ?? "",
    "Прочие удержания/выплаты": row.deductionSum ?? "",
    "Общая сумма штрафов": row.penaltySum ?? "",
    "Итого к оплате": row.bankPaymentSum ?? "",
  }));
}

function mapWbSalesApiRows(rows: WbSalesDetailedRow[]) {
  return rows.map((row) => ({
    "Номер отчета": row.reportId ? String(row.reportId) : "",
    "Номер поставки": row.giId ? String(row.giId) : "",

    Бренд: row.brandName ?? "",
    Предмет: row.subjectName ?? "",
    Наименование: row.title ?? "",
    Размер: row.techSize ?? "",

    "Код номенклатуры": row.nmId ? String(row.nmId) : "",
    "Артикул поставщика": row.vendorCode ?? "",
    Баркод: row.sku ?? "",

    "Обоснование для оплаты": row.sellerOperName ?? "",
    "Тип документа": row.docTypeName ?? "",

    "Дата продажи": row.saleDt ?? row.rrDate ?? "",

    "Кол-во": row.quantity ?? "",

    "Цена розничная": row.retailPrice ?? "",
    "Вайлдберриз реализовал Товар (Пр)": row.retailAmount ?? "",
    "К перечислению Продавцу за реализованный Товар": row.forPay ?? "",

    "Вознаграждение Вайлдберриз (ВВ), без НДС": row.vw ?? "",

    "Количество доставок": row.deliveryAmount ?? "",
    "Количество возврата": row.returnAmount ?? "",

    "Услуги по доставке товара покупателю": row.deliveryService ?? "",
    Хранение: row.paidStorage ?? "",
    "Платная приемка": row.paidAcceptance ?? "",
    Удержания: row.deduction ?? "",
    "Общая сумма штрафов": row.penalty ?? "",

    "Компенсация платёжных услуг/Комиссия за интеграцию платёжных сервисов":
      row.acquiringFee ?? "",

    "Возмещение за выдачу и возврат товаров на ПВЗ": row.ppvzReward ?? "",
    "Возмещение издержек по перевозке": row.rebillLogisticCost ?? "",
    "Корректировка вознаграждения Вайлдберриз": "",
  }));
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

async function setWbConnected(companyId: string) {
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
    },
  });
}

async function setWbError(companyId: string, error: unknown) {
  if (isWbRateLimitError(error)) {
    await prisma.marketplaceApiConnection.update({
      where: {
        companyId_marketplace: {
          companyId,
          marketplace: "WB",
        },
      },
      data: {
        status: "CONNECTED",
        lastError: getWbRateLimitMessage(),
      },
    });

    return;
  }

  await prisma.marketplaceApiConnection.update({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace: "WB",
      },
    },
    data: {
      status: "ERROR",
      lastError: getErrorMessage(error).slice(0, 1000),
    },
  });
}

async function fetchWbFinanceReports(token: string) {
  const { dateFrom, dateTo } = getDefaultPeriod();

  const response = await fetch(
    "https://finance-api.wildberries.ru/api/finance/v1/sales-reports/list",
    {
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        dateFrom,
        dateTo,
        limit: 100,
        offset: 0,
        period: "weekly",
      }),
      cache: "no-store",
    }
  );

  if (response.status === 204) {
    return { dateFrom, dateTo, rows: [] as WbFinanceReport[] };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`WB Finance API: ${response.status} ${text}`.trim());
  }

  const json = await response.json();

  if (!Array.isArray(json)) {
    throw new Error("WB Finance API вернул неожиданный формат ответа");
  }

  return {
    dateFrom,
    dateTo,
    rows: json as WbFinanceReport[],
  };
}

async function fetchWbSalesDetailedRows(token: string, reportId: string) {
  const allRows: WbSalesDetailedRow[] = [];
  const limit = 1000;
  let offset = 0;

  while (true) {
    const url = `https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed/${reportId}`;

    const response = await requestWithRetry({
      url,
      label: `WB Sales API report ${reportId}`,
      init: {
        method: "POST",
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          limit,
          offset,
        }),
        cache: "no-store",
      },
    });

    if (response.status === 204) {
      break;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `WB Sales API report ${reportId}: ${response.status} ${text}`.trim()
      );
    }

    const json = await response.json();

    if (!Array.isArray(json)) {
      throw new Error(
        `WB Sales API report ${reportId} вернул неожиданный формат ответа`
      );
    }

    allRows.push(...(json as WbSalesDetailedRow[]));

    if (json.length < limit) {
      break;
    }

    offset += limit;

    await sleep(WB_REQUEST_DELAY_MS);
  }

  return allRows;
}

function getReportIds(rows: WbFinanceReport[]) {
  return Array.from(
    new Set(
      [...rows]
        .sort((a, b) => {
          const dateA = new Date(String(a.dateFrom ?? "")).getTime();
          const dateB = new Date(String(b.dateFrom ?? "")).getTime();

          return dateB - dateA;
        })
        .map((row) => String(row.reportId ?? "").trim())
        .filter(Boolean)
    )
  );
}

export async function syncWbFinanceAndSales(companyId: string) {
  const { company, connection } = await getWbConnection(companyId);

  if (
    connection.lastError &&
    isWbRateLimitError(connection.lastError) &&
    Date.now() - connection.updatedAt.getTime() < WB_COOLDOWN_MS
  ) {
    await prisma.marketplaceApiConnection.update({
      where: { id: connection.id },
      data: {
        status: "CONNECTED",
        lastError: getCooldownMessage(connection.updatedAt),
      },
    });

    return {
      name: "WB Finance + Sales",
      rows: 0,
      skipped: true,
      message: getCooldownMessage(connection.updatedAt),
    };
  }

const wbToken = connection.wbToken;

if (!wbToken) {
  throw new Error("WB token не сохранён");
}
  const financeResult = await fetchWbFinanceReports(wbToken);
  const financeRows = mapWbFinanceApiRows(financeResult.rows);

  const financeImportSession = await prisma.importSession.create({
    data: {
      fileName: `WB API Finance ${company.name} ${financeResult.dateFrom} - ${financeResult.dateTo}`,
      reportType: "WB_FINANCE",
      marketplace: "WILDBERRIES",
      companyName: company.name,
      rowsCount: financeRows.length,
      previewJson: financeRows.slice(0, 10),
      sheetName: "WB Finance API",
      headerRow: 1,
      status: "SUCCESS",
    },
  });

  const financeNormalizeResult = await normalizeWbFinance(
    financeRows,
    financeImportSession.id,
    company.name
  );

  await prisma.importSession.update({
    where: { id: financeImportSession.id },
    data: { rowsCount: financeNormalizeResult.savedRows },
  });

  const reportIds = getReportIds(financeResult.rows).slice(0, 1);
  const salesDetailedRows: WbSalesDetailedRow[] = [];

  for (const reportId of reportIds) {
    await sleep(WB_REQUEST_DELAY_MS);

    const rows = await fetchWbSalesDetailedRows(wbToken, reportId);

    salesDetailedRows.push(...rows);
  }

  const salesRows = mapWbSalesApiRows(salesDetailedRows);

  const salesImportSession = await prisma.importSession.create({
    data: {
      fileName: `WB API Sales ${company.name} ${financeResult.dateFrom} - ${financeResult.dateTo}`,
      reportType: "WB_SALES",
      marketplace: "WILDBERRIES",
      companyName: company.name,
      rowsCount: salesRows.length,
      previewJson: salesRows.slice(0, 10),
      sheetName: "WB Sales API",
      headerRow: 1,
      status: "SUCCESS",
    },
  });

  const salesNormalizeResult = await normalizeWbSales(
    salesRows,
    salesImportSession.id,
    company.name
  );

  await prisma.importSession.update({
    where: { id: salesImportSession.id },
    data: { rowsCount: salesNormalizeResult.savedRows },
  });

  return {
    name: "WB Finance + Sales",
    rows:
      financeNormalizeResult.savedRows + salesNormalizeResult.savedRows,
    financeRows: financeNormalizeResult.savedRows,
    salesRows: salesNormalizeResult.savedRows,
  };
}

export async function syncWbAll(companyId: string) {
  const results = [];

  try {
    results.push(await syncWbFinanceAndSales(companyId));

    await setWbConnected(companyId);

    return {
      ok: true,
      results,
    };
  } catch (error) {
    await setWbError(companyId, error);

    return {
      ok: false,
      results,
      error: getErrorMessage(error),
      isRateLimit: isWbRateLimitError(error),
    };
  }
}