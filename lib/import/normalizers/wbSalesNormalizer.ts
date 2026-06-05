import { prisma } from "@/lib/prisma";

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  const number = Number(normalized);

  return Number.isNaN(number) ? null : number;
}

function toInt(value: unknown): number | null {
  const number = toNumber(value);
  if (number === null) return null;
  return Math.trunc(number);
}

function toDate(value: unknown): Date | null {
  if (!value) return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  if (typeof value === "number") {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const date = new Date(excelEpoch.getTime() + value * 86400000);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const raw = String(value).trim();
  const ddmmyyyy = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);

  if (ddmmyyyy) {
    const day = Number(ddmmyyyy[1]);
    const month = Number(ddmmyyyy[2]) - 1;
    const yearRaw = Number(ddmmyyyy[3]);
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    const date = new Date(year, month, day);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toStringOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

export async function normalizeWbSales(
  rows: Record<string, unknown>[],
  importSessionId: string,
  companyName: string | null
) {
  const data = rows.map((row) => ({
    importSessionId,
    companyName,

    reportNumber: toStringOrNull(row["Номер отчета"]),
    supplyNumber: toStringOrNull(row["Номер поставки"]),

    brand: toStringOrNull(row["Бренд"]),
    subject: toStringOrNull(row["Предмет"]),
    productName: toStringOrNull(row["Наименование"]),
    size: toStringOrNull(row["Размер"]),

    nmId: toStringOrNull(row["Код номенклатуры"]),
    vendorCode:
      toStringOrNull(row["Артикул поставщика"]) ??
      toStringOrNull(row["Артикул продавца"]),
    barcode: toStringOrNull(row["Баркод"]),

    paymentReason: toStringOrNull(row["Обоснование для оплаты"]),
    documentType: toStringOrNull(row["Тип документа"]),

    saleDate:
      toDate(row["Дата продажи"]) ??
      toDate(row["Дата операции"]) ??
      toDate(row["Дата заказа"]) ??
      toDate(row["Дата заказа покупателем"]),

    quantity: toInt(row["Кол-во"]),

    retailPrice: toNumber(row["Цена розничная"]),
    wbRealizedAmount: toNumber(row["Вайлдберриз реализовал Товар (Пр)"]),
    sellerPayout: toNumber(row["К перечислению Продавцу за реализованный Товар"]),

    wbReward: toNumber(row["Вознаграждение Вайлдберриз (ВВ), без НДС"]),

    deliveriesCount: toInt(row["Количество доставок"]),
    returnsCount: toInt(row["Количество возврата"]),

    logisticsCost: toNumber(row["Услуги по доставке товара покупателю"]),
    storageCost: toNumber(row["Хранение"]),
    acceptanceCost:
      toNumber(row["Платная приемка"]) ?? toNumber(row["Операции на приемке"]),
    deductions: toNumber(row["Удержания"]),
    penaltiesAmount: toNumber(row["Общая сумма штрафов"]),

    paymentServiceCost: toNumber(
      row["Компенсация платёжных услуг/Комиссия за интеграцию платёжных сервисов"]
    ),

    pvzCompensation: toNumber(row["Возмещение за выдачу и возврат товаров на ПВЗ"]),
    transportCompensation: toNumber(row["Возмещение издержек по перевозке"]),
    wbRewardCorrection: toNumber(row["Корректировка вознаграждения Вайлдберриз"]),
  }));

  const filteredData = data.filter(
    (row) => row.vendorCode || row.barcode || row.nmId || row.paymentReason
  );

  if (filteredData.length === 0) {
    return { savedRows: 0 };
  }

  await prisma.wbSale.deleteMany({
    where: {
      importSessionId,
      companyName,
    },
  });

  await prisma.wbSale.createMany({
    data: filteredData,
  });

  return {
    savedRows: filteredData.length,
  };
}