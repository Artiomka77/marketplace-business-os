
import { loadPeriodFinancePack, loadStockPlanningAbcPack, WaveDEConsumerUnavailableError } from "@/lib/consumers/waveDE";
import { getEffectiveFinanceTransactions } from "@/lib/finance/effectiveFinanceTransactions";
import { calculateFinanceMetricsForRows } from "@/lib/finance/financeMetrics";
import { prisma } from "@/lib/prisma";

async function unavail(id: number, name: string, fn: () => Promise<any>) {
  try { await fn(); return { id, name, pass: false, actual: "NO_THROW" }; }
  catch (e: any) {
    return { id, name, pass: e instanceof WaveDEConsumerUnavailableError, actual: { name: e?.name, reason: e?.reason, message: e?.message, code: e?.code } };
  }
}
function round2(n: number) { return Math.round((n + Number.EPSILON) * 100) / 100; }

async function main() {
  const cases: any[] = [];
  cases.push(await unavail(3, "stale_or_nonexact_stock_snapshot", () => loadStockPlanningAbcPack({ companyScope: "ALL", dateFrom: "2018-01-01", dateTo: "2018-01-31", requireExact: true })));
  cases.push(await unavail(4, "preliminary_marketplace_finality", () => loadPeriodFinancePack({ companyScope: "ALL", dateFrom: "2026-09-14", dateTo: "2026-09-20" })));
  cases.push(await unavail(5, "missing_stock_source", () => loadStockPlanningAbcPack({ companyScope: "NO_SUCH_COMPANY_WAVE_DE", dateFrom: "2026-08-15", dateTo: "2026-09-14", requireExact: true })));
  cases.push(await unavail(7, "partial_historical_range", () => loadPeriodFinancePack({ companyScope: "ALL", dateFrom: "2018-06-01", dateTo: "2018-06-03" })));
  cases.push(await unavail(9, "current_open_planning_period", () => loadStockPlanningAbcPack({ companyScope: "ALL", dateFrom: "2099-01-01", dateTo: "2099-01-31", requireExact: true })));

  // 10: future PLAN must not enter realized FACT totals; asOf gates schedule-derived EFFECTIVE FACT.
  {
    const from = new Date("2026-09-14T00:00:00.000Z");
    const toEx = new Date("2026-09-21T00:00:00.000Z");
    const asOfBefore = new Date("2026-09-13T00:00:00.000Z");
    const asOfAfter = new Date("2026-09-20T00:00:00.000Z");
    const cats = await prisma.financeCategory.findMany({ where: { isActive: true } });
    const beforeRows = await getEffectiveFinanceTransactions({ prisma, companyName: null, dateFrom: from, dateToExclusive: toEx, asOfDate: asOfBefore });
    const afterRows = await getEffectiveFinanceTransactions({ prisma, companyName: null, dateFrom: from, dateToExclusive: toEx, asOfDate: asOfAfter });
    const before = calculateFinanceMetricsForRows({ transactions: beforeRows, categories: cats });
    const after = calculateFinanceMetricsForRows({ transactions: afterRows, categories: cats });
    const beforeSynth = beforeRows.filter((r: any) => r.__effectiveFactSynthetic).length;
    const afterSynth = afterRows.filter((r: any) => r.__effectiveFactSynthetic).length;
    const planLeak = [...beforeRows, ...afterRows].filter((r: any) => r.transactionStatus === "PLAN").length;
    const pass =
      planLeak === 0 &&
      afterSynth > beforeSynth &&
      round2(after.creditPrincipal) === 1044164.22 &&
      round2(before.creditPrincipal) < round2(after.creditPrincipal);
    cases.push({
      id: 10,
      name: "future_loan_plan_not_in_realized_fact",
      pass,
      actual: {
        planLeak,
        beforeSynth,
        afterSynth,
        beforePrincipal: round2(before.creditPrincipal),
        afterPrincipal: round2(after.creditPrincipal),
      },
      expected: "no PLAN status in effective rows; asOf gates additional schedule-derived EFFECTIVE FACT",
    });
  }

  // 11: post-close future scheduled loan row must NOT enter realized FACT/category totals
  {
    const from = new Date("2026-09-21T00:00:00.000Z");
    const toEx = new Date("2026-10-01T00:00:00.000Z");
    const asOf = new Date("2026-09-30T00:00:00.000Z");
    const rows = await getEffectiveFinanceTransactions({ prisma, companyName: null, dateFrom: from, dateToExclusive: toEx, asOfDate: asOf });
    const closed = ["loan_cf6b9d061f", "loan_b05af6c78b", "loan_ffd0c8aa4f"];
    const ghosts = rows.filter((r: any) => {
      const sid = String(r.sourceId || "");
      const lid = String(r.__loanId || "");
      return closed.some((id) => sid.includes(id) || lid.includes(id));
    });
    cases.push({
      id: 11,
      name: "post_close_future_not_in_realized",
      pass: ghosts.length === 0,
      actual: { ghostCount: ghosts.length, rowCount: rows.length },
      expected: "POST_CLOSE_GHOST_COUNT=0",
    });
  }

  console.log(JSON.stringify({ cases, PASS: cases.every((c) => c.pass) }));
}
main().catch((e) => { console.log(JSON.stringify({ PASS: false, error: String(e) })); process.exitCode = 1; });
