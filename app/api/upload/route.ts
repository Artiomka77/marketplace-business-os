import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { inflateRawSync } from "zlib";
import * as XLSX from "xlsx";

import { detectWorkbookReport } from "@/lib/import/reportDetector";
import { prisma } from "@/lib/prisma";

import { normalizeWbSales } from "@/lib/import/normalizers/wbSalesNormalizer";
import { normalizeWbFinance } from "@/lib/import/normalizers/wbFinanceNormalizer";
import { normalizeWbAds } from "@/lib/import/normalizers/wbAdsNormalizer";
import { normalizeWbStock } from "@/lib/import/normalizers/wbStockNormalizer";
import { normalizeWbSupplyRecommendation } from "@/lib/import/normalizers/wbSupplyRecommendationNormalizer";
import { normalizeProductCost } from "@/lib/import/normalizers/productCostNormalizer";

import { normalizeOzonFinance } from "@/lib/import/normalizers/ozonFinanceNormalizer";
import { normalizeOzonAds } from "@/lib/import/normalizers/ozonAdsNormalizer";
import { normalizeOzonStock } from "@/lib/import/normalizers/ozonStockNormalizer";
import { normalizeOzonProduct } from "@/lib/import/normalizers/ozonProductNormalizer";
import { normalizeOzonSupplyRecommendation } from "@/lib/import/normalizers/ozonSupplyRecommendationNormalizer";
import { normalizeOzonWarehouseStock } from "@/lib/import/normalizers/ozonWarehouseStockNormalizer";
import { normalizeFinanceTransactions } from "@/lib/import/normalizers/financeTransactionNormalizer";


function findEndOfCentralDirectory(buffer: Buffer) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }

  return -1;
}

function extractFirstXlsxFromOuterZip(buffer: Buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);

  if (eocdOffset < 0) {
    return null;
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      break;
    }

    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer
      .subarray(offset + 46, offset + 46 + fileNameLength)
      .toString("utf8");

    offset += 46 + fileNameLength + extraLength + commentLength;

    if (!fileName.toLowerCase().endsWith(".xlsx")) {
      continue;
    }

    if (
      localHeaderOffset + 30 > buffer.length ||
      buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50
    ) {
      continue;
    }

    const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);

    if (compressionMethod === 0) {
      return compressed;
    }

    if (compressionMethod === 8) {
      return inflateRawSync(compressed);
    }

    throw new Error(`ZIP содержит .xlsx с неподдерживаемым методом сжатия: ${compressionMethod}`);
  }

  return null;
}

function prepareWorkbookBuffer(buffer: Buffer, fileName: string) {
  const lowerFileName = fileName.toLowerCase();

  if (!lowerFileName.endsWith(".zip")) {
    return buffer;
  }

  const extracted = extractFirstXlsxFromOuterZip(buffer);

  if (!extracted) {
    throw new Error("В ZIP-архиве не найден .xlsx-файл отчёта");
  }

  return Buffer.from(extracted);
}

function parseWbAdsPeriodFromFileName(fileName: string) {
  const matches = Array.from(fileName.matchAll(/(\d{4}-\d{2}-\d{2})T/g));

  if (matches.length < 2) {
    return {
      dateFrom: null,
      dateTo: null,
    };
  }

  const dateFrom = new Date(`${matches[0][1]}T00:00:00`);
  const dateTo = new Date(`${matches[1][1]}T00:00:00`);

  if (Number.isNaN(dateFrom.getTime()) || Number.isNaN(dateTo.getTime())) {
    return {
      dateFrom: null,
      dateTo: null,
    };
  }

  return {
    dateFrom,
    dateTo,
  };
}

