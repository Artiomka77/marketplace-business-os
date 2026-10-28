/**
 * Scoped data rollback from export_profit_period_backup_R16 output.
 *
 * Usage:
 *   node --import tsx scripts/fin_accept/run_data_rollback_ozon_R12.ts <backup_dir|ozon.json>
 *
 * Restores Ozon+WB ProfitPeriodMetric full contract, removes in-scope rows that
 * were absent at backup (hadRow=false) but exist now, restores SKU rows when
 * present in backup, validates scope/formula/meta checksum, exact staleAfterMs.
 * Does NOT touch COGS/Finance/loans/primary marketplace tables.
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

const arg = process.argv[2];
if (!arg) {
  console.error("usage: run_data_rollback_ozon_R12.ts <backup_dir|ozon_snapshot.json>");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(2);
}

const ALLOWED_SCOPES = new Set<string>(CANONICAL_PROFIT_COMPANY_SCOPES);
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

type InventoryRow = {
  key: string;
  marketplace: string;
  companyScope: string;
  formulaVersion: string;
  hadRow: boolean;
};

function loadJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

function resolveInputs(input: string): {
  ozon: SnapshotRow[];
  wb: SnapshotRow[];
  inventory: InventoryRow[];
  sku: Array<Record<string, unknown>>;
  backupDir: string | null;
} {
  const st = fs.statSync(input);
  if (st.isDirectory()) {
    const ozon = loadJson<SnapshotRow[]>(
      path.join(input, "ozon_profit_period_snapshot.json"),
    );
    const wbPath = path.join(input, "wb_profit_period_snapshot.json");
    const wb = fs.existsSync(wbPath) ? loadJson<SnapshotRow[]>(wbPath) : [];
    const invPath = path.join(input, "backup_inventory.json");
    const inventory = fs.existsSync(invPath)
      ? loadJson<InventoryRow[]>(invPath)
      : [];
    const skuPath = path.join(input, "sku_profit_period_snapshot.json");
    const sku = fs.existsSync(skuPath)
      ? loadJson<Array<Record<string, unknown>>>(skuPath)
      : [];
    return { ozon, wb, inventory, sku, backupDir: input };
  }
  return {
    ozon: loadJson<SnapshotRow[]>(input),
    wb: [],
    inventory: [],
    sku: [],
    backupDir: null,
  };
}

function validateRow(r: SnapshotRow, marketplace: "OZON" | "WB") {
  assert.equal(r.marketplace, marketplace);
  assert.equal(r.dateFrom, DATE_FROM);
  assert.equal(r.dateTo, DATE_TO);
  assert.ok(ALLOWED_SCOPES.has(r.companyScope), `bad scope ${r.companyScope}`);
  const wantFormula =
    marketplace === "OZON"
      ? FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1
      : FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1;
  assert.equal(r.formulaVersion, wantFormula);
  assert.ok(r.totals != null);
  assert.ok(r.analyticsPayload != null);
  assert.ok(typeof r.payloadChecksum === "string" && r.payloadChecksum);
  assert.ok(typeof r.sourceFingerprint === "string" && r.sourceFingerprint);
  assert.ok(r.meta != null && typeof r.meta === "object");
  assert.ok(Object.prototype.hasOwnProperty.call(r, "staleAfterMs"));
  if (r.meta.payloadChecksum && r.meta.payloadChecksum !== r.payloadChecksum) {
    throw new Error(`meta.payloadChecksum mismatch ${r.companyScope} ${marketplace}`);
  }
  if (r.meta.companyScope && r.meta.companyScope !== r.companyScope) {
    throw new Error(`meta.companyScope mismatch ${r.companyScope}`);
  }
  if (r.meta.marketplace && r.meta.marketplace !== marketplace) {
    throw new Error(`meta.marketplace mismatch ${r.companyScope}`);
  }
}

async function upsertPpm(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  r: SnapshotRow,
) {
  const key = {
    companyScope: r.companyScope,
    marketplace: r.marketplace,
    dateFrom: new Date(`${r.dateFrom}T00:00:00.000Z`),
    dateTo: new Date(`${r.dateTo}T00:00:00.000Z`),
    formulaVersion: r.formulaVersion,
  };
  const existing = await tx.profitPeriodMetric.findUnique({
    where: { companyScope_marketplace_dateFrom_dateTo_formulaVersion: key },
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
    staleAfterMs: r.staleAfterMs === undefined ? null : r.staleAfterMs,
  };
  if (!existing) {
    return tx.profitPeriodMetric.create({ data: { ...key, ...data } as never });
  }
  return tx.profitPeriodMetric.update({
    where: { companyScope_marketplace_dateFrom_dateTo_formulaVersion: key },
    data: data as never,
  });
}

async function main() {
  const { ozon, wb, inventory, sku, backupDir } = resolveInputs(arg);
  assert.ok(Array.isArray(ozon) && ozon.length > 0, "ozon snapshot required");
  for (const r of ozon) validateRow(r, "OZON");
  for (const r of wb) validateRow(r, "WB");

  const client = createWaveBProfitTargetPrismaClient();
  const deleted: string[] = [];
  const restored: string[] = [];

  const absentKeys = new Set(
    inventory
      .filter((i) => !i.hadRow)
      .map((i) => `${i.companyScope}|${i.marketplace}|${i.formulaVersion}`),
  );

  await client.$transaction(async (tx) => {
    // 1) Delete in-scope rows that were absent at backup time
    for (const inv of inventory) {
      if (inv.hadRow) continue;
      if (!ALLOWED_SCOPES.has(inv.companyScope)) continue;
      if (inv.marketplace !== "OZON" && inv.marketplace !== "WB") continue;
      const key = {
        companyScope: inv.companyScope,
        marketplace: inv.marketplace,
        dateFrom: new Date(`${DATE_FROM}T00:00:00.000Z`),
        dateTo: new Date(`${DATE_TO}T00:00:00.000Z`),
        formulaVersion: inv.formulaVersion,
      };
      const existing = await tx.profitPeriodMetric.findUnique({
        where: { companyScope_marketplace_dateFrom_dateTo_formulaVersion: key },
      });
      if (existing) {
        await tx.profitSkuPeriodMetric.deleteMany({
          where: {
            companyScope: inv.companyScope,
            marketplace: inv.marketplace,
            dateFrom: key.dateFrom,
            dateTo: key.dateTo,
            formulaVersion: inv.formulaVersion,
          },
        });
        await tx.profitPeriodMetric.delete({
          where: { companyScope_marketplace_dateFrom_dateTo_formulaVersion: key },
        });
        deleted.push(inv.key);
      }
    }

    // 2) Restore snapshots (skip keys marked absent-at-backup even if present in array)
    for (const r of [...ozon, ...wb]) {
      const k = `${r.companyScope}|${r.marketplace}|${r.formulaVersion}`;
      if (absentKeys.has(k)) {
        continue;
      }
      const updated = await upsertPpm(tx, r);
      if (
        updated.staleAfterMs !== (r.staleAfterMs ?? null)
      ) {
        throw new Error(`staleAfterMs not exact ${r.companyScope}`);
      }
      const metaCs = (updated.meta as { payloadChecksum?: string } | null)
        ?.payloadChecksum;
      if (metaCs && metaCs !== updated.payloadChecksum) {
        throw new Error(`post meta checksum ${r.companyScope}`);
      }
      restored.push(`${r.companyScope}|${r.marketplace}`);
    }

    // 3) SKU: if snapshot provided, replace SKUs for restored keys; else leave
    if (sku.length > 0) {
      const keys = new Set(
        [...ozon, ...wb].map(
          (r) => `${r.companyScope}|${r.marketplace}|${r.formulaVersion}`,
        ),
      );
      for (const key of keys) {
        const [companyScope, marketplace, formulaVersion] = key.split("|");
        await tx.profitSkuPeriodMetric.deleteMany({
          where: {
            companyScope,
            marketplace,
            dateFrom: new Date(`${DATE_FROM}T00:00:00.000Z`),
            dateTo: new Date(`${DATE_TO}T00:00:00.000Z`),
            formulaVersion,
          },
        });
      }
      for (const s of sku) {
        await tx.profitSkuPeriodMetric.create({
          data: {
            companyScope: String(s.companyScope),
            marketplace: String(s.marketplace),
            dateFrom: new Date(`${DATE_FROM}T00:00:00.000Z`),
            dateTo: new Date(`${DATE_TO}T00:00:00.000Z`),
            formulaVersion: String(s.formulaVersion),
            productKey: String(s.productKey),
            payload: (s.payload ?? {}) as object,
            generatedAt: s.generatedAt
              ? new Date(String(s.generatedAt))
              : new Date(),
          } as never,
        });
      }
    }
  });

  const out = {
    procedure: "restore_scoped_profit_readmodels_R17",
    backupDir,
    rowsRestored: restored.length,
    restored,
    deletedAbsentAtBackup: deleted,
    skuRows: sku.length,
    cogsFinanceUntouched: true,
    staleAfterMsExact: true,
    scopeFormulaValidated: true,
    metaChecksumValidated: true,
    v6DashboardNote:
      "V6/Dashboard are rebuilt by weekly stages after profit; not mutated by this PPM rollback",
  };
  console.log(JSON.stringify(out, null, 2));
  console.log("DATA_ROLLBACK_LIVE_R17_OK");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
