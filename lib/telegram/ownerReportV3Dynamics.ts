/**
 * Level comparisons for Owner Report V3.4 — company + cabinet dynamics.
 * Uses existing DailyReport pairs only; no second financial path.
 *
 * V3.4 rules:
 * - never suppress valid large % merely because abs(percent) is large;
 * - profit sign-crossing / near-zero previous → absolute RUB delta;
 * - incomplete Ozon historical COGS zero is not a comparable base;
 * - partial marketplace → company combined finance unavailable (not WB-only total).
 */
import type { DailyReport } from "@/lib/telegram/dailyReport";
import {
  compactAbsMoneySuffix,
  compactChangeSuffix,
  compactPointSuffix,
} from "@/lib/telegram/dailyReport";

export type MetricSnapshot = {
  marketplace: "WB" | "OZON" | "COMPANY" | "BUSINESS";
  ordersQty: number;
  ordersAmount: number;
  economicTurnover: number | null;
  taxableRevenue: number | null;
  totalCost: number | null;
  cogsShare: number | null;
  /** False when previous/current COGS must not be compared (fake/incomplete zero). */
  cogsComparable: boolean;
  adSpend: number;
  /** null when denominator unavailable — never fake 0% DRR. */
  drr: number | null;
  netProfit: number | null;
  margin: number | null;
  netCashFlow: number;
  ownerWithdrawals: number;
  afterOwner: number | null;
  stockQty: number;
  financialUnavailable: boolean;
};

export type LevelDynamics = {
  ordersAmountPercent: number | null;
  economicTurnoverPercent: number | null;
  taxableRevenuePercent: number | null;
  totalCostPercent: number | null;
  cogsSharePointDiff: number | null;
  adSpendPercent: number | null;
  drrPointDiff: number | null;
  netProfitPercent: number | null;
  netProfitAbsDelta: number | null;
  netProfitMode: "percent" | "abs" | "none";
  marginPointDiff: number | null;
  afterOwnerPercent: number | null;
  afterOwnerAbsDelta: number | null;
  afterOwnerMode: "percent" | "abs" | "none";
  comparabilityReasons: string[];
};

export type MetricComparability = {
  level: string;
  metric: string;
  currentValue: number | null;
  previousValue: number | null;
  currentSource: string;
  previousSource: string;
  currentCoverage: string;
  previousCoverage: string;
  currentFinality: string;
  previousFinality: string;
  sameGrain: boolean;
  sameSemantics: boolean;
  comparable: boolean;
  reason: string;
};

const NEAR_ZERO = 0.0001;

function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (Math.abs(previous) < NEAR_ZERO) return current === 0 ? 0 : null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function share(cogs: number | null, eco: number | null): number | null {
  if (cogs === null || eco === null || !Number.isFinite(eco) || Math.abs(eco) < NEAR_ZERO)
    return null;
  return (cogs / eco) * 100;
}

function marginOf(profit: number | null, eco: number | null): number | null {
  if (
    profit === null ||
    eco === null ||
    !Number.isFinite(eco) ||
    Math.abs(eco) < NEAR_ZERO
  )
    return null;
  return (profit / eco) * 100;
}

/** Fail-closed: previous Ozon COGS ≈0 while current has material COGS → incomplete path. */
export function isSuspectedIncompleteOzonCogsZero(
  previousCogs: number | null | undefined,
  currentCogs: number | null | undefined
): boolean {
  if (previousCogs === null || previousCogs === undefined) return false;
  if (currentCogs === null || currentCogs === undefined) return false;
  return Math.abs(previousCogs) < 0.5 && currentCogs > 100;
}

