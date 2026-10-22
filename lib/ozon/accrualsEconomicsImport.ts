import * as XLSX from "xlsx";
import { prisma } from "@/lib/prisma";

type MatrixRow = unknown[];

type Components = {
  dateKey: string | null;
  rows: number;
  taxableRevenue: number;
  realizedAmount: number;
  returnedAmount: number;
  discountPointsSales: number;
  discountPointsReturns: number;
  discountPointsAmount: number;
  partnerProgramsSales: number;
  partnerProgramsReturns: number;
  partnerProgramsAmount: number;
  economicTurnover: number;
};

type ParsedAccrualsReport = {
  sheetName: string;
  headerRow: number;
  expectedDays: string[];
  missingReportDays: string[];
  byDay: Map<string, Components>;
  period: Components;
  serviceTotals: Map<string, number>;
};

export type ImportOzonAccrualsEconomicsResult = {
  importSessionId: string;
  status: "SUCCESS" | "WARNING";
  companyName: string;
  dateFrom: string;
  dateTo: string;
  rowsCount: number;
  expectedDays: number;
  reportDays: number;
  missingReportDays: string[];
  economicTurnover: number;
  taxableRevenue: number;
  discountPointsAmount: number;
  partnerProgramsAmount: number;
};

function normalizeText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[–—−]/g, "-")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;

  const parsed = Number(
    String(value)
      .replace(/\u00A0/g, "")
      .replace(/\s/g, "")
      .replace(",", ".")
      .replace(/[^\d.-]/g, ""),
  );

  return Number.isFinite(parsed) ? parsed : 0;
}

function toDecimal(value: number) {
  const safe = Number.isFinite(value) ? value : 0;
  return safe.toFixed(2);
}

function toDateKey(value: unknown) {
  if (!value) return "";

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d)).toISOString().slice(0, 10);
    }
  }

  const text = String(value).trim();
  const ru = text.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (ru) return `${ru[3]}-${ru[2]}-${ru[1]}`;

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const parsedDate = new Date(text);
  return Number.isNaN(parsedDate.getTime()) ? "" : parsedDate.toISOString().slice(0, 10);
}

function dayStart(dateText: string) {
  return new Date(`${dateText}T00:00:00.000Z`);
}

function addDays(dateText: string, days: number) {
  const date = dayStart(dateText);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function listDays(dateFrom: string, dateTo: string) {
  const days: string[] = [];
  for (let day = dateFrom; day <= dateTo; day = addDays(day, 1)) days.push(day);
  return days;
}

function decodeXmlText(value: unknown) {
  return String(value ?? "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function zipFileContentToText(fileObject: any) {
  if (!fileObject) return "";

  const raw = fileObject.content ?? fileObject.data ?? fileObject;
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString("utf8");
  if (Array.isArray(raw)) return Buffer.from(raw).toString("utf8");

  if (typeof fileObject.asNodeBuffer === "function") {
    const buffer = fileObject.asNodeBuffer();
    return Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer ?? "");
  }

  if (typeof fileObject.asBinary === "function") {
    return Buffer.from(fileObject.asBinary(), "binary").toString("utf8");
  }

  if (typeof fileObject.toString === "function") {
    const text = fileObject.toString();
    if (text && text !== "[object Object]") return text;
  }

  return "";
}

function getWorkbookFileText(workbook: any, fileName: string) {
  if (!workbook?.files) return "";

  const direct = workbook.files[fileName] || workbook.files[`/${fileName}`];
  const directText = zipFileContentToText(direct);
  if (directText) return directText;

  const key = Object.keys(workbook.files).find((item) => item.replace(/^\//, "") === fileName);
  return key ? zipFileContentToText(workbook.files[key]) : "";
}

function parseSharedStringsXml(xml: string) {
  if (!xml) return [];
  const strings: string[] = [];
  const siMatches = xml.match(/<si\b[\s\S]*?<\/si>/g) || [];

  for (const si of siMatches) {
    const pieces: string[] = [];
    const tRegex = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let match: RegExpExecArray | null;
    while ((match = tRegex.exec(si))) pieces.push(decodeXmlText(match[1]));
    strings.push(pieces.join(""));
  }

  return strings;
}

function parseCellValueFromXml(cellXml: string, sharedStrings: string[]) {
  const typeMatch = cellXml.match(/\bt="([^"]+)"/);
  const cellType = typeMatch ? typeMatch[1] : "";
  const valueMatch = cellXml.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
  const inlineMatch = cellXml.match(/<is\b[\s\S]*?<t(?:\s[^>]*)?>([\s\S]*?)<\/t>[\s\S]*?<\/is>/);
  const rawValue = valueMatch ? decodeXmlText(valueMatch[1]) : inlineMatch ? decodeXmlText(inlineMatch[1]) : null;

  if (rawValue === null) return null;
  if (cellType === "s") return sharedStrings[toNumber(rawValue)] ?? "";
  if (cellType === "str" || cellType === "inlineStr") return rawValue;

  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : rawValue;
}

function parseWorksheetXmlToMatrix(sheetXml: string, sharedStrings: string[]) {
  const matrix: MatrixRow[] = [];
  if (!sheetXml) return matrix;

  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(sheetXml))) {
    const rowBody = rowMatch[1] ?? "";
    const row: unknown[] = [];
    const cellRegex = /<c\b[^>]*>([\s\S]*?)<\/c>/g;
    let cellMatch: RegExpExecArray | null;

    while ((cellMatch = cellRegex.exec(rowBody))) row.push(parseCellValueFromXml(cellMatch[0], sharedStrings));

    if (row.some((cell) => cell !== null && cell !== undefined && String(cell).trim() !== "")) matrix.push(row);
  }

  return matrix;
}

