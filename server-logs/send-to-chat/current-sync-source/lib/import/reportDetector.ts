import * as XLSX from "xlsx";

export type ReportType =
  | "PRODUCT_COST"
  | "WB_FINANCE"
  | "WB_SALES"
  | "WB_ADS_FINANCE"
  | "WB_ADS_STATS"
  | "WB_STOCK"
  | "WB_SUPPLY_RECOMMENDATION"
  | "OZON_FINANCE"
  | "OZON_ADS"
  | "OZON_STOCK"
  | "OZON_PRODUCT"
  | "OZON_SUPPLY_RECOMMENDATION"
  | "OZON_WAREHOUSE_STOCK"
  | "FINANCE_TRANSACTIONS"
  | "FINANCE_CATEGORIES"
  | "LOANS"
  | "UNKNOWN";

export type DetectionResult = {
  reportType: ReportType;
  sheetName: string;
  headerRowIndex: number;
  matchedColumns: string[];
};

function normalize(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/\s+/g, " ")
    .trim();
}

function rowHas(row: unknown[], expected: string) {
  const target = normalize(expected);
  return row.some((cell) => normalize(cell) === target);
}

function rowHasAny(row: unknown[], expected: string[]) {
  return expected.some((column) => rowHas(row, column));
}

function rowHasTextIncludes(row: unknown[], expectedPart: string) {
  const target = normalize(expectedPart);
  return row.some((cell) => normalize(cell).includes(target));
}

function countMatches(row: unknown[], columns: string[]) {
  return columns.filter((column) => rowHas(row, column));
}

const reportSignatures: {
  type: ReportType;
  columns: string[];
}[] = [
  {
    type: "WB_SUPPLY_RECOMMENDATION",
    columns: [
      "Регион",
      "Склады в регионе",
      "Артикул продавца",
      "Размер",
      "Наименование товара",
      "Артикул WB",
      "Баркоды",
      "Рекомендация",
      "Рекомендуем отгрузить (хватит на 14 дней)",
    ],
  },
  {
    type: "OZON_SUPPLY_RECOMMENDATION",
    columns: [
      "SKU",
      "Артикул",
      "Название товара",
      "Рекомендация",
      "Кластер",
      "Схема продаж",
      "Дней без остатка за 28 дней",
      "Остаток FBO, шт",
      "Остаток FBS, шт",
      "Товары в пути на склад Ozon, шт",
      "Среднесуточные продажи, шт. за 28дн",
    ],
  },
  {
    type: "OZON_WAREHOUSE_STOCK",
    columns: [
      "Компания",
      "Артикул",
      "SKU Ozon",
      "Название товара",
      "Размер",
      "Штрихкод",
      "Количество на складе, шт",
      "Остаток на складе, шт",
      "Остаток, шт",
      "Резерв, шт",
      "Доступно к поставке, шт",
    ],
  },
  {
    type: "FINANCE_TRANSACTIONS",
    columns: [
      "Дата",
      "Дата платежа",
      "Дата обязательства",
      "Дата выполнения обязательства",
      "Компания",
      "Тип операции",
      "Статья",
      "Сумма",
      "Счет",
      "Счёт",
      "Счет/наличка",
      "Контрагент",
      "Кому платим",
      "Проект",
      "Комментарий",
      "Внутренний перевод",
    ],
  },
  {
    type: "FINANCE_CATEGORIES",
    columns: ["Итого к оплате, руб", "Банки"],
  },
  {
    type: "LOANS",
    columns: [
      "Наименование",
      "Сумма долга",
      "Ежемесячный платеж",
      "Всего тело кредита",
      "Всего % процентов",
      "Общая сумма",
    ],
  },
  {
    type: "PRODUCT_COST",
    columns: ["Артикул продавца", "Себестоимость"],
  },
  {
    type: "WB_FINANCE",
    columns: [
      "№ отчета",
      "Юридическое лицо",
      "Дата начала",
      "Дата конца",
      "Продажа",
      "К перечислению за товар",
      "Итого к оплате",
    ],
  },
  {
    type: "WB_SALES",
    columns: [
      "Номер поставки",
      "Предмет",
      "Код номенклатуры",
      "Артикул поставщика",
      "Баркод",
      "Тип документа",
      "Дата продажи",
      "К перечислению Продавцу за реализованный Товар",
    ],
  },
  {
    type: "WB_ADS_FINANCE",
    columns: [
      "ID кампании",
      "Кампания",
      "Раздел",
      "Дата списания",
      "Источник списания",
      "Сумма",
    ],
  },
  {
    type: "WB_ADS_STATS",
    columns: [
      "Раздел",
      "Тип Ставки",
      "ID",
      "Кампания",
      "Показы",
      "Клики",
      "CPC",
      "CPM",
      "CTR(%)",
      "Затраты",
    ],
  },
  {
    type: "WB_STOCK",
    columns: [
      "Бренд",
      "Предмет",
      "Артикул продавца",
      "Баркод",
      "Размер вещи",
      "В пути до получателей",
      "В пути возвраты на склад WB",
      "Всего находится на складах",
    ],
  },
  {
    type: "OZON_FINANCE",
    columns: [
      "Дата начисления",
      "Тип начисления",
      "SKU",
      "Артикул",
      "Название товара или услуги",
      "Количество",
      "Вознаграждение Ozon",
      "Итого, руб.",
    ],
  },
  {
    type: "OZON_ADS",
    columns: [
      "SKU",
      "Название товара",
      "Инструмент",
      "Место размещения",
      "ID кампании",
      "Расход, ₽",
      "ДРР, %",
      "Продажи, ₽",
      "Заказы, шт",
      "Показы",
      "Клики",
    ],
  },
  {
    type: "OZON_STOCK",
    columns: [
      "Артикул",
      "SKU",
      "Название товара",
      "Доступно к продаже",
      "Готовится к продаже",
    ],
  },
  {
    type: "OZON_PRODUCT",
    columns: ["Артикул", "Название товара", "SKU"],
  },
];

