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

type WbSalesDetailedRow = Record<string, unknown>;

type SyncOptions = {
  dateFrom: Date;
  dateTo: Date;
  period?: "daily" | "weekly";
  loadDetailed?: boolean;
};

const DEFAULT_DETAIL_LIMIT = 100_000;
const DEFAULT_DETAIL_MAX_PAGES = 20;
const DEFAULT_DETAIL_DELAY_MS = Number(
  process.env.WB_DAILY_FINANCE_DETAIL_DELAY_MS ?? 15_000
);

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function formatDateOnly(date: Date) {
  return startOfUtcDay(date).toISOString().slice(0, 10);
}

function normalizeReportNumber(value: unknown) {
  return String(value ?? "").trim();
}

function getReportNumber(row: WbFinanceReport) {
  return normalizeReportNumber(row.reportId);
}

function mapWbFinanceApiRows(rows: WbFinanceReport[]) {
  return rows.map((row) => ({
    "№ отчета": row.reportId ? String(row.reportId) : "",
    "Юридическое лицо": row.sellerFinanceName ?? "",
    "Дата начала": row.dateFrom ?? "",
    "Дата конца": row.dateTo ?? "",
    "Тип отчета": row.reportType ? String(row.reportType) : "API WB Daily Finance",

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
  return rows.map((row) => {
    const get = (...keys: string[]) => {
      for (const key of keys) {
        const value = row[key];
        if (value !== undefined && value !== null && String(value).trim() !== "") {
          return value;
        }
      }
      return "";
    };

    return {
      "Номер отчета": get("reportId", "realizationreport_id", "realizationReportId"),
      "Номер поставки": get("giId", "gi_id"),

      Бренд: get("brandName", "brand_name", "brand"),
      Предмет: get("subjectName", "subject_name", "subject"),
      Наименование: get("title", "sa_name"),
      Размер: get("techSize", "tech_size"),

      "Код номенклатуры": get("nmId", "nm_id"),
      "Артикул поставщика": get("vendorCode", "sa_name", "supplierArticle"),
      Баркод: get("sku", "barcode"),

      "Обоснование для оплаты": get("sellerOperName", "supplier_oper_name"),
      "Тип документа": get("docTypeName", "doc_type_name"),
      "Дата продажи": get("saleDt", "sale_dt", "rrDate", "rr_dt"),
      "Кол-во": get("quantity"),

      "Цена розничная": get("retailPrice", "retail_price", "totalPrice", "total_price"),
      "Цена розничная с учетом согласованной скидки": get(
        "retailPriceWithDiscount",
        "retail_price_with_discount",
        "retailPrice",
        "retail_price"
      ),
      "Вайлдберриз реализовал Товар (Пр)": get("retailAmount", "retail_amount"),
      "К перечислению Продавцу за реализованный Товар": get("forPay", "ppvz_for_pay"),

      "Платформенные скидки, %": get(
        "platformDiscountPercent",
        "platform_discount_percent"
      ),
      "Размер кВВ, %": get("commissionPercent", "commission_percent"),

      "Вознаграждение Вайлдберриз (ВВ), без НДС": get("vw", "ppvz_vw"),
      "НДС с Вознаграждения Вайлдберриз": get("ppvzVwNds", "ppvz_vw_nds"),

      "Количество доставок": get("deliveryAmount", "delivery_amount"),
      "Количество возврата": get("returnAmount", "return_amount"),
      "Услуги по доставке товара покупателю": get("deliveryService", "delivery_rub"),

      Хранение: get("paidStorage", "storage_fee"),
      "Платная приемка": get("paidAcceptance", "acceptance"),
      Удержания: get("deduction"),
      "Общая сумма штрафов": get("penalty"),
      "Виды логистики, штрафов и корректировок ВВ": get(
        "bonusTypeName",
        "bonus_type_name"
      ),

      "Компенсация платёжных услуг/Комиссия за интеграцию платёжных сервисов": get(
        "acquiringFee",
        "acquiring_fee"
      ),
      "Возмещение за выдачу и возврат товаров на ПВЗ": get(
        "ppvzReward",
        "ppvz_reward"
      ),
      "Возмещение издержек по перевозке/по складским операциям с товаром": get(
        "rebillLogisticCost",
        "rebill_logistic_cost"
      ),
      "Возмещение издержек по перевозке": get(
        "rebillLogisticCost",
        "rebill_logistic_cost"
      ),
      "Компенсация скидки по программе лояльности": get(
        "loyaltyDiscountCompensation",
        "loyalty_discount_compensation"
      ),
      "Стоимость участия в программе лояльности": get(
        "loyaltyParticipationCost",
        "loyalty_participation_cost"
      ),
      "Сумма баллов, удержанных по программе лояльности": get(
        "loyaltyPointsAmount",
        "loyalty_points_amount"
      ),
    };
  });
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

async function markConnected(companyId: string) {
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
}

async function markError(companyId: string, error: unknown) {
  await prisma.marketplaceApiConnection.update({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace: "WB",
      },
    },
    data: {
      status: "ERROR",
      lastAttemptAt: new Date(),
      lastError: getErrorMessage(error).slice(0, 1000),
      retryCount: {
        increment: 1,
      },
    },
  });
}

async function fetchWbDailyFinanceReports(
  token: string,
  options: SyncOptions
) {
  const dateFrom = formatDateOnly(options.dateFrom);
  const dateTo = formatDateOnly(options.dateTo);
  const period = options.period ?? "daily";

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
        period,
      }),
      cache: "no-store",
    }
  );

  if (response.status === 204) {
    return { dateFrom, dateTo, period, rows: [] as WbFinanceReport[] };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`WB Daily Finance API: ${response.status} ${text}`.trim());
  }

  const json = await response.json();

  if (!Array.isArray(json)) {
    throw new Error("WB Daily Finance API вернул неожиданный формат ответа");
  }

  return { dateFrom, dateTo, period, rows: json as WbFinanceReport[] };
}

