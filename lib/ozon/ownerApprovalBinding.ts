/**
 * Strict parser + runtime binder for the owner approval text of the Ozon
 * historical financial repair.
 *
 * The approval file is data, never code: it is read as UTF-8 text and parsed with
 * a whitelist KEY=VALUE grammar. Nothing here evaluates, sources, requires or
 * interpolates the file, so a tampered approval can only ever produce a parse
 * failure — never execution.
 *
 * The parser is deliberately unforgiving: a duplicate key, an unknown key that
 * looks security-critical, a non-printable value, or a line that is neither a
 * banner nor KEY=VALUE aborts the run before any binding is derived.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const OWNER_EXECUTE_MARKER =
  "OWNER_EXECUTE_OZON_HISTORICAL_FINANCIAL_REPAIR_V1";

/**
 * Every key the runner is allowed to see. Grouped only for readability; the
 * parser treats the union as one flat whitelist.
 */
export const OWNER_APPROVAL_ALLOWED_KEYS = [
  // identity / provenance
  "STAMP",
  "OPERATION_ID",
  "EXECUTE_MARKER",
  "FINAL_ZIP_SHA256",
  "GITHUB_RUN_ID",
  // images
  "PRE_DEPLOY_CURRENT_APP_IMAGE_SHA256",
  "CANDIDATE_APP_IMAGE_SHA256",
  "ROLLBACK_APP_IMAGE_SHA256",
  "CANDIDATE_REPAIR_RUNNER_IMAGE_SHA256",
  "MUTATION_TIME_APP_IMAGE_SHA256",
  // v6 period read-model worker (candidate deploy of the same source bundle)
  "PRE_DEPLOY_CURRENT_V6_WORKER_IMAGE_SHA256",
  "CANDIDATE_V6_WORKER_IMAGE_SHA256",
  "ROLLBACK_V6_WORKER_IMAGE_SHA256",
  // dashboard period snapshot worker
  "PRE_DEPLOY_CURRENT_DASHBOARD_WORKER_IMAGE_SHA256",
  "CANDIDATE_DASHBOARD_WORKER_IMAGE_SHA256",
  "ROLLBACK_DASHBOARD_WORKER_IMAGE_SHA256",
  // build provenance
  "CANDIDATE_SOURCE_BUNDLE_SHA256",
  "PATCH_SHA256",
  "CANDIDATE_MANIFEST_FILE_SHA256",
  "DOCKERFILE_SHA256",
  "PRODUCTION_WRAPPER_SHA256",
  "RUNNER_SCRIPT_SHA256",
  "APP_SWAP_SPEC_SHA256",
  "V6_WORKER_SWAP_SPEC_SHA256",
  "DASHBOARD_WORKER_SWAP_SPEC_SHA256",
  "JULY_AUGUST_CANARY_PLAN_SHA256",
  // artifacts
  "APP_ARTIFACT_ID",
  "APP_ARTIFACT_NAME",
  "APP_ARTIFACT_DIGEST",
  "APP_ARTIFACT_EXPIRES_AT",
  "APP_IMAGE_TAR_SHA256",
  "APP_COMPRESSED_ARTIFACT_SHA256",
  "REPAIR_RUNNER_ARTIFACT_ID",
  "REPAIR_RUNNER_ARTIFACT_NAME",
  "REPAIR_RUNNER_ARTIFACT_DIGEST",
  "REPAIR_RUNNER_ARTIFACT_EXPIRES_AT",
  "REPAIR_RUNNER_IMAGE_TAR_SHA256",
  "REPAIR_RUNNER_COMPRESSED_ARTIFACT_SHA256",
  "V6_WORKER_ARTIFACT_ID",
  "V6_WORKER_ARTIFACT_NAME",
  "V6_WORKER_ARTIFACT_DIGEST",
  "V6_WORKER_ARTIFACT_EXPIRES_AT",
  "V6_WORKER_IMAGE_TAR_SHA256",
  "V6_WORKER_COMPRESSED_ARTIFACT_SHA256",
  "DASHBOARD_WORKER_ARTIFACT_ID",
  "DASHBOARD_WORKER_ARTIFACT_NAME",
  "DASHBOARD_WORKER_ARTIFACT_DIGEST",
  "DASHBOARD_WORKER_ARTIFACT_EXPIRES_AT",
  "DASHBOARD_WORKER_IMAGE_TAR_SHA256",
  "DASHBOARD_WORKER_COMPRESSED_ARTIFACT_SHA256",
  // mutation scope
  "SOURCE_BACKFILL_MANIFEST_SHA256",
  "SOURCE_BACKFILL_TARGET_COUNT",
  "STATUS_ONLY_MANIFEST_SHA256",
  "STATUS_STANDALONE_REPAIR_COUNT",
  "STATUS_EXECUTION_MATRIX_SHA256",
  "STATUS_INTRINSIC_COUNT",
  "STATUS_DUPLICATE_SEPARATE_COUNT",
  "SNAPSHOT_POST_BATCH_MANIFEST_SHA256",
  "SNAPSHOT_TARGET_KEY_COUNT",
  "SNAPSHOT_POST_BATCH_DELETE_COUNT",
  "SNAPSHOT_POST_BATCH_REQUEUE_COUNT",
  "V2_POST_BATCH_MANIFEST_SHA256",
  "V2_MATRIX_ROW_COUNT",
  "V2_NUMERIC_MUTATION_TARGET_COUNT",
  "V2_NONMUTATED_UNAVAILABLE_ROW_COUNT",
  "V2_NON_NULL_FINGERPRINT_COUNT",
  "PROFIT_POST_BATCH_MANIFEST_SHA256",
  "PROFIT_RM_EXPLICIT_TARGET_COUNT",
  // post-mutation drain expectations, polled as exact job SUCCESS counts
  "V6_JOB_SUCCESS_EXPECTED_COUNT",
  "SNAPSHOT_JOB_SUCCESS_EXPECTED_COUNT",
  "WORKER_QUIESCE_MANIFEST_SHA256",
  "CONCURRENCY_SURFACE_SHA256",
  "SECRET_INJECTION_CONTRACT_SHA256",
  "FUTURE_PLAN_SHA256",
  "PREPARE_CACHE_CONTENT_SHA256",
  // attestations
  "PRODUCTION_ADAPTER_PREFLIGHT",
  "REAL_PREPARE_FETCH_PATH",
  "EXECUTE_FROM_CACHE_OZON_NETWORK_CALL_COUNT",
  "INSPECT_TARGET_STATE_PRISMA",
  "STANDALONE_STATUS_PRISMA",
  "SNAPSHOT_POST_BATCH_PRISMA",
  "V2_REBUILD_PRODUCTION_PATH",
  "REAL_VERIFY_POSTSTATE",
  "EPHEMERAL_STORE",
  "EPHEMERAL_E2E",
  "PRODUCTION_WRAPPER_NO_PLACEHOLDERS",
  "PRODUCTION_MUTATION",
  "STAGE1B",
] as const;

