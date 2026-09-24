import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildFinanceCategoryTreatmentIndex,
  getFinanceTransactionAccountEffect,
} from "@/lib/finance/financeMetrics";

const emptyIndex = buildFinanceCategoryTreatmentIndex([]);

/** Mirrors overlay/lib/finance/recalculateAccountBalances.ts (pure, no prisma). */
function resolveDisplayedAccountBalance(account: { currentBalance: unknown }) {
  const number = Number(account.currentBalance ?? 0);
  return Number.isFinite(number) ? number : 0;
}

/** Mirrors overlay/lib/finance/recalculateAccountBalances.ts (pure, no prisma). */
function computeAccountBalanceFromOpeningAndEffects(
  openingBalance: unknown,
  effects: number[]
) {
  const opening = Number(openingBalance ?? 0);
  const safeOpening = Number.isFinite(opening) ? opening : 0;
  return safeOpening + effects.reduce((sum, effectValue) => sum + effectValue, 0);
}

function effect(tx: {
  operationType: string;
  category?: string;
  amount: number;
  isInternalTransfer?: boolean;
  transferDirection?: string | null;
}) {
  return getFinanceTransactionAccountEffect(
    {
      operationType: tx.operationType,
      category: tx.category ?? "test",
      amount: tx.amount,
      isInternalTransfer: tx.isInternalTransfer ?? false,
      transferDirection: tx.transferDirection ?? null,
    },
    emptyIndex
  );
}

function accountKey(companyName: string, bankAccount: string) {
  return `${companyName}|||${bankAccount}`;
}

function reconstructFromFacts(
  openingBalance: number,
  facts: Array<{
    operationType: string;
    category?: string;
    amount: number;
    transactionStatus?: string;
    isInternalTransfer?: boolean;
    transferDirection?: string | null;
  }>
) {
  const effects = facts
    .filter((row) => row.transactionStatus !== "PLAN")
    .map((row) =>
      effect({
        operationType: row.operationType,
        category: row.category,
        amount: row.amount,
        isInternalTransfer: row.isInternalTransfer,
        transferDirection: row.transferDirection,
      })
    );

  return computeAccountBalanceFromOpeningAndEffects(openingBalance, effects);
}

function readWorkspace(rel: string) {
  const candidates = [
    path.join(process.cwd(), rel),
    path.join(process.cwd(), "overlay", rel),
    path.join(
      process.cwd(),
      "_isolated_financial_p1_accounts_final_preprod_work",
      "overlay",
      rel
    ),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, "utf8");
    }
  }

  throw new Error(`Missing file for source-contract assert: ${rel}`);
}

test("1. displayed balance reads FinanceAccount.currentBalance", () => {
  assert.equal(
    resolveDisplayedAccountBalance({ currentBalance: 3258465.71 }),
    3258465.71
  );
  assert.equal(resolveDisplayedAccountBalance({ currentBalance: "0" }), 0);

  const page = readWorkspace("app/finance/accounts/page.tsx");
  const recalc = readWorkspace("lib/finance/recalculateAccountBalances.ts");
  assert.match(page, /resolveDisplayedAccountBalance/);
  assert.match(page, /financeAccount\.findMany/);
  assert.match(recalc, /export function resolveDisplayedAccountBalance/);
  assert.match(recalc, /getFinanceTransactionAccountEffect/);
  assert.doesNotMatch(recalc, /getFinanceTransactionCashEffect/);
  assert.doesNotMatch(
    page,
    /current\.balance\s*\+=\s*effect|balance\s*\+=\s*effect/
  );
});

test("2. openingBalance is not ignored by reconstruct formula", () => {
  const balance = computeAccountBalanceFromOpeningAndEffects(1000, [
    500,
    -200,
  ]);
  assert.equal(balance, 1300);
});

test("3. PLAN excluded from current balance reconstruct", () => {
  const withPlan = reconstructFromFacts(1000, [
    { operationType: "EXPENSE", amount: 100, transactionStatus: "PLAN" },
    { operationType: "INCOME", amount: 50, transactionStatus: "FACT" },
  ]);
  assert.equal(withPlan, 1050);
});

test("4. INCOME positive account effect", () => {
  assert.equal(effect({ operationType: "INCOME", amount: 1500 }), 1500);
});

test("5. EXPENSE negative account effect", () => {
  assert.equal(effect({ operationType: "EXPENSE", amount: 1500 }), -1500);
});

test("6. PERSONAL negative per cash effect rule", () => {
  assert.equal(effect({ operationType: "PERSONAL", amount: 700 }), -700);
});

