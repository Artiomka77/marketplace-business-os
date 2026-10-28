/**
 * Export scoped ProfitPeriodMetric (+ optional SKU keys inventory) BEFORE rebuild.
 * Validates integrity of each row (meta.payloadChecksum === payloadChecksum,
 * analyticsPayload present, allowed scopes/formulas). Writes a restore-ready
 * snapshot JSON and a companion inventory of keys/dependent records.
 *
 *   DATABASE_URL=... node --import tsx scripts/fin_accept/export_profit_period_backup_R16.ts \
 *     /path/to/backup_dir
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import {
  FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
  FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
} from "@/lib/profitReadModel/contract";
import { CANONICAL_PROFIT_COMPANY_SCOPES } from "@/lib/profitReadModel/canonicalScopes";
import { createWaveBProfitTargetPrismaClient } from "@/lib/profitReadModel/targetClient";

const dateFrom = process.env.DATE_FROM || "2026-10-19";
const dateTo = process.env.DATE_TO || "2026-10-25";
const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: export_profit_period_backup_R16.ts <backup_dir>");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(2);
}

const ALLOWED_OZON = new Set(
  CANONICAL_PROFIT_COMPANY_SCOPES.map(
    (s) => `${s}|OZON|${FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1}`,
  ),
);
const ALLOWED_WB = new Set(
  CANONICAL_PROFIT_COMPANY_SCOPES.map(
    (s) => `${s}|WB|${FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1}`,
  ),
);

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const client = createWaveBProfitTargetPrismaClient();
  const rows = await client.profitPeriodMetric.findMany({
    where: {
      dateFrom: new Date(`${dateFrom}T00:00:00.000Z`),
      dateTo: new Date(`${dateTo}T00:00:00.000Z`),
      marketplace: { in: ["OZON", "WB"] },
      formulaVersion: {
        in: [
          FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
          FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
        ],
      },
    },
  });

  const ozonSnap: unknown[] = [];
  const wbSnap: unknown[] = [];
  const inventory: Array<Record<string, unknown>> = [];
  const integrityFailures: string[] = [];

  for (const r of rows) {
    const key = `${r.companyScope}|${r.marketplace}|${r.formulaVersion}`;
    const allowed =
      r.marketplace === "OZON" ? ALLOWED_OZON.has(key) : ALLOWED_WB.has(key);
    if (!allowed) {
      integrityFailures.push(`out_of_scope ${key}`);
      continue;
    }
    const meta = r.meta as { payloadChecksum?: string } | null;
    if (!r.payloadChecksum) integrityFailures.push(`empty checksum ${key}`);
    if (!r.analyticsPayload) integrityFailures.push(`missing analytics ${key}`);
    if (!r.totals) integrityFailures.push(`missing totals ${key}`);
    if (
      meta?.payloadChecksum &&
      meta.payloadChecksum !== r.payloadChecksum
    ) {
      integrityFailures.push(`meta_checksum_mismatch ${key}`);
    }

    const exported = {
      companyScope: r.companyScope,
      marketplace: r.marketplace,
      dateFrom: isoDate(r.dateFrom),
      dateTo: isoDate(r.dateTo),
      formulaVersion: r.formulaVersion,
      dataMode: r.dataMode,
      coverageStatus: r.coverageStatus,
      sourceFingerprint: r.sourceFingerprint,
      payloadChecksum: r.payloadChecksum,
      totals: r.totals,
      comparison: r.comparison,
      meta: r.meta,
      analyticsPayload: r.analyticsPayload,
      generatedAt: r.generatedAt.toISOString(),
      // Preserve exact null — do not omit the key
      staleAfterMs: r.staleAfterMs === null ? null : r.staleAfterMs,
    };
    if (r.marketplace === "OZON") ozonSnap.push(exported);
    else wbSnap.push(exported);

    const skuCount = await client.profitSkuPeriodMetric.count({
      where: {
        companyScope: r.companyScope,
        marketplace: r.marketplace,
        dateFrom: r.dateFrom,
        dateTo: r.dateTo,
        formulaVersion: r.formulaVersion,
      },
    });
    inventory.push({
      key,
      marketplace: r.marketplace,
      companyScope: r.companyScope,
      formulaVersion: r.formulaVersion,
      payloadChecksum: r.payloadChecksum,
      dataMode: r.dataMode,
      coverageStatus: r.coverageStatus,
      skuCount,
      hadRow: true,
    });
  }

  // Explicit absent keys (needed for restore policy)
  for (const scope of CANONICAL_PROFIT_COMPANY_SCOPES) {
    for (const [mp, fv] of [
      ["OZON", FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1],
      ["WB", FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1],
    ] as const) {
      const key = `${scope}|${mp}|${fv}`;
      if (!inventory.some((i) => i.key === key)) {
        inventory.push({
          key,
          marketplace: mp,
          companyScope: scope,
          formulaVersion: fv,
          hadRow: false,
          note: "absent_before_rebuild",
        });
      }
    }
  }

  if (integrityFailures.length) {
    console.error(
      JSON.stringify({ error: "BACKUP_INTEGRITY_FAIL", integrityFailures }, null, 2),
    );
    process.exit(3);
  }
  assert.ok(ozonSnap.length > 0, "OZON backup empty — refuse silent empty backup");

  // Full SKU payload for restored keys (scoped)
  const skuRows = await client.profitSkuPeriodMetric.findMany({
    where: {
      dateFrom: new Date(`${dateFrom}T00:00:00.000Z`),
      dateTo: new Date(`${dateTo}T00:00:00.000Z`),
      marketplace: { in: ["OZON", "WB"] },
      formulaVersion: {
        in: [
          FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
          FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
        ],
      },
    },
  });
  const skuSnap = skuRows.map((s) => ({
    companyScope: s.companyScope,
    marketplace: s.marketplace,
    dateFrom: isoDate(s.dateFrom),
    dateTo: isoDate(s.dateTo),
    formulaVersion: s.formulaVersion,
    productKey: s.productKey,
    payload: s.payload,
    generatedAt: s.generatedAt.toISOString(),
  }));

  // Dependent V6 / Dashboard snapshots (exact scoped restore)
  const V6_FV = "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2";
  const DASH_FV = "FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1";
  const dashRows = await client.dashboardPeriodSnapshot.findMany({
    where: {
      dateFrom: new Date(`${dateFrom}T00:00:00.000Z`),
      dateTo: new Date(`${dateTo}T00:00:00.000Z`),
      formulaVersion: { in: [V6_FV, DASH_FV] },
      companyScope: { in: [...CANONICAL_PROFIT_COMPANY_SCOPES] },
    },
  });
  const v6Snap = dashRows
    .filter((r) => r.formulaVersion === V6_FV)
    .map((r) => ({
      companyScope: r.companyScope,
      dateFrom: isoDate(r.dateFrom),
      dateTo: isoDate(r.dateTo),
      formulaVersion: r.formulaVersion,
      payload: r.payload,
      payloadChecksum: r.payloadChecksum,
      sourceFingerprint: r.sourceFingerprint,
      coverageStatus: r.coverageStatus,
      rowsCount: r.rowsCount,
      calculationMs: r.calculationMs,
      generatedAt: r.generatedAt.toISOString(),
    }));
  const dashSnap = dashRows
    .filter((r) => r.formulaVersion === DASH_FV)
    .map((r) => ({
      companyScope: r.companyScope,
      dateFrom: isoDate(r.dateFrom),
      dateTo: isoDate(r.dateTo),
      formulaVersion: r.formulaVersion,
      payload: r.payload,
      payloadChecksum: r.payloadChecksum,
      sourceFingerprint: r.sourceFingerprint,
      coverageStatus: r.coverageStatus,
      rowsCount: r.rowsCount,
      calculationMs: r.calculationMs,
      generatedAt: r.generatedAt.toISOString(),
    }));

  const ozonPath = path.join(outDir, "ozon_profit_period_snapshot.json");
  const wbPath = path.join(outDir, "wb_profit_period_snapshot.json");
  const skuPath = path.join(outDir, "sku_profit_period_snapshot.json");
  const invPath = path.join(outDir, "backup_inventory.json");
  const v6Path = path.join(outDir, "v6_period_snapshot.json");
  const dashPath = path.join(outDir, "dashboard_period_snapshot.json");
  const metaPath = path.join(outDir, "backup_meta.json");
  fs.writeFileSync(ozonPath, JSON.stringify(ozonSnap, null, 2) + "\n");
  fs.writeFileSync(wbPath, JSON.stringify(wbSnap, null, 2) + "\n");
  fs.writeFileSync(skuPath, JSON.stringify(skuSnap, null, 2) + "\n");
  fs.writeFileSync(invPath, JSON.stringify(inventory, null, 2) + "\n");
  fs.writeFileSync(v6Path, JSON.stringify(v6Snap, null, 2) + "\n");
  fs.writeFileSync(dashPath, JSON.stringify(dashSnap, null, 2) + "\n");
  const meta = {
    dateFrom,
    dateTo,
    exportedAt: new Date().toISOString(),
    ozonRows: ozonSnap.length,
    wbRows: wbSnap.length,
    skuRows: skuSnap.length,
    v6Rows: v6Snap.length,
    dashboardRows: dashSnap.length,
    ozonPath,
    wbPath,
    skuPath,
    invPath,
    v6Path,
    dashPath,
    restoreCommand: `WEEK_BACKUP_DIR=${outDir} bash scripts/fin_accept/deploy_entrypoint_R12.sh data-rollback`,
    cogsFinanceUntouched: true,
    dependentRecordsNote:
      "PPM+SKU+V6+Dashboard exact scoped restore. Empty SKU[] clears SKUs in scope. Inventory hadRow=false keys deleted. Corrupt inventory/PPM contradiction rejected.",
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  console.log(JSON.stringify(meta, null, 2));
  console.log("EXPORT_PROFIT_PERIOD_BACKUP_R16_OK");
  console.log(ozonPath);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