export type OwnerApprovalKey = (typeof OWNER_APPROVAL_ALLOWED_KEYS)[number];

const ALLOWED = new Set<string>(OWNER_APPROVAL_ALLOWED_KEYS);

/**
 * An unknown key matching this shape is refused rather than ignored: it claims
 * authority the runner does not understand, which is exactly the case where
 * silently dropping it would be unsafe.
 */
const UNKNOWN_CRITICAL_KEY = /SHA256|DIGEST|IMAGE|MANIFEST|COUNT|MARKER|APPROVAL|MUTATION|OWNER|EXECUTE|TOKEN|SECRET|KEY|PASSWORD|URL/;

const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const BANNER_PATTERN = /^[A-Z][A-Z0-9 _.\-]*$/;
const PRINTABLE_VALUE = /^[\x20-\x7E]*$/;
const MAX_VALUE_LENGTH = 512;
const MAX_LINES = 2_000;

export type OwnerApproval = {
  /** sha256 of the exact approval bytes that were parsed. */
  sha256: string;
  /** Whitelisted KEY=VALUE pairs, in file order. */
  values: Readonly<Record<string, string>>;
  keys: readonly string[];
  /** Header lines carrying no '=' (the human-readable title). */
  banners: readonly string[];
  /** Unknown, non-critical keys that were parsed and deliberately not bound. */
  ignoredKeys: readonly string[];
  get: (key: OwnerApprovalKey) => string | undefined;
  require: (key: OwnerApprovalKey) => string;
  requireNumber: (key: OwnerApprovalKey) => number;
};

function fail(reason: string): never {
  throw new Error(`OWNER_APPROVAL_PARSE_FAILED EXECUTION=BLOCKED ${reason}`);
}

