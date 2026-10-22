import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = path.join(root, "financial-core/v5/manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const digest = (filePath) =>
  crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

for (const row of manifest.protectedFiles || []) {
  const snapshot = path.join(root, "financial-core/v5/snapshot", row.path);
  if (!fs.existsSync(snapshot)) throw new Error(`Missing snapshot: ${row.path}`);
  const actual = digest(snapshot);
  if (actual !== row.snapshotSha256) throw new Error(`Snapshot hash mismatch: ${row.path}`);
}

for (const row of manifest.protectedFiles || []) {
  const snapshot = path.join(root, "financial-core/v5/snapshot", row.path);
  const target = path.join(root, row.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.financial-core-v5-restore-${process.pid}`;
  fs.copyFileSync(snapshot, temp);
  fs.renameSync(temp, target);
}

const packagePath = path.join(root, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
packageJson.scripts ||= {};
for (const [name, value] of Object.entries(manifest.packageScriptContract || {})) {
  packageJson.scripts[name] = value;
}
fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + "\n", "utf8");

const check = spawnSync(process.execPath, [path.join(root, "scripts/financial-core/verify-financial-core-v5.mjs")], {
  cwd: root,
  stdio: "inherit",
});
if (check.status !== 0) process.exit(check.status ?? 1);
console.log("FINANCIAL CORE V5: RESTORED AND VERIFIED");
