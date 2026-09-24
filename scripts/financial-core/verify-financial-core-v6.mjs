import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = path.join(root, "financial-core/v6/manifest.json");
const failures = [];
const digest = (filePath) =>
  crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

if (!fs.existsSync(manifestPath)) {
  console.error("FINANCIAL CORE V6: FAILED");
  console.error("- missing financial-core/v6/manifest.json");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.version !== "financial-core-v6") {
  failures.push(`unexpected version: ${manifest.version}`);
}
if (manifest.parentVersion !== "financial-core-v5") {
  failures.push(`unexpected parent: ${manifest.parentVersion}`);
}
if (manifest.status !== "LOCAL_CANDIDATE_SERVER_VERIFY_REQUIRED") {
  failures.push(`unsafe candidate status: ${manifest.status}`);
}
if (
  manifest.policy?.closedWeekProfit !==
  "CANONICAL_PNL_SETTLEMENT_MINUS_CANONICAL_COGS_MINUS_TAXES_MINUS_EXTERNAL_PNL_COSTS"
) {
  failures.push(`unsafe closed-week profit policy: ${manifest.policy?.closedWeekProfit}`);
}
if (
  manifest.policy?.officialCashSettlement !==
  "WB_FINANCE_TOTAL_TO_PAY_RECONCILIATION_ONLY"
) {
  failures.push("totalToPay is not constrained to cash reconciliation");
}
if (
  manifest.policy?.closedPeriodSourceOwnership !==
  "EXACT_FINANCE_REPORT_SESSIONS_THEN_COMPLETE_DAILY_FINANCE_SESSIONS" ||
  manifest.policy?.ownedReportRows !==
  "ALL_SESSION_ROWS_NO_SALE_DATE_RESLICE"
) {
  failures.push("REV4 source ownership policy is missing");
}
if (
  manifest.policy?.productOperationClassifier !==
  "SHARED_PAYMENT_REASON_OR_DOCUMENT_TYPE_SALE_RETURN_OTHER"
) {
  failures.push("REV4.1 shared product-operation policy is missing");
}

for (const row of manifest.protectedFiles || []) {
  const active = path.join(root, row.path);
  const snapshot = path.join(root, "financial-core/v6/snapshot", row.path);
  if (!fs.existsSync(active) || !fs.existsSync(snapshot)) {
    failures.push(`missing protected file or snapshot: ${row.path}`);
    continue;
  }
  const activeHash = digest(active);
  const snapshotHash = digest(snapshot);
  if (activeHash !== row.sha256) failures.push(`active hash: ${row.path}`);
  if (snapshotHash !== row.snapshotSha256) {
    failures.push(`snapshot hash: ${row.path}`);
  }
  if (activeHash !== snapshotHash) failures.push(`divergence: ${row.path}`);
}

for (const contract of manifest.consumerContracts || []) {
  const file = path.join(root, contract.path);
  if (!fs.existsSync(file)) {
    failures.push(`missing consumer: ${contract.path}`);
    continue;
  }
  const text = fs.readFileSync(file, "utf8");
  for (const marker of contract.requiredPatterns || []) {
    if (!text.includes(marker)) {
      failures.push(`missing consumer marker ${contract.path}: ${marker}`);
    }
  }
  for (const marker of contract.forbiddenPatterns || []) {
    if (text.includes(marker)) {
      failures.push(`forbidden consumer marker ${contract.path}: ${marker}`);
    }
  }
}

const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8")
);
for (const [name, expected] of Object.entries(
  manifest.packageScriptContract || {}
)) {
  if (packageJson.scripts?.[name] !== expected) {
    failures.push(`package script ${name}: ${packageJson.scripts?.[name]}`);
  }
}

const v5Manifest = JSON.parse(
  fs.readFileSync(path.join(root, "financial-core/v5/manifest.json"), "utf8")
);
const v5Ozon = v5Manifest.protectedFiles.find(
  (row) => row.path === "lib/analytics/profitAnalyticsOzon.ts"
);
if (
  !v5Ozon ||
  digest(path.join(root, "lib/analytics/profitAnalyticsOzon.ts")) !==
    v5Ozon.sha256
) {
  failures.push("Ozon financial logic differs from Financial Core V5");
}

const checks = [
  {
    command: process.execPath,
    args: [path.join(root, "scripts/wb/verify-wb-official-finance-priority.mjs")],
    marker: "WB_OFFICIAL_FINANCE_PRIORITY_V1: VERIFIED",
    label: "V5 official WB finance priority",
  },
  {
    command: process.execPath,
    args: [
      path.join(root, "node_modules/tsx/dist/cli.mjs"),
      path.join(root, "scripts/wb/verify-wb-financial-core-v6.ts"),
    ],
    marker: "CURSOR_V6_REV5_1_READY_FOR_CHATGPT_REVIEW",
    label: "V6 revision-5.1 narrow delta guard",
  },
];

for (const check of checks) {
  const result = spawnSync(check.command, check.args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0 || !output.includes(check.marker)) {
    failures.push(`${check.label}: ${output.trim() || "failed"}`);
  }
}

if (failures.length > 0) {
  console.error("FINANCIAL CORE V6: FAILED");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `FINANCIAL CORE V6 LOCAL CANDIDATE: VERIFIED (${manifest.protectedFiles.length} protected files, SERVER VERIFY REQUIRED)`
);
