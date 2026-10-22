import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const lockDir = path.join(root, "financial-core", "v1");
const snapshotDir = path.join(lockDir, "snapshot");
const externalLockDir =
  process.env.EXTERNAL_LOCK_DIR?.trim() || "";
const tagName =
  process.env.FINANCIAL_CORE_TAG ||
  "financial-core-v1-2026-07-13";

const protectedFiles = [
  {
    path: "lib/analytics/profitAnalytics.ts",
    role: "Канонический расчёт прибыли Wildberries",
  },
  {
    path: "lib/analytics/profitAnalyticsOzon.ts",
    role: "Канонический расчёт прибыли Ozon",
  },
  {
    path: "lib/analytics/dataReadiness.ts",
    role: "Определение полноты и финальности данных периода",
  },
  {
    path: "lib/finance/financeMetrics.ts",
    role: "ДДС, влияние финансовых операций и выводы собственника",
  },
  {
    path: "lib/telegram/dailyReport.ts",
    role: "Единая финансовая сводка Dashboard и Telegram",
  },
  {
    path: "lib/import/detectReportType.ts",
    role: "Распознавание типов импортируемых отчётов",
  },
  {
    path: "lib/import/reportDetector.ts",
    role: "Контракт определения финансовых источников",
  },
  {
    path: "lib/import/normalizers/productCostNormalizer.ts",
    role: "Нормализация себестоимости и Excel-дат",
  },
  {
    path: "lib/import/normalizers/wbSalesNormalizer.ts",
    role: "Нормализация продаж Wildberries",
  },
  {
    path: "lib/import/normalizers/wbFinanceNormalizer.ts",
    role: "Нормализация финансового отчёта Wildberries",
  },
  {
    path: "lib/import/normalizers/wbAdsNormalizer.ts",
    role: "Нормализация рекламы Wildberries",
  },
  {
    path: "lib/import/normalizers/ozonFinanceNormalizer.ts",
    role: "Нормализация финансового отчёта Ozon",
  },
  {
    path: "lib/import/normalizers/ozonAdsNormalizer.ts",
    role: "Нормализация рекламы Ozon",
  },
  {
    path: "lib/import/normalizers/financeTransactionNormalizer.ts",
    role: "Нормализация внутренних финансовых операций",
  },
];

const consumerContracts = [
  {
    path: "app/page.tsx",
    role: "Dashboard",
    requiredPatterns: [
      "buildDailyReport",
      "@/lib/telegram/dailyReport",
    ],
  },
  {
    path: "app/insights/page.tsx",
    role: "Центр прибыли",
    requiredPatterns: [
      "buildDailyReport",
      "getProfitAnalytics",
      "getProfitAnalyticsOzon",
    ],
  },
  {
    path: "app/profit-wb/page.tsx",
    role: "Прибыль по SKU WB",
    requiredPatterns: [
      "getProfitAnalytics",
      "@/lib/analytics/profitAnalytics",
    ],
  },
  {
    path: "app/profit-ozon/page.tsx",
    role: "Прибыль по SKU Ozon",
    requiredPatterns: [
      "getProfitAnalyticsOzon",
      "@/lib/analytics/profitAnalyticsOzon",
    ],
  },
];

const controlValues = {
  currency: "RUB",
  periods: {
    "2026-07-08|ИП Петров": {
      wb: {
        economicTurnover: 4475.62,
        taxableRevenue: 3724.1,
        netProfitAfterTax: 1070.9157502644614,
        dataMode: "PRELIMINARY",
      },
    },
    "2026-07-12|ИП Петров": {
      wb: {
        economicTurnover: 534945.33,
        taxableRevenue: 367931.12,
        netProfitAfterTax: 21598.379276190462,
        dataMode: "FINAL",
      },
      ozon: {
        economicTurnover: 1094262,
        taxableRevenue: 388036.97,
        netProfitAfterTax: 150332.11934761913,
      },
      company: {
        netProfitBeforeOwner: 171930.4986238096,
        ownerWithdrawals: 9000,
        netProfitAfterOwner: 162930.4986238096,
      },
    },
    "2026-Q2|ИП Петров": {
      ozon: {
        taxableRevenue: 14445957.17,
        netProfitAfterTax: 4855169.645919057,
        coverageComplete: true,
      },
    },
    "2026-Q2|ИП Лебедева": {
      ozon: {
        taxableRevenue: 2456623.33,
        netProfitAfterTax: 619216.6133666668,
        coverageComplete: true,
      },
    },
  },
};

