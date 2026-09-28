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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
} from "@/lib/ozon/syncOzonAccrualByDay";
import { shouldInvalidateProfit, shouldInvalidateSnapshots } from "@/lib/ozon/historicalRepairInvalidationPolicy";
import {
  collectV2MatrixRows,
  computeOzonAccrualPayloadSha256,
  createMarketplaceApiConnectionCredentialLoader,
  createProductionMutationAdapters,
  STATUS_ONLY_EXPECTED_PAYLOAD_PLACEHOLDER,
  fetchOzonRepairTargetLive,
  installOzonNetworkTripwire,
  runPrepareDbReadOnlyPreflight,
  runProductionAdapterReadinessGate,
  verifyOzonHistoricalRepair,
  type OzonCredentialLoader,
  type OzonRepairFetchRange,
  type PrepareDbPreflight,
  type ProductionMutationAdapters,
  type V2RowFingerprintObservation,
  type VerifyPhase,
} from "@/lib/ozon/financialRepairProductionAdapters";
import {
  OWNER_EXECUTE_MARKER,
  assertBindingMatchesOwnerApproval,
  resolveOwnerApprovalImmutableBinding,
  verifyAndParseOwnerApprovalFile,
  type OwnerApprovalImmutableBinding,
} from "@/lib/ozon/ownerApprovalBinding";

/**
 * Re-exported so a host wrapper (or a post-mortem replay) can apply the snapshot
 * union without importing the whole runner CLI.
 */
export {
  applyExactSnapshotUnionOnce,
  installOzonNetworkTripwire,
  runPrepareDbReadOnlyPreflight,
  runProductionAdapterReadinessGate,
  verifyOzonHistoricalRepair,
  createProductionMutationAdapters,
  computeV2PeriodRowFingerprint,
  readV2PeriodRowFingerprints,
  collectV2MatrixRows,
} from "@/lib/ozon/financialRepairProductionAdapters";
export {
  OWNER_EXECUTE_MARKER,
  parseOwnerApprovalFile,
  parseOwnerApprovalText,
  resolveOwnerApprovalImmutableBinding,
  verifyAndParseOwnerApprovalFile,
} from "@/lib/ozon/ownerApprovalBinding";

export type RunnerMode =
  | "DRY_RUN"
  | "PREPARE"
  | "EXECUTE_FROM_CACHE"
  | "VERIFY"
  | "VERIFY_MUTATION_POSTCONDITIONS"
  | "VERIFY_FINAL_FINANCIAL_OUTPUT";

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
  /**
   * sha256 of the prepare-cache CONTENT (buildPrepareCacheManifestSha), not of the
   * sidecar file that carries it. The wrapper reads this straight out of
   * PREPARE_CACHE.sha256.txt, so binding it to the file's own bytes could never
   * be satisfied.
   */
  prepareCacheContentSha256: string;
  /** Legacy spelling of prepareCacheContentSha256; same CONTENT meaning. */
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
  /** Rows that must stay UNAVAILABLE carry the marker string instead of a number. */
  expectedCanonicalWb: number | string;
  expectedCanonicalOzon: number | string;
  expectedTotal: number | string;
  formulaVersion?: string;
  currentRowFingerprint?: string;
  currentDataMode?: string;
  currentCoverageStatus?: string;
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

const RUNNER_MODES: readonly RunnerMode[] = [
  "DRY_RUN",
  "PREPARE",
  "EXECUTE_FROM_CACHE",
  "VERIFY",
  "VERIFY_MUTATION_POSTCONDITIONS",
  "VERIFY_FINAL_FINANCIAL_OUTPUT",
];

export function parseMode(raw?: string): RunnerMode {
  const m = String(raw || "DRY_RUN").toUpperCase() as RunnerMode;
  if (RUNNER_MODES.includes(m)) return m;
  throw new Error(`Unknown mode ${raw}`);
}

/**
 * VERIFY is two stages: what the mutation wrote (true immediately) and what the
 * downstream workers produced (true only once the requeued jobs drain). The mode
 * picks the stage; --verifyPhase overrides it for the plain VERIFY entry point.
 */
