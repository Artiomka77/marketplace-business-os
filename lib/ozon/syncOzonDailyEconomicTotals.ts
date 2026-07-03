import { prisma } from "@/lib/prisma";

type SyncOzonDailyEconomicTotalsOptions = {
  dateFrom: Date;
  dateTo: Date;
};

type OzonTotalsResponse = {
  result?: {
    accruals_for_sale?: number;
    sale_commission?: number;
    processing_and_delivery?: number;
    refunds_and_cancellations?: number;
    services_amount?: number;
    compensation_amount?: number;
    money_transfer?: number;
    others_amount?: number;
  };
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
      .replace(/[^\d.-]/g, "")
  );

  return Number.isFinite(number) ? number : 0;
}

function normalizeText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function isOzonFinanceAdOperation(operationType: string | null | undefined) {
  const value = normalizeText(operationType);

  return (
    value.includes("оплата за клик") ||
    value.includes("продвижение с оплатой за заказ") ||
    value.includes("продвижение") ||
    value.includes("реклама") ||
    value.includes("реклам") ||
    value.includes("трафарет") ||
    value.includes("cpc") ||
    value.includes("cpo")
  );
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

async function fetchOzonTransactionTotals(params: {
  clientId: string;
  apiKey: string;
  dateFromText: string;
  dateToText: string;
}) {
  const response = await fetch("https://api-seller.ozon.ru/v3/finance/transaction/totals", {
    method: "POST",
    headers: {
      "Client-Id": params.clientId,
      "Api-Key": params.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      date: {
        from: `${params.dateFromText}T00:00:00.000Z`,
        to: `${params.dateToText}T23:59:59.999Z`,
      },
      transaction_type: "all",
    }),
    cache: "no-store",
  });

  const text = await response.text();

  let json: OzonTotalsResponse | null = null;

  try {
    json = text ? (JSON.parse(text) as OzonTotalsResponse) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    throw new Error(`Ozon transaction totals API: ${response.status} ${text.slice(0, 800)}`);
  }

  return json?.result ?? {};
}

async function getTaxableRevenueFromOzonFinance(params: {
  companyName: string;
  dateFrom: Date;
  dateToExclusive: Date;
}) {
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

  return rows.reduce((sum, row) => {
    if (isOzonFinanceAdOperation(row.operationType)) return sum;
    return sum + toNumber(row.salesAmount);
  }, 0);
}

