/**
 * Fail-closed contract for the production host wrapper.
 *
 * The wrapper cannot be executed here (it needs a production docker host), so the
 * properties that make it safe are asserted statically against its text, and the two
 * pure helpers it delegates every decision to are exercised directly:
 *
 * - the owner approval is the only authority; the environment supplies paths only
 * - PREPARE runs before anything is swapped
 * - all four candidate images are pinned and loaded
 * - the prepare-cache binding uses the sidecar CONTENT sha, never a file sha
 * - a VERIFY step can never be softened with `|| true`
 * - failure before the mutation restores the baseline; after it, RESUME_REQUIRED
 * - Telegram is deferred, never claimed as PASS from a marker file
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  evaluateDrainCounts,
} from "../financialRepair/pollRepairWorkerDrain";
import {
  BANNED_STALE_MANIFEST_SHA256,
  resolveSwapSpecBinding,
  resolveWrapperApprovalBinding,
} from "../financialRepair/resolveProductionWrapperBinding";
import {
  parseOwnerApprovalText,
  OWNER_EXECUTE_MARKER,
} from "../../lib/ozon/ownerApprovalBinding";

const WRAPPER_PATH = join(
  process.cwd(),
  "scripts",
  "financialRepair",
  "runApprovedFinancialRepairProduction.sh",
);
const WRAPPER = readFileSync(WRAPPER_PATH, "utf8");
const DOCKERFILE = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");

function hex(seed: string): string {
  // Deterministic 64-hex stand-in; shape is what the binder validates.
  let out = "";
  for (let i = 0; out.length < 64; i += 1) {
    out += Buffer.from(`${seed}:${i}`).toString("hex");
  }
  return out.slice(0, 64);
}
const imageId = (seed: string) => `sha256:${hex(seed)}`;

function approvalFixture(overrides: Record<string, string> = {}): string {
  const values: Record<string, string> = {
    STAMP: "20260925_1200",
    OPERATION_ID: "OP_TRUE_RUNTIME_CLOSURE_20260925",
    EXECUTE_MARKER: OWNER_EXECUTE_MARKER,

    PRE_DEPLOY_CURRENT_APP_IMAGE_SHA256: imageId("app-pre"),
    CANDIDATE_APP_IMAGE_SHA256: imageId("app-candidate"),
    ROLLBACK_APP_IMAGE_SHA256: imageId("app-pre"),
    MUTATION_TIME_APP_IMAGE_SHA256: imageId("app-candidate"),
    CANDIDATE_REPAIR_RUNNER_IMAGE_SHA256: imageId("runner"),
    PRE_DEPLOY_CURRENT_V6_WORKER_IMAGE_SHA256: imageId("v6-pre"),
    CANDIDATE_V6_WORKER_IMAGE_SHA256: imageId("v6-candidate"),
    ROLLBACK_V6_WORKER_IMAGE_SHA256: imageId("v6-pre"),
    PRE_DEPLOY_CURRENT_DASHBOARD_WORKER_IMAGE_SHA256: imageId("dash-pre"),
    CANDIDATE_DASHBOARD_WORKER_IMAGE_SHA256: imageId("dash-candidate"),
    ROLLBACK_DASHBOARD_WORKER_IMAGE_SHA256: imageId("dash-pre"),

    APP_SWAP_SPEC_SHA256: hex("app-spec"),
    V6_WORKER_SWAP_SPEC_SHA256: hex("v6-spec"),
    DASHBOARD_WORKER_SWAP_SPEC_SHA256: hex("dash-spec"),
    APP_IMAGE_TAR_SHA256: hex("app-tar"),
    REPAIR_RUNNER_IMAGE_TAR_SHA256: hex("runner-tar"),
    V6_WORKER_IMAGE_TAR_SHA256: hex("v6-tar"),
    DASHBOARD_WORKER_IMAGE_TAR_SHA256: hex("dash-tar"),

    SOURCE_BACKFILL_MANIFEST_SHA256: hex("source-manifest"),
    SOURCE_BACKFILL_TARGET_COUNT: "78",
    STATUS_ONLY_MANIFEST_SHA256: hex("status-manifest"),
    STATUS_STANDALONE_REPAIR_COUNT: "10",
    SNAPSHOT_POST_BATCH_MANIFEST_SHA256: hex("snapshot-manifest"),
    SNAPSHOT_TARGET_KEY_COUNT: "35",
    SNAPSHOT_POST_BATCH_DELETE_COUNT: "35",
    SNAPSHOT_POST_BATCH_REQUEUE_COUNT: "35",
    V2_POST_BATCH_MANIFEST_SHA256: hex("v2-manifest"),
    V2_MATRIX_ROW_COUNT: "6",
    V2_NUMERIC_MUTATION_TARGET_COUNT: "2",
    V2_NONMUTATED_UNAVAILABLE_ROW_COUNT: "4",
    V2_NON_NULL_FINGERPRINT_COUNT: "6",
    PROFIT_RM_EXPLICIT_TARGET_COUNT: "0",
    V6_JOB_SUCCESS_EXPECTED_COUNT: "2",
    SNAPSHOT_JOB_SUCCESS_EXPECTED_COUNT: "35",

    EXECUTE_FROM_CACHE_OZON_NETWORK_CALL_COUNT: "0",
    PRODUCTION_MUTATION: "YES",
    STAGE1B: "NO",
    ...overrides,
  };
  return [
    "AVOROFIN FINANCIAL PRODUCTION EXECUTION OWNER APPROVAL",
    ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
    "",
  ].join("\n");
}

const bind = (overrides: Record<string, string> = {}) =>
  resolveWrapperApprovalBinding(parseOwnerApprovalText(approvalFixture(overrides)));

/* ------------------------------------------------------------------ *
 * Approval is the only authority
 * ------------------------------------------------------------------ */

