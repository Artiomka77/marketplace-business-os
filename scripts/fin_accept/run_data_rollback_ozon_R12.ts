/**
 * Restore exact Ozon ProfitPeriodMetric rows from a pre-cutover snapshot JSON.
 * Full contract: totals + analyticsPayload + checksum/fingerprint/meta/dataMode +
 * exact staleAfterMs (including null). Validates scope/formula allowlist and
 * meta.payloadChecksum === payloadChecksum BEFORE any write. Atomic transaction;
 * bad snapshot → no partial writes.
 *
 *   DATABASE_URL=... node --import tsx scripts/fin_accept/run_data_rollback_ozon_R12.ts snapshot.json
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import { FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1 } from "@/lib/profitReadModel/contract";
import { CANONICAL_PROFIT_COMPANY_SCOPES } from "@/lib/profitReadModel/canonicalScopes";
import { createWaveBProfitTargetPrismaClient } from "@/lib/profitReadModel/targetClient";

const snapPath = process.argv[2];
if (!snapPath) {
  console.error("usage: run_data_rollback_ozon_R12.ts <snapshot.json>");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(2);
}

const ALLOWED_SCOPES = new Set<string>(CANONICAL_PROFIT_COMPANY_SCOPES);
const ALLOWED_FORMULA = FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1;
const DATE_FROM = "2026-10-19";
const DATE_TO = "2026-10-25";

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
  meta: { payloadChecksum?: string; companyScope?: string; marketplace?: string };
  analyticsPayload: unknown;
  generatedAt?: string;
  staleAfterMs?: number | null;
};

function hasOwnStale(r: SnapshotRow): boolean {
  return Object.prototype.hasOwnProperty.call(r, "staleAfterMs");
}

const raw = JSON.parse(fs.readFileSync(snapPath, "utf8"));
const rows = raw as SnapshotRow[];

assert.ok(Array.isArray(rows) && rows.length > 0, "snapshot must be non-empty array");

for (const r of rows) {
  assert.equal(r.marketplace, "OZON", "marketplace must be OZON");
  assert.equal(r.dateFrom, DATE_FROM);
  assert.equal(r.dateTo, DATE_TO);
  assert.ok(ALLOWED_SCOPES.has(r.companyScope), `companyScope not allowed: ${r.companyScope}`);
  assert.equal(
    r.formulaVersion,
    ALLOWED_FORMULA,
    `formulaVersion must be ${ALLOWED_FORMULA}`,
  );
  assert.ok(r.totals != null, "totals required");
  assert.ok(r.analyticsPayload != null, "analyticsPayload required");
  assert.ok(typeof r.payloadChecksum === "string" && r.payloadChecksum, "payloadChecksum");
  assert.ok(
    typeof r.sourceFingerprint === "string" && r.sourceFingerprint,
    "sourceFingerprint",
  );
  assert.ok(r.meta != null && typeof r.meta === "object", "meta required");
  assert.ok(typeof r.dataMode === "string" && r.dataMode, "dataMode");
  assert.ok(typeof r.coverageStatus === "string" && r.coverageStatus, "coverageStatus");
  assert.ok(hasOwnStale(r), "staleAfterMs key required (may be null)");
  if (r.meta.payloadChecksum && r.meta.payloadChecksum !== r.payloadChecksum) {
    throw new Error(
      `meta.payloadChecksum mismatch for ${r.companyScope}: refuse restore`,
    );
  }
  if (r.meta.companyScope && r.meta.companyScope !== r.companyScope) {
    throw new Error(`meta.companyScope mismatch for ${r.companyScope}`);
  }
  if (r.meta.marketplace && r.meta.marketplace !== "OZON") {
    throw new Error(`meta.marketplace mismatch for ${r.companyScope}`);
  }
}

async function main() {
  const client = createWaveBProfitTargetPrismaClient();
  const before: Array<Record<string, unknown>> = [];
  const after: Array<Record<string, unknown>> = [];
  await client.$transaction(async (tx) => {
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
        payloadChecksum: existing?.payloadChecksum ?? null,
        staleAfterMs: existing ? existing.staleAfterMs : null,
      });

      const data = {
        dataMode: r.dataMode,
        coverageStatus: r.coverageStatus,
        sourceFingerprint: r.sourceFingerprint,
        payloadChecksum: r.payloadChecksum,
        totals: r.totals as object,
        ...(r.comparison === undefined ? {} : { comparison: r.comparison as object }),
        meta: r.meta as object,
        analyticsPayload: r.analyticsPayload as object,
        generatedAt: r.generatedAt
          ? new Date(r.generatedAt)
          : existing?.generatedAt ?? new Date(),
        // Exact null restore — NEVER coalesce to existing
        staleAfterMs: r.staleAfterMs === undefined ? null : r.staleAfterMs,
      };

      let updated;
      if (!existing) {
        // Row absent before change: recreate from snapshot (scoped create)
        updated = await tx.profitPeriodMetric.create({
          data: {
            ...key,
            ...data,
          } as never,
        });
      } else {
        updated = await tx.profitPeriodMetric.update({
          where: { companyScope_marketplace_dateFrom_dateTo_formulaVersion: key },
          data: data as never,
        });
      }

      const aTotals = updated.totals as {
        netOzonExpenses?: number;
      };
      const aAnalytics = updated.analyticsPayload as {
        totals?: { netOzonExpenses?: number };
      };
      const metaCs = (updated.meta as { payloadChecksum?: string } | null)
        ?.payloadChecksum;
      after.push({
        companyScope: r.companyScope,
        totalsNet: aTotals.netOzonExpenses,
        analyticsNet: aAnalytics?.totals?.netOzonExpenses,
        payloadChecksum: updated.payloadChecksum,
        metaChecksum: metaCs ?? null,
        staleAfterMs: updated.staleAfterMs,
        totalsAnalyticsAgree:
          Number(aTotals.netOzonExpenses) ===
          Number(aAnalytics?.totals?.netOzonExpenses),
        checksumAgree: !metaCs || metaCs === updated.payloadChecksum,
      });
      if (!after[after.length - 1].totalsAnalyticsAgree) {
        throw new Error(
          `post-restore totals/analytics mismatch for ${r.companyScope}`,
        );
      }
      if (!after[after.length - 1].checksumAgree) {
        throw new Error(
          `post-restore meta checksum mismatch for ${r.companyScope}`,
        );
      }
      if (updated.staleAfterMs !== (r.staleAfterMs ?? null)) {
        throw new Error(
          `post-restore staleAfterMs not exact for ${r.companyScope}: got=${updated.staleAfterMs} want=${r.staleAfterMs}`,
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
    staleAfterMsExact: true,
    scopeFormulaValidated: true,
    metaChecksumValidated: true,
  };
  console.log(JSON.stringify(out, null, 2));
  console.log("DATA_ROLLBACK_LIVE_R16_OK");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
