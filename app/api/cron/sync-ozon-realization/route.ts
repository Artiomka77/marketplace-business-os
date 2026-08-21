import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { rejectUnauthorizedCron } from "@/lib/security/cronAuth";

import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

type OzonConnection = {
  companyId: string;
  companyName: string;
  ozonClientId: string | null;
  ozonApiKey: string | null;
  isEnabled: boolean | null;
  status: string | null;
};

type OzonRealizationCommission = {
  price_per_instance?: number | null;
  quantity?: number | null;
  amount?: number | null;
  compensation?: number | null;
  commission?: number | null;
  bonus?: number | null;
  standard_fee?: number | null;
  total?: number | null;
  stars?: number | null;
  bank_coinvestment?: number | null;
  pick_up_point_coinvestment?: number | null;
};

type OzonRealizationRow = {
  rowNumber?: number | null;
  item?: {
    name?: string | null;
    offer_id?: string | null;
    barcode?: string | null;
    sku?: string | number | null;
  } | null;
  seller_price_per_instance?: number | null;
  delivery_commission?: OzonRealizationCommission | null;
  return_commission?: OzonRealizationCommission | null;
  commission_ratio?: number | null;
};

type OzonRealizationResponse = {
  result?: {
    header?: {
      number?: string | null;
      doc_date?: string | null;
      start_date?: string | null;
      stop_date?: string | null;
      contract_number?: string | null;
    } | null;
    rows?: OzonRealizationRow[] | null;
  } | null;
};

type PeriodToSync = {
  label: string;
  year: number;
  month: number;
  dateFrom: string;
  dateTo: string;
  isCurrentMonth: boolean;
};

type ParsedOzonRealization = {
  reportNumber: string | null;
  contractNumber: string | null;
  sourceFileName: string;
  apiStartDate: string | null;
  apiStopDate: string | null;
  rowsCount: number;
  realizedAmount: number;
  returnedAmount: number;
  taxableRevenue: number;
  grossPointsAccrued: number;
  grossPointsReturned: number;
  totalPaidByPoints: number;
  deliveryPartnerProgramsAmount: number;
  returnPartnerProgramsAmount: number;
  partnerProgramsAmount: number;
};