test("WRAPPER BINDING: every acted-on value comes from the approval", () => {
  const binding = bind();
  assert.equal(binding.SOURCE_BACKFILL_TARGET_COUNT, "78");
  assert.equal(binding.STATUS_STANDALONE_REPAIR_COUNT, "10");
  assert.equal(binding.SNAPSHOT_JOB_SUCCESS_EXPECTED_COUNT, "35");
  assert.equal(binding.V6_JOB_SUCCESS_EXPECTED_COUNT, "2");
  assert.equal(binding.PRODUCTION_MUTATION, "YES");
  assert.match(binding.OWNER_APPROVAL_SHA256, /^[0-9a-f]{64}$/);
  assert.match(binding.CANDIDATE_V6_WORKER_IMAGE_SHA256, /^sha256:[0-9a-f]{64}$/);
  assert.match(binding.CANDIDATE_DASHBOARD_WORKER_IMAGE_SHA256, /^sha256:[0-9a-f]{64}$/);
});

test("WRAPPER BINDING: refuses every way the approval can disagree with itself", () => {
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{ SOURCE_BACKFILL_TARGET_COUNT: "79" }, /SOURCE_BACKFILL_TARGET_COUNT/],
    [{ STATUS_STANDALONE_REPAIR_COUNT: "9" }, /STATUS_STANDALONE_REPAIR_COUNT must be 10/],
    [{ SNAPSHOT_JOB_SUCCESS_EXPECTED_COUNT: "34" }, /SNAPSHOT_JOB_SUCCESS_EXPECTED_COUNT/],
    [{ V6_JOB_SUCCESS_EXPECTED_COUNT: "3" }, /V6_JOB_SUCCESS_EXPECTED_COUNT/],
    [{ PROFIT_RM_EXPLICIT_TARGET_COUNT: "1" }, /PROFIT_RM_EXPLICIT_TARGET_COUNT must be 0/],
    [{ EXECUTE_FROM_CACHE_OZON_NETWORK_CALL_COUNT: "1" }, /must be 0/],
    [{ STAGE1B: "YES" }, /STAGE1B must be NO/],
    [{ MUTATION_TIME_APP_IMAGE_SHA256: imageId("someone-else") }, /MUTATION_TIME_APP_IMAGE_SHA256/],
    [{ CANDIDATE_V6_WORKER_IMAGE_SHA256: "latest" }, /CANDIDATE_V6_WORKER_IMAGE_SHA256/],
    [{ V6_WORKER_IMAGE_TAR_SHA256: "not-a-sha" }, /V6_WORKER_IMAGE_TAR_SHA256/],
    [{ OPERATION_ID: "op id with spaces" }, /OPERATION_ID/],
  ];
  for (const [overrides, expected] of cases) {
    assert.throws(() => bind(overrides), expected, JSON.stringify(overrides));
  }
});