export function sha256Text(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Parses approval text under the whitelist grammar. Pure: no filesystem, no
 * environment, no evaluation.
 */
export function parseOwnerApprovalText(
  text: string,
  options?: { sha256?: string },
): OwnerApproval {
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_LINES) {
    fail(`approval has ${lines.length} lines, max ${MAX_LINES}`);
  }

  const values: Record<string, string> = {};
  const keys: string[] = [];
  const banners: string[] = [];
  const ignoredKeys: string[] = [];

  for (const [index, raw] of lines.entries()) {
    const lineNo = index + 1;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq < 0) {
      if (!BANNER_PATTERN.test(line)) {
        fail(`line ${lineNo} is neither KEY=VALUE nor a banner`);
      }
      banners.push(line);
      continue;
    }

    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!KEY_PATTERN.test(key)) {
      fail(`line ${lineNo} has an invalid key shape`);
    }
    if (!PRINTABLE_VALUE.test(value)) {
      fail(`line ${lineNo} key ${key} has a non-printable value`);
    }
    if (value.length > MAX_VALUE_LENGTH) {
      fail(`line ${lineNo} key ${key} value exceeds ${MAX_VALUE_LENGTH} chars`);
    }
    if (key in values || ignoredKeys.includes(key)) {
      fail(`duplicate key ${key} at line ${lineNo}`);
    }
    if (!ALLOWED.has(key)) {
      if (UNKNOWN_CRITICAL_KEY.test(key)) {
        fail(`unknown critical key ${key} at line ${lineNo}`);
      }
      ignoredKeys.push(key);
      continue;
    }
    values[key] = value;
    keys.push(key);
  }

  if (keys.length === 0) {
    fail("approval declares no whitelisted keys");
  }

  const frozen = Object.freeze({ ...values });
  const get = (key: OwnerApprovalKey) => frozen[key];
  const requireKey = (key: OwnerApprovalKey) => {
    const value = frozen[key];
    if (value === undefined || value === "" || value === "UNSET") {
      fail(`missing required key ${key}`);
    }
    return value;
  };
  return {
    sha256: options?.sha256 ?? sha256Text(text),
    values: frozen,
    keys: Object.freeze([...keys]),
    banners: Object.freeze([...banners]),
    ignoredKeys: Object.freeze([...ignoredKeys]),
    get,
    require: requireKey,
    requireNumber: (key) => {
      const value = requireKey(key);
      if (!/^-?\d+$/.test(value)) {
        fail(`key ${key} must be an integer, got ${value}`);
      }
      return Number(value);
    },
  };
}

/** Reads and parses an approval file. The returned sha256 is of the exact bytes. */
export function parseOwnerApprovalFile(path: string): OwnerApproval {
  const bytes = readFileSync(path);
  return parseOwnerApprovalText(bytes.toString("utf8"), {
    sha256: sha256Text(bytes),
  });
}

/**
 * Verifies the approval bytes against the sha the operator passed on the command
 * line, then parses. A sha mismatch stops before the grammar even runs.
 */
export function verifyAndParseOwnerApprovalFile(params: {
  path: string;
  expectedSha256: string;
}): OwnerApproval {
  const bytes = readFileSync(params.path);
  const observed = sha256Text(bytes);
  const expected = String(params.expectedSha256 || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    fail(`--approvalSha256 must be a 64-hex sha256, got ${params.expectedSha256}`);
  }
  if (observed !== expected) {
    throw new Error(
      `OWNER_APPROVAL_SHA_MISMATCH EXECUTION=BLOCKED expected=${expected} observed=${observed}`,
    );
  }
  return parseOwnerApprovalText(bytes.toString("utf8"), { sha256: observed });
}

/**
 * The fields the runner must take FROM the approval rather than from the command
 * line. Anything the wrapper passes is only allowed to agree with these.
 */
export type OwnerApprovalImmutableBinding = {
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
  v2MatrixRowCount: number;
  v2NonNullFingerprintCount: number;
  profitExplicitTargetCount: number;
  executeMarker: string;
  operationId: string | null;
};

