import { NextResponse } from "next/server";
import * as XLSX from "xlsx";

import { detectWorkbookReport } from "@/lib/import/reportDetector";
import { prisma } from "@/lib/prisma";

import { normalizeWbSales } from "@/lib/import/normalizers/wbSalesNormalizer";
import { normalizeWbFinance } from "@/lib/import/normalizers/wbFinanceNormalizer";
import { normalizeWbAds } from "@/lib/import/normalizers/wbAdsNormalizer";
import { normalizeWbStock } from "@/lib/import/normalizers/wbStockNormalizer";
import { normalizeProductCost } from "@/lib/import/normalizers/productCostNormalizer";

import { normalizeOzonFinance } from "@/lib/import/normalizers/ozonFinanceNormalizer";
import { normalizeOzonAds } from "@/lib/import/normalizers/ozonAdsNormalizer";
import { normalizeOzonStock } from "@/lib/import/normalizers/ozonStockNormalizer";
import { normalizeOzonProduct } from "@/lib/import/normalizers/ozonProductNormalizer";
import { normalizeFinanceTransactions } from "@/lib/import/normalizers/financeTransactionNormalizer";

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

    const workbook = XLSX.read(buffer, {
      type: "buffer",
      cellDates: true,
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
        previewJson: data.slice(0, 10),
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
      const result = await normalizeWbFinance(data, importSession.id, companyName);
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

    if (detection.reportType === "OZON_FINANCE") {
      const result = await normalizeOzonFinance(
        data,
        importSession.id,
        companyName
      );
      normalizedRows = result.savedRows;
    }

    if (detection.reportType === "OZON_ADS") {
      const result = await normalizeOzonAds(
        data,
        importSession.id,
        file.name,
        companyName
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