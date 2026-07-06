import { randomUUID } from "crypto";

import { prisma } from "@/lib/prisma";

type SyncOzonDailyEconomicTotalsOptions = {
  dateFrom: Date;
  dateTo: Date;
};

type DailyEconomicComponents = {
  companyName: string;
  dateFrom: Date;
  dateTo: Date;
  financeRows: number;
  economicTurnover: number;
  taxableRevenue: number;
  realizedAmount: number;
  returnedAmount: number;
  discountPointsAmount: number;
  partnerProgramsAmount: number;
  unclassifiedSalesAmount: number;
};

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;

  if (typeof value === "object" && "toNumber" in value) {
    const number = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(number) ? number : 0;
  }

  const number = Number(
    String(value)
      .replace(/\s/g, "")
      .replace(",", ".")
      .replace(/[^\d.-]/g, ""),
  );

  return Number.isFinite(number) ? number : 0;
}

function normalizeText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[–—−]/g, "-")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function createId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function isOzonFinanceAdOperation(operationType: string | null | undefined) {
  const value = normalizeText(operationType);

  return (
    value.includes("оплата за клик") ||
    value.includes("продвижение с оплатой за заказ") ||
    value.includes("реклама оплата за заказ") ||
    value.includes("продвижение") ||
    value.includes("реклама") ||
    value.includes("реклам") ||
    value.includes("трафарет") ||
    value.includes("cpc") ||
    value.includes("cpo")
  );
}

function isOzonNonOperatingFinanceOperation(operationType: string | null | undefined) {
  const value = normalizeText(operationType);

  return (
    value.includes("займ") ||
    value.includes("заем") ||
    value.includes("фактор") ||
    value.includes("кредит") ||
    value.includes("финансирован") ||
    value.includes("loan") ||
    value.includes("factor")
  );
}

function isDiscountPointsOperation(operationType: string | null | undefined) {
  const value = normalizeText(operationType);
  return value.includes("балл") && value.includes("скид");
}

function isPartnerProgramOperation(operationType: string | null | undefined) {
  const value = normalizeText(operationType);
  return value.includes("программ") && value.includes("партнер");
}

function isTaxableRevenueOperation(operationType: string | null | undefined) {
  const value = normalizeText(operationType);

  return (
    value.includes("выручк") &&
    !isDiscountPointsOperation(operationType) &&
    !isPartnerProgramOperation(operationType)
  );
}

function hasMeaningfulAmount(value: number) {
  return Math.abs(value) > 0.005;
}

async function findCompanyName(companyId: string) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { name: true },
  });

  if (!company?.name) {
    throw new Error("Компания не найдена");
  }

  return company.name;
}

async function calculateDailyEconomicComponents(params: {
  companyName: string;
  dateFrom: Date;
  dateToExclusive: Date;
}): Promise<DailyEconomicComponents> {
  const rows = await prisma.ozonFinance.findMany({
    where: {
      companyName: params.companyName,
      accrualDate: {
        gte: params.dateFrom,
        lt: params.dateToExclusive,
      },
    },
    select: {
      operationType: true,
      salesAmount: true,
    },
  });

  let economicTurnover = 0;
  let taxableRevenue = 0;
  let realizedAmount = 0;
  let returnedAmount = 0;
  let discountPointsAmount = 0;
  let partnerProgramsAmount = 0;

  for (const row of rows) {
    const operationType = row.operationType;
    const salesAmount = toNumber(row.salesAmount);

    if (
      isOzonFinanceAdOperation(operationType) ||
      isOzonNonOperatingFinanceOperation(operationType)
    ) {
      continue;
    }

    economicTurnover += salesAmount;

    if (isTaxableRevenueOperation(operationType)) {
      taxableRevenue += salesAmount;

      if (salesAmount >= 0) {
        realizedAmount += salesAmount;
      } else {
        returnedAmount += Math.abs(salesAmount);
      }

      continue;
    }

    if (isDiscountPointsOperation(operationType)) {
      discountPointsAmount += salesAmount;
      continue;
    }

    if (isPartnerProgramOperation(operationType)) {
      partnerProgramsAmount += salesAmount;
    }
  }

  const unclassifiedSalesAmount =
    economicTurnover - taxableRevenue - discountPointsAmount - partnerProgramsAmount;

  return {
    companyName: params.companyName,
    dateFrom: params.dateFrom,
    dateTo: addUtcDays(params.dateToExclusive, -1),
    financeRows: rows.length,
    economicTurnover,
    taxableRevenue,
    realizedAmount,
    returnedAmount,
    discountPointsAmount,
    partnerProgramsAmount,
    unclassifiedSalesAmount,
  };
}

