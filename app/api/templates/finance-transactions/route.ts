import { NextResponse } from "next/server";
import ExcelJS from "exceljs";

import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const MAX_TEMPLATE_ROWS = 500;

const OPERATION_TYPES = [
  "Поступление",
  "Расход",
  "Перевод",
  "Финансирование",
  "Вывод собственника",
];

const CATEGORY_TYPE_TO_OPERATION_TYPE: Record<string, string> = {
  INCOME: "Поступление",
  EXPENSE: "Расход",
  TRANSFER: "Перевод",
  FINANCING: "Финансирование",
  PERSONAL: "Вывод собственника",
};

function uniqueValues(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    )
  );
}

function normalizeCategoryType(value: unknown) {
  return String(value ?? "")
    .toUpperCase()
    .trim();
}

function applyHeaderStyle(row: ExcelJS.Row, fillColor = "4F46E5") {
  row.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: fillColor },
    };
    cell.font = {
      bold: true,
      color: { argb: "FFFFFF" },
    };
    cell.alignment = {
      vertical: "middle",
      horizontal: "center",
      wrapText: true,
    };
    cell.border = {
      top: { style: "thin", color: { argb: "CBD5E1" } },
      left: { style: "thin", color: { argb: "CBD5E1" } },
      bottom: { style: "thin", color: { argb: "CBD5E1" } },
      right: { style: "thin", color: { argb: "CBD5E1" } },
    };
  });
}

function applyBodyCellStyle(cell: ExcelJS.Cell) {
  cell.alignment = {
    vertical: "middle",
    wrapText: true,
  };

  cell.border = {
    top: { style: "thin", color: { argb: "E2E8F0" } },
    left: { style: "thin", color: { argb: "E2E8F0" } },
    bottom: { style: "thin", color: { argb: "E2E8F0" } },
    right: { style: "thin", color: { argb: "E2E8F0" } },
  };
}

function setSimpleListValidation(params: {
  sheet: ExcelJS.Worksheet;
  columnLetter: string;
  sourceRangeFormula: string;
  errorTitle: string;
  error: string;
}) {
  const { sheet, columnLetter, sourceRangeFormula, errorTitle, error } = params;

  for (let row = 2; row <= MAX_TEMPLATE_ROWS; row++) {
    const cell = sheet.getCell(`${columnLetter}${row}`);

    cell.dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [sourceRangeFormula],
      showErrorMessage: true,
      errorStyle: "warning",
      errorTitle,
      error,
    };
  }
}

function setDependentCategoryValidation(params: {
  sheet: ExcelJS.Worksheet;
  listsSheetName: string;
}) {
  const { sheet, listsSheetName } = params;

  for (let row = 2; row <= MAX_TEMPLATE_ROWS; row++) {
    const cell = sheet.getCell(`E${row}`);

    cell.dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [
        `OFFSET('${listsSheetName}'!$L$1,MATCH($D${row},'${listsSheetName}'!$K:$K,0)-1,0,COUNTIF('${listsSheetName}'!$K:$K,$D${row}),1)`,
      ],
      showErrorMessage: true,
      errorStyle: "warning",
      errorTitle: "Статья не подходит к типу операции",
      error:
        "Сначала выберите тип операции, затем выберите статью из соответствующего списка.",
    };
  }
}

