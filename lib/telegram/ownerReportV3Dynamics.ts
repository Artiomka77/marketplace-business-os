/**
 * Level comparisons for Owner Report V3.2 — company + cabinet dynamics.
 * Uses existing DailyReport pairs only; no second financial path.
 */
import type { DailyReport } from "@/lib/telegram/dailyReport";
import {
  compactChangeSuffix,
  compactPointSuffix,
} from "@/lib/telegram/dailyReport";

export type MetricSnapshot = {
  ordersQty: number;
  ordersAmount: number;
  economicTurnover: number;
  taxableRevenue: number | null;
  totalCost: number | null;
  cogsShare: number | null;
  adSpend: number;
  drr: number;
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
  marginPointDiff: number | null;
  afterOwnerPercent: number | null;
};

function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (Math.abs(previous) < 0.0001) return current === 0 ? 0 : null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function share(cogs: number | null, eco: number): number | null {
  if (cogs === null || !Number.isFinite(eco) || Math.abs(eco) < 0.0001) return null;
  return (cogs / eco) * 100;
}

function marginOf(profit: number | null, eco: number): number | null {
  if (profit === null || !Number.isFinite(eco) || Math.abs(eco) < 0.0001) return null;
  return (profit / eco) * 100;
}

function marketplaceSnapshot(
  m: DailyReport["companies"][0]["wb"]
): MetricSnapshot {
  const unavailable = Boolean(m.financialUnavailable);
  const eco = unavailable ? 0 : m.economicTurnover ?? m.salesAmount ?? 0;
  const cogs =
    unavailable || m.totalCost === undefined || m.totalCost === null
      ? null
      : m.totalCost;
  const profit =
    unavailable || m.netProfitUnavailable ? null : m.netProfitAfterTax;
  return {
    ordersQty: m.ordersQty,
    ordersAmount: m.ordersAmount,
    economicTurnover: eco,
    taxableRevenue: unavailable ? null : m.taxableRevenue ?? null,
    totalCost: cogs,
    cogsShare: share(cogs, eco),
    adSpend: m.adSpend,
    drr: m.drrByEconomicTurnover,
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
  const unavailable = wb.financialUnavailable || oz.financialUnavailable;
  const eco = wb.economicTurnover + oz.economicTurnover;
  const cogs =
    wb.totalCost === null && oz.totalCost === null
      ? null
      : (wb.totalCost ?? 0) + (oz.totalCost ?? 0);
  const profit =
    unavailable || c.wb.netProfitUnavailable
      ? null
      : (wb.netProfit ?? 0) +
        (oz.netProfit ?? 0) +
        c.finance.netProfitImpact;
  const after =
    profit === null ? null : profit - c.finance.ownerWithdrawals;
  return {
    ordersQty: wb.ordersQty + oz.ordersQty,
    ordersAmount: wb.ordersAmount + oz.ordersAmount,
    economicTurnover: eco,
    taxableRevenue:
      wb.taxableRevenue === null && oz.taxableRevenue === null
        ? null
        : (wb.taxableRevenue ?? 0) + (oz.taxableRevenue ?? 0),
    totalCost: cogs,
    cogsShare: share(cogs, eco),
    adSpend: wb.adSpend + oz.adSpend,
    drr: eco > 0.0001 ? ((wb.adSpend + oz.adSpend) / eco) * 100 : 0,
    netProfit: profit,
    margin: marginOf(profit, eco),
    netCashFlow: c.finance.netCashFlow,
    ownerWithdrawals: c.finance.ownerWithdrawals,
    afterOwner: after,
    stockQty: wb.stockQty + oz.stockQty,
    financialUnavailable: unavailable,
  };
}

export function compareSnapshots(
  current: MetricSnapshot,
  previous: MetricSnapshot | null
): LevelDynamics {
  if (!previous) {
    return {
      ordersAmountPercent: null,
      economicTurnoverPercent: null,
      taxableRevenuePercent: null,
      totalCostPercent: null,
      cogsSharePointDiff: null,
      adSpendPercent: null,
      drrPointDiff: null,
      netProfitPercent: null,
      marginPointDiff: null,
      afterOwnerPercent: null,
    };
  }
  const comparableFinance =
    !current.financialUnavailable && !previous.financialUnavailable;
  return {
    ordersAmountPercent: percentChange(
      current.ordersAmount,
      previous.ordersAmount
    ),
    economicTurnoverPercent: comparableFinance
      ? percentChange(current.economicTurnover, previous.economicTurnover)
      : null,
    taxableRevenuePercent:
      comparableFinance &&
      current.taxableRevenue !== null &&
      previous.taxableRevenue !== null
        ? percentChange(current.taxableRevenue, previous.taxableRevenue)
        : null,
    totalCostPercent:
      comparableFinance &&
      current.totalCost !== null &&
      previous.totalCost !== null
        ? percentChange(current.totalCost, previous.totalCost)
        : null,
    cogsSharePointDiff:
      comparableFinance &&
      current.cogsShare !== null &&
      previous.cogsShare !== null
        ? current.cogsShare - previous.cogsShare
        : null,
    adSpendPercent: comparableFinance
      ? percentChange(current.adSpend, previous.adSpend)
      : null,
    drrPointDiff: comparableFinance
      ? current.drr - previous.drr
      : null,
    netProfitPercent:
      comparableFinance &&
      current.netProfit !== null &&
      previous.netProfit !== null
        ? percentChange(current.netProfit, previous.netProfit)
        : null,
    marginPointDiff:
      comparableFinance &&
      current.margin !== null &&
      previous.margin !== null
        ? current.margin - previous.margin
        : null,
    afterOwnerPercent:
      comparableFinance &&
      current.afterOwner !== null &&
      previous.afterOwner !== null
        ? percentChange(current.afterOwner, previous.afterOwner)
        : null,
  };
}

export function dynPct(value: number | null, inverse = false) {
  return compactChangeSuffix(value, inverse);
}

export function dynPp(value: number | null) {
  return compactPointSuffix(value);
}

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
      compareSnapshots(
        companySnapshot(c),
        prev ? companySnapshot(prev) : null
      )
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

export function companySnapshotForTests(c: DailyReport["companies"][0]) {
  return companySnapshot(c);
}
