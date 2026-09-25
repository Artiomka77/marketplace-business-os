/**
 * Owner-gated executable Ozon historical financial repair runner.
 *
 * Modes:
 * - DRY_RUN: validate bindings / plan only (no DB writes, no network mutate)
 * - PREPARE: READ-ONLY fetch+hash+mapper; write sealed cache; no DB writes
 * - EXECUTE_FROM_CACHE: mutate from cache with DEFERRED_OWNER_REPAIR; no Ozon network
 * - VERIFY: post-state checks read back from the database
 *
 * EXECUTE_* refuses self-accepting defaults. Source hash drift => STOP.
 * Production mutation is intended for a future host wrapper; this module IS the mutation code.
 * Mutation phases are bound to real Prisma adapters in
 * lib/ozon/financialRepairProductionAdapters.ts and are gated by a pre-mutation
 * readiness check that runs before the first database write.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  mapOzonAccrualByDay,
  type OzonAccrualApiDayEnvelope,
} from "@/lib/ozon/accrualByDay";
import {
  createMemoryOzonAccrualStore,
  ingestOzonAccrualByDay,
  replayOzonAccrualCanonicalFromRaw,
  type OzonAccrualRuntimeStore,
  type OzonAccrualRawRecord,
} from "@/lib/ozon/syncOzonAccrualByDay";
import { shouldInvalidateProfit, shouldInvalidateSnapshots } from "@/lib/ozon/historicalRepairInvalidationPolicy";
import {
  computeOzonAccrualPayloadSha256,
  createMarketplaceApiConnectionCredentialLoader,
  createProductionMutationAdapters,
  fetchOzonRepairTargetLive,
  installOzonNetworkTripwire,
  runProductionAdapterReadinessGate,
  verifyOzonHistoricalRepair,
  type OzonCredentialLoader,
  type OzonRepairFetchRange,
  type ProductionMutationAdapters,
} from "@/lib/ozon/financialRepairProductionAdapters";

/**
 * Re-exported so a host wrapper (or a post-mortem replay) can apply the snapshot
 * union without importing the whole runner CLI.
 */
export {
  applyExactSnapshotUnionOnce,
  installOzonNetworkTripwire,
  runProductionAdapterReadinessGate,
  verifyOzonHistoricalRepair,
  createProductionMutationAdapters,
} from "@/lib/ozon/financialRepairProductionAdapters";

export type RunnerMode = "DRY_RUN" | "PREPARE" | "EXECUTE_FROM_CACHE" | "VERIFY";

export const OWNER_EXECUTE_MARKER = "OWNER_EXECUTE_OZON_HISTORICAL_FINANCIAL_REPAIR_V1";

export type ExecuteBinding = {
  operationId: string;
  approvalBindingSha256: string;
  sourceBackfillManifestSha256: string;
  statusOnlyManifestSha256: string;
  snapshotTargetManifestSha256: string;
  v2TargetManifestSha256: string;
  expectedPreDeployAppImageSha256: string;
  expectedCandidateAppImageSha256: string;
  expectedRepairRunnerImageSha256: string;
  sourceBackfillTargetCount: number;
  statusStandaloneTargetCount: number;
  snapshotPostBatchDeleteCount: number;
  snapshotPostBatchRequeueCount: number;
  v2NumericMutationTargetCount: number;
  executeMarker: string;
  prepareCacheManifestSha256: string;
  mutationTimeAppImageSha256: string;
};

