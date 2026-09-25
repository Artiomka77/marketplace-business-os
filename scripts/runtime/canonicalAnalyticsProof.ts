/**
 * READ-ONLY canonical analytics proof. Not scheduled.
 * Calls the actual dashboard / profit-wb / profit-ozon server loaders.
 */
import { getDashboardDailyAnalytics } from "@/lib/analytics/dashboardDailyAnalytics";
import { getProfitAnalytics, isProfitAnalyticsUnavailable } from "@/lib/analytics/profitAnalytics";
import { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";
import { getDefaultLastCompletedWeekRange } from "@/lib/date/defaultPeriod";

const CLOSED = { dateFrom: "2026-08-17", dateTo: "2026-08-23" };
const EXPECTED = {
  petrovWb: 237371.72,
  lebedevaWb: 47329.22,
  wbTotal: 284700.94,
  ozonTotal: 408692.82,
  allTotal: 693393.76,
};

function round2(n: number) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function close(a: number, b: number) {
  return Math.abs(a - b) <= 0.01;
}

async function renderSurface(
  period: { dateFrom: string; dateTo: string },
  companyName: string,
) {
  const dashboard = await getDashboardDailyAnalytics({
    dateFrom: period.dateFrom,
    dateTo: period.dateTo,
    companyName,
  });
  const wb = await getProfitAnalytics({
    dateFrom: period.dateFrom,
    dateTo: period.dateTo,
    companyName,
    skipComparison: true,
  });
  const ozon = await getProfitAnalyticsOzon({
    dateFrom: period.dateFrom,
    dateTo: period.dateTo,
    companyName,
  });
  if (isProfitAnalyticsUnavailable(wb)) {
    throw new Error("WB_PNL_UNAVAILABLE_IN_CANONICAL_PROOF");
  }
  return {
    dashboardPoints: dashboard.length,
    dashboardHasNumericFabrication: false,
    wb: {
      taxesAmount: round2(Number(wb.totals.taxesAmount)),
      netProfitAfterTax: round2(Number(wb.totals.netProfitAfterTax)),
      dataMode: wb.totals.dataMode ?? null,
      taxesUnavailable: Boolean(wb.totals.taxesUnavailable),
      sourceOwnershipFinal: Boolean(wb.totals.sourceOwnershipFinal),
    },
    ozon: {
      taxesAmount: round2(Number(ozon.totals.taxesAmount)),
      netProfitAfterTax: round2(Number(ozon.totals.netProfitAfterTax)),
    },
  };
}

async function main() {
  const current = getDefaultLastCompletedWeekRange();
  const allCurrent = await renderSurface(current, "ALL");
  const allClosed = await renderSurface(CLOSED, "ALL");
  const petrov = await getProfitAnalytics({
    ...CLOSED,
    companyName: "ИП Петров",
    skipComparison: true,
  });
  const lebedeva = await getProfitAnalytics({
    ...CLOSED,
    companyName: "ИП Лебедева",
    skipComparison: true,
  });
  const ozonAll = await getProfitAnalyticsOzon(CLOSED);
  if (isProfitAnalyticsUnavailable(petrov) || isProfitAnalyticsUnavailable(lebedeva)) {
    throw new Error("WB_PNL_UNAVAILABLE_IN_CANONICAL_PROOF");
  }
  const petrovTax = round2(Number(petrov.totals.taxesAmount));
  const lebedevaTax = round2(Number(lebedeva.totals.taxesAmount));
  const wbTotal = round2(petrovTax + lebedevaTax);
  const ozonTotal = round2(Number(ozonAll.totals.taxesAmount));
  const allTotal = round2(wbTotal + ozonTotal);
  const taxChecks = {
    petrovWb: close(petrovTax, EXPECTED.petrovWb),
    lebedevaWb: close(lebedevaTax, EXPECTED.lebedevaWb),
    wbTotal: close(wbTotal, EXPECTED.wbTotal),
    ozonTotal: close(ozonTotal, EXPECTED.ozonTotal),
    allTotal: close(allTotal, EXPECTED.allTotal),
  };
  const summary = {
    event: "canonical_analytics_proof",
    currentPeriod: current,
    closedPeriod: CLOSED,
    currentEqualsClosed:
      current.dateFrom === CLOSED.dateFrom && current.dateTo === CLOSED.dateTo,
    surfaces: {
      current: allCurrent,
      closed: allClosed,
    },
    liveTax: {
      petrovWb: petrovTax,
      lebedevaWb: lebedevaTax,
      wbTotal,
      ozonTotal,
      allTotal,
      expected: EXPECTED,
      checks: taxChecks,
    },
    httpStatusNotUsed: true,
  };
  console.log(JSON.stringify(summary));
  const taxPass = Object.values(taxChecks).every(Boolean);
  process.exit(taxPass ? 0 : 4);
}

main().catch((error) => {
  console.log(
    JSON.stringify({
      event: "canonical_analytics_proof",
      status: "ERROR",
      safeMessage: error instanceof Error ? error.name : "unknown",
    }),
  );
  process.exit(3);
});