async function upsertDailySummaries(params: {
  companyName: string;
  dateFrom: Date;
  dateTo: Date;
  taxableRevenue: number;
  economicTurnover: number;
  discountAndCoinvestmentAmount: number;
}) {
  const dateFromText = formatDateOnly(params.dateFrom);
  const dateToText = formatDateOnly(params.dateTo);
  const realizationSummaryId = createId("ozrday");
  const pointsSummaryId = createId("ozpday");
  const sourceName = `Ozon API transaction totals ${dateFromText} - ${dateToText}`;

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      DELETE FROM "OzonRealizationRow"
      WHERE "companyName" = ${params.companyName}
        AND "dateFrom"::date = CAST(${dateFromText} AS date)
        AND "dateTo"::date = CAST(${dateToText} AS date)
    `;

    await tx.$executeRaw`
      DELETE FROM "OzonRealizationSummary"
      WHERE "companyName" = ${params.companyName}
        AND "dateFrom"::date = CAST(${dateFromText} AS date)
        AND "dateTo"::date = CAST(${dateToText} AS date)
    `;

    await tx.$executeRaw`
      DELETE FROM "OzonDiscountPointsRow"
      WHERE "companyName" = ${params.companyName}
        AND "dateFrom"::date = CAST(${dateFromText} AS date)
        AND "dateTo"::date = CAST(${dateToText} AS date)
    `;

    await tx.$executeRaw`
      DELETE FROM "OzonDiscountPointsSummary"
      WHERE "companyName" = ${params.companyName}
        AND "dateFrom"::date = CAST(${dateFromText} AS date)
        AND "dateTo"::date = CAST(${dateToText} AS date)
    `;

    await tx.$executeRaw`
      INSERT INTO "OzonRealizationSummary" (
        "id", "companyName", "dateFrom", "dateTo", "contractNumber", "sourceFileName",
        "realizedAmount", "returnedAmount", "taxableRevenue", "partnerProgramsAmount", "rowsCount"
      )
      VALUES (
        ${realizationSummaryId}, ${params.companyName}, CAST(${dateFromText} AS date), CAST(${dateToText} AS date),
        ${"DAILY_TRANSACTION_TOTALS"}, ${sourceName},
        ${params.taxableRevenue}, ${0}, ${params.taxableRevenue}, ${0}, ${1}
      )
    `;

    await tx.$executeRaw`
      INSERT INTO "OzonDiscountPointsSummary" (
        "id", "companyName", "dateFrom", "dateTo", "sourceFileName",
        "pointsAccrued", "pointsWrittenOff",
        "commissionPaidByPoints", "logisticsPaidByPoints", "fboPaidByPoints",
        "advertisingPaidByPoints", "otherPaidByPoints", "totalPaidByPoints"
      )
      VALUES (
        ${pointsSummaryId}, ${params.companyName}, CAST(${dateFromText} AS date), CAST(${dateToText} AS date), ${sourceName},
        ${params.discountAndCoinvestmentAmount}, ${params.discountAndCoinvestmentAmount},
        ${0}, ${0}, ${0},
        ${0}, ${params.discountAndCoinvestmentAmount}, ${params.discountAndCoinvestmentAmount}
      )
    `;

    if (Math.abs(params.discountAndCoinvestmentAmount) > 0.005) {
      await tx.$executeRaw`
        INSERT INTO "OzonDiscountPointsRow" (
          "id", "summaryId", "companyName", "dateFrom", "dateTo", "category", "name", "amount"
        )
        VALUES (
          ${createId("ozprday")}, ${pointsSummaryId}, ${params.companyName},
          CAST(${dateFromText} AS date), CAST(${dateToText} AS date),
          ${"DAILY_ESTIMATE"}, ${"Баллы и соинвест Ozon по transaction totals, предварительно"},
          ${params.discountAndCoinvestmentAmount}
        )
      `;
    }
  });
}

export async function syncOzonDailyEconomicTotals(
  companyId: string,
  options: SyncOzonDailyEconomicTotalsOptions
) {
  const dateFrom = startOfUtcDay(options.dateFrom);
  const dateTo = startOfUtcDay(options.dateTo);
  const dateToExclusive = new Date(dateTo);
  dateToExclusive.setUTCDate(dateToExclusive.getUTCDate() + 1);

  const connection = await prisma.marketplaceApiConnection.findUnique({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace: "OZON",
      },
    },
    select: {
      ozonClientId: true,
      ozonApiKey: true,
      company: {
        select: {
          name: true,
        },
      },
    },
  });

  if (!connection?.ozonClientId || !connection.ozonApiKey) {
    throw new Error("Ozon Client-Id или Api-Key не сохранены");
  }

  const companyName = connection.company?.name ?? "Без компании";
  const dateFromText = formatDateOnly(dateFrom);
  const dateToText = formatDateOnly(dateTo);

  const [totals, taxableRevenue] = await Promise.all([
    fetchOzonTransactionTotals({
      clientId: connection.ozonClientId,
      apiKey: connection.ozonApiKey,
      dateFromText,
      dateToText,
    }),
    getTaxableRevenueFromOzonFinance({
      companyName,
      dateFrom,
      dateToExclusive,
    }),
  ]);

  const economicTurnover = toNumber(totals.accruals_for_sale);
  const discountAndCoinvestmentAmount = Math.max(0, economicTurnover - taxableRevenue);

  const hasData =
    Math.abs(economicTurnover) > 0.005 ||
    Math.abs(taxableRevenue) > 0.005 ||
    Math.abs(discountAndCoinvestmentAmount) > 0.005;

  if (!hasData) {
    return {
      name: "Ozon Daily Economic Totals",
      companyName,
      dateFrom: dateFromText,
      dateTo: dateToText,
      skipped: true,
      reason: "NO_TRANSACTION_TOTALS",
      economicTurnover,
      taxableRevenue,
      discountAndCoinvestmentAmount,
    };
  }

  await upsertDailySummaries({
    companyName,
    dateFrom,
    dateTo,
    taxableRevenue,
    economicTurnover,
    discountAndCoinvestmentAmount,
  });

  return {
    name: "Ozon Daily Economic Totals",
    companyName,
    dateFrom: dateFromText,
    dateTo: dateToText,
    skipped: false,
    economicTurnover,
    taxableRevenue,
    discountAndCoinvestmentAmount,
    source: "/v3/finance/transaction/totals",
  };
}