async function upsertDailySummaries(components: DailyEconomicComponents) {
  const dateFromText = formatDateOnly(components.dateFrom);
  const dateToText = formatDateOnly(components.dateTo);
  const realizationSummaryId = createId("ozrday");
  const pointsSummaryId = createId("ozpday");
  const importSessionId = createId("impozeco");
  const sourceName = `Ozon Finance detailed accruals ${components.companyName} ${dateFromText} - ${dateToText}`;

  await prisma.$transaction(async (tx) => {
    await tx.importSession.create({
      data: {
        id: importSessionId,
        fileName: sourceName,
        reportType: "OZON_DAILY_ECONOMIC_TOTALS",
        marketplace: "OZON",
        companyName: components.companyName,
        rowsCount: components.financeRows,
        previewJson: {
          source: "OzonFinance",
          economicTurnover: components.economicTurnover,
          taxableRevenue: components.taxableRevenue,
          discountPointsAmount: components.discountPointsAmount,
          partnerProgramsAmount: components.partnerProgramsAmount,
          unclassifiedSalesAmount: components.unclassifiedSalesAmount,
        } as any,
        sheetName: "OzonFinance derived daily economics",
        headerRow: 1,
        status: hasMeaningfulAmount(components.unclassifiedSalesAmount)
          ? "WARNING"
          : "SUCCESS",
      },
    });

    await tx.$executeRaw`
      DELETE FROM "OzonRealizationRow"
      WHERE "companyName" = ${components.companyName}
        AND "dateFrom"::date = CAST(${dateFromText} AS date)
        AND "dateTo"::date = CAST(${dateToText} AS date)
    `;

    await tx.$executeRaw`
      DELETE FROM "OzonRealizationSummary"
      WHERE "companyName" = ${components.companyName}
        AND "dateFrom"::date = CAST(${dateFromText} AS date)
        AND "dateTo"::date = CAST(${dateToText} AS date)
    `;

    await tx.$executeRaw`
      DELETE FROM "OzonDiscountPointsRow"
      WHERE "companyName" = ${components.companyName}
        AND "dateFrom"::date = CAST(${dateFromText} AS date)
        AND "dateTo"::date = CAST(${dateToText} AS date)
    `;

    await tx.$executeRaw`
      DELETE FROM "OzonDiscountPointsSummary"
      WHERE "companyName" = ${components.companyName}
        AND "dateFrom"::date = CAST(${dateFromText} AS date)
        AND "dateTo"::date = CAST(${dateToText} AS date)
    `;

    await tx.$executeRaw`
      INSERT INTO "OzonRealizationSummary" (
        "id", "importSessionId", "companyName", "dateFrom", "dateTo", "contractNumber", "sourceFileName",
        "realizedAmount", "returnedAmount", "taxableRevenue", "partnerProgramsAmount", "rowsCount"
      )
      VALUES (
        ${realizationSummaryId}, ${importSessionId}, ${components.companyName}, CAST(${dateFromText} AS date), CAST(${dateToText} AS date),
        ${"DAILY_OZON_FINANCE"}, ${sourceName},
        ${components.realizedAmount}, ${components.returnedAmount}, ${components.taxableRevenue}, ${components.partnerProgramsAmount}, ${components.financeRows}
      )
    `;

    await tx.$executeRaw`
      INSERT INTO "OzonRealizationRow" (
        "id", "summaryId", "importSessionId", "companyName", "dateFrom", "dateTo", "operationDate",
        "sku", "vendorCode", "productName",
        "realizedQty", "returnedQty", "netQty",
        "realizedAmount", "returnedAmount", "taxableRevenue", "partnerProgramsAmount"
      )
      VALUES (
        ${createId("ozrrday")}, ${realizationSummaryId}, ${importSessionId}, ${components.companyName},
        CAST(${dateFromText} AS date), CAST(${dateToText} AS date), CAST(${dateFromText} AS date),
        ${null}, ${null}, ${"Итого по дню из Ozon Finance"},
        ${0}, ${0}, ${0},
        ${components.realizedAmount}, ${components.returnedAmount}, ${components.taxableRevenue}, ${components.partnerProgramsAmount}
      )
    `;

    await tx.$executeRaw`
      INSERT INTO "OzonDiscountPointsSummary" (
        "id", "importSessionId", "companyName", "dateFrom", "dateTo", "sourceFileName",
        "pointsAccrued", "pointsWrittenOff",
        "commissionPaidByPoints", "logisticsPaidByPoints", "fboPaidByPoints",
        "advertisingPaidByPoints", "otherPaidByPoints", "totalPaidByPoints"
      )
      VALUES (
        ${pointsSummaryId}, ${importSessionId}, ${components.companyName}, CAST(${dateFromText} AS date), CAST(${dateToText} AS date), ${sourceName},
        ${components.discountPointsAmount}, ${components.discountPointsAmount},
        ${0}, ${0}, ${0},
        ${0}, ${components.discountPointsAmount}, ${components.discountPointsAmount}
      )
    `;

    if (hasMeaningfulAmount(components.discountPointsAmount)) {
      await tx.$executeRaw`
        INSERT INTO "OzonDiscountPointsRow" (
          "id", "summaryId", "importSessionId", "companyName", "dateFrom", "dateTo", "category", "name", "amount"
        )
        VALUES (
          ${createId("ozprday")}, ${pointsSummaryId}, ${importSessionId}, ${components.companyName},
          CAST(${dateFromText} AS date), CAST(${dateToText} AS date),
          ${"DISCOUNT_POINTS"}, ${"Баллы за скидки Ozon из отчёта начислений"},
          ${components.discountPointsAmount}
        )
      `;
    }
  });
}

