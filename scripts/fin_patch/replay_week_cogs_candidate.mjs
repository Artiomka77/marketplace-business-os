#!/usr/bin/env node
/**
 * Real candidate replay: runs changed parsers/classifiers/cost resolver on
 * saved RAW fixtures. Does NOT sum e.expectedNetCOGS as production COGS.
 *
 * Usage:
 *   node scripts/fin_patch/replay_week_cogs_candidate.mjs [fixturesRoot] [outDir]
 *
 * fixturesRoot must contain:
 *   raw/ozon_primary/raw_session_*.json
 *   raw/extract/RAW_PRODUCT_COST.json
 *   raw/extract/10_WB_EVENTS.json
 *   raw/extract/20_OZON_EVENTS.json (oracle only)
 *   raw/extract/21_OZON_SKU.json (sku→vendor)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WT = path.resolve(__dirname, "../..");

async function loadTs(rel) {
  const full = path.join(WT, rel);
  return import(pathToFileURL(full).href);
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}

function resolveFixturesRoot(argvRoot) {
  if (argvRoot && fs.existsSync(argvRoot)) return path.resolve(argvRoot);
  const env = process.env.FIN_READY_FIXTURES;
  if (env && fs.existsSync(env)) return path.resolve(env);
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
  throw new Error(
    "Fixtures not found. Pass fixtures root or set FIN_READY_FIXTURES.",
  );
}

const FIX = resolveFixturesRoot(process.argv[2]);
const OUT = path.resolve(
  process.argv[3] || path.join(WT, "scripts/fin_patch/out_replay"),
);
fs.mkdirSync(OUT, { recursive: true });

const {
  extractOzonAccrualProductMovements,
  mapMovementsToCogsProductRows,
  buildOzonAccrualAuthorityDays,
} = await loadTs("lib/ozon/ozonAccrualProductMovements.ts");
const {
  buildHybridOzonCogsSourceRows,
  summarizeOzonCogsCoverage,
} = await loadTs("lib/analytics/ozonCogsHybridSource.ts");
const {
  buildCanonicalPositiveCostLookups,
  resolveCanonicalOzonUnitCost,
} = await loadTs("lib/analytics/productCostResolver.ts");
const { classifyCanonicalWbProductOperation } = await loadTs(
  "lib/wb/wbProductOperationClassify.ts",
);
const { partitionInsightSkuRow } = await loadTs(
  "lib/insights/insightsSkuPartition.ts",
);
const {
  buildAccountResidualBridge,
  WEEK_2026_10_19_25_ACCEPTED_BRIDGE,
} = await loadTs("lib/insights/accountResidualBridge.ts");

const costsRaw = JSON.parse(
  fs.readFileSync(
    path.join(FIX, "raw/extract/RAW_PRODUCT_COST.json"),
    "utf8",
  ),
);
const costs = (Array.isArray(costsRaw) ? costsRaw : costsRaw.rows || []).map(
  (c) => ({
    id: c.id,
    vendorCode: c.vendorCode,
    nmId: c.nmId,
    costPrice: c.cost ?? c.costPrice,
    costDate: c.costDate,
    createdAt: c.createdAt,
  }),
);
const ozonLookups = buildCanonicalPositiveCostLookups(costs);

const skuMap = JSON.parse(
  fs.readFileSync(path.join(FIX, "raw/extract/21_OZON_SKU.json"), "utf8"),
);
const vendorBySku = new Map();
for (const row of Array.isArray(skuMap) ? skuMap : []) {
  if (row.sku && row.vendorCode) vendorBySku.set(String(row.sku), row.vendorCode);
}

const primaryDir = path.join(FIX, "raw/ozon_primary");
const sessionFiles = fs
  .readdirSync(primaryDir)
  .filter((f) => f.startsWith("raw_session_") && f.endsWith(".json"));

const allMovements = [];
const authorityDays = [];
for (const file of sessionFiles) {
  const j = JSON.parse(fs.readFileSync(path.join(primaryDir, file), "utf8"));
  const company = j.meta?.company || j.meta?.companyName;
  const sessionId = j.meta?.sessionId || file;
  const movements = extractOzonAccrualProductMovements({
    companyName: company,
    sessionId,
    rawAccruals: j.rawAccruals || [],
    dateFrom: "2026-10-19",
    dateTo: "2026-10-25",
  });
  allMovements.push(...movements);
  authorityDays.push(
    ...buildOzonAccrualAuthorityDays({
      companyName: company,
      sessionId,
      requestedDates: j.meta?.requestedDates || [j.meta?.dateFrom].filter(Boolean),
      movements,
      coverageComplete: true,
    }),
  );
}

const productRows = mapMovementsToCogsProductRows(allMovements, vendorBySku);

// Finance ads service row must survive hybrid even on covered days
const financeProbe = [
  {
    companyName: "ИП Петров",
    sku: null,
    quantity: 0,
    salesAmount: 0,
    totalAmount: -12,
    accrualDate: new Date("2026-10-19T00:00:00.000Z"),
    operationType: "Оплата за клик",
  },
];
const hybrid = buildHybridOzonCogsSourceRows({
  productRows,
  financeRows: financeProbe,
  authorityDays,
});
if (!hybrid.some((r) => r.operationType === "Оплата за клик")) {
  console.error("FAIL: ads finance row dropped by hybrid");
  process.exit(1);
}

function resolveUnitCost(vendorCode, sku) {
  const resolved = resolveCanonicalOzonUnitCost({
    vendorCode,
    sku,
    costByVendorCode: ozonLookups.costByVendorCode,
    costByNmId: ozonLookups.costByNmId,
    costByVendorFamily: ozonLookups.costByVendorFamily,
  });
  return {
    unitCost: resolved.unitCost,
    costSource: resolved.source,
    vendorCode: vendorCode || null,
  };
}

const ozonLedger = [];
const ozonByCompany = {};
for (const m of allMovements) {
  const vendor = vendorBySku.get(m.sku) || null;
  const resolved = resolveUnitCost(vendor, m.sku);
  const qty = m.quantityKnown ? m.quantity : null;
  let cogs = null;
  let missingReason = null;
  if (!m.quantityKnown) missingReason = "UNKNOWN_QUANTITY";
  else if (resolved.unitCost == null) missingReason = "MISSING_COST_OR_MAPPING";
  else cogs = round2(qty * resolved.unitCost * (m.kind === "RETURN" ? -1 : 1));

  const row = {
    marketplace: "OZON",
    company: m.companyName,
    eventKind: m.kind,
    sourceId: m.eventId,
    sessionId: m.sessionId,
    day: m.operationDay,
    sku: m.sku,
    vendorCode: vendor,
    soldQty: m.kind === "SALE" ? qty : 0,
    returnQty: m.kind === "RETURN" ? qty : 0,
    netQty: m.kind === "SALE" ? qty : m.kind === "RETURN" ? -qty : 0,
    unitCost: resolved.unitCost,
    unitCostSource: resolved.costSource,
    actualNetCOGS: cogs,
    quantityKnown: m.quantityKnown,
    missingReason,
  };
  ozonLedger.push(row);
  const bucket = (ozonByCompany[m.companyName] ||= {
    sold: 0,
    returned: 0,
    cogs: 0,
    missing: 0,
  });
  if (m.kind === "SALE" && qty != null) bucket.sold += qty;
  if (m.kind === "RETURN" && qty != null) bucket.returned += qty;
  if (cogs != null) bucket.cogs = round2(bucket.cogs + cogs);
  else bucket.missing += 1;
}

const wbEvents = JSON.parse(
  fs.readFileSync(path.join(FIX, "raw/extract/10_WB_EVENTS.json"), "utf8"),
);
const wbLedger = [];
const wbByCompany = {};
for (const e of wbEvents) {
  const classified = classifyCanonicalWbProductOperation({
    paymentReason: e.paymentReason,
    documentType: e.documentType,
  });
  const acceptedKind = e.eventKind;
  // Classifier gates physical COGS; quantities from owned event rows.
  let soldQty = 0;
  let returnQty = 0;
  if (classified === "SALE") {
    soldQty = Math.abs(Number(e.soldQty ?? e.qtyRaw ?? 0));
  } else if (classified === "RETURN") {
    returnQty = Math.abs(Number(e.returnQty ?? e.qtyRaw ?? 0));
  }

  const fixtureCost =
    e.unitCost != null && Number(e.unitCost) > 0 ? Number(e.unitCost) : null;
  const resolved = resolveUnitCost(e.vendorCode, e.nmId);
  const unitCost = fixtureCost ?? resolved.unitCost;
  let cogs = null;
  let missingReason = null;
  if (classified === "OTHER") {
    missingReason = "NON_PRODUCT_OPERATION";
  } else if (unitCost == null) {
    missingReason = "MISSING_COST_OR_MAPPING";
  } else if (!e.quantityFound && soldQty === 0 && returnQty === 0) {
    missingReason = "UNKNOWN_QUANTITY";
  } else {
    cogs = round2((soldQty - returnQty) * unitCost);
  }

  wbLedger.push({
    marketplace: "WB",
    company: e.company,
    sourceId: e.sourceId,
    day: e.day,
    nmId: e.nmId,
    vendorCode: e.vendorCode,
    paymentReason: e.paymentReason,
    documentType: e.documentType,
    classified,
    acceptedEventKind: acceptedKind,
    soldQty,
    returnQty,
    netQty: soldQty - returnQty,
    unitCost,
    unitCostSource: fixtureCost != null ? "fixture.unitCost" : resolved.costSource,
    actualNetCOGS: cogs,
    isFinanciallyFinal: e.isFinanciallyFinal,
    missingReason,
  });

  const bucket = (wbByCompany[e.company] ||= {
    sold: 0,
    returned: 0,
    cogs: 0,
    other: 0,
  });
  bucket.sold += soldQty;
  bucket.returned += returnQty;
  if (cogs != null) bucket.cogs = round2(bucket.cogs + cogs);
  if (classified === "OTHER") bucket.other += 1;
}

const compensationHit = wbLedger.find(
  (r) => r.sourceId === "cmvm9i33i000fstk5pbrkinut",
);
if (!compensationHit || compensationHit.classified !== "OTHER") {
  console.error("FAIL: WB compensation classifier", compensationHit);
  process.exit(1);
}

const EXPECTED = {
  "ИП Петров|OZON": { sold: 1309, returned: 85, cogs: 1141195 },
  "ИП Лебедева|OZON": { sold: 15, returned: 1, cogs: 11890 },
  "ИП Петров|WB": { sold: 349, returned: 29, cogs: 267305 },
  "ИП Лебедева|WB": { sold: 4, returned: 0, cogs: 3425 },
};

const cabinets = [];
for (const [company, stats] of Object.entries(ozonByCompany)) {
  cabinets.push({
    company,
    marketplace: "OZON",
    actual: {
      sold: stats.sold,
      returned: stats.returned,
      cogs: round2(stats.cogs),
    },
    expected: EXPECTED[`${company}|OZON`],
  });
}
for (const [company, stats] of Object.entries(wbByCompany)) {
  cabinets.push({
    company,
    marketplace: "WB",
    actual: {
      sold: stats.sold,
      returned: stats.returned,
      cogs: round2(stats.cogs),
    },
    expected: EXPECTED[`${company}|WB`],
  });
}

let failed = false;
const diagnostics = [];
for (const c of cabinets) {
  if (!c.expected) continue;
  const dSold = c.actual.sold - c.expected.sold;
  const dRet = c.actual.returned - c.expected.returned;
  const dCogs = round2(c.actual.cogs - c.expected.cogs);
  const ok = dSold === 0 && dRet === 0 && Math.abs(dCogs) < 0.02;
  if (!ok) {
    failed = true;
    diagnostics.push({
      cabinet: `${c.company}|${c.marketplace}`,
      delta: { sold: dSold, returned: dRet, cogs: dCogs },
      actual: c.actual,
      expected: c.expected,
    });
  }
}

// Insights partition on saved SKU metrics
const skuMetricsPath = path.join(FIX, "raw/extract/51_SKU_METRICS.json");
let insightsCheck = null;
if (fs.existsSync(skuMetricsPath)) {
  const metrics = JSON.parse(fs.readFileSync(skuMetricsPath, "utf8"));
  const rows = Array.isArray(metrics) ? metrics : metrics.rows || [];
  const slices = {};
  for (const row of rows) {
    const payload = row.payload && typeof row.payload === "object" ? row.payload : row;
    const company = row.companyScope || row.companyName || row.company || "ALL";
    const mp = String(row.marketplace || "").toUpperCase().includes("OZON")
      ? "OZON"
      : "WB";
    const key = `${company}|${mp}`;
    const revenue = Number(payload.revenue ?? 0);
    const profit = Number(
      payload.netProfitAfterTax ?? payload.profit ?? payload.netProfit ?? 0,
    );
    const part = partitionInsightSkuRow({ revenue, profit });
    const s = (slices[key] ||= { sold: 0, adjustments: 0, total: 0, count: 0 });
    s.count += 1;
    s.total += profit;
    if (part.bucket === "sold") s.sold += profit;
    else s.adjustments += profit;
  }
  insightsCheck = Object.entries(slices).map(([k, v]) => ({
    key: k,
    ...v,
    residual: round2(v.sold + v.adjustments - v.total),
  }));
  if (insightsCheck.some((s) => Math.abs(s.residual) > 0.01)) {
    failed = true;
    diagnostics.push({ insights_partition_residual: insightsCheck });
  }
}

const bridge = buildAccountResidualBridge(WEEK_2026_10_19_25_ACCEPTED_BRIDGE);
if (Math.abs(bridge.skuToMarketplaceGap - 143921.18) > 0.02) {
  failed = true;
  diagnostics.push({ bridge_gap: bridge.skuToMarketplaceGap });
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
const coveragePetrov = summarizeOzonCogsCoverage({
  productRows,
  financeRows: [],
  periodDays,
  authorityDays,
  companyName: "ИП Петров",
});
const coverageLeb = summarizeOzonCogsCoverage({
  productRows,
  financeRows: [],
  periodDays,
  authorityDays,
  companyName: "ИП Лебедева",
});

const summary = {
  fixturesRoot: FIX,
  callPath: [
    "ImportSession.previewJson.rawAccruals",
    "extractOzonAccrualProductMovements",
    "mapMovementsToCogsProductRows",
    "buildHybridOzonCogsSourceRows",
    "buildCanonicalPositiveCostLookups × signed qty",
    "classifyCanonicalWbProductOperation / owned WB events",
  ],
  cabinets,
  diagnostics,
  coverage: { petrov: coveragePetrov, lebedeva: coverageLeb },
  bridge,
  insightsCheck,
  ozonEventCount: ozonLedger.length,
  wbEventCount: wbLedger.length,
  exit: failed ? 1 : 0,
};

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
  JSON.stringify(cabinets, null, 2),
);
fs.writeFileSync(path.join(OUT, "REPLAY_SUMMARY.json"), JSON.stringify(summary, null, 2));

// CSV
function toCsv(rows) {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]);
  const esc = (v) => {
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
  console.error("REPLAY FAILED");
  process.exit(1);
}
console.log("REPLAY OK");
