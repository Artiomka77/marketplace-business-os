import { randomUUID } from "crypto";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

type InputRow = Record<string, unknown>;

type OzonAccrualDay = {
  date: string;
  rawRows: number;
  relevantRows: number;
  realizedAmountCents: number;
  returnedAmountCents: number;
  taxableRevenueCents: number;
  pointsAccruedCents: number;
  pointsWrittenOffCents: number;
  totalPaidByPointsCents: number;
  partnerProgramsAmountCents: number;
  economicTurnoverCents: number;
};

export type OzonAccrualEconomicsImportResult = {
  coverageComplete: true;
  dateFrom: string;
  dateTo: string;
  days: number;
  sourceRows: number;
  relevantRows: number;
  taxableRevenue: number;
  discountPointsAmount: number;
  partnerProgramsAmount: number;
  economicTurnover: number;
  financeEconomicTurnover: number;
  financeEconomicTurnoverMatched: boolean;
  financeEconomicTurnoverDifference: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REPORT_DAYS = 370;

function normalizeText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHeader(value: unknown) {
  return normalizeText(value)
    .replace(/[.,:;]/g, "")
    .trim();
}

function findValue(row: InputRow, aliases: string[]) {
  const normalizedAliases = aliases.map(normalizeHeader);

  for (const [key, value] of Object.entries(row)) {
    if (normalizedAliases.includes(normalizeHeader(key))) {
      return value;
    }
  }

  return undefined;
}

function findValueWithFallback(
  row: InputRow,
  aliases: string[],
  fallbackIndex: number
) {
  const value = findValue(row, aliases);

  if (
    value !== undefined &&
    value !== null &&
    String(value).trim() !== ""
  ) {
    return value;
  }

  return Object.values(row)[fallbackIndex];
}

function parseMoneyToCents(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value * 100) : 0;
  }

  const normalized = String(value ?? "")
    .replace(/\u00a0/g, "")
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  if (!normalized) {
    return 0;
  }

  const amount = Number(normalized);

  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

function makeDateKey(year: number, month: number, day: number) {
  const value = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

  if (
    Number.isNaN(value.getTime()) ||
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day
  ) {
    return null;
  }

  return value.toISOString().slice(0, 10);
}