async function fetchWbDetailedReportRows(token: string, reportId: string) {
  const allRows: WbSalesDetailedRow[] = [];
  const limit = DEFAULT_DETAIL_LIMIT;
  const maxPages = Number(process.env.WB_DAILY_FINANCE_DETAIL_MAX_PAGES ?? DEFAULT_DETAIL_MAX_PAGES);

  let rrdId: number | string = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const response = await requestWithRetry({
      url: `https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed/${reportId}`,
      label: `WB Daily Detail report ${reportId}`,
      timeoutMs: 45_000,
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

    if (response.status === 204) break;

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`WB Daily Detail report ${reportId}: ${response.status} ${text}`.trim());
    }

    const json = await response.json();

    if (!Array.isArray(json)) {
      throw new Error(`WB Daily Detail report ${reportId}: неожиданный формат ответа`);
    }

    if (json.length === 0) break;

    const rows = json as WbSalesDetailedRow[];
    allRows.push(...rows);

    const lastRow = rows[rows.length - 1];
    const nextRrdId = lastRow?.["rrdId"] ?? lastRow?.["rrd_id"] ?? null;

    if (json.length < limit) break;

    if (nextRrdId === null || nextRrdId === undefined || nextRrdId === rrdId) {
      throw new Error(`WB Daily Detail report ${reportId}: rrdId не изменился, пагинация остановлена`);
    }

    rrdId = String(nextRrdId);
    await sleep(DEFAULT_DETAIL_DELAY_MS);
  }

  return allRows;
}

export async function syncWbDailyFinancialReports(
  companyId: string,
  options: SyncOptions
) {
  const { company, connection } = await getWbConnection(companyId);

  try {
    const wbToken = connection.wbToken;

    if (!wbToken) {
      throw new Error("WB token не сохранён");
    }

    const financeResult = await fetchWbDailyFinanceReports(wbToken, options);
    const financeRows = mapWbFinanceApiRows(financeResult.rows);

    const financeImportSession = await prisma.importSession.create({
      data: {
        fileName: `WB API Daily Finance ${company.name} ${financeResult.dateFrom} - ${financeResult.dateTo}`,
        reportType: "WB_FINANCE",
        marketplace: "WILDBERRIES",
        companyName: company.name,
        rowsCount: financeRows.length,
        previewJson: financeRows.slice(0, 10),
        sheetName: "WB Daily Finance API",
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

    const reportNumbers = Array.from(
      new Set(financeResult.rows.map(getReportNumber).filter(Boolean))
    );

    const detailedResults: Array<{
      ok: boolean;
      reportNumber: string;
      rowsFromApi: number;
      savedRows: number;
      error?: string;
    }> = [];

    if (options.loadDetailed !== false) {
      for (const reportNumber of reportNumbers) {
        try {
          const detailRowsFromApi = await fetchWbDetailedReportRows(wbToken, reportNumber);
          const mappedDetailRows = mapWbSalesApiRows(detailRowsFromApi);

          const salesImportSession = await prisma.importSession.create({
            data: {
              fileName: `WB API Daily Detailed ${company.name} report ${reportNumber} ${financeResult.dateFrom} - ${financeResult.dateTo}`,
              reportType: "WB_SALES",
              marketplace: "WILDBERRIES",
              companyName: company.name,
              rowsCount: mappedDetailRows.length,
              previewJson: mappedDetailRows.slice(0, 10),
              sheetName: "WB Daily Detailed API",
              headerRow: 1,
              status: "SUCCESS",
            },
          });

          const salesNormalizeResult = await normalizeWbSales(
            mappedDetailRows,
            salesImportSession.id,
            company.name
          );

          await prisma.importSession.update({
            where: { id: salesImportSession.id },
            data: { rowsCount: salesNormalizeResult.savedRows },
          });

          detailedResults.push({
            ok: true,
            reportNumber,
            rowsFromApi: detailRowsFromApi.length,
            savedRows: salesNormalizeResult.savedRows,
          });
        } catch (error) {
          detailedResults.push({
            ok: false,
            reportNumber,
            rowsFromApi: 0,
            savedRows: 0,
            error: getErrorMessage(error).slice(0, 2000),
          });
        }

        await sleep(DEFAULT_DETAIL_DELAY_MS);
      }
    }

    await markConnected(companyId);

    const detailedRows = detailedResults.reduce((sum, item) => sum + item.savedRows, 0);
    const detailErrors = detailedResults.filter((item) => !item.ok);

    return {
      name: "WB Daily Financial Reports",
      companyName: company.name,
      dateFrom: financeResult.dateFrom,
      dateTo: financeResult.dateTo,
      period: financeResult.period,
      reportsFound: reportNumbers.length,
      reportNumbers,
      financeRows: financeNormalizeResult.savedRows,
      detailedReports: detailedResults,
      detailedRows,
      detailErrors,
      detailStatus: detailErrors.length === 0 ? "COMPLETE" : "PARTIAL",
      rows: financeNormalizeResult.savedRows + detailedRows,
    };
  } catch (error) {
    await markError(companyId, error);
    throw error;
  }
}
