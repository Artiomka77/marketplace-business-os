/**
 * Real-Postgres end-to-end for the owner-gated Ozon historical financial repair.
 *
 * ozonHistoricalRepairExecutable.test.ts proves the orchestration contract with a
 * memory store. This file is the database half: EPHEMERAL_MEMORY_STORE stays unset,
 * so every phase runs through the real Prisma adapters in
 * lib/ozon/financialRepairProductionAdapters.ts against an ephemeral Postgres whose
 * schema is created by `prisma db push`.
 *
 * Fixtures are production-shaped: 78 source targets (2 companies x 39 days), 36 of
 * them already FINAL so the run must NOOP them, 10 standalone status-only
 * ImportSessions, 35 V4 period snapshots (20 with an existing SUCCESS job), 6 V2
 * period read-model rows (2 ALL + 4 company) and zero profit read-model overlap.
 *
 * The test is destructive (it truncates its fixture tables), so it only runs
 * against a local / explicitly allowed database. It skips with a message when
 * DATABASE_URL is missing or SKIP_POSTGRES_E2E=1; GitHub Actions runs it against
 * the postgres service container and gates on the emitted
 * FINANCIAL_REPAIR_POSTGRES_E2E_FINAL.json.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { Prisma } from "@prisma/client";

import {
  mapOzonAccrualByDay,
  type OzonAccrualApiDayEnvelope,
} from "../../lib/ozon/accrualByDay";
import {
  planCanonicalOzonAccrualPersist,
  unexplainedOzonGrossDifference,
} from "../../lib/ozon/accrualIngestValidation";
import {
  FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1,
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
  OZON_ACCRUAL_BY_DAY_REPORT_TYPE,
  SNAPSHOT_REQUEUE_PRIORITY,
  computeCertificationMapperResultHash,
  computeCertificationRawResponseHash,
  createMarketplaceApiConnectionCredentialLoader,
  rebuildV2PeriodTargets,
  type OzonRepairFetchRange,
} from "../../lib/ozon/financialRepairProductionAdapters";
import { prisma } from "../../lib/prisma";
import { WAVE_B_PROFIT_FORMULAS } from "../../lib/profitReadModel/contract";
import {
  OWNER_EXECUTE_MARKER,
  buildPrepareCacheManifestSha,
  prepareCacheTargetPayloadSha256,
  preparePrepareCacheLive,
  runCli,
  type PrepareCache,
  type PrepareCacheTarget,
  type SnapshotKey,
  type SourceTarget,
  type StatusOnlyTarget,
  type V2Target,
} from "../financialRepair/runOzonHistoricalFinancialRepair";

const DATABASE_URL = (process.env.DATABASE_URL ?? "").trim();

const COMPANIES = [
  {
    id: "cmp_e2e_petrov",
    name: "ИП Петров",
    connectionId: "conn_e2e_petrov",
    clientId: "ozon-client-e2e-petrov",
    apiKey: "ozon-key-e2e-petrov",
  },
  {
    id: "cmp_e2e_lebedeva",
    name: "ИП Лебедева",
    connectionId: "conn_e2e_lebedeva",
    clientId: "ozon-client-e2e-lebedeva",
    apiKey: "ozon-key-e2e-lebedeva",
  },
] as const;

const SOURCE_DAY_COUNT = 39;
const SOURCE_TARGET_COUNT = SOURCE_DAY_COUNT * COMPANIES.length; // 78
const SEEDED_NOOP_COUNT = 36;
const FRESH_PERSIST_COUNT = SOURCE_TARGET_COUNT - SEEDED_NOOP_COUNT; // 42
const STATUS_ONLY_COUNT = 10;
const SNAPSHOT_KEY_COUNT = 35;
const SNAPSHOT_JOBS_SEEDED = 20;
const V2_METRIC_ROWS = 6;

/** Truncated before the run; nothing outside this list is touched. */
const FIXTURE_TABLES = [
  "ImportSession",
  "OzonAccrualDayStatus",
  "OzonFinancialCategoryFact",
  "OzonRealizationRow",
  "OzonRealizationSummary",
  "OzonDiscountPointsRow",
  "OzonDiscountPointsSummary",
  "DashboardPeriodSnapshot",
  "DashboardPeriodSnapshotJob",
  "PeriodCompanyMarketplaceMetric",
  "DailyCompanyMarketplaceMetric",
  "ProfitPeriodMetric",
  "WbSale",
  "WbFinance",
  "MarketplaceApiConnection",
  "Company",
] as const;

