import { prisma } from "@/lib/prisma";

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(",", ".");

  const number = Number(normalized);

  return Number.isNaN(number) ? null : number;
}

function toDate(value: unknown): Date | null {
  if (!value) {
    return null;
  }

  const date = new Date(String(value));

  return Number.isNaN(date.getTime()) ? null : date;
}

export async function normalizeWbSales(
  rows: any[],
  importSessionId: string
) {
  const data = rows.map((row) => ({
    importSessionId,

    reportNumber: row["Номер отчета"] ? String(row["Номер отчета"]) : null,
    supplyNumber: row["Номер поставки"] ? String(row["Номер поставки"]) : null,
    subject: row["Предмет"] ? String(row["Предмет"]) : null,
    nmId: row["Код номенклатуры"] ? String(row["Код номенклатуры"]) : null,
    vendorCode: row["Артикул поставщика"] ? String(row["Артикул поставщика"]) : null,
    barcode: row["Баркод"] ? String(row["Баркод"]) : null,

    documentType: row["Тип документа"] ? String(row["Тип документа"]) : null,
    saleDate: toDate(row["Дата продажи"]),

    quantity: toNumber(row["Кол-во"]),
    retailPrice: toNumber(row["Цена розничная"]),
    wbRealizedAmount: toNumber(row["Вайлдберриз реализовал Товар (Пр)"]),
    wbReward: toNumber(row["Вознаграждение Вайлдберриз (ВВ), без НДС"]),
    sellerPayout: toNumber(row["К перечислению Продавцу за реализованный Товар"]),
    logisticsCost: toNumber(row["Услуги по доставке товара покупателю"]),
  }));

  const filteredData = data.filter((row) => row.vendorCode || row.barcode);

  if (filteredData.length === 0) {
    return {
      savedRows: 0,
    };
  }

  await prisma.wbSale.createMany({
    data: filteredData,
  });

  return {
    savedRows: filteredData.length,
  };
}