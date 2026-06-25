import { NextResponse } from "next/server";
import ExcelJS from "exceljs";

import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const MAX_TEMPLATE_ROWS = 500;

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

export async function GET() {
  const companies = await prisma.company.findMany({
    where: {
      isActive: true,
    },
    orderBy: {
      name: "asc",
    },
    select: {
      name: true,
    },
  });

  const companyNames = uniqueValues(companies.map((company) => company.name));
  const safeCompanyNames =
    companyNames.length > 0 ? companyNames : ["ИП Петров", "ИП Лебедева"];

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Marketplace Business OS";
  workbook.created = new Date();

  const stockSheet = workbook.addWorksheet("Собственный_склад", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  const guideSheet = workbook.addWorksheet("Инструкция", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  const listsSheet = workbook.addWorksheet("Списки");

  stockSheet.columns = [
    { header: "Компания", key: "companyName", width: 18 },
    { header: "Артикул", key: "vendorCode", width: 24 },
    { header: "SKU Ozon", key: "sku", width: 18 },
    { header: "Название товара", key: "productName", width: 34 },
    { header: "Цвет", key: "color", width: 16 },
    { header: "Размер", key: "size", width: 14 },
    { header: "Штрихкод", key: "barcode", width: 20 },
    { header: "Количество на складе, шт", key: "warehouseQty", width: 22 },
    { header: "Резерв, шт", key: "reservedQty", width: 14 },
    { header: "Доступно к поставке, шт", key: "availableForSupplyQty", width: 22 },
    { header: "Себестоимость", key: "costPrice", width: 16 },
    { header: "Дата инвентаризации", key: "inventoryDate", width: 20 },
    { header: "Комментарий", key: "comment", width: 34 },
  ];

  applyHeaderStyle(stockSheet.getRow(1));
  stockSheet.getRow(1).height = 38;

  stockSheet.addRows([
    [
      safeCompanyNames[0],
      "914803449-140",
      "3750656598",
      "Костюм спортивный MODNYVIKI",
      "Серый",
      "140",
      "",
      20,
      2,
      { formula: "MAX(0,H2-I2)" },
      850,
      "23.06.2026",
      "Пример строки собственного склада. Замените на свои данные.",
    ],
    [
      safeCompanyNames[0],
      "914803449-146",
      "3750656601",
      "Костюм спортивный MODNYVIKI",
      "Серый",
      "146",
      "",
      15,
      0,
      { formula: "MAX(0,H3-I3)" },
      850,
      "23.06.2026",
      "",
    ],
  ]);

  for (let rowNumber = 2; rowNumber <= MAX_TEMPLATE_ROWS; rowNumber++) {
    const row = stockSheet.getRow(rowNumber);

    row.eachCell({ includeEmpty: true }, (cell) => {
      applyBodyCellStyle(cell);
    });

    row.getCell(8).numFmt = "0";
    row.getCell(9).numFmt = "0";
    row.getCell(10).numFmt = "0";
    row.getCell(11).numFmt = "#,##0 ₽";
    row.getCell(12).numFmt = "dd.mm.yyyy";

    if (rowNumber > 3) {
      row.getCell(10).value = {
        formula: `MAX(0,H${rowNumber}-I${rowNumber})`,
      };
    }
  }

  stockSheet.autoFilter = {
    from: "A1",
    to: "M1",
  };

  listsSheet.columns = [
    { header: "Компании", key: "companies", width: 28 },
  ];

  applyHeaderStyle(listsSheet.getRow(1), "111827");

  for (const companyName of safeCompanyNames) {
    listsSheet.addRow([companyName]);
  }

  setSimpleListValidation({
    sheet: stockSheet,
    columnLetter: "A",
    sourceRangeFormula: `'${listsSheet.name}'!$A$2:$A$${safeCompanyNames.length + 1}`,
    errorTitle: "Компания не найдена",
    error: "Выберите компанию из выпадающего списка.",
  });

  guideSheet.columns = [
    { header: "Поле", key: "field", width: 28 },
    { header: "Как заполнять", key: "description", width: 96 },
    { header: "Обязательно", key: "required", width: 16 },
  ];

  applyHeaderStyle(guideSheet.getRow(1), "111827");

  guideSheet.addRows([
    [
      "Компания",
      "Выберите компанию из списка. Выберите компанию из списка. Этот шаблон используется как общий собственный склад для планирования поставок на WB и Ozon.",
      "Да",
    ],
    [
      "Артикул",
      "Артикул продавца / поставщика. Это главный ключ для связи собственного склада с товарами WB и Ozon.",
      "Да",
    ],
    [
      "SKU Ozon",
      "Числовой SKU Ozon. Поле желательно для сверки с Ozon, но для WB-планирования не обязательно.",
      "Нет",
    ],
    ["Название товара", "Название для удобства проверки и поиска на странице остатков.", "Нет"],
    ["Цвет", "Цвет товара, если удобно вести учёт по цвету.", "Нет"],
    ["Размер", "Размер товара, если удобно вести учёт по размеру.", "Нет"],
    ["Штрихкод", "Баркод/штрихкод товара, если есть. Для WB это поможет точнее сопоставлять размер и карточку.", "Нет"],
    [
      "Количество на складе, шт",
      "Фактический остаток на вашем складе на дату инвентаризации.",
      "Да",
    ],
    [
      "Резерв, шт",
      "Количество, которое уже отложено под другие поставки/заказы. Если резерва нет — укажите 0 или оставьте пустым.",
      "Нет",
    ],
    [
      "Доступно к поставке, шт",
      "Считается автоматически: Количество на складе минус Резерв. Система при импорте также пересчитает это значение сама.",
      "Нет",
    ],
    ["Себестоимость", "Себестоимость единицы товара для будущей финансовой аналитики.", "Нет"],
    [
      "Дата инвентаризации",
      "Дата, на которую актуален остаток. Формат: ДД.ММ.ГГГГ.",
      "Нет",
    ],
    ["Комментарий", "Любое пояснение.", "Нет"],
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
        'attachment; filename="own_warehouse_stock_template.xlsx"',
      "Cache-Control": "no-store",
    },
  });
}