export function resolveVerifyPhase(mode: RunnerMode, raw?: string): VerifyPhase {
  if (raw) {
    const phase = raw.toUpperCase().replace(/^VERIFY_/, "");
    if (
      phase === "MUTATION_POSTCONDITIONS" ||
      phase === "FINAL_FINANCIAL_OUTPUT" ||
      phase === "ALL"
    ) {
      return phase;
    }
    throw new Error(`Unknown verifyPhase ${raw}`);
  }
  if (mode === "VERIFY_MUTATION_POSTCONDITIONS") return "MUTATION_POSTCONDITIONS";
  if (mode === "VERIFY_FINAL_FINANCIAL_OUTPUT") return "FINAL_FINANCIAL_OUTPUT";
  return "ALL";
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

/** The CONTENT sha the binding pins, accepting either spelling of the field. */
export function executeBindingPrepareCacheContentSha(binding: ExecuteBinding): string {
  const content = binding.prepareCacheContentSha256 || binding.prepareCacheManifestSha256;
  return requireExplicit("prepareCacheContentSha256", content);
}

export function validateExecuteBinding(binding: ExecuteBinding, files: {
  sourceBackfillPath: string;
  statusOnlyPath: string;
  snapshotPath: string;
  v2Path: string;
  /** Sidecar that declares the cache CONTENT sha (PREPARE_CACHE.sha256.txt). */
  prepareCacheManifestPath: string;
  /** When supplied, the cache itself must hash to the same CONTENT sha. */
  cache?: PrepareCache;
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
  const prepareCacheContentSha = executeBindingPrepareCacheContentSha(binding);
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
  // The sidecar carries the cache CONTENT sha, so the binding is compared against
  // what the sidecar declares — never against sha256File(sidecar), which pins the
  // wrong artifact and can never agree with what the wrapper passes.
  const sealedContentSha = resolveSealedPrepareCacheContentSha(files.prepareCacheManifestPath);
  if (sealedContentSha !== prepareCacheContentSha.toLowerCase()) {
    throw new Error(
      `prepareCacheContentSha256 mismatch binding=${prepareCacheContentSha} sealed=${sealedContentSha}`
    );
  }
  if (files.cache && buildPrepareCacheManifestSha(files.cache) !== sealedContentSha) {
    throw new Error("prepare cache content sha mismatch vs sealed manifest");
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
  /** All 6 V2 matrix rows (mutation targets + rows kept UNAVAILABLE). */
  v2MatrixRows?: V2Target[];
  /** READ-ONLY database observation taken during PREPARE. */
  PREPARE_DB_PREFLIGHT?: PrepareDbPreflight;
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

export type FullRepairPreMutationGateReport = {
  ok: boolean;
  WRITES_PERFORMED: 0;
  inspectedSourceTargets: number;
  sourceStates: Record<"MISSING" | "NOOP_COMPLETE" | "RAW_PERSISTED_RESUME" | "CONFLICT", number>;
  conflicts: Array<{ company: string; date: string; reason: string }>;
  statusStandaloneTargets: number;
  snapshotUniqueKeys: number;
  v2MatrixRows: number;
  v2FingerprintsMatched: number;
  v2Fingerprints: V2RowFingerprintObservation[];
  profitReadModelTargets: number;
  failures: string[];
};

export type FullRepairPreMutationGateInput = {
  cache: PrepareCache;
  statusTargets: StatusOnlyTarget[];
  snapshotKeys: SnapshotKey[];
  v2Targets: V2Target[];
  /** All 6 matrix rows; falls back to the 2 mutation targets. */
  v2MatrixRows?: V2Target[];
  adapters: Pick<
    ProductionMutationAdapters,
    | "inspectTargetStateForGate"
    | "inspectStandaloneStatusTargetStateForGate"
    | "readV2MatrixFingerprints"
    | "countProfitReadModelTargets"
  >;
  expected?: {
    sourceTargets?: number;
    statusTargets?: number;
    snapshotUniqueKeys?: number;
    v2MatrixRows?: number;
    v2NumericMutationTargets?: number;
    profitReadModelTargets?: number;
  };
};

/**
 * ALL-TARGET pre-mutation gate. Runs before the first write of EXECUTE_FROM_CACHE
 * and inspects every one of the 78 source targets, not just the next one, so a
 * conflict on the *last* day stops the run with zero rows written instead of 77
 * days in and a half-applied repair.
 *
 * It also proves the rest of the blast radius is the approved one: 10 standalone
 * statuses, 35 unique snapshot keys, 6 V2 matrix fingerprints unchanged, and zero
 * profit read-model targets.
 */
export async function runFullRepairPreMutationGate(
  input: FullRepairPreMutationGateInput
): Promise<FullRepairPreMutationGateReport> {
  const expected = {
    sourceTargets: 78,
    statusTargets: 10,
    snapshotUniqueKeys: 35,
    v2MatrixRows: 6,
    v2NumericMutationTargets: 2,
    profitReadModelTargets: 0,
    ...(input.expected ?? {}),
  };
  const failures: string[] = [];
  const sourceStates = {
    MISSING: 0,
    NOOP_COMPLETE: 0,
    RAW_PERSISTED_RESUME: 0,
    CONFLICT: 0,
  };
  const conflicts: FullRepairPreMutationGateReport["conflicts"] = [];

  // Every source is inspected before the decision; a CONFLICT is recorded, never
  // thrown mid-loop, so the report covers all 78 and no write can have happened.
  for (const target of input.cache.targets) {
    const sealed = target.sealed;
    const observed = await input.adapters.inspectTargetStateForGate(sealed);
    sourceStates[observed.state] += 1;
    if (observed.state === "CONFLICT") {
      conflicts.push({
        company: sealed.companyName,
        date: sealed.date,
        reason: observed.reason,
      });
    }
  }
  const inspectedSourceTargets = input.cache.targets.length;
  if (inspectedSourceTargets !== expected.sourceTargets) {
    failures.push(
      `source targets inspected ${inspectedSourceTargets}, expected ${expected.sourceTargets}`
    );
  }
  if (conflicts.length > 0) {
    failures.push(
      `CONFLICTING_SOURCE_STATE on ${conflicts.length} target(s): ` +
        conflicts
          .slice(0, 5)
          .map((row) => `${row.company}|${row.date}:${row.reason}`)
          .join(" ; ")
    );
  }

  if (input.statusTargets.length !== expected.statusTargets) {
    failures.push(
      `standalone status targets ${input.statusTargets.length}, expected ${expected.statusTargets}`
    );
  }

  for (const target of input.statusTargets) {
    const observed = await input.adapters.inspectStandaloneStatusTargetStateForGate(
      target,
    );
    if (observed.state === "CONFLICT") {
      failures.push(
        `STANDALONE_STATUS_CONFLICT ${target.company}|${target.date}: ${observed.reason}`,
      );
    }
  }

  const uniqueSnapshotKeys = new Set(
    input.snapshotKeys.map(
      (key) => `${key.companyScope}|${key.dateFrom}|${key.dateTo}|${key.formulaVersion}`
    )
  );
  if (uniqueSnapshotKeys.size !== expected.snapshotUniqueKeys) {
    failures.push(
      `unique snapshot keys ${uniqueSnapshotKeys.size}, expected ${expected.snapshotUniqueKeys}`
    );
  }

  if (input.v2Targets.length !== expected.v2NumericMutationTargets) {
    failures.push(
      `V2 numeric mutation targets ${input.v2Targets.length}, expected ${expected.v2NumericMutationTargets}`
    );
  }
  if (input.v2Targets.some((target) => target.scope !== "ALL")) {
    failures.push("V2 numeric mutation targets must all be ALL scope");
  }

  const matrixRows = input.v2MatrixRows ?? input.cache.v2MatrixRows ?? input.v2Targets;
  if (matrixRows.length !== expected.v2MatrixRows) {
    failures.push(
      `V2 matrix rows ${matrixRows.length}, expected ${expected.v2MatrixRows}`
    );
  }
  const v2Fingerprints = await input.adapters.readV2MatrixFingerprints(matrixRows);
  const v2FingerprintsMatched = v2Fingerprints.filter((row) => row.match).length;
  const driftedV2 = v2Fingerprints.filter((row) => !row.match);
  if (driftedV2.length > 0) {
    failures.push(
      `V2_ROW_FINGERPRINT_DRIFT rows=${driftedV2.map((row) => row.dbId).join(",")}`
    );
  }

  const profitReadModelTargets = await input.adapters.countProfitReadModelTargets();
  if (profitReadModelTargets !== expected.profitReadModelTargets) {
    failures.push(
      `profit read-model targets ${profitReadModelTargets}, expected ${expected.profitReadModelTargets}`
    );
  }

  const report: FullRepairPreMutationGateReport = {
    ok: failures.length === 0,
    WRITES_PERFORMED: 0,
    inspectedSourceTargets,
    sourceStates,
    conflicts,
    statusStandaloneTargets: input.statusTargets.length,
    snapshotUniqueKeys: uniqueSnapshotKeys.size,
    v2MatrixRows: matrixRows.length,
    v2FingerprintsMatched,
    v2Fingerprints,
    profitReadModelTargets,
    failures,
  };

  if (!report.ok) {
    throw new Error(
      `FULL_REPAIR_PRE_MUTATION_GATE=FAILED EXECUTION=BLOCKED WRITES_PERFORMED=0 ` +
        `inspected=${inspectedSourceTargets} reasons=${failures.join(" | ")}`
    );
  }
  return report;
}

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
    inspectTargetStateForGate: async () => ({
      state: "MISSING",
      reason: "ephemeral memory store has no prior state",
    }),
    upsertStandaloneStatus: async () => "WRITTEN",
    applySnapshotPostBatch: async (keys) => ({
      deleted: keys.length,
      requeued: keys.length,
    }),
    rebuildV2Targets: async (targets) => ({ rebuilt: targets.length }),
    readV2MatrixFingerprints: async (rows) =>
      rows.map((row) => ({
        dbId: row.dbId,
        period: row.period,
        scope: row.scope,
        found: true,
        sealedFingerprint: row.currentRowFingerprint ?? null,
        observedFingerprint: row.currentRowFingerprint ?? null,
        observedDataMode: row.currentDataMode ?? null,
        observedCoverageStatus: row.currentCoverageStatus ?? null,
        match: true,
      })),
    countProfitReadModelTargets: async () => 0,
    inspectStandaloneStatusTargetStateForGate: async (target) => {
      const bound = target.expectedPayloadSha256 ?? "";
      if (
        !bound ||
        bound === STATUS_ONLY_EXPECTED_PAYLOAD_PLACEHOLDER ||
        !/^[0-9a-f]{64}$/i.test(bound)
      ) {
        return {
          state: "CONFLICT",
          reason: "expectedPayloadSha256 missing or not live-bound",
        };
      }
      return {
        state: "READY",
        reason: "ephemeral memory store has no prior standalone status",
      };
    },
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
  /** All 6 V2 matrix rows, carried into the cache for the pre-mutation gate. */
  v2MatrixRows?: V2Target[];
  /** READ-ONLY database observation to seal into the cache. */
  dbPreflight?: PrepareDbPreflight;
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
      v2MatrixRows: params.v2MatrixRows ?? params.v2Targets,
      ...(params.dbPreflight ? { PREPARE_DB_PREFLIGHT: params.dbPreflight } : {}),
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

/** The full V2 matrix: numeric mutation targets plus the rows kept UNAVAILABLE. */
function readV2MatrixRows(path: string): V2Target[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    targets?: V2Target[];
    keepUnavailable?: V2Target[];
  };
  return collectV2MatrixRows(parsed);
}

/**
 * Verifies the owner approval bytes, parses them under the whitelist grammar, and
 * returns the immutable fields the runner must bind to. Absent --approvalFile the
 * runner keeps working from the command line alone, which is what the ephemeral
 * contract tests exercise.
 */
function bindOwnerApproval(args: Record<string, string>): OwnerApprovalImmutableBinding | null {
  if (!args.approvalFile) {
    if (args.approvalSha256) {
      throw new Error("--approvalSha256 requires --approvalFile");
    }
    return null;
  }
  const approval = verifyAndParseOwnerApprovalFile({
    path: resolve(args.approvalFile),
    expectedSha256: requireExplicit("approvalSha256", args.approvalSha256),
  });
  return resolveOwnerApprovalImmutableBinding(approval);
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
        "PREPARE_DB_READONLY_PREFLIGHT",
        "PREPARE",
        "QUIESCE_EXTERNAL",
        "ADAPTER_READINESS_GATE",
        "FULL_REPAIR_PRE_MUTATION_GATE",
        "EXECUTE_FROM_CACHE",
        "POST_BATCH",
        "VERIFY_MUTATION_POSTCONDITIONS",
        "VERIFY_FINAL_FINANCIAL_OUTPUT",
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

    // Approval is bound in PREPARE too: fetching live under the wrong approval is
    // already a contract violation, even though nothing is written.
    const approvalBinding = bindOwnerApproval(args);
    if (approvalBinding) {
      assertBindingMatchesOwnerApproval({
        binding: {
          sourceBackfillManifestSha256: manifestShas.sourceBackfillManifestSha256,
          statusOnlyManifestSha256: manifestShas.statusOnlyManifestSha256,
          snapshotTargetManifestSha256: manifestShas.snapshotTargetManifestSha256,
          v2TargetManifestSha256: manifestShas.v2TargetManifestSha256,
        },
        approvalBinding,
      });
    }

    let cache: PrepareCache;
    let ozonApiCalls = 0;
    let prepareMode: "LIVE_OZON_FETCH" | "EXTERNAL_CACHE_IN";
    let dbPreflight: PrepareDbPreflight | null = null;

    if (args.prepareLive === "1") {
      prepareMode = "LIVE_OZON_FETCH";
      const sourceTargets = readManifestTargets<SourceTarget>(sourcePath, "targets");
      const statusTargets = readManifestTargets<StatusOnlyTarget>(statusPath, "targets");
      const snapshotKeys = readManifestTargets<SnapshotKey>(snapshotPath, "keys");
      const v2Targets = readManifestTargets<V2Target>(v2Path, "targets");
      const v2MatrixRows = readV2MatrixRows(v2Path);

      // READ-ONLY preflight first: if the database the mutation will touch is not
      // the one that was certified, stop before a single Ozon call is made.
      dbPreflight = await runPrepareDbReadOnlyPreflight({
        sourceTargets,
        statusTargets,
        snapshotKeys,
        v2MatrixRows,
      });
      if (!dbPreflight.ok) {
        throw new Error(
          `PREPARE_DB_PREFLIGHT=FAILED EXECUTION=BLOCKED CURRENT_TASK_DATABASE_WRITE=NO ` +
            `reasons=${dbPreflight.failures.join(" | ")}`
        );
      }

      const tripwire = installOzonNetworkTripwire({ mode: "COUNT" });
      try {
        const live = await preparePrepareCacheLive({
          sourceTargets,
          statusOnly: statusTargets,
          snapshotKeys,
          v2Targets,
          v2MatrixRows,
          dbPreflight,
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

    // PREPARE_CACHE.sha256.txt carries the CONTENT sha of the cache; that is the
    // value the wrapper feeds back as --prepareCacheManifestSha256 on EXECUTE.
    const contentSha = buildPrepareCacheManifestSha(cache);
    const cacheDir = resolve(args.prepareCacheOut || join(outDir, "prepare-cache"));
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "PREPARE_CACHE.json"), JSON.stringify(cache, null, 2) + "\n");
    writeFileSync(join(cacheDir, "PREPARE_CACHE.sha256.txt"), contentSha + "\n");
    writeFileSync(
      join(cacheDir, "PREPARE_CACHE_MANIFEST.json"),
      JSON.stringify(
        {
          prepareCacheContentSha256: contentSha,
          prepareCacheManifestSha256: contentSha,
          PREPARE_CACHE_SHA_MEANING: "CONTENT_SHA_OF_PREPARE_CACHE_JSON",
          ...manifestShas,
          prepareMode,
          ozonApiCalls,
          targetCount: cache.targets.length,
          ownerApprovalBound: Boolean(approvalBinding),
          PREPARE_DB_PREFLIGHT: cache.PREPARE_DB_PREFLIGHT ?? dbPreflight ?? "NOT_RUN",
          CURRENT_TASK_DATABASE_WRITE: "NO",
        },
        null,
        2
      ) + "\n"
    );
    console.log(
      JSON.stringify(
        {
          mode,
          ok: true,
          prepareMode,
          ozonApiCalls,
          prepareCacheContentSha256: contentSha,
          prepareCacheManifestSha256: contentSha,
          PREPARE_DB_PREFLIGHT: dbPreflight
            ? { ok: dbPreflight.ok, skipped: dbPreflight.skipped }
            : "NOT_RUN",
        },
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
      prepareCacheContentSha256: requireExplicit(
        "prepareCacheContentSha256",
        args.prepareCacheContentSha256 ?? args.prepareCacheManifestSha256
      ),
      prepareCacheManifestSha256: requireExplicit(
        "prepareCacheManifestSha256",
        args.prepareCacheManifestSha256 ?? args.prepareCacheContentSha256
      ),
      mutationTimeAppImageSha256: requireExplicit("mutationTimeAppImageSha256", args.mutationTimeAppImageSha256),
    };

    // The approval file, not the command line, is the authority for every
    // immutable field. A wrapper that passes something else is refused.
    const approvalBinding = bindOwnerApproval(args);
    if (approvalBinding) {
      assertBindingMatchesOwnerApproval({ binding, approvalBinding });
    }

    const sourcePath = requireExplicit("sourceManifest", args.sourceManifest);
    const statusPath = requireExplicit("statusManifest", args.statusManifest);
    const snapshotPath = requireExplicit("snapshotManifest", args.snapshotManifest);
    const v2Path = requireExplicit("v2Manifest", args.v2Manifest);
    const cachePath = requireExplicit("prepareCache", args.prepareCache);
    const cacheManifestPath = requireExplicit("prepareCacheManifest", args.prepareCacheManifest);

    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as PrepareCache;
    validateExecuteBinding(binding, {
      sourceBackfillPath: sourcePath,
      statusOnlyPath: statusPath,
      snapshotPath,
      v2Path,
      prepareCacheManifestPath: cacheManifestPath,
      cache,
    });

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

      const statusTargets = readManifestTargets<StatusOnlyTarget>(statusPath, "targets");
      const snapKeys = readManifestTargets<SnapshotKey>(snapshotPath, "keys");
      const v2Targets = readManifestTargets<V2Target>(v2Path, "targets");
      const v2MatrixRows = readV2MatrixRows(v2Path);

      const adapters: ProductionMutationAdapters = ephemeral
        ? createEphemeralMutationAdapters()
        : createProductionMutationAdapters({
            expectedPayloadSha256: (target) =>
              payloadShaByDay.get(`${target.companyName}|${target.date}`) ?? null,
            v2MatrixRows,
          });

      // PRE-MUTATION GATE 1/2. Proves the adapters are bound, the relations
      // exist, the deferred-invalidation contract holds, and no Ozon call has
      // happened.
      const readiness = await runProductionAdapterReadinessGate({
        adapters,
        profile: ephemeral ? "EPHEMERAL_MEMORY" : "PRODUCTION_PRISMA",
        tripwire,
      });

      // PRE-MUTATION GATE 2/2. Inspects ALL 78 sources plus the whole blast
      // radius before the first write, so a conflict on the last target costs
      // zero rows instead of a half-applied repair.
      const preMutationGate = await runFullRepairPreMutationGate({
        cache,
        statusTargets,
        snapshotKeys: snapKeys,
        v2Targets,
        v2MatrixRows,
        adapters,
        expected: {
          sourceTargets: binding.sourceBackfillTargetCount,
          statusTargets: binding.statusStandaloneTargetCount,
          snapshotUniqueKeys: binding.snapshotPostBatchDeleteCount,
          v2NumericMutationTargets: binding.v2NumericMutationTargetCount,
          // The approval is the authority for the matrix size; without one the
          // manifest is all there is.
          v2MatrixRows: approvalBinding?.v2MatrixRowCount ?? v2MatrixRows.length,
        },
      });

      const sourceResult = await executeSourceTargetsFromCache({
        cache,
        adapters,
        checkpointPath: args.checkpointPath
          ? resolve(args.checkpointPath)
          : join(outDir, "EXECUTE_CHECKPOINT.json"),
      });

      const statusResult = await executeStandaloneStatuses({
        targets: statusTargets,
        upsert: adapters.upsertStandaloneStatus,
      });

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
        ownerApprovalBound: Boolean(approvalBinding),
        adapterReadiness: readiness,
        preMutationGate,
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

  if (
    mode === "VERIFY" ||
    mode === "VERIFY_MUTATION_POSTCONDITIONS" ||
    mode === "VERIFY_FINAL_FINANCIAL_OUTPUT"
  ) {
    const sourcePath = requireExplicit("sourceManifest", args.sourceManifest);
    const statusPath = requireExplicit("statusManifest", args.statusManifest);
    const snapshotPath = requireExplicit("snapshotManifest", args.snapshotManifest);
    const v2Path = requireExplicit("v2Manifest", args.v2Manifest);
    const verifyPhase = resolveVerifyPhase(mode, args.verifyPhase);

    const verified = await verifyOzonHistoricalRepair({
      sourceTargets: readManifestTargets<SourceTarget>(sourcePath, "targets"),
      statusTargets: readManifestTargets<StatusOnlyTarget>(statusPath, "targets"),
      snapshotKeys: readManifestTargets<SnapshotKey>(snapshotPath, "keys"),
      v2Targets: readManifestTargets<V2Target>(v2Path, "targets"),
      operationStartedAt: args.operationStartedAt ?? null,
      verifyPhase,
    });

    const report = {
      mode,
      verifyPhase,
      ok: verified.ok,
      DATABASE_READ: "YES",
      checks: verified.checks,
    };
    const fileName =
      verifyPhase === "FINAL_FINANCIAL_OUTPUT"
        ? "VERIFY_FINAL_FINANCIAL_OUTPUT_RESULT.json"
        : "VERIFY_RESULT.json";
    writeFileSync(join(outDir, fileName), JSON.stringify(report, null, 2) + "\n");
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
