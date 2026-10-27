import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const digest = (p) =>
  crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

const targets = [
  "lib/analytics/profitAnalyticsOzon.ts",
  "lib/telegram/dailyReport.ts",
];

for (const rel of targets) {
  const active = path.join(root, rel);
  const snap = path.join(root, "financial-core/v6/snapshot", rel);
  fs.copyFileSync(active, snap);
}

const manPath = path.join(root, "financial-core/v6/manifest.json");
const man = JSON.parse(fs.readFileSync(manPath, "utf8"));
for (const row of man.protectedFiles || []) {
  if (!targets.includes(row.path)) continue;
  const active = path.join(root, row.path);
  const hash = digest(active);
  const size = fs.statSync(active).size;
  row.sha256 = hash;
  row.snapshotSha256 = hash;
  row.activeSha256 = hash;
  row.sizeBytes = size;
  console.log(row.path, hash, size);
}
fs.writeFileSync(manPath, JSON.stringify(man, null, 2) + "\n");
console.log("RESEAL_OK");