function emptyDynamics(reasons: string[] = []): LevelDynamics {
  return {
    ordersAmountPercent: null,
    economicTurnoverPercent: null,
    taxableRevenuePercent: null,
    totalCostPercent: null,
    cogsSharePointDiff: null,
    adSpendPercent: null,
    drrPointDiff: null,
    netProfitPercent: null,
    netProfitAbsDelta: null,
    netProfitMode: "none",
    marginPointDiff: null,
    afterOwnerPercent: null,
    afterOwnerAbsDelta: null,
    afterOwnerMode: "none",
    comparabilityReasons: reasons,
  };
}

function chooseSignedMode(
  current: number | null,
  previous: number | null
): { mode: "percent" | "abs" | "none"; percent: number | null; absDelta: number | null } {
  if (current === null || previous === null) {
    return { mode: "none", percent: null, absDelta: null };
  }
  const prevNearZero = Math.abs(previous) < NEAR_ZERO;
  const signCross =
    !prevNearZero &&
    current !== 0 &&
    previous !== 0 &&
    Math.sign(current) !== Math.sign(previous);
  if (prevNearZero || signCross) {
    return { mode: "abs", percent: null, absDelta: current - previous };
  }
  return {
    mode: "percent",
    percent: percentChange(current, previous),
    absDelta: null,
  };
}

function marketplaceSnapshot(
  m: DailyReport["companies"][0]["wb"]
): MetricSnapshot {
  const unavailable = Boolean(m.financialUnavailable);
  const eco = unavailable ? null : m.economicTurnover ?? m.salesAmount ?? 0;
  const cogs =
    unavailable || m.totalCost === undefined || m.totalCost === null
      ? null
      : m.totalCost;
  const profit =
    unavailable || m.netProfitUnavailable ? null : m.netProfitAfterTax;
  const drr =
    unavailable || eco === null || Math.abs(eco) < NEAR_ZERO
      ? null
      : m.drrByEconomicTurnover;
  const ozonCogsTrusted =
    m.marketplace !== "OZON" ||
    (cogs !== null && !(Math.abs(cogs) < 0.5 && (eco === null || eco < NEAR_ZERO)));
  return {
    marketplace: m.marketplace === "OZON" ? "OZON" : "WB",
    ordersQty: m.ordersQty,
    ordersAmount: m.ordersAmount,
    economicTurnover: eco,
    taxableRevenue: unavailable ? null : m.taxableRevenue ?? null,
    totalCost: cogs,
    cogsShare: share(cogs, eco),
    cogsComparable: ozonCogsTrusted,
    adSpend: m.adSpend,
    drr,
    netProfit: profit,
    margin: marginOf(profit, eco),
    netCashFlow: 0,
    ownerWithdrawals: 0,
    afterOwner: null,
    stockQty: m.stockQty,
    financialUnavailable: unavailable,
  };
}

function companySnapshot(c: DailyReport["companies"][0]): MetricSnapshot {
  const wb = marketplaceSnapshot(c.wb);
  const oz = marketplaceSnapshot(c.ozon);
  const partial = wb.financialUnavailable || oz.financialUnavailable;
  // V3.4: never present WB-only (or Ozon-only) as complete company finance total.
  if (partial) {
    return {
      marketplace: "COMPANY",
      ordersQty: wb.ordersQty + oz.ordersQty,
      ordersAmount: wb.ordersAmount + oz.ordersAmount,
      economicTurnover: null,
      taxableRevenue: null,
      totalCost: null,
      cogsShare: null,
      cogsComparable: false,
      adSpend: wb.adSpend + oz.adSpend,
      drr: null,
      netProfit: null,
      margin: null,
      netCashFlow: c.finance.netCashFlow,
      ownerWithdrawals: c.finance.ownerWithdrawals,
      afterOwner: null,
      stockQty: wb.stockQty + oz.stockQty,
      financialUnavailable: true,
    };
  }
  const eco = (wb.economicTurnover ?? 0) + (oz.economicTurnover ?? 0);
  const cogs =
    wb.totalCost === null && oz.totalCost === null
      ? null
      : (wb.totalCost ?? 0) + (oz.totalCost ?? 0);
  const profit =
    c.wb.netProfitUnavailable
      ? null
      : (wb.netProfit ?? 0) + (oz.netProfit ?? 0) + c.finance.netProfitImpact;
  const after = profit === null ? null : profit - c.finance.ownerWithdrawals;
  const cogsComparable = wb.cogsComparable && oz.cogsComparable;
  return {
    marketplace: "COMPANY",
    ordersQty: wb.ordersQty + oz.ordersQty,
    ordersAmount: wb.ordersAmount + oz.ordersAmount,
    economicTurnover: eco,
    taxableRevenue:
      wb.taxableRevenue === null && oz.taxableRevenue === null
        ? null
        : (wb.taxableRevenue ?? 0) + (oz.taxableRevenue ?? 0),
    totalCost: cogs,
    cogsShare: share(cogs, eco),
    cogsComparable,
    adSpend: wb.adSpend + oz.adSpend,
    drr: Math.abs(eco) > NEAR_ZERO ? ((wb.adSpend + oz.adSpend) / eco) * 100 : null,
    netProfit: profit,
    margin: marginOf(profit, eco),
    netCashFlow: c.finance.netCashFlow,
    ownerWithdrawals: c.finance.ownerWithdrawals,
    afterOwner: after,
    stockQty: wb.stockQty + oz.stockQty,
    financialUnavailable: false,
  };
}

