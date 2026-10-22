import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "financial-core/v6/manifest.json"), "utf8")
);

for (const row of manifest.protectedFiles || []) {
  const snapshot = path.join(root, "financial-core/v6/snapshot", row.path);
  const target = path.join(root, row.path);
  if (!fs.existsSync(snapshot)) throw new Error(`Missing snapshot: ${row.path}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(snapshot, target);
}

const packagePath = path.join(root, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
packageJson.scripts ||= {};
for (const [name, value] of Object.entries(
  manifest.packageScriptContract || {}
)) {
  packageJson.scripts[name] = value;
}
fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + "\n");

const result = spawnSync(
  process.execPath,
  [path.join(root, "scripts/financial-core/verify-financial-core-v6.mjs")],
  { cwd: root, stdio: "inherit" }
);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log("FINANCIAL CORE V6: RESTORED AND VERIFIED");