test("WRAPPER BINDING: the stale pre-correction manifest sha stays banned", () => {
  const [banned] = [...BANNED_STALE_MANIFEST_SHA256];
  assert.match(banned, /^[0-9a-f]{64}$/);
  assert.throws(
    () => bind({ SOURCE_BACKFILL_MANIFEST_SHA256: banned }),
    /banned stale manifest sha/,
  );
});

test("WRAPPER BINDING: a missing worker key is a refusal, not a default", () => {
  const text = approvalFixture()
    .split("\n")
    .filter((line) => !line.startsWith("CANDIDATE_V6_WORKER_IMAGE_SHA256="))
    .join("\n");
  assert.throws(
    () => resolveWrapperApprovalBinding(parseOwnerApprovalText(text)),
    /missing required key CANDIDATE_V6_WORKER_IMAGE_SHA256/,
  );
});

/* ------------------------------------------------------------------ *
 * Swap specs
 * ------------------------------------------------------------------ */

const APP_SPEC = {
  name: "avorofin-app",
  Image: imageId("app-pre"),
  Entrypoint: ["docker-entrypoint.sh"],
  Cmd: ["node", "server.js"],
  User: "nextjs",
  WorkingDir: "/app",
  RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
  NetworkMode: "host",
  Binds: null,
  Mounts: [],
  publishedPorts: [],
  Healthcheck: null,
  SECRET_VALUES_INCLUDED: false,
} as Record<string, unknown>;

test("SWAP SPEC: the production APP spec resolves to exact recreate arguments", () => {
  const spec = resolveSwapSpecBinding(APP_SPEC);
  assert.deepEqual(spec, {
    NAME: "avorofin-app",
    SPEC_IMAGE: imageId("app-pre"),
    NETWORK_MODE: "host",
    RESTART_POLICY: "unless-stopped",
    RESTART_MAX_RETRY: "0",
    USER: "nextjs",
    WORKING_DIR: "/app",
    ENTRYPOINT: "docker-entrypoint.sh",
    CMD: "node server.js",
  });
});

test("SWAP SPEC: anything the wrapper cannot reproduce is refused, not dropped", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ Binds: ["/host:/container"] }, /Binds/],
    [{ Mounts: [{ Source: "/host" }] }, /Mounts/],
    [{ publishedPorts: ["3000/tcp"] }, /published ports/],
    [{ Healthcheck: { Test: ["CMD", "true"] } }, /Healthcheck/],
    [{ NetworkMode: "bridge" }, /NetworkMode must be host/],
    [{ Image: "avorofin:latest" }, /Image must be sha256/],
    [{ SECRET_VALUES_INCLUDED: true }, /secret values/],
    [{ Cmd: ["node", "server.js; rm -rf /"] }, /non shell-safe token/],
    [{ Entrypoint: [] }, /non-empty array/],
  ];
  for (const [overrides, expected] of cases) {
    assert.throws(
      () => resolveSwapSpecBinding({ ...APP_SPEC, ...overrides }),
      expected,
      JSON.stringify(overrides),
    );
  }
});

test("SWAP SPEC: a spec for the wrong container or image is refused", () => {
  assert.throws(
    () => resolveSwapSpecBinding({ ...APP_SPEC, name: "avorofin-app; touch /tmp/x" }),
    /not shell-safe/,
  );
});

/* ------------------------------------------------------------------ *
 * Worker drain
 * ------------------------------------------------------------------ */

