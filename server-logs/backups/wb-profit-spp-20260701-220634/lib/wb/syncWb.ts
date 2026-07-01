import { prisma } from "@/lib/prisma";
import { normalizeWbFinance } from "@/lib/import/normalizers/wbFinanceNormalizer";
import { normalizeWbSales } from "@/lib/import/normalizers/wbSalesNormalizer";
import { sleep } from "@/lib/sleep";
import { requestWithRetry } from "@/lib/wbApi/requestWithRetry";
import { syncWbAds } from "@/lib/wb/syncWbAds";
import { syncWbStock } from "@/lib/wb/syncWbStock";
import { syncWbProductCards } from "@/lib/wb/syncWbProductCards";

type CompanyRow = {
  id: string;
  name: string;
};

type WbSyncPeriodOptions = {
  dateFrom?: Date;
  dateTo?: Date;
};

type WbSalesByReportOptions = {
  dateFrom?: Date | null;
  dateTo?: Date | null;
};

type SyncStepResult = {
  name: string;
  ok: boolean;
  rows: number;
  error: string | null;
  isRateLimit?: boolean;
  durationMs: number;
  details?: Record<string, unknown>;
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
  realizationreport_id?: number | string;
  rrdId?: number | string;
  rrd_id?: number | string;
  giId?: number | string;
  gi_id?: number | string;
  brandName?: string;
  brand_name?: string;
  subjectName?: string;
  subject_name?: string;
  title?: string;
  techSize?: string;
  tech_size?: string;
  nmId?: number | string;
  nm_id?: number | string;
  vendorCode?: string;
  sa_name?: string;
  sku?: string;
  barcode?: string;
  sellerOperName?: string;
  supplier_oper_name?: string;
  docTypeName?: string;
  doc_type_name?: string;
  saleDt?: string;
  sale_dt?: string;
  rrDate?: string;
  rr_dt?: string;
  quantity?: number | string;
  retailPrice?: number | string;
  retail_price?: number | string;
  retailAmount?: number | string;
  retail_amount?: number | string;
  forPay?: number | string;
  ppvz_for_pay?: number | string;
  vw?: number | string;
  ppvz_vw?: number | string;
  deliveryAmount?: number | string;
  delivery_amount?: number | string;
  returnAmount?: number | string;
  return_amount?: number | string;
  deliveryService?: number | string;
  delivery_rub?: number | string;
  paidStorage?: number | string;
  storage_fee?: number | string;
  paidAcceptance?: number | string;
  acceptance?: number | string;
  deduction?: number | string;
  penalty?: number | string;
  acquiringFee?: number | string;
  acquiring_fee?: number | string;
  ppvzReward?: number | string;
  ppvz_reward?: number | string;
  rebillLogisticCost?: number | string;
  rebill_logistic_cost?: number | string;
};

const WB_COOLDOWN_MS = 60 * 60 * 1000;
const WB_REQUEST_DELAY_MS = 70 * 1000;
const WB_SALES_DETAILED_LIMIT = 100_000;
const WB_SALES_MAX_PAGES = 20;

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
  return "WB временно ограничил запросы (429). Повторная синхронизация будет выполнена автоматически позже.";
}

function getCooldownMessage(lastAttemptAt: Date) {
  const nextTryAt = new Date(lastAttemptAt.getTime() + WB_COOLDOWN_MS);

  return `WB недавно вернул 429. Чтобы не усиливать блокировку, повторный запуск временно остановлен. Повторить можно после ${nextTryAt.toLocaleString("ru-RU")}.`;
}

function isConnectionInCooldown(connection: {
  lastError: string | null;
  lastAttemptAt: Date | null;
}) {
  if (!connection.lastError || !connection.lastAttemptAt) {
    return false;
  }

  return (
    isWbRateLimitError(connection.lastError) &&
    Date.now() - connection.lastAttemptAt.getTime() < WB_COOLDOWN_MS
  );
}

function startOfUtcDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function formatDateForFileName(date: Date | null | undefined) {
  if (!date) return "unknown";
  return formatDateOnly(date);
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

function getSyncPeriod(options: WbSyncPeriodOptions = {}) {
  if (!options.dateFrom && !options.dateTo) {
    return getDefaultPeriod();
  }

  if (!options.dateFrom || !options.dateTo) {
    throw new Error("Для исторической WB-синхронизации нужны dateFrom и dateTo");
  }

  const dateFrom = startOfUtcDay(options.dateFrom);
  const dateTo = startOfUtcDay(options.dateTo);

  if (dateFrom.getTime() > dateTo.getTime()) {
    throw new Error("dateFrom не может быть позже dateTo");
  }

  return {
    dateFrom: formatDateOnly(dateFrom),
    dateTo: formatDateOnly(dateTo),
  };
}

function getWbSalesRrdId(row: WbSalesDetailedRow) {
  return row.rrdId ?? row.rrd_id ?? null;
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

function normalizeWbReportNumber(value: unknown) {
  return String(value ?? "").trim();
}

function getWbFinanceApiReportNumber(row: WbFinanceReport) {
  return normalizeWbReportNumber(row.reportId);
}

async function getExistingWbFinanceReportNumbers(
  companyName: string,
  reportNumbers: string[]
) {
  const normalizedReportNumbers = Array.from(
    new Set(reportNumbers.map(normalizeWbReportNumber).filter(Boolean))
  );

  if (normalizedReportNumbers.length === 0) {
    return new Set<string>();
  }

  const rows = await prisma.wbFinance.findMany({
    where: {
      companyName,
      reportNumber: {
        in: normalizedReportNumbers,
      },
    },
    select: {
      reportNumber: true,
    },
    distinct: ["reportNumber"],
  });

  return new Set(
    rows
      .map((row) => normalizeWbReportNumber(row.reportNumber))
      .filter(Boolean)
  );
}

async function getExistingWbSalesRowsCount(
  companyName: string,
  reportNumber: string
) {
  const normalizedReportNumber = normalizeWbReportNumber(reportNumber);

  if (!normalizedReportNumber) {
    return 0;
  }

  return prisma.wbSale.count({
    where: {
      companyName,
      reportNumber: normalizedReportNumber,
    },
  });
}

function mapWbSalesApiRows(rows: WbSalesDetailedRow[]) {
  return rows.map((row) => ({
    "Номер отчета": row.reportId
      ? String(row.reportId)
      : row.realizationreport_id
        ? String(row.realizationreport_id)
        : "",

    "Номер поставки": row.giId
      ? String(row.giId)
      : row.gi_id
        ? String(row.gi_id)
        : "",

    Бренд: row.brandName ?? row.brand_name ?? "",
    Предмет: row.subjectName ?? row.subject_name ?? "",
    Наименование: row.title ?? "",
    Размер: row.techSize ?? row.tech_size ?? "",

    "Код номенклатуры": row.nmId
      ? String(row.nmId)
      : row.nm_id
        ? String(row.nm_id)
        : "",

    "Артикул поставщика": row.vendorCode ?? row.sa_name ?? "",
    Баркод: row.sku ?? row.barcode ?? "",

    "Обоснование для оплаты":
      row.sellerOperName ?? row.supplier_oper_name ?? "",

    "Тип документа": row.docTypeName ?? row.doc_type_name ?? "",

    "Дата продажи": row.saleDt ?? row.sale_dt ?? row.rrDate ?? row.rr_dt ?? "",

    "Кол-во": row.quantity ?? "",

    "Цена розничная": row.retailPrice ?? row.retail_price ?? "",
    "Вайлдберриз реализовал Товар (Пр)":
      row.retailAmount ?? row.retail_amount ?? "",
    "К перечислению Продавцу за реализованный Товар":
      row.forPay ?? row.ppvz_for_pay ?? "",

    "Вознаграждение Вайлдберриз (ВВ), без НДС":
      row.vw ?? row.ppvz_vw ?? "",

    "Количество доставок": row.deliveryAmount ?? row.delivery_amount ?? "",
    "Количество возврата": row.returnAmount ?? row.return_amount ?? "",

    "Услуги по доставке товара покупателю":
      row.deliveryService ?? row.delivery_rub ?? "",

    Хранение: row.paidStorage ?? row.storage_fee ?? "",
    "Платная приемка": row.paidAcceptance ?? row.acceptance ?? "",
    Удержания: row.deduction ?? "",
    "Общая сумма штрафов": row.penalty ?? "",

    "Компенсация платёжных услуг/Комиссия за интеграцию платёжных сервисов":
      row.acquiringFee ?? row.acquiring_fee ?? "",

    "Возмещение за выдачу и возврат товаров на ПВЗ":
      row.ppvzReward ?? row.ppvz_reward ?? "",

    "Возмещение издержек по перевозке":
      row.rebillLogisticCost ?? row.rebill_logistic_cost ?? "",

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

async function markWbAttempt(companyId: string) {
  await prisma.marketplaceApiConnection.update({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace: "WB",
      },
    },
    data: {
      lastAttemptAt: new Date(),
    },
  });
}

async function setWbConnected(companyId: string, lastError?: string | null) {
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
      lastError: lastError ?? null,
      retryCount: 0,
    },
  });
}

async function setWbRateLimited(companyId: string, errorText: string) {
  await prisma.marketplaceApiConnection.update({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace: "WB",
      },
    },
    data: {
      status: "CONNECTED",
      lastAttemptAt: new Date(),
      lastError: errorText.slice(0, 1000),
      retryCount: {
        increment: 1,
      },
    },
  });
}

