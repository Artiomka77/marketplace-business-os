import ExcelJS from "exceljs";

const BLANK_ROWS = 40;

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

/**
 * Safe PRODUCT_COST download template.
 * Import sheet headers must stay exact for reportDetector.
 */
export async function buildProductCostTemplateWorkbook(): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AvoroFin";
  workbook.created = new Date();

  const costSheet = workbook.addWorksheet("Себестоимость", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  const guideSheet = workbook.addWorksheet("Инструкция", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  const mappingSheet = workbook.addWorksheet("Сопоставление", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  costSheet.columns = [
    { header: "Артикул продавца", key: "vendorCode", width: 28 },
    { header: "Себестоимость", key: "cost", width: 18 },
  ];
  applyHeaderStyle(costSheet.getRow(1));
  costSheet.getRow(1).height = 28;

  for (let rowNumber = 2; rowNumber <= BLANK_ROWS + 1; rowNumber++) {
    const row = costSheet.getRow(rowNumber);
    const articleCell = row.getCell(1);
    const costCell = row.getCell(2);

    articleCell.value = "";
    costCell.value = null;

    applyBodyCellStyle(articleCell);
    applyBodyCellStyle(costCell);

    articleCell.numFmt = "@";
    costCell.numFmt = '#,##0.00 "₽"';
  }

  costSheet.autoFilter = {
    from: "A1",
    to: "B1",
  };

  guideSheet.columns = [
    { header: "Тема", key: "topic", width: 28 },
    { header: "Пояснение", key: "text", width: 96 },
  ];
  applyHeaderStyle(guideSheet.getRow(1), "111827");

  guideSheet.addRows([
    [
      "Артикул продавца",
      "Канонический артикул/key, по которому AvoroFin хранит ProductCost.",
    ],
    [
      "Себестоимость",
      "Стоимость 1 единицы в рублях. ProductCost используется как статическая себестоимость.",
    ],
    ["Дата", "Не требуется."],
    [
      "Ozon offer",
      "Для формата <base WB nmId>-<size>, например 1840938386-146: base = 1840938386, size = 146.",
    ],
    [
      "Семейство размеров",
      "Если для семейства одна себестоимость по всем размерам, не нужно создавать размерные дубли, если current canonical resolver однозначно использует base key.",
    ],
    [
      "Сомнения по mapping",
      "Не угадывать. Используйте Telegram «Себестоимость» / exact mapping flow.",
    ],
    [
      "Загрузка",
      "Заполните только лист «Себестоимость», затем загрузите файл на /import?reportType=PRODUCT_COST.",
    ],
  ]);

  guideSheet.eachRow((row) => {
    row.eachCell({ includeEmpty: true }, (cell) => {
      applyBodyCellStyle(cell);
    });
  });

  mappingSheet.columns = [
    { header: "Артикул продавца Ozon", key: "ozonOffer", width: 26 },
    { header: "Артикул WB / nmId", key: "wbNmId", width: 20 },
    { header: "Размер", key: "size", width: 12 },
    { header: "Артикул продавца WB", key: "wbVendor", width: 24 },
    { header: "Себестоимость", key: "cost", width: 16 },
  ];
  applyHeaderStyle(mappingSheet.getRow(1), "0F766E");
  mappingSheet.getRow(1).height = 28;

  const noteRow = mappingSheet.getRow(2);
  noteRow.getCell(1).value =
    'Не импортируется автоматически. Для загрузки используйте лист "Себестоимость".';
  noteRow.getCell(1).font = { bold: true, color: { argb: "B45309" } };
  noteRow.getCell(1).alignment = { wrapText: true, vertical: "middle" };
  mappingSheet.mergeCells("A2:E2");
  noteRow.height = 36;

  for (let rowNumber = 3; rowNumber <= 12; rowNumber++) {
    const row = mappingSheet.getRow(rowNumber);
    for (let col = 1; col <= 5; col++) {
      const cell = row.getCell(col);
      cell.value = col === 5 ? null : "";
      applyBodyCellStyle(cell);
      if (col === 5) cell.numFmt = '#,##0.00 "₽"';
      if (col === 1 || col === 2 || col === 4) cell.numFmt = "@";
    }
  }

  mappingSheet.getCell("A3").value = "1840938386-146";
  mappingSheet.getCell("B3").value = "1840938386";
  mappingSheet.getCell("C3").value = "146";
  mappingSheet.getCell("D3").value = "пример";
  mappingSheet.getCell("E3").value = null;

  return workbook;
}

export async function buildProductCostTemplateBuffer(): Promise<Buffer> {
  const workbook = await buildProductCostTemplateWorkbook();
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
