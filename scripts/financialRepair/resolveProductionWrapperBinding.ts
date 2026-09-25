/**
 * Resolves everything the production host wrapper is allowed to act on.
 *
 * runApprovedFinancialRepairProduction.sh must not take a single security-relevant
 * value from the environment: the owner approval file is the authority, and the
 * only thing the operator supplies is *where* files live. This helper is the bridge.
 * It parses the approval with the strict whitelist grammar in
 * lib/ozon/ownerApprovalBinding.ts (no eval, no source, no interpolation), shape-checks
 * every value the wrapper will interpolate into a docker command line, and writes a
 * flat KEY=VALUE file that bash reads with grep — never with `source` or `eval`.
 *
 * Modes:
 * - APPROVAL:  approval file -> validated KEY=VALUE + JSON binding
 * - SWAP_SPEC: `docker inspect`-derived container spec -> validated recreate arguments
 *
 * Every failure is fatal and prefixed WRAPPER_BINDING_FAILED so the wrapper can
 * never continue on a partially understood approval.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  OWNER_EXECUTE_MARKER,
  resolveOwnerApprovalImmutableBinding,
  parseOwnerApprovalFile,
  verifyAndParseOwnerApprovalFile,
  type OwnerApproval,
} from "@/lib/ozon/ownerApprovalBinding";

/** Manifest sha that was sealed before the 78-target scope was corrected. */
export const BANNED_STALE_MANIFEST_SHA256 = new Set([
  "6f11a0d69daf2497e0bc6872bab67ded248c3196c08f22cfc31bba69565bf647",
]);

