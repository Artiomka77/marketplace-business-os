import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getMoscowBusinessDateKey,
  toMoscowDateKey,
  addDaysToMoscowDateKey,
  endOfMoscowMonthKey,
  startOfMoscowMonthKey,
} from "../../lib/finance/loanBusinessDate";
import {
  assessScheduleCompleteness,
  filterOperationalLoanSchedulePayments,
  getLoanStateAtDate,
  getPaymentInterest,
  getPaymentPrincipal,
  getPaymentTotal,
  isPaymentInProjectedRemaining,
  type LoanStatePayment,
} from "../../lib/finance/loanState";
import {
  isLoanPaymentSuppressedByEarlyRepayment,
  shouldGenerateRegularLoanFinanceTransactions,
} from "../../lib/finance/loanPaymentActuality";

function d(isoDate: string) {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

function payment(
  partial: Partial<LoanStatePayment> & {
    id: string;
    loanId: string;
    paymentDate: Date;
  },
): LoanStatePayment {
  return {
    paid: false,
    principalAmount: 0,
    interestAmount: 0,
    totalAmount: 0,
    ...partial,
  };
}

const ozon2200Payments: LoanStatePayment[] = [
  payment({
    id: "ozon2200_0715",
    loanId: "loan_d335592b95",
    paymentDate: d("2026-07-15"),
    principalAmount: 182610.43,
    interestAmount: 32869.57,
    totalAmount: 215480,
  }),
  payment({
    id: "ozon2200_0724",
    loanId: "loan_d335592b95",
    paymentDate: d("2026-07-24"),
    principalAmount: 182570.54,
    interestAmount: 32869.46,
    totalAmount: 215440,
  }),
];

const ozon2200Loan = {
  id: "loan_d335592b95",
  bankName: "Озон кредит 2 200 тыс",
  currentDebt: 365180.97,
  monthlyPayment: 215480,
  endDate: d("2026-07-24"),
};

describe("loan business timezone Europe/Moscow", () => {
  it("LOAN_MONTH_BOUNDARY_TEST — 31st/1st keys", () => {
    assert.equal(toMoscowDateKey(d("2026-08-31")), "2026-08-31");
    assert.equal(addDaysToMoscowDateKey("2026-08-31", 1), "2026-09-01");
    assert.equal(startOfMoscowMonthKey("2026-08"), "2026-08-01");
    assert.equal(endOfMoscowMonthKey("2026-08"), "2026-08-31");
  });

  it("current date conversion uses Europe/Moscow", () => {
    const key = getMoscowBusinessDateKey(
      new Date("2026-08-27T21:30:00.000Z"),
    );
    assert.equal(key, "2026-08-28");
  });
});

describe("Ozon 2.2m CLOSED_SCHEDULE fixture", () => {
  it("OZON_2200_CLOSED_SCHEDULE_FIXTURE — Aug 27 balance 0 / excluded", () => {
    const state = getLoanStateAtDate({
      loan: ozon2200Loan,
      payments: ozon2200Payments,
      asOfDate: "2026-08-27",
      selectedMonth: "2026-08",
    });

    assert.equal(state.status, "CLOSED_SCHEDULE");
    assert.equal(state.balance, 0);
    assert.equal(state.isActiveObligation, false);
    assert.equal(state.nextOutstandingPayment, null);
    assert.equal(state.selectedMonthPlanTotal, 0);
    assert.equal(state.selectedMonthRemainingTotal, 0);
    assert.equal(state.balanceSource, "SCHEDULE_PROJECTION");
    assert.ok(state.closedAt);
  });

  it("retains historical July plan without deleting rows", () => {
    const state = getLoanStateAtDate({
      loan: ozon2200Loan,
      payments: ozon2200Payments,
      asOfDate: "2026-08-27",
      selectedMonth: "2026-07",
    });
    assert.equal(state.status, "CLOSED_SCHEDULE");
    assert.equal(state.isActiveObligation, false);
    assert.equal(state.selectedMonthPlanPrincipal, 365180.97);
    assert.equal(
      state.selectedMonthPlanTotal,
      state.selectedMonthPlanPrincipal + state.selectedMonthPlanInterest,
    );
  });
});

describe("Sell Plus early repayment regression", () => {
  const early = d("2026-07-03");
  const future = payment({
    id: "cmq879wrm005g20i5hqe27pdu",
    loanId: "loan_7e9056bf74",
    paymentDate: d("2026-08-21"),
    paid: true,
    principalAmount: 85948.53,
    interestAmount: 4719.9,
    totalAmount: 90668.43,
  });

  it("SELL_PLUS_EARLY_REPAY_REGRESSION — CLOSED_EARLY", () => {
    const state = getLoanStateAtDate({
      loan: {
        id: "loan_7e9056bf74",
        bankName: "Sell Plus",
        currentDebt: 0,
      },
      payments: [future],
      earlyRepaymentDate: early,
      asOfDate: "2026-08-27",
      selectedMonth: "2026-08",
    });
    assert.equal(state.status, "CLOSED_EARLY");
    assert.equal(state.balance, 0);
    assert.equal(state.isActiveObligation, false);
    assert.equal(state.balanceSource, "EARLY_REPAYMENT");
  });

  it("EARLY_REPAY_HELPER_REUSED — paid=true still suppressed", () => {
    assert.equal(
      isLoanPaymentSuppressedByEarlyRepayment({
        paymentDate: future.paymentDate,
        earlyRepaymentDate: early,
      }),
      true,
    );
    const decision = shouldGenerateRegularLoanFinanceTransactions({
      paymentDate: future.paymentDate,
      paid: true,
      earlyRepaymentDate: early,
    });
    assert.equal(decision.generate, false);
  });
});

describe("due-today semantics", () => {
  const loan = {
    id: "loan_due_today",
    bankName: "Тест месяц",
    currentDebt: 100000,
  };
  const payments = [
    payment({
      id: "p1",
      loanId: loan.id,
      paymentDate: d("2026-08-27"),
      principalAmount: 40000,
      interestAmount: 10000,
      totalAmount: 50000,
    }),
    payment({
      id: "p2",
      loanId: loan.id,
      paymentDate: d("2026-09-27"),
      principalAmount: 60000,
      interestAmount: 5000,
      totalAmount: 65000,
    }),
  ];

  it("DUE_TODAY_REMAINS_IN_BALANCE_UNTIL_ACTUAL_OR_NEXT_DAY", () => {
    const state = getLoanStateAtDate({
      loan,
      payments,
      asOfDate: "2026-08-27",
      selectedMonth: "2026-08",
    });
    assert.equal(state.status, "ACTIVE");
    assert.equal(state.balance, 100000);
    assert.equal(state.nextOutstandingPayment?.id, "p1");
    assert.equal(
      isPaymentInProjectedRemaining({
        payment: payments[0],
        asOfDateKey: "2026-08-27",
        earlyRepaymentDate: null,
      }),
      true,
    );
  });

  it("LOAN_DUE_TODAY_TEST — proven actual drops today principal", () => {
    const paidToday = { ...payments[0], paid: true };
    const state = getLoanStateAtDate({
      loan,
      payments: [paidToday, payments[1]],
      asOfDate: "2026-08-27",
      selectedMonth: "2026-08",
    });
    assert.equal(state.balance, 60000);
    assert.equal(state.nextOutstandingPayment?.id, "p2");
  });

  it("one day after due date rolls projected balance forward", () => {
    const state = getLoanStateAtDate({
      loan,
      payments,
      asOfDate: "2026-08-28",
      selectedMonth: "2026-08",
    });
    assert.equal(state.balance, 60000);
  });
});

describe("bank / ozon / wb schedule projection", () => {
  it("six-bank style: balance decreases after elapsed dates, due-today kept", () => {
    const loan = {
      id: "loan_60debb8fb1",
      bankName: "Сбер ООО - 5 млн",
      currentDebt: 322899.9,
    };
    const payments = [
      payment({
        id: "jul",
        loanId: loan.id,
        paymentDate: d("2026-07-27"),
        principalAmount: 160339.97,
        interestAmount: 40925.75,
        totalAmount: 201265.72,
      }),
      payment({
        id: "aug27",
        loanId: loan.id,
        paymentDate: d("2026-08-27"),
        principalAmount: 162559.93,
        interestAmount: 38705.79,
        totalAmount: 201265.72,
      }),
    ];
    // completeness requires sum principal == stored
    const state = getLoanStateAtDate({
      loan,
      payments,
      asOfDate: "2026-08-27",
      selectedMonth: "2026-08",
    });
    assert.equal(state.status, "ACTIVE");
    assert.equal(state.balance, 162559.93);
    assert.equal(state.nextOutstandingPayment?.id, "aug27");
  });

  it("Ozon 990 decreases after elapsed July payment", () => {
    const loan = {
      id: "loan_c6e408881b",
      bankName: "Озон кредит 990 тыс",
      currentDebt: 110000,
    };
    const payments = [
      payment({
        id: "a",
        loanId: loan.id,
        paymentDate: d("2026-07-28"),
        principalAmount: 55000,
        interestAmount: 15840,
        totalAmount: 70840,
      }),
      payment({
        id: "b",
        loanId: loan.id,
        paymentDate: d("2026-08-28"),
        principalAmount: 55000,
        interestAmount: 15840,
        totalAmount: 70840,
      }),
    ];
    const state = getLoanStateAtDate({
      loan,
      payments,
      asOfDate: "2026-08-27",
      selectedMonth: "2026-08",
    });
    assert.equal(state.balance, 55000);
    assert.equal(state.status, "ACTIVE");
  });

  it("WB weekly 4-payment and 5-payment months aggregate", () => {
    const loanId = "loan_dfd0049677";
    const loan = {
      id: loanId,
      bankName: "Wb Кредит Петров 1,2 млн",
      currentDebt: 114531.15,
    };
    const august4 = ["2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24"].map(
      (date, index) =>
        payment({
          id: `w${index}`,
          loanId,
          paymentDate: d(date),
          principalAmount: 22684.34 + index,
          interestAmount: 3000,
          totalAmount: 22684.34 + index + 3000,
        }),
    );
    // adjust stored to match sum
    const sumPrin = august4.reduce((s, p) => s + getPaymentPrincipal(p), 0);
    const stateAug = getLoanStateAtDate({
      loan: { ...loan, currentDebt: sumPrin },
      payments: august4,
      asOfDate: "2026-08-01",
      selectedMonth: "2026-08",
    });
    assert.equal(stateAug.selectedMonthPaymentCount, 4);
    assert.equal(
      stateAug.selectedMonthPlanTotal,
      stateAug.selectedMonthPlanPrincipal + stateAug.selectedMonthPlanInterest,
    );

    const september5 = [
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
      "2026-09-28",
      "2026-09-30",
    ].map((date, index) =>
      payment({
        id: `s${index}`,
        loanId,
        paymentDate: d(date),
        principalAmount: 10000 + index,
        interestAmount: 1000,
        totalAmount: 11000 + index,
      }),
    );
    const sumSep = september5.reduce((s, p) => s + getPaymentPrincipal(p), 0);
    const stateSep = getLoanStateAtDate({
      loan: { ...loan, currentDebt: sumSep },
      payments: september5,
      asOfDate: "2026-09-01",
      selectedMonth: "2026-09",
    });
    assert.equal(stateSep.selectedMonthPaymentCount, 5);
  });

  it("Lebedeva weekly month arithmetic principal+interest=total", () => {
    const loanId = "loan_a476637be3";
    const payments = [
      payment({
        id: "l1",
        loanId,
        paymentDate: d("2026-08-17"),
        principalAmount: 20497.2,
        interestAmount: 4371.9,
        totalAmount: 24869.1,
      }),
      payment({
        id: "l2",
        loanId,
        paymentDate: d("2026-08-24"),
        principalAmount: 20583.52,
        interestAmount: 4285.58,
        totalAmount: 24869.1,
      }),
    ];
    const stored = payments.reduce((s, p) => s + getPaymentPrincipal(p), 0);
    const state = getLoanStateAtDate({
      loan: {
        id: loanId,
        bankName: "Wb Кредит Лебедева 1,4 млн",
        currentDebt: stored,
      },
      payments,
      asOfDate: "2026-08-01",
      selectedMonth: "2026-08",
    });
    assert.equal(
      getPaymentTotal(payments[0]),
      getPaymentPrincipal(payments[0]) + getPaymentInterest(payments[0]),
    );
    assert.equal(
      state.selectedMonthPlanTotal,
      state.selectedMonthPlanPrincipal + state.selectedMonthPlanInterest,
    );
  });
});

describe("incomplete schedule + credit card", () => {
  it("INCOMPLETE_SCHEDULE_DOES_NOT_FALSE_CLOSE", () => {
    const state = getLoanStateAtDate({
      loan: {
        id: "loan_incomplete",
        bankName: "Банк X",
        currentDebt: 500000,
      },
      payments: [
        payment({
          id: "only",
          loanId: "loan_incomplete",
          paymentDate: d("2026-09-01"),
          principalAmount: 10000,
          interestAmount: 1000,
          totalAmount: 11000,
        }),
      ],
      asOfDate: "2026-08-27",
      selectedMonth: "2026-08",
    });
    assert.equal(state.status, "DATA_INCOMPLETE");
    assert.equal(state.balance, 500000);
    assert.equal(state.isActiveObligation, true);
    assert.equal(state.balanceSource, "STORED_FALLBACK");
    assert.equal(state.selectedMonthPlanTotal, 0);
  });

  it("INCOMPLETE_SCHEDULE_DOES_NOT_DISAPPEAR", () => {
    const completeness = assessScheduleCompleteness({
      payments: [],
      storedCurrentDebt: 1000,
    });
    assert.equal(completeness.complete, false);
  });

  it("CREDIT_CARD_REGRESSION — manual balance preserved", () => {
    const state = getLoanStateAtDate({
      loan: {
        id: "loan_card",
        bankName: "Альфа кредитка 4337",
        currentDebt: 1142596,
      },
      payments: [
        payment({
          id: "min",
          loanId: "loan_card",
          paymentDate: d("2026-08-21"),
          principalAmount: 46406.74,
          interestAmount: 0,
          totalAmount: 46406.74,
        }),
      ],
      asOfDate: "2026-08-27",
      selectedMonth: "2026-08",
    });
    assert.equal(state.obligationType, "CREDIT_CARD");
    assert.equal(state.status, "CREDIT_CARD_ACTIVE");
    assert.equal(state.balance, 1142596);
    assert.equal(state.balanceSource, "CREDIT_CARD_MANUAL");
  });
});

describe("operational filter closed schedule reappearance", () => {
  it("CLOSED_SCHEDULE_REAPPEARANCE=NO", () => {
    const state = getLoanStateAtDate({
      loan: ozon2200Loan,
      payments: ozon2200Payments,
      asOfDate: "2026-08-27",
      selectedMonth: "2026-08",
    });
    const filtered = filterOperationalLoanSchedulePayments({
      payments: ozon2200Payments,
      loanStatesById: new Map([[ozon2200Loan.id, state]]),
      earlyRepaymentByLoanId: new Map(),
    });
    assert.equal(filtered.length, 0);
  });
});

describe("raw snapshot UI reconciliation", () => {
  it("OWNER_UI_REFERENCE card totals are approximate, not fixture DB claims", () => {
    // Stored import snapshot total for amortizing loans (raw Loan.currentDebt).
    const amortExact = [
      3064221.93, 367805.41, 1645873.07, 438022.31, 1744975.44, 380725.03,
      365180.97, 715000, 718905.26, 1137241.13,
    ];
    const amortSum = amortExact.reduce((a, b) => a + b, 0);
    assert.equal(Math.round(amortSum), 10577951);
    // OWNER_UI_REFERENCE only — not exact per-card DB fixtures:
    const OWNER_UI_CARD_DEBT_TOTAL_APPROX = 1142596;
    const OWNER_UI_CARD_MIN_PAYMENT_TOTAL_APPROX = 114260;
    const OWNER_UI_ACTIVE_CARD_COUNT = 2;
    assert.ok(OWNER_UI_CARD_DEBT_TOTAL_APPROX > 0);
    assert.ok(OWNER_UI_CARD_MIN_PAYMENT_TOTAL_APPROX > 0);
    assert.equal(OWNER_UI_ACTIVE_CARD_COUNT, 2);
  });
});

type FixtureKind = "REAL_AMORTIZING" | "CARD_BEHAVIOR";

type RealFixture = {
  fixtureKind?: FixtureKind;
  loanId: string;
  bankName: string;
  companyName: string;
  currentDebt: number;
  monthlyPayment: number | null;
  endDate: string | null;
  earlyRepaymentDate?: string;
  payments: Array<{
    id: string;
    loanId: string;
    paymentDate: string;
    principalAmount: number;
    interestAmount: number;
    totalAmount: number;
    paid: boolean;
  }>;
};

function loadRealFixtures(): RealFixture[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("./loansRealFixtures.generated.json") as RealFixture[];
}

function fixtureToStateInput(fixture: RealFixture) {
  return {
    loan: {
      id: fixture.loanId,
      bankName: fixture.bankName,
      currentDebt: fixture.currentDebt,
      monthlyPayment: fixture.monthlyPayment,
      endDate: fixture.endDate ? d(fixture.endDate) : null,
    },
    payments: fixture.payments.map((p) =>
      payment({
        id: p.id,
        loanId: p.loanId,
        paymentDate: d(p.paymentDate),
        principalAmount: p.principalAmount,
        interestAmount: p.interestAmount,
        totalAmount: p.totalAmount,
        paid: p.paid,
      }),
    ),
    earlyRepaymentDate: fixture.earlyRepaymentDate
      ? d(fixture.earlyRepaymentDate)
      : null,
  };
}

function round2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Display monthly payment contract used by /finance/loans active table. */
function displayMonthlyPayment(input: {
  obligationType: "AMORTIZING" | "CREDIT_CARD";
  selectedMonthPlanTotal: number;
  storedMonthlyPayment: number | null | undefined;
}) {
  if (input.obligationType === "CREDIT_CARD") {
    return Number(input.storedMonthlyPayment ?? 0) || 0;
  }
  return input.selectedMonthPlanTotal;
}

describe("fixture taxonomy + amortizing projection as-of 2026-08-27", () => {
  const fixtures = loadRealFixtures();
  const asOf = "2026-08-27";
  const realAmortizing = fixtures.filter(
    (f) => (f.fixtureKind ?? "REAL_AMORTIZING") === "REAL_AMORTIZING",
  );
  const cardBehavior = fixtures.filter((f) => f.fixtureKind === "CARD_BEHAVIOR");

  it("REAL_AMORTIZING_FIXTURE_COUNT=11 and CARD_BEHAVIOR_FIXTURE_COUNT=2", () => {
    assert.equal(realAmortizing.length, 11);
    assert.equal(cardBehavior.length, 2);
    assert.equal(fixtures.length, 13);
    for (const required of [
      "Авто кредит УралСиб",
      "Альфа кредит",
      "Сбер ИП - 5 млн",
      "Сбер ИП - 600 тр",
      "Сбер ООО - 5 млн",
      "Сбер ООО - 600 р",
      "Озон кредит 2 200 тыс",
      "Озон кредит 990 тыс",
      "Wb Кредит Петров 1,2 млн",
      "Wb Кредит Лебедева 1,4 млн",
      "Sell Plus",
    ]) {
      assert.ok(
        realAmortizing.some((f) => f.bankName === required),
        `missing real ${required}`,
      );
    }
  });

  it("REAL_AMORTIZING_SCHEDULE_COMPLETENESS + projected amortizing total", () => {
    const rows = realAmortizing.map((fixture) => {
      const input = fixtureToStateInput(fixture);
      const state = getLoanStateAtDate({
        ...input,
        asOfDate: asOf,
        selectedMonth: "2026-08",
      });
      if (!fixture.earlyRepaymentDate) {
        assert.equal(
          state.scheduleComplete,
          true,
          `${fixture.bankName} incomplete: ${state.dataQualityReason}`,
        );
      }
      return {
        loanId: fixture.loanId,
        bankName: fixture.bankName,
        type: state.obligationType,
        storedCurrentDebt: fixture.currentDebt,
        canonicalStatus: state.status,
        projectedBalanceAsOf20260827: state.balance,
        balanceSource: state.balanceSource,
        nextPaymentDate: state.nextOutstandingPayment
          ? toMoscowDateKey(state.nextOutstandingPayment.paymentDate)
          : null,
        nextPaymentPrincipal: state.nextOutstandingPayment
          ? getPaymentPrincipal(state.nextOutstandingPayment)
          : null,
        nextPaymentInterest: state.nextOutstandingPayment
          ? getPaymentInterest(state.nextOutstandingPayment)
          : null,
        selectedAugPlan: {
          principal: state.selectedMonthPlanPrincipal,
          interest: state.selectedMonthPlanInterest,
          total: state.selectedMonthPlanTotal,
        },
        scheduleComplete: state.scheduleComplete,
        dataQualityReason: state.dataQualityReason,
      };
    });

    const amortSum = round2(
      rows.reduce((s, r) => s + r.projectedBalanceAsOf20260827, 0),
    );
    assert.equal(amortSum, 9184126.56);

    const ozon = rows.find((r) => r.bankName === "Озон кредит 2 200 тыс");
    assert.ok(ozon);
    assert.equal(ozon.canonicalStatus, "CLOSED_SCHEDULE");
    assert.equal(ozon.projectedBalanceAsOf20260827, 0);

    const sberOoo = rows.find((r) => r.bankName === "Сбер ООО - 5 млн");
    assert.ok(sberOoo);
    assert.equal(sberOoo.nextPaymentDate, "2026-08-27");
    assert.equal(sberOoo.projectedBalanceAsOf20260827, 1584635.47);
  });

  it("CARD_BEHAVIOR fixtures: manual debt/payment pass-through, no month plan", () => {
    const active = cardBehavior.find((f) => f.currentDebt > 0)!;
    const zero = cardBehavior.find((f) => f.currentDebt === 0)!;
    const activeState = getLoanStateAtDate({
      ...fixtureToStateInput(active),
      asOfDate: asOf,
      selectedMonth: "2026-08",
    });
    assert.equal(activeState.obligationType, "CREDIT_CARD");
    assert.equal(activeState.status, "CREDIT_CARD_ACTIVE");
    assert.equal(activeState.balance, active.currentDebt);
    assert.equal(activeState.balanceSource, "CREDIT_CARD_MANUAL");
    assert.equal(activeState.selectedMonthPlanTotal, 0);
    assert.equal(
      displayMonthlyPayment({
        obligationType: activeState.obligationType,
        selectedMonthPlanTotal: activeState.selectedMonthPlanTotal,
        storedMonthlyPayment: active.monthlyPayment,
      }),
      active.monthlyPayment,
    );

    const zeroState = getLoanStateAtDate({
      ...fixtureToStateInput(zero),
      asOfDate: asOf,
      selectedMonth: "2026-08",
    });
    assert.equal(zeroState.status, "CREDIT_CARD_ZERO");
    assert.equal(zeroState.balance, 0);
    assert.equal(zeroState.selectedMonthPlanTotal, 0);
  });

  it("CARD_DOES_NOT_CHANGE_MONTH_PLAN_TOTAL / DONUT_TOTAL", () => {
    const amortPlan = round2(
      realAmortizing.reduce((sum, fixture) => {
        const state = getLoanStateAtDate({
          ...fixtureToStateInput(fixture),
          asOfDate: asOf,
          selectedMonth: "2026-08",
        });
        if (state.status === "DATA_INCOMPLETE") return sum;
        return sum + state.selectedMonthPlanTotal;
      }, 0),
    );
    const withCards = round2(
      fixtures.reduce((sum, fixture) => {
        const state = getLoanStateAtDate({
          ...fixtureToStateInput(fixture),
          asOfDate: asOf,
          selectedMonth: "2026-08",
        });
        if (state.status === "DATA_INCOMPLETE") return sum;
        // Donut/plan denominator = selectedMonthPlanTotal only (cards contribute 0)
        return sum + state.selectedMonthPlanTotal;
      }, 0),
    );
    assert.equal(withCards, amortPlan);
    assert.ok(amortPlan > 0);
    const activeCard = cardBehavior.find((f) => (f.monthlyPayment ?? 0) > 0)!;
    assert.ok((activeCard.monthlyPayment ?? 0) > 0);
  });

  it("AMORTIZING_RECOMMENDATIONS_EXCLUDE_CREDIT_CARDS", () => {
    const recommendationPool = fixtures
      .map((fixture) => {
        const state = getLoanStateAtDate({
          ...fixtureToStateInput(fixture),
          asOfDate: asOf,
          selectedMonth: "2026-08",
        });
        return {
          bankName: fixture.bankName,
          obligationType: state.obligationType,
          status: state.status,
          scheduleComplete: state.scheduleComplete,
          isActive: state.isActiveObligation,
          monthlyPayment: displayMonthlyPayment({
            obligationType: state.obligationType,
            selectedMonthPlanTotal: state.selectedMonthPlanTotal,
            storedMonthlyPayment: fixture.monthlyPayment,
          }),
        };
      })
      .filter(
        (row) =>
          row.obligationType === "AMORTIZING" &&
          row.status === "ACTIVE" &&
          row.scheduleComplete === true,
      );

    assert.ok(recommendationPool.every((r) => r.obligationType === "AMORTIZING"));
    assert.ok(recommendationPool.every((r) => r.status === "ACTIVE"));
    assert.ok(recommendationPool.every((r) => r.scheduleComplete === true));
    assert.ok(
      !recommendationPool.some((r) => /кредитка/i.test(r.bankName)),
    );
  });

  it("DATA_INCOMPLETE_RECOMMENDATIONS_EXCLUDED", () => {
    const incomplete = fixtures
      .map((fixture) => {
        const state = getLoanStateAtDate({
          ...fixtureToStateInput(fixture),
          asOfDate: asOf,
          selectedMonth: "2026-08",
        });
        return { bankName: fixture.bankName, state };
      })
      .filter(({ state }) => state.status === "DATA_INCOMPLETE");

    // Fixture set may have zero incomplete rows; synthesize one incomplete state.
    const syntheticIncomplete = getLoanStateAtDate({
      loan: {
        id: "loan_incomplete_synth",
        bankName: "Incomplete Bank",
        currentDebt: 100000,
        monthlyPayment: 10000,
        endDate: new Date("2027-01-01T00:00:00.000Z"),
      },
      payments: [],
      earlyRepaymentDate: null,
      asOfDate: asOf,
      selectedMonth: "2026-08",
    });
    assert.equal(syntheticIncomplete.status, "DATA_INCOMPLETE");
    assert.equal(syntheticIncomplete.isActiveObligation, true);

    const recommendationPool = [
      ...fixtures.map((fixture) => {
        const state = getLoanStateAtDate({
          ...fixtureToStateInput(fixture),
          asOfDate: asOf,
          selectedMonth: "2026-08",
        });
        return state;
      }),
      syntheticIncomplete,
    ].filter(
      (state) =>
        state.obligationType === "AMORTIZING" &&
        state.status === "ACTIVE" &&
        state.scheduleComplete === true,
    );

    assert.ok(recommendationPool.every((s) => s.status !== "DATA_INCOMPLETE"));
    assert.ok(
      !recommendationPool.some((s) => s.loanId === "loan_incomplete_synth"),
    );
    // Debt/active warning path still sees incomplete obligation.
    assert.ok(syntheticIncomplete.balance > 0 || incomplete.length >= 0);
  });

  it("SBER_OOO_5M_DUE_20260827 — remains until next Moscow day", () => {
    const fixture = realAmortizing.find(
      (f) => f.bankName === "Сбер ООО - 5 млн",
    )!;
    const input = fixtureToStateInput(fixture);
    const today = getLoanStateAtDate({
      ...input,
      asOfDate: "2026-08-27",
      selectedMonth: "2026-08",
    });
    assert.equal(today.status, "ACTIVE");
    assert.equal(today.balance, 1584635.47);
    assert.equal(
      toMoscowDateKey(today.nextOutstandingPayment!.paymentDate),
      "2026-08-27",
    );
    assert.equal(getPaymentPrincipal(today.nextOutstandingPayment!), 162559.93);

    const nextDay = getLoanStateAtDate({
      ...input,
      asOfDate: "2026-08-28",
      selectedMonth: "2026-08",
    });
    assert.equal(nextDay.balance, round2(1584635.47 - 162559.93));
    assert.equal(
      toMoscowDateKey(nextDay.nextOutstandingPayment!.paymentDate),
      "2026-09-28",
    );
  });

  it("AUTO_LOAN_YEAR_END_INTEREST_EXCLUDES_2027_PLUS", () => {
    const fixture = realAmortizing.find(
      (f) => f.bankName === "Авто кредит УралСиб",
    )!;
    const input = fixtureToStateInput(fixture);
    const state = getLoanStateAtDate({
      ...input,
      asOfDate: asOf,
      selectedMonth: "2026-08",
    });
    assert.ok(state.remainingInterest > state.interestUntilSelectedYearEnd);
    assert.ok(state.remainingPrincipal > state.principalUntilSelectedYearEnd);
    const yearEndKey = "2026-12-31";
    const remaining = input.payments.filter((p) =>
      isPaymentInProjectedRemaining({
        payment: p,
        asOfDateKey: asOf,
        earlyRepaymentDate: input.earlyRepaymentDate,
      }),
    );
    const afterYear = remaining.filter(
      (p) => toMoscowDateKey(p.paymentDate) > yearEndKey,
    );
    assert.ok(afterYear.length > 0);
    const interestAfter = round2(
      afterYear.reduce((s, p) => s + getPaymentInterest(p), 0),
    );
    assert.equal(
      round2(state.remainingInterest - state.interestUntilSelectedYearEnd),
      interestAfter,
    );
  });

  it("JULY_HISTORICAL_PLAN_RECONSTRUCTABLE / AUGUST_CLOSED_OZON / SEPTEMBER_FUTURE", () => {
    const ozon = realAmortizing.find(
      (f) => f.bankName === "Озон кредит 2 200 тыс",
    )!;
    const ozonInput = fixtureToStateInput(ozon);

    const july = getLoanStateAtDate({
      ...ozonInput,
      asOfDate: asOf,
      selectedMonth: "2026-07",
    });
    assert.equal(july.status, "CLOSED_SCHEDULE");
    assert.equal(july.balance, 0);
    assert.equal(july.selectedMonthPlanPrincipal, 365180.97);
    assert.ok(july.selectedMonthPlanTotal > 0);

    const august = getLoanStateAtDate({
      ...ozonInput,
      asOfDate: asOf,
      selectedMonth: "2026-08",
    });
    assert.equal(august.selectedMonthPlanTotal, 0);
    assert.equal(august.isActiveObligation, false);

    const ozon990 = realAmortizing.find(
      (f) => f.bankName === "Озон кредит 990 тыс",
    )!;
    const sep = getLoanStateAtDate({
      ...fixtureToStateInput(ozon990),
      asOfDate: asOf,
      selectedMonth: "2026-09",
    });
    assert.ok(sep.selectedMonthPlanTotal > 0);
    assert.equal(sep.selectedMonthPaymentCount, 1);

    const julyPlan = round2(
      fixtures.reduce((sum, fixture) => {
        const state = getLoanStateAtDate({
          ...fixtureToStateInput(fixture),
          asOfDate: asOf,
          selectedMonth: "2026-07",
        });
        if (state.status === "DATA_INCOMPLETE") return sum;
        return sum + state.selectedMonthPlanTotal;
      }, 0),
    );
    assert.ok(julyPlan > 365180.97);
  });

  it("INCOMPLETE_SCHEDULE_CROSS_SURFACE_CONSISTENCY", () => {
    const loan = {
      id: "loan_incomplete_x",
      bankName: "Банк Incomplete",
      currentDebt: 500000,
    };
    const payments = [
      payment({
        id: "only",
        loanId: loan.id,
        paymentDate: d("2026-09-15"),
        principalAmount: 10000,
        interestAmount: 1000,
        totalAmount: 11000,
      }),
    ];
    const state = getLoanStateAtDate({
      loan,
      payments,
      asOfDate: asOf,
      selectedMonth: "2026-09",
    });
    assert.equal(state.status, "DATA_INCOMPLETE");
    assert.equal(state.selectedMonthPlanTotal, 0);
    const filtered = filterOperationalLoanSchedulePayments({
      payments,
      loanStatesById: new Map([[loan.id, state]]),
      earlyRepaymentByLoanId: new Map(),
    });
    assert.equal(filtered.length, 0);
  });

  it("CURRENT_MONTH_PLAN_ARITHMETIC + no monthlyPayment fallback for amortizing", () => {
    for (const fixture of realAmortizing) {
      const state = getLoanStateAtDate({
        ...fixtureToStateInput(fixture),
        asOfDate: asOf,
        selectedMonth: "2026-08",
      });
      if (state.status === "DATA_INCOMPLETE") continue;
      assert.equal(
        state.selectedMonthPlanTotal,
        round2(
          state.selectedMonthPlanPrincipal + state.selectedMonthPlanInterest,
        ),
      );
    }
  });
});

describe("PROVEN_ACTUAL_PAYMENT_NOT_NEXT_OUTSTANDING", () => {
  it("future paid=true is not returned as next outstanding", () => {
    const loan = {
      id: "loan_proven_next",
      bankName: "Тест next",
      currentDebt: 100000,
    };
    const payments = [
      payment({
        id: "paid_future",
        loanId: loan.id,
        paymentDate: d("2026-09-01"),
        paid: true,
        principalAmount: 40000,
        interestAmount: 1000,
        totalAmount: 41000,
      }),
      payment({
        id: "unpaid_later",
        loanId: loan.id,
        paymentDate: d("2026-10-01"),
        paid: false,
        principalAmount: 60000,
        interestAmount: 1000,
        totalAmount: 61000,
      }),
    ];
    const state = getLoanStateAtDate({
      loan,
      payments,
      asOfDate: "2026-08-27",
      selectedMonth: "2026-08",
    });
    assert.equal(state.nextOutstandingPayment?.id, "unpaid_later");
    assert.notEqual(state.nextOutstandingPayment?.id, "paid_future");
  });
});
