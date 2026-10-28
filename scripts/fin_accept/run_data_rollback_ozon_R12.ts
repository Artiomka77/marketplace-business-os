/**
 * Restore exact Ozon ProfitPeriodMetric rows from a pre-cutover snapshot JSON.
 * Restores the FULL read-model contract fields consumers actually read
 * (totals + analyticsPayload + checksum/fingerprint/meta/dataMode/…).
 * Scope: marketplace=OZON + dateFrom/dateTo only. No COGS/Finance.
 *
 * Snapshot format: array of full ProfitPeriodMetric-compatible rows.
 *
 *   DATABASE_URL=... node --import tsx scripts/fin_accept/run_data_rollback_ozon_R12.ts snapshot.json
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { prisma } from "@/lib/prisma";

const snapPath = process.argv[2];
if (!snapPath) {
  console.error("usage: run_data_rollback_ozon_R12.ts <snapshot.json>");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(2);
}

type SnapshotRow = {
  companyScope: string;
  marketplace: string;
  dateFrom: string;
  dateTo: string;
  formulaVersion: string;
  dataMode: string;
  coverageStatus: string;
  sourceFingerprint: string;
  payloadChecksum: string;
  totals: unknown;
  comparison?: unknown;
  meta: unknown;
  analyticsPayload: unknown;
  generatedAt?: string;
  staleAfterMs?: number | null;
};

const rows = JSON.parse(fs.readFileSync(snapPath, "utf8")) as SnapshotRow[];

assert.ok(Array.isArray(rows) && rows.length > 0, "snapshot must be non-empty array");
for (const r of rows) {
  assert.equal(r.marketplace, "OZON", "marketplace must be OZON");
  assert.equal(r.dateFrom, "2026-10-19");
  assert.equal(r.dateTo, "2026-10-25");
  assert.ok(r.totals != null, "totals required");
  assert.ok(r.analyticsPayload != null, "analyticsPayload required");
  assert.ok(typeof r.payloadChecksum === "string" && r.payloadChecksum, "payloadChecksum");
  assert.ok(
    typeof r.sourceFingerprint === "string" && r.sourceFingerprint,
    "sourceFingerprint",
  );
  assert.ok(r.meta != null, "meta required");
  assert.ok(typeof r.dataMode === "string" && r.dataMode, "dataMode");
  assert.ok(typeof r.coverageStatus === "string" && r.coverageStatus, "coverageStatus");
}

async function main() {
  const before = [];
  const after = [];
  await prisma.$transaction(async (tx) => {
    for (const r of rows) {
      const key = {
        companyScope: r.companyScope,
        marketplace: "OZON" as const,
        dateFrom: new Date(`${r.dateFrom}T00:00:00.000Z`),
        dateTo: new Date(`${r.dateTo}T00:00:00.000Z`),
        formulaVersion: r.formulaVersion,
      };
      const existing = await tx.profitPeriodMetric.findUnique({
        where: { companyScope_marketplace_dateFrom_dateTo_formulaVersion: key },
      });
      before.push({
        companyScope: r.companyScope,
        hadRow: Boolean(existing),
        totalsNet: (existing?.totals as { netOzonExpenses?: number } | undefined)
          ?.netOzonExpenses,
        analyticsNet: (
          existing?.analyticsPayload as { totals?: { netOzonExpenses?: number } } | undefined
        )?.totals?.netOzonExpenses,
        payloadChecksum: existing?.payloadChecksum,
      });
      if (!existing) {
        throw new Error(`missing target row for restore: ${r.companyScope}`);
      }
      const updated = await tx.profitPeriodMetric.update({
        where: { companyScope_marketplace_dateFrom_dateTo_formulaVersion: key },
        data: {
          dataMode: r.dataMode,
          coverageStatus: r.coverageStatus,
          sourceFingerprint: r.sourceFingerprint,
          payloadChecksum: r.payloadChecksum,
          totals: r.totals as object,
          comparison: (r.comparison ?? null) as object | null,
          meta: r.meta as object,
          analyticsPayload: r.analyticsPayload as object,
          generatedAt: r.generatedAt ? new Date(r.generatedAt) : existing.generatedAt,
          staleAfterMs: r.staleAfterMs ?? existing.staleAfterMs,
        },
      });
      const aTotals = updated.totals as {
        netOzonExpenses?: number;
        netOzonExpensesRepresentation?: string;
      };
      const aAnalytics = updated.analyticsPayload as {
        totals?: { netOzonExpenses?: number };
      };
      after.push({
        companyScope: r.companyScope,
        totalsNet: aTotals.netOzonExpenses,
        analyticsNet: aAnalytics?.totals?.netOzonExpenses,
        representation: aTotals.netOzonExpensesRepresentation,
        payloadChecksum: updated.payloadChecksum,
        sourceFingerprint: updated.sourceFingerprint,
        metaChecksum: (updated.meta as { payloadChecksum?: string } | null)?.payloadChecksum,
        totalsAnalyticsAgree:
          Number(aTotals.netOzonExpenses) === Number(aAnalytics?.totals?.netOzonExpenses),
      });
      if (!after[after.length - 1].totalsAnalyticsAgree) {
        throw new Error(
          `post-restore totals/analytics mismatch for ${r.companyScope}`,
        );
      }
    }
  });

  const out = {
    procedure: "restore_full_profit_period_metric_contract",
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