const HEX64 = /^[0-9a-f]{64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const INTEGER = /^\d+$/;
/**
 * Everything the wrapper interpolates into a docker command line. A leading `-` is
 * excluded so a value can never be read as a flag; everything else is restricted to
 * characters that cannot end an argument or start a new command.
 */
const SHELL_SAFE_TOKEN = /^[A-Za-z0-9/][A-Za-z0-9._:@+=/-]*$/;

export class WrapperBindingError extends Error {
  constructor(reason: string) {
    super(`WRAPPER_BINDING_FAILED EXECUTION=BLOCKED ${reason}`);
  }
}

function fail(reason: string): never {
  throw new WrapperBindingError(reason);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/* ------------------------------------------------------------------ *
 * Value shapes
 * ------------------------------------------------------------------ */

function requireShape(
  key: string,
  value: string | undefined,
  pattern: RegExp,
  shapeName: string,
): string {
  if (value === undefined || value === "" || value === "UNSET") {
    fail(`approval is missing required key ${key}`);
  }
  if (!pattern.test(value)) {
    fail(`approval key ${key} is not a ${shapeName}: ${value}`);
  }
  return value;
}

/** Container image identities are compared to `docker image inspect -f {{.Id}}`. */
const IMAGE_KEYS = [
  "PRE_DEPLOY_CURRENT_APP_IMAGE_SHA256",
  "CANDIDATE_APP_IMAGE_SHA256",
  "ROLLBACK_APP_IMAGE_SHA256",
  "CANDIDATE_REPAIR_RUNNER_IMAGE_SHA256",
  "MUTATION_TIME_APP_IMAGE_SHA256",
  "PRE_DEPLOY_CURRENT_V6_WORKER_IMAGE_SHA256",
  "CANDIDATE_V6_WORKER_IMAGE_SHA256",
  "ROLLBACK_V6_WORKER_IMAGE_SHA256",
  "PRE_DEPLOY_CURRENT_DASHBOARD_WORKER_IMAGE_SHA256",
  "CANDIDATE_DASHBOARD_WORKER_IMAGE_SHA256",
  "ROLLBACK_DASHBOARD_WORKER_IMAGE_SHA256",
] as const;

/** Bare sha256 of a file on disk, compared with sha256sum. */
const FILE_SHA_KEYS = [
  "SOURCE_BACKFILL_MANIFEST_SHA256",
  "STATUS_ONLY_MANIFEST_SHA256",
  "SNAPSHOT_POST_BATCH_MANIFEST_SHA256",
  "V2_POST_BATCH_MANIFEST_SHA256",
  "APP_SWAP_SPEC_SHA256",
  "V6_WORKER_SWAP_SPEC_SHA256",
  "DASHBOARD_WORKER_SWAP_SPEC_SHA256",
  "APP_IMAGE_TAR_SHA256",
  "REPAIR_RUNNER_IMAGE_TAR_SHA256",
  "V6_WORKER_IMAGE_TAR_SHA256",
  "DASHBOARD_WORKER_IMAGE_TAR_SHA256",
] as const;

const COUNT_KEYS = [
  "SOURCE_BACKFILL_TARGET_COUNT",
  "STATUS_STANDALONE_REPAIR_COUNT",
  "SNAPSHOT_TARGET_KEY_COUNT",
  "SNAPSHOT_POST_BATCH_DELETE_COUNT",
  "SNAPSHOT_POST_BATCH_REQUEUE_COUNT",
  "V2_MATRIX_ROW_COUNT",
  "V2_NUMERIC_MUTATION_TARGET_COUNT",
  "V2_NON_NULL_FINGERPRINT_COUNT",
  "PROFIT_RM_EXPLICIT_TARGET_COUNT",
  "V6_JOB_SUCCESS_EXPECTED_COUNT",
  "SNAPSHOT_JOB_SUCCESS_EXPECTED_COUNT",
] as const;

export type WrapperApprovalBinding = {
  OWNER_APPROVAL_SHA256: string;
  OPERATION_ID: string;
  EXECUTE_MARKER: string;
  PRODUCTION_MUTATION: string;
  STAGE1B: string;
  EXECUTE_FROM_CACHE_OZON_NETWORK_CALL_COUNT: string;
} & Record<(typeof IMAGE_KEYS)[number], string> &
  Record<(typeof FILE_SHA_KEYS)[number], string> &
  Record<(typeof COUNT_KEYS)[number], string>;

/**
 * Projects a parsed approval onto the exact set of values the wrapper may use.
 *
 * The runner's own immutable projection is resolved alongside it, so an approval
 * the runner would refuse can never reach the deploy phase of the wrapper.
 */
export function resolveWrapperApprovalBinding(
  approval: OwnerApproval,
): WrapperApprovalBinding {
  // Refuse here too: the runner will refuse it later anyway, and discovering that
  // after the APP swap would cost a rollback for no reason.
  const immutable = resolveOwnerApprovalImmutableBinding(approval);

  const out: Record<string, string> = {
    OWNER_APPROVAL_SHA256: approval.sha256,
  };

  out.OPERATION_ID = requireShape(
    "OPERATION_ID",
    approval.get("OPERATION_ID"),
    SHELL_SAFE_TOKEN,
    "shell-safe token",
  );
  const marker = approval.get("EXECUTE_MARKER") ?? OWNER_EXECUTE_MARKER;
  if (marker !== OWNER_EXECUTE_MARKER) {
    fail(`EXECUTE_MARKER must be ${OWNER_EXECUTE_MARKER}`);
  }
  out.EXECUTE_MARKER = marker;

  for (const key of IMAGE_KEYS) {
    out[key] = requireShape(key, approval.get(key), IMAGE_ID, "sha256:<64 hex> image id");
  }
  for (const key of FILE_SHA_KEYS) {
    out[key] = requireShape(key, approval.get(key), HEX64, "64-hex sha256");
    if (BANNED_STALE_MANIFEST_SHA256.has(out[key])) {
      fail(`${key} pins a banned stale manifest sha ${out[key]}`);
    }
  }
  for (const key of COUNT_KEYS) {
    out[key] = requireShape(key, approval.get(key), INTEGER, "non-negative integer");
  }

  // The approval must not contradict itself. Each of these is also independently
  // enforced by the runner; disagreement here stops before the first docker call.
  const n = (key: string) => Number(out[key]);
  if (n("SOURCE_BACKFILL_TARGET_COUNT") !== immutable.sourceBackfillTargetCount) {
    fail("SOURCE_BACKFILL_TARGET_COUNT disagrees with the runner projection");
  }
  if (n("SOURCE_BACKFILL_TARGET_COUNT") !== 78) {
    fail(`SOURCE_BACKFILL_TARGET_COUNT must be 78, got ${out.SOURCE_BACKFILL_TARGET_COUNT}`);
  }
  if (n("STATUS_STANDALONE_REPAIR_COUNT") !== 10) {
    fail(`STATUS_STANDALONE_REPAIR_COUNT must be 10, got ${out.STATUS_STANDALONE_REPAIR_COUNT}`);
  }
  if (n("SNAPSHOT_TARGET_KEY_COUNT") !== 35) {
    fail(`SNAPSHOT_TARGET_KEY_COUNT must be 35, got ${out.SNAPSHOT_TARGET_KEY_COUNT}`);
  }
  if (
    n("SNAPSHOT_POST_BATCH_DELETE_COUNT") !== 35 ||
    n("SNAPSHOT_POST_BATCH_REQUEUE_COUNT") !== 35
  ) {
    fail("SNAPSHOT_POST_BATCH_DELETE_COUNT and _REQUEUE_COUNT must both be 35");
  }
  if (n("V2_NUMERIC_MUTATION_TARGET_COUNT") !== 2) {
    fail(`V2_NUMERIC_MUTATION_TARGET_COUNT must be 2, got ${out.V2_NUMERIC_MUTATION_TARGET_COUNT}`);
  }
  if (n("V2_MATRIX_ROW_COUNT") !== 6 || n("V2_NON_NULL_FINGERPRINT_COUNT") !== 6) {
    fail("V2_MATRIX_ROW_COUNT and V2_NON_NULL_FINGERPRINT_COUNT must both be 6");
  }
  if (n("PROFIT_RM_EXPLICIT_TARGET_COUNT") !== 0) {
    fail("PROFIT_RM_EXPLICIT_TARGET_COUNT must be 0");
  }
  // The post-mutation drain is polled as an exact count, so the approval has to
  // pin the same numbers the mutation scope already pins.
  if (n("V6_JOB_SUCCESS_EXPECTED_COUNT") !== n("V2_NUMERIC_MUTATION_TARGET_COUNT")) {
    fail("V6_JOB_SUCCESS_EXPECTED_COUNT must equal V2_NUMERIC_MUTATION_TARGET_COUNT");
  }
  if (n("SNAPSHOT_JOB_SUCCESS_EXPECTED_COUNT") !== n("SNAPSHOT_TARGET_KEY_COUNT")) {
    fail("SNAPSHOT_JOB_SUCCESS_EXPECTED_COUNT must equal SNAPSHOT_TARGET_KEY_COUNT");
  }
  if (out.MUTATION_TIME_APP_IMAGE_SHA256 !== out.CANDIDATE_APP_IMAGE_SHA256) {
    fail("MUTATION_TIME_APP_IMAGE_SHA256 must equal CANDIDATE_APP_IMAGE_SHA256");
  }

  const ozonCalls = requireShape(
    "EXECUTE_FROM_CACHE_OZON_NETWORK_CALL_COUNT",
    approval.get("EXECUTE_FROM_CACHE_OZON_NETWORK_CALL_COUNT"),
    INTEGER,
    "non-negative integer",
  );
  if (ozonCalls !== "0") {
    fail("EXECUTE_FROM_CACHE_OZON_NETWORK_CALL_COUNT must be 0");
  }
  out.EXECUTE_FROM_CACHE_OZON_NETWORK_CALL_COUNT = ozonCalls;

  const stage1b = approval.get("STAGE1B") ?? "NO";
  if (stage1b !== "NO") fail(`STAGE1B must be NO, got ${stage1b}`);
  out.STAGE1B = stage1b;

  // Reported, not judged: the wrapper decides whether a non-production approval is
  // acceptable for the phase it is about to run.
  out.PRODUCTION_MUTATION = requireShape(
    "PRODUCTION_MUTATION",
    approval.get("PRODUCTION_MUTATION"),
    SHELL_SAFE_TOKEN,
    "shell-safe token",
  );

  return Object.freeze(out) as WrapperApprovalBinding;
}

/* ------------------------------------------------------------------ *
 * Container swap specs
 * ------------------------------------------------------------------ */

export type SwapSpecBinding = {
  NAME: string;
  SPEC_IMAGE: string;
  NETWORK_MODE: string;
  RESTART_POLICY: string;
  RESTART_MAX_RETRY: string;
  USER: string;
  WORKING_DIR: string;
  ENTRYPOINT: string;
  CMD: string;
};

/**
 * Validates a `docker inspect`-derived swap spec and returns the recreate
 * arguments. Anything the wrapper cannot faithfully reproduce — a bind, a mount, a
 * published port, a healthcheck, a non-host network — is refused rather than
 * silently dropped, because a container recreated without them is not the
 * container the owner approved.
 */
export function resolveSwapSpecBinding(spec: Record<string, unknown>): SwapSpecBinding {
  const str = (key: string): string => {
    const value = spec[key];
    if (typeof value !== "string" || value === "") {
      fail(`swap spec key ${key} must be a non-empty string`);
    }
    return value;
  };
  const tokens = (key: string): string[] => {
    const value = spec[key];
    if (!Array.isArray(value) || value.length === 0) {
      fail(`swap spec key ${key} must be a non-empty array`);
    }
    return value.map((entry) => {
      if (typeof entry !== "string" || !SHELL_SAFE_TOKEN.test(entry)) {
        fail(`swap spec key ${key} contains a non shell-safe token: ${String(entry)}`);
      }
      return entry;
    });
  };

  const name = str("name");
  if (!SHELL_SAFE_TOKEN.test(name)) fail(`swap spec name is not shell-safe: ${name}`);
  const image = str("Image");
  if (!IMAGE_ID.test(image)) fail(`swap spec Image must be sha256:<64 hex>, got ${image}`);

  const networkMode = str("NetworkMode");
  if (networkMode !== "host") {
    fail(`swap spec NetworkMode must be host, got ${networkMode}`);
  }
  const restart = spec.RestartPolicy;
  if (!restart || typeof restart !== "object") fail("swap spec RestartPolicy is missing");
  const restartName = String((restart as { Name?: unknown }).Name ?? "");
  if (!SHELL_SAFE_TOKEN.test(restartName)) {
    fail(`swap spec RestartPolicy.Name is not shell-safe: ${restartName}`);
  }
  const restartMax = Number((restart as { MaximumRetryCount?: unknown }).MaximumRetryCount ?? 0);
  if (!Number.isInteger(restartMax) || restartMax < 0) {
    fail("swap spec RestartPolicy.MaximumRetryCount must be a non-negative integer");
  }

  const binds = spec.Binds;
  if (Array.isArray(binds) && binds.length > 0) {
    fail(`swap spec declares ${binds.length} Binds, which the wrapper cannot reproduce`);
  }
  const mounts = spec.Mounts;
  if (Array.isArray(mounts) && mounts.length > 0) {
    fail(`swap spec declares ${mounts.length} Mounts, which the wrapper cannot reproduce`);
  }
  const published = spec.publishedPorts;
  if (Array.isArray(published) && published.length > 0) {
    fail(`swap spec declares ${published.length} published ports on a host-network container`);
  }
  if (spec.Healthcheck !== null && spec.Healthcheck !== undefined) {
    fail("swap spec declares a Healthcheck, which the wrapper cannot reproduce");
  }
  if (spec.SECRET_VALUES_INCLUDED === true) {
    fail("swap spec carries secret values; reseal it with SECRET_VALUES_INCLUDED=false");
  }

  return Object.freeze({
    NAME: name,
    SPEC_IMAGE: image,
    NETWORK_MODE: networkMode,
    RESTART_POLICY: restartName,
    RESTART_MAX_RETRY: String(restartMax),
    USER: (() => {
      const user = str("User");
      if (!SHELL_SAFE_TOKEN.test(user)) fail(`swap spec User is not shell-safe: ${user}`);
      return user;
    })(),
    WORKING_DIR: (() => {
      const dir = str("WorkingDir");
      if (!SHELL_SAFE_TOKEN.test(dir)) fail(`swap spec WorkingDir is not shell-safe: ${dir}`);
      return dir;
    })(),
    ENTRYPOINT: tokens("Entrypoint").join(" "),
    CMD: tokens("Cmd").join(" "),
  });
}

/* ------------------------------------------------------------------ *
 * Emission
 * ------------------------------------------------------------------ */

/**
 * Bash reads this with `grep -m1 '^KEY='`, never with `source` or `eval`, so the
 * only requirement is that no value can break out of a single line.
 */
export function renderKeyValueFile(values: Record<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) fail(`refusing to emit malformed key ${key}`);
    if (/[\r\n]/.test(value)) fail(`refusing to emit multi-line value for ${key}`);
    lines.push(`${key}=${value}`);
  }
  return lines.join("\n") + "\n";
}

