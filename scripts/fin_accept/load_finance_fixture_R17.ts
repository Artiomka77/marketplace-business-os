/**
 * Load accepted offline Finance adapter rows into an ephemeral DB.
 * Does NOT touch production. No balancing entries — uses fixture as-is.
 *
 *   DATABASE_URL=... node --import tsx scripts/fin_accept/load_finance_fixture_R17.ts \
 *     path/to/FINANCE_ADAPTER_ROWS.json
 */
import fs from "node:fs";
import { prisma } from "@/lib/prisma";

const path = process.argv[2];
if (!path) {
  console.error("usage: load_finance_fixture_R17.ts <FINANCE_ADAPTER_ROWS.json>");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(2);
}
if (/72\.56\.4\.62|ardelo|production/i.test(process.env.DATABASE_URL)) {
  console.error("REFUSE: DATABASE_URL looks like production");
  process.exit(3);
}

type Adapter = {
  financeCategory?: Array<Record<string, unknown>>;
  financeTransaction?: Array<Record<string, unknown>>;
  loan?: Array<Record<string, unknown>>;
  loanPayment?: Array<Record<string, unknown>>;
};

function d(v: unknown): Date | null {
  if (v == null || v === "") return null;
  const x = new Date(String(v));
  return Number.isNaN(x.getTime()) ? null : x;
}
function n(v: unknown): number | null {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(path, "utf8")) as Adapter;
  const cats = raw.financeCategory || [];
  const txs = raw.financeTransaction || [];
  const loans = raw.loan || [];
  const pays = raw.loanPayment || [];

  // Clear only finance-domain tables in ephemeral DB
  await prisma.$executeRawUnsafe(`TRUNCATE "LoanPayment" CASCADE`);
  await prisma.$executeRawUnsafe(`TRUNCATE "Loan" CASCADE`);
  await prisma.$executeRawUnsafe(`TRUNCATE "FinanceTransaction" CASCADE`);
  await prisma.$executeRawUnsafe(`TRUNCATE "FinanceCategory" CASCADE`);

  for (const c of cats) {
    await prisma.financeCategory.create({
      data: {
        id: String(c.id),
        name: String(c.name),
        parentName: (c.parentName as string | null) ?? null,
        categoryType: String(c.categoryType ?? "EXPENSE"),
        sortOrder: Number(c.sortOrder ?? 0),
        isActive: c.isActive !== false,
        profitTreatment: String(c.profitTreatment ?? "AUTO"),
        createdAt: d(c.createdAt) ?? new Date(),
      },
    });
  }

  for (const L of loans) {
    await prisma.loan.create({
      data: {
        id: String(L.id),
        bankName: String(L.bankName ?? ""),
        companyName: String(L.companyName ?? ""),
        creditLimit: n(L.creditLimit) ?? 0,
        currentDebt: n(L.currentDebt) ?? 0,
        interestRate: n(L.interestRate),
        monthlyPayment: n(L.monthlyPayment) ?? 0,
        paymentFrequency: String(L.paymentFrequency ?? "MONTHLY"),
        startDate: d(L.startDate),
        endDate: d(L.endDate),
        createdAt: d(L.createdAt) ?? new Date(),
      } as never,
    });
  }

  for (const p of pays) {
    await prisma.loanPayment.create({
      data: {
        id: String(p.id),
        loanId: String(p.loanId),
        paymentDate: d(p.paymentDate) ?? new Date(),
        totalAmount: n(p.totalAmount) ?? 0,
        principalAmount: n(p.principalAmount) ?? 0,
        interestAmount: n(p.interestAmount) ?? 0,
        paid: Boolean(p.paid),
        createdAt: d(p.createdAt) ?? new Date(),
      } as never,
    });
  }

  for (const t of txs) {
    await prisma.financeTransaction.create({
      data: {
        id: String(t.id),
        companyId: (t.companyId as string | null) ?? null,
        companyName: String(t.companyName ?? ""),
        amount: n(t.amount) ?? 0,
        operationType: String(t.operationType ?? "EXPENSE"),
        category: String(t.category ?? ""),
        subcategory: (t.subcategory as string | null) ?? null,
        isInternalTransfer: Boolean(t.isInternalTransfer),
        counterparty: (t.counterparty as string | null) ?? null,
        comment: (t.comment as string | null) ?? null,
        sourceType: (t.sourceType as string | null) ?? null,
        sourceId: (t.sourceId as string | null) ?? null,
        transactionStatus: String(t.transactionStatus ?? "FACT"),
        operationDate: d(t.operationDate) ?? new Date(),
        obligationDate: d(t.obligationDate),
        transferGroupId: (t.transferGroupId as string | null) ?? null,
        transferDirection: (t.transferDirection as string | null) ?? null,
      } as never,
    });
  }

  const out = {
    categories: cats.length,
    loans: loans.length,
    loanPayments: pays.length,
    transactions: txs.length,
    ok: true,
  };
  console.log(JSON.stringify(out, null, 2));
  console.log("LOAD_FINANCE_FIXTURE_R17_OK");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
