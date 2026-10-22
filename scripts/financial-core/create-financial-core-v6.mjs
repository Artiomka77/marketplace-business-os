import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const v5Manifest = JSON.parse(
  fs.readFileSync(path.join(root, "financial-core/v5/manifest.json"), "utf8")
);
const lockDir = path.join(root, "financial-core/v6");
const snapshotDir = path.join(lockDir, "snapshot");
const digest = (filePath) =>
  crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
const gitText = (args, fallback = "") => {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return fallback;
  }
};

const protectedFiles = [
  ...v5Manifest.protectedFiles.map(({ path, role }) => ({ path, role })),
  {
    path: "lib/analytics/wbFinancialCoreV6.ts",
    role: "Контракты выручки, сверки удержаний, cash и P&L settlement WB V6",
  },
  {
    path: "lib/wb/sourceOwnership.ts",
    role: "Канонический владелец WB Sales источника по finance reportNumber",
  },
  {
    path: "app/profit-wb/page.tsx",
    role: "Пользовательские определения показателей WB V6",
  },
  {
    path: "lib/analytics/productCostResolver.ts",
    role: "Единый детерминированный resolver положительной себестоимости",
  },
  {
    path: "lib/analytics/wbFinality.ts",
    role: "Fail-closed контракт FINAL для stock и planning consumers",
  },
  {
    path: "lib/analytics/wbSizeAllocation.ts",
    role: "Signed SALE/RETURN агрегация и reconciliation размеров WB",
  },
  {
    path: "lib/analytics/costCoverage.ts",
    role: "Coverage себестоимости на общем положительном resolver",
  },
  {
    path: "lib/stocks/stockAbcSnapshots.ts",
    role: "Запрет WB ABC snapshot из PRELIMINARY аналитики",
  },
  {
    path: "app/api/stocks/supply-plan/export/route.ts",
    role: "Запрет supply-plan export из PRELIMINARY WB аналитики",
  },
  {
    path: "app/api/stocks/production-plan/export/route.ts",
    role: "Запрет production-plan export из PRELIMINARY WB аналитики",
  },
];

fs.rmSync(snapshotDir, { recursive: true, force: true });

const lockedFiles = protectedFiles.map((entry) => {
  const source = path.join(root, entry.path);
  const snapshot = path.join(snapshotDir, entry.path);
  if (!fs.existsSync(source)) throw new Error(`Missing ${entry.path}`);
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  fs.copyFileSync(source, snapshot);
  return {
    ...entry,
    sha256: digest(source),
    snapshotSha256: digest(snapshot),
    sizeBytes: fs.statSync(source).size,
  };
});

