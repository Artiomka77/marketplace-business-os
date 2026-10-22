import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = path.join(root, "financial-core/v4/manifest.json");
const failures = [];
const digest = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

if (!fs.existsSync(manifestPath)) {
  console.error("FINANCIAL CORE V4: FAILED");
  console.error("- missing financial-core/v4/manifest.json");
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.version !== "financial-core-v4") failures.push(`unexpected version: ${manifest.version}`);

for (const row of manifest.protectedFiles || []) {
  const file = path.join(root, row.path);
  const snapshot = path.join(root, "financial-core/v4/snapshot", row.path);
  if (!fs.existsSync(file)) { failures.push(`missing protected file ${row.path}`); continue; }
  if (!fs.existsSync(snapshot)) { failures.push(`missing snapshot ${row.path}`); continue; }
  const actual = digest(file);
  const snap = digest(snapshot);
  if (actual !== row.sha256) failures.push(`hash ${row.path}: ${actual} != ${row.sha256}`);
  if (snap !== row.snapshotSha256) failures.push(`snapshot hash ${row.path}: ${snap} != ${row.snapshotSha256}`);
  if (actual !== snap) failures.push(`protected/snapshot divergence ${row.path}`);
}

for (const contract of manifest.consumerContracts || []) {
  const file = path.join(root, contract.path);
  if (!fs.existsSync(file)) { failures.push(`missing consumer ${contract.path}`); continue; }
  const text = fs.readFileSync(file, "utf8");
  for (const pattern of contract.requiredPatterns || []) {
    if (!text.includes(pattern)) failures.push(`missing pattern ${contract.path}: ${pattern}`);
  }
  for (const pattern of contract.forbiddenPatterns || []) {
    if (text.includes(pattern)) failures.push(`forbidden pattern ${contract.path}: ${pattern}`);
  }
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
for (const [name, expected] of Object.entries(manifest.packageScriptContract || {})) {
  const actual = packageJson.scripts?.[name];
  if (actual !== expected) failures.push(`package script ${name}: ${actual} != ${expected}`);
}

for (const row of manifest.toolingFiles || []) {
  const file = path.join(root, row.path);
  if (!fs.existsSync(file)) { failures.push(`missing tooling file ${row.path}`); continue; }
  const actual = digest(file);
  if (actual !== row.sha256) failures.push(`tooling hash ${row.path}: ${actual} != ${row.sha256}`);
}

if (failures.length) {
  console.error("FINANCIAL CORE V4: FAILED");
  for (const item of failures) console.error(`- ${item}`);
  process.exit(1);
}
console.log(`FINANCIAL CORE V4: VERIFIED (${manifest.protectedFiles.length} protected files, ${manifest.consumerContracts.length} consumers)`);
