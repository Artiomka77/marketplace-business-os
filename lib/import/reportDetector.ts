import * as XLSX from "xlsx";

export type ReportType =
  | "WB_FINANCE"
  | "WB_SALES"
  | "WB_ADS_FINANCE"
  | "WB_ADS_STATS"
  | "WB_STOCK"
  | "OZON_FINANCE"
  | "OZON_ADS"
  | "OZON_STOCK"
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
    ],
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
  normalize(sheetName).includes("начисления") &&
  rowHas(row, "SKU")
) {
  return {
    reportType: "OZON_FINANCE",
    sheetName,
    headerRowIndex: rowIndex,
    matchedColumns: ["sheet: Начисления", "SKU"],
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

  if (bestResult.matchedColumns.length < 3) {
    return {
      ...bestResult,
      reportType: "UNKNOWN",
    };
  }

  return bestResult;
}