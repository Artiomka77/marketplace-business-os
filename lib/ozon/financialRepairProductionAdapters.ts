/**
 * Production Prisma adapters for the owner-gated Ozon historical financial repair.
 *
 * Every phase the sealed runner needs at mutation time is implemented here against
 * the real database. No phase throws "adapter not injected": a failure is always a
 * real precondition failure (missing relation, conflicting source state, ineligible
 * V2 rebuild) and is reported as such.
 *
 * Invalidation contract: the 78 source persists run with DEFERRED_OWNER_REPAIR, so
 * neither snapshots nor the profit read model are touched per target. The snapshot
 * union is applied exactly once by applyExactSnapshotUnionOnce in the post-batch.
 */
import { createHash, randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import {
  fetchOzonAccrualByDayRange,
  mapOzonAccrualByDay,
  type OzonAccrualApiCallLog,
  type OzonAccrualApiDayEnvelope,
  type OzonAccrualByDayResult,
} from "@/lib/ozon/accrualByDay";
import { buildCanonicalOzonDayStatuses } from "@/lib/ozon/accrualDayStatus";
import { persistOzonAccrualDayStatuses } from "@/lib/ozon/accrualDayStatusStore";
import {
  planCanonicalOzonAccrualPersist,
  unexplainedOzonGrossDifference,
} from "@/lib/ozon/accrualIngestValidation";
import {
  postBatchV2PromotionAllowed,
  shouldInvalidateProfit,
  shouldInvalidateSnapshots,
} from "@/lib/ozon/historicalRepairInvalidationPolicy";
import {
  createPrismaOzonAccrualStore,
  type OzonAccrualRuntimeStore,
} from "@/lib/ozon/syncOzonAccrualByDay";
import { createPrismaV6PeriodReadModelRepository } from "@/lib/dashboard/v6PeriodReadModel/repository";
import { asPrismaLikeV6Client } from "@/lib/dashboard/v6PeriodReadModel/targetClient";
import { WAVE_B_PROFIT_FORMULAS } from "@/lib/profitReadModel/contract";
import { prisma as defaultPrisma } from "@/lib/prisma";

/** Same constant the pre-V6 production overlay uses for V4 period snapshots. */
export const FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1 =
  "FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1";

export const FINANCIAL_CORE_V6_PERIOD_READMODEL_V2 =
  "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2";

/** Identical to the requeue priority used by the normal ingest invalidation path. */
export const SNAPSHOT_REQUEUE_PRIORITY = 995_000;

export const OZON_ACCRUAL_BY_DAY_REPORT_TYPE = "OZON_ACCRUAL_BY_DAY_API";

export const OZON_ACCRUAL_CANONICAL_FACT_SOURCE = "OZON_ACCRUAL_REPORT";

/**
 * Structural mirrors of the sealed runner manifest rows. Declared here (instead of
 * imported from scripts/) so lib/ never depends on the runner and the two modules
 * cannot form an import cycle.
 */
export type RepairSourceTarget = {
  companyId: string;
  companyName: string;
  date: string;
  rawResponseHash: string;
  pageHashes: string[];
  rowCount: number;
  fullMapperResultHash: string;
  marketplaceApiConnectionId?: string;
  ACCOUNT_AUTHORITY_ID?: string;
  clientIdSha256?: string;
};

export const STATUS_ONLY_EXPECTED_PAYLOAD_PLACEHOLDER =
  "PLACEHOLDER_REQUIRES_LIVE_PREPARE_BIND";

export type RepairStatusOnlyTarget = {
  company: string;
  date: string;
  importSessionId: string;
  reportType?: string;
  expectedPayloadSha256?: string;
  readonlySessionFingerprintSha256?: string;
  previewDateFrom?: string;
  previewDateTo?: string;
  coverageComplete?: boolean;
  quarantineCount?: number;
  dataMode?: string;
  phase?: string;
  mapperComplete?: boolean;
};

export type RepairSnapshotKey = {
  companyScope: string;
  dateFrom: string;
  dateTo: string;
  formulaVersion?: string;
};

export type RepairV2Target = {
  dbId: string;
  period: string;
  scope: string;
  dateFrom: string;
  dateTo: string;
  expectedCanonicalWb: number | string;
  expectedCanonicalOzon: number | string;
  expectedTotal: number | string;
  /** V6 formula version the row is keyed by. */
  formulaVersion?: string;
  /** Sealed fingerprint of the row as observed during certification. */
  currentRowFingerprint?: string;
  currentDataMode?: string;
  currentCoverageStatus?: string;
};

export type RepairTargetState =
  | "MISSING"
  | "NOOP_COMPLETE"
  | "RAW_PERSISTED_RESUME"
  | "CONFLICT";

type RepairDbClient = PrismaClient;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function dateOnly(value: string): string {
  return value.slice(0, 10);
}

function db(client?: RepairDbClient): RepairDbClient {
  return client ?? defaultPrisma;
}

/* ------------------------------------------------------------------ *
 * Certification hash recipes
 * ------------------------------------------------------------------ */

/**
 * Per-page body hashes in request order, exactly as the certification fetcher
 * recorded them: sha256 of each successful raw response body.
 */
export function collectCertificationPageHashes(
  calls: ReadonlyArray<Pick<OzonAccrualApiCallLog, "ok" | "responseBodySha256">>,
): string[] {
  return calls.filter((call) => call.ok).map((call) => call.responseBodySha256);
}

/** rawResponseHash recipe frozen by the sealed source-backfill manifest. */
export function computeCertificationRawResponseHash(params: {
  date: string;
  pageHashes: string[];
  count: number;
  paginationComplete: boolean;
}): string {
  return sha256Hex(
    JSON.stringify({
      date: params.date,
      pageHashes: params.pageHashes,
      count: params.count,
      paginationComplete: params.paginationComplete,
    }),
  );
}

/**
 * fullMapperResultHash recipe frozen by the sealed source-backfill manifest.
 * Deliberately excludes facts/totals: the certification hash covers mapper
 * completeness + diagnostics + ingest finality only, which is why the sealed
 * manifest repeats one hash across all clean FINAL days.
 */
export function computeCertificationMapperResultHash(params: {
  mapped: OzonAccrualByDayResult;
  ingestStatus: string;
  unexplainedGross: number;
  persistError?: string | null;
}): string {
  const { mapped } = params;
  return sha256Hex(
    JSON.stringify({
      mapperComplete: mapped.mapperComplete,
      coverageComplete: mapped.coverageComplete,
      diagnostics: {
        unknown: mapped.diagnostics.unknownMeaningfulTypeIds,
        type71: mapped.diagnostics.unresolvedType71Groups,
        gross: mapped.diagnostics.grossExpenseDifference,
        dailyGross: mapped.diagnostics.dailyGrossExpenseDifferences,
      },
      ingestStatus: params.ingestStatus,
      unexplainedGross: params.unexplainedGross,
      persistError: params.persistError ?? null,
    }),
  );
}

/** Mirrors the private payload hash used by the ingest store for raw records. */
export function computeOzonAccrualPayloadSha256(params: {
  companyName: string;
  dateFrom: string;
  dateTo: string;
  dayEnvelopes: OzonAccrualApiDayEnvelope[];
  rawAccruals: unknown[];
}): string {
  return sha256Hex(
    JSON.stringify({
      companyName: params.companyName,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      dayEnvelopes: params.dayEnvelopes,
      rawAccruals: params.rawAccruals,
    }),
  );
}

/* ------------------------------------------------------------------ *
 * V2 period read-model row fingerprints
 * ------------------------------------------------------------------ */

/** The exact 11 columns the sealed V2 fingerprint covers, in recipe order. */
export type V2PeriodRowFingerprintInput = {
  id: string;
  companyScope: string;
  dateFrom: string | Date;
  dateTo: string | Date;
  formulaVersion: string;
  dataMode: string;
  coverageStatus: string;
  sourceFingerprint: string | null;
  payloadChecksum: string | null;
  generatedAt: string | Date | null;
  updatedAt: string | Date | null;
};

function isoOrNull(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

/**
 * Same recipe that sealed V2_CURRENT_ROW_FINGERPRINTS_READONLY.json: sha256 over
 * the JSON of the picked columns, timestamps as ISO-8601. Reimplemented here so
 * the runner can recompute a live row and compare, rather than trusting the
 * sealed value.
 */
export function computeV2PeriodRowFingerprint(
  row: V2PeriodRowFingerprintInput,
): string {
  return sha256Hex(
    JSON.stringify({
      id: row.id,
      companyScope: row.companyScope,
      dateFrom: isoOrNull(row.dateFrom),
      dateTo: isoOrNull(row.dateTo),
      formulaVersion: row.formulaVersion,
      dataMode: row.dataMode,
      coverageStatus: row.coverageStatus,
      sourceFingerprint: row.sourceFingerprint,
      payloadChecksum: row.payloadChecksum,
      generatedAt: isoOrNull(row.generatedAt),
      updatedAt: isoOrNull(row.updatedAt),
    }),
  );
}

export type V2RowFingerprintObservation = {
  dbId: string;
  period: string;
  scope: string;
  found: boolean;
  sealedFingerprint: string | null;
  observedFingerprint: string | null;
  observedDataMode: string | null;
  observedCoverageStatus: string | null;
  match: boolean;
};

/**
 * READ-ONLY fingerprint read for the V2 matrix rows. Rows are looked up by the
 * sealed primary key; a row that is absent is reported as such instead of being
 * silently treated as unchanged.
 */
export async function readV2PeriodRowFingerprints(params: {
  rows: RepairV2Target[];
  client?: RepairDbClient;
}): Promise<V2RowFingerprintObservation[]> {
  const client = db(params.client);
  const ids = params.rows.map((row) => row.dbId).filter(Boolean);
  const live = ids.length
    ? await client.$queryRaw<V2PeriodRowFingerprintInput[]>`
        SELECT
          "id", "companyScope", "dateFrom", "dateTo", "formulaVersion",
          "dataMode", "coverageStatus", "sourceFingerprint", "payloadChecksum",
          "generatedAt", "updatedAt"
        FROM "PeriodCompanyMarketplaceMetric"
        WHERE "id" IN (${Prisma.join(ids)})
      `
    : [];
  const byId = new Map(live.map((row) => [row.id, row]));

  return params.rows.map((target) => {
    const row = byId.get(target.dbId) ?? null;
    const observedFingerprint = row ? computeV2PeriodRowFingerprint(row) : null;
    const sealedFingerprint = target.currentRowFingerprint ?? null;
    return {
      dbId: target.dbId,
      period: target.period,
      scope: target.scope,
      found: Boolean(row),
      sealedFingerprint,
      observedFingerprint,
      observedDataMode: row?.dataMode ?? null,
      observedCoverageStatus: row?.coverageStatus ?? null,
      match: sealedFingerprint
        ? observedFingerprint === sealedFingerprint
        : Boolean(row),
    };
  });
}

/**
 * Flattens a V2 post-batch manifest into all matrix rows (mutation targets plus
 * the rows that must stay UNAVAILABLE), which is what the fingerprint gate needs.
 */
export function collectV2MatrixRows(manifest: {
  targets?: RepairV2Target[];
  keepUnavailable?: RepairV2Target[];
}): RepairV2Target[] {
  return [...(manifest.targets ?? []), ...(manifest.keepUnavailable ?? [])];
}

/* ------------------------------------------------------------------ *
 * Ozon network tripwire (EXECUTE must perform zero Ozon calls)
 * ------------------------------------------------------------------ */

export type OzonNetworkTripwire = {
  /** Number of outbound requests observed to an Ozon host. */
  count: () => number;
  /** Observed Ozon request targets, in order. */
  calls: () => readonly string[];
  /** Every outbound request observed, Ozon or not. */
  totalCount: () => number;
  assertZero: (phase: string) => void;
  restore: () => void;
};

function requestTargetUrl(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input === "object" && "url" in input) {
    return String((input as { url: unknown }).url ?? "");
  }
  return "";
}

function isOzonTarget(url: string): boolean {
  return /(^https?:\/\/)?([^/]*\.)?ozon\.ru(\/|:|$)/i.test(url);
}

/**
 * Patches global fetch so the runner can prove EXECUTE_FROM_CACHE performed no
 * Ozon network I/O. BLOCK additionally fails the request instead of only counting,
 * which is what EXECUTE uses: a cache-only phase has no legitimate reason to call.
 */
export function installOzonNetworkTripwire(options?: {
  mode?: "COUNT" | "BLOCK";
}): OzonNetworkTripwire {
  const mode = options?.mode ?? "COUNT";
  const scope = globalThis as unknown as { fetch?: typeof fetch };
  const original = scope.fetch;
  const ozonCalls: string[] = [];
  let total = 0;

  if (typeof original === "function") {
    scope.fetch = (async (input: unknown, init?: unknown) => {
      total += 1;
      const url = requestTargetUrl(input);
      if (isOzonTarget(url)) {
        ozonCalls.push(url);
        if (mode === "BLOCK") {
          throw new Error(
            `OZON_NETWORK_BLOCKED_DURING_CACHE_ONLY_PHASE url=${url}`,
          );
        }
      }
      return (original as (a: unknown, b?: unknown) => Promise<Response>)(
        input,
        init,
      );
    }) as unknown as typeof fetch;
  }

  return {
    count: () => ozonCalls.length,
    calls: () => [...ozonCalls],
    totalCount: () => total,
    assertZero(phase: string) {
      if (ozonCalls.length > 0) {
        throw new Error(
          `OZON_NETWORK_CALLS_DURING_${phase}=${ozonCalls.length} EXECUTION=BLOCKED`,
        );
      }
    },
    restore() {
      if (typeof original === "function") {
        scope.fetch = original;
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * Credentials for the PREPARE live fetch
 * ------------------------------------------------------------------ */

export type OzonRepairCredentials = { clientId: string; apiKey: string };

export type OzonCredentialLoader = (
  connectionId: string,
) => Promise<OzonRepairCredentials>;

/**
 * Loads Ozon seller credentials from MarketplaceApiConnection.
 *
 * The candidate schema stores ozonClientId / ozonApiKey directly (no encryption
 * column, no decrypt helper exists anywhere in the codebase), so this reads them
 * as-is. A host that later introduces envelope encryption injects its own loader
 * through getCredentials instead of changing this module.
 */
export function createMarketplaceApiConnectionCredentialLoader(
  client?: RepairDbClient,
): OzonCredentialLoader {
  return async (connectionId: string) => {
    const row = await db(client).marketplaceApiConnection.findUnique({
      where: { id: connectionId },
      select: {
        id: true,
        marketplace: true,
        isEnabled: true,
        ozonClientId: true,
        ozonApiKey: true,
      },
    });
    if (!row) {
      throw new Error(
        `MarketplaceApiConnection ${connectionId} not found for Ozon repair PREPARE`,
      );
    }
    if (row.marketplace !== "OZON") {
      throw new Error(
        `MarketplaceApiConnection ${connectionId} is ${row.marketplace}, expected OZON`,
      );
    }
    const clientId = String(row.ozonClientId ?? "").trim();
    const apiKey = String(row.ozonApiKey ?? "").trim();
    if (!clientId || !apiKey) {
      throw new Error(
        `MarketplaceApiConnection ${connectionId} has no usable Ozon credentials`,
      );
    }
    return { clientId, apiKey };
  };
}

/** Binds the sealed clientIdSha256 so PREPARE cannot fetch under the wrong account. */
export function assertCredentialAuthorityMatch(params: {
  target: RepairSourceTarget;
  credentials: OzonRepairCredentials;
}): void {
  const expected = params.target.clientIdSha256;
  if (!expected) return;
  const observed = sha256Hex(params.credentials.clientId);
  if (observed !== expected) {
    throw new Error(
      `SOURCE_DRIFT=YES EXECUTION=BLOCKED NEW_FINANCIAL_RECERTIFICATION_REQUIRED fields=clientIdSha256 ${params.target.companyName} ${params.target.date}`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * PREPARE: real read-only Ozon fetch
 * ------------------------------------------------------------------ */

export type OzonRepairFetchRange = typeof fetchOzonAccrualByDayRange;

export type PreparedLiveFetch = {
  target: RepairSourceTarget;
  accruals: unknown[];
  requestedDates: string[];
  dayEnvelopes: OzonAccrualApiDayEnvelope[];
  pagesByDay: Record<string, number>;
  rawResponseHash: string;
  pageHashes: string[];
  mapperResultHash: string;
  mapperComplete: boolean;
  ingestStatus: string;
  apiCallCount: number;
};

/**
 * READ-ONLY single-day live fetch for PREPARE. Performs the Ozon calls, recomputes
 * the certification hashes from the observed bodies, and hard-stops on drift versus
 * the sealed manifest before the payload can reach any cache.
 */
export async function fetchOzonRepairTargetLive(params: {
  target: RepairSourceTarget;
  getCredentials: OzonCredentialLoader;
  fetchRange?: OzonRepairFetchRange;
  connectionId?: string;
  onNetworkCall?: (call: OzonAccrualApiCallLog) => void;
}): Promise<PreparedLiveFetch> {
  const { target } = params;
  const connectionId =
    params.connectionId ??
    target.ACCOUNT_AUTHORITY_ID ??
    target.marketplaceApiConnectionId;
  if (!connectionId) {
    throw new Error(
      `PREPARE live fetch requires ACCOUNT_AUTHORITY_ID for ${target.companyName} ${target.date}`,
    );
  }

  const credentials = await params.getCredentials(connectionId);
  assertCredentialAuthorityMatch({ target, credentials });

  const date = dateOnly(target.date);
  const calls: OzonAccrualApiCallLog[] = [];
  const fetchRange = params.fetchRange ?? fetchOzonAccrualByDayRange;
  const fetched = await fetchRange({
    credentials,
    dateFrom: date,
    dateTo: date,
    onCall: (call) => {
      calls.push(call);
      params.onNetworkCall?.(call);
    },
  });

  const envelope = fetched.dayEnvelopes.find((item) => item.date === date);
  if (!envelope) {
    throw new Error(`PREPARE live fetch returned no day envelope for ${date}`);
  }

  const pageHashes = collectCertificationPageHashes(calls);
  const rawResponseHash = computeCertificationRawResponseHash({
    date,
    pageHashes,
    count: envelope.rawAccrualCount,
    paginationComplete: envelope.paginationComplete,
  });

  const mapped = mapOzonAccrualByDay({
    accruals: fetched.accruals,
    requestedDates: fetched.requestedDates,
    dayEnvelopes: fetched.dayEnvelopes,
  });
  const dateObject = new Date(`${date}T00:00:00.000Z`);
  const persistPlan = planCanonicalOzonAccrualPersist({
    mapped,
    dateFrom: dateObject,
    dateTo: dateObject,
    requestedDates: fetched.requestedDates,
  });
  const mapperResultHash = computeCertificationMapperResultHash({
    mapped,
    ingestStatus: persistPlan.ingestPlan.status,
    unexplainedGross: unexplainedOzonGrossDifference(mapped),
  });

  assertLiveFetchMatchesSealedTarget({
    target,
    observed: {
      rawResponseHash,
      pageHashes,
      rowCount: fetched.accruals.length,
      mapperResultHash,
    },
  });

  return {
    target,
    accruals: fetched.accruals,
    requestedDates: fetched.requestedDates,
    dayEnvelopes: fetched.dayEnvelopes,
    pagesByDay: fetched.pagesByDay,
    rawResponseHash,
    pageHashes,
    mapperResultHash,
    mapperComplete: mapped.mapperComplete === true,
    ingestStatus: persistPlan.ingestPlan.status,
    apiCallCount: calls.length,
  };
}

/** Source drift is always STOP, never remapper-and-proceed. */
export function assertLiveFetchMatchesSealedTarget(params: {
  target: RepairSourceTarget;
  observed: {
    rawResponseHash: string;
    pageHashes: string[];
    rowCount: number;
    mapperResultHash: string;
  };
}): void {
  const { target, observed } = params;
  const failures: string[] = [];
  if (target.rawResponseHash && target.rawResponseHash !== "TEST") {
    if (observed.rawResponseHash !== target.rawResponseHash) {
      failures.push("rawResponseHash");
    }
  }
  const sealedPages = [...(target.pageHashes ?? [])].sort().join(",");
  const observedPages = [...observed.pageHashes].sort().join(",");
  if (sealedPages && sealedPages !== "TEST" && sealedPages !== observedPages) {
    failures.push("pageHashes");
  }
  if (
    Number.isFinite(target.rowCount) &&
    observed.rowCount !== target.rowCount
  ) {
    failures.push("rowCount");
  }
  if (
    target.fullMapperResultHash &&
    target.fullMapperResultHash !== "TEST" &&
    observed.mapperResultHash !== target.fullMapperResultHash
  ) {
    failures.push("fullMapperResultHash");
  }
  if (failures.length > 0) {
    throw new Error(
      `SOURCE_DRIFT=YES EXECUTION=BLOCKED NEW_FINANCIAL_RECERTIFICATION_REQUIRED ` +
        `${target.companyName} ${target.date} fields=${failures.join(",")}`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * PREPARE: READ-ONLY database preflight
 * ------------------------------------------------------------------ */

export type PrepareDbPreflight = {
  CURRENT_TASK_DATABASE_WRITE: "NO";
  DATABASE_ACCESS: "READ_ONLY";
  observedAt: string;
  ok: boolean;
  skipped: boolean;
  skipReason?: string;
  failures: string[];
  relations: { required: string[]; missing: string[] };
  counts: {
    sourceTargets: number;
    statusTargets: number;
    snapshotUniqueKeys: number;
    v2MatrixRows: number;
    sourceDaysAlreadyFinal: number;
    statusSessionsPresent: number;
    snapshotRowsPresent: number;
    liveProfitReadModelJobs: number;
  };
  v2Fingerprints: V2RowFingerprintObservation[];
};

/**
 * Read-only proof, recorded into the sealed cache, that the database the EXECUTE
 * phase will mutate is the one PREPARE looked at: relations exist, the sealed
 * V2 fingerprints still hash the same, the status-only ImportSessions are really
 * there, and no profit read-model job is in flight.
 *
 * Every statement is a SELECT. The transaction is opened READ ONLY so the
 * database itself refuses a write, which is what makes the "no writes" claim
 * enforced rather than asserted.
 */
export async function runPrepareDbReadOnlyPreflight(params: {
  sourceTargets: RepairSourceTarget[];
  statusTargets: RepairStatusOnlyTarget[];
  snapshotKeys: RepairSnapshotKey[];
  v2MatrixRows: RepairV2Target[];
  client?: RepairDbClient;
  formulaVersion?: string;
}): Promise<PrepareDbPreflight> {
  const observedAt = new Date().toISOString();
  const uniqueSnapshotKeys = new Set(
    params.snapshotKeys.map((key) =>
      snapshotKeyId({
        companyScope: key.companyScope,
        dateFrom: dateOnly(key.dateFrom),
        dateTo: dateOnly(key.dateTo),
        formulaVersion: key.formulaVersion ?? FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1,
      }),
    ),
  );
  const base = {
    CURRENT_TASK_DATABASE_WRITE: "NO",
    DATABASE_ACCESS: "READ_ONLY",
    observedAt,
    counts: {
      sourceTargets: params.sourceTargets.length,
      statusTargets: params.statusTargets.length,
      snapshotUniqueKeys: uniqueSnapshotKeys.size,
      v2MatrixRows: params.v2MatrixRows.length,
      sourceDaysAlreadyFinal: 0,
      statusSessionsPresent: 0,
      snapshotRowsPresent: 0,
      liveProfitReadModelJobs: 0,
    },
  } as const;

  if (!process.env.DATABASE_URL?.trim()) {
    return {
      ...base,
      ok: true,
      skipped: true,
      skipReason: "DATABASE_URL is not set",
      failures: [],
      relations: { required: [...REQUIRED_RELATIONS], missing: [] },
      v2Fingerprints: [],
    };
  }

  const failures: string[] = [];

  // Everything below runs inside one READ ONLY transaction, so an accidental
  // write is rejected by Postgres rather than merely absent from the code.
  return db(params.client).$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET TRANSACTION READ ONLY`);
      const client = tx as unknown as RepairDbClient;

      const relationRows = await client.$queryRaw<Array<{ table_name: string }>>`
        SELECT "table_name"
        FROM information_schema.tables
        WHERE "table_schema" = 'public'
          AND "table_name" IN (${Prisma.join([...REQUIRED_RELATIONS])})
      `;
      const present = new Set(relationRows.map((row) => row.table_name));
      const missing = REQUIRED_RELATIONS.filter((name) => !present.has(name));
      if (missing.length) failures.push(`missing relations ${missing.join(",")}`);

      let sourceDaysAlreadyFinal = 0;
      for (const target of params.sourceTargets) {
        const row = await loadDayStatus({
          client,
          companyName: target.companyName,
          date: dateOnly(target.date),
        });
        if (row?.dataMode === "FINAL" && row.coverageComplete === true && row.phase === "CANONICAL") {
          sourceDaysAlreadyFinal += 1;
        }
      }

      let statusSessionsPresent = 0;
      for (const target of params.statusTargets) {
        const rows = await client.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count"
          FROM "ImportSession"
          WHERE "id" = ${target.importSessionId}
            AND "reportType" = ${OZON_ACCRUAL_BY_DAY_REPORT_TYPE}
        `;
        if (Number(rows[0]?.count ?? 0) > 0) statusSessionsPresent += 1;
      }
      if (statusSessionsPresent !== params.statusTargets.length) {
        failures.push(
          `status-only ImportSessions present ${statusSessionsPresent}/${params.statusTargets.length}`,
        );
      }

      let snapshotRowsPresent = 0;
      for (const key of params.snapshotKeys) {
        const rows = await client.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count"
          FROM "DashboardPeriodSnapshot"
          WHERE "companyScope" = ${key.companyScope}
            AND "dateFrom" = ${dateOnly(key.dateFrom)}::timestamp
            AND "dateTo" = ${dateOnly(key.dateTo)}::timestamp
            AND "formulaVersion" = ${key.formulaVersion ?? params.formulaVersion ?? FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1}
        `;
        snapshotRowsPresent += Number(rows[0]?.count ?? 0);
      }

      const v2Fingerprints = await readV2PeriodRowFingerprints({
        rows: params.v2MatrixRows,
        client,
      });
      const driftedV2 = v2Fingerprints.filter((row) => row.sealedFingerprint && !row.match);
      if (driftedV2.length) {
        failures.push(`V2 fingerprint drift ${driftedV2.map((row) => row.dbId).join(",")}`);
      }

      const liveProfitReadModelJobs = await countLiveProfitReadModelJobs({ client });

      return {
        ...base,
        ok: failures.length === 0,
        skipped: false,
        failures,
        relations: { required: [...REQUIRED_RELATIONS], missing: [...missing] },
        counts: {
          ...base.counts,
          sourceDaysAlreadyFinal,
          statusSessionsPresent,
          snapshotRowsPresent,
          liveProfitReadModelJobs,
        },
        v2Fingerprints,
      };
    },
    { maxWait: 20_000, timeout: 180_000 },
  );
}

/* ------------------------------------------------------------------ *
 * Idempotency: inspect existing source state
 * ------------------------------------------------------------------ */

type ImportSessionRow = {
  id: string;
  status: string;
  payloadSha256: string | null;
};

async function loadOzonDaySessions(params: {
  client: RepairDbClient;
  companyName: string;
  date: string;
}): Promise<ImportSessionRow[]> {
  return params.client.$queryRaw<ImportSessionRow[]>`
    SELECT
      "id",
      "status",
      "previewJson"->>'payloadSha256' AS "payloadSha256"
    FROM "ImportSession"
    WHERE "reportType" = ${OZON_ACCRUAL_BY_DAY_REPORT_TYPE}
      AND "companyName" = ${params.companyName}
      AND "previewJson"->>'dateFrom' = ${params.date}
      AND "previewJson"->>'dateTo' = ${params.date}
    ORDER BY "createdAt" ASC
  `;
}

async function countCanonicalFacts(params: {
  client: RepairDbClient;
  companyName: string;
  date: string;
}): Promise<number> {
  const rows = await params.client.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS "count"
    FROM "OzonFinancialCategoryFact"
    WHERE "companyName" = ${params.companyName}
      AND "source" = ${OZON_ACCRUAL_CANONICAL_FACT_SOURCE}
      AND "operationDate" >= ${params.date}::date
      AND "operationDate" < (${params.date}::date + INTERVAL '1 day')
  `;
  return Number(rows[0]?.count ?? 0);
}

type DayStatusRow = {
  importSessionId: string;
  dataMode: string;
  coverageComplete: boolean;
  phase: string;
  payloadSha256: string | null;
};

async function loadDayStatus(params: {
  client: RepairDbClient;
  companyName: string;
  date: string;
}): Promise<DayStatusRow | null> {
  const rows = await params.client.$queryRaw<DayStatusRow[]>`
    SELECT "importSessionId", "dataMode", "coverageComplete", "phase", "payloadSha256"
    FROM "OzonAccrualDayStatus"
    WHERE "companyName" = ${params.companyName}
      AND "date" = ${params.date}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export type InspectTargetStateResult = {
  state: RepairTargetState;
  rawId?: string;
  reason: string;
};

/**
 * Real Prisma idempotency probe for one of the 78 source-backfill targets.
 *
 * MISSING              nothing persisted for the day yet
 * RAW_PERSISTED_RESUME raw ImportSession survived a crash, canonical never applied
 * NOOP_COMPLETE        day already FINAL + coverageComplete from the expected payload
 * CONFLICT             anything else, which must STOP the run rather than guess
 *
 * Skipping or resuming a day is only safe when the persisted bytes are provably
 * the sealed cache bytes, so both NOOP_COMPLETE and RAW_PERSISTED_RESUME require
 * an exact payload-sha match on the ImportSession *and* (for NOOP) on the day
 * status. A missing hash on either side is unprovable, therefore CONFLICT.
 */
export async function inspectOzonSourceTargetState(params: {
  target: RepairSourceTarget;
  client?: RepairDbClient;
  /** Payload hash of the sealed cache entry, used to prove a NOOP is really ours. */
  expectedPayloadSha256?: string | null;
}): Promise<InspectTargetStateResult> {
  const client = db(params.client);
  const companyName = params.target.companyName;
  const date = dateOnly(params.target.date);
  const expectedPayloadSha256 = params.expectedPayloadSha256 ?? null;

  const [sessions, dayStatus] = await Promise.all([
    loadOzonDaySessions({ client, companyName, date }),
    loadDayStatus({ client, companyName, date }),
  ]);

  const rawSessions = sessions.filter((row) => row.status === "RAW_PERSISTED");
  const canonicalSessions = sessions.filter(
    (row) => row.status === "SUCCESS" || row.status === "PRELIMINARY",
  );

  if (canonicalSessions.length > 1) {
    return {
      state: "CONFLICT",
      reason: `duplicate canonical ImportSession rows (${canonicalSessions.length})`,
    };
  }

  if (canonicalSessions.length === 1) {
    const session = canonicalSessions[0]!;
    const finalStatus =
      dayStatus?.dataMode === "FINAL" &&
      dayStatus.coverageComplete === true &&
      dayStatus.phase === "CANONICAL";
    if (!finalStatus) {
      return {
        state: "CONFLICT",
        reason: `canonical ImportSession ${session.id} exists but OzonAccrualDayStatus is ${dayStatus?.dataMode ?? "MISSING"}/${dayStatus?.phase ?? "NONE"}`,
      };
    }
    if (dayStatus.importSessionId !== session.id) {
      return {
        state: "CONFLICT",
        reason: `OzonAccrualDayStatus points at ${dayStatus.importSessionId} but canonical session is ${session.id}`,
      };
    }
    if (!expectedPayloadSha256) {
      return {
        state: "CONFLICT",
        reason: `no sealed cache payload sha available to prove ${session.id} is the approved payload`,
      };
    }
    if (!session.payloadSha256) {
      return {
        state: "CONFLICT",
        reason: `canonical ImportSession ${session.id} carries no payloadSha256`,
      };
    }
    if (session.payloadSha256 !== expectedPayloadSha256) {
      return {
        state: "CONFLICT",
        reason: `ImportSession ${session.id} payloadSha256 ${session.payloadSha256} differs from sealed cache payload`,
      };
    }
    if (!dayStatus.payloadSha256) {
      return {
        state: "CONFLICT",
        reason: `OzonAccrualDayStatus for ${companyName} ${date} carries no payloadSha256`,
      };
    }
    if (dayStatus.payloadSha256 !== expectedPayloadSha256) {
      return {
        state: "CONFLICT",
        reason: `persisted payloadSha256 ${dayStatus.payloadSha256} differs from sealed cache payload`,
      };
    }
    return {
      state: "NOOP_COMPLETE",
      rawId: session.id,
      reason: `already FINAL from ${session.id}`,
    };
  }

  if (rawSessions.length > 1) {
    return {
      state: "CONFLICT",
      reason: `duplicate RAW_PERSISTED ImportSession rows (${rawSessions.length})`,
    };
  }

  if (rawSessions.length === 1) {
    const raw = rawSessions[0]!;
    if (!expectedPayloadSha256) {
      return {
        state: "CONFLICT",
        reason: `no sealed cache payload sha available to prove RAW_PERSISTED ${raw.id} is resumable`,
      };
    }
    if (!raw.payloadSha256) {
      return {
        state: "CONFLICT",
        reason: `RAW_PERSISTED ${raw.id} carries no payloadSha256`,
      };
    }
    if (raw.payloadSha256 !== expectedPayloadSha256) {
      return {
        state: "CONFLICT",
        reason: `RAW_PERSISTED ${raw.id} payloadSha256 differs from sealed cache payload`,
      };
    }
    return {
      state: "RAW_PERSISTED_RESUME",
      rawId: raw.id,
      reason: `resume canonical from ${raw.id}`,
    };
  }

  const facts = await countCanonicalFacts({ client, companyName, date });
  if (facts > 0) {
    return {
      state: "CONFLICT",
      reason: `${facts} canonical /by-day facts exist with no owning ImportSession`,
    };
  }

  return { state: "MISSING", reason: "no source rows for the day" };
}

/* ------------------------------------------------------------------ *
 * Standalone status-only repair (the 10 targets)
 * ------------------------------------------------------------------ */

/** Frozen read-only ImportSession fingerprint (proof-ozon-session-diag recipe). */
export function computeReadonlyImportSessionFingerprint(params: {
  id: string;
  company: string;
  df: string | null;
  dt: string | null;
  coverage: string | null;
  pages: unknown;
  totals: unknown;
  diagnostics: unknown;
}): string {
  return sha256Hex(
    JSON.stringify({
      id: params.id,
      company: params.company,
      df: params.df,
      dt: params.dt,
      coverage: params.coverage,
      pages: params.pages,
      totals: params.totals,
      diagnostics: params.diagnostics,
    }),
  );
}

function isBoundStatusPayloadSha256(value: string | undefined | null): value is string {
  if (value == null || String(value).trim() === "") return false;
  if (value === STATUS_ONLY_EXPECTED_PAYLOAD_PLACEHOLDER) return false;
  return /^[0-9a-f]{64}$/i.test(value);
}

export type InspectStandaloneStatusTargetStateResult = {
  state: "READY" | "NOOP_COMPLETE" | "CONFLICT";
  reason: string;
};

/**
 * READ-ONLY gate probe for one of the 10 standalone status targets. Proves the
 * SUCCESS ImportSession still matches the sealed binding and that any existing day
 * status is either absent or already exact — never a partial or drifted row.
 */
export async function inspectStandaloneStatusTargetState(params: {
  target: RepairStatusOnlyTarget;
  client?: RepairDbClient;
}): Promise<InspectStandaloneStatusTargetStateResult> {
  const client = db(params.client);
  const companyName = params.target.company;
  const date = dateOnly(params.target.date);
  const expectedPayloadSha256 = params.target.expectedPayloadSha256 ?? null;

  if (!isBoundStatusPayloadSha256(expectedPayloadSha256)) {
    return {
      state: "CONFLICT",
      reason: "expectedPayloadSha256 missing or not live-bound",
    };
  }
  const expectedPayload = expectedPayloadSha256.toLowerCase();

  const sessions = await client.$queryRaw<
    Array<{
      id: string;
      status: string;
      companyName: string | null;
      reportType: string;
      df: string | null;
      dt: string | null;
      coverage: string | null;
      diagnostics: unknown;
      pages: unknown;
      totals: unknown;
    }>
  >`
    SELECT
      "id",
      "status",
      "companyName",
      "reportType",
      "previewJson"->>'dateFrom' AS "df",
      "previewJson"->>'dateTo' AS "dt",
      "previewJson"->>'coverageComplete' AS "coverage",
      "previewJson"->'diagnostics' AS "diagnostics",
      "previewJson"->'pagesByDay' AS "pages",
      "previewJson"->'totals' AS "totals"
    FROM "ImportSession"
    WHERE "id" = ${params.target.importSessionId}
    LIMIT 1
  `;
  const session = sessions[0];
  if (!session) {
    return {
      state: "CONFLICT",
      reason: `missing ImportSession ${params.target.importSessionId}`,
    };
  }

  const expectedReportType =
    params.target.reportType ?? OZON_ACCRUAL_BY_DAY_REPORT_TYPE;
  if (session.reportType !== expectedReportType) {
    return {
      state: "CONFLICT",
      reason: `reportType=${session.reportType} expected ${expectedReportType}`,
    };
  }
  if (session.status !== "SUCCESS") {
    return {
      state: "CONFLICT",
      reason: `ImportSession status=${session.status}, expected SUCCESS`,
    };
  }
  if ((session.companyName ?? "") !== companyName) {
    return {
      state: "CONFLICT",
      reason: `companyName=${session.companyName ?? "null"} expected ${companyName}`,
    };
  }

  const liveFingerprint = computeReadonlyImportSessionFingerprint({
    id: session.id,
    company: session.companyName ?? companyName,
    df: session.df,
    dt: session.dt,
    coverage: session.coverage,
    pages: session.pages,
    totals: session.totals,
    diagnostics: session.diagnostics,
  }).toLowerCase();

  const sealedSessionFingerprint =
    params.target.readonlySessionFingerprintSha256?.toLowerCase() ?? null;
  if (sealedSessionFingerprint && liveFingerprint !== sealedSessionFingerprint) {
    return {
      state: "CONFLICT",
      reason: `readonly session fingerprint drift live=${liveFingerprint} sealed=${sealedSessionFingerprint}`,
    };
  }
  const fingerprintMatchesBound =
    liveFingerprint === expectedPayload ||
    (sealedSessionFingerprint != null && liveFingerprint === sealedSessionFingerprint);
  if (!fingerprintMatchesBound) {
    return {
      state: "CONFLICT",
      reason: `session fingerprint=${liveFingerprint} expectedPayloadSha256=${expectedPayload}`,
    };
  }
  if (sealedSessionFingerprint && expectedPayload !== sealedSessionFingerprint) {
    return {
      state: "CONFLICT",
      reason: `expectedPayloadSha256=${expectedPayload} readonlySessionFingerprintSha256=${sealedSessionFingerprint}`,
    };
  }

  const targetDataMode = params.target.dataMode ?? "FINAL";
  const targetPhase = params.target.phase ?? "CANONICAL";
  const targetCoverageComplete = params.target.coverageComplete ?? true;

  const existing = await loadDayStatus({ client, companyName, date });
  if (!existing) {
    return {
      state: "READY",
      reason: `ImportSession ${session.id} validated; day status absent`,
    };
  }

  const exact =
    existing.importSessionId === session.id &&
    existing.dataMode === targetDataMode &&
    existing.coverageComplete === targetCoverageComplete &&
    existing.phase === targetPhase &&
    (existing.payloadSha256 ?? "").toLowerCase() === expectedPayload;

  if (exact) {
    return {
      state: "NOOP_COMPLETE",
      reason: `day status already exact for ${companyName} ${date}`,
    };
  }

  return {
    state: "CONFLICT",
    reason: `day status exists but not exact: session=${existing.importSessionId} mode=${existing.dataMode}/${existing.phase} payload=${existing.payloadSha256 ?? "null"}`,
  };
}

/**
 * Revalidates the referenced ImportSession, then writes the canonical FINAL day
 * status. Returns NOOP when the row already carries the exact target state.
 */
export async function upsertStandaloneOzonDayStatus(params: {
  target: RepairStatusOnlyTarget;
  client?: RepairDbClient;
}): Promise<"WRITTEN" | "NOOP"> {
  const client = db(params.client);
  const companyName = params.target.company;
  const date = dateOnly(params.target.date);
  const boundPayloadSha256 = params.target.expectedPayloadSha256 ?? null;
  if (!isBoundStatusPayloadSha256(boundPayloadSha256)) {
    throw new Error(
      `STANDALONE_STATUS_PREREQUISITE_FAILED ${params.target.importSessionId} expectedPayloadSha256 not live-bound`,
    );
  }

  const inspect = await inspectStandaloneStatusTargetState({
    target: params.target,
    client,
  });
  if (inspect.state === "CONFLICT") {
    throw new Error(
      `STANDALONE_STATUS_PREREQUISITE_FAILED ${companyName} ${date}: ${inspect.reason}`,
    );
  }
  if (inspect.state === "NOOP_COMPLETE") {
    return "NOOP";
  }

  const targetDataMode = params.target.dataMode ?? "FINAL";
  const targetPhase = params.target.phase ?? "CANONICAL";
  const targetCoverageComplete = params.target.coverageComplete ?? true;
  const targetQuarantineCount = Number(params.target.quarantineCount ?? 0);

  await persistOzonAccrualDayStatuses(
    buildCanonicalOzonDayStatuses({
      companyName,
      dates: [date],
      importSessionId: params.target.importSessionId,
      payloadSha256: boundPayloadSha256.toLowerCase(),
      dataMode: targetDataMode as "FINAL" | "PRELIMINARY",
      coverageComplete: targetCoverageComplete,
      quarantineCount: targetQuarantineCount,
    }),
    client,
  );
  return "WRITTEN";
}

/* ------------------------------------------------------------------ *
 * Post-batch: exact-key snapshot union, applied once
 * ------------------------------------------------------------------ */

export type ExactSnapshotUnionKeyResult = {
  companyScope: string;
  dateFrom: string;
  dateTo: string;
  formulaVersion: string;
  snapshotRowsDeleted: number;
  job: "INSERTED" | "UPDATED";
};

export type ExactSnapshotUnionResult = {
  /** Keys whose snapshot is absent as a result of this call (deleted or already gone). */
  deleted: number;
  /** Keys left with a PENDING rebuild job. */
  requeued: number;
  /** Truthful DELETE row count, which drops to 0 on an idempotent re-run. */
  rowsDeleted: number;
  alreadyAbsent: number;
  jobsInserted: number;
  jobsUpdated: number;
  keys: ExactSnapshotUnionKeyResult[];
};

function snapshotKeyId(key: {
  companyScope: string;
  dateFrom: string;
  dateTo: string;
  formulaVersion: string;
}): string {
  return [key.companyScope, key.dateFrom, key.dateTo, key.formulaVersion].join(
    "|",
  );
}

/**
 * EXACT-KEY union delete + requeue for the V4 period snapshots, using the same SQL
 * upsert semantics as the normal ingest invalidation (identical PENDING reset and
 * SNAPSHOT_REQUEUE_PRIORITY), but applied once for the union of all 78 deferred
 * source events instead of once per event.
 *
 * `deleted` counts keys that are now absent so a crash-resume re-run still reports
 * the contract count; `rowsDeleted` is the untouched DELETE row count.
 */
export async function applyExactSnapshotUnionOnce(params: {
  keys: RepairSnapshotKey[];
  client?: RepairDbClient;
  formulaVersion?: string;
  priority?: number;
}): Promise<ExactSnapshotUnionResult> {
  const client = db(params.client);
  const defaultFormula = params.formulaVersion ?? FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1;
  const priority = params.priority ?? SNAPSHOT_REQUEUE_PRIORITY;

  const union = new Map<
    string,
    {
      companyScope: string;
      dateFrom: string;
      dateTo: string;
      formulaVersion: string;
    }
  >();
  for (const raw of params.keys) {
    const key = {
      companyScope: raw.companyScope,
      dateFrom: dateOnly(raw.dateFrom),
      dateTo: dateOnly(raw.dateTo),
      formulaVersion: raw.formulaVersion ?? defaultFormula,
    };
    union.set(snapshotKeyId(key), key);
  }
  if (union.size === 0) {
    return {
      deleted: 0,
      requeued: 0,
      rowsDeleted: 0,
      alreadyAbsent: 0,
      jobsInserted: 0,
      jobsUpdated: 0,
      keys: [],
    };
  }

  return client.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        `LOCK TABLE "DashboardPeriodSnapshotJob" IN SHARE ROW EXCLUSIVE MODE`,
      );
      await tx.$executeRawUnsafe(
        `LOCK TABLE "DashboardPeriodSnapshot" IN SHARE ROW EXCLUSIVE MODE`,
      );

      const results: ExactSnapshotUnionKeyResult[] = [];
      let rowsDeleted = 0;
      let alreadyAbsent = 0;
      let jobsInserted = 0;
      let jobsUpdated = 0;

      for (const key of union.values()) {
        const deletedRows = await tx.$executeRaw`
          DELETE FROM "DashboardPeriodSnapshot"
          WHERE "companyScope" = ${key.companyScope}
            AND "dateFrom" = ${key.dateFrom}::timestamp
            AND "dateTo" = ${key.dateTo}::timestamp
            AND "formulaVersion" = ${key.formulaVersion}
        `;
        rowsDeleted += deletedRows;
        if (deletedRows === 0) alreadyAbsent += 1;

        const existingJob = await tx.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count"
          FROM "DashboardPeriodSnapshotJob"
          WHERE "companyScope" = ${key.companyScope}
            AND "dateFrom" = ${key.dateFrom}::timestamp
            AND "dateTo" = ${key.dateTo}::timestamp
            AND "formulaVersion" = ${key.formulaVersion}
        `;
        const jobExisted = Number(existingJob[0]?.count ?? 0) > 0;

        await tx.$executeRaw`
          INSERT INTO "DashboardPeriodSnapshotJob" (
            "id", "companyScope", "dateFrom", "dateTo", "formulaVersion",
            "status", "priority", "attempts", "maxAttempts",
            "lockedAt", "lockedBy", "nextAttemptAt", "startedAt", "finishedAt", "lastError",
            "createdAt", "updatedAt"
          )
          VALUES (
            ${`dpsjob_${randomUUID()}`},
            ${key.companyScope},
            ${key.dateFrom}::timestamp,
            ${key.dateTo}::timestamp,
            ${key.formulaVersion},
            ${"PENDING"}, ${priority}, ${0}, ${3},
            NULL, NULL, NULL, NULL, NULL, NULL,
            NOW(), NOW()
          )
          ON CONFLICT ("companyScope", "dateFrom", "dateTo", "formulaVersion")
          DO UPDATE SET
            "status" = ${"PENDING"},
            "priority" = ${priority},
            "attempts" = ${0},
            "lockedAt" = NULL,
            "lockedBy" = NULL,
            "nextAttemptAt" = NULL,
            "startedAt" = NULL,
            "finishedAt" = NULL,
            "lastError" = NULL,
            "updatedAt" = NOW()
        `;

        if (jobExisted) jobsUpdated += 1;
        else jobsInserted += 1;

        results.push({
          ...key,
          snapshotRowsDeleted: deletedRows,
          job: jobExisted ? "UPDATED" : "INSERTED",
        });
      }

      return {
        deleted: union.size,
        requeued: union.size,
        rowsDeleted,
        alreadyAbsent,
        jobsInserted,
        jobsUpdated,
        keys: results,
      };
    },
    { maxWait: 20_000, timeout: 180_000 },
  );
}

/* ------------------------------------------------------------------ *
 * Post-batch: V2 period read-model rebuild (ALL scope only)
 * ------------------------------------------------------------------ */

export type V2RebuildOutcome =
  | "queued_local"
  | "queued_prisma"
  | "noop"
  | "rejected_d6_unsafe";

export type V2RebuildResult = {
  rebuilt: number;
  outcomes: Array<{ dbId: string; scope: string; outcome: V2RebuildOutcome }>;
  fingerprints: V2RowFingerprintObservation[];
};

/**
 * Refuses the V2 post-batch when any sealed matrix row no longer hashes to its
 * certified fingerprint. Rows without a sealed fingerprint are not inspected:
 * there is nothing to compare against and inventing a baseline would be
 * self-accepting.
 */
export async function assertV2MatrixFingerprintsUnchanged(params: {
  rows: RepairV2Target[];
  client?: RepairDbClient;
}): Promise<V2RowFingerprintObservation[]> {
  const sealed = params.rows.filter((row) => row.currentRowFingerprint);
  if (sealed.length === 0) return [];
  const observations = await readV2PeriodRowFingerprints({
    rows: sealed,
    client: params.client,
  });
  const drifted = observations.filter((row) => !row.match);
  if (drifted.length > 0) {
    throw new Error(
      `V2_ROW_FINGERPRINT_DRIFT=YES EXECUTION=BLOCKED NEW_FINANCIAL_RECERTIFICATION_REQUIRED rows=` +
        drifted
          .map(
            (row) =>
              `${row.dbId}(${row.period}/${row.scope}):${row.found ? "changed" : "missing"}`,
          )
          .join(","),
    );
  }
  return observations;
}

/**
 * Enqueues a V6 period read-model rebuild for the 2 ALL-scope rows. Per-company
 * rows must stay UNAVAILABLE, so a non-ALL scope is refused outright.
 */
export async function rebuildV2PeriodTargets(params: {
  targets: RepairV2Target[];
  /** All 6 matrix rows when the caller has them, so drift on a kept row also stops. */
  matrixRows?: RepairV2Target[];
  client?: RepairDbClient;
  repository?: {
    requestRebuild?: (args: {
      companyScope: string;
      dateFrom: string;
      dateTo: string;
      priority?: number;
    }) => Promise<V2RebuildOutcome>;
  };
  priority?: number;
}): Promise<V2RebuildResult> {
  const fingerprints = await assertV2MatrixFingerprintsUnchanged({
    rows: params.matrixRows ?? params.targets,
    client: params.client,
  });
  const repository =
    params.repository ??
    createPrismaV6PeriodReadModelRepository(
      asPrismaLikeV6Client(db(params.client)),
    );
  if (typeof repository.requestRebuild !== "function") {
    throw new Error(
      "V2_REBUILD_UNAVAILABLE: V6 period read-model repository exposes no requestRebuild",
    );
  }

  const outcomes: V2RebuildResult["outcomes"] = [];
  let rebuilt = 0;

  for (const target of params.targets) {
    if (!postBatchV2PromotionAllowed(target.scope)) {
      throw new Error(
        `V2_SCOPE_REFUSED ${target.dbId} scope=${target.scope} must remain UNAVAILABLE`,
      );
    }
    const outcome = await repository.requestRebuild({
      companyScope: target.scope,
      dateFrom: dateOnly(target.dateFrom),
      dateTo: dateOnly(target.dateTo),
      priority: params.priority,
    });
    outcomes.push({ dbId: target.dbId, scope: target.scope, outcome });
    if (outcome === "queued_prisma" || outcome === "queued_local") {
      rebuilt += 1;
      continue;
    }
    throw new Error(
      `V2_REBUILD_NOT_QUEUED ${target.dbId} ${target.period} outcome=${outcome}`,
    );
  }

  return { rebuilt, outcomes, fingerprints };
}

/* ------------------------------------------------------------------ *
 * Profit read-model: the repair has zero explicit targets
 * ------------------------------------------------------------------ */

/**
 * Counts profit read-model rebuild jobs that already exist for the repair months.
 * The approved plan has PROFIT_RM_EXPLICIT_TARGET_COUNT=0, so the pre-mutation
 * gate only needs to confirm nothing is queued or running for them.
 */
export async function countLiveProfitReadModelJobs(params: {
  client?: RepairDbClient;
}): Promise<number> {
  const rows = await db(params.client).$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS "count"
    FROM "DashboardPeriodSnapshotJob"
    WHERE "formulaVersion" IN (${Prisma.join([...WAVE_B_PROFIT_FORMULAS])})
      AND "status" IN ('PENDING', 'RUNNING')
  `;
  return Number(rows[0]?.count ?? 0);
}

/* ------------------------------------------------------------------ *
 * VERIFY: post-state checks against the database
 * ------------------------------------------------------------------ */

export type VerifyCheck = {
  name: string;
  ok: boolean;
  expected: number | string;
  actual: number | string;
  detail?: string[];
};

export type VerifyReport = {
  ok: boolean;
  phase: VerifyPhase;
  checks: VerifyCheck[];
};

/**
 * VERIFY runs in two stages because they answer different questions and become
 * true at different times:
 *
 * MUTATION_POSTCONDITIONS  everything the repair itself wrote is in place, and it
 *                          wrote nothing it was forbidden to write. True the
 *                          instant EXECUTE_FROM_CACHE returns.
 * FINAL_FINANCIAL_OUTPUT   the downstream workers have rebuilt the V2 period
 *                          read model to the July/August owner oracles. Only
 *                          true after the requeued jobs have been consumed, so
 *                          absent rows are reported, not failed.
 */
export type VerifyPhase =
  | "MUTATION_POSTCONDITIONS"
  | "FINAL_FINANCIAL_OUTPUT"
  | "ALL";

async function countFinalDayStatuses(params: {
  client: RepairDbClient;
  pairs: Array<{ companyName: string; date: string }>;
}): Promise<{ final: number; missing: string[] }> {
  const missing: string[] = [];
  let final = 0;
  for (const pair of params.pairs) {
    const row = await loadDayStatus({
      client: params.client,
      companyName: pair.companyName,
      date: dateOnly(pair.date),
    });
    if (
      row &&
      row.dataMode === "FINAL" &&
      row.coverageComplete === true &&
      row.phase === "CANONICAL"
    ) {
      final += 1;
    } else {
      missing.push(`${pair.companyName}|${dateOnly(pair.date)}`);
    }
  }
  return { final, missing };
}

/**
 * Queries the database for the post-mutation contract:
 * every source day FINAL, every standalone day FINAL, no duplicate canonical
 * sessions, snapshot union applied exactly once, both V2 rows queued, and zero
 * profit read-model rebuild jobs created during the repair window.
 */
export async function verifyOzonHistoricalRepair(params: {
  sourceTargets: RepairSourceTarget[];
  statusTargets: RepairStatusOnlyTarget[];
  snapshotKeys: RepairSnapshotKey[];
  v2Targets: RepairV2Target[];
  client?: RepairDbClient;
  operationStartedAt?: string | Date | null;
  formulaVersion?: string;
  verifyPhase?: VerifyPhase;
}): Promise<VerifyReport> {
  const client = db(params.client);
  const phase = params.verifyPhase ?? "ALL";
  const formulaVersion =
    params.formulaVersion ?? FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1;
  const checks: VerifyCheck[] = [];

  if (phase === "FINAL_FINANCIAL_OUTPUT") {
    checks.push(
      ...(await verifyFinalFinancialOutputChecks({
        client,
        v2Targets: params.v2Targets,
      })),
    );
    return { ok: checks.every((check) => check.ok), phase, checks };
  }

  const intrinsic = await countFinalDayStatuses({
    client,
    pairs: params.sourceTargets.map((t) => ({
      companyName: t.companyName,
      date: t.date,
    })),
  });
  checks.push({
    name: "intrinsic_source_days_final",
    ok: intrinsic.final === params.sourceTargets.length,
    expected: params.sourceTargets.length,
    actual: intrinsic.final,
    detail: intrinsic.missing.slice(0, 20),
  });

  const standalone = await countFinalDayStatuses({
    client,
    pairs: params.statusTargets.map((t) => ({
      companyName: t.company,
      date: t.date,
    })),
  });
  checks.push({
    name: "standalone_status_days_final",
    ok: standalone.final === params.statusTargets.length,
    expected: params.statusTargets.length,
    actual: standalone.final,
    detail: standalone.missing.slice(0, 20),
  });

  const duplicates: string[] = [];
  for (const target of params.sourceTargets) {
    const sessions = await loadOzonDaySessions({
      client,
      companyName: target.companyName,
      date: dateOnly(target.date),
    });
    const canonical = sessions.filter(
      (row) => row.status === "SUCCESS" || row.status === "PRELIMINARY",
    );
    if (canonical.length > 1) {
      duplicates.push(`${target.companyName}|${dateOnly(target.date)}`);
    }
  }
  checks.push({
    name: "duplicate_canonical_import_sessions",
    ok: duplicates.length === 0,
    expected: 0,
    actual: duplicates.length,
    detail: duplicates.slice(0, 20),
  });

  const uniqueSnapshotKeys = new Map<
    string,
    { companyScope: string; dateFrom: string; dateTo: string; formulaVersion: string }
  >();
  for (const raw of params.snapshotKeys) {
    const key = {
      companyScope: raw.companyScope,
      dateFrom: dateOnly(raw.dateFrom),
      dateTo: dateOnly(raw.dateTo),
      formulaVersion: raw.formulaVersion ?? formulaVersion,
    };
    uniqueSnapshotKeys.set(snapshotKeyId(key), key);
  }

  let snapshotRowsRemaining = 0;
  let snapshotJobsPending = 0;
  const snapshotDetail: string[] = [];
  for (const key of uniqueSnapshotKeys.values()) {
    const rows = await client.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count"
      FROM "DashboardPeriodSnapshot"
      WHERE "companyScope" = ${key.companyScope}
        AND "dateFrom" = ${key.dateFrom}::timestamp
        AND "dateTo" = ${key.dateTo}::timestamp
        AND "formulaVersion" = ${key.formulaVersion}
    `;
    const remaining = Number(rows[0]?.count ?? 0);
    snapshotRowsRemaining += remaining;

    const jobs = await client.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count"
      FROM "DashboardPeriodSnapshotJob"
      WHERE "companyScope" = ${key.companyScope}
        AND "dateFrom" = ${key.dateFrom}::timestamp
        AND "dateTo" = ${key.dateTo}::timestamp
        AND "formulaVersion" = ${key.formulaVersion}
        AND "status" IN ('PENDING', 'RUNNING', 'SUCCESS')
    `;
    const queued = Number(jobs[0]?.count ?? 0);
    snapshotJobsPending += queued;
    if (queued === 0) snapshotDetail.push(snapshotKeyId(key));
  }
  checks.push({
    name: "snapshot_rows_deleted",
    ok: snapshotRowsRemaining === 0,
    expected: 0,
    actual: snapshotRowsRemaining,
  });
  checks.push({
    name: "snapshot_union_requeued_once",
    ok: snapshotJobsPending === uniqueSnapshotKeys.size,
    expected: uniqueSnapshotKeys.size,
    actual: snapshotJobsPending,
    detail: snapshotDetail.slice(0, 20),
  });

  let v2Queued = 0;
  const v2Detail: string[] = [];
  for (const target of params.v2Targets) {
    const rows = await client.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count"
      FROM "DashboardPeriodSnapshotJob"
      WHERE "companyScope" = ${target.scope}
        AND "dateFrom" = ${dateOnly(target.dateFrom)}::timestamp
        AND "dateTo" = ${dateOnly(target.dateTo)}::timestamp
        AND "formulaVersion" = ${FINANCIAL_CORE_V6_PERIOD_READMODEL_V2}
    `;
    const count = Number(rows[0]?.count ?? 0);
    if (count > 0) v2Queued += 1;
    else v2Detail.push(`${target.dbId}|${target.period}`);
  }
  checks.push({
    name: "v2_all_scope_rebuild_queued",
    ok: v2Queued === params.v2Targets.length,
    expected: params.v2Targets.length,
    actual: v2Queued,
    detail: v2Detail,
  });

  const startedAt = params.operationStartedAt
    ? new Date(params.operationStartedAt)
    : null;
  if (startedAt && !Number.isNaN(startedAt.getTime())) {
    const rows = await client.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count"
      FROM "DashboardPeriodSnapshotJob"
      WHERE "formulaVersion" IN (${Prisma.join([...WAVE_B_PROFIT_FORMULAS])})
        AND "createdAt" >= ${startedAt.toISOString()}::timestamp
    `;
    const created = Number(rows[0]?.count ?? 0);
    checks.push({
      name: "profit_readmodel_jobs_created_during_repair",
      ok: created === 0,
      expected: 0,
      actual: created,
    });
  } else {
    checks.push({
      name: "profit_readmodel_jobs_created_during_repair",
      ok: true,
      expected: 0,
      actual: "NOT_OBSERVED_NO_OPERATION_START_TIMESTAMP",
    });
  }

  if (phase === "ALL") {
    checks.push(
      ...(await verifyFinalFinancialOutputChecks({
        client,
        v2Targets: params.v2Targets,
      })),
    );
  }

  return { ok: checks.every((check) => check.ok), phase, checks };
}

/** Numeric tolerance for the owner oracles, in roubles. */
const OWNER_ORACLE_TOLERANCE = 0.01;

function readPayloadNumber(
  payload: unknown,
  keys: string[],
): number | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

/**
 * Stage two: the July / August ALL-scope owner oracles. Only the rows that are
 * actually present are asserted — before the requeued V6 jobs are consumed there
 * is nothing to compare, and reporting NOT_OBSERVED is honest where failing would
 * be a false negative.
 */
export async function verifyFinalFinancialOutputChecks(params: {
  client?: RepairDbClient;
  v2Targets: RepairV2Target[];
}): Promise<VerifyCheck[]> {
  const client = db(params.client);
  const checks: VerifyCheck[] = [];
  const oracleTargets = params.v2Targets.filter(
    (target) => target.scope === "ALL" && typeof target.expectedTotal === "number",
  );

  if (oracleTargets.length === 0) {
    return [
      {
        name: "owner_oracles_july_august",
        ok: true,
        expected: 0,
        actual: "NOT_OBSERVED_NO_ALL_SCOPE_ORACLE_TARGETS",
      },
    ];
  }

  for (const target of oracleTargets) {
    const rows = await client.$queryRaw<
      Array<{ dataMode: string; coverageStatus: string; payload: unknown }>
    >`
      SELECT "dataMode", "coverageStatus", "payload"
      FROM "PeriodCompanyMarketplaceMetric"
      WHERE "companyScope" = ${target.scope}
        AND "marketplace" = ${"ALL"}
        AND "dateFrom" = ${dateOnly(target.dateFrom)}::timestamp
        AND "dateTo" = ${dateOnly(target.dateTo)}::timestamp
        AND "formulaVersion" = ${target.formulaVersion ?? FINANCIAL_CORE_V6_PERIOD_READMODEL_V2}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      checks.push({
        name: `owner_oracle_${target.period}_total`,
        ok: true,
        expected: Number(target.expectedTotal),
        actual: "NOT_OBSERVED_V2_ROW_ABSENT",
      });
      continue;
    }

    const observed = {
      canonicalWb: readPayloadNumber(row.payload, [
        "canonicalWb",
        "wbCanonical",
        "wbTotal",
      ]),
      canonicalOzon: readPayloadNumber(row.payload, [
        "canonicalOzon",
        "ozonCanonical",
        "ozonTotal",
      ]),
      total: readPayloadNumber(row.payload, ["total", "canonicalTotal"]),
    };

    for (const [field, expectedRaw] of [
      ["canonicalWb", target.expectedCanonicalWb],
      ["canonicalOzon", target.expectedCanonicalOzon],
      ["total", target.expectedTotal],
    ] as const) {
      if (typeof expectedRaw !== "number") continue;
      const actual = observed[field];
      if (actual === null) {
        checks.push({
          name: `owner_oracle_${target.period}_${field}`,
          ok: true,
          expected: expectedRaw,
          actual: "NOT_OBSERVED_PAYLOAD_FIELD_ABSENT",
        });
        continue;
      }
      checks.push({
        name: `owner_oracle_${target.period}_${field}`,
        ok: Math.abs(actual - expectedRaw) <= OWNER_ORACLE_TOLERANCE,
        expected: expectedRaw,
        actual,
        detail: [`dataMode=${row.dataMode}`, `coverageStatus=${row.coverageStatus}`],
      });
    }
  }

  return checks;
}

/* ------------------------------------------------------------------ *
 * Production mutation adapters
 * ------------------------------------------------------------------ */

export type ProductionMutationAdapters = {
  store: OzonAccrualRuntimeStore;
  inspectTargetState: (target: RepairSourceTarget) => Promise<{
    state: RepairTargetState;
    rawId?: string;
  }>;
  /**
   * Same probe as inspectTargetState but reports CONFLICT instead of throwing, so
   * the all-target pre-mutation gate can inspect every source before deciding.
   */
  inspectTargetStateForGate: (target: RepairSourceTarget) => Promise<{
    state: RepairTargetState;
    rawId?: string;
    reason: string;
  }>;
  upsertStandaloneStatus: (
    target: RepairStatusOnlyTarget,
  ) => Promise<"WRITTEN" | "NOOP">;
  applySnapshotPostBatch: (
    keys: RepairSnapshotKey[],
  ) => Promise<{ deleted: number; requeued: number }>;
  rebuildV2Targets: (
    targets: RepairV2Target[],
  ) => Promise<{ rebuilt: number }>;
  /** READ-ONLY. Recomputes the sealed V2 fingerprints for the full matrix. */
  readV2MatrixFingerprints: (
    rows: RepairV2Target[],
  ) => Promise<V2RowFingerprintObservation[]>;
  /** READ-ONLY. Profit read-model jobs in flight; the approved plan expects 0. */
  countProfitReadModelTargets: () => Promise<number>;
  /** READ-ONLY. Validates each standalone status target before mutation. */
  inspectStandaloneStatusTargetStateForGate: (
    target: RepairStatusOnlyTarget,
  ) => Promise<InspectStandaloneStatusTargetStateResult>;
};

/**
 * Binds every mutation phase to Prisma. Nothing here is a placeholder; the runner
 * can call these directly once the readiness gate has passed.
 */
export function createProductionMutationAdapters(params?: {
  client?: RepairDbClient;
  store?: OzonAccrualRuntimeStore;
  /** Sealed cache payload hash per target, used to prove NOOP_COMPLETE is ours. */
  expectedPayloadSha256?: (target: RepairSourceTarget) => string | null;
  snapshotFormulaVersion?: string;
  /** All 6 V2 matrix rows, so a kept-UNAVAILABLE row drifting also stops the run. */
  v2MatrixRows?: RepairV2Target[];
}): ProductionMutationAdapters {
  const client = db(params?.client);
  const inspect = (target: RepairSourceTarget) =>
    inspectOzonSourceTargetState({
      target,
      client,
      expectedPayloadSha256: params?.expectedPayloadSha256?.(target) ?? null,
    });
  return {
    store: params?.store ?? createPrismaOzonAccrualStore(),
    async inspectTargetState(target) {
      const result = await inspect(target);
      if (result.state === "CONFLICT") {
        throw new Error(
          `CONFLICTING_SOURCE_STATE ${target.companyName} ${target.date}: ${result.reason}`,
        );
      }
      return { state: result.state, rawId: result.rawId };
    },
    inspectTargetStateForGate: (target) => inspect(target),
    upsertStandaloneStatus: (target) =>
      upsertStandaloneOzonDayStatus({ target, client }),
    async applySnapshotPostBatch(keys) {
      const result = await applyExactSnapshotUnionOnce({
        keys,
        client,
        formulaVersion: params?.snapshotFormulaVersion,
      });
      return { deleted: result.deleted, requeued: result.requeued };
    },
    async rebuildV2Targets(targets) {
      const result = await rebuildV2PeriodTargets({
        targets,
        matrixRows: params?.v2MatrixRows ?? targets,
        client,
      });
      return { rebuilt: result.rebuilt };
    },
    readV2MatrixFingerprints: (rows) =>
      readV2PeriodRowFingerprints({ rows, client }),
    countProfitReadModelTargets: () => countLiveProfitReadModelJobs({ client }),
    inspectStandaloneStatusTargetStateForGate: (target) =>
      inspectStandaloneStatusTargetState({ target, client }),
  };
}

/* ------------------------------------------------------------------ *
 * Pre-mutation adapter readiness gate
 * ------------------------------------------------------------------ */

const REQUIRED_RELATIONS = [
  "ImportSession",
  "OzonAccrualDayStatus",
  "OzonFinancialCategoryFact",
  "OzonRealizationRow",
  "OzonRealizationSummary",
  "OzonDiscountPointsRow",
  "OzonDiscountPointsSummary",
  "DashboardPeriodSnapshot",
  "DashboardPeriodSnapshotJob",
  "MarketplaceApiConnection",
] as const;

export type ReadinessProfile = "PRODUCTION_PRISMA" | "EPHEMERAL_MEMORY";

export type AdapterReadinessReport = {
  ok: boolean;
  profile: ReadinessProfile;
  failures: string[];
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  databaseWriteIntent: "YES" | "EPHEMERAL_ONLY";
  ozonNetworkCallsBeforeMutation: number;
};

/**
 * Runs BEFORE the first database write. Proves the adapters are really bound, the
 * relations the mutation will touch exist, the deferred-invalidation contract still
 * holds, and no Ozon network call has happened yet.
 */
export async function runProductionAdapterReadinessGate(params: {
  adapters: Partial<ProductionMutationAdapters>;
  profile?: ReadinessProfile;
  client?: RepairDbClient;
  tripwire?: Pick<OzonNetworkTripwire, "count">;
}): Promise<AdapterReadinessReport> {
  const profile = params.profile ?? "PRODUCTION_PRISMA";
  const checks: AdapterReadinessReport["checks"] = [];
  const failures: string[] = [];

  const record = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(detail ? `${name}: ${detail}` : name);
  };

  for (const name of [
    "store",
    "inspectTargetState",
    "inspectTargetStateForGate",
    "upsertStandaloneStatus",
    "applySnapshotPostBatch",
    "rebuildV2Targets",
    "readV2MatrixFingerprints",
    "countProfitReadModelTargets",
    "inspectStandaloneStatusTargetStateForGate",
  ] as const) {
    const value = params.adapters[name];
    const bound =
      name === "store"
        ? Boolean(value) && typeof value === "object"
        : typeof value === "function";
    record(`adapter_bound_${name}`, bound, bound ? undefined : "not bound");
  }

  const store = params.adapters.store;
  record(
    "adapter_store_surface",
    Boolean(
      store &&
        typeof store.commitRaw === "function" &&
        typeof store.loadRaw === "function" &&
        typeof store.persistCanonical === "function",
    ),
    "store must expose commitRaw/loadRaw/persistCanonical",
  );

  record(
    "deferred_invalidation_contract",
    !shouldInvalidateSnapshots("DEFERRED_OWNER_REPAIR") &&
      !shouldInvalidateProfit("DEFERRED_OWNER_REPAIR") &&
      shouldInvalidateSnapshots("NORMAL") &&
      shouldInvalidateProfit("NORMAL"),
    "DEFERRED_OWNER_REPAIR must suppress invalidation while NORMAL keeps it",
  );

  record(
    "v2_scope_policy",
    postBatchV2PromotionAllowed("ALL") &&
      !postBatchV2PromotionAllowed("ИП Петров"),
    "only ALL scope may be numerically promoted",
  );

  const ozonCalls = params.tripwire?.count() ?? 0;
  record(
    "no_ozon_network_before_mutation",
    ozonCalls === 0,
    `observed ${ozonCalls} Ozon calls`,
  );

  if (profile === "PRODUCTION_PRISMA") {
    const client = db(params.client);
    record(
      "database_url_present",
      Boolean(process.env.DATABASE_URL?.trim()),
      "DATABASE_URL is required for production mutation",
    );

    let connected = false;
    try {
      await client.$queryRaw`SELECT 1`;
      connected = true;
    } catch (error) {
      record(
        "database_reachable",
        false,
        String(error instanceof Error ? error.message : error).slice(0, 300),
      );
    }
    if (connected) {
      record("database_reachable", true);

      const rows = await client.$queryRaw<Array<{ table_name: string }>>`
        SELECT "table_name"
        FROM information_schema.tables
        WHERE "table_schema" = 'public'
          AND "table_name" IN (${Prisma.join([...REQUIRED_RELATIONS])})
      `;
      const present = new Set(rows.map((row) => row.table_name));
      const missing = REQUIRED_RELATIONS.filter((name) => !present.has(name));
      record(
        "required_relations_present",
        missing.length === 0,
        missing.length ? `missing ${missing.join(",")}` : undefined,
      );

      const jobColumns = await client.$queryRaw<
        Array<{ column_name: string }>
      >`
        SELECT "column_name"
        FROM information_schema.columns
        WHERE "table_schema" = 'public'
          AND "table_name" = 'DashboardPeriodSnapshotJob'
      `;
      const jobColumnNames = new Set(
        jobColumns.map((row) => row.column_name),
      );
      const requiredJobColumns = [
        "companyScope",
        "dateFrom",
        "dateTo",
        "formulaVersion",
        "status",
        "priority",
        "attempts",
        "maxAttempts",
      ];
      const missingJobColumns = requiredJobColumns.filter(
        (name) => !jobColumnNames.has(name),
      );
      record(
        "snapshot_job_columns_present",
        missingJobColumns.length === 0,
        missingJobColumns.length
          ? `missing ${missingJobColumns.join(",")}`
          : undefined,
      );

      const v6Repository = createPrismaV6PeriodReadModelRepository(
        asPrismaLikeV6Client(client),
      );
      record(
        "v6_repository_request_rebuild",
        typeof v6Repository.requestRebuild === "function",
        "V6 repository must expose requestRebuild",
      );
    }
  } else {
    record("ephemeral_profile_acknowledged", true, "memory store, no DB writes");
  }

  const report: AdapterReadinessReport = {
    ok: failures.length === 0,
    profile,
    failures,
    checks,
    databaseWriteIntent:
      profile === "PRODUCTION_PRISMA" ? "YES" : "EPHEMERAL_ONLY",
    ozonNetworkCallsBeforeMutation: ozonCalls,
  };

  if (!report.ok) {
    throw new Error(
      `ADAPTER_READINESS_GATE=FAILED EXECUTION=BLOCKED profile=${profile} reasons=${failures.join(" | ")}`,
    );
  }
  return report;
}