function parseDateKey(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = Date.UTC(1899, 11, 30) + Math.round(value * DAY_MS);
    const date = new Date(milliseconds);

    return Number.isNaN(date.getTime())
      ? null
      : date.toISOString().slice(0, 10);
  }

  const text = String(value ?? "").trim();

  let match = text.match(/^(\d{2})[.\-/](\d{2})[.\-/](\d{4})/);

  if (match) {
    return makeDateKey(Number(match[3]), Number(match[2]), Number(match[1]));
  }

  match = text.match(/^(\d{4})[.\-/](\d{2})[.\-/](\d{2})/);

  if (match) {
    return makeDateKey(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  return null;
}

function parsePeriodFromRawRows(rawRows: unknown[][]) {
  for (const row of rawRows.slice(0, 40)) {
    const text = row
      .map((cell) => String(cell ?? "").trim())
      .filter(Boolean)
      .join(" ");

    if (!normalizeText(text).includes("период")) {
      continue;
    }

    const matches = Array.from(
      text.matchAll(/(\d{2})[.\-/](\d{2})[.\-/](\d{4})/g)
    );

    if (matches.length < 2) {
      continue;
    }

    const dateFrom = makeDateKey(
      Number(matches[0][3]),
      Number(matches[0][2]),
      Number(matches[0][1])
    );
    const dateTo = makeDateKey(
      Number(matches[1][3]),
      Number(matches[1][2]),
      Number(matches[1][1])
    );

    if (dateFrom && dateTo) {
      return { dateFrom, dateTo };
    }
  }

  return null;
}

function enumerateDays(dateFrom: string, dateTo: string) {
  const from = new Date(`${dateFrom}T00:00:00.000Z`);
  const to = new Date(`${dateTo}T00:00:00.000Z`);

  if (
    Number.isNaN(from.getTime()) ||
    Number.isNaN(to.getTime()) ||
    from.getTime() > to.getTime()
  ) {
    throw new Error("Некорректный период в отчёте начислений Ozon");
  }

  const count = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;

  if (count < 1 || count > MAX_REPORT_DAYS) {
    throw new Error(
      `Период отчёта начислений Ozon должен содержать от 1 до ${MAX_REPORT_DAYS} дней`
    );
  }

  return Array.from({ length: count }, (_, index) =>
    new Date(from.getTime() + index * DAY_MS).toISOString().slice(0, 10)
  );
}

function createEmptyDay(date: string): OzonAccrualDay {
  return {
    date,
    rawRows: 0,
    relevantRows: 0,
    realizedAmountCents: 0,
    returnedAmountCents: 0,
    taxableRevenueCents: 0,
    pointsAccruedCents: 0,
    pointsWrittenOffCents: 0,
    totalPaidByPointsCents: 0,
    partnerProgramsAmountCents: 0,
    economicTurnoverCents: 0,
  };
}

function centsToMoney(value: number) {
  return value / 100;
}

function createId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

export function isOzonAccrualEconomicsReport(
  data: InputRow[],
  fileName = ""
) {
  const row = data.find((item) => Object.keys(item).length > 0);
  const normalizedFileName = normalizeText(fileName);

  if (row) {
    const headers = Object.keys(row).map(normalizeHeader);
    const matchesHeaders = [
      "дата начисления",
      "группа услуг",
      "тип начисления",
      "сумма итого руб",
    ].every((required) => headers.includes(required));

    if (matchesHeaders) {
      return true;
    }
  }

  return normalizedFileName.includes("отчет по начислениям");
}

function buildDailyEconomics(data: InputRow[], rawRows: unknown[][]) {
  const parsedRows: Array<{
    date: string;
    group: string;
    type: string;
    amountCents: number;
  }> = [];

  for (const row of data) {
    const rawDate = findValueWithFallback(
      row,
      [
        "Дата начисления",
        "Дата операции",
        "operation_date",
      ],
      1
    );
    const rawGroup = findValueWithFallback(
      row,
      ["Группа услуг"],
      2
    );
    const rawType = findValueWithFallback(
      row,
      ["Тип начисления"],
      3
    );
    const rawAmount = findValueWithFallback(
      row,
      [
        "Сумма итого, руб.",
        "Сумма итого",
        "Итого, руб.",
      ],
      15
    );

    const group = normalizeText(rawGroup);
    const type = normalizeText(rawType);
    const hasMeaningfulData =
      Boolean(group) ||
      Boolean(type) ||
      String(rawAmount ?? "").trim() !== "";

    const date = parseDateKey(rawDate);

    if (!date) {
      if (hasMeaningfulData) {
        throw new Error(
          "В отчёте начислений Ozon обнаружена содержательная строка без корректной даты начисления"
        );
      }

      continue;
    }

    parsedRows.push({
      date,
      group,
      type,
      amountCents: parseMoneyToCents(rawAmount),
    });
  }

  if (parsedRows.length === 0) {
    throw new Error("В отчёте начислений Ozon не найдено строк с датой");
  }

  const dates = parsedRows.map((row) => row.date).sort();
  const statedPeriod = parsePeriodFromRawRows(rawRows);
  const dateFrom = statedPeriod?.dateFrom ?? dates[0];
  const dateTo = statedPeriod?.dateTo ?? dates[dates.length - 1];
  const days = enumerateDays(dateFrom, dateTo);
  const daily = new Map(days.map((date) => [date, createEmptyDay(date)]));

  for (const row of parsedRows) {
    const day = daily.get(row.date);

    if (!day) {
      throw new Error(
        `Дата ${row.date} выходит за пределы периода отчёта начислений Ozon ${dateFrom}–${dateTo}`
      );
    }

    day.rawRows += 1;

    if (row.group === "продажи" && row.type === "выручка") {
      day.realizedAmountCents += row.amountCents;
      day.taxableRevenueCents += row.amountCents;
      day.relevantRows += 1;
    } else if (
      row.group === "возвраты" &&
      row.type === "возврат выручки"
    ) {
      day.returnedAmountCents += Math.abs(row.amountCents);
      day.taxableRevenueCents += row.amountCents;
      day.relevantRows += 1;
    } else if (
      row.group === "продажи" &&
      row.type === "баллы за скидки"
    ) {
      day.pointsAccruedCents += row.amountCents;
      day.totalPaidByPointsCents += row.amountCents;
      day.relevantRows += 1;
    } else if (
      row.group === "возвраты" &&
      row.type === "баллы за скидки"
    ) {
      day.pointsWrittenOffCents += Math.abs(row.amountCents);
      day.totalPaidByPointsCents += row.amountCents;
      day.relevantRows += 1;
    } else if (
      (row.group === "продажи" || row.group === "возвраты") &&
      row.type === "программы партнеров"
    ) {
      day.partnerProgramsAmountCents += row.amountCents;
      day.relevantRows += 1;
    }
  }

  for (const day of daily.values()) {
    day.economicTurnoverCents =
      day.taxableRevenueCents +
      day.totalPaidByPointsCents +
      day.partnerProgramsAmountCents;
  }

  const result = Array.from(daily.values());
  const relevantRows = result.reduce(
    (sum, day) => sum + day.relevantRows,
    0
  );

  if (relevantRows === 0) {
    throw new Error(
      "В отчёте начислений Ozon не найдены выручка, возврат выручки, баллы за скидки или программы партнёров"
    );
  }

  return {
    dateFrom,
    dateTo,
    daily: result,
    sourceRows: parsedRows.length,
    relevantRows,
  };
}

async function readOzonFinanceEconomicTurnover(
  companyName: string,
  dateFrom: string,
  dateTo: string
) {
  const rows = await prisma.$queryRaw<Array<{ amount: unknown }>>`
    SELECT COALESCE(SUM("salesAmount"), 0) AS "amount"
    FROM "OzonFinance"
    WHERE "companyName" = ${companyName}
      AND "accrualDate"::date >= CAST(${dateFrom} AS date)
      AND "accrualDate"::date <= CAST(${dateTo} AS date)
  `;

  return parseMoneyToCents(rows[0]?.amount);
}

async function replaceSummaryRows(
  tx: Prisma.TransactionClient,
  params: {
    importSessionId: string;
    companyName: string;
    fileName: string;
    dateFrom: string;
    dateTo: string;
    daily: OzonAccrualDay[];
  }
) {
  const {
    importSessionId,
    companyName,
    fileName,
    dateFrom,
    dateTo,
    daily,
  } = params;

  await tx.$executeRaw`
    DELETE FROM "OzonDiscountPointsRow"
    WHERE "companyName" = ${companyName}
      AND "dateFrom"::date >= CAST(${dateFrom} AS date)
      AND "dateTo"::date <= CAST(${dateTo} AS date)
  `;

  await tx.$executeRaw`
    DELETE FROM "OzonDiscountPointsSummary"
    WHERE "companyName" = ${companyName}
      AND "dateFrom"::date >= CAST(${dateFrom} AS date)
      AND "dateTo"::date <= CAST(${dateTo} AS date)
  `;

  await tx.$executeRaw`
    DELETE FROM "OzonRealizationRow"
    WHERE "companyName" = ${companyName}
      AND "dateFrom"::date >= CAST(${dateFrom} AS date)
      AND "dateTo"::date <= CAST(${dateTo} AS date)
  `;

  await tx.$executeRaw`
    DELETE FROM "OzonRealizationSummary"
    WHERE "companyName" = ${companyName}
      AND "dateFrom"::date >= CAST(${dateFrom} AS date)
      AND "dateTo"::date <= CAST(${dateTo} AS date)
  `;

  for (const day of daily) {
    const realizationSummaryId = createId("ozracc");
    const discountPointsSummaryId = createId("ozpacc");

    await tx.$executeRaw`
      INSERT INTO "OzonRealizationSummary" (
        "id", "importSessionId", "companyName", "dateFrom", "dateTo",
        "reportNumber", "contractNumber", "sourceFileName",
        "realizedAmount", "returnedAmount", "taxableRevenue",
        "partnerProgramsAmount", "rowsCount", "createdAt"
      ) VALUES (
        ${realizationSummaryId}, ${importSessionId}, ${companyName},
        CAST(${day.date} AS date), CAST(${day.date} AS date),
        ${"OZON_ACCRUALS_REPORT"}, NULL, ${fileName},
        ${centsToMoney(day.realizedAmountCents)},
        ${centsToMoney(day.returnedAmountCents)},
        ${centsToMoney(day.taxableRevenueCents)},
        ${centsToMoney(day.partnerProgramsAmountCents)},
        ${day.rawRows}, NOW()
      )
    `;

    await tx.$executeRaw`
      INSERT INTO "OzonRealizationRow" (
        "id", "summaryId", "importSessionId", "companyName",
        "dateFrom", "dateTo", "operationDate",
        "sku", "vendorCode", "productName",
        "realizedQty", "returnedQty", "netQty",
        "realizedAmount", "returnedAmount", "taxableRevenue",
        "partnerProgramsAmount", "createdAt"
      ) VALUES (
        ${createId("ozrracc")}, ${realizationSummaryId},
        ${importSessionId}, ${companyName},
        CAST(${day.date} AS date), CAST(${day.date} AS date),
        CAST(${day.date} AS date),
        NULL, NULL, ${"Итого по дню из отчёта начислений Ozon"},
        0, 0, 0,
        ${centsToMoney(day.realizedAmountCents)},
        ${centsToMoney(day.returnedAmountCents)},
        ${centsToMoney(day.taxableRevenueCents)},
        ${centsToMoney(day.partnerProgramsAmountCents)},
        NOW()
      )
    `;

    await tx.$executeRaw`
      INSERT INTO "OzonDiscountPointsSummary" (
        "id", "importSessionId", "companyName", "dateFrom", "dateTo",
        "sourceFileName", "pointsAccrued", "pointsWrittenOff",
        "commissionPaidByPoints", "logisticsPaidByPoints",
        "fboPaidByPoints", "advertisingPaidByPoints",
        "otherPaidByPoints", "totalPaidByPoints", "createdAt"
      ) VALUES (
        ${discountPointsSummaryId}, ${importSessionId}, ${companyName},
        CAST(${day.date} AS date), CAST(${day.date} AS date),
        ${fileName},
        ${centsToMoney(day.pointsAccruedCents)},
        ${centsToMoney(day.pointsWrittenOffCents)},
        0, 0, 0, 0,
        ${centsToMoney(day.totalPaidByPointsCents)},
        ${centsToMoney(day.totalPaidByPointsCents)},
        NOW()
      )
    `;

    await tx.$executeRaw`
      INSERT INTO "OzonDiscountPointsRow" (
        "id", "summaryId", "importSessionId", "companyName",
        "dateFrom", "dateTo", "category", "name", "amount", "createdAt"
      ) VALUES (
        ${createId("ozpracc")}, ${discountPointsSummaryId},
        ${importSessionId}, ${companyName},
        CAST(${day.date} AS date), CAST(${day.date} AS date),
        ${"DISCOUNT_POINTS"},
        ${"Баллы за скидки Ozon из отчёта начислений"},
        ${centsToMoney(day.totalPaidByPointsCents)},
        NOW()
      )
    `;
  }
}

export async function normalizeOzonAccrualEconomics(params: {
  data: InputRow[];
  rawRows: unknown[][];
  importSessionId: string;
  companyName: string | null;
  fileName: string;
}): Promise<OzonAccrualEconomicsImportResult> {
  const {
    data,
    rawRows,
    importSessionId,
    companyName,
    fileName,
  } = params;

  if (!companyName) {
    throw new Error(
      "Для отчёта начислений Ozon необходимо выбрать компанию"
    );
  }

  const parsed = buildDailyEconomics(data, rawRows);

  const totals = parsed.daily.reduce(
    (acc, day) => {
      acc.taxableRevenueCents += day.taxableRevenueCents;
      acc.discountPointsCents += day.totalPaidByPointsCents;
      acc.partnerProgramsCents += day.partnerProgramsAmountCents;
      acc.economicTurnoverCents += day.economicTurnoverCents;
      return acc;
    },
    {
      taxableRevenueCents: 0,
      discountPointsCents: 0,
      partnerProgramsCents: 0,
      economicTurnoverCents: 0,
    }
  );

  const financeEconomicTurnoverCents =
    await readOzonFinanceEconomicTurnover(
      companyName,
      parsed.dateFrom,
      parsed.dateTo
    );

  const financeEconomicTurnoverMatched =
    financeEconomicTurnoverCents === totals.economicTurnoverCents;
  const financeEconomicTurnoverDifferenceCents =
    financeEconomicTurnoverCents - totals.economicTurnoverCents;

  await prisma.$transaction(
    async (tx) => {
      await tx.ozonFinance.deleteMany({
        where: {
          importSessionId,
          companyName,
        },
      });

      await replaceSummaryRows(tx, {
        importSessionId,
        companyName,
        fileName,
        dateFrom: parsed.dateFrom,
        dateTo: parsed.dateTo,
        daily: parsed.daily,
      });

      await tx.importSession.update({
        where: {
          id: importSessionId,
        },
        data: {
          status: "SUCCESS",
        },
      });
    },
    {
      timeout: 120_000,
      maxWait: 20_000,
    }
  );

  return {
    coverageComplete: true,
    dateFrom: parsed.dateFrom,
    dateTo: parsed.dateTo,
    days: parsed.daily.length,
    sourceRows: parsed.sourceRows,
    relevantRows: parsed.relevantRows,
    taxableRevenue: centsToMoney(totals.taxableRevenueCents),
    discountPointsAmount: centsToMoney(totals.discountPointsCents),
    partnerProgramsAmount: centsToMoney(totals.partnerProgramsCents),
    economicTurnover: centsToMoney(totals.economicTurnoverCents),
    financeEconomicTurnover: centsToMoney(
      financeEconomicTurnoverCents
    ),
    financeEconomicTurnoverMatched,
    financeEconomicTurnoverDifference: centsToMoney(
      financeEconomicTurnoverDifferenceCents
    ),
  };
}