test("WORKER DRAIN: settles only on exactly 2 and 35 SUCCESS jobs", () => {
  const v6 = evaluateDrainCounts({
    formulaVersion: "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2",
    expectedSuccess: 2,
    rows: [{ status: "SUCCESS", count: 2 }],
  });
  assert.equal(v6.settled, true);
  assert.deepEqual(v6.failures, []);

  const snapshot = evaluateDrainCounts({
    formulaVersion: "FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1",
    expectedSuccess: 35,
    rows: [{ status: "SUCCESS", count: 35 }],
  });
  assert.equal(snapshot.settled, true);

  // Still draining: not settled, but not a failure either.
  const draining = evaluateDrainCounts({
    formulaVersion: "FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1",
    expectedSuccess: 35,
    rows: [
      { status: "SUCCESS", count: 20 },
      { status: "PENDING", count: 15 },
    ],
  });
  assert.equal(draining.settled, false);
  assert.deepEqual(draining.failures, []);
});

test("WORKER DRAIN: a surplus, an ERROR or an unknown status is a hard failure", () => {
  const surplus = evaluateDrainCounts({
    formulaVersion: "V6",
    expectedSuccess: 2,
    rows: [{ status: "SUCCESS", count: 3 }],
  });
  assert.equal(surplus.settled, false);
  assert.match(surplus.failures.join(" "), /expected exactly 2/);

  const errored = evaluateDrainCounts({
    formulaVersion: "V4",
    expectedSuccess: 35,
    rows: [
      { status: "SUCCESS", count: 34 },
      { status: "ERROR", count: 1 },
    ],
  });
  assert.equal(errored.settled, false);
  assert.match(errored.failures.join(" "), /1 ERROR jobs/);

  const unknown = evaluateDrainCounts({
    formulaVersion: "V4",
    expectedSuccess: 35,
    rows: [
      { status: "SUCCESS", count: 35 },
      { status: "CANCELLED", count: 1 },
    ],
  });
  assert.equal(unknown.settled, false);
  assert.match(unknown.failures.join(" "), /unexpected status/);
});

/* ------------------------------------------------------------------ *
 * Wrapper text contract
 * ------------------------------------------------------------------ */

test("WRAPPER: single-writer lock is taken with flock -n", () => {
  assert.match(WRAPPER, /LOCK_FILE="\/tmp\/avorofin-financial-repair\.lock"/);
  assert.match(WRAPPER, /flock -n 9 \|\| die/);
});