function parseArgs(argv: string[]): Record<string, string> {
  return Object.fromEntries(
    argv
      .filter((arg) => arg.startsWith("--") && arg.includes("="))
      .map((arg) => {
        const eq = arg.indexOf("=");
        return [arg.slice(2, eq), arg.slice(eq + 1)];
      }),
  );
}

export function runWrapperBindingCli(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  const mode = args.mode ?? "APPROVAL";
  const outPath = args.out ? resolve(args.out) : "";
  if (!outPath) fail("--out=<path> is required");
  mkdirSync(dirname(outPath), { recursive: true });

  if (mode === "APPROVAL") {
    const approvalPath = args.approvalFile
      ? resolve(args.approvalFile)
      : fail("--approvalFile=<path> is required");
    // The approval bytes at the operator-supplied path are the root of trust. A
    // supplied sha is only allowed to agree with them; it can never replace them.
    const approval = args.expectedSha256
      ? verifyAndParseOwnerApprovalFile({
          path: approvalPath,
          expectedSha256: args.expectedSha256,
        })
      : parseOwnerApprovalFile(approvalPath);
    const binding = resolveWrapperApprovalBinding(approval);
    writeFileSync(outPath, renderKeyValueFile(binding));
    if (args.jsonOut) {
      const jsonPath = resolve(args.jsonOut);
      mkdirSync(dirname(jsonPath), { recursive: true });
      const body =
        JSON.stringify(
          {
            OWNER_APPROVAL_WRAPPER_BINDING: "RESOLVED",
            approvalPath,
            approvalSha256: approval.sha256,
            parsedKeyCount: approval.keys.length,
            ignoredNonCriticalKeys: [...approval.ignoredKeys],
            binding,
          },
          null,
          2,
        ) + "\n";
      writeFileSync(jsonPath, body);
      writeFileSync(`${jsonPath}.sha256.txt`, sha256(body) + "\n");
    }
    console.log(`OWNER_APPROVAL_WRAPPER_BINDING=RESOLVED keys=${Object.keys(binding).length}`);
    return 0;
  }

  if (mode === "SWAP_SPEC") {
    const specPath = args.specFile ? resolve(args.specFile) : fail("--specFile=<path> is required");
    const spec = JSON.parse(readFileSync(specPath, "utf8")) as Record<string, unknown>;
    const binding = resolveSwapSpecBinding(spec);
    if (args.expectedName && binding.NAME !== args.expectedName) {
      fail(`swap spec is for ${binding.NAME}, expected ${args.expectedName}`);
    }
    if (args.expectedImage && binding.SPEC_IMAGE !== args.expectedImage) {
      fail(`swap spec pins image ${binding.SPEC_IMAGE}, approval pins ${args.expectedImage}`);
    }
    writeFileSync(outPath, renderKeyValueFile(binding));
    console.log(`SWAP_SPEC_BINDING=RESOLVED name=${binding.NAME}`);
    return 0;
  }

  fail(`unknown --mode=${mode}`);
}

const isDirect =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  Boolean(process.argv[1]) &&
  /resolveProductionWrapperBinding\.(ts|js|mjs|cjs)$/.test(
    String(process.argv[1]).replace(/\\/g, "/"),
  );
if (isDirect) {
  try {
    process.exit(runWrapperBindingCli());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