function findHeader(matrix: MatrixRow[]) {
  for (let i = 0; i < matrix.length; i += 1) {
    const cells = (matrix[i] ?? []).map(normalizeText);
    const hasDate = cells.some((cell) => cell.includes("дата начисления"));
    const hasGroup = cells.some((cell) => cell.includes("группа услуг"));
    const hasType = cells.some((cell) => cell.includes("тип начисления"));
    const hasAmount = cells.some((cell) => cell.includes("сумма итого"));
    if (hasDate && hasGroup && hasType && hasAmount) return i;
  }
  return -1;
}

function parseReportMatrixFromWorkbook(workbook: any, firstSheetName: string) {
  const sheet = workbook.Sheets[firstSheetName];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null }) as MatrixRow[];
  if (findHeader(matrix) >= 0) return matrix;

  const firstSheetKey = (workbook.keys || []).find((key: string) =>
    /^xl\/worksheets\/sheet\d+\.xml$/i.test(String(key).replace(/^\//, "")),
  );
  const sheetXml = getWorkbookFileText(workbook, firstSheetKey || "xl/worksheets/sheet1.xml");
  const sharedXml = getWorkbookFileText(workbook, "xl/sharedStrings.xml");
  const xmlMatrix = parseWorksheetXmlToMatrix(sheetXml, parseSharedStringsXml(sharedXml));

  return findHeader(xmlMatrix) >= 0 ? xmlMatrix : matrix;
}

function findColumn(headers: MatrixRow, predicate: (value: string) => boolean) {
  for (let i = 0; i < headers.length; i += 1) {
    if (predicate(normalizeText(headers[i]))) return i;
  }
  return -1;
}

function emptyComponents(dateKey: string | null = null): Components {
  return {
    dateKey,
    rows: 0,
    taxableRevenue: 0,
    realizedAmount: 0,
    returnedAmount: 0,
    discountPointsSales: 0,
    discountPointsReturns: 0,
    discountPointsAmount: 0,
    partnerProgramsSales: 0,
    partnerProgramsReturns: 0,
    partnerProgramsAmount: 0,
    economicTurnover: 0,
  };
}

function addComponent(acc: Components, groupRaw: unknown, typeRaw: unknown, amount: number) {
  const group = normalizeText(groupRaw);
  const type = normalizeText(typeRaw);

  if (group.includes("продажи") && type === "выручка") {
    acc.realizedAmount += amount;
    acc.taxableRevenue += amount;
    acc.economicTurnover += amount;
    return true;
  }

  if (group.includes("возврат") && (type.includes("возврат выручки") || type === "выручка")) {
    const negative = amount > 0 ? -amount : amount;
    acc.returnedAmount += Math.abs(negative);
    acc.taxableRevenue += negative;
    acc.economicTurnover += negative;
    return true;
  }

  if (group.includes("продажи") && type.includes("балл") && type.includes("скид")) {
    acc.discountPointsSales += amount;
    acc.discountPointsAmount += amount;
    acc.economicTurnover += amount;
    return true;
  }

  if (group.includes("возврат") && type.includes("балл") && type.includes("скид")) {
    const negative = amount > 0 ? -amount : amount;
    acc.discountPointsReturns += Math.abs(negative);
    acc.discountPointsAmount += negative;
    acc.economicTurnover += negative;
    return true;
  }

  if (group.includes("продажи") && type.includes("программ") && type.includes("партнер")) {
    acc.partnerProgramsSales += amount;
    acc.partnerProgramsAmount += amount;
    acc.economicTurnover += amount;
    return true;
  }

  if (group.includes("возврат") && type.includes("программ") && type.includes("партнер")) {
    const negative = amount > 0 ? -amount : amount;
    acc.partnerProgramsReturns += Math.abs(negative);
    acc.partnerProgramsAmount += negative;
    acc.economicTurnover += negative;
    return true;
  }

  return false;
}

export function parseOzonAccrualsEconomicsReport(input: Buffer | Uint8Array, dateFrom: string, dateTo: string): ParsedAccrualsReport {
  const workbook = XLSX.read(input, { type: "buffer", cellDates: true, bookFiles: true } as any) as any;
  const firstSheetName = workbook.SheetNames?.[0];
  if (!firstSheetName) throw new Error("В Excel-файле нет листов");

  const matrix = parseReportMatrixFromWorkbook(workbook, firstSheetName);
  const headerIndex = findHeader(matrix);
  if (headerIndex < 0) {
    throw new Error(`Не найдена строка заголовков отчёта начислений Ozon. Нужны колонки: Дата начисления, Группа услуг, Тип начисления, Сумма итого, руб. Первые строки: ${JSON.stringify(matrix.slice(0, 5))}`);
  }

  const headers = matrix[headerIndex] ?? [];
  const dateCol = findColumn(headers, (v) => v.includes("дата начисления"));
  const groupCol = findColumn(headers, (v) => v.includes("группа услуг"));
  const typeCol = findColumn(headers, (v) => v.includes("тип начисления"));
  const amountCol = findColumn(headers, (v) => v.includes("сумма итого"));

  if (dateCol < 0 || groupCol < 0 || typeCol < 0 || amountCol < 0) {
    throw new Error("Не найдены обязательные колонки отчёта начислений Ozon");
  }

  const byDay = new Map<string, Components>();
  const period = emptyComponents(null);
  const serviceTotals = new Map<string, number>();

  for (let i = headerIndex + 1; i < matrix.length; i += 1) {
    const row = matrix[i] ?? [];
    const dateKey = toDateKey(row[dateCol]);
    if (!dateKey || dateKey < dateFrom || dateKey > dateTo) continue;

    const group = row[groupCol];
    const type = row[typeCol];
    const amount = toNumber(row[amountCol]);
    if (amount === 0) continue;

    if (!byDay.has(dateKey)) byDay.set(dateKey, emptyComponents(dateKey));
    const day = byDay.get(dateKey)!;

    day.rows += 1;
    period.rows += 1;

    const serviceKey = `${String(group ?? "").trim()} / ${String(type ?? "").trim()}`;
    serviceTotals.set(serviceKey, (serviceTotals.get(serviceKey) || 0) + amount);

    addComponent(day, group, type, amount);
    addComponent(period, group, type, amount);
  }

  const expectedDays = listDays(dateFrom, dateTo);
  const missingReportDays = expectedDays.filter((day) => !byDay.has(day));

  return {
    sheetName: firstSheetName,
    headerRow: headerIndex + 1,
    expectedDays,
    missingReportDays,
    byDay,
    period,
    serviceTotals,
  };
}

async function deleteExistingForPeriod(tx: any, companyName: string, dateFrom: string, dateTo: string) {
  const where = { companyName, dateFrom: dayStart(dateFrom), dateTo: dayStart(dateTo) };
  await tx.ozonRealizationRow.deleteMany({ where });
  await tx.ozonRealizationSummary.deleteMany({ where });
  await tx.ozonDiscountPointsRow.deleteMany({ where });
  await tx.ozonDiscountPointsSummary.deleteMany({ where });
}

async function insertSummaries(tx: any, params: {
  companyName: string;
  dateFrom: string;
  dateTo: string;
  components: Components;
  importSessionId: string;
  sourceFileName: string;
  rowsCount: number;
}) {
  const { companyName, dateFrom, dateTo, components, importSessionId, sourceFileName, rowsCount } = params;

  await deleteExistingForPeriod(tx, companyName, dateFrom, dateTo);

  const realizationSummary = await tx.ozonRealizationSummary.create({
    data: {
      importSessionId,
      companyName,
      dateFrom: dayStart(dateFrom),
      dateTo: dayStart(dateTo),
      contractNumber: "OZON_ACCRUALS_REPORT",
      sourceFileName,
      realizedAmount: toDecimal(components.realizedAmount),
      returnedAmount: toDecimal(components.returnedAmount),
      taxableRevenue: toDecimal(components.taxableRevenue),
      partnerProgramsAmount: toDecimal(components.partnerProgramsAmount),
      rowsCount,
    },
  });

  await tx.ozonRealizationRow.create({
    data: {
      summaryId: realizationSummary.id,
      importSessionId,
      companyName,
      dateFrom: dayStart(dateFrom),
      dateTo: dayStart(dateTo),
      operationDate: dayStart(dateFrom),
      productName: dateFrom === dateTo ? "Итого по дню из отчёта начислений Ozon" : "Итого за период из отчёта начислений Ozon",
      realizedQty: 0,
      returnedQty: 0,
      netQty: 0,
      realizedAmount: toDecimal(components.realizedAmount),
      returnedAmount: toDecimal(components.returnedAmount),
      taxableRevenue: toDecimal(components.taxableRevenue),
      partnerProgramsAmount: toDecimal(components.partnerProgramsAmount),
    },
  });

  const pointsSummary = await tx.ozonDiscountPointsSummary.create({
    data: {
      importSessionId,
      companyName,
      dateFrom: dayStart(dateFrom),
      dateTo: dayStart(dateTo),
      sourceFileName,
      pointsAccrued: toDecimal(components.discountPointsSales),
      pointsWrittenOff: toDecimal(components.discountPointsReturns),
      commissionPaidByPoints: "0.00",
      logisticsPaidByPoints: "0.00",
      fboPaidByPoints: "0.00",
      advertisingPaidByPoints: "0.00",
      otherPaidByPoints: toDecimal(components.discountPointsAmount),
      totalPaidByPoints: toDecimal(components.discountPointsAmount),
    },
  });

  if (Math.abs(components.discountPointsAmount) > 0.005) {
    await tx.ozonDiscountPointsRow.create({
      data: {
        summaryId: pointsSummary.id,
        importSessionId,
        companyName,
        dateFrom: dayStart(dateFrom),
        dateTo: dayStart(dateTo),
        category: "DISCOUNT_POINTS",
        name: "Баллы за скидки Ozon из отчёта начислений",
        amount: toDecimal(components.discountPointsAmount),
      },
    });
  }
}

export async function importOzonAccrualsEconomicsFromBuffer(params: {
  fileBuffer: Buffer | Uint8Array;
  fileName: string;
  dateFrom: string;
  dateTo: string;
  companyName: string;
}): Promise<ImportOzonAccrualsEconomicsResult> {
  const parsed = parseOzonAccrualsEconomicsReport(params.fileBuffer, params.dateFrom, params.dateTo);

  if (parsed.period.rows === 0) {
    throw new Error("В выбранном периоде не найдено строк отчёта начислений");
  }

  if (Math.abs(parsed.period.economicTurnover) < 0.005) {
    throw new Error("Экономический оборот по отчёту равен нулю. Проверьте период и файл.");
  }

  const status = parsed.missingReportDays.length ? "WARNING" : "SUCCESS";

  return prisma.$transaction(async (tx) => {
    const importSession = await tx.importSession.create({
      data: {
        fileName: params.fileName,
        reportType: "OZON_ACCRUALS_ECONOMICS",
        marketplace: "OZON",
        companyName: params.companyName,
        rowsCount: parsed.period.rows,
        previewJson: {
          dateFrom: params.dateFrom,
          dateTo: params.dateTo,
          companyName: params.companyName,
          expectedDays: parsed.expectedDays.length,
          reportDays: parsed.byDay.size,
          missingReportDays: parsed.missingReportDays,
          period: parsed.period,
        },
        sheetName: parsed.sheetName,
        headerRow: parsed.headerRow,
        status,
      },
    });

    await insertSummaries(tx, {
      companyName: params.companyName,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      components: parsed.period,
      importSessionId: importSession.id,
      sourceFileName: params.fileName,
      rowsCount: parsed.period.rows,
    });

    for (const day of parsed.expectedDays) {
      const dayComponents = parsed.byDay.get(day);
      if (!dayComponents) continue;
      await insertSummaries(tx, {
        companyName: params.companyName,
        dateFrom: day,
        dateTo: day,
        components: dayComponents,
        importSessionId: importSession.id,
        sourceFileName: params.fileName,
        rowsCount: dayComponents.rows,
      });
    }

    return {
      importSessionId: importSession.id,
      status,
      companyName: params.companyName,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      rowsCount: parsed.period.rows,
      expectedDays: parsed.expectedDays.length,
      reportDays: parsed.byDay.size,
      missingReportDays: parsed.missingReportDays,
      economicTurnover: parsed.period.economicTurnover,
      taxableRevenue: parsed.period.taxableRevenue,
      discountPointsAmount: parsed.period.discountPointsAmount,
      partnerProgramsAmount: parsed.period.partnerProgramsAmount,
    };
  });
}
