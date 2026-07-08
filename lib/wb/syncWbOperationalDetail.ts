import { prisma } from "@/lib/prisma";
import { normalizeWbSales } from "@/lib/import/normalizers/wbSalesNormalizer";

export type WbOperationalDetailOptions = {
  dateFrom?: Date;
  dateTo?: Date;
};

type CompanyRow = {
  id: string;
  name: string;
};

type WbOperationalDetailRow = Record<string, unknown>;

const WB_DETAIL_LIMIT = 100_000;
const WB_DETAIL_MAX_PAGES = 20;

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

function getDateRange(options: WbOperationalDetailOptions = {}) {
  const dateFrom = startOfUtcDay(options.dateFrom ?? new Date());
  const dateTo = startOfUtcDay(options.dateTo ?? dateFrom);

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

function toStringOrNull(value: unknown) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function getField(row: WbOperationalDetailRow, ...names: string[]) {
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }

  return null;
}

function getReportId(row: WbOperationalDetailRow) {
  return toStringOrNull(
    getField(row, "realizationreport_id", "realizationReportId", "reportId")
  );
}

function getRrdId(row: WbOperationalDetailRow) {
  return getField(row, "rrd_id", "rrdId");
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
    select: {
      wbToken: true,
    },
  });

  if (!connection?.wbToken) {
    throw new Error("WB token не сохранён");
  }

  return { company, wbToken: connection.wbToken };
}

async function fetchWbReportDetailByPeriod(
  token: string,
  dateFromText: string,
  dateToText: string
) {
  const allRows: WbOperationalDetailRow[] = [];
  let rrdid: number | string = 0;
  let page = 0;

  while (true) {
    if (page >= WB_DETAIL_MAX_PAGES) {
      throw new Error(
        `WB reportDetailByPeriod: остановлено после ${WB_DETAIL_MAX_PAGES} страниц, чтобы не уйти в бесконечную пагинацию`
      );
    }

    const url = new URL(
      "https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod"
    );

    url.searchParams.set("dateFrom", `${dateFromText}T00:00:00`);
    url.searchParams.set("dateTo", `${dateToText}T23:59:59`);
    url.searchParams.set("limit", String(WB_DETAIL_LIMIT));
    url.searchParams.set("rrdid", String(rrdid));

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: token,
      },
      cache: "no-store",
    });

    if (response.status === 204) {
      break;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `WB reportDetailByPeriod: ${response.status} ${text}`.trim()
      );
    }

    const json = await response.json().catch(() => null);

    if (!Array.isArray(json)) {
      throw new Error("WB reportDetailByPeriod вернул неожиданный формат ответа");
    }

    if (json.length === 0) {
      break;
    }

    allRows.push(...(json as WbOperationalDetailRow[]));

    const nextRrdid = getRrdId(json[json.length - 1]);

    if (json.length < WB_DETAIL_LIMIT) {
      break;
    }

    if (!nextRrdid || String(nextRrdid) === String(rrdid)) {
      throw new Error("WB reportDetailByPeriod: rrdid не изменился");
    }

    rrdid = nextRrdid as number | string;
    page += 1;
  }

  return allRows;
}