function sha256(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function gitText(args, fallback = "") {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return fallback;
  }
}

fs.rmSync(snapshotDir, {
  recursive: true,
  force: true,
});
fs.mkdirSync(snapshotDir, {
  recursive: true,
});

const lockedFiles = protectedFiles.map((entry) => {
  const sourcePath = path.join(root, entry.path);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(
      `Protected financial file is missing: ${entry.path}`
    );
  }

  const snapshotPath = path.join(snapshotDir, entry.path);
  fs.mkdirSync(path.dirname(snapshotPath), {
    recursive: true,
  });
  fs.copyFileSync(sourcePath, snapshotPath);

  return {
    ...entry,
    sha256: sha256(sourcePath),
    sizeBytes: fs.statSync(sourcePath).size,
    snapshotSha256: sha256(snapshotPath),
  };
});

for (const contract of consumerContracts) {
  const filePath = path.join(root, contract.path);

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Financial consumer is missing: ${contract.path}`
    );
  }

  const source = fs.readFileSync(filePath, "utf8");

  for (const pattern of contract.requiredPatterns) {
    if (!source.includes(pattern)) {
      throw new Error(
        `Consumer contract failed: ${contract.path} does not contain ${pattern}`
      );
    }
  }
}

const manifest = {
  version: "financial-core-v1",
  createdAt: new Date().toISOString(),
  tagName,
  sourceCommit: gitText(["rev-parse", "HEAD"], null),
  workingTreeDirty:
    gitText(["status", "--porcelain"], "").length > 0,
  policy: {
    purpose:
      "Защитить проверенное финансовое ядро от случайных изменений при работе над UI и отдельными страницами.",
    visualChangesAllowed: [
      "компоновка и размеры блоков",
      "цвета, типографика и адаптивность",
      "таблицы, графики и подписи",
      "фильтры отображения без изменения финансового источника",
    ],
    requireNewAuditFor: [
      "формулы прибыли, налогов, ДРР и ДДС",
      "выбор и объединение периодов WB/Ozon",
      "себестоимость и финансовые нормализаторы",
      "готовность данных",
      "финансовая логика Telegram/Dashboard",
    ],
  },
  packageScriptContract: {
    "financial-core:verify":
      "node scripts/financial-core/verify-financial-core-v1.mjs",
    "financial-core:regression":
      "bash scripts/financial-core/run-financial-core-regression-v1.sh",
    "financial-core:restore":
      "node scripts/financial-core/restore-financial-core-v1.mjs",
    prebuild: "npm run financial-core:verify",
    predev: "npm run financial-core:verify",
  },
  protectedFiles: lockedFiles,
  consumerContracts,
  controlValues,
};

fs.mkdirSync(lockDir, {
  recursive: true,
});

const manifestPath = path.join(lockDir, "manifest.json");
fs.writeFileSync(
  manifestPath,
  JSON.stringify(manifest, null, 2) + "\n",
  "utf8"
);

fs.writeFileSync(
  path.join(lockDir, "LOCKED"),
  [
    "FINANCIAL_CORE_V1_LOCKED",
    `createdAt=${manifest.createdAt}`,
    `tagName=${tagName}`,
    `protectedFiles=${lockedFiles.length}`,
    "",
  ].join("\n"),
  "utf8"
);

if (externalLockDir) {
  fs.mkdirSync(externalLockDir, {
    recursive: true,
  });

  fs.cpSync(lockDir, path.join(externalLockDir, "financial-core-v1"), {
    recursive: true,
    force: true,
  });
}

console.log(
  `manifest=${path.relative(root, manifestPath)}`
);
console.log(
  `protected_files=${lockedFiles.length}`
);
console.log(
  `consumer_contracts=${consumerContracts.length}`
);
console.log(
  `tag_name=${tagName}`
);
