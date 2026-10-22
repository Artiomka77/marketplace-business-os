import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "financial-core/v4/manifest.json"), "utf8"));
const digest = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

for (const row of manifest.protectedFiles || []) {
  const snapshot = path.join(root, "financial-core/v4/snapshot", row.path);
  if (!fs.existsSync(snapshot)) throw new Error(`Missing snapshot: ${row.path}`);
  const actual = digest(snapshot);
  if (actual !== row.snapshotSha256) throw new Error(`Snapshot hash mismatch: ${row.path}`);
}

for (const row of manifest.protectedFiles || []) {
  const snapshot = path.join(root, "financial-core/v4/snapshot", row.path);
  const target = path.join(root, row.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.financial-core-v4-restore-${process.pid}`;
  fs.copyFileSync(snapshot, temp);
  fs.renameSync(temp, target);
}

const check = spawnSync(process.execPath, [path.join(root, "scripts/financial-core/verify-financial-core-v4.mjs")], {
  cwd: root,
  stdio: "inherit",
});
if (check.status !== 0) process.exit(check.status ?? 1);
console.log("FINANCIAL CORE V4: RESTORED AND VERIFIED");