export type SourceTarget = {
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

export type StatusOnlyTarget = {
  company: string;
  date: string;
  importSessionId: string;
};

export type SnapshotKey = {
  companyScope: string;
  dateFrom: string;
  dateTo: string;
  formulaVersion: string;
};

export type V2Target = {
  dbId: string;
  period: string;
  scope: string;
  dateFrom: string;
  dateTo: string;
  expectedCanonicalWb: number;
  expectedCanonicalOzon: number;
  expectedTotal: number;
};

export function sha256(buf: string | Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

export function sha256Json(value: unknown): string {
  return sha256(JSON.stringify(value));
}

export function requireExplicit(name: string, value: string | undefined | null): string {
  if (value == null || String(value).trim() === "" || String(value) === "UNSET") {
    throw new Error(`EXECUTE requires explicit ${name}`);
  }
  return String(value);
}

export function requireExplicitNumber(name: string, value: unknown): number {
  if (value === undefined || value === null || value === "" || Number.isNaN(Number(value))) {
    throw new Error(`EXECUTE requires explicit ${name}`);
  }
  return Number(value);
}

export function parseMode(raw?: string): RunnerMode {
  const m = String(raw || "DRY_RUN").toUpperCase();
  if (m === "DRY_RUN" || m === "PREPARE" || m === "EXECUTE_FROM_CACHE" || m === "VERIFY") return m;
  throw new Error(`Unknown mode ${raw}`);
}

export function assertSourceTargetExactMatch(params: {
  sealed: SourceTarget;
  observed: {
    rawResponseHash: string;
    pageHashes: string[];
    rowCount: number;
    fullMapperResultHash: string;
    accountAuthorityId?: string | null;
  };
}): void {
  const failures: string[] = [];
  if (params.observed.rawResponseHash !== params.sealed.rawResponseHash) {
    failures.push("rawResponseHash");
  }
  const a = [...(params.sealed.pageHashes || [])].sort().join(",");
  const b = [...(params.observed.pageHashes || [])].sort().join(",");
  if (a !== b) failures.push("pageHashes");
  if (params.observed.rowCount !== params.sealed.rowCount) failures.push("rowCount");
  if (params.observed.fullMapperResultHash !== params.sealed.fullMapperResultHash) {
    failures.push("fullMapperResultHash");
  }
  const sealedAuth = params.sealed.ACCOUNT_AUTHORITY_ID || params.sealed.marketplaceApiConnectionId;
  if (sealedAuth && params.observed.accountAuthorityId && sealedAuth !== params.observed.accountAuthorityId) {
    failures.push("accountAuthorityId");
  }
  if (failures.length) {
    throw new Error(
      `SOURCE_DRIFT=YES EXECUTION=BLOCKED NEW_FINANCIAL_RECERTIFICATION_REQUIRED fields=${failures.join(",")}`
    );
  }
}

export function validateExecuteBinding(binding: ExecuteBinding, files: {
  sourceBackfillPath: string;
  statusOnlyPath: string;
  snapshotPath: string;
  v2Path: string;
  prepareCacheManifestPath: string;
}): void {
  requireExplicit("operationId", binding.operationId);
  requireExplicit("approvalBindingSha256", binding.approvalBindingSha256);
  requireExplicit("sourceBackfillManifestSha256", binding.sourceBackfillManifestSha256);
  requireExplicit("statusOnlyManifestSha256", binding.statusOnlyManifestSha256);
  requireExplicit("snapshotTargetManifestSha256", binding.snapshotTargetManifestSha256);
  requireExplicit("v2TargetManifestSha256", binding.v2TargetManifestSha256);
  requireExplicit("expectedPreDeployAppImageSha256", binding.expectedPreDeployAppImageSha256);
  requireExplicit("expectedCandidateAppImageSha256", binding.expectedCandidateAppImageSha256);
  requireExplicit("expectedRepairRunnerImageSha256", binding.expectedRepairRunnerImageSha256);
  requireExplicit("prepareCacheManifestSha256", binding.prepareCacheManifestSha256);
  requireExplicit("mutationTimeAppImageSha256", binding.mutationTimeAppImageSha256);
  requireExplicit("executeMarker", binding.executeMarker);
  if (binding.executeMarker !== OWNER_EXECUTE_MARKER) {
    throw new Error("executeMarker mismatch");
  }
  if (binding.sourceBackfillTargetCount !== 78) throw new Error("sourceBackfillTargetCount must be 78");
  if (binding.statusStandaloneTargetCount !== 10) throw new Error("statusStandaloneTargetCount must be 10");
  if (binding.v2NumericMutationTargetCount !== 2) throw new Error("v2NumericMutationTargetCount must be 2");

  if (sha256File(files.sourceBackfillPath) !== binding.sourceBackfillManifestSha256) {
    throw new Error("sourceBackfillManifestSha256 file mismatch");
  }
  if (sha256File(files.statusOnlyPath) !== binding.statusOnlyManifestSha256) {
    throw new Error("statusOnlyManifestSha256 file mismatch");
  }
  if (sha256File(files.snapshotPath) !== binding.snapshotTargetManifestSha256) {
    throw new Error("snapshotTargetManifestSha256 file mismatch");
  }
  if (sha256File(files.v2Path) !== binding.v2TargetManifestSha256) {
    throw new Error("v2TargetManifestSha256 file mismatch");
  }
  if (sha256File(files.prepareCacheManifestPath) !== binding.prepareCacheManifestSha256) {
    throw new Error("prepareCacheManifestSha256 file mismatch");
  }
  if (binding.mutationTimeAppImageSha256 !== binding.expectedCandidateAppImageSha256) {
    throw new Error(
      "MUTATION_TIME_REQUIRED_APP_IMAGE mismatch: runner refuses mutation unless candidate APP is running"
    );
  }
}

export type PrepareCacheTarget = {
  sealed: SourceTarget;
  raw: {
    accruals: unknown[];
    requestedDates: string[];
    dayEnvelopes: OzonAccrualApiDayEnvelope[];
    pagesByDay: Record<string, number>;
  };
  observed: {
    rawResponseHash: string;
    pageHashes: string[];
    rowCount: number;
    fullMapperResultHash: string;
    mapperComplete: boolean;
    expectedStatus: string;
  };
};

export type PrepareCache = {
  version: "AVOROFIN_OZON_HISTORICAL_REPAIR_PREPARE_CACHE_V1";
  createdAt: string;
  sourceBackfillManifestSha256: string;
  statusOnlyManifestSha256: string;
  snapshotTargetManifestSha256: string;
  v2TargetManifestSha256: string;
  targets: PrepareCacheTarget[];
  statusOnly: StatusOnlyTarget[];
  snapshotKeys: SnapshotKey[];
  v2Targets: V2Target[];
  noCredentials: true;
};

export function buildPrepareCacheManifestSha(cache: PrepareCache): string {
  return sha256Json(cache);
}

/**
 * The binding pins the bytes of the prepare-cache manifest artifact; that artifact
 * in turn declares the cache *content* sha. Resolving the content sha from the
 * artifact keeps the chain non-self-accepting while staying satisfiable: the
 * manifest file's own sha256 cannot also equal the sha256 of the cache it
 * describes. Accepts either PREPARE_CACHE.sha256.txt (bare hex) or
 * PREPARE_CACHE_MANIFEST.json (prepareCacheManifestSha256 field).
 */
export function resolveSealedPrepareCacheContentSha(manifestPath: string): string {
  const text = readFileSync(manifestPath, "utf8");
  const trimmed = text.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  let declared = "";
  try {
    const parsed = JSON.parse(text) as { prepareCacheManifestSha256?: unknown };
    declared = String(parsed?.prepareCacheManifestSha256 ?? "");
  } catch {
    declared = "";
  }
  if (/^[0-9a-f]{64}$/i.test(declared)) return declared.toLowerCase();
  throw new Error(
    `prepare cache manifest ${manifestPath} declares no cache content sha256`
  );
}

export type MutationAdapters = {
  store: OzonAccrualRuntimeStore;
  /** Optional: upsert standalone day status */
  upsertStandaloneStatus?: (t: StatusOnlyTarget) => Promise<"WRITTEN" | "NOOP">;
  /** Optional: snapshot post-batch once */
  applySnapshotPostBatch?: (keys: SnapshotKey[]) => Promise<{ deleted: number; requeued: number }>;
  /** Optional: V2 rebuild enqueue for ALL rows only */
  rebuildV2Targets?: (targets: V2Target[]) => Promise<{ rebuilt: number }>;
  /** Inspect existing source state for idempotency */
  inspectTargetState?: (t: SourceTarget) => Promise<{
    state: "MISSING" | "NOOP_COMPLETE" | "RAW_PERSISTED_RESUME" | "CONFLICT";
    rawId?: string;
  }>;
  loadCachedFetch?: (t: SourceTarget, cache: PrepareCache) => PrepareCacheTarget;
};

export async function executeSourceTargetsFromCache(params: {
  cache: PrepareCache;
  adapters: MutationAdapters;
  checkpointPath?: string;
}): Promise<{
  persisted: number;
  noopComplete: number;
  resumed: number;
  intrinsicStatuses: number;
  separateStatusUpserts: number;
}> {
  let persisted = 0;
  let noopComplete = 0;
  let resumed = 0;
  const checkpoint: Array<{ date: string; company: string; result: string }> = [];

  for (const sealed of params.cache.targets.map((t) => t.sealed)) {
    const cached = params.adapters.loadCachedFetch
      ? params.adapters.loadCachedFetch(sealed, params.cache)
      : params.cache.targets.find((t) => t.sealed.date === sealed.date && t.sealed.companyName === sealed.companyName);
    if (!cached) throw new Error(`cache miss ${sealed.companyName} ${sealed.date}`);

    // Re-verify sealed hashes against cache observed (TOCTOU eliminated vs network)
    assertSourceTargetExactMatch({
      sealed,
      observed: {
        ...cached.observed,
        accountAuthorityId: sealed.ACCOUNT_AUTHORITY_ID || sealed.marketplaceApiConnectionId,
      },
    });
    if (!cached.observed.mapperComplete || cached.observed.expectedStatus !== "FINAL") {
      throw new Error(`cache mapper not FINAL for ${sealed.companyName} ${sealed.date}`);
    }

    const inspect = params.adapters.inspectTargetState
      ? await params.adapters.inspectTargetState(sealed)
      : { state: "MISSING" as const };

    if (inspect.state === "NOOP_COMPLETE") {
      noopComplete += 1;
      checkpoint.push({ company: sealed.companyName, date: sealed.date, result: "NOOP_COMPLETE" });
      continue;
    }
    if (inspect.state === "CONFLICT") {
      throw new Error(`CONFLICTING_SOURCE_STATE ${sealed.companyName} ${sealed.date}`);
    }

    if (inspect.state === "RAW_PERSISTED_RESUME" && inspect.rawId) {
      await replayOzonAccrualCanonicalFromRaw({
        rawId: inspect.rawId,
        companyId: sealed.companyId,
        companyName: sealed.companyName,
        dateFrom: new Date(`${sealed.date}T00:00:00.000Z`),
        dateTo: new Date(`${sealed.date}T00:00:00.000Z`),
        store: params.adapters.store,
        invalidationMode: "DEFERRED_OWNER_REPAIR",
      });
      resumed += 1;
      checkpoint.push({ company: sealed.companyName, date: sealed.date, result: "RESUMED_CANONICAL" });
      continue;
    }

    // Fresh persist from exact cached payload (no network)
    await ingestOzonAccrualByDay({
      companyId: sealed.companyId,
      companyName: sealed.companyName,
      dateFrom: new Date(`${sealed.date}T00:00:00.000Z`),
      dateTo: new Date(`${sealed.date}T00:00:00.000Z`),
      store: params.adapters.store,
      invalidationMode: "DEFERRED_OWNER_REPAIR",
      fetchRange: async () => ({
        accruals: cached.raw.accruals,
        requestedDates: cached.raw.requestedDates,
        dayEnvelopes: cached.raw.dayEnvelopes,
        pagesByDay: cached.raw.pagesByDay,
      }),
    });
    persisted += 1;
    checkpoint.push({ company: sealed.companyName, date: sealed.date, result: "PERSISTED_DEFERRED" });
  }

  if (params.checkpointPath) {
    mkdirSync(dirname(params.checkpointPath), { recursive: true });
    writeFileSync(params.checkpointPath, JSON.stringify({ checkpoint }, null, 2) + "\n");
  }

  return {
    persisted,
    noopComplete,
    resumed,
    intrinsicStatuses: persisted + resumed + noopComplete,
    separateStatusUpserts: 0,
  };
}

export async function executeStandaloneStatuses(params: {
  targets: StatusOnlyTarget[];
  upsert: (t: StatusOnlyTarget) => Promise<"WRITTEN" | "NOOP">;
}): Promise<{ written: number; noop: number }> {
  if (params.targets.length !== 10) throw new Error("standalone status targets must be exactly 10");
  let written = 0;
  let noop = 0;
  for (const t of params.targets) {
    const r = await params.upsert(t);
    if (r === "WRITTEN") written += 1;
    else noop += 1;
  }
  return { written, noop };
}

export async function executePostBatch(params: {
  snapshotKeys: SnapshotKey[];
  expectedDeleteCount: number;
  expectedRequeueCount: number;
  v2Targets: V2Target[];
  applySnapshotPostBatch: (keys: SnapshotKey[]) => Promise<{ deleted: number; requeued: number }>;
  rebuildV2Targets: (targets: V2Target[]) => Promise<{ rebuilt: number }>;
}): Promise<{ snapshotDeleted: number; snapshotRequeued: number; v2Rebuilt: number }> {
  const unique = new Map<string, SnapshotKey>();
  for (const k of params.snapshotKeys) {
    unique.set(`${k.companyScope}|${k.dateFrom}|${k.dateTo}|${k.formulaVersion}`, k);
  }
  if (unique.size !== params.expectedDeleteCount || unique.size !== params.expectedRequeueCount) {
    throw new Error(
      `snapshot post-batch unique count mismatch unique=${unique.size} delete=${params.expectedDeleteCount} requeue=${params.expectedRequeueCount}`
    );
  }
  if (params.v2Targets.length !== 2 || params.v2Targets.some((t) => t.scope !== "ALL")) {
    throw new Error("V2 post-batch must be exactly 2 ALL targets");
  }
  const snap = await params.applySnapshotPostBatch([...unique.values()]);
  if (snap.deleted !== params.expectedDeleteCount || snap.requeued !== params.expectedRequeueCount) {
    throw new Error(`snapshot apply counts mismatch ${JSON.stringify(snap)}`);
  }
  const v2 = await params.rebuildV2Targets(params.v2Targets);
  if (v2.rebuilt !== 2) throw new Error(`v2 rebuilt must be 2 got ${v2.rebuilt}`);
  return { snapshotDeleted: snap.deleted, snapshotRequeued: snap.requeued, v2Rebuilt: v2.rebuilt };
}

export function regressionNormalInvalidationStillDefault(): boolean {
  return shouldInvalidateSnapshots("NORMAL") && shouldInvalidateProfit("NORMAL");
}

export function repairOnlyRequiresDeferred(): boolean {
  return !shouldInvalidateSnapshots("DEFERRED_OWNER_REPAIR") && !shouldInvalidateProfit("DEFERRED_OWNER_REPAIR");
}

/**
 * Build a prepare-cache entry from an already-fetched payload (tests / PREPARE).
 *
 * `mapperResultHash` lets the live PREPARE path substitute the certification hash
 * recipe that sealed the source-backfill manifest; without it the local recipe
 * (facts + totals + diagnostics) is used, which is what the ephemeral tests seal.
 */
export function sealPreparedTarget(params: {
  sealed: SourceTarget;
  accruals: unknown[];
  requestedDates: string[];
  dayEnvelopes: OzonAccrualApiDayEnvelope[];
  pagesByDay: Record<string, number>;
  rawResponseHash: string;
  pageHashes: string[];
  mapperResultHash?: string;
}): PrepareCacheTarget {
  const mapped = mapOzonAccrualByDay({
    accruals: params.accruals,
    requestedDates: params.requestedDates,
    dayEnvelopes: params.dayEnvelopes,
  } as Parameters<typeof mapOzonAccrualByDay>[0]);
  const fullMapperResultHash =
    params.mapperResultHash ??
    sha256Json({
      facts: mapped.facts,
      totals: mapped.totals,
      diagnostics: mapped.diagnostics,
      mapperComplete: mapped.mapperComplete,
    });
  const observed = {
    rawResponseHash: params.rawResponseHash,
    pageHashes: params.pageHashes,
    rowCount: params.accruals.length,
    fullMapperResultHash,
    mapperComplete: mapped.mapperComplete === true,
    expectedStatus: mapped.mapperComplete ? "FINAL" : "BLOCKED",
  };
  assertSourceTargetExactMatch({
    sealed: params.sealed,
    observed: {
      rawResponseHash: observed.rawResponseHash,
      pageHashes: observed.pageHashes,
      rowCount: observed.rowCount,
      fullMapperResultHash:
        params.sealed.fullMapperResultHash === "TEST"
          ? params.sealed.fullMapperResultHash
          : fullMapperResultHash,
      accountAuthorityId: params.sealed.ACCOUNT_AUTHORITY_ID || params.sealed.marketplaceApiConnectionId,
    },
  });
  if (
    params.sealed.fullMapperResultHash &&
    params.sealed.fullMapperResultHash !== "TEST" &&
    fullMapperResultHash !== params.sealed.fullMapperResultHash
  ) {
    throw new Error(
      `SOURCE_DRIFT=YES mapperResultHash sealed=${params.sealed.fullMapperResultHash} observed=${fullMapperResultHash}`
    );
  }
  return {
    sealed: {
      ...params.sealed,
      fullMapperResultHash:
        params.sealed.fullMapperResultHash === "TEST"
          ? fullMapperResultHash
          : params.sealed.fullMapperResultHash,
    },
    raw: {
      accruals: params.accruals,
      requestedDates: params.requestedDates,
      dayEnvelopes: params.dayEnvelopes,
      pagesByDay: params.pagesByDay,
    },
    observed: {
      ...observed,
      fullMapperResultHash:
        params.sealed.fullMapperResultHash === "TEST"
          ? fullMapperResultHash
          : params.sealed.fullMapperResultHash,
      mapperComplete: mapped.mapperComplete === true,
    },
  };
}

/** Payload hash the ingest store will derive for a sealed cache entry. */
export function prepareCacheTargetPayloadSha256(target: PrepareCacheTarget): string {
  return computeOzonAccrualPayloadSha256({
    companyName: target.sealed.companyName,
    dateFrom: target.sealed.date,
    dateTo: target.sealed.date,
    dayEnvelopes: target.raw.dayEnvelopes,
    rawAccruals: target.raw.accruals,
  });
}

/** Memory-only adapter set for the ephemeral contract tests. Never a production path. */
export function createEphemeralMutationAdapters(): ProductionMutationAdapters {
  return {
    store: createMemoryOzonAccrualStore(),
    inspectTargetState: async () => ({ state: "MISSING" }),
    upsertStandaloneStatus: async () => "WRITTEN",
    applySnapshotPostBatch: async (keys) => ({
      deleted: keys.length,
      requeued: keys.length,
    }),
    rebuildV2Targets: async (targets) => ({ rebuilt: targets.length }),
  };
}

export type PrepareLiveInputs = {
  sourceTargets: SourceTarget[];
  statusOnly: StatusOnlyTarget[];
  snapshotKeys: SnapshotKey[];
  v2Targets: V2Target[];
  manifestShas: {
    sourceBackfillManifestSha256: string;
    statusOnlyManifestSha256: string;
    snapshotTargetManifestSha256: string;
    v2TargetManifestSha256: string;
  };
  getCredentials: OzonCredentialLoader;
  fetchRange?: OzonRepairFetchRange;
  onProgress?: (info: {
    index: number;
    total: number;
    company: string;
    date: string;
    apiCalls: number;
  }) => void;
};

/**
 * READ-ONLY live PREPARE: fetches every sealed source target from Ozon, recomputes
 * the certification hashes, stops on any drift, and assembles the sealed cache.
 * No database write happens here — the cache is the only output.
 */
export async function preparePrepareCacheLive(
  params: PrepareLiveInputs
): Promise<{ cache: PrepareCache; ozonApiCalls: number }> {
  const targets: PrepareCacheTarget[] = [];
  let ozonApiCalls = 0;

  for (const [offset, sealed] of params.sourceTargets.entries()) {
    const live = await fetchOzonRepairTargetLive({
      target: sealed,
      getCredentials: params.getCredentials,
      fetchRange: params.fetchRange,
    });
    ozonApiCalls += live.apiCallCount;
    if (!live.mapperComplete || live.ingestStatus !== "FINAL") {
      throw new Error(
        `PREPARE live mapper not FINAL for ${sealed.companyName} ${sealed.date} status=${live.ingestStatus}`
      );
    }
    targets.push(
      sealPreparedTarget({
        sealed,
        accruals: live.accruals,
        requestedDates: live.requestedDates,
        dayEnvelopes: live.dayEnvelopes,
        pagesByDay: live.pagesByDay,
        rawResponseHash: live.rawResponseHash,
        pageHashes: live.pageHashes,
        mapperResultHash: live.mapperResultHash,
      })
    );
    params.onProgress?.({
      index: offset + 1,
      total: params.sourceTargets.length,
      company: sealed.companyName,
      date: sealed.date,
      apiCalls: live.apiCallCount,
    });
  }

  return {
    cache: {
      version: "AVOROFIN_OZON_HISTORICAL_REPAIR_PREPARE_CACHE_V1",
      createdAt: new Date().toISOString(),
      ...params.manifestShas,
      targets,
      statusOnly: params.statusOnly,
      snapshotKeys: params.snapshotKeys,
      v2Targets: params.v2Targets,
      noCredentials: true,
    },
    ozonApiCalls,
  };
}

function readManifestTargets<T>(path: string, key: "targets" | "keys"): T[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const rows = parsed[key];
  if (!Array.isArray(rows)) {
    throw new Error(`manifest ${path} has no "${key}" array`);
  }
  return rows as T[];
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const args = Object.fromEntries(
    argv.filter((a) => a.includes("=")).map((a) => {
      const i = a.indexOf("=");
      return [a.slice(0, i).replace(/^--/, ""), a.slice(i + 1)];
    })
  ) as Record<string, string>;

  const mode = parseMode(args.mode);
  const outDir = resolve(args.outDir || ".");
  mkdirSync(outDir, { recursive: true });

  if (mode === "DRY_RUN") {
    const plan = {
      mode,
      CURRENT_TASK_DATABASE_WRITE: "NO",
      invalidationModeForSourcePersist: "DEFERRED_OWNER_REPAIR",
      SEPARATE_STATUS_UPSERT_FOR_SOURCE_BACKFILL: "NO",
      SOURCE_DRIFT_POLICY: "STOP_REQUIRE_RECERTIFICATION",
      phases: [
        "PREPARE",
        "QUIESCE_EXTERNAL",
        "ADAPTER_READINESS_GATE",
        "EXECUTE_FROM_CACHE",
        "POST_BATCH",
        "VERIFY",
      ],
      regressionNormalInvalidationStillDefault: regressionNormalInvalidationStillDefault(),
      repairOnlyRequiresDeferred: repairOnlyRequiresDeferred(),
      executableMutationCode: true,
      productionAdaptersModule: "lib/ozon/financialRepairProductionAdapters.ts",
      OZON_NETWORK_CALLS_ALLOWED_ON_EXECUTE: 0,
      note: "DRY_RUN only. EXECUTE_FROM_CACHE runs the pre-mutation readiness gate, then real Prisma adapters.",
    };
    writeFileSync(join(outDir, "OZON_HISTORICAL_REPAIR_RUNNER_PLAN.json"), JSON.stringify(plan, null, 2) + "\n");
    console.log(JSON.stringify({ mode, ok: true, executableMutationCode: true }, null, 2));
    return 0;
  }

  if (mode === "PREPARE") {
    // READ-ONLY phase. --prepareLive=1 fetches Ozon directly; --prepareCacheIn
    // re-seals a cache assembled by an external read-only fetcher.
    const sourcePath = requireExplicit("sourceManifest", args.sourceManifest);
    const statusPath = requireExplicit("statusManifest", args.statusManifest);
    const snapshotPath = requireExplicit("snapshotManifest", args.snapshotManifest);
    const v2Path = requireExplicit("v2Manifest", args.v2Manifest);
    const manifestShas = {
      sourceBackfillManifestSha256: sha256File(sourcePath),
      statusOnlyManifestSha256: sha256File(statusPath),
      snapshotTargetManifestSha256: sha256File(snapshotPath),
      v2TargetManifestSha256: sha256File(v2Path),
    };

    let cache: PrepareCache;
    let ozonApiCalls = 0;
    let prepareMode: "LIVE_OZON_FETCH" | "EXTERNAL_CACHE_IN";

    if (args.prepareLive === "1") {
      prepareMode = "LIVE_OZON_FETCH";
      const tripwire = installOzonNetworkTripwire({ mode: "COUNT" });
      try {
        const live = await preparePrepareCacheLive({
          sourceTargets: readManifestTargets<SourceTarget>(sourcePath, "targets"),
          statusOnly: readManifestTargets<StatusOnlyTarget>(statusPath, "targets"),
          snapshotKeys: readManifestTargets<SnapshotKey>(snapshotPath, "keys"),
          v2Targets: readManifestTargets<V2Target>(v2Path, "targets"),
          manifestShas,
          getCredentials: createMarketplaceApiConnectionCredentialLoader(),
          onProgress: (info) =>
            console.error(
              `PREPARE ${info.index}/${info.total} ${info.company} ${info.date} calls=${info.apiCalls}`
            ),
        });
        cache = live.cache;
        ozonApiCalls = Math.max(live.ozonApiCalls, tripwire.count());
      } finally {
        tripwire.restore();
      }
    } else if (args.prepareCacheIn) {
      prepareMode = "EXTERNAL_CACHE_IN";
      cache = JSON.parse(readFileSync(resolve(args.prepareCacheIn), "utf8")) as PrepareCache;
    } else {
      throw new Error(
        "PREPARE requires --prepareLive=1 (read-only Ozon fetch) or --prepareCacheIn=<assembled-cache.json>"
      );
    }

    const manifestSha = buildPrepareCacheManifestSha(cache);
    const cacheDir = resolve(args.prepareCacheOut || join(outDir, "prepare-cache"));
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "PREPARE_CACHE.json"), JSON.stringify(cache, null, 2) + "\n");
    writeFileSync(join(cacheDir, "PREPARE_CACHE.sha256.txt"), manifestSha + "\n");
    writeFileSync(
      join(cacheDir, "PREPARE_CACHE_MANIFEST.json"),
      JSON.stringify(
        {
          prepareCacheManifestSha256: manifestSha,
          ...manifestShas,
          prepareMode,
          ozonApiCalls,
          targetCount: cache.targets.length,
          CURRENT_TASK_DATABASE_WRITE: "NO",
        },
        null,
        2
      ) + "\n"
    );
    console.log(
      JSON.stringify(
        { mode, ok: true, prepareMode, ozonApiCalls, prepareCacheManifestSha256: manifestSha },
        null,
        2
      )
    );
    return 0;
  }

  if (mode === "EXECUTE_FROM_CACHE") {
    const binding: ExecuteBinding = {
      operationId: requireExplicit("operationId", args.operationId),
      approvalBindingSha256: requireExplicit("approvalBindingSha256", args.approvalBindingSha256),
      sourceBackfillManifestSha256: requireExplicit("sourceBackfillManifestSha256", args.sourceBackfillManifestSha256),
      statusOnlyManifestSha256: requireExplicit("statusOnlyManifestSha256", args.statusOnlyManifestSha256),
      snapshotTargetManifestSha256: requireExplicit("snapshotTargetManifestSha256", args.snapshotTargetManifestSha256),
      v2TargetManifestSha256: requireExplicit("v2TargetManifestSha256", args.v2TargetManifestSha256),
      expectedPreDeployAppImageSha256: requireExplicit(
        "expectedPreDeployAppImageSha256",
        args.expectedPreDeployAppImageSha256
      ),
      expectedCandidateAppImageSha256: requireExplicit(
        "expectedCandidateAppImageSha256",
        args.expectedCandidateAppImageSha256
      ),
      expectedRepairRunnerImageSha256: requireExplicit(
        "expectedRepairRunnerImageSha256",
        args.expectedRepairRunnerImageSha256
      ),
      sourceBackfillTargetCount: requireExplicitNumber("sourceBackfillTargetCount", args.sourceBackfillTargetCount),
      statusStandaloneTargetCount: requireExplicitNumber(
        "statusStandaloneTargetCount",
        args.statusStandaloneTargetCount
      ),
      snapshotPostBatchDeleteCount: requireExplicitNumber(
        "snapshotPostBatchDeleteCount",
        args.snapshotPostBatchDeleteCount
      ),
      snapshotPostBatchRequeueCount: requireExplicitNumber(
        "snapshotPostBatchRequeueCount",
        args.snapshotPostBatchRequeueCount
      ),
      v2NumericMutationTargetCount: requireExplicitNumber(
        "v2NumericMutationTargetCount",
        args.v2NumericMutationTargetCount
      ),
      executeMarker: requireExplicit("executeMarker", args.executeMarker),
      prepareCacheManifestSha256: requireExplicit("prepareCacheManifestSha256", args.prepareCacheManifestSha256),
      mutationTimeAppImageSha256: requireExplicit("mutationTimeAppImageSha256", args.mutationTimeAppImageSha256),
    };

    const sourcePath = requireExplicit("sourceManifest", args.sourceManifest);
    const statusPath = requireExplicit("statusManifest", args.statusManifest);
    const snapshotPath = requireExplicit("snapshotManifest", args.snapshotManifest);
    const v2Path = requireExplicit("v2Manifest", args.v2Manifest);
    const cachePath = requireExplicit("prepareCache", args.prepareCache);
    const cacheManifestPath = requireExplicit("prepareCacheManifest", args.prepareCacheManifest);

    validateExecuteBinding(binding, {
      sourceBackfillPath: sourcePath,
      statusOnlyPath: statusPath,
      snapshotPath,
      v2Path,
      prepareCacheManifestPath: cacheManifestPath,
    });

    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as PrepareCache;
    const sealedCacheContentSha = resolveSealedPrepareCacheContentSha(cacheManifestPath);
    if (buildPrepareCacheManifestSha(cache) !== sealedCacheContentSha) {
      throw new Error("prepare cache content sha mismatch vs sealed manifest");
    }
    if (cache.targets.length !== 78) throw new Error("cache targets must be 78");

    const ephemeral = process.env.EPHEMERAL_MEMORY_STORE === "1";
    const operationStartedAt = new Date().toISOString();

    // EXECUTE_FROM_CACHE is cache-only: any Ozon request from here on is a
    // contract violation, so the tripwire blocks as well as counts.
    const tripwire = installOzonNetworkTripwire({ mode: "BLOCK" });
    try {
      const payloadShaByDay = new Map<string, string>();
      for (const target of cache.targets) {
        payloadShaByDay.set(
          `${target.sealed.companyName}|${target.sealed.date}`,
          prepareCacheTargetPayloadSha256(target)
        );
      }

      const adapters: ProductionMutationAdapters = ephemeral
        ? createEphemeralMutationAdapters()
        : createProductionMutationAdapters({
            expectedPayloadSha256: (target) =>
              payloadShaByDay.get(`${target.companyName}|${target.date}`) ?? null,
          });

      // PRE-MUTATION GATE. Runs before the first database write: proves the
      // adapters are bound, the relations exist, the deferred-invalidation
      // contract holds, and no Ozon call has happened.
      const readiness = await runProductionAdapterReadinessGate({
        adapters,
        profile: ephemeral ? "EPHEMERAL_MEMORY" : "PRODUCTION_PRISMA",
        tripwire,
      });

      const sourceResult = await executeSourceTargetsFromCache({
        cache,
        adapters,
        checkpointPath: args.checkpointPath
          ? resolve(args.checkpointPath)
          : join(outDir, "EXECUTE_CHECKPOINT.json"),
      });

      const statusTargets = readManifestTargets<StatusOnlyTarget>(statusPath, "targets");
      const statusResult = await executeStandaloneStatuses({
        targets: statusTargets,
        upsert: adapters.upsertStandaloneStatus,
      });

      const snapKeys = readManifestTargets<SnapshotKey>(snapshotPath, "keys");
      const v2Targets = readManifestTargets<V2Target>(v2Path, "targets");

      const post = await executePostBatch({
        snapshotKeys: snapKeys,
        expectedDeleteCount: binding.snapshotPostBatchDeleteCount,
        expectedRequeueCount: binding.snapshotPostBatchRequeueCount,
        v2Targets,
        applySnapshotPostBatch: adapters.applySnapshotPostBatch,
        rebuildV2Targets: adapters.rebuildV2Targets,
      });

      tripwire.assertZero("EXECUTE_FROM_CACHE");

      const result = {
        mode,
        CURRENT_TASK_DATABASE_WRITE: ephemeral ? "EPHEMERAL_ONLY" : "YES",
        operationId: binding.operationId,
        operationStartedAt,
        adapterReadiness: readiness,
        OZON_NETWORK_CALLS: tripwire.count(),
        sourceResult,
        statusResult,
        post,
        SEPARATE_STATUS_UPSERT_FOR_SOURCE_BACKFILL: 0,
        executableMutationCode: true,
      };
      writeFileSync(
        join(outDir, "EXECUTE_FROM_CACHE_RESULT.json"),
        JSON.stringify(result, null, 2) + "\n"
      );
      console.log(
        JSON.stringify(
          {
            mode,
            ok: true,
            operationStartedAt,
            OZON_NETWORK_CALLS: tripwire.count(),
            ...sourceResult,
            statusResult,
            post,
          },
          null,
          2
        )
      );
      return 0;
    } finally {
      tripwire.restore();
    }
  }

  if (mode === "VERIFY") {
    const sourcePath = requireExplicit("sourceManifest", args.sourceManifest);
    const statusPath = requireExplicit("statusManifest", args.statusManifest);
    const snapshotPath = requireExplicit("snapshotManifest", args.snapshotManifest);
    const v2Path = requireExplicit("v2Manifest", args.v2Manifest);

    const verified = await verifyOzonHistoricalRepair({
      sourceTargets: readManifestTargets<SourceTarget>(sourcePath, "targets"),
      statusTargets: readManifestTargets<StatusOnlyTarget>(statusPath, "targets"),
      snapshotKeys: readManifestTargets<SnapshotKey>(snapshotPath, "keys"),
      v2Targets: readManifestTargets<V2Target>(v2Path, "targets"),
      operationStartedAt: args.operationStartedAt ?? null,
    });

    const report = {
      mode,
      ok: verified.ok,
      DATABASE_READ: "YES",
      checks: verified.checks,
    };
    writeFileSync(join(outDir, "VERIFY_RESULT.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
    return verified.ok ? 0 : 1;
  }

  throw new Error(`Unhandled mode ${mode}`);
}

const isDirect =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  /runOzonHistoricalFinancialRepair\.(ts|js|mjs|cjs)$/.test(process.argv[1].replace(/\\/g, "/"));
if (isDirect) {
  runCli().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    }
  );
}