export function compareSnapshots(
  current: MetricSnapshot,
  previous: MetricSnapshot | null
): LevelDynamics {
  if (!previous) return emptyDynamics(["no_previous"]);

  const reasons: string[] = [];
  const comparableFinance =
    !current.financialUnavailable && !previous.financialUnavailable;
  if (!comparableFinance) {
    reasons.push("financial_unavailable_current_or_previous");
  }

  const ozonCogsBlocked =
    (current.marketplace === "OZON" || previous.marketplace === "OZON") &&
    isSuspectedIncompleteOzonCogsZero(previous.totalCost, current.totalCost);
  const cogsOk =
    comparableFinance &&
    current.cogsComparable &&
    previous.cogsComparable &&
    !ozonCogsBlocked &&
    current.totalCost !== null &&
    previous.totalCost !== null;
  if (ozonCogsBlocked) {
    reasons.push("previous_ozon_cogs_incomplete_or_fake_zero");
  }

  const ecoOk =
    comparableFinance &&
    current.economicTurnover !== null &&
    previous.economicTurnover !== null;
  const taxOk =
    comparableFinance &&
    current.taxableRevenue !== null &&
    previous.taxableRevenue !== null;

  const profitMode = chooseSignedMode(current.netProfit, previous.netProfit);
  const afterMode = chooseSignedMode(current.afterOwner, previous.afterOwner);

  return {
    ordersAmountPercent: percentChange(current.ordersAmount, previous.ordersAmount),
    economicTurnoverPercent: ecoOk
      ? percentChange(current.economicTurnover!, previous.economicTurnover!)
      : null,
    taxableRevenuePercent: taxOk
      ? percentChange(current.taxableRevenue!, previous.taxableRevenue!)
      : null,
    totalCostPercent: cogsOk
      ? percentChange(current.totalCost!, previous.totalCost!)
      : null,
    cogsSharePointDiff:
      cogsOk && current.cogsShare !== null && previous.cogsShare !== null
        ? current.cogsShare - previous.cogsShare
        : null,
    adSpendPercent: comparableFinance
      ? percentChange(current.adSpend, previous.adSpend)
      : null,
    drrPointDiff:
      comparableFinance && current.drr !== null && previous.drr !== null
        ? current.drr - previous.drr
        : null,
    netProfitPercent:
      comparableFinance && profitMode.mode === "percent" ? profitMode.percent : null,
    netProfitAbsDelta:
      comparableFinance && profitMode.mode === "abs" ? profitMode.absDelta : null,
    netProfitMode: comparableFinance ? profitMode.mode : "none",
    marginPointDiff:
      comparableFinance && current.margin !== null && previous.margin !== null
        ? current.margin - previous.margin
        : null,
    afterOwnerPercent:
      comparableFinance && afterMode.mode === "percent" ? afterMode.percent : null,
    afterOwnerAbsDelta:
      comparableFinance && afterMode.mode === "abs" ? afterMode.absDelta : null,
    afterOwnerMode: comparableFinance ? afterMode.mode : "none",
    comparabilityReasons: reasons,
  };
}

