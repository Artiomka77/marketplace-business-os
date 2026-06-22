import { NextResponse } from "next/server";
import ExcelJS from "exceljs";

import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const MAX_TEMPLATE_ROWS = 500;

function toSafeSheetName(value: string) {
  return value.replace(/[\[\]\*\/\\\?\:]/g, "").slice(0, 31) || "Лист";
}

function uniqueValues(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    )
  );
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

function setListValidation(params: {
  sheet: ExcelJS.Worksheet;
  columnLetter: string;
  listSheetName: string;
  listColumnLetter: string;
  startRow: number;
  endRow: number;
  errorTitle: string;
  error: string;
}) {
  const {
    sheet,
    columnLetter,
    listSheetName,
    listColumnLetter,
    startRow,
    endRow,
    errorTitle,
    error,
  } = params;

  for (let row = 2; row <= MAX_TEMPLATE_ROWS; row++) {
    const cell = sheet.getCell(`${columnLetter}${row}`);

    cell.dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [
        `'${listSheetName}'!$${listColumnLetter}$${startRow}:$${listColumnLetter}$${endRow}`,
      ],
      showErrorMessage: true,
      errorStyle: "warning",
      errorTitle,
      error,
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
        parentName: true,
        categoryType: true,
        profitTreatment: true,
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
  const categoryNames = uniqueValues(categories.map((category) => category.name));
  const accountNames = uniqueValues(accounts.map((account) => account.name));

  const safeCompanyNames =
    companyNames.length > 0 ? companyNames : ["ИП Петров", "ИП Лебедева"];

  const safeCategoryNames =
    categoryNames.length > 0
      ? categoryNames
      : [
          "Оплата тела кредита",
          "Проценты по кредиту",
          "Фулфилмент",
          "Закуп",
          "Вывод собственника",
          "Перевод между счетами",
          "Без статьи",
        ];

  const safeAccountNames =
    accountNames.length > 0
      ? accountNames
      : ["Сбербанк карта", "Расчетный счет", "Наличные", "Касса"];

  const operationTypes = [
    "Поступление",
    "Расход",
    "Перевод",
    "Финансирование",
    "Вывод собственника",
  ];

  const yesNoValues = ["Да", "Нет"];

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Marketplace Business OS";
  workbook.created = new Date();

  const operationsSheet = workbook.addWorksheet("Операции", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  const guideSheet = workbook.addWorksheet("Справочник", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  const listsSheetName = toSafeSheetName("Списки");
  const listsSheet = workbook.addWorksheet(listsSheetName);

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

  const exampleRows = [
    [
      "22.06.2026",
      "22.06.2026",
      safeCompanyNames[0],
      "Расход",
      safeCategoryNames.includes("Оплата тела кредита")
        ? "Оплата тела кредита"
        : safeCategoryNames[0],
      "",
      safeAccountNames[0],
      17792,
      "Банк",
      "Кредиты",
      "Платёж по кредиту",
      "Нет",
    ],
    [
      "22.06.2026",
      "22.06.2026",
      safeCompanyNames[0],
      "Расход",
      safeCategoryNames.includes("Фулфилмент")
        ? "Фулфилмент"
        : safeCategoryNames[0],
      "",
      safeAccountNames[0],
      12500,
      "Поставщик",
      "WB/Ozon",
      "Упаковка и обработка",
      "Нет",
    ],
    [
      "22.06.2026",
      "22.06.2026",
      safeCompanyNames[1] ?? safeCompanyNames[0],
      "Поступление",
      safeCategoryNames.includes("Внесение собственника")
        ? "Внесение собственника"
        : safeCategoryNames[0],
      "",
      safeAccountNames[0],
      50000,
      "Собственник",
      "Оборотка",
      "Пополнение оборотных средств",
      "Нет",
    ],
  ];

  operationsSheet.addRows(exampleRows);

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
    { header: "Статьи", key: "categories", width: 42 },
    { header: "Счета", key: "accounts", width: 28 },
    { header: "Внутренний перевод", key: "yesNo", width: 22 },
  ];

  applyHeaderStyle(listsSheet.getRow(1), "111827");

  const listsRowsCount = Math.max(
    safeCompanyNames.length,
    operationTypes.length,
    safeCategoryNames.length,
    safeAccountNames.length,
    yesNoValues.length
  );

  for (let index = 0; index < listsRowsCount; index++) {
    listsSheet.addRow([
      safeCompanyNames[index] ?? "",
      operationTypes[index] ?? "",
      safeCategoryNames[index] ?? "",
      safeAccountNames[index] ?? "",
      yesNoValues[index] ?? "",
    ]);
  }

  listsSheet.getColumn(3).eachCell((cell) => {
    cell.alignment = {
      vertical: "middle",
      wrapText: true,
    };
  });

  const companyEndRow = safeCompanyNames.length + 1;
  const operationTypeEndRow = operationTypes.length + 1;
  const categoryEndRow = safeCategoryNames.length + 1;
  const accountEndRow = safeAccountNames.length + 1;
  const yesNoEndRow = yesNoValues.length + 1;

  setListValidation({
    sheet: operationsSheet,
    columnLetter: "C",
    listSheetName: listsSheetName,
    listColumnLetter: "A",
    startRow: 2,
    endRow: companyEndRow,
    errorTitle: "Компания не найдена",
    error: "Выберите компанию из выпадающего списка.",
  });

  setListValidation({
    sheet: operationsSheet,
    columnLetter: "D",
    listSheetName: listsSheetName,
    listColumnLetter: "B",
    startRow: 2,
    endRow: operationTypeEndRow,
    errorTitle: "Тип операции не найден",
    error: "Выберите тип операции из выпадающего списка.",
  });

  setListValidation({
    sheet: operationsSheet,
    columnLetter: "E",
    listSheetName: listsSheetName,
    listColumnLetter: "C",
    startRow: 2,
    endRow: categoryEndRow,
    errorTitle: "Статья не найдена",
    error:
      "Выберите статью из выпадающего списка. Список берётся из справочника статей проекта.",
  });

  setListValidation({
    sheet: operationsSheet,
    columnLetter: "G",
    listSheetName: listsSheetName,
    listColumnLetter: "D",
    startRow: 2,
    endRow: accountEndRow,
    errorTitle: "Счёт не найден",
    error: "Выберите счёт из списка или введите новый вручную.",
  });

  setListValidation({
    sheet: operationsSheet,
    columnLetter: "L",
    listSheetName: listsSheetName,
    listColumnLetter: "E",
    startRow: 2,
    endRow: yesNoEndRow,
    errorTitle: "Некорректное значение",
    error: "Укажите Да или Нет.",
  });

  guideSheet.columns = [
    { header: "Поле", key: "field", width: 24 },
    { header: "Как заполнять", key: "description", width: 86 },
    { header: "Обязательно", key: "required", width: 16 },
  ];

  applyHeaderStyle(guideSheet.getRow(1), "111827");

  guideSheet.addRows([
    [
      "Дата",
      "Дата фактической оплаты или поступления. Формат: ДД.ММ.ГГГГ.",
      "Да",
    ],
    ["Дата обязательства", "Дата, к которой относится обязательство. Можно оставить пустой.", "Нет"],
    [
      "Компания",
      "Выберите из выпадающего списка. Если пусто, используется компания, выбранная на странице импорта.",
      "Нет",
    ],
    [
      "Тип операции",
      "Выберите из списка: Поступление, Расход, Перевод, Финансирование, Вывод собственника.",
      "Да",
    ],
    [
      "Статья",
      "Выберите статью из выпадающего списка. Список автоматически берётся из справочника статей проекта.",
      "Да",
    ],
    ["Подстатья", "Дополнительная детализация статьи.", "Нет"],
    ["Счет", "Выберите счёт/кассу из списка или впишите вручную.", "Нет"],
    ["Сумма", "Положительное число. Знак минус ставить не нужно.", "Да"],
    ["Контрагент", "Кому платим или от кого поступили деньги.", "Нет"],
    ["Проект", "Проект, маркетплейс или направление.", "Нет"],
    ["Комментарий", "Любое пояснение к операции.", "Нет"],
    ["Внутренний перевод", "Да или Нет. Для переводов между своими счетами укажите Да.", "Нет"],
  ]);

  guideSheet.eachRow((row) => {
    row.eachCell({ includeEmpty: true }, (cell) => {
      applyBodyCellStyle(cell);
    });
  });

  // Лист оставляем видимым, чтобы собственник мог посмотреть полный список статей.
  // Если нужно скрыть технический лист, можно заменить на: listsSheet.state = "veryHidden";

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