function toNumber(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function toDateText(date: Date) {
  return date.toISOString().slice(0, 10);
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function monthStart(year: number, monthIndexZeroBased: number) {
  return new Date(Date.UTC(year, monthIndexZeroBased, 1));
}

function monthEnd(year: number, monthIndexZeroBased: number) {
  return new Date(Date.UTC(year, monthIndexZeroBased + 1, 0));
}

function buildPeriods(now = new Date()) {
  const currentYear = now.getUTCFullYear();
  const currentMonthIndex = now.getUTCMonth();

  const previousMonthDate = monthStart(currentYear, currentMonthIndex - 1);
  const previousYear = previousMonthDate.getUTCFullYear();
  const previousMonthIndex = previousMonthDate.getUTCMonth();

  return [
    {
      label: "previous-month-finalization",
      year: previousYear,
      month: previousMonthIndex + 1,
      dateFrom: toDateText(monthStart(previousYear, previousMonthIndex)),
      dateTo: toDateText(monthEnd(previousYear, previousMonthIndex)),
      isCurrentMonth: false,
    },
  ];
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function getCommissionAmount(value: OzonRealizationCommission | null | undefined) {
  return toNumber(value?.amount);
}

function getCommissionQuantity(value: OzonRealizationCommission | null | undefined) {
  return Math.round(toNumber(value?.quantity));
}

function getBonusAmount(value: OzonRealizationCommission | null | undefined) {
  return toNumber(value?.bonus);
}

function getPartnerProgramsAmount(value: OzonRealizationCommission | null | undefined) {
  return (
    toNumber(value?.bank_coinvestment) +
    toNumber(value?.pick_up_point_coinvestment)
  );
}

async function getOzonConnections(companyIds?: string[]) {
  const rows = await prisma.$queryRaw<OzonConnection[]>`
    SELECT
      c."id" AS "companyId",
      c."name" AS "companyName",
      mac."ozonClientId" AS "ozonClientId",
      mac."ozonApiKey" AS "ozonApiKey",
      mac."isEnabled" AS "isEnabled",
      mac."status" AS "status"
    FROM "MarketplaceApiConnection" mac
    INNER JOIN "Company" c ON c."id" = mac."companyId"
    WHERE mac."marketplace" = 'OZON'
      AND mac."isEnabled" = TRUE
    ORDER BY c."name" ASC
  `;

  if (!companyIds || companyIds.length === 0) return rows;

  const requested = new Set(companyIds);
  return rows.filter((row) => requested.has(row.companyId));
}

async function fetchOzonRealization(
  connection: OzonConnection,
  period: PeriodToSync
) {
  if (!connection.ozonClientId || !connection.ozonApiKey) {
    throw new Error(`Ozon Client-Id или Api-Key не сохранены для ${connection.companyName}`);
  }

  const response = await fetch("https://api-seller.ozon.ru/v2/finance/realization", {
    method: "POST",
    headers: {
      "Client-Id": connection.ozonClientId,
      "Api-Key": connection.ozonApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      month: period.month,
      year: period.year,
    }),
    cache: "no-store",
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Ozon realization API: ${response.status} ${text.slice(0, 1000)}`.trim()
    );
  }

  return JSON.parse(text) as OzonRealizationResponse;
}

async function fetchOzonTransactionTotals(
  connection: OzonConnection,
  period: PeriodToSync
) {
  if (!connection.ozonClientId || !connection.ozonApiKey) return null;

  const response = await fetch("https://api-seller.ozon.ru/v3/finance/transaction/totals", {
    method: "POST",
    headers: {
      "Client-Id": connection.ozonClientId,
      "Api-Key": connection.ozonApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      date: {
        from: `${period.dateFrom}T00:00:00.000Z`,
        to: `${period.dateTo}T23:59:59.999Z`,
      },
      transaction_type: "all",
    }),
    cache: "no-store",
  });

  if (!response.ok) return null;

  const json = await response.json().catch(() => null) as null | {
    result?: { accruals_for_sale?: number | null } | null;
  };

  return json?.result?.accruals_for_sale ?? null;
}

function parseOzonRealization(
  payload: OzonRealizationResponse,
  companyName: string,
  period: PeriodToSync
): ParsedOzonRealization {
  const rows = payload.result?.rows ?? [];
  const header = payload.result?.header ?? null;

  let realizedAmount = 0;
  let returnedAmount = 0;
  let grossPointsAccrued = 0;
  let grossPointsReturned = 0;
  let deliveryPartnerProgramsAmount = 0;
  let returnPartnerProgramsAmount = 0;

  for (const row of rows) {
    const delivery = row.delivery_commission;
    const returned = row.return_commission;

    realizedAmount += getCommissionAmount(delivery);
    returnedAmount += getCommissionAmount(returned);

    grossPointsAccrued += getBonusAmount(delivery);
    grossPointsReturned += getBonusAmount(returned);

    deliveryPartnerProgramsAmount += getPartnerProgramsAmount(delivery);
    returnPartnerProgramsAmount += getPartnerProgramsAmount(returned);
  }

  const taxableRevenue = realizedAmount - returnedAmount;
  const totalPaidByPoints = grossPointsAccrued - grossPointsReturned;
  const partnerProgramsAmount =
    deliveryPartnerProgramsAmount - returnPartnerProgramsAmount;

  return {
    reportNumber: header?.number ?? null,
    contractNumber: header?.contract_number ?? null,
    sourceFileName: `Ozon API /v2/finance/realization ${companyName} ${period.year}-${String(period.month).padStart(2, "0")}`,
    apiStartDate: header?.start_date ?? null,
    apiStopDate: header?.stop_date ?? null,
    rowsCount: rows.length,
    realizedAmount: roundMoney(realizedAmount),
    returnedAmount: roundMoney(returnedAmount),
    taxableRevenue: roundMoney(taxableRevenue),
    grossPointsAccrued: roundMoney(grossPointsAccrued),
    grossPointsReturned: roundMoney(grossPointsReturned),
    totalPaidByPoints: roundMoney(totalPaidByPoints),
    deliveryPartnerProgramsAmount: roundMoney(deliveryPartnerProgramsAmount),
    returnPartnerProgramsAmount: roundMoney(returnPartnerProgramsAmount),
    partnerProgramsAmount: roundMoney(partnerProgramsAmount),
  };
}

async function ensureOzonRealizationTables() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "OzonRealizationSummary" (
      "id" TEXT PRIMARY KEY,
      "importSessionId" TEXT,
      "companyName" TEXT,
      "dateFrom" TIMESTAMP NOT NULL,
      "dateTo" TIMESTAMP NOT NULL,
      "reportNumber" TEXT,
      "contractNumber" TEXT,
      "sourceFileName" TEXT,
      "realizedAmount" NUMERIC(65,30) DEFAULT 0,
      "returnedAmount" NUMERIC(65,30) DEFAULT 0,
      "taxableRevenue" NUMERIC(65,30) DEFAULT 0,
      "partnerProgramsAmount" NUMERIC(65,30) DEFAULT 0,
      "rowsCount" INTEGER DEFAULT 0,
      "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "OzonDiscountPointsSummary" (
      "id" TEXT PRIMARY KEY,
      "importSessionId" TEXT,
      "companyName" TEXT,
      "dateFrom" TIMESTAMP NOT NULL,
      "dateTo" TIMESTAMP NOT NULL,
      "sourceFileName" TEXT,
      "pointsAccrued" NUMERIC(65,30) DEFAULT 0,
      "pointsWrittenOff" NUMERIC(65,30) DEFAULT 0,
      "commissionPaidByPoints" NUMERIC(65,30) DEFAULT 0,
      "logisticsPaidByPoints" NUMERIC(65,30) DEFAULT 0,
      "fboPaidByPoints" NUMERIC(65,30) DEFAULT 0,
      "advertisingPaidByPoints" NUMERIC(65,30) DEFAULT 0,
      "otherPaidByPoints" NUMERIC(65,30) DEFAULT 0,
      "totalPaidByPoints" NUMERIC(65,30) DEFAULT 0,
      "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "OzonDiscountPointsRow" (
      "id" TEXT PRIMARY KEY,
      "summaryId" TEXT,
      "importSessionId" TEXT,
      "companyName" TEXT,
      "dateFrom" TIMESTAMP NOT NULL,
      "dateTo" TIMESTAMP NOT NULL,
      "category" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "amount" NUMERIC(65,30) DEFAULT 0,
      "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "OzonRealizationSummary_companyName_idx" ON "OzonRealizationSummary" ("companyName")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "OzonRealizationSummary_dateFrom_idx" ON "OzonRealizationSummary" ("dateFrom")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "OzonRealizationSummary_dateTo_idx" ON "OzonRealizationSummary" ("dateTo")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "OzonDiscountPointsSummary_companyName_idx" ON "OzonDiscountPointsSummary" ("companyName")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "OzonDiscountPointsSummary_dateFrom_idx" ON "OzonDiscountPointsSummary" ("dateFrom")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "OzonDiscountPointsSummary_dateTo_idx" ON "OzonDiscountPointsSummary" ("dateTo")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "OzonDiscountPointsRow_companyName_idx" ON "OzonDiscountPointsRow" ("companyName")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "OzonDiscountPointsRow_dateFrom_idx" ON "OzonDiscountPointsRow" ("dateFrom")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "OzonDiscountPointsRow_dateTo_idx" ON "OzonDiscountPointsRow" ("dateTo")`);
}

async function replaceSummaryRows(
  companyName: string,
  period: PeriodToSync,
  parsed: ParsedOzonRealization
) {
  const realizationId = `ozr_${randomUUID()}`;
  const pointsId = `ozp_${randomUUID()}`;

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      DELETE FROM "OzonRealizationSummary"
      WHERE "companyName" = ${companyName}
        AND "dateFrom"::date = CAST(${period.dateFrom} AS date)
        AND "dateTo"::date = CAST(${period.dateTo} AS date)
    `;

    await tx.$executeRaw`
      DELETE FROM "OzonDiscountPointsRow"
      WHERE "companyName" = ${companyName}
        AND "dateFrom"::date = CAST(${period.dateFrom} AS date)
        AND "dateTo"::date = CAST(${period.dateTo} AS date)
    `;

    await tx.$executeRaw`
      DELETE FROM "OzonDiscountPointsSummary"
      WHERE "companyName" = ${companyName}
        AND "dateFrom"::date = CAST(${period.dateFrom} AS date)
        AND "dateTo"::date = CAST(${period.dateTo} AS date)
    `;

    await tx.$executeRaw`
      INSERT INTO "OzonRealizationSummary" (
        "id", "companyName", "dateFrom", "dateTo", "reportNumber", "contractNumber", "sourceFileName",
        "realizedAmount", "returnedAmount", "taxableRevenue", "partnerProgramsAmount", "rowsCount"
      )
      VALUES (
        ${realizationId}, ${companyName}, CAST(${period.dateFrom} AS date), CAST(${period.dateTo} AS date),
        ${parsed.reportNumber}, ${parsed.contractNumber}, ${parsed.sourceFileName},
        ${parsed.realizedAmount}, ${parsed.returnedAmount}, ${parsed.taxableRevenue}, ${parsed.partnerProgramsAmount}, ${parsed.rowsCount}
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
        ${pointsId}, ${companyName}, CAST(${period.dateFrom} AS date), CAST(${period.dateTo} AS date), ${parsed.sourceFileName},
        ${parsed.grossPointsAccrued}, ${parsed.grossPointsReturned},
        0, 0, 0,
        0, ${parsed.totalPaidByPoints}, ${parsed.totalPaidByPoints}
      )
    `;

    await tx.$executeRaw`
      INSERT INTO "OzonDiscountPointsRow" (
        "id", "summaryId", "companyName", "dateFrom", "dateTo", "category", "name", "amount"
      )
      VALUES (
        ${`ozpr_${randomUUID()}`}, ${pointsId}, ${companyName}, CAST(${period.dateFrom} AS date), CAST(${period.dateTo} AS date),
        'DISCOUNT_POINTS', 'Баллы за скидки по API Ozon realization', ${parsed.totalPaidByPoints}
      )
    `;
  });
}

async function syncCompanyPeriod(connection: OzonConnection, period: PeriodToSync) {
  const payload = await fetchOzonRealization(connection, period);
  const parsed = parseOzonRealization(payload, connection.companyName, period);
  const transactionTotalsAccrualsForSale = await fetchOzonTransactionTotals(connection, period);

  const economicTurnover = roundMoney(
    parsed.taxableRevenue + parsed.totalPaidByPoints + parsed.partnerProgramsAmount
  );

  await replaceSummaryRows(connection.companyName, period, parsed);

  return {
    companyName: connection.companyName,
    period: {
      label: period.label,
      dateFrom: period.dateFrom,
      dateTo: period.dateTo,
      apiMonth: period.month,
      apiYear: period.year,
      apiStartDate: parsed.apiStartDate,
      apiStopDate: parsed.apiStopDate,
    },
    rowsCount: parsed.rowsCount,
    taxableRevenue: parsed.taxableRevenue,
    pointsAccruedGross: parsed.grossPointsAccrued,
    pointsReturnedGross: parsed.grossPointsReturned,
    discountPointsAmount: parsed.totalPaidByPoints,
    partnerProgramsAmount: parsed.partnerProgramsAmount,
    economicTurnover,
    transactionTotalsAccrualsForSale,
    differenceVsTransactionTotals:
      transactionTotalsAccrualsForSale === null
        ? null
        : roundMoney(economicTurnover - transactionTotalsAccrualsForSale),
  };
}

export async function GET(request: Request) {
  const cronDenied = rejectUnauthorizedCron(request);
  if (cronDenied) return cronDenied;
  const startedAt = new Date();
  const periods = buildPeriods(startedAt);

  await ensureOzonRealizationTables();

  const connections = await getOzonConnections();
  const results = [];

  for (const connection of connections) {
    for (const period of periods) {
      try {
        const result = await syncCompanyPeriod(connection, period);
        results.push({ ok: true, ...result });
      } catch (error) {
        results.push({
          ok: false,
          companyName: connection.companyName,
          period,
          error: getErrorMessage(error),
        });
      }
    }
  }

  const failed = results.filter((item) => !item.ok);

  return NextResponse.json({
    ok: failed.length === 0,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    periods,
    companies: connections.map((connection) => connection.companyName),
    results,
  });
}
