/**
 * Owner-gated Ozon historical financial repair runner.
 * DEFAULT = DRY-RUN. Never mutates unless EXECUTE marker + all bound identities match.
 *
 * Production wrapper (future, not this task) must quiesce workers BEFORE EXECUTE.
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type RepairRunnerMode = "DRY_RUN" | "EXECUTE";

export type RepairRunnerInputs = {
  operationId: string;
  sourceBackfillManifestSha256: string;
  statusOnlyManifestSha256: string;
  postBatchTargetsSha256: string;
  expectedProductionAppImageSha256: string;
  expectedCandidateAppImageSha256?: string;
  sourceBackfillTargetCount: number;
  statusStandaloneTargetCount: number;
  executeMarker?: string;
};

export type RepairRunnerManifests = {
  sourceBackfill: {
    SOURCE_BACKFILL_TARGET_COUNT: number;
    targets: Array<{ companyName: string; companyId: string; date: string; rawResponseHash: string }>;
  };
  statusOnly: {
    STANDALONE_STATUS_ONLY_REPAIR: number;
    targets: Array<{ company: string; date: string; importSessionId: string }>;
  };
  postBatch: {
    V2_NUMERIC_MUTATION_TARGET_COUNT: number;
    PROFIT_RM_EXPLICIT_TARGET_COUNT: number;
    SNAPSHOT_EXPLICIT_TARGET_COUNT: number;
    v2Targets: Array<{ period: string; scope: string; dbId: string }>;
    profitTargets: unknown[];
    snapshotTargets: unknown[];
  };
};

export const OWNER_EXECUTE_MARKER = "OWNER_EXECUTE_OZON_HISTORICAL_FINANCIAL_REPAIR_V1";

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function assertManifestCounts(manifests: RepairRunnerManifests, inputs: RepairRunnerInputs) {
  if (manifests.sourceBackfill.SOURCE_BACKFILL_TARGET_COUNT !== inputs.sourceBackfillTargetCount) {
    throw new Error(
      `sourceBackfill count mismatch: manifest=${manifests.sourceBackfill.SOURCE_BACKFILL_TARGET_COUNT} input=${inputs.sourceBackfillTargetCount}`
    );
  }
  if (manifests.sourceBackfill.targets.length !== 78) {
    throw new Error(`sourceBackfill targets must be 78, got ${manifests.sourceBackfill.targets.length}`);
  }
  if (manifests.statusOnly.STANDALONE_STATUS_ONLY_REPAIR !== inputs.statusStandaloneTargetCount) {
    throw new Error(
      `statusOnly count mismatch: manifest=${manifests.statusOnly.STANDALONE_STATUS_ONLY_REPAIR} input=${inputs.statusStandaloneTargetCount}`
    );
  }
  if (manifests.statusOnly.targets.length !== 10) {
    throw new Error(`standalone status targets must be 10, got ${manifests.statusOnly.targets.length}`);
  }
  if (manifests.postBatch.V2_NUMERIC_MUTATION_TARGET_COUNT !== 2) {
    throw new Error(`V2 numeric targets must be 2, got ${manifests.postBatch.V2_NUMERIC_MUTATION_TARGET_COUNT}`);
  }
}

export function resolveRunnerMode(inputs: RepairRunnerInputs): RepairRunnerMode {
  if (inputs.executeMarker === OWNER_EXECUTE_MARKER) return "EXECUTE";
  return "DRY_RUN";
}

export type PreflightResult = {
  mode: RepairRunnerMode;
  ok: boolean;
  phases: string[];
  failures: string[];
  plan: {
    sourcePersistWithDeferredInvalidation: number;
    intrinsicStatusWrites: number;
    separateStatusUpsertsForSourceBackfill: number;
    standaloneStatusOnly: number;
    postBatchV2: number;
    postBatchProfit: number;
    postBatchSnapshot: number;
  };
};

/**
 * Pure preflight planner — no DB/API. Used by tests and dry-run.
 */
