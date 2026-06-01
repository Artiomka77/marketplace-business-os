import * as XLSX from "xlsx";

export type ReportType =
  | "PRODUCT_COST"
  | "WB_FINANCE"
  | "WB_SALES"
  | "WB_ADS_FINANCE"
  | "WB_ADS_STATS"
  | "WB_STOCK"
  | "OZON_FINANCE"
  | "OZON_ADS"
  | "OZON_STOCK"
  | "OZON_PRODUCT"
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

function countMatches(row: unknown[], columns: string[]) {
  return columns.filter((column) => rowHas(row, column));
}

const reportSignatures: {
  type: ReportType;
  columns: string[];
}[] = [
  {
    type: "FINANCE_TRANSACTIONS",
    columns: [
      "Дата платежа",
      "Дата выполнения обязательства",
      "Статья",
      "Сумма",
      "Счет/наличка",
      "Кому платим",
      "За что платим",
      "Комментарий",
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
    columns: ["Артикул", "SKU", "Название товара", "Доступно к продаже"],
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

    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: "",
      blankrows: false,
    });

    for (let rowIndex = 0; rowIndex < Math.min(matrix.length, 40); rowIndex++) {
      const row = matrix[rowIndex];

      if (
        normalize(sheetName).includes("операции") &&
        rowHas(row, "Дата платежа") &&
        rowHas(row, "Статья") &&
        rowHas(row, "Сумма")
      ) {
        return {
          reportType: "FINANCE_TRANSACTIONS",
          sheetName,
          headerRowIndex: rowIndex,
          matchedColumns: ["sheet: Операции", "Дата платежа", "Статья", "Сумма"],
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
    bestResult.reportType === "LOANS"
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