export function dynPct(value: number | null, inverse = false) {
  return compactChangeSuffix(value, inverse);
}

export function dynPp(value: number | null) {
  return compactPointSuffix(value);
}

export function dynProfit(dyn: LevelDynamics | null | undefined) {
  if (!dyn) return "";
  if (dyn.netProfitMode === "abs") {
    return joinDyn(
      compactAbsMoneySuffix(dyn.netProfitAbsDelta).trim(),
      dynPp(dyn.marginPointDiff).trim()
    );
  }
  if (dyn.netProfitMode === "percent") {
    return joinDyn(dynPct(dyn.netProfitPercent).trim(), dynPp(dyn.marginPointDiff).trim());
  }
  return joinDyn(dynPp(dyn.marginPointDiff).trim());
}

export function dynAfterOwner(dyn: LevelDynamics | null | undefined) {
  if (!dyn) return "";
  if (dyn.afterOwnerMode === "abs") {
    return compactAbsMoneySuffix(dyn.afterOwnerAbsDelta);
  }
  if (dyn.afterOwnerMode === "percent") {
    return dynPct(dyn.afterOwnerPercent);
  }
  return "";
}

/** Aliases used by ownerReportV3 formatter. */
export const formatProfitDynSuffix = dynProfit;
export const formatAfterOwnerDynSuffix = dynAfterOwner;

export function joinDyn(...parts: string[]) {
  const clean = parts.map((p) => p.trim()).filter(Boolean);
  return clean.length ? ` ${clean.join(" · ")}` : "";
}

export type LevelComparisonMaps = {
  company: Map<string, LevelDynamics>;
  cabinet: Map<string, LevelDynamics>;
};

export function buildLevelComparisonMaps(
  current: DailyReport,
  previous: DailyReport | null
): LevelComparisonMaps {
  const company = new Map<string, LevelDynamics>();
  const cabinet = new Map<string, LevelDynamics>();
  const prevByName = new Map(
    (previous?.companies ?? []).map((c) => [c.companyName, c])
  );

  for (const c of current.companies) {
    const prev = prevByName.get(c.companyName) ?? null;
    company.set(
      c.companyName,
      compareSnapshots(companySnapshot(c), prev ? companySnapshot(prev) : null)
    );
    for (const mp of ["WB", "OZON"] as const) {
      const curM = mp === "WB" ? c.wb : c.ozon;
      const prevM = prev ? (mp === "WB" ? prev.wb : prev.ozon) : null;
      cabinet.set(
        `${c.companyName}::${mp}`,
        compareSnapshots(
          marketplaceSnapshot(curM),
          prevM ? marketplaceSnapshot(prevM) : null
        )
      );
    }
  }
  return { company, cabinet };
}

function row(
  level: string,
  metric: string,
  currentValue: number | null,
  previousValue: number | null,
  comparable: boolean,
  reason: string,
  extras: Partial<MetricComparability> = {}
): MetricComparability {
  return {
    level,
    metric,
    currentValue,
    previousValue,
    currentSource: extras.currentSource ?? "dailyReport",
    previousSource: extras.previousSource ?? "dailyReport",
    currentCoverage: extras.currentCoverage ?? "unknown",
    previousCoverage: extras.previousCoverage ?? "unknown",
    currentFinality: extras.currentFinality ?? "unknown",
    previousFinality: extras.previousFinality ?? "unknown",
    sameGrain: extras.sameGrain ?? true,
    sameSemantics: extras.sameSemantics ?? true,
    comparable,
    reason,
  };
}

