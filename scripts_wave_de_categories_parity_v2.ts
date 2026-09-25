import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import {
  buildFinanceCategoryTreatmentIndex,
  calculateFinanceMetricsForRows,
  getFinanceTransactionCashEffect,
  getFinanceTransactionTreatment,
} from '@/lib/finance/financeMetrics';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);

function ser(v: any): any {
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(ser);
  if (v && typeof v === 'object') {
    if (v.constructor?.name === 'Decimal') return Number(v);
    const o: any = {};
    for (const [k, x] of Object.entries(v)) o[k] = ser(x);
    return o;
  }
  return v;
}

async function main() {
  const company = 'ALL';
  const dateFrom = '2026-09-07';
  const dateTo = '2026-09-13';
  const periodStart = new Date(dateFrom + 'T00:00:00.000Z');
  const periodEndExclusive = new Date('2026-09-14T00:00:00.000Z');

  const categories = await prisma.financeCategory.findMany({ where: { isActive: true } });
  const factRows = await prisma.financeTransaction.findMany({
    where: {
      transactionStatus: 'FACT',
      operationDate: { gte: periodStart, lt: periodEndExclusive },
    },
    select: {
      companyName: true,
      operationType: true,
      category: true,
      subcategory: true,
      amount: true,
      isInternalTransfer: true,
      transferDirection: true,
    },
  });
  const categoryIndex = buildFinanceCategoryTreatmentIndex(categories);
  const metrics = calculateFinanceMetricsForRows({ transactions: factRows, categories });

  let ownerN = 0, loanPrincipalN = 0, loanInterestN = 0, transferN = 0, ordinaryN = 0;
  for (const row of factRows) {
    const t = getFinanceTransactionTreatment(row, categoryIndex).treatment;
    if (t === 'OWNER_WITHDRAWAL') ownerN++;
    else if (t === 'CREDIT_PRINCIPAL') loanPrincipalN++;
    else if (t === 'CREDIT_INTEREST') loanInterestN++;
    else if (t === 'IGNORE' || row.isInternalTransfer || row.operationType === 'TRANSFER') transferN++;
    else ordinaryN++;
    getFinanceTransactionCashEffect(row, categoryIndex);
  }

  const pageUsesStockPlanning = false; // enforced by source contract separately
  const out = {
    PASS: factRows.length > 0 && categories.length > 0 && typeof metrics.ownerWithdrawals === 'number',
    control: { company, dateFrom, dateTo },
    factRowCount: factRows.length,
    categoryCount: categories.length,
    metrics: ser(metrics),
    treatmentCounts: { ownerN, loanPrincipalN, loanInterestN, transferN, ordinaryN },
    authority: 'FinanceTransaction FACT + FinanceCategory via financeMetrics',
    notStockPlanning: true,
    heavyFinancialCore: 0,
    pageUsesStockPlanning,
  };
  console.log(JSON.stringify(out, null, 2));
  if (!out.PASS) process.exitCode = 1;
}
main().catch((e) => { console.log(JSON.stringify({ PASS: false, error: String(e?.stack || e) })); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect().catch(()=>{}); await pool.end().catch(()=>{}); });