const manifest = {
  version: "financial-core-v6",
  parentVersion: "financial-core-v5",
  createdAt: new Date().toISOString(),
  tagName: "financial-core-v6-rev5-1-narrow-delta-2026-08-20",
  status: "LOCAL_CANDIDATE_SERVER_VERIFY_REQUIRED",
  sourceCommit: gitText(["rev-parse", "HEAD"], null),
  workingTreeDirty: gitText(["status", "--porcelain"], "").length > 0,
  policy: {
    economicTurnover: "ABS_RETAIL_PRICE_WITH_DISCOUNT_NO_SPP_DOUBLE_ADD",
    buyerPaid: "ABS_WB_REALIZED_AMOUNT",
    marketplaceTaxTopUp: "MAX_ZERO_PAYOUT_MINUS_BUYER_PAID_PER_ROW",
    taxableRevenue: "BUYER_PAID_PLUS_MARKETPLACE_TAX_TOP_UP",
    taxableRevenueScope: "TAX_AND_INFORMATIONAL_USE_ONLY",
    returnTreatment: "REVERSE_SAME_ROW_LEVEL_AMOUNTS",
    managementPercentageDenominator: "ECONOMIC_TURNOVER",
    managementSharesAbcAndAllocation:
      "REVENUE_ALIAS_AND_SELLER_RETAIL_AMOUNT_EQUAL_ECONOMIC_TURNOVER",
    canonicalRevenueCompleteness:
      "MATERIAL_SALE_RETURN_REQUIRES_ALL_CANONICAL_V6_INPUTS",
    productCost:
      "FINITE_POSITIVE_DETERMINISTIC_COSTDATE_CREATEDAT_ID_RESOLVER",
    productCostKey:
      "LOWERCASE_YO_DASH_SPACING_AND_WHITESPACE_CANONICAL_NORMALIZATION",
    pnlExpenseReconciliation:
      "ECONOMIC_TURNOVER_MINUS_NET_PROFIT_AFTER_TAX",
    closedPeriodSourceOwnership:
      "EXACT_FINANCE_REPORT_SESSIONS_THEN_COMPLETE_DAILY_FINANCE_SESSIONS",
    ownedReportRows: "ALL_SESSION_ROWS_NO_SALE_DATE_RESLICE",
    productOperationClassifier:
      "SHARED_PAYMENT_REASON_OR_DOCUMENT_TYPE_SALE_RETURN_OTHER",
    closedWeekProfit:
      "CANONICAL_PNL_SETTLEMENT_MINUS_CANONICAL_COGS_MINUS_TAXES_MINUS_EXTERNAL_PNL_COSTS",
    officialCashSettlement: "WB_FINANCE_TOTAL_TO_PAY_RECONCILIATION_ONLY",
    deductionClassification:
      "ADS_AND_OPERATING_IN_PNL_CREDIT_EXCLUDED_UNKNOWN_FAILS_CLOSED",
    wbPromotion: "CLASSIFIED_PNL_DEDUCTION_NEVER_SUBTRACTED_TWICE",
    officialLogisticsPriority: "PRESERVED_FROM_FINANCIAL_CORE_V5",
    ozonLogic: "UNCHANGED_FROM_FINANCIAL_CORE_V5",
  },
  sourceSelection: {
    precedence: [
      "EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS",
      "DAILY_FINANCE_MATCHED_SESSIONS_ALL_ROWS",
      "PRELIMINARY_SINGLE_CLASS_FALLBACK",
    ],
    ownershipKey: "COMPANY_FINANCE_INTERVAL_AND_REPORT_NUMBER",
    allCompanies: "SUM_SEPARATELY_SELECTED_COMPANY_OWNERS",
    dailyCoverage: "EVERY_MOSCOW_CALENDAR_DAY_AND_REPORT_NUMBER_REQUIRED",
    persistedOwnerEvidence:
      "EVERY_SELECTED_FINAL_SESSION_REQUIRES_PERSISTED_WBSALE_ROWS",
    officialClosedWeekExpenses:
      "WB_FINANCE_MINIMAL_NON_OVERLAPPING_INTERVAL_COVER",
  },
  protectedFiles: lockedFiles,
  consumerContracts: v5Manifest.consumerContracts,
  packageScriptContract: {
    "financial-core:verify":
      "node scripts/financial-core/verify-financial-core-v6.mjs",
    "financial-core:regression":
      v5Manifest.packageScriptContract["financial-core:regression"],
    "financial-core:restore":
      "node scripts/financial-core/restore-financial-core-v6.mjs",
    "wb-finance:verify":
      v5Manifest.packageScriptContract["wb-finance:verify"],
    "wb-financial-core-v6:verify":
      "tsx scripts/wb/verify-wb-financial-core-v6.ts",
    prebuild: "npm run financial-core:verify",
    predev: "npm run financial-core:verify",
  },
  controlValues: {
    currency: "RUB",
    "2026-08-03..2026-08-09|ИП Петров": {
      economicTurnover: 3731559.73,
      buyerPaid: 2125455.72,
      platformDiscount: 1606104.01,
      sellerPayout: 2024884.25,
      prePayoutBridge: 1706675.48,
      marketplaceTaxTopUp: 24665.75,
      taxableRevenue: 2150121.47,
      officialLogistics: 499259.76,
      officialStorage: 1503.7,
      officialAcceptance: 0,
      officialWbPromotion: 163422,
      officialPenalties: 30,
      officialCashSettlement: 1360668.79,
      canonicalPnlSettlement: 1360668.79,
      cogs: 562890,
      taxes: 123887.95,
      netProfitAfterTax: 673890.84,
      marginAfterTaxPercent: 18.0592,
      sourceOwner: "DAILY_FINANCE_MATCHED_SESSIONS_ALL_ROWS",
      sourceProof: "PRIOR_READ_ONLY_SERVER_DIAGNOSTIC",
    },
    "2026-08-10..2026-08-16|ИП Петров": {
      economicTurnover: 4423576.82,
      buyerPaid: 2701877.81,
      platformDiscount: 1721699.01,
      sellerPayout: 2374350.14,
      prePayoutBridge: 2049226.68,
      marketplaceTaxTopUp: 6021.42,
      taxableRevenue: 2707899.23,
      officialLogistics: 594955.92,
      officialStorage: 471.11,
      officialAcceptance: 0,
      officialWbPromotion: 511778,
      officialPenalties: 10,
      officialCashSettlement: 1267135.11,
      canonicalPnlSettlement: 1267135.11,
      cogs: 649425,
      taxes: 156026.57,
      netProfitAfterTax: 461683.54,
      marginAfterTaxPercent: 10.4369,
      sourceOwner: "EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS",
      sourceProof: "PRIOR_READ_ONLY_SERVER_DIAGNOSTIC",
    },
    "2026-08-03..2026-08-09|ИП Лебедева": {
      economicTurnover: 500617.5,
      buyerPaid: 293400.95,
      sellerPayout: 277022.34,
      marketplaceTaxTopUp: 6338.63,
      taxableRevenue: 299739.58,
      cogs: 87195,
      taxes: 32257.69,
      officialWbPromotion: 5498,
      officialCashSettlement: 211108.15,
      canonicalPnlSettlement: 211108.15,
      netProfitAfterTax: 91655.46,
      marginAfterTaxPercent: 18.3085,
      sourceOwner: "DAILY_FINANCE_MATCHED_SESSIONS_ALL_ROWS",
      sourceProof: "PRIOR_READ_ONLY_SERVER_DIAGNOSTIC",
    },
    "2026-08-10..2026-08-16|ИП Лебедева": {
      economicTurnover: 432667.21,
      buyerPaid: 276309.01,
      sellerPayout: 237861.65,
      marketplaceTaxTopUp: 1895.91,
      taxableRevenue: 278204.92,
      cogs: 75810,
      taxes: 29940.15,
      officialWbPromotion: 29055,
      officialCashSettlement: 135120.13,
      canonicalPnlSettlement: 135120.13,
      netProfitAfterTax: 29369.98,
      marginAfterTaxPercent: 6.7881,
      sourceOwner: "EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS",
      sourceProof: "PRIOR_READ_ONLY_SERVER_DIAGNOSTIC",
    },
    "2026-08-03..2026-08-09|ALL": {
      economicTurnover: 4232177.23,
      buyerPaid: 2418856.67,
      marketplaceTaxTopUp: 31004.38,
      taxableRevenue: 2449861.05,
      cogs: 650085,
      taxes: 156145.64,
      canonicalPnlSettlement: 1571776.94,
      netProfitAfterTax: 765546.3,
      marginAfterTaxPercent: 18.0887,
    },
    "2026-08-10..2026-08-16|ALL": {
      economicTurnover: 4856244.03,
      buyerPaid: 2978186.82,
      marketplaceTaxTopUp: 7917.33,
      taxableRevenue: 2986104.15,
      cogs: 725235,
      taxes: 185966.72,
      canonicalPnlSettlement: 1402255.24,
      netProfitAfterTax: 491053.52,
      marginAfterTaxPercent: 10.1118,
    },
  },
  evidence: {
    directory: "__v6_evidence",
    stateAtImplementation: "EMPTY",
    productionSourceSha256Available: false,
    officialXlsxAvailable: false,
    productionAccess: "NONE",
  },
};