function sha(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function shaFile(path: string): string {
  return sha(readFileSync(path));
}

function isoDay(offsetFromJune1: number): string {
  return new Date(Date.UTC(2026, 5, 1) + offsetFromJune1 * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Skips instead of running the destructive fixtures when no ephemeral database is
 * available. A remote host is refused unless the operator opts in explicitly.
 */
function postgresE2eSkipReason(): string | null {
  if (process.env.SKIP_POSTGRES_E2E === "1") {
    return "SKIP_POSTGRES_E2E=1";
  }
  if (!DATABASE_URL) {
    return "DATABASE_URL is not set: no ephemeral Postgres to run the repair against";
  }
  if (process.env.POSTGRES_E2E_ALLOW_NONLOCAL === "1") return null;
  let host = "";
  let database = "";
  try {
    const url = new URL(DATABASE_URL);
    host = url.hostname;
    database = url.pathname.replace(/^\//, "");
  } catch {
    return "DATABASE_URL is not a parseable URL";
  }
  const localHost = ["127.0.0.1", "localhost", "::1", "postgres"].includes(host);
  const ephemeralName = /(canary|ephemeral|e2e|test)/i.test(database);
  if (localHost || ephemeralName) return null;
  return (
    `refusing destructive fixtures against non-ephemeral DATABASE_URL ` +
    `host=${host} db=${database} (set POSTGRES_E2E_ALLOW_NONLOCAL=1 to override)`
  );
}

const SKIP_REASON = postgresE2eSkipReason();
if (SKIP_REASON) {
  console.log(`POSTGRES_E2E=SKIPPED reason=${SKIP_REASON}`);
}

/* ------------------------------------------------------------------ *
 * Stub Ozon transport (PREPARE) + certification seal
 * ------------------------------------------------------------------ */

function minimalAccrual(date: string, amount = -15) {
  return {
    accrual_id: Number(date.replace(/-/g, "")),
    date,
    total_amount: amount,
    non_item_fee: { type_id: 84, accrued: amount },
  };
}

function dayEnvelope(date: string, rawAccrualCount: number): OzonAccrualApiDayEnvelope {
  return {
    date,
    httpOk: true,
    pages: 1,
    paginationComplete: true,
    rawAccrualCount,
    explicitZeroDayEvidence: false,
  };
}

/** Exact bytes the stub transport returns, so page hashes are reproducible. */
function stubResponseBody(clientId: string, date: string): string {
  return JSON.stringify({
    client_id: clientId,
    result: { accruals: [minimalAccrual(date)] },
  });
}

/**
 * Builds a sealed target with the same hash recipes the certification fetcher used,
 * so PREPARE compares live-observed hashes against a manifest it did not produce.
 */
function sealCertifiedTarget(params: {
  companyId: string;
  companyName: string;
  connectionId: string;
  clientId: string;
  date: string;
}): SourceTarget {
  const { date } = params;
  const accruals = [minimalAccrual(date)];
  const pageHashes = [sha(stubResponseBody(params.clientId, date))];
  const rawResponseHash = computeCertificationRawResponseHash({
    date,
    pageHashes,
    count: accruals.length,
    paginationComplete: true,
  });
  const mapped = mapOzonAccrualByDay({
    accruals,
    requestedDates: [date],
    dayEnvelopes: [dayEnvelope(date, accruals.length)],
  });
  const day = new Date(`${date}T00:00:00.000Z`);
  const persistPlan = planCanonicalOzonAccrualPersist({
    mapped,
    dateFrom: day,
    dateTo: day,
    requestedDates: [date],
  });
  return {
    companyId: params.companyId,
    companyName: params.companyName,
    date,
    rawResponseHash,
    pageHashes,
    rowCount: accruals.length,
    fullMapperResultHash: computeCertificationMapperResultHash({
      mapped,
      ingestStatus: persistPlan.ingestPlan.status,
      unexplainedGross: unexplainedOzonGrossDifference(mapped),
    }),
    ACCOUNT_AUTHORITY_ID: params.connectionId,
    marketplaceApiConnectionId: params.connectionId,
    clientIdSha256: sha(params.clientId),
  };
}

/** Injected read-only transport: no socket is opened, hashes stay deterministic. */
const stubTransport = (async (params: {
  credentials: { clientId: string; apiKey: string };
  dateFrom: string;
  dateTo: string;
  onCall?: (call: {
    endpoint: string;
    requestBody: Record<string, unknown>;
    attempt: number;
    httpStatus: number | null;
    ok: boolean;
    retryAfter: string | null;
    responseBodySha256: string;
    responseBodyBytes: number;
  }) => void;
}) => {
  const date = params.dateFrom;
  const body = stubResponseBody(params.credentials.clientId, date);
  const accruals = [minimalAccrual(date)];
  params.onCall?.({
    endpoint: "/v1/finance/accrual/by-day",
    requestBody: { date, client_id: params.credentials.clientId },
    attempt: 1,
    httpStatus: 200,
    ok: true,
    retryAfter: null,
    responseBodySha256: sha(body),
    responseBodyBytes: Buffer.byteLength(body),
  });
  return {
    accruals,
    requestedDates: [date],
    dayEnvelopes: [dayEnvelope(date, accruals.length)],
    pagesByDay: { [date]: 1 },
  };
}) as unknown as OzonRepairFetchRange;

/* ------------------------------------------------------------------ *
 * Ephemeral schema + fixtures
 * ------------------------------------------------------------------ */

function pushEphemeralSchema(): { command: string; log: string } {
  if (process.env.POSTGRES_E2E_SKIP_PUSH === "1") {
    return { command: "SKIPPED_POSTGRES_E2E_SKIP_PUSH", log: "" };
  }
  // The CLI entry point is invoked directly instead of through npx: Node refuses to
  // spawn npx.cmd without a shell on Windows, and Prisma 7 dropped --skip-generate.
  const cli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");
  const args = [cli, "db", "push", "--accept-data-loss"];
  const command = `node node_modules/prisma/build/index.js db push --accept-data-loss`;
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });
  const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(
      `prisma db push failed (status=${result.status} error=${result.error?.message ?? "none"}): ${log}`,
    );
  }
  return { command, log };
}

/**
 * Production parity for the pushed schema.
 *
 * insertCategoryRows (lib/ozon/syncOzonAccrualByDay.ts) omits "createdAt", which
 * only works because the production OzonFinancialCategoryFact column carries a
 * NOW() default. schema.prisma declares that column without @default, so a database
 * created purely by `prisma db push` rejects every canonical fact insert. The gap is
 * closed here — and reported in the evidence — instead of being papered over by
 * changing the repair code.
 */
const SCHEMA_PARITY_STATEMENTS = [
  `ALTER TABLE "OzonFinancialCategoryFact" ALTER COLUMN "createdAt" SET DEFAULT NOW()`,
] as const;

async function applySchemaParity(): Promise<void> {
  for (const statement of SCHEMA_PARITY_STATEMENTS) {
    await prisma.$executeRawUnsafe(statement);
  }
}

async function truncateFixtureTables(): Promise<void> {
  const tables = FIXTURE_TABLES.map((name) => `"${name}"`).join(", ");
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`,
  );
}

async function seedCompaniesAndConnections(): Promise<void> {
  for (const company of COMPANIES) {
    await prisma.company.create({
      data: { id: company.id, name: company.name, isActive: true },
    });
    await prisma.marketplaceApiConnection.create({
      data: {
        id: company.connectionId,
        companyId: company.id,
        marketplace: "OZON",
        ozonClientId: company.clientId,
        ozonApiKey: company.apiKey,
        isEnabled: true,
        status: "CONNECTED",
      },
    });
  }
}

/** ImportSession previewJson shaped like a canonical /by-day persist. */
function canonicalPreviewJson(target: PrepareCacheTarget) {
  return {
    phase: "CANONICAL",
    endpoint: "/v1/finance/accrual/by-day",
    dateFrom: target.sealed.date,
    dateTo: target.sealed.date,
    payloadSha256: prepareCacheTargetPayloadSha256(target),
    pagesByDay: target.raw.pagesByDay,
    dayEnvelopes: target.raw.dayEnvelopes,
    rawAccruals: target.raw.accruals,
    requestedDates: target.raw.requestedDates,
    unknownTypes: [],
    rawAccrualCount: target.raw.accruals.length,
    coverageComplete: true,
    ingestStatus: "FINAL",
    quarantine: [],
  } as unknown as Prisma.InputJsonValue;
}

/** The 36 days the repair must recognise as already complete. */
async function seedAlreadyFinalDays(targets: PrepareCacheTarget[]): Promise<void> {
  for (const [index, target] of targets.entries()) {
    const sessionId = `impozapi_seed_${index}`;
    const payloadSha256 = prepareCacheTargetPayloadSha256(target);
    await prisma.importSession.create({
      data: {
        id: sessionId,
        fileName: `Ozon Accrual /by-day API ${target.sealed.companyName} ${target.sealed.date}`,
        reportType: OZON_ACCRUAL_BY_DAY_REPORT_TYPE,
        marketplace: "OZON",
        companyName: target.sealed.companyName,
        rowsCount: target.raw.accruals.length,
        previewJson: canonicalPreviewJson(target),
        sheetName: "Ozon /by-day API",
        headerRow: 1,
        status: "SUCCESS",
      },
    });
    await prisma.ozonAccrualDayStatus.create({
      data: {
        companyName: target.sealed.companyName,
        date: target.sealed.date,
        importSessionId: sessionId,
        dataMode: "FINAL",
        coverageComplete: true,
        quarantineCount: 0,
        missingEvidence: [],
        payloadSha256,
        phase: "CANONICAL",
      },
    });
  }
}

/** The 10 status-only targets: a SUCCESS session with no day status row yet. */
async function seedStatusOnlySessions(
  targets: StatusOnlyTarget[],
): Promise<void> {
  for (const target of targets) {
    await prisma.importSession.create({
      data: {
        id: target.importSessionId,
        fileName: `Ozon Accrual /by-day API ${target.company} ${target.date}`,
        reportType: OZON_ACCRUAL_BY_DAY_REPORT_TYPE,
        marketplace: "OZON",
        companyName: target.company,
        rowsCount: 1,
        previewJson: {
          phase: "CANONICAL",
          dateFrom: target.date,
          dateTo: target.date,
          payloadSha256: sha(`status-only|${target.company}|${target.date}`),
          quarantine: [],
          ingestStatus: "FINAL",
          coverageComplete: true,
        } as unknown as Prisma.InputJsonValue,
        sheetName: "Ozon /by-day API",
        headerRow: 1,
        status: "SUCCESS",
      },
    });
  }
}

async function seedSnapshotsAndJobs(keys: SnapshotKey[]): Promise<void> {
  const now = new Date("2026-09-20T00:00:00.000Z");
  for (const [index, key] of keys.entries()) {
    await prisma.dashboardPeriodSnapshot.create({
      data: {
        id: `dps_e2e_${index}`,
        companyScope: key.companyScope,
        dateFrom: new Date(`${key.dateFrom}T00:00:00.000Z`),
        dateTo: new Date(`${key.dateTo}T00:00:00.000Z`),
        formulaVersion: key.formulaVersion,
        payload: { stale: true, key: index } as unknown as Prisma.InputJsonValue,
        payloadChecksum: sha(`snapshot|${index}`),
        sourceFingerprint: sha(`fingerprint|${index}`),
        coverageStatus: "COMPLETE",
        rowsCount: 1,
        calculationMs: 10,
        generatedAt: now,
        updatedAt: now,
      },
    });
    if (index < SNAPSHOT_JOBS_SEEDED) {
      await prisma.dashboardPeriodSnapshotJob.create({
        data: {
          id: `dpsjob_e2e_${index}`,
          companyScope: key.companyScope,
          dateFrom: new Date(`${key.dateFrom}T00:00:00.000Z`),
          dateTo: new Date(`${key.dateTo}T00:00:00.000Z`),
          formulaVersion: key.formulaVersion,
          status: "SUCCESS",
          priority: 100,
          attempts: 1,
          maxAttempts: 3,
          finishedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
  }
}

/** 6 V2 read-model rows: 2 ALL + 4 company. The repair must not renumber them. */
async function seedV2PeriodRows(v2Targets: V2Target[]): Promise<void> {
  const generatedAt = new Date("2026-09-20T00:00:00.000Z");
  const scopes = ["ALL", ...COMPANIES.map((company) => company.name)];
  for (const target of v2Targets) {
    for (const companyScope of scopes) {
      await prisma.periodCompanyMarketplaceMetric.create({
        data: {
          companyScope,
          marketplace: "ALL",
          dateFrom: new Date(`${target.dateFrom}T00:00:00.000Z`),
          dateTo: new Date(`${target.dateTo}T00:00:00.000Z`),
          formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
          dataMode: companyScope === "ALL" ? "FINAL" : "PRELIMINARY",
          coverageStatus: companyScope === "ALL" ? "COMPLETE" : "PARTIAL",
          sourceFingerprint: sha(`v2|${companyScope}|${target.period}`),
          payloadChecksum: sha(`v2-payload|${companyScope}|${target.period}`),
          payload: {
            canonicalWb: target.expectedCanonicalWb,
            canonicalOzon: target.expectedCanonicalOzon,
            total: target.expectedTotal,
          } as unknown as Prisma.InputJsonValue,
          meta: { scope: companyScope } as unknown as Prisma.InputJsonValue,
          generatedAt,
        },
      });
    }
  }
}

/**
 * WB source ownership for the two V2 months. The production V6 repository refuses a
 * rebuild that is not D1/D5-safe, so the months need an exact finance cover with
 * persisted owner rows for every company the ALL scope enumerates.
 */
async function seedWbExactFinanceCover(v2Targets: V2Target[]): Promise<void> {
  let reportSeed = 7_100_001;
  for (const target of v2Targets) {
    for (const company of COMPANIES) {
      const reportNumber = String(reportSeed);
      reportSeed += 1;
      const sessionId = `imp_wb_${reportNumber}`;
      await prisma.importSession.create({
        data: {
          id: sessionId,
          fileName: `wb_sales_report_${reportNumber}.xlsx`,
          reportType: "WB_SALES",
          marketplace: "WB",
          companyName: company.name,
          rowsCount: 1,
          status: "SUCCESS",
        },
      });
      await prisma.wbFinance.create({
        data: {
          importSessionId: sessionId,
          companyName: company.name,
          reportNumber,
          dateFrom: new Date(`${target.dateFrom}T00:00:00.000Z`),
          dateTo: new Date(`${target.dateTo}T00:00:00.000Z`),
          reportTypeName: "Реализация",
        },
      });
      await prisma.wbSale.create({
        data: {
          importSessionId: sessionId,
          companyName: company.name,
          reportNumber,
          saleDate: new Date(`${target.dateFrom}T09:00:00.000Z`),
          quantity: 1,
          retailPrice: 1000,
          retailPriceWithDiscount: 900,
          wbRealizedAmount: 900,
          sellerPayout: 700,
          paymentReason: "Продажа",
        },
      });
    }
  }
}

/** Pre-existing profit job from before the repair window: VERIFY must ignore it. */
async function seedPreRepairProfitJob(target: V2Target): Promise<string> {
  const id = "dpsjob_profit_pre_existing";
  // Relative to the runner clock so the row is always outside the repair window.
  const createdAt = new Date(Date.now() - 30 * 86_400_000);
  await prisma.dashboardPeriodSnapshotJob.create({
    data: {
      id,
      companyScope: "ALL",
      dateFrom: new Date(`${target.dateFrom}T00:00:00.000Z`),
      dateTo: new Date(`${target.dateTo}T00:00:00.000Z`),
      formulaVersion: WAVE_B_PROFIT_FORMULAS[1],
      status: "SUCCESS",
      priority: 100,
      attempts: 1,
      maxAttempts: 3,
      createdAt,
      updatedAt: createdAt,
    },
  });
  return id;
}

/* ------------------------------------------------------------------ *
 * Database observation helpers
 * ------------------------------------------------------------------ */

async function countRows(table: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
    `SELECT COUNT(*)::int AS "count" FROM "${table}"`,
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Everything a repair phase could possibly change. Compared before/after the
 * phases that must not write, which is how "zero writes" is proven rather than
 * asserted.
 */
async function dbFingerprint(): Promise<string> {
  const counts: Record<string, number> = {};
  for (const table of FIXTURE_TABLES) {
    counts[table] = await countRows(table);
  }
  const dayStatuses = await prisma.$queryRaw<
    Array<{ dataMode: string; phase: string; count: number }>
  >`
    SELECT "dataMode", "phase", COUNT(*)::int AS "count"
    FROM "OzonAccrualDayStatus"
    GROUP BY 1, 2
    ORDER BY 1, 2
  `;
  const sessions = await prisma.$queryRaw<
    Array<{ reportType: string; status: string; count: number }>
  >`
    SELECT "reportType", "status", COUNT(*)::int AS "count"
    FROM "ImportSession"
    GROUP BY 1, 2
    ORDER BY 1, 2
  `;
  const jobs = await prisma.$queryRaw<
    Array<{ formulaVersion: string; status: string; priority: number; count: number }>
  >`
    SELECT "formulaVersion", "status", "priority", COUNT(*)::int AS "count"
    FROM "DashboardPeriodSnapshotJob"
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3
  `;
  const lastTouched = await prisma.$queryRaw<Array<{ touched: string | null }>>`
    SELECT COALESCE(MAX("updatedAt")::text, 'NONE') AS "touched"
    FROM "OzonAccrualDayStatus"
  `;
  return JSON.stringify({
    counts,
    dayStatuses,
    sessions,
    jobs,
    lastTouched: lastTouched[0]?.touched ?? "NONE",
  });
}

async function finalDayStatusCount(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS "count"
    FROM "OzonAccrualDayStatus"
    WHERE "dataMode" = 'FINAL'
      AND "coverageComplete" = true
      AND "phase" = 'CANONICAL'
  `;
  return Number(rows[0]?.count ?? 0);
}

async function distinctFactDays(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS "count"
    FROM (
      SELECT DISTINCT "companyName", "operationDate"::date AS "day"
      FROM "OzonFinancialCategoryFact"
    ) AS days
  `;
  return Number(rows[0]?.count ?? 0);
}

type SnapshotJobState = {
  status: string;
  priority: number;
  attempts: number;
  count: number;
};

async function snapshotJobStates(
  formulaVersion: string,
): Promise<SnapshotJobState[]> {
  return prisma.$queryRaw<SnapshotJobState[]>`
    SELECT "status", "priority", "attempts", COUNT(*)::int AS "count"
    FROM "DashboardPeriodSnapshotJob"
    WHERE "formulaVersion" = ${formulaVersion}
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3
  `;
}

async function v2MetricFingerprint(): Promise<string> {
  const rows = await prisma.$queryRaw<
    Array<{
      companyScope: string;
      dateFrom: string;
      dataMode: string;
      coverageStatus: string;
      payloadChecksum: string;
    }>
  >`
    SELECT "companyScope", "dateFrom"::text AS "dateFrom", "dataMode",
           "coverageStatus", "payloadChecksum"
    FROM "PeriodCompanyMarketplaceMetric"
    WHERE "formulaVersion" = ${FINANCIAL_CORE_V6_PERIOD_READMODEL_V2}
    ORDER BY "companyScope", "dateFrom"
  `;
  return JSON.stringify(rows);
}

async function profitJobsCreatedSince(since: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS "count"
    FROM "DashboardPeriodSnapshotJob"
    WHERE "formulaVersion" IN (${Prisma.join([...WAVE_B_PROFIT_FORMULAS])})
      AND "createdAt" >= ${since}::timestamp
  `;
  return Number(rows[0]?.count ?? 0);
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

type ExecuteResult = {
  mode: string;
  CURRENT_TASK_DATABASE_WRITE: string;
  operationStartedAt: string;
  OZON_NETWORK_CALLS: number;
  adapterReadiness: { ok: boolean; profile: string; ozonNetworkCallsBeforeMutation: number };
  sourceResult: {
    persisted: number;
    noopComplete: number;
    resumed: number;
    intrinsicStatuses: number;
    separateStatusUpserts: number;
  };
  statusResult: { written: number; noop: number };
  post: { snapshotDeleted: number; snapshotRequeued: number; v2Rebuilt: number };
};

type VerifyResult = {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; expected: unknown; actual: unknown }>;
};

test(
  "POSTGRES E2E: real adapters repair 78/10/35/2 against an ephemeral Postgres",
  { skip: SKIP_REASON ?? false },
  async (t) => {
    assert.notEqual(
      process.env.EPHEMERAL_MEMORY_STORE,
      "1",
      "the Postgres E2E must run the production adapters, not the memory store",
    );

    const workDir = join(process.cwd(), ".tmp-repair-postgres-e2e");
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });
    const outDir = process.env.E2E_OUT ? resolve(process.env.E2E_OUT) : process.cwd();
    mkdirSync(outDir, { recursive: true });

    const scenarios: Array<{ name: string; outcome: string; detail?: string }> = [];
    const record = (name: string, outcome: string, detail?: string) => {
      scenarios.push({ name, outcome, detail });
      console.log(`POSTGRES_E2E scenario=${name} outcome=${outcome}`);
    };

    try {
      /* -------- ephemeral schema -------- */
      const push = pushEphemeralSchema();
      await applySchemaParity();
      await truncateFixtureTables();
      record("SCHEMA_BOOTSTRAP", "PASS", push.command);

      /* -------- sealed manifests (certification recipes) -------- */
      const sealedTargets: SourceTarget[] = [];
      for (let day = 0; day < SOURCE_DAY_COUNT; day += 1) {
        const date = isoDay(day);
        for (const company of COMPANIES) {
          sealedTargets.push(
            sealCertifiedTarget({
              companyId: company.id,
              companyName: company.name,
              connectionId: company.connectionId,
              clientId: company.clientId,
              date,
            }),
          );
        }
      }
      assert.equal(sealedTargets.length, SOURCE_TARGET_COUNT);

      const statusTargets: StatusOnlyTarget[] = Array.from(
        { length: STATUS_ONLY_COUNT },
        (_, index) => ({
          company: COMPANIES[0].name,
          date: `2026-08-${String(9 + index).padStart(2, "0")}`,
          importSessionId: `impozapi_status_${index}`,
        }),
      );
      const snapshotKeys: SnapshotKey[] = Array.from(
        { length: SNAPSHOT_KEY_COUNT },
        (_, index) => ({
          companyScope: "ALL",
          dateFrom: "2026-01-01",
          dateTo: new Date(Date.UTC(2026, 6, 1) + index * 86_400_000)
            .toISOString()
            .slice(0, 10),
          formulaVersion: FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1,
        }),
      );
      const v2Targets: V2Target[] = [
        {
          dbId: "v2_2026_07",
          period: "2026-07",
          scope: "ALL",
          dateFrom: "2026-07-01",
          dateTo: "2026-07-31",
          expectedCanonicalWb: 15_708_958.04,
          expectedCanonicalOzon: 29_465_148.86,
          expectedTotal: 45_174_106.9,
        },
        {
          dbId: "v2_2026_08",
          period: "2026-08",
          scope: "ALL",
          dateFrom: "2026-08-01",
          dateTo: "2026-08-31",
          expectedCanonicalWb: 27_649_638.17,
          expectedCanonicalOzon: 64_190_278.77,
          expectedTotal: 91_839_916.94,
        },
      ];

      const paths = {
        source: join(workDir, "SOURCE_BACKFILL_TARGETS.json"),
        status: join(workDir, "STATUS_ONLY_TARGETS.json"),
        snapshot: join(workDir, "SNAPSHOT_POST_BATCH_TARGETS.json"),
        v2: join(workDir, "V2_POST_BATCH_TARGETS.json"),
        assembledCache: join(workDir, "ASSEMBLED_PREPARE_CACHE.json"),
        cacheDir: join(workDir, "prepare-cache"),
      };
      writeFileSync(
        paths.source,
        JSON.stringify({ targets: sealedTargets }, null, 2) + "\n",
      );
      writeFileSync(
        paths.status,
        JSON.stringify({ targets: statusTargets }, null, 2) + "\n",
      );
      writeFileSync(
        paths.snapshot,
        JSON.stringify({ keys: snapshotKeys }, null, 2) + "\n",
      );
      writeFileSync(paths.v2, JSON.stringify({ targets: v2Targets }, null, 2) + "\n");
      const manifestShas = {
        sourceBackfillManifestSha256: shaFile(paths.source),
        statusOnlyManifestSha256: shaFile(paths.status),
        snapshotTargetManifestSha256: shaFile(paths.snapshot),
        v2TargetManifestSha256: shaFile(paths.v2),
      };

      /* -------- fixtures -------- */
      await seedCompaniesAndConnections();
      await seedStatusOnlySessions(statusTargets);
      await seedSnapshotsAndJobs(snapshotKeys);
      await seedV2PeriodRows(v2Targets);
      await seedWbExactFinanceCover(v2Targets);
      const profitJobId = await seedPreRepairProfitJob(v2Targets[0]);

      /* -------- DRY_RUN -------- */
      const beforeDryRun = await dbFingerprint();
      assert.equal(
        await runCli([`--mode=DRY_RUN`, `--outDir=${join(workDir, "dry-run")}`]),
        0,
      );
      const plan = JSON.parse(
        readFileSync(
          join(workDir, "dry-run", "OZON_HISTORICAL_REPAIR_RUNNER_PLAN.json"),
          "utf8",
        ),
      ) as { CURRENT_TASK_DATABASE_WRITE: string; repairOnlyRequiresDeferred: boolean };
      assert.equal(plan.CURRENT_TASK_DATABASE_WRITE, "NO");
      assert.equal(plan.repairOnlyRequiresDeferred, true);
      assert.equal(await dbFingerprint(), beforeDryRun, "DRY_RUN must not write");
      record("DRY_RUN", "PASS", "zero database writes");

      /* -------- PREPARE with injected transport (read-only) -------- */
      const beforePrepare = await dbFingerprint();
      const prepared = await preparePrepareCacheLive({
        sourceTargets: sealedTargets,
        statusOnly: statusTargets,
        snapshotKeys,
        v2Targets,
        manifestShas,
        getCredentials: createMarketplaceApiConnectionCredentialLoader(),
        fetchRange: stubTransport,
      });
      assert.equal(prepared.cache.targets.length, SOURCE_TARGET_COUNT);
      assert.equal(prepared.ozonApiCalls, SOURCE_TARGET_COUNT);
      assert.ok(
        prepared.cache.targets.every(
          (target) => target.observed.expectedStatus === "FINAL",
        ),
        "every prepared day must be FINAL-eligible",
      );
      assert.equal(await dbFingerprint(), beforePrepare, "PREPARE must not write");

      writeFileSync(
        paths.assembledCache,
        JSON.stringify(prepared.cache, null, 2) + "\n",
      );
      assert.equal(
        await runCli([
          "--mode=PREPARE",
          `--sourceManifest=${paths.source}`,
          `--statusManifest=${paths.status}`,
          `--snapshotManifest=${paths.snapshot}`,
          `--v2Manifest=${paths.v2}`,
          `--prepareCacheIn=${paths.assembledCache}`,
          `--prepareCacheOut=${paths.cacheDir}`,
          `--outDir=${join(workDir, "prepare")}`,
        ]),
        0,
      );
      const cachePath = join(paths.cacheDir, "PREPARE_CACHE.json");
      const cacheShaPath = join(paths.cacheDir, "PREPARE_CACHE.sha256.txt");
      const cache = JSON.parse(readFileSync(cachePath, "utf8")) as PrepareCache;
      assert.equal(
        buildPrepareCacheManifestSha(cache),
        readFileSync(cacheShaPath, "utf8").trim(),
      );
      assert.equal(await dbFingerprint(), beforePrepare, "PREPARE CLI must not write");
      record("PREPARE_INJECTED_FETCH", "PASS", `ozonApiCalls=${prepared.ozonApiCalls}`);

      /* -------- PREPARE drift + wrong Ozon account -------- */
      await assert.rejects(
        () =>
          preparePrepareCacheLive({
            sourceTargets: [{ ...sealedTargets[0], rowCount: 999 }],
            statusOnly: [],
            snapshotKeys: [],
            v2Targets: [],
            manifestShas,
            getCredentials: createMarketplaceApiConnectionCredentialLoader(),
            fetchRange: stubTransport,
          }),
        /SOURCE_DRIFT=YES[\s\S]*rowCount/,
      );
      await assert.rejects(
        () =>
          preparePrepareCacheLive({
            sourceTargets: [
              { ...sealedTargets[0], clientIdSha256: sha("someone-elses-account") },
            ],
            statusOnly: [],
            snapshotKeys: [],
            v2Targets: [],
            manifestShas,
            getCredentials: createMarketplaceApiConnectionCredentialLoader(),
            fetchRange: stubTransport,
          }),
        /SOURCE_DRIFT=YES[\s\S]*clientIdSha256/,
      );
      assert.equal(
        await dbFingerprint(),
        beforePrepare,
        "a drifted PREPARE must leave the database untouched",
      );
      record("PREPARE_DRIFT_STOPS", "PASS", "rowCount + clientIdSha256, zero writes");

      /* -------- binding mismatch: refuse before the first write -------- */
      const executeArgs = (overrides: Record<string, string> = {}) => {
        const base: Record<string, string> = {
          mode: "EXECUTE_FROM_CACHE",
          operationId: "OP_POSTGRES_E2E",
          approvalBindingSha256: sha("approval|postgres-e2e"),
          sourceBackfillManifestSha256: manifestShas.sourceBackfillManifestSha256,
          statusOnlyManifestSha256: manifestShas.statusOnlyManifestSha256,
          snapshotTargetManifestSha256: manifestShas.snapshotTargetManifestSha256,
          v2TargetManifestSha256: manifestShas.v2TargetManifestSha256,
          expectedPreDeployAppImageSha256: "sha256:pre-deploy",
          expectedCandidateAppImageSha256: "sha256:candidate",
          expectedRepairRunnerImageSha256: "sha256:repair-runner",
          mutationTimeAppImageSha256: "sha256:candidate",
          sourceBackfillTargetCount: String(SOURCE_TARGET_COUNT),
          statusStandaloneTargetCount: String(STATUS_ONLY_COUNT),
          snapshotPostBatchDeleteCount: String(SNAPSHOT_KEY_COUNT),
          snapshotPostBatchRequeueCount: String(SNAPSHOT_KEY_COUNT),
          v2NumericMutationTargetCount: "2",
          executeMarker: OWNER_EXECUTE_MARKER,
          prepareCacheManifestSha256: shaFile(cacheShaPath),
          sourceManifest: paths.source,
          statusManifest: paths.status,
          snapshotManifest: paths.snapshot,
          v2Manifest: paths.v2,
          prepareCache: cachePath,
          prepareCacheManifest: cacheShaPath,
          outDir: join(workDir, "execute"),
          ...overrides,
        };
        return Object.entries(base).map(([key, value]) => `--${key}=${value}`);
      };

      const beforeBinding = await dbFingerprint();
      await assert.rejects(
        () => runCli(executeArgs({ mutationTimeAppImageSha256: "sha256:stale-app" })),
        /MUTATION_TIME_REQUIRED_APP_IMAGE/,
      );
      await assert.rejects(
        () => runCli(executeArgs({ sourceBackfillManifestSha256: sha("wrong") })),
        /sourceBackfillManifestSha256 file mismatch/,
      );
      await assert.rejects(
        () => runCli(executeArgs({ prepareCacheManifestSha256: sha("wrong") })),
        /prepareCacheManifestSha256 file mismatch/,
      );
      assert.equal(
        await dbFingerprint(),
        beforeBinding,
        "a binding mismatch must produce zero database writes",
      );
      record("BINDING_MISMATCH_ZERO_WRITES", "PASS", "3 refusals, zero writes");

      /* -------- cache drift: refuse before the first write -------- */
      const driftedCache: PrepareCache = JSON.parse(
        JSON.stringify(cache),
      ) as PrepareCache;
      driftedCache.targets[0].observed.rowCount = 999;
      const driftedDir = join(workDir, "drifted-cache");
      mkdirSync(driftedDir, { recursive: true });
      const driftedCachePath = join(driftedDir, "PREPARE_CACHE.json");
      const driftedShaPath = join(driftedDir, "PREPARE_CACHE.sha256.txt");
      writeFileSync(driftedCachePath, JSON.stringify(driftedCache, null, 2) + "\n");
      writeFileSync(
        driftedShaPath,
        buildPrepareCacheManifestSha(driftedCache) + "\n",
      );
      await assert.rejects(
        () =>
          runCli(
            executeArgs({
              prepareCache: driftedCachePath,
              prepareCacheManifest: driftedShaPath,
              prepareCacheManifestSha256: shaFile(driftedShaPath),
              outDir: join(workDir, "execute-drift"),
            }),
          ),
        /SOURCE_DRIFT=YES/,
      );
      assert.equal(
        await dbFingerprint(),
        beforeBinding,
        "a drifted cache must produce zero database writes",
      );
      record("CACHE_DRIFT_ZERO_WRITES", "PASS", "rowCount drift, zero writes");

      /* -------- V2 scope guard (per-company rows stay UNAVAILABLE) -------- */
      await assert.rejects(
        () =>
          rebuildV2PeriodTargets({
            targets: [{ ...v2Targets[0], scope: COMPANIES[0].name }],
          }),
        /V2_SCOPE_REFUSED/,
      );
      assert.equal(
        await dbFingerprint(),
        beforeBinding,
        "a refused V2 scope must produce zero database writes",
      );
      record("V2_COMPANY_SCOPE_REFUSED", "PASS", "zero writes");

      /* -------- the 36 already-FINAL days -------- */
      await seedAlreadyFinalDays(cache.targets.slice(0, SEEDED_NOOP_COUNT));
      assert.equal(await finalDayStatusCount(), SEEDED_NOOP_COUNT);

      /* -------- EXECUTE_FROM_CACHE (real Prisma mutation) -------- */
      assert.equal(await runCli(executeArgs()), 0);
      const execute = JSON.parse(
        readFileSync(
          join(workDir, "execute", "EXECUTE_FROM_CACHE_RESULT.json"),
          "utf8",
        ),
      ) as ExecuteResult;

      assert.equal(execute.CURRENT_TASK_DATABASE_WRITE, "YES");
      assert.equal(execute.adapterReadiness.ok, true);
      assert.equal(execute.adapterReadiness.profile, "PRODUCTION_PRISMA");
      assert.equal(execute.OZON_NETWORK_CALLS, 0);
      assert.equal(execute.sourceResult.persisted, FRESH_PERSIST_COUNT);
      assert.equal(execute.sourceResult.noopComplete, SEEDED_NOOP_COUNT);
      assert.equal(execute.sourceResult.resumed, 0);
      assert.equal(execute.sourceResult.intrinsicStatuses, SOURCE_TARGET_COUNT);
      assert.equal(execute.sourceResult.separateStatusUpserts, 0);
      assert.equal(execute.statusResult.written, STATUS_ONLY_COUNT);
      assert.equal(execute.post.snapshotDeleted, SNAPSHOT_KEY_COUNT);
      assert.equal(execute.post.snapshotRequeued, SNAPSHOT_KEY_COUNT);
      assert.equal(execute.post.v2Rebuilt, 2);

      assert.equal(
        await finalDayStatusCount(),
        SOURCE_TARGET_COUNT + STATUS_ONLY_COUNT,
        "78 source days + 10 standalone days must be FINAL in Postgres",
      );
      assert.equal(
        await distinctFactDays(),
        FRESH_PERSIST_COUNT,
        "canonical facts exist for exactly the freshly persisted days",
      );
      assert.equal(
        await countRows("DashboardPeriodSnapshot"),
        0,
        "the exact-key union must delete every seeded V4 snapshot",
      );
      assert.deepEqual(await snapshotJobStates(FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1), [
        {
          status: "PENDING",
          priority: SNAPSHOT_REQUEUE_PRIORITY,
          attempts: 0,
          count: SNAPSHOT_KEY_COUNT,
        },
      ]);
      const v6Jobs = await snapshotJobStates(FINANCIAL_CORE_V6_PERIOD_READMODEL_V2);
      assert.equal(
        v6Jobs.reduce((total, row) => total + row.count, 0),
        2,
        "exactly the 2 ALL-scope V2 rows may be queued",
      );
      assert.equal(await profitJobsCreatedSince(execute.operationStartedAt), 0);
      assert.equal(await countRows("PeriodCompanyMarketplaceMetric"), V2_METRIC_ROWS);
      const v2AfterExecute = await v2MetricFingerprint();
      record(
        "EXECUTE_FROM_CACHE",
        "PASS",
        `persisted=${execute.sourceResult.persisted} noop=${execute.sourceResult.noopComplete}`,
      );

      /* -------- VERIFY -------- */
      const verifyArgs = (outDir: string, operationStartedAt: string) => [
        "--mode=VERIFY",
        `--sourceManifest=${paths.source}`,
        `--statusManifest=${paths.status}`,
        `--snapshotManifest=${paths.snapshot}`,
        `--v2Manifest=${paths.v2}`,
        `--operationStartedAt=${operationStartedAt}`,
        `--outDir=${outDir}`,
      ];
      const readVerify = (outDir: string) =>
        JSON.parse(readFileSync(join(outDir, "VERIFY_RESULT.json"), "utf8")) as VerifyResult;

      const verifyDir = join(workDir, "verify");
      assert.equal(
        await runCli(verifyArgs(verifyDir, execute.operationStartedAt)),
        0,
      );
      const verify = readVerify(verifyDir);
      assert.equal(verify.ok, true, JSON.stringify(verify.checks));
      record("VERIFY", "PASS", `${verify.checks.length} checks`);

      /* -------- VERIFY bites: a profit job inside the window fails it -------- */
      await prisma.dashboardPeriodSnapshotJob.create({
        data: {
          id: "dpsjob_profit_during_repair",
          companyScope: "ALL",
          dateFrom: new Date("2026-08-01T00:00:00.000Z"),
          dateTo: new Date("2026-08-31T00:00:00.000Z"),
          formulaVersion: WAVE_B_PROFIT_FORMULAS[0],
          status: "PENDING",
          priority: 100,
          attempts: 0,
          maxAttempts: 3,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      const negativeDir = join(workDir, "verify-negative");
      assert.equal(
        await runCli(verifyArgs(negativeDir, execute.operationStartedAt)),
        1,
      );
      const negative = readVerify(negativeDir);
      assert.equal(negative.ok, false);
      assert.equal(
        negative.checks.find(
          (check) => check.name === "profit_readmodel_jobs_created_during_repair",
        )?.ok,
        false,
      );
      await prisma.dashboardPeriodSnapshotJob.delete({
        where: { id: "dpsjob_profit_during_repair" },
      });
      record("VERIFY_PROFIT_GUARD_BITES", "PASS", "profit job in window fails VERIFY");

      /* -------- full rerun: idempotent -------- */
      const rerunDir = join(workDir, "execute-rerun");
      assert.equal(await runCli(executeArgs({ outDir: rerunDir })), 0);
      const rerun = JSON.parse(
        readFileSync(join(rerunDir, "EXECUTE_FROM_CACHE_RESULT.json"), "utf8"),
      ) as ExecuteResult;
      assert.equal(rerun.sourceResult.persisted, 0);
      assert.equal(rerun.sourceResult.noopComplete, SOURCE_TARGET_COUNT);
      assert.equal(rerun.sourceResult.resumed, 0);
      assert.equal(rerun.statusResult.written, 0);
      assert.equal(rerun.statusResult.noop, STATUS_ONLY_COUNT);
      assert.equal(rerun.post.snapshotDeleted, SNAPSHOT_KEY_COUNT);
      assert.equal(rerun.post.v2Rebuilt, 2);
      assert.equal(await countRows("DashboardPeriodSnapshot"), 0);
      assert.equal(
        await distinctFactDays(),
        FRESH_PERSIST_COUNT,
        "a rerun must not duplicate canonical facts",
      );
      assert.equal(
        await finalDayStatusCount(),
        SOURCE_TARGET_COUNT + STATUS_ONLY_COUNT,
      );
      assert.equal(await profitJobsCreatedSince(rerun.operationStartedAt), 0);
      assert.equal(
        await v2MetricFingerprint(),
        v2AfterExecute,
        "the repair must never renumber the V2 read-model rows",
      );
      const verifyRerunDir = join(workDir, "verify-rerun");
      assert.equal(
        await runCli(verifyArgs(verifyRerunDir, rerun.operationStartedAt)),
        0,
      );
      assert.equal(readVerify(verifyRerunDir).ok, true);
      record("FULL_RERUN_IDEMPOTENT", "PASS", "persisted=0 noop=78");

      /* -------- crash after raw: resume canonical from the surviving session -------- */
      const crashTarget = cache.targets[0];
      const crashSessionId = "impozapi_seed_0";
      await prisma.importSession.update({
        where: { id: crashSessionId },
        data: { status: "RAW_PERSISTED" },
      });
      await prisma.ozonAccrualDayStatus.update({
        where: {
          companyName_date: {
            companyName: crashTarget.sealed.companyName,
            date: crashTarget.sealed.date,
          },
        },
        data: {
          dataMode: "PRELIMINARY",
          coverageComplete: false,
          phase: "RAW",
          missingEvidence: ["RAW_PHASE"],
        },
      });
      assert.equal(
        await finalDayStatusCount(),
        SOURCE_TARGET_COUNT + STATUS_ONLY_COUNT - 1,
      );

      const resumeDir = join(workDir, "execute-resume");
      assert.equal(await runCli(executeArgs({ outDir: resumeDir })), 0);
      const resume = JSON.parse(
        readFileSync(join(resumeDir, "EXECUTE_FROM_CACHE_RESULT.json"), "utf8"),
      ) as ExecuteResult;
      assert.equal(resume.sourceResult.resumed, 1);
      assert.equal(resume.sourceResult.persisted, 0);
      assert.equal(resume.sourceResult.noopComplete, SOURCE_TARGET_COUNT - 1);
      assert.equal(
        await finalDayStatusCount(),
        SOURCE_TARGET_COUNT + STATUS_ONLY_COUNT,
        "the resumed day must be FINAL again",
      );
      const resumedSession = await prisma.importSession.findUnique({
        where: { id: crashSessionId },
      });
      assert.equal(resumedSession?.status, "SUCCESS");
      assert.equal(
        await distinctFactDays(),
        FRESH_PERSIST_COUNT + 1,
        "the resumed day writes its canonical facts",
      );
      assert.equal(await profitJobsCreatedSince(resume.operationStartedAt), 0);
      const verifyResumeDir = join(workDir, "verify-resume");
      assert.equal(
        await runCli(verifyArgs(verifyResumeDir, resume.operationStartedAt)),
        0,
      );
      const verifyResume = readVerify(verifyResumeDir);
      assert.equal(verifyResume.ok, true, JSON.stringify(verifyResume.checks));
      record("CRASH_RESUME_AFTER_RAW", "PASS", "resumed=1 from RAW_PERSISTED session");

      /* -------- the pre-existing profit job was never touched -------- */
      const preExistingProfitJob = await prisma.dashboardPeriodSnapshotJob.findUnique(
        { where: { id: profitJobId } },
      );
      assert.equal(preExistingProfitJob?.status, "SUCCESS");
      assert.equal(preExistingProfitJob?.attempts, 1);

      /* -------- evidence -------- */
      const report = {
        EPHEMERAL_STORE: "POSTGRES",
        EPHEMERAL_E2E: "PASS",
        EPHEMERAL_MEMORY_STORE: "UNSET",
        PRODUCTION_ADAPTERS: "lib/ozon/financialRepairProductionAdapters.ts",
        PRODUCTION_MUTATION: "NO",
        DATABASE_WRITE: "EPHEMERAL_POSTGRES",
        PRODUCTION_DB_USED: "NO",
        schemaBootstrap: push.command,
        schemaParityStatements: [...SCHEMA_PARITY_STATEMENTS],
        adapterReadinessProfile: "PRODUCTION_PRISMA",
        OZON_NETWORK_CALLS_ON_EXECUTE: execute.OZON_NETWORK_CALLS,
        counts: {
          sourceTargets: SOURCE_TARGET_COUNT,
          sourcePersistedFirstRun: execute.sourceResult.persisted,
          sourceNoopSeeded: SEEDED_NOOP_COUNT,
          sourceNoopOnRerun: rerun.sourceResult.noopComplete,
          sourceResumedAfterCrash: resume.sourceResult.resumed,
          intrinsicStatuses: execute.sourceResult.intrinsicStatuses,
          standaloneStatusesWritten: execute.statusResult.written,
          standaloneStatusesNoopOnRerun: rerun.statusResult.noop,
          duplicateSeparateStatuses: execute.sourceResult.separateStatusUpserts,
          snapshotRowsSeeded: SNAPSHOT_KEY_COUNT,
          snapshotJobsSeeded: SNAPSHOT_JOBS_SEEDED,
          snapshotDelete: execute.post.snapshotDeleted,
          snapshotRequeue: execute.post.snapshotRequeued,
          snapshotRowsRemaining: 0,
          v2ReadModelRowsSeeded: V2_METRIC_ROWS,
          v2AllScopeRebuilt: execute.post.v2Rebuilt,
          v2CompanyScopeRebuilt: 0,
          profitReadModelJobsDuringRepair: 0,
          profitDailyExplosion: 0,
        },
        scenarios,
        verifyChecks: verify.checks.map((check) => ({
          name: check.name,
          ok: check.ok,
          expected: check.expected,
          actual: check.actual,
        })),
        generatedAt: new Date().toISOString(),
      };
      const body = JSON.stringify(report, null, 2) + "\n";
      const reportPath = join(outDir, "FINANCIAL_REPAIR_POSTGRES_E2E_FINAL.json");
      writeFileSync(reportPath, body);
      writeFileSync(`${reportPath}.sha256.txt`, sha(body) + "\n");
      console.log(`POSTGRES_E2E=PASS report=${reportPath}`);
      await t.test("evidence file is written", () => {
        const persisted = JSON.parse(readFileSync(reportPath, "utf8")) as {
          EPHEMERAL_STORE: string;
          EPHEMERAL_E2E: string;
        };
        assert.equal(persisted.EPHEMERAL_STORE, "POSTGRES");
        assert.equal(persisted.EPHEMERAL_E2E, "PASS");
      });
    } finally {
      await prisma.$disconnect().catch(() => undefined);
    }
  },
);
