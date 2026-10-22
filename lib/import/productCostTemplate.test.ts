import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as XLSX from "xlsx";

import { detectWorkbookReport } from "@/lib/import/reportDetector";
import {
  buildProductCostTemplateBuffer,
  buildProductCostTemplateWorkbook,
} from "@/lib/import/productCostTemplate";

async function main() {
  const workbook = await buildProductCostTemplateWorkbook();
  const sheetNames = workbook.worksheets.map((sheet) => sheet.name);

  assert.deepEqual(sheetNames, ["Себестоимость", "Инструкция", "Сопоставление"]);

  const costSheet = workbook.getWorksheet("Себестоимость");
  assert.ok(costSheet);
  assert.equal(costSheet.getCell("A1").value, "Артикул продавца");
  assert.equal(costSheet.getCell("B1").value, "Себестоимость");
  assert.ok(costSheet.views?.[0]?.state === "frozen");

  const guideSheet = workbook.getWorksheet("Инструкция");
  assert.ok(guideSheet);
  assert.equal(guideSheet.getCell("A1").value, "Тема");

  const mappingSheet = workbook.getWorksheet("Сопоставление");
  assert.ok(mappingSheet);
  assert.equal(mappingSheet.getCell("A1").value, "Артикул продавца Ozon");
  assert.match(
    String(mappingSheet.getCell("A2").value ?? ""),
    /Не импортируется автоматически/
  );

  const buffer = await buildProductCostTemplateBuffer();
  assert.ok(buffer.byteLength > 1000);

  const tmpPath = join(tmpdir(), `product_cost_template_selftest_${Date.now()}.xlsx`);
  writeFileSync(tmpPath, buffer);

  try {
    const xlsx = XLSX.read(readFileSync(tmpPath), { type: "buffer" });
    const detected = detectWorkbookReport(xlsx);
    assert.equal(detected.reportType, "PRODUCT_COST");
    assert.equal(detected.sheetName, "Себестоимость");
    assert.ok(detected.matchedColumns.includes("Артикул продавца"));
    assert.ok(detected.matchedColumns.includes("Себестоимость"));
  } finally {
    unlinkSync(tmpPath);
  }

  console.log("PRODUCT_COST_TEMPLATE_TEST_OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
