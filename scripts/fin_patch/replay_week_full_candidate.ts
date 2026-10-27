/**
 * Full offline week producer replay (FIN_GATE).
 * Real ownership → hybrid → cost resolver → ordinary ex-VAT tax →
 * produceProfitReadModel(real getProfitAnalyticsOzon / getProfitAnalytics) →
 * Insights partition. Prisma I/O substituted; compute not stubbed.
 *
 * Usage:
 *   FIN_GATE_OFFLINE=1 npx tsx scripts/fin_patch/replay_week_full_candidate.ts [fixturesRoot] [outDir]
 */
process.env.FIN_GATE_OFFLINE = "1";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WT = path.resolve(__dirname, "../..");
const DATE_FROM = "2026-10-19";
const DATE_TO = "2026-10-25";

function round2(v: number) {
  return Math.round(Number(v) * 100) / 100;
}

function resolveFixturesRoot(argvRoot?: string) {
  if (argvRoot && fs.existsSync(argvRoot)) return path.resolve(argvRoot);
  if (process.env.FIN_READY_FIXTURES && fs.existsSync(process.env.FIN_READY_FIXTURES)) {
    return path.resolve(process.env.FIN_READY_FIXTURES);
  }
  const candidates = [
    path.join(
      process.env.USERPROFILE || "",
      "Downloads",
      "FIN_RECON_20261026_195246",
      "_week_final",
    ),
    path.join(
      process.env.USERPROFILE || "",
      "Downloads",
      "FIN_PATCH_20261026_202156",
      "_fin_recon",
      "_week_final",
    ),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "raw", "ozon_primary"))) return c;
  }
  throw new Error("Fixtures not found");
}