export function detectWorkbookReport(workbook: XLSX.WorkBook): DetectionResult {
  let bestResult: DetectionResult = {
    reportType: "UNKNOWN",
    sheetName: workbook.SheetNames[0] ?? "",
    headerRowIndex: 0,
    matchedColumns: [],
  };

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];

    if (normalize(sheetName).includes("товар-склад")) {
      return {
        reportType: "OZON_STOCK",
        sheetName,
        headerRowIndex: 0,
        matchedColumns: ["sheet: Товар-склад"],
      };
    }

    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: "",
      blankrows: true,
    });

    for (let rowIndex = 0; rowIndex < Math.min(matrix.length, 40); rowIndex++) {
      const row = matrix[rowIndex];


      if (
        rowHas(row, "Регион") &&
        rowHas(row, "Склады в регионе") &&
        rowHas(row, "Артикул продавца") &&
        rowHas(row, "Артикул WB") &&
        rowHas(row, "Баркоды") &&
        rowHas(row, "Рекомендация") &&
        rowHasTextIncludes(row, "Рекомендуем отгрузить")
      ) {
        return {
          reportType: "WB_SUPPLY_RECOMMENDATION",
          sheetName,
          headerRowIndex: rowIndex,
          matchedColumns: [
            "Регион",
            "Склады в регионе",
            "Артикул продавца",
            "Артикул WB",
            "Баркоды",
            "Рекомендация",
            "Рекомендуем отгрузить",
          ],
        };
      }

      if (
        rowHas(row, "SKU") &&
        rowHas(row, "Артикул") &&
        rowHas(row, "Кластер") &&
        rowHas(row, "Рекомендация") &&
        rowHasTextIncludes(row, "Рекомендуемая поставка")
      ) {
        return {
          reportType: "OZON_SUPPLY_RECOMMENDATION",
          sheetName,
          headerRowIndex: rowIndex,
          matchedColumns: [
            "SKU",
            "Артикул",
            "Кластер",
            "Рекомендация",
            "Рекомендуемая поставка",
          ],
        };
      }

      if (
        rowHas(row, "Компания") &&
        rowHas(row, "Артикул") &&
        rowHasAny(row, [
          "Количество на складе, шт",
          "Остаток на складе, шт",
          "Остаток, шт",
          "Остаток",
          "Количество",
        ])
      ) {
        return {
          reportType: "OZON_WAREHOUSE_STOCK",
          sheetName,
          headerRowIndex: rowIndex,
          matchedColumns: [
            "Компания",
            "Артикул",
            "Количество на складе / остаток",
          ],
        };
      }

      if (
        normalize(sheetName).includes("операции") &&
        rowHasAny(row, ["Дата", "Дата платежа"]) &&
        rowHas(row, "Статья") &&
        rowHas(row, "Сумма")
      ) {
        return {
          reportType: "FINANCE_TRANSACTIONS",
          sheetName,
          headerRowIndex: rowIndex,
          matchedColumns: ["sheet: Операции", "Дата", "Статья", "Сумма"],
        };
      }

      if (
        rowHasAny(row, ["Дата", "Дата платежа"]) &&
        rowHas(row, "Тип операции") &&
        rowHas(row, "Статья") &&
        rowHas(row, "Сумма")
      ) {
        return {
          reportType: "FINANCE_TRANSACTIONS",
          sheetName,
          headerRowIndex: rowIndex,
          matchedColumns: ["Дата", "Тип операции", "Статья", "Сумма"],
        };
      }

      if (
        normalize(sheetName).includes("справочник") &&
        rowHas(row, "Итого к оплате, руб")
      ) {
        return {
          reportType: "FINANCE_CATEGORIES",
          sheetName,
          headerRowIndex: rowIndex,
          matchedColumns: ["sheet: Справочник", "Итого к оплате, руб"],
        };
      }

      if (
        normalize(sheetName).includes("кредиты") &&
        rowHas(row, "Наименование") &&
        rowHas(row, "Сумма долга")
      ) {
        return {
          reportType: "LOANS",
          sheetName,
          headerRowIndex: rowIndex,
          matchedColumns: ["sheet: Кредиты", "Наименование", "Сумма долга"],
        };
      }

      if (normalize(sheetName).includes("начисления") && rowHas(row, "SKU")) {
        return {
          reportType: "OZON_FINANCE",
          sheetName,
          headerRowIndex: rowIndex,
          matchedColumns: ["sheet: Начисления", "SKU"],
        };
      }

      if (
        normalize(sheetName).includes("товар-склад") &&
        rowHas(row, "Артикул") &&
        rowHas(row, "SKU") &&
        rowHas(row, "Доступно к продаже")
      ) {
        return {
          reportType: "OZON_STOCK",
          sheetName,
          headerRowIndex: rowIndex,
          matchedColumns: [
            "sheet: Товар-склад",
            "Артикул",
            "SKU",
            "Доступно к продаже",
          ],
        };
      }

      if (
        normalize(sheetName).includes("товары") &&
        rowHas(row, "Артикул") &&
        rowHas(row, "Название товара") &&
        rowHas(row, "SKU")
      ) {
        return {
          reportType: "OZON_PRODUCT",
          sheetName,
          headerRowIndex: rowIndex,
          matchedColumns: ["sheet: Товары", "Артикул", "Название товара", "SKU"],
        };
      }

      for (const signature of reportSignatures) {
        const matchedColumns = countMatches(row, signature.columns);

        if (matchedColumns.length > bestResult.matchedColumns.length) {
          bestResult = {
            reportType: signature.type,
            sheetName,
            headerRowIndex: rowIndex,
            matchedColumns,
          };
        }
      }
    }
  }

  if (
    bestResult.reportType === "PRODUCT_COST" ||
    bestResult.reportType === "FINANCE_TRANSACTIONS" ||
    bestResult.reportType === "FINANCE_CATEGORIES" ||
    bestResult.reportType === "LOANS" ||
    bestResult.reportType === "WB_SUPPLY_RECOMMENDATION" ||
    bestResult.reportType === "OZON_SUPPLY_RECOMMENDATION" ||
    bestResult.reportType === "OZON_WAREHOUSE_STOCK"
  ) {
    return bestResult;
  }

  if (bestResult.matchedColumns.length < 3) {
    return {
      ...bestResult,
      reportType: "UNKNOWN",
    };
  }

  return bestResult;
}