export async function syncOzonDailyEconomicTotals(
  companyId: string,
  options: SyncOzonDailyEconomicTotalsOptions,
) {
  const companyName = await findCompanyName(companyId);
  const dateFrom = startOfUtcDay(options.dateFrom);
  const dateTo = startOfUtcDay(options.dateTo);
  const dateToExclusive = addUtcDays(dateTo, 1);

  const components = await calculateDailyEconomicComponents({
    companyName,
    dateFrom,
    dateToExclusive,
  });

  const hasFinanceRows = components.financeRows > 0;
  const hasClassifiedEconomicData =
    hasMeaningfulAmount(components.taxableRevenue) ||
    hasMeaningfulAmount(components.discountPointsAmount) ||
    hasMeaningfulAmount(components.partnerProgramsAmount);

  if (!hasFinanceRows || !hasClassifiedEconomicData) {
    return {
      ...components,
      name: "Ozon Daily Economic Totals",
      companyName,
      dateFrom: formatDateOnly(dateFrom),
      dateTo: formatDateOnly(dateTo),
      skipped: true,
      reason: !hasFinanceRows ? "NO_OZON_FINANCE_ROWS" : "NO_REVENUE_COMPONENTS_IN_OZON_FINANCE",
    };
  }

  await upsertDailySummaries(components);

  return {
    ...components,
    name: "Ozon Daily Economic Totals",
    companyName,
    dateFrom: formatDateOnly(dateFrom),
    dateTo: formatDateOnly(dateTo),
    skipped: false,
    reason: null,
    source: "OzonFinance detailed accruals",
  };
}

export async function syncOzonDailyEconomicTotalsRange(
  companyId: string,
  options: SyncOzonDailyEconomicTotalsOptions,
) {
  const dateFrom = startOfUtcDay(options.dateFrom);
  const dateTo = startOfUtcDay(options.dateTo);
  const results = [];

  for (let day = new Date(dateFrom); day.getTime() <= dateTo.getTime(); day = addUtcDays(day, 1)) {
    results.push(
      await syncOzonDailyEconomicTotals(companyId, {
        dateFrom: day,
        dateTo: day,
      }),
    );
  }

  return {
    name: "Ozon Daily Economic Totals Range",
    dateFrom: formatDateOnly(dateFrom),
    dateTo: formatDateOnly(dateTo),
    days: results.length,
    savedDays: results.filter((result) => !result.skipped).length,
    skippedDays: results.filter((result) => result.skipped).length,
    results: results.map((result) => ({
      dateFrom: result.dateFrom,
      dateTo: result.dateTo,
      skipped: result.skipped,
      reason: result.skipped ? result.reason : null,
      economicTurnover: result.economicTurnover,
      taxableRevenue: result.taxableRevenue,
      discountPointsAmount: result.discountPointsAmount,
      partnerProgramsAmount: result.partnerProgramsAmount,
      unclassifiedSalesAmount: result.unclassifiedSalesAmount,
    })),
  };
}
