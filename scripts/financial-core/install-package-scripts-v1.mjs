import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const packagePath = path.join(root, "package.json");
const packageJson = JSON.parse(
  fs.readFileSync(packagePath, "utf8")
);

packageJson.scripts ??= {};

const requiredScripts = {
  "financial-core:verify":
    "node scripts/financial-core/verify-financial-core-v1.mjs",
  "financial-core:regression":
    "bash scripts/financial-core/run-financial-core-regression-v1.sh",
  "financial-core:restore":
    "node scripts/financial-core/restore-financial-core-v1.mjs",
  prebuild: "npm run financial-core:verify",
  predev: "npm run financial-core:verify",
};

for (const [name, value] of Object.entries(
  requiredScripts
)) {
  packageJson.scripts[name] = value;
}

fs.writeFileSync(
  packagePath,
  JSON.stringify(packageJson, null, 2) + "\n",
  "utf8"
);

console.log(
  "package_scripts=INSTALLED"
);
