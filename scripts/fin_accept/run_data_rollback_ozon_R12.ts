/**
 * Restore exact Ozon ProfitPeriodMetric rows from a pre-cutover snapshot JSON.
 * Scope: marketplace=OZON + dateFrom/dateTo only. No COGS/Finance.
 *
 * Snapshot format: [{ companyScope, marketplace, dateFrom, dateTo, formulaVersion, totals, meta? }]
 *
 *   DATABASE_URL=... node --import tsx scripts/fin_accept/run_data_rollback_ozon_R12.ts snapshot.json
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";

const snapPath = process.argv[2];
if (!snapPath) {
  console.error("usage: run_data_rollback_ozon_R12.ts <snapshot.json>");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(2);
}

const rows = JSON.parse(fs.readFileSync(snapPath, "utf8")) as Array<{
  companyScope: string;
  marketplace: string;
  dateFrom: string;
  dateTo: string;
  formulaVersion: string;
  totals: unknown;
  meta?: unknown;
}>;

assert.ok(Array.isArray(rows) && rows.length > 0);
for (const r of rows) {
  assert.equal(r.marketplace, "OZON");
  assert.equal(r.dateFrom, "2026-10-19");
  assert.equal(r.dateTo, "2026-10-25");
}

const prisma = new PrismaClient();

async function main() {
  const before = [];
  const after = [];
  for (const r of rows) {
    const key = {
      companyScope: r.companyScope,
      marketplace: "OZON" as const,
      dateFrom: new Date(`${r.dateFrom}T00:00:00.000Z`),
      dateTo: new Date(`${r.dateTo}T00:00:00.000Z`),
      formulaVersion: r.formulaVersion,
    };
    const existing = await prisma.profitPeriodMetric.findUnique({
      where: { companyScope_marketplace_dateFrom_dateTo_formulaVersion: key },
    });
    before.push({
      companyScope: r.companyScope,
      hadRow: Boolean(existing),
      net: (existing?.totals as { netOzonExpenses?: number } | undefined)
        ?.netOzonExpenses,
    });
    if (!existing) {
      throw new Error(`missing target row for restore: ${r.companyScope}`);
    }
    const updated = await prisma.profitPeriodMetric.update({
      where: { companyScope_marketplace_dateFrom_dateTo_formulaVersion: key },
      data: {
        totals: r.totals as object,
        ...(r.meta != null ? { meta: r.meta as object } : {}),
      },
    });
    after.push({
      companyScope: r.companyScope,
      net: (updated.totals as { netOzonExpenses?: number }).netOzonExpenses,
      representation: (
        updated.totals as { netOzonExpensesRepresentation?: string }
      ).netOzonExpensesRepresentation,
    });
  }
  const out = {
    procedure: "restore_exact_period_snapshot_rows",
    rowsRestored: rows.length,
    before,
    after,
    cogsFinanceUntouched: true,
  };
  console.log(JSON.stringify(out, null, 2));
  console.log("DATA_ROLLBACK_LIVE_R12_OK");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