test("WRAPPER: the environment supplies paths only, never hashes or counts", () => {
  const required = [...WRAPPER.matchAll(/^:\s*"\$\{([A-Z0-9_]+):/gm)].map((m) => m[1]);
  assert.ok(required.length >= 12, `expected the path contract to be declared, got ${required}`);
  for (const name of required) {
    assert.doesNotMatch(
      name,
      /SHA256|COUNT|MARKER|OPERATION_ID|IMAGE$/,
      `${name} must come from the owner approval, not the environment`,
    );
    assert.match(
      name,
      /(FILE|MANIFEST|SPEC|TAR)$/,
      `${name} does not look like a path input`,
    );
  }
});

test("WRAPPER: the approval is parsed by the node helper, never sourced or eval'd", () => {
  assert.match(WRAPPER, /resolveProductionWrapperBinding\.ts/);
  assert.match(WRAPPER, /--mode=APPROVAL/);
  assert.doesNotMatch(WRAPPER, /\beval\b/);
  assert.doesNotMatch(WRAPPER, /source "\$OWNER_APPROVAL_FILE"/);
  assert.doesNotMatch(WRAPPER, /\.\s+"\$OWNER_APPROVAL_FILE"/);
});

test("WRAPPER: PREPARE runs before anything is swapped", () => {
  const prepare = WRAPPER.indexOf("--mode=PREPARE");
  const deploy = WRAPPER.indexOf('swap_role "$APP_SPEC_ENV"');
  const execute = WRAPPER.indexOf("--mode=EXECUTE_FROM_CACHE");
  assert.ok(prepare > 0 && deploy > 0 && execute > 0);
  assert.ok(prepare < deploy, "PREPARE must precede the APP/worker swap");
  assert.ok(deploy < execute, "the swap must precede EXECUTE");
});

test("WRAPPER: all four candidate images are pinned, loaded and identity-checked", () => {
  for (const key of [
    "CANDIDATE_APP_IMAGE_SHA256",
    "CANDIDATE_REPAIR_RUNNER_IMAGE_SHA256",
    "CANDIDATE_V6_WORKER_IMAGE_SHA256",
    "CANDIDATE_DASHBOARD_WORKER_IMAGE_SHA256",
  ]) {
    assert.ok(WRAPPER.includes(key), `${key} is not resolved from the approval`);
  }
  for (const tar of [
    "APP_IMAGE_TAR",
    "REPAIR_RUNNER_IMAGE_TAR",
    "V6_WORKER_IMAGE_TAR",
    "DASHBOARD_WORKER_IMAGE_TAR",
  ]) {
    assert.match(
      WRAPPER,
      new RegExp(`load_image_tar "\\$${tar}"`),
      `${tar} is never loaded`,
    );
  }
});

test("WRAPPER: each manifest file is mounted directly at its own path", () => {
  for (const [variable, mount] of [
    ["SOURCE_MANIFEST", "/manifests/source.json"],
    ["STATUS_MANIFEST", "/manifests/status.json"],
    ["SNAPSHOT_MANIFEST", "/manifests/snapshot.json"],
    ["V2_MANIFEST", "/manifests/v2.json"],
  ] as const) {
    assert.ok(
      WRAPPER.includes(`-v "$${variable}:${mount}:ro"`),
      `${variable} is not mounted read-only at ${mount}`,
    );
  }
});

test("WRAPPER: the prepare-cache binding is the sidecar CONTENT sha", () => {
  assert.match(WRAPPER, /PREPARE_CACHE_CONTENT_SHA256="\$\(tr -d[^)]*PREPARE_CACHE_SIDECAR"\)"/);
  assert.match(WRAPPER, /--prepareCacheManifestSha256="\$PREPARE_CACHE_CONTENT_SHA256"/);
  // Both self-accepting bindings are explicitly refused.
  assert.match(WRAPPER, /sidecar text equals the sidecar file sha/);
  assert.match(WRAPPER, /not the byte sha of PREPARE_CACHE\.json/);
});

test("WRAPPER: no critical step is softened with || true", () => {
  assert.doesNotMatch(WRAPPER, /\|\|\s*true/);
});

test("WRAPPER: every runner phase is invoked and failure is fatal", () => {
  for (const mode of [
    "PREPARE",
    "EXECUTE_FROM_CACHE",
    "VERIFY_MUTATION_POSTCONDITIONS",
    "VERIFY_FINAL_FINANCIAL_OUTPUT",
  ]) {
    assert.ok(WRAPPER.includes(`--mode=${mode}`), `${mode} is never run`);
  }
  for (const failure of [
    'die "PREPARE failed"',
    'die "VERIFY_MUTATION_POSTCONDITIONS failed"',
    'die "VERIFY_FINAL_FINANCIAL_OUTPUT failed"',
  ]) {
    assert.ok(WRAPPER.includes(failure), `missing fatal handling: ${failure}`);
  }
});

test("WRAPPER: the drain is polled for exact approved SUCCESS counts", () => {
  assert.match(WRAPPER, /pollRepairWorkerDrain\.ts/);
  assert.match(WRAPPER, /--v6ExpectedSuccess="\$V6_JOB_SUCCESS_EXPECTED_COUNT"/);
  assert.match(
    WRAPPER,
    /--snapshotExpectedSuccess="\$SNAPSHOT_JOB_SUCCESS_EXPECTED_COUNT"/,
  );
  const drain = WRAPPER.indexOf("--v6ExpectedSuccess=");
  const stage1 = WRAPPER.indexOf("--mode=VERIFY_MUTATION_POSTCONDITIONS");
  const stage2 = WRAPPER.indexOf("--mode=VERIFY_FINAL_FINANCIAL_OUTPUT");
  assert.ok(stage1 < drain, "stage 1 VERIFY must run before the workers are started");
  assert.ok(drain < stage2, "the final output VERIFY must run after the drain");
});

test("WRAPPER: the failure trap is phase-aware", () => {
  assert.match(WRAPPER, /MUTATION_WINDOW_ENTERED=1/);
  assert.match(WRAPPER, /write_resume_required/);
  assert.match(WRAPPER, /restore_baseline_after_prefailure/);
  assert.match(WRAPPER, /"RESUME_REQUIRED": "YES"/);
  assert.match(WRAPPER, /"FAILED_BEFORE_DB_MUTATION": "YES"/);
  // A failure inside the mutation window may only be downgraded on the runner's own
  // zero-writes marker.
  assert.match(WRAPPER, /execute_failed_before_mutation/);
  assert.match(WRAPPER, /WRITES_PERFORMED=0/);
});

test("WRAPPER: Telegram is deferred and never claimed as PASS from a marker", () => {
  assert.match(WRAPPER, /TELEGRAM_NOSEND_STEP=DEFERRED_SECOND_HOST_ORCHESTRATION/);
  assert.match(WRAPPER, /"TELEGRAM_REPORT_PASS_CLAIMED": "NO"/);
  assert.doesNotMatch(WRAPPER, /TELEGRAM_SEND_FALSE\.txt/);
  assert.doesNotMatch(WRAPPER, /TELEGRAM_SEND=false/);
});

test("WRAPPER: the July/August canary plan is authenticated and not executed", () => {
  assert.match(WRAPPER, /JULY_AUGUST_AUTHENTICATED_CANARY_PLAN\.json/);
  assert.match(WRAPPER, /LOCAL_AUTH_SESSION_COOKIE/);
  assert.match(WRAPPER, /avorofin_local_auth/);
  assert.match(WRAPPER, /"ANONYMOUS_PROBE_ACCEPTED": "NO"/);
  assert.match(WRAPPER, /"EXECUTED": "NO"/);
  assert.match(WRAPPER, /refusing to plan a canary from a VERIFY result that did not pass/);
});

test("WRAPPER: no placeholder is left in the production path", () => {
  // mktemp templates legitimately contain X runs, so only real markers are checked.
  for (const pattern of [/TODO/, /FIXME/, /PLACEHOLDER/, /REPLACE_ME/, /\bTBD\b/, /\bstub\b/]) {
    assert.doesNotMatch(WRAPPER, pattern, `wrapper still contains ${pattern}`);
  }
});

/* ------------------------------------------------------------------ *
 * Dockerfile targets
 * ------------------------------------------------------------------ */

test("DOCKERFILE: all four repair-relevant build targets exist", () => {
  for (const target of [
    "financial-repair-runner",
    "v6-period-readmodel-worker",
    "dashboard-period-snapshot-worker",
  ]) {
    assert.match(
      DOCKERFILE,
      new RegExp(`^FROM builder AS ${target}$`, "m"),
      `missing build target ${target}`,
    );
  }
  assert.match(DOCKERFILE, /^FROM base AS runner$/m, "the default APP target is missing");
});

test("DOCKERFILE: the worker targets fail closed on their own entrypoints", () => {
  assert.match(DOCKERFILE, /test -f scripts\/dashboard\/runV6PeriodReadModelWorker\.ts/);
  assert.match(DOCKERFILE, /test -f lib\/dashboard\/v6PeriodReadModel\/producer\.ts/);
  assert.match(
    DOCKERFILE,
    /CMD \["node", "--import", "tsx", "scripts\/dashboard\/runV6PeriodReadModelWorker\.ts"\]/,
  );
  assert.match(
    DOCKERFILE,
    /test -f scripts\/financialRepair\/resolveProductionWrapperBinding\.ts/,
  );
  assert.match(DOCKERFILE, /test -f scripts\/financialRepair\/pollRepairWorkerDrain\.ts/);
});
