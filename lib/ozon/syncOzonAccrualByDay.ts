import { createHash, randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import {
  fetchOzonAccrualByDayRange,
  mapOzonAccrualByDay,
  type OzonAccrualApiDayEnvelope,
  type OzonAccrualByDayFact,
  type OzonAccrualByDayResult,
} from "@/lib/ozon/accrualByDay";
import type { OzonAccrualIngestPlan } from "@/lib/ozon/accrualIngestPolicy";
import {
  planCanonicalOzonAccrualPersist,
  validateOzonAccrualIngest,
  unexplainedOzonGrossDifference,
} from "@/lib/ozon/accrualIngestValidation";
import { persistRawThenCanonical } from "@/lib/ozon/accrualTwoPhasePersist";
import {
  buildCanonicalOzonDayStatuses,
  buildRawOzonDayStatuses,
  upsertOzonDayStatusRecords,
  type OzonAccrualDayStatusRecord,
} from "@/lib/ozon/accrualDayStatus";
import { persistOzonAccrualDayStatuses } from "@/lib/ozon/accrualDayStatusStore";
import { prisma } from "@/lib/prisma";
import {
  shouldInvalidateProfit,
  shouldInvalidateSnapshots,
} from "@/lib/ozon/historicalRepairInvalidationPolicy";

export {
  unexplainedOzonGrossDifference,
  validateOzonAccrualIngest,
  planCanonicalOzonAccrualPersist,
} from "@/lib/ozon/accrualIngestValidation";
export { persistRawThenCanonical } from "@/lib/ozon/accrualTwoPhasePersist";

// Same constant as the proven pre-V6 production overlay. Inlined because
// Financial Core V6 app source no longer ships lib/dashboard/periodSnapshot.ts.
const DASHBOARD_PERIOD_SNAPSHOT_FORMULA_VERSION =
  "FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1";

type SyncOzonAccrualByDayParams = {
  companyId: string;
  companyName: string;
  clientId: string;
  apiKey: string;
  dateFrom: Date;
  dateTo: Date;
};

type EconomicDaySplit = {
  date: string;
  realizedAmount: number;
  returnedAmount: number;
  pointsAccrued: number;
  pointsWrittenOff: number;
  partnerProgramsAmount: number;
};

type SnapshotKey = {
  companyScope: string;
  dateFrom: Date;
  dateTo: Date;
  formulaVersion: string;
};

type UnknownRecord = Record<string, unknown>;

const TARGET_TABLES = [
  "OzonFinancialCategoryFact",
  "OzonRealizationRow",
  "OzonRealizationSummary",
  "OzonDiscountPointsRow",
  "OzonDiscountPointsSummary",
] as const;

const SNAPSHOT_REQUEUE_PRIORITY = 995_000;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function startOfUtcDay(value: Date) {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

function formatDateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function decimalToCents(value: unknown) {
  const raw = isRecord(value) ? value.amount : value;

  if (typeof raw === "number") {
    return Number.isFinite(raw) ? Math.round(raw * 100) : 0;
  }

  let text = String(raw ?? "").trim().replace(/\s+/g, "").replace(",", ".");
  if (!text) return 0;

  let sign = 1;
  if (text.startsWith("-")) {
    sign = -1;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }

  if (!/^\d+(?:\.\d+)?$/.test(text)) return 0;

  const [whole, fraction = ""] = text.split(".");
  const firstThree = `${fraction}000`.slice(0, 3);
  let cents = Number(whole) * 100 + Number(firstThree.slice(0, 2));
  if (Number(firstThree[2]) >= 5) cents += 1;

  return sign * cents;
}

function centsToMoney(value: number) {
  return value / 100;
}

function getMoneyCents(record: UnknownRecord, key: string) {
  return decimalToCents(record[key]);
}

function buildEconomicDaySplits(accruals: unknown[]) {
  const days = new Map<string, {
    realizedCents: number;
    returnedCents: number;
    pointsAccruedCents: number;
    pointsWrittenOffCents: number;
    partnerProgramsCents: number;
  }>();

  for (const value of accruals) {
    if (!isRecord(value)) continue;
    const date = String(value.date ?? "").trim();
    if (!date) continue;

    const current = days.get(date) ?? {
      realizedCents: 0,
      returnedCents: 0,
      pointsAccruedCents: 0,
      pointsWrittenOffCents: 0,
      partnerProgramsCents: 0,
    };

    const posting = isRecord(value.posting) ? value.posting : null;
    const products = Array.isArray(posting?.products) ? posting.products : [];

    for (const productValue of products) {
      if (!isRecord(productValue)) continue;
      const commission = isRecord(productValue.commission)
        ? productValue.commission
        : null;
      if (!commission) continue;

      const saleCents = getMoneyCents(commission, "sale_price");
      if (saleCents >= 0) current.realizedCents += saleCents;
      else current.returnedCents += Math.abs(saleCents);

      const bonusCents = getMoneyCents(commission, "bonus");
      if (bonusCents >= 0) current.pointsAccruedCents += bonusCents;
      else current.pointsWrittenOffCents += Math.abs(bonusCents);

      current.partnerProgramsCents += getMoneyCents(commission, "coinvestment");
    }

    days.set(date, current);
  }

  return new Map<string, EconomicDaySplit>(
    [...days.entries()].map(([date, value]) => [
      date,
      {
        date,
        realizedAmount: centsToMoney(value.realizedCents),
        returnedAmount: centsToMoney(value.returnedCents),
        pointsAccrued: centsToMoney(value.pointsAccruedCents),
        pointsWrittenOff: centsToMoney(value.pointsWrittenOffCents),
        partnerProgramsAmount: centsToMoney(value.partnerProgramsCents),
      },
    ]),
  );
}

function createId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function legacyCompatibleFactMetadata(fact: OzonAccrualByDayFact) {
  if (Number(fact.sourceTypeId) === 41) {
    return {
      sourceOperationType: "Оплата за клик",
      sourceOperationCode: "OperationMarketplaceCostPerClick",
      sourceServiceName: "",
    };
  }

  if (Number(fact.sourceTypeId) === 54) {
    return {
      sourceOperationType: "Продвижение с оплатой за заказ",
      sourceOperationCode: "OperationPromotionWithCostPerOrder",
      sourceServiceName: "",
    };
  }

  if (fact.sourceTypeId === null && fact.sourceKind === "COMMISSION") {
    return {
      sourceOperationType: "Вознаграждение за продажу",
      sourceOperationCode: "SaleCommission",
      sourceServiceName: "",
    };
  }

  return {
    sourceOperationType: fact.sourceTypeDescription ?? fact.sourceKind,
    sourceOperationCode:
      fact.sourceTypeName ??
      (fact.sourceTypeId === null
        ? "SALE_COMMISSION"
        : `TYPE_${fact.sourceTypeId}`),
    sourceServiceName: fact.eventKey,
  };
}

function buildCategoryRows(params: {
  companyName: string;
  importSessionId: string;
  dateFrom: Date;
  dateTo: Date;
  facts: OzonAccrualByDayFact[];
}) {
  const dateFromText = formatDateOnly(params.dateFrom);
  const dateToText = formatDateOnly(params.dateTo);

  return params.facts.map((fact) => ({
    id: createId("ozapi"),
    importSessionId: params.importSessionId,
    companyName: params.companyName,
    operationDate: `${fact.date}T12:00:00.000Z`,
    dateFrom: `${dateFromText}T00:00:00.000Z`,
    dateTo: `${dateToText}T23:59:59.999Z`,
    ...legacyCompatibleFactMetadata(fact),
    category: fact.category,
    amount: fact.amount,
    includeInProfit: fact.includeInProfit,
    isCashFlowOnly: fact.isCashFlowOnly,
    isCompensation: fact.isCompensation,
  }));
}

async function insertCategoryRows(
  tx: Prisma.TransactionClient,
  rows: ReturnType<typeof buildCategoryRows>,
) {
  const chunkSize = 500;

  for (let index = 0; index < rows.length; index += chunkSize) {
    const part = rows.slice(index, index + chunkSize);

    await tx.$executeRawUnsafe(
      `
        INSERT INTO "OzonFinancialCategoryFact" (
          "id", "importSessionId", "companyName", "operationDate", "dateFrom", "dateTo",
          "source", "sourceOperationType", "sourceOperationCode", "sourceServiceName",
          "category", "amount", "includeInProfit", "isCashFlowOnly", "isCompensation"
        )
        SELECT
          x."id",
          x."importSessionId",
          x."companyName",
          x."operationDate"::timestamptz,
          x."dateFrom"::timestamptz,
          x."dateTo"::timestamptz,
          'OZON_ACCRUAL_REPORT',
          x."sourceOperationType",
          x."sourceOperationCode",
          x."sourceServiceName",
          x."category",
          x."amount"::numeric,
          x."includeInProfit",
          x."isCashFlowOnly",
          x."isCompensation"
        FROM jsonb_to_recordset($1::jsonb) AS x(
          "id" text,
          "importSessionId" text,
          "companyName" text,
          "operationDate" text,
          "dateFrom" text,
          "dateTo" text,
          "sourceOperationType" text,
          "sourceOperationCode" text,
          "sourceServiceName" text,
          "category" text,
          "amount" numeric,
          "includeInProfit" boolean,
          "isCashFlowOnly" boolean,
          "isCompensation" boolean
        )
      `,
      JSON.stringify(part),
    );
  }
}

async function deleteCanonicalAccrualRows(
  tx: Prisma.TransactionClient,
  params: { companyName: string; dates: string[] },
) {
  for (const day of params.dates) {
    await tx.$executeRawUnsafe(
      `
      DELETE FROM "OzonFinancialCategoryFact"
      WHERE "companyName" = $1
        AND "operationDate" >= $2::date
        AND "operationDate" < ($2::date + INTERVAL '1 day')
    `,
      params.companyName,
      day,
    );

    for (const table of [
      "OzonRealizationRow",
      "OzonRealizationSummary",
      "OzonDiscountPointsRow",
      "OzonDiscountPointsSummary",
    ]) {
      await tx.$executeRawUnsafe(
        `
        DELETE FROM "${table}"
        WHERE "companyName" = $1
          AND "dateFrom"::date = $2::date
          AND "dateTo"::date = $2::date
      `,
        params.companyName,
        day,
      );
    }
  }
}

async function insertEconomicDay(
  tx: Prisma.TransactionClient,
  params: {
    companyName: string;
    importSessionId: string;
    date: string;
    accrualRows: number;
    taxableRevenue: number;
    discountPointsAmount: number;
    split: EconomicDaySplit;
  },
) {
  const realizationSummaryId = createId("ozrapi");
  const pointsSummaryId = createId("ozpapi");
  const sourceName = `Ozon Accrual /by-day API ${params.companyName} ${params.date}`;

  await tx.$executeRawUnsafe(
    `
      INSERT INTO "OzonRealizationSummary" (
        "id", "importSessionId", "companyName", "dateFrom", "dateTo",
        "reportNumber", "contractNumber", "sourceFileName",
        "realizedAmount", "returnedAmount", "taxableRevenue",
        "partnerProgramsAmount", "rowsCount", "createdAt"
      ) VALUES (
        $1, $2, $3, $4::date, $4::date,
        'OZON_ACCRUAL_BY_DAY_API', NULL, $5,
        $6, $7, $8, $9, $10, NOW()
      )
    `,
    realizationSummaryId,
    params.importSessionId,
    params.companyName,
    params.date,
    sourceName,
    params.split.realizedAmount,
    params.split.returnedAmount,
    params.taxableRevenue,
    params.split.partnerProgramsAmount,
    params.accrualRows,
  );

  await tx.$executeRawUnsafe(
    `
      INSERT INTO "OzonRealizationRow" (
        "id", "summaryId", "importSessionId", "companyName",
        "dateFrom", "dateTo", "operationDate",
        "sku", "vendorCode", "productName",
        "realizedQty", "returnedQty", "netQty",
        "realizedAmount", "returnedAmount", "taxableRevenue",
        "partnerProgramsAmount", "createdAt"
      ) VALUES (
        $1, $2, $3, $4,
        $5::date, $5::date, $5::date,
        NULL, NULL, 'Итого по дню из Ozon Accrual /by-day API',
        0, 0, 0,
        $6, $7, $8, $9, NOW()
      )
    `,
    createId("ozrrapi"),
    realizationSummaryId,
    params.importSessionId,
    params.companyName,
    params.date,
    params.split.realizedAmount,
    params.split.returnedAmount,
    params.taxableRevenue,
    params.split.partnerProgramsAmount,
  );

  await tx.$executeRawUnsafe(
    `
      INSERT INTO "OzonDiscountPointsSummary" (
        "id", "importSessionId", "companyName", "dateFrom", "dateTo",
        "sourceFileName", "pointsAccrued", "pointsWrittenOff",
        "commissionPaidByPoints", "logisticsPaidByPoints", "fboPaidByPoints",
        "advertisingPaidByPoints", "otherPaidByPoints", "totalPaidByPoints", "createdAt"
      ) VALUES (
        $1, $2, $3, $4::date, $4::date, $5,
        $6, $7, 0, 0, 0, 0, $8, $8, NOW()
      )
    `,
    pointsSummaryId,
    params.importSessionId,
    params.companyName,
    params.date,
    sourceName,
    params.split.pointsAccrued,
    params.split.pointsWrittenOff,
    params.discountPointsAmount,
  );

  await tx.$executeRawUnsafe(
    `
      INSERT INTO "OzonDiscountPointsRow" (
        "id", "summaryId", "importSessionId", "companyName",
        "dateFrom", "dateTo", "category", "name", "amount", "createdAt"
      ) VALUES (
        $1, $2, $3, $4, $5::date, $5::date,
        'DISCOUNT_POINTS', 'Баллы за скидки Ozon из отчёта начислений', $6, NOW()
      )
    `,
    createId("ozprapi"),
    pointsSummaryId,
    params.importSessionId,
    params.companyName,
    params.date,
    params.discountPointsAmount,
  );
}

function snapshotKeyString(key: SnapshotKey) {
  return [
    key.companyScope,
    formatDateOnly(key.dateFrom),
    formatDateOnly(key.dateTo),
    key.formulaVersion,
  ].join("|");
}

async function invalidateFinancialSnapshots(
  tx: Prisma.TransactionClient,
  params: { companyName: string; dateFrom: Date; dateTo: Date },
) {
  const scopes = ["ALL", params.companyName];
  const formulaVersion = DASHBOARD_PERIOD_SNAPSHOT_FORMULA_VERSION;

  try {
    await tx.$executeRawUnsafe(
      `LOCK TABLE "DashboardPeriodSnapshotJob" IN SHARE ROW EXCLUSIVE MODE`,
    );
    await tx.$executeRawUnsafe(
      `LOCK TABLE "DashboardPeriodSnapshot" IN SHARE ROW EXCLUSIVE MODE`,
    );
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    if (/does not exist|undefined_table/i.test(message)) {
      return {
        deletedSnapshots: 0,
        requeuedJobs: 0,
        keys: [] as Array<{
          companyScope: string;
          dateFrom: string;
          dateTo: string;
          formulaVersion: string;
        }>,
      };
    }
    throw error;
  }

  const snapshots = await tx.$queryRaw<SnapshotKey[]>`
    SELECT "companyScope", "dateFrom", "dateTo", "formulaVersion"
    FROM "DashboardPeriodSnapshot"
    WHERE "formulaVersion" = ${formulaVersion}
      AND "companyScope" IN (${Prisma.join(scopes)})
      AND "dateFrom" <= ${params.dateTo}
      AND "dateTo" >= ${params.dateFrom}
  `;

  const jobs = await tx.$queryRaw<SnapshotKey[]>`
    SELECT "companyScope", "dateFrom", "dateTo", "formulaVersion"
    FROM "DashboardPeriodSnapshotJob"
    WHERE "formulaVersion" = ${formulaVersion}
      AND "companyScope" IN (${Prisma.join(scopes)})
      AND "dateFrom" <= ${params.dateTo}
      AND "dateTo" >= ${params.dateFrom}
  `;

  const keyMap = new Map<string, SnapshotKey>();
  for (const row of [...snapshots, ...jobs]) {
    const key: SnapshotKey = {
      companyScope: row.companyScope,
      dateFrom: row.dateFrom,
      dateTo: row.dateTo,
      formulaVersion: row.formulaVersion,
    };
    keyMap.set(snapshotKeyString(key), key);
  }

  await tx.$executeRaw`
    DELETE FROM "DashboardPeriodSnapshot"
    WHERE "formulaVersion" = ${formulaVersion}
      AND "companyScope" IN (${Prisma.join(scopes)})
      AND "dateFrom" <= ${params.dateTo}
      AND "dateTo" >= ${params.dateFrom}
  `;

  for (const key of keyMap.values()) {
    const id = createId("dpsjob");
    await tx.$executeRaw`
      INSERT INTO "DashboardPeriodSnapshotJob" (
        "id", "companyScope", "dateFrom", "dateTo", "formulaVersion",
        "status", "priority", "attempts", "maxAttempts",
        "lockedAt", "lockedBy", "nextAttemptAt", "startedAt", "finishedAt", "lastError",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${id}, ${key.companyScope}, ${key.dateFrom}, ${key.dateTo}, ${key.formulaVersion},
        ${"PENDING"}, ${SNAPSHOT_REQUEUE_PRIORITY}, ${0}, ${3},
        NULL, NULL, NULL, NULL, NULL, NULL,
        NOW(), NOW()
      )
      ON CONFLICT ("companyScope", "dateFrom", "dateTo", "formulaVersion")
      DO UPDATE SET
        "status" = ${"PENDING"},
        "priority" = ${SNAPSHOT_REQUEUE_PRIORITY},
        "attempts" = ${0},
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "nextAttemptAt" = NULL,
        "startedAt" = NULL,
        "finishedAt" = NULL,
        "lastError" = NULL,
        "updatedAt" = NOW()
    `;
  }

  return {
    deletedSnapshots: snapshots.length,
    requeuedJobs: keyMap.size,
    keys: [...keyMap.values()].map((key) => ({
      companyScope: key.companyScope,
      dateFrom: formatDateOnly(key.dateFrom),
      dateTo: formatDateOnly(key.dateTo),
      formulaVersion: key.formulaVersion,
    })),
  };
}

export type OzonAccrualRawRecord = {
  id: string;
  companyName: string;
  dateFrom: string;
  dateTo: string;
  payloadSha256: string;
  requestedDates: string[];
  dayEnvelopes: OzonAccrualApiDayEnvelope[];
  pagesByDay: Record<string, number>;
  rawAccruals: unknown[];
  unknownTypes: OzonAccrualByDayResult["diagnostics"]["unknownMeaningfulTypeIds"];
};

export type OzonAccrualCanonicalWrite = {
  importSessionId: string;
  factCount: number;
  ingestStatus: OzonAccrualIngestPlan["status"];
  coverageComplete: boolean;
  snapshotInvalidation: {
    deletedSnapshots: number;
    requeuedJobs: number;
    keys: Array<{
      companyScope: string;
      dateFrom: string;
      dateTo: string;
      formulaVersion: string;
    }>;
    deferred?: boolean;
  };
};

/**
 * NORMAL (default): per-persist snapshot + profit invalidation (cron/API).
 * DEFERRED_OWNER_REPAIR: persist raw/canonical/day-status only; invalidation
 * must be performed later by the sealed historical repair runner post-batch.
 * Cron/API paths MUST leave this unset / NORMAL.
 */
export type OzonAccrualInvalidationMode = "NORMAL" | "DEFERRED_OWNER_REPAIR";

export type OzonAccrualPersistCanonicalParams = {
  raw: OzonAccrualRawRecord;
  mapped: OzonAccrualByDayResult;
  ingestPlan: OzonAccrualIngestPlan;
  companyName: string;
  dateFrom: Date;
  dateTo: Date;
  invalidationMode?: OzonAccrualInvalidationMode;
};

export type OzonAccrualRuntimeStore = {
  commitRaw: (record: OzonAccrualRawRecord) => Promise<OzonAccrualRawRecord>;
  loadRaw: (id: string) => Promise<OzonAccrualRawRecord | null>;
  persistCanonical: (
    params: OzonAccrualPersistCanonicalParams,
  ) => Promise<OzonAccrualCanonicalWrite>;
};

function payloadHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createMemoryOzonAccrualStore(hooks?: {
  beforeCommitRaw?: () => void | Promise<void>;
  beforePersistCanonical?: () => void | Promise<void>;
}): OzonAccrualRuntimeStore & {
  rawById: Map<string, OzonAccrualRawRecord>;
  dayStatuses: Map<string, OzonAccrualDayStatusRecord>;
  canonicalWrites: OzonAccrualCanonicalWrite[];
  canonicalCallCount: number;
} {
  const rawById = new Map<string, OzonAccrualRawRecord>();
  const dayStatuses = new Map<string, OzonAccrualDayStatusRecord>();
  const canonicalWrites: OzonAccrualCanonicalWrite[] = [];
  const store = {
    rawById,
    dayStatuses,
    canonicalWrites,
    canonicalCallCount: 0,
    async commitRaw(record: OzonAccrualRawRecord) {
      await hooks?.beforeCommitRaw?.();
      rawById.set(record.id, structuredClone(record));
      upsertOzonDayStatusRecords(
        dayStatuses,
        buildRawOzonDayStatuses({
          companyName: record.companyName,
          dates: record.requestedDates,
          importSessionId: record.id,
          payloadSha256: record.payloadSha256,
          quarantineCount: record.unknownTypes.length,
        }),
      );
      return structuredClone(record);
    },
    async loadRaw(id: string) {
      const row = rawById.get(id);
      return row ? structuredClone(row) : null;
    },
    async persistCanonical(params: OzonAccrualPersistCanonicalParams) {
      store.canonicalCallCount += 1;
      await hooks?.beforePersistCanonical?.();
      upsertOzonDayStatusRecords(
        dayStatuses,
        buildCanonicalOzonDayStatuses({
          companyName: params.companyName,
          dates: params.raw.requestedDates,
          importSessionId: params.raw.id,
          payloadSha256: params.raw.payloadSha256,
          dataMode: params.ingestPlan.status,
          coverageComplete: params.ingestPlan.coverageComplete,
          quarantineCount: params.ingestPlan.quarantine.length,
        }),
      );
      const write: OzonAccrualCanonicalWrite = {
        importSessionId: params.raw.id,
        factCount: params.mapped.facts.length,
        ingestStatus: params.ingestPlan.status,
        coverageComplete: params.ingestPlan.coverageComplete,
        snapshotInvalidation: {
          deletedSnapshots: 0,
          requeuedJobs: 0,
          keys: [],
        },
      };
      canonicalWrites.push(write);
      return write;
    },
  };
  return store;
}

function previewFromRaw(params: {
  raw: OzonAccrualRawRecord;
  mapped: OzonAccrualByDayResult;
  ingestPlan: OzonAccrualIngestPlan;
  snapshotInvalidation?: OzonAccrualCanonicalWrite["snapshotInvalidation"];
  phase: "RAW" | "CANONICAL";
}) {
  return {
    phase: params.phase,
    endpoint: "/v1/finance/accrual/by-day",
    dateFrom: params.raw.dateFrom,
    dateTo: params.raw.dateTo,
    payloadSha256: params.raw.payloadSha256,
    pagesByDay: params.raw.pagesByDay,
    dayEnvelopes: params.raw.dayEnvelopes,
    rawAccruals: params.raw.rawAccruals,
    requestedDates: params.raw.requestedDates,
    coverageComplete: params.ingestPlan.coverageComplete,
    failFinality: params.ingestPlan.failFinality,
    ingestStatus: params.ingestPlan.status,
    quarantine: params.ingestPlan.quarantine,
    replayAfterMapperUpdate: params.ingestPlan.replayAfterMapperUpdate,
    rawAccrualCount: params.raw.rawAccruals.length,
    totals: params.mapped.totals,
    diagnostics: params.mapped.diagnostics,
    snapshotInvalidation: params.snapshotInvalidation ?? null,
  } as Prisma.InputJsonValue;
}

export function createPrismaOzonAccrualStore(): OzonAccrualRuntimeStore {
  return {
    async commitRaw(record) {
      await prisma.importSession.create({
        data: {
          id: record.id,
          fileName: `Ozon Accrual /by-day API ${record.companyName} ${record.dateFrom} - ${record.dateTo}`,
          reportType: "OZON_ACCRUAL_BY_DAY_API",
          marketplace: "OZON",
          companyName: record.companyName,
          rowsCount: record.rawAccruals.length,
          previewJson: {
            phase: "RAW",
            endpoint: "/v1/finance/accrual/by-day",
            dateFrom: record.dateFrom,
            dateTo: record.dateTo,
            payloadSha256: record.payloadSha256,
            pagesByDay: record.pagesByDay,
            dayEnvelopes: record.dayEnvelopes,
            rawAccruals: record.rawAccruals,
            requestedDates: record.requestedDates,
            unknownTypes: record.unknownTypes,
            rawAccrualCount: record.rawAccruals.length,
          } as Prisma.InputJsonValue,
          sheetName: "Ozon /by-day API",
          headerRow: 1,
          status: "RAW_PERSISTED",
        },
      });
      await persistOzonAccrualDayStatuses(
        buildRawOzonDayStatuses({
          companyName: record.companyName,
          dates: record.requestedDates,
          importSessionId: record.id,
          payloadSha256: record.payloadSha256,
          quarantineCount: record.unknownTypes.length,
        }),
      );
      return record;
    },
    async loadRaw(id) {
      const row = await prisma.importSession.findUnique({ where: { id } });
      if (!row?.previewJson || typeof row.previewJson !== "object") return null;
      const preview = row.previewJson as Record<string, unknown>;
      return {
        id: row.id,
        companyName: row.companyName ?? "",
        dateFrom: String(preview.dateFrom ?? ""),
        dateTo: String(preview.dateTo ?? ""),
        payloadSha256: String(preview.payloadSha256 ?? ""),
        requestedDates: Array.isArray(preview.requestedDates)
          ? preview.requestedDates.map((item) => String(item))
          : [],
        dayEnvelopes: Array.isArray(preview.dayEnvelopes)
          ? (preview.dayEnvelopes as OzonAccrualApiDayEnvelope[])
          : [],
        pagesByDay:
          preview.pagesByDay && typeof preview.pagesByDay === "object"
            ? (preview.pagesByDay as Record<string, number>)
            : {},
        rawAccruals: Array.isArray(preview.rawAccruals) ? preview.rawAccruals : [],
        unknownTypes: Array.isArray(preview.unknownTypes)
          ? (preview.unknownTypes as OzonAccrualRawRecord["unknownTypes"])
          : [],
      };
    },
    async persistCanonical(params: OzonAccrualPersistCanonicalParams) {
      const invalidationMode = params.invalidationMode ?? "NORMAL";
      const persistPlan = planCanonicalOzonAccrualPersist({
        mapped: params.mapped,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        requestedDates: params.raw.requestedDates,
      });
      const persistDateSet = new Set(persistPlan.persistDates);
      const categoryRows = buildCategoryRows({
        companyName: params.companyName,
        importSessionId: params.raw.id,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        facts: params.mapped.facts.filter((fact) => persistDateSet.has(fact.date)),
      });
      const splitByDay = buildEconomicDaySplits(params.raw.rawAccruals);

      const snapshotInvalidation = await prisma.$transaction(
        async (tx) => {
          for (const table of TARGET_TABLES) {
            await tx.$executeRawUnsafe(
              `LOCK TABLE "${table}" IN SHARE ROW EXCLUSIVE MODE`,
            );
          }

          await deleteCanonicalAccrualRows(tx, {
            companyName: params.companyName,
            dates: persistPlan.persistDates,
          });
          await insertCategoryRows(tx, categoryRows);

          for (const day of params.mapped.days.filter((d) => persistDateSet.has(d.date))) {
            const split = splitByDay.get(day.date);
            if (!split) {
              throw new Error(`Ozon /by-day economic split missing for ${day.date}`);
            }
            await insertEconomicDay(tx, {
              companyName: params.companyName,
              importSessionId: params.raw.id,
              date: day.date,
              accrualRows: params.raw.rawAccruals.filter(
                (value) => isRecord(value) && String(value.date ?? "") === day.date,
              ).length,
              taxableRevenue: day.taxableRevenue,
              discountPointsAmount: day.discountPointsAmount,
              split,
            });
          }

          const invalidation = !shouldInvalidateSnapshots(invalidationMode)
              ? {
                  deletedSnapshots: 0,
                  requeuedJobs: 0,
                  keys: [] as Array<{
                    companyScope: string;
                    dateFrom: string;
                    dateTo: string;
                    formulaVersion: string;
                  }>,
                  deferred: true as const,
                }
              : await invalidateFinancialSnapshots(tx, {
                  companyName: params.companyName,
                  dateFrom: params.dateFrom,
                  dateTo: params.dateTo,
                });

          await tx.importSession.update({
            where: { id: params.raw.id },
            data: {
              status: params.ingestPlan.status === "FINAL" ? "SUCCESS" : "PRELIMINARY",
              rowsCount: params.raw.rawAccruals.length,
              previewJson: previewFromRaw({
                raw: params.raw,
                mapped: params.mapped,
                ingestPlan: params.ingestPlan,
                snapshotInvalidation: invalidation,
                phase: "CANONICAL",
              }),
            },
          });

          await persistOzonAccrualDayStatuses(
            buildCanonicalOzonDayStatuses({
              companyName: params.companyName,
              dates: params.raw.requestedDates,
              importSessionId: params.raw.id,
              payloadSha256: params.raw.payloadSha256,
              dataMode: params.ingestPlan.status,
              coverageComplete: params.ingestPlan.coverageComplete,
              quarantineCount: params.ingestPlan.quarantine.length,
            }),
            tx,
          );

          return invalidation;
        },
        {
          maxWait: 20_000,
          timeout: 180_000,
        },
      );

      if (shouldInvalidateProfit(invalidationMode)) {
        const { safeInvalidateWaveBProfitReadModel } = await import(
          "@/lib/profitReadModel/invalidation"
        );
        await safeInvalidateWaveBProfitReadModel({
          prisma,
          marketplace: "OZON",
          companyScope: params.companyName,
          dateFrom: params.dateFrom.toISOString().slice(0, 10),
          dateTo: params.dateTo.toISOString().slice(0, 10),
        });
      }

      return {
        importSessionId: params.raw.id,
        factCount: params.mapped.facts.length,
        ingestStatus: params.ingestPlan.status,
        coverageComplete: params.ingestPlan.coverageComplete,
        snapshotInvalidation,
      };
    },
  };
}

export async function ingestOzonAccrualByDay(params: {
  companyId: string;
  companyName: string;
  clientId?: string;
  apiKey?: string;
  dateFrom: Date;
  dateTo: Date;
  store: OzonAccrualRuntimeStore;
  fetchRange?: (params: {
    credentials: { clientId: string; apiKey: string };
    dateFrom: string;
    dateTo: string;
    onCall?: (call: {
      endpoint: string;
      attempt: number;
      httpStatus: number | null;
      ok: boolean;
      retryAfter: string | null;
      responseBodySha256: string;
      responseBodyBytes: number;
    }) => void;
  }) => Promise<{
    accruals: unknown[];
    requestedDates: string[];
    dayEnvelopes: OzonAccrualApiDayEnvelope[];
    pagesByDay: Record<string, number>;
  }>;
  replayFromRawId?: string;
  mapAccruals?: typeof mapOzonAccrualByDay;
  /** Defaults NORMAL. Only sealed historical repair runner may pass DEFERRED_OWNER_REPAIR. */
  invalidationMode?: OzonAccrualInvalidationMode;
}) {
  const dateFrom = startOfUtcDay(params.dateFrom);
  const dateTo = startOfUtcDay(params.dateTo);
  const dateFromText = formatDateOnly(dateFrom);
  const dateToText = formatDateOnly(dateTo);
  const apiCalls: Array<Record<string, unknown>> = [];
  const mapAccruals = params.mapAccruals ?? mapOzonAccrualByDay;

  let fetched: {
    accruals: unknown[];
    requestedDates: string[];
    dayEnvelopes: OzonAccrualApiDayEnvelope[];
    pagesByDay: Record<string, number>;
  };
  let rawId = createId("impozapi");

  if (params.replayFromRawId) {
    const existing = await params.store.loadRaw(params.replayFromRawId);
    if (!existing) {
      throw new Error(`Ozon /by-day raw persist missing for ${params.replayFromRawId}`);
    }
    rawId = existing.id;
    fetched = {
      accruals: existing.rawAccruals,
      requestedDates: existing.requestedDates,
      dayEnvelopes: existing.dayEnvelopes,
      pagesByDay: existing.pagesByDay,
    };
  } else {
    const fetchRange = params.fetchRange ?? fetchOzonAccrualByDayRange;
    fetched = await fetchRange({
      credentials: {
        clientId: params.clientId ?? "",
        apiKey: params.apiKey ?? "",
      },
      dateFrom: dateFromText,
      dateTo: dateToText,
      onCall: (call) => {
        apiCalls.push({
          endpoint: call.endpoint,
          attempt: call.attempt,
          httpStatus: call.httpStatus,
          ok: call.ok,
          retryAfter: call.retryAfter,
          responseBodySha256: call.responseBodySha256,
          responseBodyBytes: call.responseBodyBytes,
        });
      },
    });
  }

  const mapped = mapAccruals({
    accruals: fetched.accruals,
    requestedDates: fetched.requestedDates,
    dayEnvelopes: fetched.dayEnvelopes,
  });

  const raw: OzonAccrualRawRecord = {
    id: rawId,
    companyName: params.companyName,
    dateFrom: dateFromText,
    dateTo: dateToText,
    payloadSha256: payloadHash({
      companyName: params.companyName,
      dateFrom: dateFromText,
      dateTo: dateToText,
      dayEnvelopes: fetched.dayEnvelopes,
      rawAccruals: fetched.accruals,
    }),
    requestedDates: fetched.requestedDates,
    dayEnvelopes: fetched.dayEnvelopes,
    pagesByDay: fetched.pagesByDay,
    rawAccruals: fetched.accruals,
    unknownTypes: mapped.diagnostics.unknownMeaningfulTypeIds,
  };

  const phaseResult: {
    ingestPlan: OzonAccrualIngestPlan | null;
    canonical: OzonAccrualCanonicalWrite | null;
    persistPlan: ReturnType<typeof planCanonicalOzonAccrualPersist> | null;
  } = { ingestPlan: null, canonical: null, persistPlan: null };

  await persistRawThenCanonical({
    persistRaw: async () => {
      if (!params.replayFromRawId) {
        await params.store.commitRaw(raw);
      }
    },
    persistCanonical: async () => {
      const persistPlan = planCanonicalOzonAccrualPersist({
        mapped,
        dateFrom,
        dateTo,
        requestedDates: fetched.requestedDates,
      });
      phaseResult.ingestPlan = persistPlan.ingestPlan;
      phaseResult.persistPlan = persistPlan;
      phaseResult.canonical = await params.store.persistCanonical({
        raw,
        mapped,
        ingestPlan: phaseResult.ingestPlan,
        companyName: params.companyName,
        dateFrom,
        dateTo,
        invalidationMode: params.invalidationMode ?? "NORMAL",
      });
    },
  });

  if (!phaseResult.ingestPlan || !phaseResult.canonical || !phaseResult.persistPlan) {
    throw new Error("Ozon /by-day canonical overlay failed: missing ingest result");
  }

  return {
    name: "Ozon Accrual /by-day",
    source: "OZON_ACCRUAL_BY_DAY_API",
    importSessionId: raw.id,
    dateFrom: dateFromText,
    dateTo: dateToText,
    accrualRows: fetched.accruals.length,
    pagesByDay: fetched.pagesByDay,
    coverageComplete: phaseResult.ingestPlan.coverageComplete,
    ingestStatus: phaseResult.ingestPlan.status,
    failFinality: phaseResult.ingestPlan.failFinality,
    quarantine: phaseResult.ingestPlan.quarantine,
    totals: mapped.totals,
    diagnostics: mapped.diagnostics,
    unexplainedGrossDifference: unexplainedOzonGrossDifference(mapped),
    windowPartial: phaseResult.persistPlan.windowPartial,
    persistedDays: phaseResult.persistPlan.persistDates,
    pendingDays: phaseResult.persistPlan.pendingDates,
    fakeZeroDates: phaseResult.persistPlan.fakeZeroDates,
    apiCalls,
    snapshotInvalidation: phaseResult.canonical.snapshotInvalidation,
    rawPersisted: true,
    canonicalPersisted: true,
  };
}

export async function replayOzonAccrualCanonicalFromRaw(params: {
  rawId: string;
  companyId: string;
  companyName: string;
  dateFrom: Date;
  dateTo: Date;
  store: OzonAccrualRuntimeStore;
  mapAccruals?: typeof mapOzonAccrualByDay;
  invalidationMode?: OzonAccrualInvalidationMode;
}) {
  return ingestOzonAccrualByDay({
    companyId: params.companyId,
    companyName: params.companyName,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    store: params.store,
    replayFromRawId: params.rawId,
    mapAccruals: params.mapAccruals,
    invalidationMode: params.invalidationMode ?? "NORMAL",
  });
}

export async function syncOzonAccrualByDayOverlay(
  params: SyncOzonAccrualByDayParams,
) {
  return ingestOzonAccrualByDay({
    ...params,
    store: createPrismaOzonAccrualStore(),
  });
}