async function setWbError(companyId: string, error: unknown) {
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
      retryCount: {
        increment: 1,
      },
    },
  });
}

async function fetchWbFinanceReports(
  token: string,
  options: WbSyncPeriodOptions = {}
) {
  const { dateFrom, dateTo } = getSyncPeriod(options);

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
  const limit = WB_SALES_DETAILED_LIMIT;

  let rrdId: number | string = 0;
  let page = 0;

  while (true) {
    if (page >= WB_SALES_MAX_PAGES) {
      throw new Error(
        `WB Sales API report ${reportId}: остановлено после ${WB_SALES_MAX_PAGES} страниц, чтобы не уйти в бесконечную пагинацию`
      );
    }

    const url = `https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed/${reportId}`;

    const response = await requestWithRetry({
      url,
      label: `WB Sales API report ${reportId}`,
      timeoutMs: 30_000,
      init: {
        method: "POST",
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          limit,
          rrdId,
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

    if (json.length === 0) {
      break;
    }

    const rows = json as WbSalesDetailedRow[];
    const lastRow = rows[rows.length - 1];
    const nextRrdId = getWbSalesRrdId(lastRow);

    allRows.push(...rows);

    if (json.length < limit) {
      break;
    }

    if (nextRrdId === null || nextRrdId === undefined || nextRrdId === rrdId) {
      throw new Error(
        `WB Sales API report ${reportId}: не удалось продолжить пагинацию, rrdId не изменился`
      );
    }

    rrdId = nextRrdId;
    page += 1;

    await sleep(WB_REQUEST_DELAY_MS);
  }

  return allRows;
}

async function getNextFinanceReportWithoutSales(companyName: string) {
  const reports = await prisma.wbFinance.findMany({
    where: {
      companyName,
      reportNumber: {
        not: null,
      },
    },
    orderBy: [{ dateFrom: "desc" }, { createdAt: "desc" }],
    select: {
      reportNumber: true,
      dateFrom: true,
      dateTo: true,
    },
  });

  if (reports.length === 0) {
    throw new Error(
      "Не найден номер отчёта WB Finance. Сначала запусти синхронизацию WB Finance."
    );
  }

  const seenReportNumbers = new Set<string>();

  const uniqueReports = reports.filter((report) => {
    const reportNumber = String(report.reportNumber ?? "").trim();

    if (!reportNumber || seenReportNumbers.has(reportNumber)) {
      return false;
    }

    seenReportNumbers.add(reportNumber);
    return true;
  });

  const reportNumbers = uniqueReports.map((report) =>
    String(report.reportNumber)
  );

  if (reportNumbers.length === 0) {
    throw new Error(
      "Не найден номер отчёта WB Finance. Сначала запусти синхронизацию WB Finance."
    );
  }

  const existingSalesReports = await prisma.wbSale.findMany({
    where: {
      companyName,
      reportNumber: {
        in: reportNumbers,
      },
    },
    select: {
      reportNumber: true,
    },
    distinct: ["reportNumber"],
  });

  const loadedReportNumbers = new Set(
    existingSalesReports
      .map((row) => String(row.reportNumber ?? "").trim())
      .filter(Boolean)
  );

  const nextReport =
    uniqueReports.find(
      (report) => !loadedReportNumbers.has(String(report.reportNumber))
    ) ?? null;

  return {
    report: nextReport,
    totalReports: uniqueReports.length,
    loadedReports: loadedReportNumbers.size,
    pendingReports: Math.max(uniqueReports.length - loadedReportNumbers.size, 0),
  };
}

async function runSyncStep<T extends { name: string; rows: number }>(
  name: string,
  fn: () => Promise<T>
): Promise<SyncStepResult> {
  const startedAt = Date.now();

  try {
    const result = await fn();

    const { name: resultName, rows, ...details } = result;

    return {
      name: resultName || name,
      ok: true,
      rows,
      error: null,
      durationMs: Date.now() - startedAt,
      details,
    };
  } catch (error) {
    return {
      name,
      ok: false,
      rows: 0,
      error: getErrorMessage(error),
      isRateLimit: isWbRateLimitError(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

export async function syncWbFinanceMissingReports(
  companyId: string,
  options: WbSyncPeriodOptions = {}
) {
  const { company, connection } = await getWbConnection(companyId);

  if (isConnectionInCooldown(connection)) {
    const message = getCooldownMessage(connection.lastAttemptAt as Date);

    return {
      name: "WB Finance Missing Reports",
      rows: 0,
      financeRows: 0,
      skipped: true,
      reason: "WB_RATE_LIMIT_COOLDOWN",
      message,
    };
  }

  const wbToken = connection.wbToken;

  if (!wbToken) {
    throw new Error("WB token не сохранён");
  }

  const financeResult = await fetchWbFinanceReports(wbToken, options);
  const apiReportNumbers = Array.from(
    new Set(
      financeResult.rows
        .map((row) => getWbFinanceApiReportNumber(row))
        .filter(Boolean)
    )
  );

  const existingReportNumbers = await getExistingWbFinanceReportNumbers(
    company.name,
    apiReportNumbers
  );

  const missingFinanceRows = financeResult.rows.filter((row) => {
    const reportNumber = getWbFinanceApiReportNumber(row);

    return Boolean(reportNumber && !existingReportNumbers.has(reportNumber));
  });

  if (missingFinanceRows.length === 0) {
    return {
      name: "WB Finance Missing Reports",
      rows: 0,
      financeRows: 0,
      skipped: true,
      reason: "ALL_FINANCE_REPORTS_ALREADY_LOADED",
      message:
        "Все WB Finance отчёты за проверяемый период уже есть в базе. Повторная загрузка пропущена.",
      dateFrom: financeResult.dateFrom,
      dateTo: financeResult.dateTo,
      apiReports: apiReportNumbers.length,
      existingReports: existingReportNumbers.size,
      missingReports: 0,
    };
  }

  const financeRows = mapWbFinanceApiRows(missingFinanceRows);

  const financeImportSession = await prisma.importSession.create({
    data: {
      fileName: `WB API Finance missing ${company.name} ${financeResult.dateFrom} - ${financeResult.dateTo}`,
      reportType: "WB_FINANCE",
      marketplace: "WILDBERRIES",
      companyName: company.name,
      rowsCount: financeRows.length,
      previewJson: financeRows.slice(0, 10),
      sheetName: "WB Finance API Missing",
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

  return {
    name: "WB Finance Missing Reports",
    rows: financeNormalizeResult.savedRows,
    financeRows: financeNormalizeResult.savedRows,
    dateFrom: financeResult.dateFrom,
    dateTo: financeResult.dateTo,
    apiReports: apiReportNumbers.length,
    existingReports: existingReportNumbers.size,
    missingReports: missingFinanceRows.length,
    loadedReportNumbers: missingFinanceRows
      .map((row) => getWbFinanceApiReportNumber(row))
      .filter(Boolean),
  };
}

export async function syncWbFinance(
  companyId: string,
  options: WbSyncPeriodOptions = {}
) {
  const { company, connection } = await getWbConnection(companyId);

  if (isConnectionInCooldown(connection)) {
    const message = getCooldownMessage(connection.lastAttemptAt as Date);

    return {
      name: "WB Finance",
      rows: 0,
      skipped: true,
      message,
    };
  }

  const wbToken = connection.wbToken;

  if (!wbToken) {
    throw new Error("WB token не сохранён");
  }

  const financeResult = await fetchWbFinanceReports(wbToken, options);
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

  return {
    name: "WB Finance",
    rows: financeNormalizeResult.savedRows,
    financeRows: financeNormalizeResult.savedRows,
    dateFrom: financeResult.dateFrom,
    dateTo: financeResult.dateTo,
  };
}

export async function syncWbSalesByReportNumber(
  companyId: string,
  reportId: string,
  options: WbSalesByReportOptions = {}
) {
  const normalizedReportId = String(reportId ?? "").trim();

  if (!normalizedReportId) {
    throw new Error("WB Sales: reportNumber не заполнен");
  }

  const { company, connection } = await getWbConnection(companyId);
  const existingRows = await getExistingWbSalesRowsCount(
    company.name,
    normalizedReportId
  );

  if (existingRows > 0) {
    return {
      name: "WB Sales",
      rows: 0,
      salesRows: 0,
      skipped: true,
      reason: "WB_SALES_REPORT_ALREADY_LOADED",
      message: `WB Sales report ${normalizedReportId} уже есть в базе (${existingRows} строк). Повторная загрузка пропущена.`,
      reportId: normalizedReportId,
      existingRows,
      dateFrom: formatDateForFileName(options.dateFrom),
      dateTo: formatDateForFileName(options.dateTo),
    };
  }

  if (isConnectionInCooldown(connection)) {
    const message = getCooldownMessage(connection.lastAttemptAt as Date);

    return {
      name: "WB Sales",
      rows: 0,
      skipped: true,
      message,
      reportId: normalizedReportId,
    };
  }

  const wbToken = connection.wbToken;

  if (!wbToken) {
    throw new Error("WB token не сохранён");
  }

  const salesDetailedRows = await fetchWbSalesDetailedRows(
    wbToken,
    normalizedReportId
  );
  const salesRows = mapWbSalesApiRows(salesDetailedRows);

  const salesImportSession = await prisma.importSession.create({
    data: {
      fileName: `WB API Sales ${company.name} report ${normalizedReportId} ${formatDateForFileName(
        options.dateFrom
      )} - ${formatDateForFileName(options.dateTo)}`,
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
    name: "WB Sales",
    rows: salesNormalizeResult.savedRows,
    salesRows: salesNormalizeResult.savedRows,
    reportId: normalizedReportId,
    dateFrom: formatDateForFileName(options.dateFrom),
    dateTo: formatDateForFileName(options.dateTo),
  };
}

export async function syncWbSales(companyId: string) {
  const { company, connection } = await getWbConnection(companyId);

  if (isConnectionInCooldown(connection)) {
    const message = getCooldownMessage(connection.lastAttemptAt as Date);

    return {
      name: "WB Sales",
      rows: 0,
      skipped: true,
      message,
    };
  }

  const salesQueue = await getNextFinanceReportWithoutSales(company.name);

  if (!salesQueue.report) {
    return {
      name: "WB Sales",
      rows: 0,
      salesRows: 0,
      skipped: true,
      message: "Все найденные отчёты WB Sales уже загружены.",
      totalReports: salesQueue.totalReports,
      loadedReports: salesQueue.loadedReports,
      pendingReports: 0,
    };
  }

  const reportId = String(salesQueue.report.reportNumber);

  const existingSalesRows = await prisma.wbSale.count({
    where: {
      companyName: company.name,
      reportNumber: reportId,
    },
  });

  if (existingSalesRows > 0) {
    return {
      name: "WB Sales",
      rows: 0,
      salesRows: 0,
      reportId,
      skipped: true,
      message: `WB Sales report ${reportId} уже загружен, повторная загрузка пропущена.`,
      totalReports: salesQueue.totalReports,
      loadedReports: salesQueue.loadedReports,
      pendingReports: salesQueue.pendingReports,
    };
  }

  const salesResult = await syncWbSalesByReportNumber(companyId, reportId, {
    dateFrom: salesQueue.report.dateFrom,
    dateTo: salesQueue.report.dateTo,
  });

  return {
    ...salesResult,
    totalReports: salesQueue.totalReports,
    loadedReportsBefore: salesQueue.loadedReports,
    pendingReportsBefore: salesQueue.pendingReports,
  };
}

export async function syncWbFinanceAndSales(companyId: string) {
  const financeResult = await syncWbFinance(companyId);
  const salesResult = await syncWbSales(companyId);

  return {
    name: "WB Finance + Sales",
    rows: financeResult.rows + salesResult.rows,
    financeRows: financeResult.rows,
    salesRows: salesResult.rows,
  };
}

export async function syncWbAll(companyId: string) {
  const { connection } = await getWbConnection(companyId);

  if (isConnectionInCooldown(connection)) {
    const message = getCooldownMessage(connection.lastAttemptAt as Date);

    return {
      ok: true,
      partial: true,
      skipped: true,
      reason: "RATE_LIMIT_COOLDOWN",
      results: [
        {
          name: "WB Sync",
          ok: true,
          rows: 0,
          error: null,
          durationMs: 0,
          details: {
            skipped: true,
            message,
            retryCount: connection.retryCount,
          },
        },
      ],
    };
  }

  await markWbAttempt(companyId);

  const results: SyncStepResult[] = [];

  results.push(
    await runSyncStep("WB Product Cards", () => syncWbProductCards(companyId))
  );
  results.push(await runSyncStep("WB Stock", () => syncWbStock(companyId)));
  results.push(await runSyncStep("WB Ads", () => syncWbAds(companyId)));
  results.push(await runSyncStep("WB Finance", () => syncWbFinance(companyId)));
  results.push(await runSyncStep("WB Sales", () => syncWbSales(companyId)));

  const failedResults = results.filter((result) => !result.ok);
  const hardFailures = failedResults.filter((result) => !result.isRateLimit);
  const successfulResults = results.filter((result) => result.ok);

  if (successfulResults.length > 0) {
    const warningText =
      failedResults.length > 0
        ? failedResults
            .map((result) => `${result.name}: ${result.error}`)
            .join(" | ")
            .slice(0, 1000)
        : null;

    await setWbConnected(companyId, warningText);

    return {
      ok: hardFailures.length === 0,
      partial: failedResults.length > 0,
      results,
    };
  }

  const errorText =
    failedResults.map((result) => `${result.name}: ${result.error}`).join(" | ") ||
    "WB синхронизация не выполнила ни один блок";

  if (failedResults.every((result) => result.isRateLimit)) {
    await setWbRateLimited(companyId, getWbRateLimitMessage());

    return {
      ok: false,
      partial: false,
      results,
      error: errorText,
      isRateLimit: true,
    };
  }

  await setWbError(companyId, errorText);

  return {
    ok: false,
    partial: false,
    results,
    error: errorText,
    isRateLimit: failedResults.every((result) => result.isRateLimit),
  };
}