function mapWbOperationalRows(rows: WbOperationalDetailRow[]) {
  return rows.map((row) => ({
    "Номер отчета": getReportId(row) ?? "",

    "Номер поставки":
      getField(row, "gi_id", "giId", "incomeID", "incomeId") ?? "",

    Бренд: getField(row, "brand_name", "brandName", "brand") ?? "",
    Предмет: getField(row, "subject_name", "subjectName", "subject") ?? "",
    Наименование: getField(row, "title", "productName") ?? "",
    Размер: getField(row, "tech_size", "techSize") ?? "",

    "Код номенклатуры": getField(row, "nm_id", "nmId") ?? "",
    "Артикул поставщика": getField(row, "sa_name", "vendorCode", "supplierArticle") ?? "",
    Баркод: getField(row, "barcode", "sku") ?? "",

    "Обоснование для оплаты":
      getField(row, "supplier_oper_name", "supplierOperName", "sellerOperName") ?? "",

    "Тип документа": getField(row, "doc_type_name", "docTypeName") ?? "",

    // Для reportDetailByPeriod фильтр WB работает по периоду детализации.
    // Обычно sale_dt совпадает с днем выкупа, а rr_dt нужен как fallback.
    "Дата продажи": getField(row, "sale_dt", "saleDt", "rr_dt", "rrDate") ?? "",

    "Кол-во": getField(row, "quantity") ?? "",

    "Цена розничная": getField(row, "retail_price", "retailPrice") ?? "",
    "Цена розничная с учетом согласованной скидки":
      getField(
        row,
        "retail_price_withdisc_rub",
        "retail_price_with_discount",
        "retailPriceWithDiscount",
        "retail_price",
        "retailPrice"
      ) ?? "",

    "Вайлдберриз реализовал Товар (Пр)":
      getField(row, "retail_amount", "retailAmount") ?? "",

    "К перечислению Продавцу за реализованный Товар":
      getField(row, "ppvz_for_pay", "forPay") ?? "",

    "Платформенные скидки, %":
      getField(row, "platform_discount_percent", "platformDiscountPercent") ?? "",

    "Размер кВВ, %": getField(row, "commission_percent", "commissionPercent") ?? "",

    "Вознаграждение Вайлдберриз (ВВ), без НДС":
      getField(row, "ppvz_vw", "vw") ?? "",

    "НДС с Вознаграждения Вайлдберриз":
      getField(row, "ppvz_vw_nds", "ppvzVwNds") ?? "",

    "Количество доставок": getField(row, "delivery_amount", "deliveryAmount") ?? "",
    "Количество возврата": getField(row, "return_amount", "returnAmount") ?? "",

    "Услуги по доставке товара покупателю":
      getField(row, "delivery_rub", "deliveryService") ?? "",

    Хранение: getField(row, "storage_fee", "paidStorage") ?? "",
    "Платная приемка": getField(row, "acceptance", "paidAcceptance") ?? "",
    Удержания: getField(row, "deduction") ?? "",
    "Общая сумма штрафов": getField(row, "penalty") ?? "",

    "Виды логистики, штрафов и корректировок ВВ":
      getField(row, "bonus_type_name", "bonusTypeName") ?? "",

    "Компенсация платёжных услуг/Комиссия за интеграцию платёжных сервисов":
      getField(row, "acquiring_fee", "acquiringFee") ?? "",

    "Возмещение за выдачу и возврат товаров на ПВЗ":
      getField(row, "ppvz_reward", "ppvzReward") ?? "",

    "Возмещение издержек по перевозке":
      getField(row, "rebill_logistic_cost", "rebillLogisticCost") ?? "",

    "Возмещение издержек по перевозке/по складским операциям с товаром":
      getField(row, "rebill_logistic_cost", "rebillLogisticCost") ?? "",

    "Корректировка вознаграждения Вайлдберриз": "",
    "Компенсация скидки по программе лояльности":
      getField(row, "loyalty_discount_compensation", "loyaltyDiscountCompensation") ?? "",
    "Стоимость участия в программе лояльности":
      getField(row, "loyalty_participation_cost", "loyaltyParticipationCost") ?? "",
    "Сумма баллов, удержанных по программе лояльности":
      getField(row, "loyalty_points_amount", "loyaltyPointsAmount") ?? "",
  }));
}

export async function syncWbOperationalDetail(
  companyId: string,
  options: WbOperationalDetailOptions = {}
) {
  const { company, wbToken } = await getWbConnection(companyId);
  const { dateFromText, dateToText } = getDateRange(options);

  const apiRows = await fetchWbReportDetailByPeriod(
    wbToken,
    dateFromText,
    dateToText
  );

  const mappedRows = mapWbOperationalRows(apiRows);
  const reportNumbers = Array.from(
    new Set(apiRows.map(getReportId).filter(Boolean) as string[])
  );

  const importSession = await prisma.importSession.create({
    data: {
      fileName: `WB Operational Detail ${company.name} ${dateFromText} - ${dateToText}`,
      reportType: "WB_SALES_OPERATIONAL",
      marketplace: "WILDBERRIES",
      companyName: company.name,
      rowsCount: mappedRows.length,
      previewJson: mappedRows.slice(0, 10),
      sheetName: "WB reportDetailByPeriod",
      headerRow: 1,
      status: "SUCCESS",
    },
  });

  const normalizeResult = await normalizeWbSales(
    mappedRows,
    importSession.id,
    company.name
  );

  await prisma.importSession.update({
    where: { id: importSession.id },
    data: { rowsCount: normalizeResult.savedRows },
  });

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

  return {
    name: "WB Operational Detail",
    rows: normalizeResult.savedRows,
    apiRows: apiRows.length,
    dateFrom: dateFromText,
    dateTo: dateToText,
    reportNumbers,
  };
}

export function getWbOperationalDetailErrorMessage(error: unknown) {
  return getErrorMessage(error);
}