fs.mkdirSync(lockDir, { recursive: true });
fs.writeFileSync(
  path.join(lockDir, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  "utf8"
);
fs.writeFileSync(
  path.join(lockDir, "README.txt"),
  [
    "Financial Core V6 is a LOCAL_CANDIDATE and requires read-only server verification.",
    "It does not claim production readiness or production finality.",
    "The candidate preserves the WB row-level taxable-revenue contract.",
    "REV3 isolates taxable revenue to tax/informational use; WB management economics reconcile from economic turnover.",
    "REV4 assigns each closed finance interval to exact reportNumber sessions or a calendar-complete daily owner, using all selected-session rows.",
    "REV4.1 shares one paymentReason/documentType product-operation classifier across analytics, finality coverage, and size breakdown.",
    "REV5 fails closed on invalid cost, blank reportNumber, empty owner sessions, and missing canonical revenue inputs.",
    "REV5 restores revenue as the economic-turnover compatibility alias and keeps taxableRevenue explicit.",
    "REV5 blocks PRELIMINARY WB stock/planning consumers and preserves signed return-only sizes.",
    "REV5.1 unifies WB cost-key normalization and scopes export finality checks to outputs that can include WB.",
    "Parent: Financial Core V5; official weekly logistics priority is preserved.",
    "Created locally without production access; 03-09 source coverage remains unresolved.",
    "",
  ].join("\n"),
  "utf8"
);
fs.writeFileSync(
  path.join(lockDir, "LOCKED"),
  `FINANCIAL_CORE_V6_LOCAL_CANDIDATE\nstatus=SERVER_VERIFY_REQUIRED\ncreatedAt=${manifest.createdAt}\nprotectedFiles=${lockedFiles.length}\n`,
  "utf8"
);

console.log(
  `FINANCIAL CORE V6: LOCAL CANDIDATE CREATED (${lockedFiles.length} protected files, SERVER VERIFY REQUIRED)`
);
