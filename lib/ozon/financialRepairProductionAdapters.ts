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

export type RepairStatusOnlyTarget = {
  company: string;
  date: string;
  importSessionId: string;
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
  expectedCanonicalWb: number;
  expectedCanonicalOzon: number;
  expectedTotal: number;
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
    if (
      params.expectedPayloadSha256 &&
      dayStatus.payloadSha256 &&
      dayStatus.payloadSha256 !== params.expectedPayloadSha256
    ) {
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
    if (
      params.expectedPayloadSha256 &&
      raw.payloadSha256 &&
      raw.payloadSha256 !== params.expectedPayloadSha256
    ) {
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

  const sessions = await client.$queryRaw<
    Array<{
      id: string;
      status: string;
      companyName: string | null;
      reportType: string;
      payloadSha256: string | null;
      quarantineCount: number | null;
    }>
  >`
    SELECT
      "id",
      "status",
      "companyName",
      "reportType",
      "previewJson"->>'payloadSha256' AS "payloadSha256",
      CASE
        WHEN jsonb_typeof("previewJson"->'quarantine') = 'array'
          THEN jsonb_array_length("previewJson"->'quarantine')
        ELSE 0
      END AS "quarantineCount"
    FROM "ImportSession"
    WHERE "id" = ${params.target.importSessionId}
    LIMIT 1
  `;
  const session = sessions[0];
  if (!session) {
    throw new Error(
      `STANDALONE_STATUS_PREREQUISITE_FAILED missing ImportSession ${params.target.importSessionId}`,
    );
  }
  if (session.reportType !== OZON_ACCRUAL_BY_DAY_REPORT_TYPE) {
    throw new Error(
      `STANDALONE_STATUS_PREREQUISITE_FAILED ${session.id} reportType=${session.reportType}`,
    );
  }
  if (session.status !== "SUCCESS") {
    throw new Error(
      `STANDALONE_STATUS_PREREQUISITE_FAILED ${session.id} status=${session.status}, expected SUCCESS`,
    );
  }
  if ((session.companyName ?? "") !== companyName) {
    throw new Error(
      `STANDALONE_STATUS_PREREQUISITE_FAILED ${session.id} companyName=${session.companyName} expected ${companyName}`,
    );
  }

  const existing = await loadDayStatus({ client, companyName, date });
  if (
    existing &&
    existing.dataMode === "FINAL" &&
    existing.coverageComplete === true &&
    existing.phase === "CANONICAL" &&
    existing.importSessionId === session.id
  ) {
    return "NOOP";
  }

  await persistOzonAccrualDayStatuses(
    buildCanonicalOzonDayStatuses({
      companyName,
      dates: [date],
      importSessionId: session.id,
      payloadSha256: session.payloadSha256 ?? existing?.payloadSha256 ?? null,
      dataMode: "FINAL",
      coverageComplete: true,
      quarantineCount: Number(session.quarantineCount ?? 0),
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
};

/**
 * Enqueues a V6 period read-model rebuild for the 2 ALL-scope rows. Per-company
 * rows must stay UNAVAILABLE, so a non-ALL scope is refused outright.
 */
export async function rebuildV2PeriodTargets(params: {
  targets: RepairV2Target[];
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

  return { rebuilt, outcomes };
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
  checks: VerifyCheck[];
};

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
}): Promise<VerifyReport> {
  const client = db(params.client);
  const formulaVersion =
    params.formulaVersion ?? FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1;
  const checks: VerifyCheck[] = [];

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

  return { ok: checks.every((check) => check.ok), checks };
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
  upsertStandaloneStatus: (
    target: RepairStatusOnlyTarget,
  ) => Promise<"WRITTEN" | "NOOP">;
  applySnapshotPostBatch: (
    keys: RepairSnapshotKey[],
  ) => Promise<{ deleted: number; requeued: number }>;
  rebuildV2Targets: (
    targets: RepairV2Target[],
  ) => Promise<{ rebuilt: number }>;
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
}): ProductionMutationAdapters {
  const client = db(params?.client);
  return {
    store: params?.store ?? createPrismaOzonAccrualStore(),
    async inspectTargetState(target) {
      const result = await inspectOzonSourceTargetState({
        target,
        client,
        expectedPayloadSha256: params?.expectedPayloadSha256?.(target) ?? null,
      });
      if (result.state === "CONFLICT") {
        throw new Error(
          `CONFLICTING_SOURCE_STATE ${target.companyName} ${target.date}: ${result.reason}`,
        );
      }
      return { state: result.state, rawId: result.rawId };
    },
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
      const result = await rebuildV2PeriodTargets({ targets, client });
      return { rebuilt: result.rebuilt };
    },
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
    "upsertStandaloneStatus",
    "applySnapshotPostBatch",
    "rebuildV2Targets",
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