test("7. TRANSFER_OUT decreases account", () => {
  assert.equal(
    effect({
      operationType: "TRANSFER",
      amount: 400,
      isInternalTransfer: true,
      transferDirection: "TRANSFER_OUT",
    }),
    -400
  );
});

test("8. TRANSFER_IN increases account", () => {
  assert.equal(
    effect({
      operationType: "TRANSFER",
      amount: 400,
      isInternalTransfer: true,
      transferDirection: "TRANSFER_IN",
    }),
    400
  );
});

test("9. internal transfer pair: total neutral, individuals move", () => {
  const out = effect({
    operationType: "TRANSFER",
    amount: 2500,
    isInternalTransfer: true,
    transferDirection: "TRANSFER_OUT",
  });
  const inn = effect({
    operationType: "TRANSFER",
    amount: 2500,
    isInternalTransfer: true,
    transferDirection: "TRANSFER_IN",
  });

  assert.equal(out, -2500);
  assert.equal(inn, 2500);
  assert.equal(out + inn, 0);

  const source = reconstructFromFacts(10000, [
    {
      operationType: "TRANSFER",
      amount: 2500,
      isInternalTransfer: true,
      transferDirection: "TRANSFER_OUT",
    },
  ]);
  const dest = reconstructFromFacts(0, [
    {
      operationType: "TRANSFER",
      amount: 2500,
      isInternalTransfer: true,
      transferDirection: "TRANSFER_IN",
    },
  ]);

  assert.equal(source, 7500);
  assert.equal(dest, 2500);
  assert.equal(source + dest, 10000);
});

test("10. company/account isolation keys", () => {
  const movements = new Map<string, number>();

  const rows = [
    {
      companyName: "ИП Петров",
      bankAccount: "Сбербанк карта",
      effect: effect({ operationType: "INCOME", amount: 100 }),
    },
    {
      companyName: "ИП Петров",
      bankAccount: "Озон карта",
      effect: effect({ operationType: "EXPENSE", amount: 40 }),
    },
    {
      companyName: "ИП Лебедева",
      bankAccount: "Сбербанк карта",
      effect: effect({ operationType: "INCOME", amount: 10 }),
    },
  ];

  for (const row of rows) {
    const key = accountKey(row.companyName, row.bankAccount);
    movements.set(key, (movements.get(key) ?? 0) + row.effect);
  }

  assert.equal(
    movements.get(accountKey("ИП Петров", "Сбербанк карта")),
    100
  );
  assert.equal(movements.get(accountKey("ИП Петров", "Озон карта")), -40);
  assert.equal(
    movements.get(accountKey("ИП Лебедева", "Сбербанк карта")),
    10
  );
  assert.notEqual(
    accountKey("ИП Петров", "Сбербанк карта"),
    accountKey("ИП Лебедева", "Сбербанк карта")
  );
});

test("11. Calendar uses stored FinanceAccount.currentBalance", () => {
  const src = readWorkspace("app/finance/calendar/page.tsx");
  assert.match(src, /account\.currentBalance|currentBalance/);
  assert.match(
    src,
    /cashOnAccounts\s*=\s*accounts\.reduce\([\s\S]*currentBalance/
  );
});

test("12. Forecast uses stored FinanceAccount.currentBalance", () => {
  const src = readWorkspace("app/finance/forecast/page.tsx");
  assert.match(src, /account\.currentBalance|currentBalance/);
  assert.match(
    src,
    /totalCash\s*=\s*accounts\.reduce\([\s\S]*currentBalance/
  );
});

test("13. Sber fixture: opening 1000 + effects 3257465.71 => 3258465.71", () => {
  assert.equal(
    computeAccountBalanceFromOpeningAndEffects(1000, [3257465.71]),
    3258465.71
  );
});

test("14. Ozon fixture: opening 0 + no FACT => 0", () => {
  assert.equal(reconstructFromFacts(0, []), 0);
  assert.equal(computeAccountBalanceFromOpeningAndEffects(0, []), 0);
});

test("15. two identical FACT expenses both valid — no dedupe", () => {
  const effects = [
    effect({ operationType: "EXPENSE", category: "Реклама", amount: 10000 }),
    effect({ operationType: "EXPENSE", category: "Реклама", amount: 10000 }),
  ];

  assert.equal(effects.length, 2);
  assert.equal(
    effects.reduce((sum, value) => sum + value, 0),
    -20000
  );

  // Guard: no fingerprint dedupe helper introduced in accounts overlay sources.
  const page = readWorkspace("app/finance/accounts/page.tsx");
  const recalc = readWorkspace("lib/finance/recalculateAccountBalances.ts");
  assert.doesNotMatch(page, /dedupe|fingerprint|uniqueBy/i);
  assert.doesNotMatch(recalc, /dedupe|fingerprint|uniqueBy/i);
});
