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

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const number = toNumber(value);
    if (number !== null) return number;
  }

  return null;
}

function calculateSppAmount(
  retailPriceWithDiscount: number | null,
  wbRealizedAmount: number | null
) {
  if (retailPriceWithDiscount === null || wbRealizedAmount === null) return null;
  return retailPriceWithDiscount - wbRealizedAmount;
}

function calculateWbRewardTotal(
  wbReward: number | null,
  wbRewardVat: number | null
) {
  if (wbReward === null && wbRewardVat === null) return null;
  return (wbReward ?? 0) + (wbRewardVat ?? 0);
}

export async function normalizeWbSales(
  rows: Record<string, unknown>[],
  importSessionId: string,
  companyName: string | null
) {
  const data = rows.map((row) => {
    const retailPriceWithDiscount = firstNumber(
      row["Цена розничная с учетом согласованной скидки"],
      row["Цена розничная с учётом согласованной скидки"],
      row["Цена розничная"]
    );

    const wbRealizedAmount = firstNumber(
      row["Вайлдберриз реализовал Товар (Пр)"],
      row["Wildberries реализовал товар"],
      row["WB реализовал товар"]
    );

    const wbReward = firstNumber(
      row["Вознаграждение Вайлдберриз (ВВ), без НДС"]
    );

    const wbRewardVat = firstNumber(
      row["НДС с Вознаграждения Вайлдберриз"],
      row["НДС с вознаграждения Вайлдберриз"],
      row["НДС с Вознаграждения WB"],
      row["НДС с вознаграждения WB"]
    );

    const wbRewardTotal = firstNumber(
      row["Вознаграждение Вайлдберриз (ВВ), с НДС"],
      row["Вознаграждение WB с НДС"]
    ) ?? calculateWbRewardTotal(wbReward, wbRewardVat);

    return {
      importSessionId,
      companyName,

      reportNumber: toStringOrNull(row["Номер отчета"]),
      supplyNumber: toStringOrNull(row["Номер поставки"]),

      brand: toStringOrNull(row["Бренд"]),
      subject: toStringOrNull(row["Предмет"]),
      productName: toStringOrNull(row["Наименование"]) ?? toStringOrNull(row["Название"]),
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

      // Для старых отчётов поле retailPrice остаётся заполненным.
      // Для новых отчётов это цена продавца с согласованной скидкой, до СПП WB.
      retailPrice: retailPriceWithDiscount,
      retailPriceWithDiscount,

      // Фактическая реализация WB покупателю после СПП.
      wbRealizedAmount,

      // К перечислению продавцу за реализованный товар.
      sellerPayout: firstNumber(row["К перечислению Продавцу за реализованный Товар"]),

      sppDiscountAmount: calculateSppAmount(
        retailPriceWithDiscount,
        wbRealizedAmount
      ),

      platformDiscountPercent: firstNumber(
        row["Платформенные скидки, %"],
        row["Платформенная скидка, %"]
      ),

      commissionPercentBase: firstNumber(
        row["Размер кВВ без НДС, % Базовый"],
        row["Размер кВВ, %"]
      ),
      commissionPercentFinal: firstNumber(row["Итоговый кВВ без НДС, %"]),

      wbReward,
      wbRewardVat,
      wbRewardTotal,

      deliveriesCount: toInt(row["Количество доставок"]),
      returnsCount: toInt(row["Количество возврата"]),

      logisticsCost: firstNumber(row["Услуги по доставке товара покупателю"]),
      storageCost: firstNumber(row["Хранение"]),
      acceptanceCost:
        firstNumber(row["Платная приемка"]) ?? firstNumber(row["Операции на приемке"]),
      deductions: firstNumber(row["Удержания"]),
      penaltiesAmount: firstNumber(row["Общая сумма штрафов"]),

      paymentServiceCost: firstNumber(
        row["Компенсация платёжных услуг/Комиссия за интеграцию платёжных сервисов"],
        row["Компенсация платежных услуг/Комиссия за интеграцию платежных сервисов"]
      ),

      pvzCompensation: firstNumber(row["Возмещение за выдачу и возврат товаров на ПВЗ"]),
      transportCompensation: firstNumber(
        row["Возмещение издержек по перевозке/по складским операциям с товаром"],
        row["Возмещение издержек по перевозке"]
      ),
      wbRewardCorrection: firstNumber(
        row["Корректировка Вознаграждения Вайлдберриз (ВВ)"],
        row["Корректировка вознаграждения Вайлдберриз"]
      ),

      loyaltyDiscountCompensation: firstNumber(
        row["Компенсация скидки по программе лояльности"]
      ),
      loyaltyParticipationCost: firstNumber(
        row["Стоимость участия в программе лояльности"]
      ),
      loyaltyPointsAmount: firstNumber(
        row["Сумма баллов, удержанных по программе лояльности"]
      ),
    };
  });

  const filteredData = data.filter(
    (row) => row.vendorCode || row.barcode || row.nmId || row.paymentReason
  );

  if (filteredData.length === 0) {
    return { savedRows: 0 };
  }

  const reportNumbers = Array.from(
    new Set(
      filteredData
        .map((row) => String(row.reportNumber ?? "").trim())
        .filter(Boolean)
    )
  );

  if (reportNumbers.length > 0) {
    await prisma.wbSale.deleteMany({
      where: {
        companyName,
        reportNumber: {
          in: reportNumbers,
        },
      },
    });
  } else {
    await prisma.wbSale.deleteMany({
      where: {
        importSessionId,
        companyName,
      },
    });
  }

  await prisma.wbSale.createMany({
    data: filteredData,
  });

  return {
    savedRows: filteredData.length,
  };
}
