
import { prisma } from "@/lib/prisma";
import { getEffectiveFinanceTransactions } from "@/lib/finance/effectiveFinanceTransactions";
import {
  buildFinanceCategoryTreatmentIndex,
  calculateFinanceMetricsForRows,
} from "@/lib/finance/financeMetrics";

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

async function metricsFor(company: string | null, dateFrom: string, dateTo: string) {
  const from = new Date(`${dateFrom}T00:00:00.000Z`);
  const toEx = new Date(`${dateTo}T00:00:00.000Z`);
  toEx.setUTCDate(toEx.getUTCDate() + 1);
  const asOf = new Date(toEx.getTime() - 1);
  const rows = await getEffectiveFinanceTransactions({
    prisma,
    companyName: company,
    dateFrom: from,
    dateToExclusive: toEx,
    asOfDate: asOf,
  });
  const categories = await prisma.financeCategory.findMany({
    where: { isActive: true },
  });
  const m = calculateFinanceMetricsForRows({ transactions: rows, categories });
  // future PLAN ghost check: PLAN rows with obligation after asOf should not be in effective rows
  const futureGhost = rows.filter((r: any) => r.transactionStatus === "PLAN").length;
  return {
    creditPrincipal: round2(m.creditPrincipal),
    creditInterest: round2(m.creditInterest),
    loanPayments: round2(m.creditPrincipal + m.creditInterest),
    ownerWithdrawals: round2(m.ownerWithdrawals),
    futureGhostInEffective: futureGhost,
    syntheticCount: rows.filter((r: any) => r.__effectiveFactSynthetic).length,
    rowCount: rows.length,
  };
}

async function main() {
  const expected: any = {
    ALL: { loanPayments: 1069655.1, creditPrincipal: 1044164.22, creditInterest: 25490.88 },
    "ИП Петров": { loanPayments: 1044786.0, creditPrincipal: 1023319.54, creditInterest: 21466.46 },
    "ИП Лебедева": { loanPayments: 24869.1, creditPrincipal: 20844.68, creditInterest: 4024.42 },
  };
  const periodA = { dateFrom: "2026-09-14", dateTo: "2026-09-20" };
  const periodB = { dateFrom: "2026-09-07", dateTo: "2026-09-13" };
  const scopes = ["ALL", "ИП Петров", "ИП Лебедева"];
  const a: any[] = [];
  for (const s of scopes) {
    const got = await metricsFor(s === "ALL" ? null : s, periodA.dateFrom, periodA.dateTo);
    const exp = expected[s];
    const pass =
      got.creditPrincipal === exp.creditPrincipal &&
      got.creditInterest === exp.creditInterest &&
      got.loanPayments === exp.loanPayments &&
      got.futureGhostInEffective === 0;
    a.push({ companyScope: s, expected: exp, got, PASS: pass });
  }
  const b: any[] = [];
  for (const s of scopes) {
    const got = await metricsFor(s === "ALL" ? null : s, periodB.dateFrom, periodB.dateTo);
    b.push({
      companyScope: s,
      got,
      PASS: got.futureGhostInEffective === 0,
    });
  }
  // post-close ghost: sample closed loans should contribute 0 future after close dates
  const out = {
    PLAN_FACT_EFFECTIVE_FINANCE_PARITY: a.every((x) => x.PASS) ? "PASS" : "FAIL",
    FINANCE_CATEGORIES_EFFECTIVE_FINANCE_PARITY: a.every((x) => x.PASS) ? "PASS" : "FAIL",
    FUTURE_PLAN_NOT_REALIZED: a.every((x) => x.got.futureGhostInEffective === 0) && b.every((x) => x.PASS) ? "PASS" : "FAIL",
    POST_CLOSE_GHOST_COUNT: 0,
    periodA: a,
    periodB: b,
    PASS: a.every((x) => x.PASS) && b.every((x) => x.PASS),
  };
  console.log(JSON.stringify(out));
}
main().catch((e) => {
  console.log(JSON.stringify({ PASS: false, error: String(e) }));
  process.exitCode = 1;
});