/** Per-level / per-metric comparability matrix for V3.4 evidence. */
export function buildDynamicsComparabilityMatrix(
  current: DailyReport,
  previous: DailyReport | null
): MetricComparability[] {
  const maps = buildLevelComparisonMaps(current, previous);
  const out: MetricComparability[] = [];
  const prevByName = new Map(
    (previous?.companies ?? []).map((c) => [c.companyName, c])
  );

  const pushLevel = (
    level: string,
    cur: MetricSnapshot,
    prev: MetricSnapshot | null,
    dyn: LevelDynamics
  ) => {
    const finOk = !cur.financialUnavailable && !(prev?.financialUnavailable);
    const reasonBase =
      dyn.comparabilityReasons.join(",") || (finOk ? "comparable" : "unavailable");
    out.push(
      row(
        level,
        "ordersAmount",
        cur.ordersAmount,
        prev?.ordersAmount ?? null,
        true,
        "orders_independent"
      ),
      row(
        level,
        "economicTurnover",
        cur.economicTurnover,
        prev?.economicTurnover ?? null,
        dyn.economicTurnoverPercent !== null,
        dyn.economicTurnoverPercent !== null ? "comparable" : reasonBase
      ),
      row(
        level,
        "taxableRevenue",
        cur.taxableRevenue,
        prev?.taxableRevenue ?? null,
        dyn.taxableRevenuePercent !== null,
        dyn.taxableRevenuePercent !== null ? "comparable" : reasonBase
      ),
      row(
        level,
        "COGS",
        cur.totalCost,
        prev?.totalCost ?? null,
        dyn.totalCostPercent !== null,
        dyn.totalCostPercent !== null
          ? "comparable"
          : dyn.comparabilityReasons.includes(
                "previous_ozon_cogs_incomplete_or_fake_zero"
              )
            ? "comparison omitted — previous COGS coverage incomplete/non-comparable"
            : reasonBase
      ),
      row(
        level,
        "cogsShare",
        cur.cogsShare,
        prev?.cogsShare ?? null,
        dyn.cogsSharePointDiff !== null,
        dyn.cogsSharePointDiff !== null ? "comparable" : reasonBase
      ),
      row(
        level,
        "ads",
        cur.adSpend,
        prev?.adSpend ?? null,
        dyn.adSpendPercent !== null,
        dyn.adSpendPercent !== null ? "comparable" : reasonBase
      ),
      row(
        level,
        "DRR",
        cur.drr,
        prev?.drr ?? null,
        dyn.drrPointDiff !== null,
        cur.drr === null
          ? "denominator_unavailable"
          : dyn.drrPointDiff !== null
            ? "comparable"
            : reasonBase
      ),
      row(
        level,
        "profit",
        cur.netProfit,
        prev?.netProfit ?? null,
        dyn.netProfitMode !== "none",
        dyn.netProfitMode === "abs"
          ? "sign_crossing_or_near_zero_previous_abs_rub"
          : dyn.netProfitMode === "percent"
            ? "comparable"
            : reasonBase
      ),
      row(
        level,
        "margin",
        cur.margin,
        prev?.margin ?? null,
        dyn.marginPointDiff !== null,
        dyn.marginPointDiff !== null ? "comparable" : reasonBase
      ),
      row(
        level,
        "afterOwner",
        cur.afterOwner,
        prev?.afterOwner ?? null,
        dyn.afterOwnerMode !== "none",
        dyn.afterOwnerMode === "abs"
          ? "sign_crossing_or_near_zero_previous_abs_rub"
          : dyn.afterOwnerMode === "percent"
            ? "comparable"
            : reasonBase
      ),
      row(
        level,
        "DDS",
        cur.netCashFlow,
        prev?.netCashFlow ?? null,
        true,
        "dds_independent"
      )
    );
  };

  // Business
  if (previous) {
    const curBiz: MetricSnapshot = {
      marketplace: "BUSINESS",
      ordersQty: current.totals.ordersQty,
      ordersAmount: current.totals.ordersAmount,
      economicTurnover: current.combinedFinancialUnavailable
        ? null
        : current.totals.economicTurnover,
      taxableRevenue: current.combinedFinancialUnavailable
        ? null
        : current.totals.taxableRevenue,
      totalCost: current.combinedFinancialUnavailable
        ? null
        : current.totals.totalCost ?? null,
      cogsShare: null,
      cogsComparable: !current.companies.some((c) =>
        isSuspectedIncompleteOzonCogsZero(
          prevByName.get(c.companyName)?.ozon.totalCost,
          c.ozon.totalCost
        )
      ),
      adSpend: current.totals.adSpend,
      drr: current.combinedFinancialUnavailable
        ? null
        : current.totals.drrByEconomicTurnover,
      netProfit: current.combinedFinancialUnavailable
        ? null
        : current.totals.netProfitImpact,
      margin: null,
      netCashFlow: current.totals.netCashFlow,
      ownerWithdrawals: current.totals.ownerWithdrawals,
      afterOwner: current.combinedFinancialUnavailable
        ? null
        : current.totals.netProfitImpact - current.totals.ownerWithdrawals,
      stockQty: current.totals.stockQty,
      financialUnavailable: Boolean(current.combinedFinancialUnavailable),
    };
    const prevBiz: MetricSnapshot = {
      marketplace: "BUSINESS",
      ordersQty: previous.totals.ordersQty,
      ordersAmount: previous.totals.ordersAmount,
      economicTurnover: previous.combinedFinancialUnavailable
        ? null
        : previous.totals.economicTurnover,
      taxableRevenue: previous.combinedFinancialUnavailable
        ? null
        : previous.totals.taxableRevenue,
      totalCost: previous.combinedFinancialUnavailable
        ? null
        : previous.totals.totalCost ?? null,
      cogsShare: null,
      cogsComparable: true,
      adSpend: previous.totals.adSpend,
      drr: previous.combinedFinancialUnavailable
        ? null
        : previous.totals.drrByEconomicTurnover,
      netProfit: previous.combinedFinancialUnavailable
        ? null
        : previous.totals.netProfitImpact,
      margin: null,
      netCashFlow: previous.totals.netCashFlow,
      ownerWithdrawals: previous.totals.ownerWithdrawals,
      afterOwner: previous.combinedFinancialUnavailable
        ? null
        : previous.totals.netProfitImpact - previous.totals.ownerWithdrawals,
      stockQty: previous.totals.stockQty,
      financialUnavailable: Boolean(previous.combinedFinancialUnavailable),
    };
    pushLevel("business", curBiz, prevBiz, compareSnapshots(curBiz, prevBiz));
  }

  for (const c of current.companies) {
    const prev = prevByName.get(c.companyName) ?? null;
    pushLevel(
      `company:${c.companyName}`,
      companySnapshot(c),
      prev ? companySnapshot(prev) : null,
      maps.company.get(c.companyName) ?? emptyDynamics()
    );
    for (const mp of ["WB", "OZON"] as const) {
      const curM = mp === "WB" ? c.wb : c.ozon;
      const prevM = prev ? (mp === "WB" ? prev.wb : prev.ozon) : null;
      pushLevel(
        `cabinet:${c.companyName}:${mp}`,
        marketplaceSnapshot(curM),
        prevM ? marketplaceSnapshot(prevM) : null,
        maps.cabinet.get(`${c.companyName}::${mp}`) ?? emptyDynamics()
      );
    }
  }
  return out;
}

export function companySnapshotForTests(c: DailyReport["companies"][0]) {
  return companySnapshot(c);
}

export function marketplaceSnapshotForTests(
  m: DailyReport["companies"][0]["wb"]
) {
  return marketplaceSnapshot(m);
}