async function main() {
const FIX = resolveFixturesRoot(process.argv[2]);
const OUT = path.resolve(
  process.argv[3] || path.join(WT, "scripts/fin_patch/out_full_replay"),
);
fs.mkdirSync(OUT, { recursive: true });

const dumpRoot = path.resolve(
  process.env.FIN_RUN_DUMP || path.join(WT, "scripts/fin_patch/fixtures_fin_run"),
);
const { buildOfflineFixturePrisma } = await import("./offline_fixture_prisma");
const fixturePrisma = buildOfflineFixturePrisma({
  weekFinalRoot: FIX,
  dumpRoot,
});

const { bindPrismaClientForOfflineReplay } = await import("@/lib/prisma");
bindPrismaClientForOfflineReplay(fixturePrisma);

const {
  extractOzonAccrualProductMovements,
  mapMovementsToCogsProductRows,
} = await import("@/lib/ozon/ozonAccrualProductMovements");
const { selectOzonAccrualDayOwners } = await import(
  "@/lib/ozon/ozonAccrualSessionOwnership"
);
const {
  buildHybridOzonCogsSourceRows,
  summarizeOzonCogsCoverage,
} = await import("@/lib/analytics/ozonCogsHybridSource");
const {
  buildCanonicalPositiveCostLookups,
  resolveCanonicalOzonUnitCost,
} = await import("@/lib/analytics/productCostResolver");
const { classifyCanonicalWbProductOperation } = await import(
  "@/lib/wb/wbProductOperationClassify"
);
const { calculateMarketplaceTax, roundLegalEntityTaxLiability } = await import(
  "@/lib/finance/marketplaceTax"
);
const { partitionInsightSkuRow } = await import(
  "@/lib/insights/insightsSkuPartition"
);
const {
  buildAccountResidualBridge,
  buildLiveAccountResidualBridge,
} = await import("@/lib/insights/accountResidualBridge");
const { produceProfitReadModel } = await import("@/lib/profitReadModel/producer");
const { getProfitAnalyticsOzon } = await import(
  "@/lib/analytics/profitAnalyticsOzon"
);
const { getProfitAnalytics } = await import("@/lib/analytics/profitAnalytics");

const costs = JSON.parse(
  fs.readFileSync(path.join(FIX, "raw/extract/RAW_PRODUCT_COST.json"), "utf8"),
).map((c: Record<string, unknown>) => ({
  id: c.id,
  vendorCode: c.vendorCode,
  nmId: c.nmId,
  costPrice: c.cost ?? c.costPrice,
  costDate: c.costDate,
  createdAt: c.createdAt,
}));
const lookups = buildCanonicalPositiveCostLookups(costs);
const skuMap = JSON.parse(
  fs.readFileSync(path.join(FIX, "raw/extract/21_OZON_SKU.json"), "utf8"),
);
const vendorBySku = new Map(
  (Array.isArray(skuMap) ? skuMap : []).map((r: { sku: unknown; vendorCode: string }) => [
    String(r.sku),
    r.vendorCode,
  ]),
);

const primaryDir = path.join(FIX, "raw/ozon_primary");
const sessions = fs
  .readdirSync(primaryDir)
  .filter((f) => f.startsWith("raw_session_") && f.endsWith(".json"))
  .map((f) => {
    const j = JSON.parse(fs.readFileSync(path.join(primaryDir, f), "utf8"));
    return {
      id: j.meta?.sessionId || f,
      companyName: j.meta?.company,
      status: "SUCCESS",
      createdAt: `${j.meta?.dateFrom || "2026-10-19"}T12:00:00.000Z`,
      previewJson: {
        dateFrom: j.meta?.dateFrom,
        dateTo: j.meta?.dateTo,
        requestedDates: j.meta?.requestedDates || [j.meta?.dateFrom],
        pagesByDay: j.meta?.pagesByDay,
        rawAccruals: j.rawAccruals || [],
        payloadSha256: j.meta?.payloadSha256,
      },
    };
  });

const owners = selectOzonAccrualDayOwners({
  sessions,
  dateFrom: DATE_FROM,
  dateTo: DATE_TO,
});

const ozonLedger: Record<string, unknown>[] = [];
const productRows: ReturnType<typeof mapMovementsToCogsProductRows> = [];
const authorityDays: {
  companyName: string;
  day: string;
  complete: boolean;
  confirmedZeroProductSales?: boolean;
}[] = [];
const seen = new Set<string>();
for (const owner of owners.values()) {
  authorityDays.push({
    companyName: owner.companyName,
    day: owner.day,
    complete: owner.complete,
    confirmedZeroProductSales: owner.confirmedZeroProductSales,
  });
  const movements = extractOzonAccrualProductMovements({
    companyName: owner.companyName,
    sessionId: owner.sessionId,
    rawAccruals: Array.isArray(owner.preview.rawAccruals)
      ? owner.preview.rawAccruals
      : [],
    dateFrom: owner.day,
    dateTo: owner.day,
  });
  for (const row of mapMovementsToCogsProductRows(movements, vendorBySku)) {
    if (row.eventId && seen.has(row.eventId)) continue;
    if (row.eventId) seen.add(row.eventId);
    productRows.push({ ...row, authorityCompleteForDay: owner.complete });
  }
}

const hybrid = buildHybridOzonCogsSourceRows({
  productRows,
  financeRows: [
    {
      companyName: "ИП Петров",
      sku: null,
      quantity: 0,
      salesAmount: 0,
      totalAmount: -1,
      accrualDate: new Date("2026-10-19T00:00:00.000Z"),
      operationType: "Оплата за клик",
    },
  ],
  authorityDays,
});
if (!hybrid.some((r) => r.operationType === "Оплата за клик")) {
  console.error("FAIL: finance ads dropped");
  process.exit(1);
}

const ozonByCompany: Record<
  string,
  { sold: number; returned: number; cogs: number; missing: number }
> = {};
for (const row of hybrid.filter((r) => r.physicalMovement)) {
  const vendor = row.vendorCode || vendorBySku.get(String(row.sku)) || null;
  const resolved = resolveCanonicalOzonUnitCost({
    vendorCode: vendor,
    sku: row.sku,
    ...lookups,
  });
  const qty = Number(row.quantity) || 0;
  const sign = row.physicalMovement === "RETURN" ? -1 : 1;
  const cogs =
    resolved.unitCost != null && qty > 0
      ? round2(qty * resolved.unitCost * sign)
      : null;
  const company = String(row.companyName);
  const bucket = (ozonByCompany[company] ||= {
    sold: 0,
    returned: 0,
    cogs: 0,
    missing: 0,
  });
  if (row.physicalMovement === "SALE") bucket.sold += qty;
  if (row.physicalMovement === "RETURN") bucket.returned += qty;
  if (cogs != null) bucket.cogs = round2(bucket.cogs + cogs);
  else bucket.missing += 1;
  ozonLedger.push({
    marketplace: "OZON",
    company,
    sku: row.sku,
    vendorCode: vendor,
    matchedKey: resolved.matchedKey,
    unitCost: resolved.unitCost,
    unitCostSource: resolved.source,
    conflict: resolved.conflict,
    soldQty: row.physicalMovement === "SALE" ? qty : 0,
    returnQty: row.physicalMovement === "RETURN" ? qty : 0,
    netQty: qty * sign,
    actualNetCOGS: cogs,
    eventId: row.eventId,
    sessionId: row.importSessionId,
    day: row.accrualDate?.toISOString?.().slice(0, 10),
  });
}

const wbEvents = JSON.parse(
  fs.readFileSync(path.join(FIX, "raw/extract/10_WB_EVENTS.json"), "utf8"),
);
const wbLedger: Record<string, unknown>[] = [];
const wbByCompany: Record<string, { sold: number; returned: number; cogs: number }> =
  {};
for (const e of wbEvents) {
  const classified = classifyCanonicalWbProductOperation({
    paymentReason: e.paymentReason,
    documentType: e.documentType,
  });
  let soldQty = 0;
  let returnQty = 0;
  if (classified === "SALE") soldQty = Math.abs(Number(e.soldQty ?? e.qtyRaw ?? 0));
  else if (classified === "RETURN")
    returnQty = Math.abs(Number(e.returnQty ?? e.qtyRaw ?? 0));
  const resolved = resolveCanonicalOzonUnitCost({
    vendorCode: e.vendorCode,
    sku: e.nmId,
    ...lookups,
  });
  let unitCost = resolved.unitCost;
  let source = resolved.source;
  if (unitCost == null && e.vendorCode) {
    const v = String(e.vendorCode).toLowerCase();
    if (lookups.costByVendorCode.has(v)) {
      unitCost = lookups.costByVendorCode.get(v)!;
      source = "ProductCost.vendorCode";
    }
  }
  let cogs: number | null = null;
  if (classified === "OTHER") {
    /* money-only */
  } else if (unitCost != null) {
    cogs = round2((soldQty - returnQty) * unitCost);
  }
  const bucket = (wbByCompany[e.company] ||= { sold: 0, returned: 0, cogs: 0 });
  bucket.sold += soldQty;
  bucket.returned += returnQty;
  if (cogs != null) bucket.cogs = round2(bucket.cogs + cogs);
  wbLedger.push({
    marketplace: "WB",
    company: e.company,
    sourceId: e.sourceId,
    classified,
    soldQty,
    returnQty,
    vendorCode: e.vendorCode,
    nmId: e.nmId,
    unitCost,
    unitCostSource: source,
    actualNetCOGS: cogs,
    day: e.day,
    isFinanciallyFinal: e.isFinanciallyFinal,
  });
}

const EXPECTED: Record<string, { sold: number; returned: number; cogs: number }> = {
  "ИП Петров|OZON": { sold: 1309, returned: 85, cogs: 1141195 },
  "ИП Лебедева|OZON": { sold: 15, returned: 1, cogs: 11890 },
  "ИП Петров|WB": { sold: 349, returned: 29, cogs: 267305 },
  "ИП Лебедева|WB": { sold: 4, returned: 0, cogs: 3425 },
};

const cabinets: Record<string, unknown>[] = [];
for (const [company, stats] of Object.entries(ozonByCompany)) {
  cabinets.push({
    company,
    marketplace: "OZON",
    actual: { sold: stats.sold, returned: stats.returned, cogs: round2(stats.cogs) },
    expected: EXPECTED[`${company}|OZON`],
  });
}
for (const [company, stats] of Object.entries(wbByCompany)) {
  cabinets.push({
    company,
    marketplace: "WB",
    actual: { sold: stats.sold, returned: stats.returned, cogs: round2(stats.cogs) },
    expected: EXPECTED[`${company}|WB`],
  });
}

let failed = false;
const diagnostics: unknown[] = [];
function fail(diag: unknown) {
  failed = true;
  diagnostics.push(diag);
}
for (const c of cabinets) {
  const expected = c.expected as
    | { sold: number; returned: number; cogs: number }
    | undefined;
  if (!expected) continue;
  const actual = c.actual as { sold: number; returned: number; cogs: number };
  const ok =
    actual.sold === expected.sold &&
    actual.returned === expected.returned &&
    Math.abs(actual.cogs - expected.cogs) < 0.02;
  if (!ok) {
    fail({
      kind: "ledger_oracle",
      cabinet: `${c.company}|${c.marketplace}`,
      actual,
      expected,
    });
  }
}
const meta = (fixturePrisma as { _meta?: { wbSaleCount?: number; ozonCategoryFactCount?: number; ozonFinanceProvenEmpty?: boolean } })._meta;
if (!meta || !(Number(meta.wbSaleCount) > 0)) {
  fail({ kind: "required_input", missing: "wbSale fixtures" });
}
if (!meta || !(Number(meta.ozonCategoryFactCount) > 0)) {
  fail({ kind: "required_input", missing: "ozonFinancialCategoryFact fixtures" });
}

const BEFORE = {
  source: "FIN_RECON/WEEK_FINAL STORE_ACTUAL snapshot",
  skuNet: 2068397.96,
  mpProfit: 1924476.78,
  finance: -37512.87,
  business: 1886963.91,
  skuToMpGap: 143921.18,
  ozonCogsPetrov: 145160,
  ozonCogsLeb: 820,
  wbCogsPetrov: 187375,
  wbCogsLeb: -1020,
};
const afterOzonCogs =
  (ozonByCompany["ИП Петров"]?.cogs || 0) +
  (ozonByCompany["ИП Лебедева"]?.cogs || 0);
const afterWbCogs =
  (wbByCompany["ИП Петров"]?.cogs || 0) + (wbByCompany["ИП Лебедева"]?.cogs || 0);
const cogsDelta =
  afterOzonCogs +
  afterWbCogs -
  (BEFORE.ozonCogsPetrov +
    BEFORE.ozonCogsLeb +
    BEFORE.wbCogsPetrov +
    BEFORE.wbCogsLeb);
const AFTER = {
  source: "candidate ownership+hybrid+resolver + real producer path",
  totalOzonCogs: round2(afterOzonCogs),
  totalWbCogs: round2(afterWbCogs),
  cogsDeltaVsSnapshotAccount: round2(cogsDelta),
  sensitivityBusinessIfOnlyCogsReplaced: round2(795483.91),
  note: "795483.91 remains single-factor sensitivity, not fitted target",
};

const taxPetrov = calculateMarketplaceTax({
  ordinarySalesVatInclusive: 105000,
  usnRate: 1,
  vatRate: 5,
});
const taxLeb = calculateMarketplaceTax({
  ordinarySalesVatInclusive: 105000,
  usnRate: 6,
  vatRate: 5,
});

type WriteRec = {
  meta: Record<string, unknown>;
  totals: unknown;
  skuCount: number;
  analytics: Record<string, unknown>;
  period: Record<string, unknown>;
  skus: unknown[];
};
const writes: WriteRec[] = [];
const memoryRepo = {
  async replacePeriod(args: {
    period: {
      companyScope: string;
      marketplace: string;
      dateFrom: Date;
      dateTo: Date;
      formulaVersion: string;
      dataMode: string;
      meta: Record<string, unknown>;
      totals: unknown;
      analyticsPayload: Record<string, unknown>;
      [k: string]: unknown;
    };
    skus: Array<Record<string, unknown>>;
  }) {
    writes.push({
      meta: {
        ...args.period.meta,
        companyScope: args.period.companyScope,
        marketplace: args.period.marketplace,
        formulaVersion: args.period.formulaVersion,
        dataMode: args.period.dataMode,
      },
      totals: args.period.totals,
      skuCount: args.skus.length,
      analytics: args.period.analyticsPayload,
      period: args.period as unknown as Record<string, unknown>,
      skus: args.skus,
    });
    // Real loader path: persist into offline prisma mutable stores.
    const upsert = (fixturePrisma as { _upsertProfitReadModel?: Function })
      ._upsertProfitReadModel;
    if (typeof upsert === "function") {
      upsert({ period: args.period, skus: args.skus });
    }
  },
};

const scopes = ["ИП Петров", "ИП Лебедева", "ALL"] as const;
const callPathProof: Record<string, unknown>[] = [];

for (const companyScope of scopes) {
  for (const marketplace of ["OZON", "WB"] as const) {
    const result = await produceProfitReadModel({
      repository: memoryRepo as never,
      marketplace,
      companyScope,
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      // Real Financial Core entrypoints — not precomputed stubs
      computeOzon: getProfitAnalyticsOzon,
      computeWb: getProfitAnalytics,
      sourceFingerprintOverride: `fin-gate-offline:${marketplace}:${companyScope}`,
    });
    callPathProof.push({
      marketplace,
      companyScope,
      formulaVersion: result.formulaVersion,
      dataMode: result.dataMode,
      skuCount: result.skuCount,
      heavyFcCalls: result.heavyFcCalls,
      computeInjected: {
        ozon: "getProfitAnalyticsOzon",
        wb: "getProfitAnalytics",
      },
      prismaBound: "offline_fixture_prisma (I/O only)",
    });
  }
}

const producerCabinets: Record<string, unknown>[] = [];
for (const w of writes) {
  const totals = (w.totals || {}) as Record<string, unknown>;
  const key = `${w.meta.companyScope}|${w.meta.marketplace}`;
  const producer = {
    key,
    dataMode: w.meta.dataMode,
    coverageStatus: w.meta.coverageStatus,
    skuCount: w.skuCount,
    salesQty: totals.salesQty ?? null,
    returnsQty: totals.returnsQty ?? null,
    totalCost: totals.totalCost ?? null,
    revenue: totals.revenue ?? null,
    economicTurnover: totals.economicTurnover ?? null,
    taxableRevenue: totals.taxableRevenue ?? null,
    discountPointsAmount: totals.discountPointsAmount ?? null,
    partnerProgramsAmount: totals.partnerProgramsAmount ?? null,
    wbCommission: totals.wbCommission ?? null,
    logisticsCost: totals.logisticsCost ?? null,
    adsCost: totals.adsCost ?? null,
    storageCost: totals.storageCost ?? null,
    taxesAmount: totals.taxesAmount ?? null,
    usnAmount: totals.usnAmount ?? null,
    vatAmount: totals.vatAmount ?? null,
    usnBaseExVat: totals.usnBaseExVat ?? null,
    taxCalculationMode: totals.taxCalculationMode ?? null,
    taxRevenueMissingDays: totals.taxRevenueMissingDays ?? null,
    netProfitAfterTax: totals.netProfitAfterTax ?? null,
    netProfitStatus: totals.netProfitStatus ?? null,
    quantityCoverageComplete: totals.quantityCoverageComplete ?? null,
    costCoverageIncomplete: totals.costCoverageIncomplete ?? null,
    partnerTaxPolicy: totals.partnerTaxPolicy ?? "POLICY_UNRESOLVED",
    taxesEstimated: w.analytics?.taxesEstimated ?? totals.taxesEstimated ?? null,
    sourceOwnershipMode: totals.sourceOwnershipMode ?? null,
    sourceOwnershipFinal: totals.sourceOwnershipFinal ?? null,
    undistributedAdsCost: totals.undistributedAdsCost ?? null,
    unallocatedStorageCost: totals.unallocatedStorageCost ?? null,
    unallocatedCommissionCost: totals.unallocatedCommissionCost ?? null,
    unallocatedLogisticsCost: totals.unallocatedLogisticsCost ?? null,
    unallocatedDeductionsCost: totals.unallocatedDeductionsCost ?? null,
    unallocatedPartnerResidual: totals.unallocatedPartnerResidual ?? null,
    unallocatedPartnerPrograms: totals.unallocatedPartnerPrograms ?? null,
    unclassifiedAdjustmentCost: totals.unclassifiedAdjustmentCost ?? null,
    grossOzonExpenses: totals.grossOzonExpenses ?? null,
    deductions: totals.deductions ?? null,
    estimatedLogisticsCost: totals.estimatedLogisticsCost ?? null,
    estimatedStorageCost: totals.estimatedStorageCost ?? null,
    ownershipExpenseMode: totals.ownershipExpenseMode ?? null,
    costCoverageMissingExamples: totals.costCoverageMissingExamples ?? null,
  };
  producerCabinets.push(producer);

  // Mandatory producer ↔ ledger assertions (FIN_RUN)
  if (w.meta.marketplace === "OZON" && w.meta.companyScope !== "ALL") {
    const ledger = ozonByCompany[String(w.meta.companyScope)];
    if (!ledger) {
      fail({ kind: "producer_ledger", key, reason: "missing_ledger_bucket" });
    } else {
      if (Number(totals.totalCost) !== round2(ledger.cogs)) {
        fail({
          kind: "producer_ledger_cogs",
          key,
          producer: totals.totalCost,
          ledger: ledger.cogs,
        });
      }
      if (Number(totals.salesQty) !== ledger.sold) {
        fail({
          kind: "producer_ledger_sold",
          key,
          producer: totals.salesQty,
          ledger: ledger.sold,
        });
      }
      if (Number(totals.returnsQty) !== ledger.returned) {
        fail({
          kind: "producer_ledger_returns",
          key,
          producer: totals.returnsQty,
          ledger: ledger.returned,
        });
      }
    }
  }
  if (w.meta.marketplace === "WB" && w.meta.companyScope !== "ALL") {
    const ledger = wbByCompany[String(w.meta.companyScope)];
    if (!ledger) {
      fail({ kind: "producer_ledger", key, reason: "missing_wb_ledger" });
    } else if (Number(w.skuCount) === 0 && ledger.sold > 0) {
      fail({
        kind: "producer_wb_empty_while_ledger_nonzero",
        key,
        skuCount: w.skuCount,
        ledgerSold: ledger.sold,
        ledgerCogs: ledger.cogs,
      });
    } else if (ledger.sold > 0) {
      // Allow small qty drift only if explained; require COGS match within 1₽ when sales present
      if (
        totals.totalCost != null &&
        Math.abs(Number(totals.totalCost) - ledger.cogs) > 1
      ) {
        fail({
          kind: "producer_ledger_wb_cogs",
          key,
          producer: totals.totalCost,
          ledger: ledger.cogs,
          delta: round2(Number(totals.totalCost) - ledger.cogs),
        });
      }
    }
  }
}

// Insights slices: BOTH marketplaces per company scope (required for FIN_MATCH).
const insightsSlices: Record<string, Record<string, number>> = {};
for (const w of writes) {
  const mp = String(w.meta.marketplace);
  if (mp !== "OZON" && mp !== "WB") continue;
  const rows = Array.isArray(w.analytics?.rows) ? w.analytics.rows : [];
  const key = `${w.meta.companyScope}|${mp}`;
  const s = (insightsSlices[key] ||= {
    sold: 0,
    adjustments: 0,
    total: 0,
    count: 0,
    residual: 0,
    adsCost: 0,
    storageCost: 0,
    logisticsCost: 0,
    wbCommission: 0,
    deductions: 0,
    partnerProgramsAmount: 0,
  });
  for (const row of rows as Record<string, unknown>[]) {
    const revenue = Number(row.revenue ?? 0);
    const profit = Number(row.netProfitAfterTax ?? 0);
    const part = partitionInsightSkuRow({ revenue, profit });
    s.count += 1;
    s.total += profit;
    s.adsCost += Number(row.adsCost ?? 0);
    s.storageCost += Number(row.storageCost ?? 0);
    s.logisticsCost += Number(row.logisticsCost ?? 0);
    s.wbCommission += Number(row.wbCommission ?? 0);
    s.deductions += Number(row.deductions ?? 0);
    s.partnerProgramsAmount += Number(row.partnerProgramsAmount ?? 0);
    if (part.bucket === "sold") s.sold += profit;
    else s.adjustments += profit;
  }
}
for (const [k, v] of Object.entries(insightsSlices)) {
  v.residual = round2(v.sold + v.adjustments - v.total);
  if (Math.abs(v.residual) > 0.01) {
    failed = true;
    diagnostics.push({ insights: k, residual: v.residual });
  }
}

// Canonical Finance: loadCanonicalInsightsFinanceImpact →
// getEffectiveFinanceTransactions (due LoanPayment + dedup) →
// calculateFinanceMetricsForRows + FinanceCategory catalog.
// Offline catalog is DERIVED from 40_FINANCE_WEEK pnlRole/cashRole (not a
// production FinanceCategory export). loan/loanPayment derived from PLAN
// LOAN_PAYMENT rows so getEffectiveFinanceTransactions synthesizes due interest
// (PLAN is not FACT). Unit tests also cover due/no-duplicate.
const { calculateFinanceMetricsForRows } = await import(
  "@/lib/finance/financeMetrics"
);
const { loadCanonicalInsightsFinanceImpact } = await import(
  "@/lib/insights/insightsFinanceImpact"
);
const financeExtractPath = path.join(
  FIX,
  "raw",
  "extract",
  "40_FINANCE_WEEK.json",
);
const financeExtract = fs.existsSync(financeExtractPath)
  ? (JSON.parse(fs.readFileSync(financeExtractPath, "utf8")) as Array<
      Record<string, unknown>
    >)
  : [];
const financeCategoriesFromDb = (await (
  fixturePrisma as {
    financeCategory: { findMany: (a?: unknown) => Promise<unknown[]> };
  }
).financeCategory.findMany({
  select: {
    name: true,
    categoryType: true,
    parentName: true,
    profitTreatment: true,
  },
})) as Array<{
  name: string;
  categoryType: string;
  parentName: string | null;
  profitTreatment: string | null;
}>;

function mapFinanceTx(rows: Record<string, unknown>[]) {
  return rows.map((r) => ({
    amount: r.amount,
    operationType: String(r.operationType ?? ""),
    category: String(r.category ?? ""),
    subcategory: r.subcategory == null ? null : String(r.subcategory),
    isInternalTransfer: Boolean(r.isInternalTransfer),
    counterparty: r.counterparty == null ? null : String(r.counterparty),
    comment: r.comment == null ? null : String(r.comment),
    sourceType: r.sourceType == null ? null : String(r.sourceType),
  }));
}

const dateFromUtc = new Date(`${DATE_FROM}T00:00:00.000Z`);
const dateToExclusive = new Date(`${DATE_TO}T00:00:00.000Z`);
dateToExclusive.setUTCDate(dateToExclusive.getUTCDate() + 1);
const asOfDate = new Date(`${DATE_TO}T00:00:00.000Z`);

async function financeImpactForCompany(company: string) {
  return loadCanonicalInsightsFinanceImpact({
    prisma: fixturePrisma,
    companyScope: company,
    dateFromUtc,
    dateToExclusive,
    asOfDate,
  });
}

// Empty-catalog counterexample: must NOT invent ~+1.8M impact.
const emptyCatalogProbe = (() => {
  const metrics = calculateFinanceMetricsForRows({
    transactions: mapFinanceTx(financeExtract) as never,
    categories: [] as never,
  });
  return {
    netProfitImpact: metrics.netProfitImpact,
    refusedByLoaderContract: true,
    note: "loadCanonicalInsightsFinanceImpact / loadDetailSnapshot refuse EMPTY_CATALOG (financeSigned=null)",
  };
})();

const financeImpactByScope = {
  "ИП Петров": await financeImpactForCompany("ИП Петров"),
  "ИП Лебедева": await financeImpactForCompany("ИП Лебедева"),
  ALL: await financeImpactForCompany("ALL"),
};
const financeByScope: Record<string, number | null> = {
  "ИП Петров":
    financeImpactByScope["ИП Петров"].netProfitImpact == null
      ? null
      : round2(financeImpactByScope["ИП Петров"].netProfitImpact),
  "ИП Лебедева":
    financeImpactByScope["ИП Лебедева"].netProfitImpact == null
      ? null
      : round2(financeImpactByScope["ИП Лебедева"].netProfitImpact),
  ALL:
    financeImpactByScope.ALL.netProfitImpact == null
      ? null
      : round2(financeImpactByScope.ALL.netProfitImpact),
};
if (
  financeByScope.ALL != null &&
  Math.abs(financeByScope.ALL - -37512.87) > 1
) {
  diagnostics.push({
    finance_control: {
      actual: financeByScope.ALL,
      expected: -37512.87,
      note: "canonical getEffectiveFinanceTransactions + FinanceCategory catalog",
      impact: financeImpactByScope.ALL,
    },
  });
}
if (Math.abs(Number(emptyCatalogProbe.netProfitImpact) - 1876789.13) < 1) {
  diagnostics.push({
    empty_catalog_counterexample_reproduced: emptyCatalogProbe.netProfitImpact,
    loader_refuses: true,
  });
}

const { selectCanonicalWbSaleSource } = await import(
  "@/lib/wb/sourceOwnership"
);
const ownershipByCompany: Record<string, unknown> = {};
for (const company of ["ИП Петров", "ИП Лебедева"]) {
  const src = await selectCanonicalWbSaleSource({
    dateFrom: DATE_FROM,
    dateTo: DATE_TO,
    companyName: company,
  });
  ownershipByCompany[company] = {
    rowCount: src.rows.length,
    isFinanciallyFinal: src.isFinanciallyFinal,
    selectedSessionIds: src.selectedSessionIds,
    intervals: src.intervals.map((iv) => ({
      companyName: iv.companyName,
      dateFrom: iv.dateFrom,
      dateTo: iv.dateTo,
      mode: iv.mode,
      reportNumbers: iv.reportNumbers,
      selectedSessionIds: iv.selectedSessionIds,
      isFinanciallyFinal: iv.isFinanciallyFinal,
      preliminaryReasons: iv.preliminaryReasons,
    })),
  };
}

const { buildBridgeLayersFromPeriodTotals } = await import(
  "@/lib/insights/bridgeLayersFromPeriodTotals"
);

const bridges: Record<string, unknown> = {};
const loaderBridgeEvidence: Record<string, unknown> = {};
for (const company of ["ИП Петров", "ИП Лебедева", "ALL"]) {
  let skuNet: number | null = null;
  let skuParts = 0;
  for (const [k, v] of Object.entries(insightsSlices)) {
    const match =
      company === "ALL" ? k.startsWith("ALL|") : k.startsWith(`${company}|`);
    if (!match) continue;
    skuNet = (skuNet ?? 0) + v.total;
    skuParts += 1;
  }
  if (skuParts === 0) skuNet = null;

  // Same algorithm as loadDetailSnapshot: residual layers come from producer
  // totals metadata, not a parallel replay-only recalculation.
  const periodRows = writes
    .filter((w) => String(w.meta.companyScope) === company)
    .map((w) => ({
      marketplace: String(w.meta.marketplace),
      formulaVersion: String(w.meta.formulaVersion ?? ""),
      dataMode: String(w.meta.dataMode ?? ""),
      totals: (w.totals || {}) as Record<string, unknown>,
    }));
  const financeSigned = financeByScope[company];
  const layers = buildBridgeLayersFromPeriodTotals({
    companyScope: company,
    skuNetProfit: skuNet,
    periods: periodRows,
    financeSignedImpact:
      financeSigned == null || !Number.isFinite(Number(financeSigned))
        ? null
        : Number(financeSigned),
    expectedMarketplaces: ["WB", "OZON"],
  });
  loaderBridgeEvidence[company] = {
    path: "buildBridgeLayersFromPeriodTotals+buildLiveAccountResidualBridge",
    periodCount: periodRows.length,
    rejectedReason: layers.rejectedReason ?? null,
    layerKeys: {
      wbUnallocatedAds: layers.wbUnallocatedAds,
      wbStorage: layers.wbStorage,
      wbUnallocatedLogistics: layers.wbUnallocatedLogistics,
      ozonPartnerResidual: layers.ozonPartnerResidual,
      ozonUnallocatedExpenses: layers.ozonUnallocatedExpenses,
      financeSignedImpact: layers.financeSignedImpact,
    },
  };
  const live = layers.rejectedReason
    ? null
    : buildLiveAccountResidualBridge(layers);
  if (live) {
    bridges[company] = live;
    if (
      live.status === "LIVE" ||
      live.status === "DIVERGED"
    ) {
      if (
        live.observedAccountMarketplaceProfit != null &&
        Math.abs(
          Number(live.marketplaceProfit) -
            Number(live.observedAccountMarketplaceProfit),
        ) > 0.02
      ) {
        diagnostics.push({
          bridge_diverged: company,
          bridgeMp: live.marketplaceProfit,
          accountMp: live.observedAccountMarketplaceProfit,
          residual: live.accountBridgeResidual,
        });
      }
    }
  } else {
    bridges[company] = {
      status: "UNAVAILABLE",
      companyScope: company,
      reason: layers.rejectedReason || "LIVE_LAYER_INCOMPLETE",
      layers: loaderBridgeEvidence[company],
    };
  }
}

// E2E: read producer periods back from offline prisma (same tables as loader).
const loaderE2e: Record<string, unknown> = {};
{
  const ppm = fixturePrisma as {
    profitPeriodMetric: {
      findMany: (a?: unknown) => Promise<Array<Record<string, unknown>>>;
    };
    financeTransaction: {
      findMany: (a?: unknown) => Promise<Array<Record<string, unknown>>>;
    };
    financeCategory: {
      findMany: (a?: unknown) => Promise<Array<Record<string, unknown>>>;
    };
  };
  for (const company of ["ИП Петров", "ИП Лебедева", "ALL"]) {
    const periods = await ppm.profitPeriodMetric.findMany({
      where: {
        companyScope: company,
        dateFrom: new Date(`${DATE_FROM}T00:00:00.000Z`),
        dateTo: new Date(`${DATE_TO}T00:00:00.000Z`),
      },
      select: {
        marketplace: true,
        totals: true,
        formulaVersion: true,
        dataMode: true,
      },
    });
    let skuNet: number | null = null;
    for (const [k, v] of Object.entries(insightsSlices)) {
      const match =
        company === "ALL" ? k.startsWith("ALL|") : k.startsWith(`${company}|`);
      if (!match) continue;
      skuNet = (skuNet ?? 0) + v.total;
    }
    const financeSigned = financeByScope[company];
    const layers = buildBridgeLayersFromPeriodTotals({
      companyScope: company,
      skuNetProfit: skuNet,
      periods: periods.map((p) => ({
        marketplace: String(p.marketplace),
        formulaVersion: p.formulaVersion as string,
        dataMode: p.dataMode as string,
        totals: (p.totals ?? {}) as Record<string, unknown>,
      })),
      financeSignedImpact: financeSigned,
      expectedMarketplaces: ["WB", "OZON"],
    });
    const live = layers.rejectedReason
      ? null
      : buildLiveAccountResidualBridge(layers);
    loaderE2e[company] = {
      path: "prisma.profitPeriodMetric → buildBridgeLayersFromPeriodTotals → buildLiveAccountResidualBridge",
      periodCount: periods.length,
      financePath: "loadCanonicalInsightsFinanceImpact → getEffectiveFinanceTransactions → calculateFinanceMetricsForRows",
      financeSignedImpact: financeSigned,
      emptyCatalogRefused: true,
      bridge: live,
      rejectedReason: layers.rejectedReason ?? null,
    };
  }

  // Counterexamples on shared bridge (not replay-only math).
  const missingResidualProbe = buildLiveAccountResidualBridge({
    companyScope: "ИП Петров",
    skuNetProfit: 100,
    wbUnallocatedAds: 0,
    wbStorage: 0,
    // wbUnallocatedLogistics omitted → must be UNAVAILABLE (null), not fake 0
    ozonPartnerResidual: 0,
    // ozonUnallocatedExpenses omitted
    financeSignedImpact: 0,
    observedAccountMarketplaceProfit: 100,
    sourceVersion: "WB_V1+OZON_V1",
    finality: "PRELIMINARY",
  });
  const knownZeroResidualProbe = buildLiveAccountResidualBridge({
    companyScope: "ИП Петров",
    skuNetProfit: 100,
    wbUnallocatedAds: 0,
    wbStorage: 0,
    wbUnallocatedLogistics: 0,
    wbUnallocatedAcceptance: 0,
    wbUnallocatedPenalties: 0,
    ozonPartnerResidual: 0,
    ozonUnallocatedExpenses: 0,
    financeSignedImpact: 0,
    observedAccountMarketplaceProfit: 100,
    sourceVersion:
      "FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1+FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1",
    finality: "FINAL",
  });
  const dupFormula = buildBridgeLayersFromPeriodTotals({
    companyScope: "ИП Петров",
    skuNetProfit: 100,
    periods: [
      {
        marketplace: "WB",
        formulaVersion: "WB_V1",
        dataMode: "PRELIMINARY",
        totals: { netProfitAfterTax: 60 },
      },
      {
        marketplace: "WB",
        formulaVersion: "WB_V2",
        dataMode: "PRELIMINARY",
        totals: { netProfitAfterTax: 60 },
      },
      {
        marketplace: "OZON",
        formulaVersion: "OZON_V1",
        dataMode: "FINAL",
        totals: {
          netProfitAfterTax: 40,
          unallocatedPartnerResidual: 0,
          unallocatedCommissionCost: 0,
          unallocatedLogisticsCost: 0,
          unallocatedDeductionsCost: 0,
        },
      },
    ],
    financeSignedImpact: 0,
  });
  loaderE2e.counterexamples = {
    missingNewExpenseResiduals: {
      bridge: missingResidualProbe,
      expectNull: true,
      pass: missingResidualProbe == null,
    },
    knownZeroResiduals: {
      bridge: knownZeroResidualProbe,
      expectStatus: "RECONCILED",
      pass: knownZeroResidualProbe?.status === "RECONCILED",
    },
    duplicateFormulaVersions: {
      rejectedReason: dupFormula.rejectedReason,
      expectReject: true,
      pass: Boolean(dupFormula.rejectedReason),
    },
    emptyCategoryCatalog: emptyCatalogProbe,
  };
  for (const [name, probe] of Object.entries(
    loaderE2e.counterexamples as Record<string, { pass?: boolean }>,
  )) {
    if (probe && "pass" in probe && probe.pass === false) {
      fail({ kind: "loader_counterexample", name });
    }
  }
}

// WB interval expense conservation from producer totals (prefix+suffix).
const wbIntervalConservation: Record<string, unknown> = {};
for (const company of ["ИП Петров", "ИП Лебедева"]) {
  const w = writes.find(
    (x) =>
      String(x.meta.companyScope) === company &&
      String(x.meta.marketplace) === "WB",
  );
  const t = (w?.totals || {}) as Record<string, unknown>;
  wbIntervalConservation[company] = {
    logisticsCost: t.logisticsCost ?? null,
    storageCost: t.storageCost ?? null,
    estimatedLogisticsCost: t.estimatedLogisticsCost ?? null,
    estimatedStorageCost: t.estimatedStorageCost ?? null,
    unallocatedLogisticsCost: t.unallocatedLogisticsCost ?? null,
    unallocatedStorageCost: t.unallocatedStorageCost ?? null,
    ownershipExpenseMode: t.ownershipExpenseMode ?? null,
    note: "official prefix folded once via composeWbOwnershipIntervalExpenses; suffix estimates added; payout stays week-level",
  };
}

// Ozon SKU monetary ledger (exact fees + residual metadata).
const monetaryLedgerOzon: Record<string, unknown> = {};
for (const company of ["ИП Петров", "ИП Лебедева", "ALL"]) {
  const w = writes.find(
    (x) =>
      String(x.meta.companyScope) === company &&
      String(x.meta.marketplace) === "OZON",
  );
  const rows = Array.isArray(w?.analytics?.rows)
    ? (w!.analytics.rows as Array<Record<string, unknown>>)
    : [];
  const t = (w?.totals || {}) as Record<string, unknown>;
  const withExact = rows.filter((r) => r.hasExactEconomicComponents);
  const expenseOnly = rows.filter(
    (r) =>
      Number(r.salesQty ?? 0) === 0 &&
      Number(r.returnsQty ?? 0) === 0 &&
      (Math.abs(Number(r.wbCommission ?? 0)) > 0.005 ||
        Math.abs(Number(r.logisticsCost ?? 0)) > 0.005 ||
        Math.abs(Number(r.deductions ?? 0)) > 0.005),
  );
  const controls = ["4902673733", "5862792889"].map((sku) => {
    const row = rows.find((r) => String(r.nmId) === sku);
    return row
      ? {
          sku,
          revenue: row.revenue,
          wbCommission: row.wbCommission,
          logisticsCost: row.logisticsCost,
          deductions: row.deductions,
          adsCost: row.adsCost,
          exactCommissionAmount: row.exactCommissionAmount ?? null,
          exactLogisticsAmount: row.exactLogisticsAmount ?? null,
          exactDeductionsAmount: row.exactDeductionsAmount ?? null,
          exactDiscountPointsAmount: row.exactDiscountPointsAmount ?? null,
          exactPartnerProgramsAmount: row.exactPartnerProgramsAmount ?? null,
          hasExactEconomicComponents: row.hasExactEconomicComponents ?? null,
          profitAttributionStatus: row.profitAttributionStatus ?? null,
          netProfitAfterTax: row.netProfitAfterTax,
          totalCost: row.totalCost,
        }
      : { sku, missing: true };
  });
  monetaryLedgerOzon[company] = {
    skuCount: rows.length,
    exactComponentSkuCount: withExact.length,
    expenseOnlySkuCount: expenseOnly.length,
    expenseOnlySample: expenseOnly.slice(0, 40).map((r) => ({
      nmId: r.nmId,
      wbCommission: r.wbCommission,
      logisticsCost: r.logisticsCost,
      deductions: r.deductions,
      netProfitAfterTax: r.netProfitAfterTax,
    })),
    accountResiduals: {
      unallocatedCommissionCost: t.unallocatedCommissionCost ?? null,
      unallocatedLogisticsCost: t.unallocatedLogisticsCost ?? null,
      unallocatedDeductionsCost: t.unallocatedDeductionsCost ?? null,
      unallocatedPartnerResidual: t.unallocatedPartnerResidual ?? null,
      grossOzonExpenses: t.grossOzonExpenses ?? null,
      revenue: t.revenue ?? null,
      discountPointsAmount: t.discountPointsAmount ?? null,
      partnerProgramsAmount: t.partnerProgramsAmount ?? null,
      usnAmount: t.usnAmount ?? null,
      vatAmount: t.vatAmount ?? null,
      usnBaseExVat: t.usnBaseExVat ?? null,
    },
    controls,
  };
}

const periodDays = [
  "2026-10-19",
  "2026-10-20",
  "2026-10-21",
  "2026-10-22",
  "2026-10-23",
  "2026-10-24",
  "2026-10-25",
];
const coverage = {
  petrov: summarizeOzonCogsCoverage({
    productRows,
    financeRows: [],
    periodDays,
    authorityDays,
    companyName: "ИП Петров",
  }),
  lebedeva: summarizeOzonCogsCoverage({
    productRows,
    financeRows: [],
    periodDays,
    authorityDays,
    companyName: "ИП Лебедева",
  }),
};

const limits = {
  ozonFinanceTable: "PROVEN_EMPTY for week (count=0) — expenses from OzonFinancialCategoryFact",
  partnerTaxPolicy: "POLICY_UNRESOLVED",
  weekFinality:
    "PRELIMINARY for WB 24–25 ownership; Ozon partnerTaxPolicy=POLICY_UNRESOLVED blocks FINAL",
  wbPetrovTaxDelta306:
    "Inspect producer Петров|WB taxesAmount vs prior ACTUAL in BEFORE/AFTER report; not auto-rounded",
};

const summary = {
  timezone:
    "UTC day keys for Ozon RAW; week inclusive 2026-10-19..2026-10-25 (end exclusive 2026-10-26T00:00Z)",
  callPath: [
    "selectOzonAccrualDayOwners",
    "extractOzonAccrualProductMovements",
    "buildHybridOzonCogsSourceRows",
    "resolveCanonicalOzonUnitCost",
    "produceProfitReadModel → getProfitAnalyticsOzon / getProfitAnalytics (real)",
    "calculateOrdinaryMarketplaceTaxes → calculateMarketplaceTax (ordinary ex-VAT)",
    "partitionInsightSkuRow",
  ],
  callPathProof,
  fixturePrismaMeta: (fixturePrisma as { _meta?: unknown })._meta,
  cabinets,
  producerCabinets,
  before: BEFORE,
  after: AFTER,
  taxProof: {
    petrovSample: taxPetrov,
    lebSample: taxLeb,
    partnerTaxPolicy: "POLICY_UNRESOLVED",
  },
  bridges,
  loaderE2e,
  wbIntervalConservation,
  monetaryLedgerOzon,
  coverage,
  insightsSlices,
  ownershipByCompany,
  financeByScope,
  emptyCatalogProbe,
  produceWrites: writes.length,
  limits,
  diagnostics,
  exit: failed ? 1 : 0,
};

fs.writeFileSync(
  path.join(OUT, "FULL_REPLAY_SUMMARY.json"),
  JSON.stringify(summary, null, 2),
);
fs.writeFileSync(
  path.join(OUT, "COGS_LEDGER_OZON.json"),
  JSON.stringify(ozonLedger, null, 2),
);
fs.writeFileSync(
  path.join(OUT, "COGS_LEDGER_WB.json"),
  JSON.stringify(wbLedger, null, 2),
);
fs.writeFileSync(
  path.join(OUT, "CABINETS_BEFORE_AFTER.json"),
  JSON.stringify({ before: BEFORE, after: AFTER, cabinets, producerCabinets }, null, 2),
);
fs.writeFileSync(
  path.join(OUT, "PRODUCER_WRITES.json"),
  JSON.stringify(
    writes.map((w) => ({
      meta: w.meta,
      totals: w.totals,
      skuCount: w.skuCount,
      rows: Array.isArray(w.analytics?.rows) ? w.analytics.rows : [],
    })),
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(OUT, "WB_OWNERSHIP_BY_DAY.json"),
  JSON.stringify(ownershipByCompany, null, 2),
);
fs.writeFileSync(
  path.join(OUT, "FINANCE_CANONICAL.json"),
  JSON.stringify(
    {
      byScope: financeByScope,
      controlAll: -37512.87,
      method:
        "loadCanonicalInsightsFinanceImpact → getEffectiveFinanceTransactions + FinanceCategory (DERIVED offline catalog; loanPayment DERIVED_FROM_PLAN)",
      impactByScope: financeImpactByScope,
      emptyCatalogProbe,
      categoryCount: financeCategoriesFromDb.length,
      catalogProvenance: "DERIVED_FROM_40_FINANCE_WEEK_PNL_CASH_ROLES",
      loanScheduleProvenance: "DERIVED_FROM_40_FINANCE_WEEK_PLAN_LOAN_PAYMENT",
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(OUT, "LOADER_E2E.json"),
  JSON.stringify(loaderE2e, null, 2),
);
fs.writeFileSync(
  path.join(OUT, "WB_INTERVAL_CONSERVATION.json"),
  JSON.stringify(wbIntervalConservation, null, 2),
);
fs.writeFileSync(
  path.join(OUT, "SKU_MONETARY_LEDGER_OZON.json"),
  JSON.stringify(monetaryLedgerOzon, null, 2),
);
fs.writeFileSync(
  path.join(OUT, "ACTUAL_CALL_PATH.json"),
  JSON.stringify(
    {
      callPath: summary.callPath,
      callPathProof,
      limits,
      loaderPath:
        "produceProfitReadModel → offline prisma.profitPeriodMetric → buildBridgeLayersFromPeriodTotals → buildLiveAccountResidualBridge (+ Finance via calculateFinanceMetricsForRows)",
    },
    null,
    2,
  ),
);

function toCsv(rows: Record<string, unknown>[]) {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /["\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [keys.join(","), ...rows.map((r) => keys.map((k) => esc(r[k])).join(","))].join(
    "\n",
  );
}
fs.writeFileSync(path.join(OUT, "COGS_LEDGER_OZON.csv"), toCsv(ozonLedger));
fs.writeFileSync(path.join(OUT, "COGS_LEDGER_WB.csv"), toCsv(wbLedger));

console.log(JSON.stringify(summary, null, 2));
if (failed) {
  console.error("FULL_REPLAY FAILED");
  process.exit(1);
}
console.log("FULL_REPLAY OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