function makeUtcNoonDate(day: number, month: number, year: number) {
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseRussianDateFromText(value: string): Date | null {
  const match = value.match(/(\d{2})[.\-_](\d{2})[.\-_](\d{4})/);

  if (!match) {
    return null;
  }

  const [, day, month, year] = match;

  return makeUtcNoonDate(Number(day), Number(month), Number(year));
}

function parseOzonAdsReportDateFromWorksheet(
  worksheet: XLSX.WorkSheet
): Date | null {
  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    defval: "",
    blankrows: false,
  });

  for (const row of rawRows.slice(0, 30)) {
    const text = row
      .map((cell) => String(cell ?? "").trim())
      .filter(Boolean)
      .join(" ");

    const lowerText = text.toLowerCase();

    if (!lowerText.includes("период")) {
      continue;
    }

    const date = parseRussianDateFromText(text);

    if (date) {
      return date;
    }
  }

  return null;
}

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const companyName =
      String(formData.get("companyName") ?? "").trim() || null;

    if (!file) {
      return NextResponse.json({ error: "Файл не найден" }, { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const workbookBuffer = prepareWorkbookBuffer(buffer, file.name);

    const workbook = XLSX.read(workbookBuffer, {
      type: "buffer",
      cellDates: false,
    });

    const detection = detectWorkbookReport(workbook);

    if (detection.reportType === "UNKNOWN") {
      return NextResponse.json(
        {
          success: false,
          error: "Не удалось определить тип отчета",
          fileName: file.name,
          reportType: detection.reportType,
          sheet: detection.sheetName,
          headerRowIndex: detection.headerRowIndex + 1,
          matchedColumns: detection.matchedColumns,
        },
        { status: 400 }
      );
    }

    const worksheet = workbook.Sheets[detection.sheetName];

    if (!worksheet) {
      return NextResponse.json(
        { error: "Лист отчета не найден" },
        { status: 400 }
      );
    }

    const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
      range: detection.headerRowIndex,
      defval: "",
    });

    const marketplace = detection.reportType.startsWith("WB")
      ? "WILDBERRIES"
      : detection.reportType.startsWith("OZON")
        ? "OZON"
        : detection.reportType === "PRODUCT_COST"
          ? "INTERNAL"
          : detection.reportType === "FINANCE_TRANSACTIONS"
            ? "FINANCE"
            : detection.reportType === "FINANCE_CATEGORIES"
              ? "FINANCE"
              : detection.reportType === "LOANS"
                ? "FINANCE"
                : "UNKNOWN";

    const needsCompanyName =
      detection.reportType.startsWith("WB") ||
      detection.reportType.startsWith("OZON") ||
      detection.reportType === "FINANCE_TRANSACTIONS";

    if (needsCompanyName && !companyName) {
      return NextResponse.json(
        {
          success: false,
          error: "Выберите компанию перед загрузкой этого отчета",
          reportType: detection.reportType,
        },
        { status: 400 }
      );
    }

    const importSession = await prisma.importSession.create({
      data: {
        fileName: file.name,
        reportType: detection.reportType,
        marketplace,
        companyName,
        rowsCount: data.length,
        previewJson: data.slice(0, 10) as Prisma.InputJsonValue[],
        sheetName: detection.sheetName,
        headerRow: detection.headerRowIndex + 1,
        status: "SUCCESS",
      },
    });

    let normalizedRows = 0;
    let skippedRows = 0;

    if (detection.reportType === "WB_SALES") {
      const result = await normalizeWbSales(data, importSession.id, companyName);
      normalizedRows = result.savedRows;
    }

    if (detection.reportType === "WB_FINANCE") {
      const result = await normalizeWbFinance(
        data,
        importSession.id,
        companyName
      );
      normalizedRows = result.savedRows;
    }

    if (
      detection.reportType === "WB_ADS_STATS" ||
      detection.reportType === "WB_ADS_FINANCE"
    ) {
      const adsPeriod = parseWbAdsPeriodFromFileName(file.name);

      const result = await normalizeWbAds(
        data,
        importSession.id,
        adsPeriod.dateFrom,
        adsPeriod.dateTo,
        companyName
      );

      normalizedRows = result.savedRows;
    }

    if (detection.reportType === "WB_STOCK") {
      const result = await normalizeWbStock(data, importSession.id, companyName);
      normalizedRows = result.savedRows;
    }


    if (detection.reportType === "WB_SUPPLY_RECOMMENDATION") {
      const result = await normalizeWbSupplyRecommendation(
        data,
        importSession.id,
        companyName
      );
      normalizedRows = result.savedRows;

      if (normalizedRows === 0) {
        await prisma.importSession.update({
          where: {
            id: importSession.id,
          },
          data: {
            status: "ERROR",
          },
        });

        return NextResponse.json(
          {
            success: false,
            error:
              "Файл распознан как Wildberries — Рекомендации по поставке, но не удалось сохранить строки. Проверьте заголовки: Регион, Артикул продавца, Артикул WB, Рекомендация, Рекомендуем отгрузить.",
            reportType: detection.reportType,
            marketplace,
            companyName,
            sheet: detection.sheetName,
            headerRowIndex: detection.headerRowIndex + 1,
            matchedColumns: detection.matchedColumns,
            rows: data.length,
            normalizedRows,
            preview: data.slice(0, 5),
          },
          { status: 422 }
        );
      }
    }

    if (detection.reportType === "OZON_FINANCE") {
      const result = await normalizeOzonFinance(
        data,
        importSession.id,
        companyName
      );
      normalizedRows = result.savedRows;
    }

    if (detection.reportType === "OZON_ADS") {
      const ozonAdsReportDate = parseOzonAdsReportDateFromWorksheet(worksheet);

      const result = await normalizeOzonAds(
        data,
        importSession.id,
        file.name,
        companyName,
        ozonAdsReportDate
      );

      normalizedRows = result.savedRows;
    }

    if (detection.reportType === "OZON_STOCK") {
      const result = await normalizeOzonStock(
        data,
        importSession.id,
        companyName
      );
      normalizedRows = result.savedRows;
    }

    if (detection.reportType === "OZON_PRODUCT") {
      const result = await normalizeOzonProduct(
        data,
        importSession.id,
        companyName
      );
      normalizedRows = result.savedRows;
    }

    if (detection.reportType === "OZON_SUPPLY_RECOMMENDATION") {
      const result = await normalizeOzonSupplyRecommendation(
        data,
        importSession.id,
        companyName
      );
      normalizedRows = result.savedRows;

      if (normalizedRows === 0) {
        await prisma.importSession.update({
          where: {
            id: importSession.id,
          },
          data: {
            status: "ERROR",
          },
        });

        return NextResponse.json(
          {
            success: false,
            error:
              "Файл распознан как Ozon — Планирование поставок, но не удалось сохранить строки. Проверьте заголовки: SKU, Артикул, Кластер, Рекомендуемая поставка.",
            reportType: detection.reportType,
            marketplace,
            companyName,
            sheet: detection.sheetName,
            headerRowIndex: detection.headerRowIndex + 1,
            matchedColumns: detection.matchedColumns,
            rows: data.length,
            normalizedRows,
            preview: data.slice(0, 5),
          },
          { status: 422 }
        );
      }
    }

    if (detection.reportType === "OZON_WAREHOUSE_STOCK") {
      const result = await normalizeOzonWarehouseStock(
        data,
        importSession.id,
        companyName ?? "ИП Петров"
      );
      normalizedRows = result.savedRows;
    }

    if (detection.reportType === "FINANCE_TRANSACTIONS") {
      const result = await normalizeFinanceTransactions(
        data,
        importSession.id,
        companyName ?? "ИП Петров"
      );

      normalizedRows = result.savedRows;
    }

    if (detection.reportType === "PRODUCT_COST") {
      const result = await normalizeProductCost(data, importSession.id);
      normalizedRows = result.savedRows;
      skippedRows = result.skippedRows;
    }

    return NextResponse.json({
      success: true,
      reportType: detection.reportType,
      marketplace,
      companyName,
      sheet: detection.sheetName,
      headerRowIndex: detection.headerRowIndex + 1,
      matchedColumns: detection.matchedColumns,
      rows: data.length,
      normalizedRows,
      skippedRows,
      preview: data.slice(0, 5),
    });
  } catch (error) {
    console.error("UPLOAD_ERROR", error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Ошибка загрузки файла",
      },
      { status: 500 }
    );
  }
}
