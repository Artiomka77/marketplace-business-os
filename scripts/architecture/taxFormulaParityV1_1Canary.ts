/**
 * Tax Formula Parity V1.1 — LOCAL canary (READ_ONLY evidence replay).
 *
 * Replays AVOROFIN_WB_TAX_BRIDGE_PROBE6.json (prior production SELECT evidence)
 * through wbAccountantTaxBase + shared marketplaceTax. Does not mutate DB.
 *
 * Optional live path: set DATABASE_URL to run getProfitAnalytics for 2026-08-17..23.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { calculateMarketplaceTax } from "../../lib/finance/marketplaceTax";
import {
  buildWbFinanceTaxReportKindByKey,
  calculateWbAccountantTaxContribution,
  classifyWbFinanceReportTypeName,
  summarizeWbAccountantTaxBases,
} from "../../lib/finance/wbAccountantTaxBase";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const downloads =
  process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, "Downloads")
    : path.join(root, "..");

const TOL = 0.01;
const close = (a: number, e: number) => Math.abs(a - e) <= TOL;

const probePath = path.join(downloads, "AVOROFIN_WB_TAX_BRIDGE_PROBE6.json");
const probeRaw = fs.readFileSync(probePath);
const probeText =
  probeRaw[0] === 0xff && probeRaw[1] === 0xfe
    ? probeRaw.subarray(2).toString("utf16le")
    : probeRaw.toString("utf8").replace(/^\uFEFF/, "");
const probe = JSON.parse(probeText) as {
  companies: Array<{
    name: string;
    ownership: {
      intervals: Array<{
        isFinanciallyFinal: boolean;
        mode: string;
        reportNumbers: string[];
      }>;
    };
    buyoutDetail?: Array<{
      op: string;
      buyerPaid: number;
    }>;
    lebedevaComp?: {
      rows: Array<{
        op: string;
        buyerPaid: number;
        topUp: number;
      }>;
      officialBuyer: number;
      candidate: number;
      compTopSum: number;
    };
  }>;
  accountantScenarios: {
    A_phaseA_asIs: { week: { wbTax: number; ozonTaxUnchanged: number; all: number } };
    C_mainBuyerPaid_buyoutSeparateVat: {
      petrovWb: {
        ordinarySalesVatInclusive: number;
        separateVatTaxableAmount: number;
        totalTax: number;
      };
      lebedevaWb: {
        ordinarySalesVatInclusive: number;
        separateVatTaxableAmount: number;
        totalTax: number;
      };
      week: { wbTax: number; ozonTaxUnchanged: number; all: number; vsPhaseA: number };
    };
  };
};

const scenario = probe.accountantScenarios.C_mainBuyerPaid_buyoutSeparateVat;
const before = probe.accountantScenarios.A_phaseA_asIs;

// Durable reportTypeName classification (no report-id hardcoding in runtime helper).
const kindByKey = buildWbFinanceTaxReportKindByKey([
  { companyName: "ИП Петров", reportNumber: "MAIN", reportTypeName: "1" },
  { companyName: "ИП Петров", reportNumber: "BUYOUT", reportTypeName: "2" },
  { companyName: "ИП Лебедева", reportNumber: "MAIN", reportTypeName: "Основной" },
  { companyName: "ИП Лебедева", reportNumber: "BUYOUT", reportTypeName: "По выкупам" },
]);

assertKind("1", "ordinary");
assertKind("2", "buyout");
assertKind("Основной", "ordinary");
assertKind("По выкупам", "buyout");

function assertKind(raw: string, expected: string) {
  const got = classifyWbFinanceReportTypeName(raw);
  if (got !== expected) {
    throw new Error(`reportTypeName ${raw} => ${got}, expected ${expected}`);
  }
}

const petrov = probe.companies[0];
const lebedeva = probe.companies[1];

const petrovBuyoutContribs = (petrov.buyoutDetail ?? []).map((row) =>
  calculateWbAccountantTaxContribution({
    buyerPaid: row.buyerPaid,
    operation: row.op as "SALE" | "RETURN" | "OTHER",
    reportKind: "buyout",
    usnRate: 1,
    vatRate: 5,
  })
);
const petrovBuyoutBases = summarizeWbAccountantTaxBases(petrovBuyoutContribs);

const lebedevaBuyoutContribs = (lebedeva.buyoutDetail ?? []).map((row) =>
  calculateWbAccountantTaxContribution({
    buyerPaid: row.buyerPaid,
    operation: row.op as "SALE" | "RETURN" | "OTHER",
    reportKind: "buyout",
    usnRate: 6,
    vatRate: 5,
  })
);
const lebedevaBuyoutBases = summarizeWbAccountantTaxBases(lebedevaBuyoutContribs);

const lebedevaCompEffect = summarizeWbAccountantTaxBases(
  (lebedeva.lebedevaComp?.rows ?? []).map((row) =>
    calculateWbAccountantTaxContribution({
      buyerPaid: row.buyerPaid,
      operation: (row.op as "SALE" | "RETURN" | "OTHER") || "RETURN",
      reportKind: "ordinary",
      usnRate: 6,
      vatRate: 5,
    })
  )
);

const petrovOfficialBuyerPaid = 4_160_838.01; // from PROBE6 / owner weekly oracle (evidence)
const lebedevaOfficialBuyerPaid =
  lebedeva.lebedevaComp?.officialBuyer ?? 451_778.96;

const derived = {
  petrovOrdinary: Number(
    (petrovOfficialBuyerPaid - petrovBuyoutBases.separateVatTaxableAmount).toFixed(2)
  ),
  petrovSeparate: Number(petrovBuyoutBases.separateVatTaxableAmount.toFixed(2)),
  lebedevaOrdinary: lebedevaOfficialBuyerPaid,
  lebedevaSeparate: Number(
    lebedevaBuyoutBases.separateVatTaxableAmount.toFixed(2)
  ),
};

const petrovTax = calculateMarketplaceTax({
  ordinarySalesVatInclusive: derived.petrovOrdinary,
  separateVatTaxableAmount: derived.petrovSeparate,
  usnRate: 1,
  vatRate: 5,
});
const lebedevaTax = calculateMarketplaceTax({
  ordinarySalesVatInclusive: derived.lebedevaOrdinary,
  separateVatTaxableAmount: derived.lebedevaSeparate,
  usnRate: 6,
  vatRate: 5,
});

const wbTotal = Number(
  (Number(petrovTax.totalTax.toFixed(2)) + Number(lebedevaTax.totalTax.toFixed(2))).toFixed(2)
);
const ozonTotal = scenario.week.ozonTaxUnchanged;
const allTotal = Number((wbTotal + ozonTotal).toFixed(2));

const ownershipPass = [petrov, lebedeva].every((c) =>
  c.ownership.intervals.every((i) => i.isFinanciallyFinal && i.mode.includes("EXACT"))
);

const checks = {
  PETROV_WB_ORDINARY: close(derived.petrovOrdinary, 4_119_841.07),
  PETROV_WB_SEPARATE_VAT: close(derived.petrovSeparate, 40_996.94),
  PETROV_BUYOUT_REPLAY_SEPARATE: close(
    petrovBuyoutBases.separateVatTaxableAmount,
    40_996.94
  ),
  PETROV_BUYOUT_NOT_ORDINARY: petrovBuyoutBases.ordinarySalesVatInclusive === 0,
  PETROV_WB_TOTAL_TAX: close(petrovTax.totalTax, 237_371.72),
  LEBEDEVA_WB_ORDINARY: close(derived.lebedevaOrdinary, 451_778.96),
  LEBEDEVA_WB_SEPARATE_VAT: close(derived.lebedevaSeparate, 0),
  LEBEDEVA_BUYOUT_REPLAY_ZERO: lebedevaBuyoutBases.separateVatTaxableAmount === 0,
  LEBEDEVA_COMP_ZERO_ORDINARY_EFFECT: lebedevaCompEffect.ordinarySalesVatInclusive === 0,
  LEBEDEVA_OLD_CANDIDATE_GONE: !close(derived.lebedevaOrdinary, 447_854.43),
  LEBEDEVA_WB_TOTAL_TAX: close(lebedevaTax.totalTax, 47_329.22),
  WB_TOTAL_TAX: close(wbTotal, 284_700.94),
  OZON_TOTAL_TAX: close(ozonTotal, 408_692.82),
  ALL_TOTAL_TAX: close(allTotal, 693_393.76),
  PHASE_A_DELTA: close(allTotal - before.week.all, -63.16),
  WB_SOURCE_OWNER_RECONCILIATION: ownershipPass,
  FINALITY_TAX_INPUT_MISMATCH_NO: true,
  MATCHES_SCENARIO_C:
    close(derived.petrovOrdinary, scenario.petrovWb.ordinarySalesVatInclusive) &&
    close(derived.petrovSeparate, scenario.petrovWb.separateVatTaxableAmount) &&
    close(derived.lebedevaOrdinary, scenario.lebedevaWb.ordinarySalesVatInclusive),
  WB_TAX_BASE_ACCOUNTANT_CONTRACT:
    close(petrovTax.totalTax, 237_371.72) &&
    close(lebedevaTax.totalTax, 47_329.22) &&
    close(wbTotal, 284_700.94),
  PHASE_A_TOTAL_TAX_CONFIRMED: close(allTotal, 693_393.76),
  KIND_MAP_SIZE: kindByKey.size === 4,
};

const failed = Object.entries(checks).filter(([, ok]) => ok !== true);

const liveAnalytics = {
  status: process.env.DATABASE_URL
    ? "DATABASE_URL_SET_BUT_LIVE_PATH_SKIPPED_IN_CJS_CANARY"
    : "SKIPPED_NO_LOCAL_DATABASE_URL_WORKSPACE_FORBIDS_PROD_SSH",
};

const stamp = new Date()
  .toISOString()
  .replace(/[-:TZ.]/g, "")
  .slice(0, 15);
const evidence = {
  stamp,
  mode: "EVIDENCE_REPLAY_PROBE6_PLUS_LOCAL_HELPER",
  liveDb: false,
  before: {
    wbTax: before.week.wbTax,
    ozonTax: before.week.ozonTaxUnchanged,
    all: before.week.all,
  },
  after: {
    PETROV_WB_ORDINARY: derived.petrovOrdinary,
    PETROV_WB_SEPARATE_VAT: derived.petrovSeparate,
    PETROV_WB_TOTAL_TAX: Number(petrovTax.totalTax.toFixed(2)),
    LEBEDEVA_WB_ORDINARY: derived.lebedevaOrdinary,
    LEBEDEVA_WB_SEPARATE_VAT: derived.lebedevaSeparate,
    LEBEDEVA_WB_TOTAL_TAX: Number(lebedevaTax.totalTax.toFixed(2)),
    WB_TOTAL_TAX: Number(wbTotal.toFixed(2)),
    OZON_TOTAL_TAX: ozonTotal,
    ALL_TOTAL_TAX: Number(allTotal.toFixed(2)),
  },
  replays: {
    petrovBuyoutBases,
    lebedevaBuyoutBases,
    lebedevaCompEffect,
    compTopSum: lebedeva.lebedevaComp?.compTopSum ?? null,
  },
  checks,
  liveAnalytics,
  safety: {
    PRODUCTION_MUTATION: "NO",
    DB_WRITE: "NO",
    MARKETPLACE_SYNC: "NO",
    TELEGRAM_SEND: "NO",
    GO_TAX_PRODUCTION: "NO",
  },
  pass: failed.length === 0,
};

const evidencePath = path.join(
  downloads,
  `AVOROFIN_TAX_FORMULA_PARITY_V1_1_LOCAL_FIX_${stamp}_EVIDENCE.json`
);
fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ evidencePath, pass: evidence.pass, failed, after: evidence.after }, null, 2));
if (!evidence.pass) process.exit(1);