export async function GET() {
  const [companies, categories, accounts] = await Promise.all([
    prisma.company.findMany({
      where: {
        isActive: true,
      },
      orderBy: {
        name: "asc",
      },
      select: {
        name: true,
      },
    }),
    prisma.financeCategory.findMany({
      where: {
        isActive: true,
      },
      orderBy: [
        { categoryType: "asc" },
        { sortOrder: "asc" },
        { name: "asc" },
      ],
      select: {
        name: true,
        categoryType: true,
      },
    }),
    prisma.financeAccount.findMany({
      where: {
        isActive: true,
      },
      orderBy: [
        {
          companyName: "asc",
        },
        {
          name: "asc",
        },
      ],
      select: {
        name: true,
        companyName: true,
      },
    }),
  ]);

  const companyNames = uniqueValues(companies.map((company) => company.name));
  const accountNames = uniqueValues(accounts.map((account) => account.name));

  const safeCompanyNames =
    companyNames.length > 0 ? companyNames : ["ИП Петров", "ИП Лебедева"];

  const safeAccountNames =
    accountNames.length > 0
      ? accountNames
      : ["Сбербанк карта", "Расчетный счет", "Наличные", "Касса"];

  const categoriesByOperationType = new Map<string, string[]>();

  for (const operationType of OPERATION_TYPES) {
    categoriesByOperationType.set(operationType, []);
  }

  for (const category of categories) {
    const categoryType = normalizeCategoryType(category.categoryType);
    const operationType = CATEGORY_TYPE_TO_OPERATION_TYPE[categoryType];

    if (!operationType) continue;

    categoriesByOperationType.get(operationType)?.push(category.name);
  }

  const fallbackCategories: Record<string, string[]> = {
    "Поступление": [
      "Поступления от продаж",
      "Внесение собственника",
      "Получение кредита",
    ],
    "Расход": [
      "Закуп",
      "Реклама",
      "Оплата фулфилменту",
      "Упаковка и расходные материалы",
    ],
    "Перевод": ["Перевод между счетами"],
    "Финансирование": ["Тело кредита", "Проценты по кредиту", "Получение кредита"],
    "Вывод собственника": ["Вывод собственника"],
  };

  for (const operationType of OPERATION_TYPES) {
    const current = categoriesByOperationType.get(operationType) ?? [];

    if (current.length === 0) {
      categoriesByOperationType.set(
        operationType,
        fallbackCategories[operationType] ?? ["Без статьи"]
      );
    }
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Marketplace Business OS";
  workbook.created = new Date();

  const operationsSheet = workbook.addWorksheet("Операции", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  const guideSheet = workbook.addWorksheet("Справочник", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  const listsSheet = workbook.addWorksheet("Списки");

  operationsSheet.columns = [
    { header: "Дата", key: "operationDate", width: 14 },
    { header: "Дата обязательства", key: "obligationDate", width: 18 },
    { header: "Компания", key: "companyName", width: 18 },
    { header: "Тип операции", key: "operationType", width: 22 },
    { header: "Статья", key: "category", width: 34 },
    { header: "Подстатья", key: "subcategory", width: 22 },
    { header: "Счет", key: "bankAccount", width: 22 },
    { header: "Сумма", key: "amount", width: 14 },
    { header: "Контрагент", key: "counterparty", width: 24 },
    { header: "Проект", key: "project", width: 22 },
    { header: "Комментарий", key: "comment", width: 38 },
    { header: "Внутренний перевод", key: "isInternalTransfer", width: 20 },
  ];

  applyHeaderStyle(operationsSheet.getRow(1));
  operationsSheet.getRow(1).height = 34;

  const firstExpenseCategory =
    categoriesByOperationType.get("Расход")?.[0] ?? "Закуп";
  const firstIncomeCategory =
    categoriesByOperationType.get("Поступление")?.[0] ?? "Поступления от продаж";
  const firstFinanceCategory =
    categoriesByOperationType.get("Финансирование")?.[0] ?? "Тело кредита";

  operationsSheet.addRows([
    [
      "22.06.2026",
      "22.06.2026",
      safeCompanyNames[0],
      "Расход",
      firstExpenseCategory,
      "",
      safeAccountNames[0],
      15000,
      "Поставщик",
      "Ozon",
      "Пример расходной операции",
      "Нет",
    ],
    [
      "15.06.2026",
      "15.06.2026",
      safeCompanyNames[0],
      "Поступление",
      firstIncomeCategory,
      "",
      safeAccountNames[0],
      50000,
      "Покупатели",
      "WB",
      "Пример поступления",
      "Нет",
    ],
    [
      "20.06.2026",
      "20.06.2026",
      safeCompanyNames[0],
      "Финансирование",
      firstFinanceCategory,
      "",
      safeAccountNames[0],
      17792,
      "Банк",
      "Кредиты",
      "Пример кредитной операции",
      "Нет",
    ],
  ]);

  for (let rowNumber = 2; rowNumber <= MAX_TEMPLATE_ROWS; rowNumber++) {
    const row = operationsSheet.getRow(rowNumber);

    row.eachCell({ includeEmpty: true }, (cell) => {
      applyBodyCellStyle(cell);
    });

    row.getCell(1).numFmt = "dd.mm.yyyy";
    row.getCell(2).numFmt = "dd.mm.yyyy";
    row.getCell(8).numFmt = '#,##0 ₽';
  }

  operationsSheet.autoFilter = {
    from: "A1",
    to: "L1",
  };

  listsSheet.columns = [
    { header: "Компании", key: "companies", width: 28 },
    { header: "Типы операций", key: "operationTypes", width: 28 },
    { header: "Счета", key: "accounts", width: 28 },
    { header: "Внутренний перевод", key: "yesNo", width: 22 },
    { header: "", key: "blank", width: 6 },
    { header: "", key: "blank2", width: 6 },
    { header: "", key: "blank3", width: 6 },
    { header: "", key: "blank4", width: 6 },
    { header: "", key: "blank5", width: 6 },
    { header: "", key: "blank6", width: 6 },
    { header: "Тип операции для статьи", key: "categoryType", width: 30 },
    { header: "Статья", key: "categoryName", width: 46 },
  ];

  applyHeaderStyle(listsSheet.getRow(1), "111827");

  const yesNoValues = ["Да", "Нет"];
  const mainRowsCount = Math.max(
    safeCompanyNames.length,
    OPERATION_TYPES.length,
    safeAccountNames.length,
    yesNoValues.length
  );

  for (let index = 0; index < mainRowsCount; index++) {
    listsSheet.addRow([
      safeCompanyNames[index] ?? "",
      OPERATION_TYPES[index] ?? "",
      safeAccountNames[index] ?? "",
      yesNoValues[index] ?? "",
    ]);
  }

  let categoryListRow = 2;

  for (const operationType of OPERATION_TYPES) {
    const categoryNames = categoriesByOperationType.get(operationType) ?? [];

    for (const categoryName of categoryNames) {
      listsSheet.getCell(`K${categoryListRow}`).value = operationType;
      listsSheet.getCell(`L${categoryListRow}`).value = categoryName;
      categoryListRow++;
    }
  }

  listsSheet.autoFilter = {
    from: "A1",
    to: "L1",
  };

  const listsSheetName = listsSheet.name;

  setSimpleListValidation({
    sheet: operationsSheet,
    columnLetter: "C",
    sourceRangeFormula: `'${listsSheetName}'!$A$2:$A$${safeCompanyNames.length + 1}`,
    errorTitle: "Компания не найдена",
    error: "Выберите компанию из выпадающего списка.",
  });

  setSimpleListValidation({
    sheet: operationsSheet,
    columnLetter: "D",
    sourceRangeFormula: `'${listsSheetName}'!$B$2:$B$${OPERATION_TYPES.length + 1}`,
    errorTitle: "Тип операции не найден",
    error: "Выберите тип операции из выпадающего списка.",
  });

  setDependentCategoryValidation({
    sheet: operationsSheet,
    listsSheetName,
  });

  setSimpleListValidation({
    sheet: operationsSheet,
    columnLetter: "G",
    sourceRangeFormula: `'${listsSheetName}'!$C$2:$C$${safeAccountNames.length + 1}`,
    errorTitle: "Счёт не найден",
    error: "Выберите счёт из списка или введите новый вручную.",
  });

  setSimpleListValidation({
    sheet: operationsSheet,
    columnLetter: "L",
    sourceRangeFormula: `'${listsSheetName}'!$D$2:$D$3`,
    errorTitle: "Некорректное значение",
    error: "Укажите Да или Нет.",
  });

  guideSheet.columns = [
    { header: "Поле", key: "field", width: 24 },
    { header: "Как заполнять", key: "description", width: 92 },
    { header: "Обязательно", key: "required", width: 16 },
  ];

  applyHeaderStyle(guideSheet.getRow(1), "111827");

  guideSheet.addRows([
    [
      "Дата",
      "Дата фактической оплаты или поступления. Формат: ДД.ММ.ГГГГ.",
      "Да",
    ],
    [
      "Дата обязательства",
      "Дата, к которой относится обязательство. Можно оставить пустой.",
      "Нет",
    ],
    [
      "Компания",
      "Выберите из выпадающего списка. Если пусто, используется компания, выбранная на странице импорта.",
      "Нет",
    ],
    [
      "Тип операции",
      "Сначала выберите тип операции. После этого в колонке “Статья” будут доступны только статьи этого типа.",
      "Да",
    ],
    [
      "Статья",
      "Выберите статью из выпадающего списка. Список фильтруется по выбранному типу операции.",
      "Да",
    ],
    ["Подстатья", "Дополнительная детализация статьи.", "Нет"],
    ["Счет", "Выберите счёт/кассу из списка или впишите вручную.", "Нет"],
    ["Сумма", "Положительное число. Знак минус ставить не нужно.", "Да"],
    ["Контрагент", "Кому платим или от кого поступили деньги.", "Нет"],
    ["Проект", "Проект, маркетплейс или направление.", "Нет"],
    ["Комментарий", "Любое пояснение к операции.", "Нет"],
    [
      "Внутренний перевод",
      "Да или Нет. Для переводов между своими счетами укажите Да.",
      "Нет",
    ],
  ]);

  guideSheet.eachRow((row) => {
    row.eachCell({ includeEmpty: true }, (cell) => {
      applyBodyCellStyle(cell);
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();

  return new NextResponse(Buffer.from(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition":
        'attachment; filename="finance_transactions_template.xlsx"',
      "Cache-Control": "no-store",
    },
  });
}
