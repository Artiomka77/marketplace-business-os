import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const manifestPath = path.join(root, "financial-core", "v3", "manifest.json");

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

if (!fs.existsSync(manifestPath)) {
  throw new Error("financial-core/v3/manifest.json is missing.");
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const restoreRoot = path.join(
  root,
  "backups",
  `financial-core-v3-restore-${new Date().toISOString().replaceAll(":", "-")}`
);

for (const entry of manifest.protectedFiles ?? []) {
  const currentPath = path.join(root, entry.path);
  const snapshotPath = path.join(root, "financial-core", "v3", "snapshot", entry.path);
  if (!fs.existsSync(snapshotPath)) throw new Error(`Snapshot is missing: ${entry.path}`);
  if (sha256(snapshotPath) !== entry.sha256) {
    throw new Error(`Snapshot hash mismatch: ${entry.path}`);
  }
  if (fs.existsSync(currentPath)) {
    const backupPath = path.join(restoreRoot, entry.path);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(currentPath, backupPath);
  }
  fs.mkdirSync(path.dirname(currentPath), { recursive: true });
  fs.copyFileSync(snapshotPath, currentPath);
}

execFileSync(
  process.execPath,
  [path.join(root, "scripts", "financial-core", "verify-financial-core-v3.mjs")],
  { cwd: root, stdio: "inherit" }
);

console.log(
  `FINANCIAL CORE V3 restored. Previous changed files: ${path.relative(root, restoreRoot)}`
);
