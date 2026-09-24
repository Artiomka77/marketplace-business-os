import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const failures = [];

function rel(filePath) {
  return path.relative(root, filePath).replaceAll("\\", "/");
}

function mustExist(filePath) {
  if (!fs.existsSync(filePath)) {
    failures.push(`missing required file: ${rel(filePath)}`);
  }
}

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

const requiredFiles = [
  "proxy.ts",
  "prisma.config.ts",
  "scripts/dashboard/runDashboardPeriodSnapshotWorker.ts",
  "lib/dashboard/periodSnapshot.ts",
  "app/api/cron/sync-ozon-accruals/route.ts",
  "app/api/cron/auth-probe/route.ts",
  "lib/ozon/accrualByDay.ts",
  "lib/ozon/syncOzonAccrualByDay.ts",
  "lib/security/cronAuth.ts",
];
for (const file of requiredFiles) mustExist(path.join(root, file));

const schema = fs.existsSync(path.join(root, "prisma/schema.prisma"))
  ? read(path.join(root, "prisma/schema.prisma"))
  : "";
for (const model of [
  "OzonFinancialCategoryFact",
  "DashboardPeriodSnapshot",
  "DashboardPeriodSnapshotJob",
]) {
  if (!schema.includes(`model ${model}`)) {
    failures.push(`prisma model missing: ${model}`);
  }
}

const dockerfile = fs.existsSync(path.join(root, "Dockerfile"))
  ? read(path.join(root, "Dockerfile"))
  : "";
for (const needle of [
  "AS runner",
  "AS stock-abc-worker",
  "AS dashboard-period-snapshot-worker",
  "app/api/cron/sync-ozon-accruals/route.ts",
  "sync-ozon-accruals/route.js",
]) {
  if (!dockerfile.includes(needle)) {
    failures.push(`Dockerfile missing required contract: ${needle}`);
  }
}
if (
  dockerfile.includes(
    'CMD ["node", "--import", "tsx", "scripts/stocks/refreshStockAbcSnapshots.ts"]'
  ) === false
) {
  failures.push("stock-abc-worker CMD changed");
}

const cronRoutes = walk(path.join(root, "app/api/cron")).filter((file) =>
  file.endsWith(`${path.sep}route.ts`)
);
if (cronRoutes.length !== 24) {
  failures.push(`expected 24 cron routes, found ${cronRoutes.length}`);
}

const probeRel = "app/api/cron/auth-probe/route.ts";
const sideEffectMarkers = [
  "prisma.",
  "syncWb",
  "syncOzon",
  "buildDailyReport",
  "updateMany(",
  "runCurrentPrioritySync",
  "retryMissingOzonReportAds",
  "syncMarketplaceDailyOrders",
];
const probeForbidden = [
  "@/lib/prisma",
  "prisma.",
  "syncWb",
  "syncOzon",
  "sendTelegram",
  "buildDailyReport",
  "runCurrentPrioritySync",
  "runNextHistoricalSyncJob",
  "retryMissingOzonReportAds",
  "syncMarketplaceDailyOrders",
  "historicalSync",
  "writeFile",
];

let probeCount = 0;
for (const file of cronRoutes) {
  const text = read(file);
  const fileRel = rel(file);
  const isProbe = fileRel === probeRel;
  if (isProbe) probeCount += 1;
  if (!text.includes('from "@/lib/security/cronAuth"')) {
    failures.push(`cron auth import missing: ${fileRel}`);
  }
  const getIdx = text.indexOf("export async function GET");
  if (getIdx < 0) {
    failures.push(`GET handler missing: ${fileRel}`);
    continue;
  }
  const guardIdx = text.indexOf("rejectUnauthorizedCron", getIdx);
  if (guardIdx < 0) {
    failures.push(`cron auth guard missing in GET: ${fileRel}`);
    continue;
  }
  for (const marker of sideEffectMarkers) {
    const markerIdx = text.indexOf(marker, getIdx);
    if (markerIdx >= 0 && markerIdx < guardIdx) {
      failures.push(`side-effect ${marker} before auth in ${fileRel}`);
    }
  }
  if (isProbe) {
    for (const needle of probeForbidden) {
      if (text.includes(needle)) {
        failures.push(`auth-probe is not READ_ONLY_PROBE: contains ${needle}`);
      }
    }
    if (!text.includes('probe: "cron-auth"')) {
      failures.push("auth-probe missing authorized JSON contract");
    }
  }
}
if (probeCount !== 1) {
  failures.push(`READ_ONLY_PROBE count expected 1, found ${probeCount}`);
}

const vercel = crypto
  .createHash("sha256")
  .update(fs.readFileSync(path.join(root, "vercel.json")))
  .digest("hex");
if (vercel !== "c6261956395517d77975f76e1f4fd6712af6f18bfc05eb8b395d611b5e70d1a0") {
  failures.push("vercel.json hash changed");
}

if (failures.length) {
  console.error("RELEASE SURFACE: FAILED");
  for (const failure of failures) console.error("- " + failure);
  process.exit(1);
}

console.log(
  `RELEASE SURFACE: PASS (${cronRoutes.length}/24 cron routes guarded; READ_ONLY_PROBE=1)`
);