export const OWNER_APPROVAL_IMMUTABLE_FIELDS = [
  "approvalBindingSha256",
  "sourceBackfillManifestSha256",
  "statusOnlyManifestSha256",
  "snapshotTargetManifestSha256",
  "v2TargetManifestSha256",
  "expectedPreDeployAppImageSha256",
  "expectedCandidateAppImageSha256",
  "expectedRepairRunnerImageSha256",
  "sourceBackfillTargetCount",
  "statusStandaloneTargetCount",
  "snapshotPostBatchDeleteCount",
  "snapshotPostBatchRequeueCount",
  "v2NumericMutationTargetCount",
  "executeMarker",
] as const;

/** Projects the approval onto the immutable binding fields. */
export function resolveOwnerApprovalImmutableBinding(
  approval: OwnerApproval,
): OwnerApprovalImmutableBinding {
  const snapshotKeys = approval.requireNumber("SNAPSHOT_TARGET_KEY_COUNT");
  const declaredDelete = approval.get("SNAPSHOT_POST_BATCH_DELETE_COUNT");
  const declaredRequeue = approval.get("SNAPSHOT_POST_BATCH_REQUEUE_COUNT");
  const marker = approval.get("EXECUTE_MARKER") ?? OWNER_EXECUTE_MARKER;
  if (marker !== OWNER_EXECUTE_MARKER) {
    fail(`EXECUTE_MARKER must be ${OWNER_EXECUTE_MARKER}`);
  }
  const binding: OwnerApprovalImmutableBinding = {
    approvalBindingSha256: approval.sha256,
    sourceBackfillManifestSha256: approval.require("SOURCE_BACKFILL_MANIFEST_SHA256"),
    statusOnlyManifestSha256: approval.require("STATUS_ONLY_MANIFEST_SHA256"),
    snapshotTargetManifestSha256: approval.require("SNAPSHOT_POST_BATCH_MANIFEST_SHA256"),
    v2TargetManifestSha256: approval.require("V2_POST_BATCH_MANIFEST_SHA256"),
    expectedPreDeployAppImageSha256: approval.require("PRE_DEPLOY_CURRENT_APP_IMAGE_SHA256"),
    expectedCandidateAppImageSha256: approval.require("CANDIDATE_APP_IMAGE_SHA256"),
    expectedRepairRunnerImageSha256: approval.require("CANDIDATE_REPAIR_RUNNER_IMAGE_SHA256"),
    sourceBackfillTargetCount: approval.requireNumber("SOURCE_BACKFILL_TARGET_COUNT"),
    statusStandaloneTargetCount: approval.requireNumber("STATUS_STANDALONE_REPAIR_COUNT"),
    snapshotPostBatchDeleteCount: declaredDelete ? Number(declaredDelete) : snapshotKeys,
    snapshotPostBatchRequeueCount: declaredRequeue ? Number(declaredRequeue) : snapshotKeys,
    v2NumericMutationTargetCount: approval.requireNumber("V2_NUMERIC_MUTATION_TARGET_COUNT"),
    v2MatrixRowCount: approval.requireNumber("V2_MATRIX_ROW_COUNT"),
    v2NonNullFingerprintCount: approval.requireNumber("V2_NON_NULL_FINGERPRINT_COUNT"),
    profitExplicitTargetCount: approval.requireNumber("PROFIT_RM_EXPLICIT_TARGET_COUNT"),
    executeMarker: marker,
    operationId: approval.get("OPERATION_ID") ?? null,
  };
  if (
    binding.snapshotPostBatchDeleteCount !== snapshotKeys ||
    binding.snapshotPostBatchRequeueCount !== snapshotKeys
  ) {
    fail(
      `snapshot post-batch counts disagree with SNAPSHOT_TARGET_KEY_COUNT=${snapshotKeys}`,
    );
  }
  return Object.freeze(binding);
}

/**
 * Fails closed when the wrapper's command line disagrees with the approval on any
 * immutable field. The approval always wins; disagreement is never reconciled.
 */
export function assertBindingMatchesOwnerApproval(params: {
  binding: Record<string, string | number>;
  approvalBinding: OwnerApprovalImmutableBinding;
}): void {
  const mismatches: string[] = [];
  for (const field of OWNER_APPROVAL_IMMUTABLE_FIELDS) {
    const supplied = params.binding[field];
    if (supplied === undefined) continue;
    const approved = params.approvalBinding[field];
    if (String(supplied) !== String(approved)) {
      mismatches.push(`${field} cli=${supplied} approval=${approved}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `OWNER_APPROVAL_BINDING_MISMATCH EXECUTION=BLOCKED ${mismatches.join(" | ")}`,
    );
  }
}
