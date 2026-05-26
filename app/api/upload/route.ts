import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { detectWorkbookReport } from "@/lib/import/reportDetector";
import { prisma } from "@/lib/prisma";
import { normalizeWbSales } from "@/lib/import/normalizers/wbSalesNormalizer";

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return NextResponse.json(
        { error: "Файл не найден" },
        { status: 400 }
      );
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const workbook = XLSX.read(buffer, {
      type: "buffer",
    });

    const detection = detectWorkbookReport(workbook);

    const worksheet = workbook.Sheets[detection.sheetName];

    const data = XLSX.utils.sheet_to_json(worksheet, {
      range: detection.headerRowIndex,
      defval: "",
    });

const marketplace =
  detection.reportType.startsWith("WB")
    ? "WILDBERRIES"
    : detection.reportType.startsWith("OZON")
    ? "OZON"
    : "UNKNOWN";

const importSession = await prisma.importSession.create({
  data: {
    fileName: file.name,
    reportType: detection.reportType,
    marketplace,
    rowsCount: data.length,
    previewJson: data.slice(0, 10),
    sheetName: detection.sheetName,
    headerRow: detection.headerRowIndex + 1,
    status: "SUCCESS",
  },
}); 
  let normalizedRows = 0;

if (detection.reportType === "WB_SALES") {
  const result = await normalizeWbSales(data, importSession.id);
  normalizedRows = result.savedRows;
}
return NextResponse.json({
      success: true,
      reportType: detection.reportType,
      sheet: detection.sheetName,
      headerRowIndex: detection.headerRowIndex + 1,
      matchedColumns: detection.matchedColumns,
      rows: data.length,
      normalizedRows,
      preview: data.slice(0, 5),
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      { error: "Ошибка загрузки файла" },
      { status: 500 }
    );
  }
}