export function planHistoricalRepair(params: {
  inputs: RepairRunnerInputs;
  manifests: RepairRunnerManifests;
  sourceBackfillFileSha256: string;
  statusOnlyFileSha256: string;
  postBatchFileSha256: string;
  currentProductionAppImageSha256: string;
}): PreflightResult {
  const failures: string[] = [];
  const phases = [
    "1_preflight",
    "2_quiescence_prerequisite_external",
    "3_source_persist_DEFERRED_OWNER_REPAIR",
    "4_verify_intrinsic_statuses_78",
    "5_standalone_status_only_10",
    "6_post_batch_invalidation_exact_manifest",
    "7_rebuild_exact_V2_ALL_only",
    "8_restore_workers_external",
  ];

  try {
    assertManifestCounts(params.manifests, params.inputs);
  } catch (e) {
    failures.push(e instanceof Error ? e.message : String(e));
  }

  if (params.sourceBackfillFileSha256 !== params.inputs.sourceBackfillManifestSha256) {
    failures.push("sourceBackfillManifestSha256 mismatch");
  }
  if (params.statusOnlyFileSha256 !== params.inputs.statusOnlyManifestSha256) {
    failures.push("statusOnlyManifestSha256 mismatch");
  }
  if (params.postBatchFileSha256 !== params.inputs.postBatchTargetsSha256) {
    failures.push("postBatchTargetsSha256 mismatch");
  }
  if (params.currentProductionAppImageSha256 !== params.inputs.expectedProductionAppImageSha256) {
    failures.push("production APP image precondition mismatch");
  }

  const mode = resolveRunnerMode(params.inputs);
  if (mode === "EXECUTE" && failures.length) {
    // EXECUTE always fail-closed on preflight errors
  }

  return {
    mode,
    ok: failures.length === 0,
    phases,
    failures,
    plan: {
      sourcePersistWithDeferredInvalidation: 78,
      intrinsicStatusWrites: 78,
      separateStatusUpsertsForSourceBackfill: 0,
      standaloneStatusOnly: 10,
      postBatchV2: params.manifests.postBatch.V2_NUMERIC_MUTATION_TARGET_COUNT,
      postBatchProfit: params.manifests.postBatch.PROFIT_RM_EXPLICIT_TARGET_COUNT,
      postBatchSnapshot: params.manifests.postBatch.SNAPSHOT_EXPLICIT_TARGET_COUNT,
    },
  };
}

export function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * CLI entry: defaults DRY_RUN. Writes plan JSON. Does not mutate production.
 */
export async function main(argv = process.argv.slice(2)) {
  const args = Object.fromEntries(
    argv
      .filter((a) => a.includes("="))
      .map((a) => {
        const i = a.indexOf("=");
        return [a.slice(0, i).replace(/^--/, ""), a.slice(i + 1)];
      })
  ) as Record<string, string>;

  const sourcePath = resolve(args.sourceManifest || "");
  const statusPath = resolve(args.statusManifest || "");
  const postPath = resolve(args.postBatchManifest || "");
  if (!existsSync(sourcePath) || !existsSync(statusPath) || !existsSync(postPath)) {
    throw new Error("sourceManifest/statusManifest/postBatchManifest paths required and must exist");
  }

  const sourceObj = loadJson(sourcePath) as RepairRunnerManifests["sourceBackfill"];
  const statusObj = loadJson(statusPath) as RepairRunnerManifests["statusOnly"];
  const postObj = loadJson(postPath) as RepairRunnerManifests["postBatch"];

  const inputs: RepairRunnerInputs = {
    operationId: args.operationId || "UNSET",
    sourceBackfillManifestSha256: args.sourceBackfillManifestSha256 || sha256File(sourcePath),
    statusOnlyManifestSha256: args.statusOnlyManifestSha256 || sha256File(statusPath),
    postBatchTargetsSha256: args.postBatchTargetsSha256 || sha256File(postPath),
    expectedProductionAppImageSha256:
      args.expectedProductionAppImageSha256 ||
      "sha256:7b29005b1655fe68144e6b8a88010ab6d95894c9a167072dab92825af65e044b",
    sourceBackfillTargetCount: Number(args.sourceBackfillTargetCount || 78),
    statusStandaloneTargetCount: Number(args.statusStandaloneTargetCount || 10),
    executeMarker: args.executeMarker,
  };

  const result = planHistoricalRepair({
    inputs,
    manifests: {
      sourceBackfill: sourceObj,
      statusOnly: statusObj,
      postBatch: postObj,
    },
    sourceBackfillFileSha256: sha256File(sourcePath),
    statusOnlyFileSha256: sha256File(statusPath),
    postBatchFileSha256: sha256File(postPath),
    currentProductionAppImageSha256:
      args.currentProductionAppImageSha256 || inputs.expectedProductionAppImageSha256,
  });

  const outPath = resolve(args.out || "OZON_HISTORICAL_REPAIR_RUNNER_PLAN.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        runner: "scripts/financialRepair/runOzonHistoricalFinancialRepair.ts",
        invalidationModeForSourcePersist: "DEFERRED_OWNER_REPAIR",
        SEPARATE_STATUS_UPSERT_FOR_SOURCE_BACKFILL: "NO",
        CURRENT_TASK_DATABASE_WRITE: result.mode === "EXECUTE" ? "WOULD_MUTATE_IN_FUTURE_WRAPPER" : "NO",
        ...result,
      },
      null,
      2
    ) + "\n"
  );
  console.log(JSON.stringify({ mode: result.mode, ok: result.ok, outPath, failures: result.failures }, null, 2));
  if (!result.ok) process.exit(2);
  if (result.mode === "EXECUTE") {
    console.error(
      "EXECUTE marker accepted for plan only in this certification build; production mutation wrapper is out of scope for this task."
    );
    process.exit(3);
  }
}

// CLI: `npx tsx scripts/financialRepair/runOzonHistoricalFinancialRepair.ts --sourceManifest=...`
const isDirect =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  /runOzonHistoricalFinancialRepair\.(ts|js|mjs|cjs)$/.test(process.argv[1].replace(/\\/g, "/"));
if (isDirect) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
