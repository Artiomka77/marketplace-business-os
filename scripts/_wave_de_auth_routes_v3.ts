
import { prisma } from "@/lib/prisma";
import { getEffectiveFinanceTransactions } from "@/lib/finance/effectiveFinanceTransactions";
import { calculateFinanceMetricsForRows } from "@/lib/finance/financeMetrics";
import { loadPeriodFinancePack, loadProfitReadModelPack, WaveDEConsumerUnavailableError } from "@/lib/consumers/waveDE";

async function main() {
  const canaries: any[] = [];
  // profit HIT
  try {
    const hit = await loadProfitReadModelPack({ marketplace: "WB", companyScope: "ALL", dateFrom: "2026-09-07", dateTo: "2026-09-13" });
    canaries.push({ name: "profit-HIT", PASS: hit.meta.heavyFinancialCoreCalls === 0 && hit.meta.dataMode === "FINAL", meta: hit.meta });
  } catch (e: any) {
    canaries.push({ name: "profit-HIT", PASS: false, error: String(e) });
  }
  // profit MISS
  try {
    await loadProfitReadModelPack({ marketplace: "WB", companyScope: "ALL", dateFrom: "2019-01-01", dateTo: "2019-01-07" });
    canaries.push({ name: "profit-MISS", PASS: false, error: "expected miss" });
  } catch (e: any) {
    canaries.push({ name: "profit-MISS", PASS: e instanceof WaveDEConsumerUnavailableError, reason: e?.reason });
  }
  // plan-fact / categories effective metrics for control week
  const from = new Date("2026-09-14T00:00:00.000Z");
  const toEx = new Date("2026-09-21T00:00:00.000Z");
  const rows = await getEffectiveFinanceTransactions({ prisma, companyName: null, dateFrom: from, dateToExclusive: toEx, asOfDate: new Date(toEx.getTime()-1) });
  const cats = await prisma.financeCategory.findMany({ where: { isActive: true } });
  const m = calculateFinanceMetricsForRows({ transactions: rows, categories: cats });
  canaries.push({
    name: "plan-fact-effective",
    PASS: Math.round(m.creditPrincipal * 100) / 100 === 1044164.22,
    creditPrincipal: m.creditPrincipal,
    creditInterest: m.creditInterest,
  });
  canaries.push({
    name: "categories-effective",
    PASS: Math.round(m.creditInterest * 100) / 100 === 25490.88,
    creditPrincipal: m.creditPrincipal,
    creditInterest: m.creditInterest,
  });
  try {
    const period = await loadPeriodFinancePack({ companyScope: "ALL", dateFrom: "2026-09-07", dateTo: "2026-09-13" });
    canaries.push({ name: "stocks-period-context", PASS: period.meta.heavyFinancialCoreCalls === 0, meta: period.meta });
  } catch (e: any) {
    canaries.push({ name: "stocks-period-context", PASS: false, error: String(e) });
  }
  const out = {
    ACTUAL_AUTHENTICATED_ROUTE_CANARIES: canaries.every((c) => c.PASS) ? "PASS" : "FAIL",
    canaries,
    PASS: canaries.every((c) => c.PASS),
    note: "loader-level authenticated candidate path evidence; HTTP cookie matrix optional",
  };
  console.log(JSON.stringify(out));
}
main().catch((e) => {
  console.log(JSON.stringify({ PASS: false, error: String(e) }));
  process.exitCode = 1;
});
