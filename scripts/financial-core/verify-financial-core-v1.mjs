import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const manifestPath = path.join(
  root,
  "financial-core",
  "v1",
  "manifest.json"
);

function sha256(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

if (!fs.existsSync(manifestPath)) {
  console.error(
    "FINANCIAL CORE LOCK ERROR: financial-core/v1/manifest.json is missing."
  );
  process.exit(1);
}

const manifest = JSON.parse(
  fs.readFileSync(manifestPath, "utf8")
);

const failures = [];

for (const entry of manifest.protectedFiles ?? []) {
  const currentPath = path.join(root, entry.path);
  const snapshotPath = path.join(
    root,
    "financial-core",
    "v1",
    "snapshot",
    entry.path
  );

  if (!fs.existsSync(currentPath)) {
    failures.push({
      kind: "PROTECTED_FILE_MISSING",
      path: entry.path,
    });
    continue;
  }

  const currentHash = sha256(currentPath);

  if (currentHash !== entry.sha256) {
    failures.push({
      kind: "PROTECTED_FILE_CHANGED",
      path: entry.path,
      expected: entry.sha256,
      actual: currentHash,
    });
  }

  if (!fs.existsSync(snapshotPath)) {
    failures.push({
      kind: "SNAPSHOT_MISSING",
      path: entry.path,
    });
    continue;
  }

  const snapshotHash = sha256(snapshotPath);

  if (
    snapshotHash !== entry.snapshotSha256 ||
    snapshotHash !== entry.sha256
  ) {
    failures.push({
      kind: "SNAPSHOT_CHANGED",
      path: entry.path,
      expected: entry.sha256,
      actual: snapshotHash,
    });
  }
}

for (const contract of manifest.consumerContracts ?? []) {
  const filePath = path.join(root, contract.path);

  if (!fs.existsSync(filePath)) {
    failures.push({
      kind: "CONSUMER_MISSING",
      path: contract.path,
    });
    continue;
  }

  const source = fs.readFileSync(filePath, "utf8");

  for (const pattern of contract.requiredPatterns ?? []) {
    if (!source.includes(pattern)) {
      failures.push({
        kind: "CONSUMER_CONTRACT_CHANGED",
        path: contract.path,
        missingPattern: pattern,
      });
    }
  }
}

const packagePath = path.join(root, "package.json");

if (!fs.existsSync(packagePath)) {
  failures.push({
    kind: "PACKAGE_JSON_MISSING",
  });
} else {
  const packageJson = JSON.parse(
    fs.readFileSync(packagePath, "utf8")
  );

  for (const [scriptName, expectedValue] of Object.entries(
    manifest.packageScriptContract ?? {}
  )) {
    const actualValue = packageJson.scripts?.[scriptName];

    if (actualValue !== expectedValue) {
      failures.push({
        kind: "PACKAGE_SCRIPT_CHANGED",
        scriptName,
        expected: expectedValue,
        actual: actualValue ?? null,
      });
    }
  }
}

if (failures.length > 0) {
  console.error("");
  console.error(
    "FINANCIAL CORE V1: LOCK VIOLATION"
  );
  console.error(
    "Финансовое ядро или его подключение изменено."
  );
  console.error(
    "Визуальную работу продолжать можно только после восстановления ядра либо отдельного аудита новой версии."
  );
  console.error("");

  for (const failure of failures) {
    console.error(JSON.stringify(failure));
  }

  console.error("");
  console.error(
    "Восстановление: npm run financial-core:restore"
  );

  process.exit(1);
}

console.log(
  `FINANCIAL CORE V1: VERIFIED (${manifest.protectedFiles.length} protected files, ${manifest.consumerContracts.length} consumers)`
);
