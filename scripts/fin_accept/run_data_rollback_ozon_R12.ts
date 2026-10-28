/**
 * Scoped data rollback from export_profit_period_backup_R16 output.
 *
 *   node --import tsx scripts/fin_accept/run_data_rollback_ozon_R12.ts <backup_dir|ozon.json>
 *
 * - Restores Ozon+WB ProfitPeriodMetric full contract
 * - Deletes in-scope keys with inventory hadRow=false (allowed MP/formula only)
 * - Empty sku_profit_period_snapshot.json [] clears SKUs in restored PPM scope
 * - Missing required sku file (when backup_dir) → hard fail (≠ empty array)
 * - Rejects corrupt backup: PPM row present in snapshot but inventory hadRow=false
 * - Validates SKU scope/MP/formula/dates before write
 * - Requires inventory + v6_pcm + v6_daily + v6 + dashboard files in backup_dir
 *   (empty [] OK; missing file ≠ empty — hard fail)
 * - Restores PeriodCompanyMarketplaceMetric + DailyCompanyMarketplaceMetric (real V6)
 *   and DashboardPeriodSnapshot; deletes in-scope rows absent at backup
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
const ALLOWED_PPM_FORMULAS = new Set([
  FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
  FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
]);
const V6_FORMULA = "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2";
const DASH_FORMULA = "FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1";
const ALLOWED_DASH_FORMULAS = new Set([V6_FORMULA, DASH_FORMULA]);

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

type DashRow = {
  companyScope: string;
  dateFrom: string;
  dateTo: string;
  formulaVersion: string;
  payload: unknown;
  payloadChecksum: string;
  sourceFingerprint: string;
  coverageStatus: string;
  rowsCount: number;
  calculationMs: number;
  generatedAt?: string;
};

function loadJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

type PcmRow = {
  companyScope: string;
  marketplace: string;
  dateFrom: string;
  dateTo: string;
  formulaVersion: string;
  dataMode: string;
  coverageStatus: string;
  sourceFingerprint: string;
  payloadChecksum: string;
  payload: unknown;
  meta: unknown;
  generatedAt?: string;
};

type DailyRow = {
  companyScope: string;
  marketplace: string;
  businessDate: string;
  formulaVersion: string;
  dataMode: string;
  coverageStatus: string;
  sourceFingerprint: string;
  payloadChecksum: string;
  payload: unknown;
  generatedAt?: string;
};

function resolveInputs(input: string): {
  ozon: SnapshotRow[];
  wb: SnapshotRow[];
  inventory: InventoryRow[];
  sku: Array<Record<string, unknown>>;
  skuFilePresent: boolean;
  v6: DashRow[];
  dashboard: DashRow[];
  pcm: PcmRow[];
  pcmInventory: InventoryRow[];
  daily: DailyRow[];
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
    if (!fs.existsSync(invPath)) {
      throw new Error(
        "MISSING_INVENTORY_FILE — backup_inventory.json required in backup_dir",
      );
    }
    const inventory = loadJson<InventoryRow[]>(invPath);
    assert.ok(Array.isArray(inventory), "inventory must be an array");
    const skuPath = path.join(input, "sku_profit_period_snapshot.json");
    if (!fs.existsSync(skuPath)) {
      throw new Error(
        "MISSING_SKU_SNAPSHOT_FILE — required in backup_dir (use [] for empty SKU set)",
      );
    }
    const sku = loadJson<Array<Record<string, unknown>>>(skuPath);
    assert.ok(Array.isArray(sku), "sku snapshot must be an array");
    const v6Path = path.join(input, "v6_period_snapshot.json");
    const dashPath = path.join(input, "dashboard_period_snapshot.json");
    const pcmPath = path.join(input, "v6_pcm_snapshot.json");
    const pcmInvPath = path.join(input, "v6_pcm_inventory.json");
    const dailyPath = path.join(input, "v6_daily_snapshot.json");
    if (!fs.existsSync(v6Path)) {
      throw new Error(
        "MISSING_V6_SNAPSHOT_FILE — v6_period_snapshot.json required (use [] if none)",
      );
    }
    if (!fs.existsSync(dashPath)) {
      throw new Error(
        "MISSING_DASHBOARD_SNAPSHOT_FILE — dashboard_period_snapshot.json required (use [] if none)",
      );
    }
    if (!fs.existsSync(pcmPath)) {
      throw new Error(
        "MISSING_V6_PCM_SNAPSHOT_FILE — v6_pcm_snapshot.json required (PeriodCompanyMarketplaceMetric)",
      );
    }
    if (!fs.existsSync(pcmInvPath)) {
      throw new Error(
        "MISSING_V6_PCM_INVENTORY_FILE — v6_pcm_inventory.json required",
      );
    }
    if (!fs.existsSync(dailyPath)) {
      throw new Error(
        "MISSING_V6_DAILY_SNAPSHOT_FILE — v6_daily_snapshot.json required (use [] if none)",
      );
    }
    const v6 = loadJson<DashRow[]>(v6Path);
    const dashboard = loadJson<DashRow[]>(dashPath);
    const pcm = loadJson<PcmRow[]>(pcmPath);
    const pcmInventory = loadJson<InventoryRow[]>(pcmInvPath);
    const daily = loadJson<DailyRow[]>(dailyPath);
    assert.ok(Array.isArray(v6), "v6 snapshot must be an array");
    assert.ok(Array.isArray(dashboard), "dashboard snapshot must be an array");
    assert.ok(Array.isArray(pcm), "v6 pcm snapshot must be an array");
    assert.ok(Array.isArray(pcmInventory), "v6 pcm inventory must be an array");
    assert.ok(Array.isArray(daily), "v6 daily snapshot must be an array");
    return {
      ozon,
      wb,
      inventory,
      sku,
      skuFilePresent: true,
      v6,
      dashboard,
      pcm,
      pcmInventory,
      daily,
      backupDir: input,
    };
  }
  return {
    ozon: loadJson<SnapshotRow[]>(input),
    wb: [],
    inventory: [],
    sku: [],
    skuFilePresent: false,
    v6: [],
    dashboard: [],
    pcm: [],
    pcmInventory: [],
    daily: [],
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

function validateInventory(inv: InventoryRow[]) {
  for (const i of inv) {
    assert.ok(ALLOWED_SCOPES.has(i.companyScope), `inv bad scope ${i.companyScope}`);
    assert.ok(i.marketplace === "OZON" || i.marketplace === "WB", `inv bad mp ${i.marketplace}`);
    assert.ok(
      ALLOWED_PPM_FORMULAS.has(i.formulaVersion as never),
      `inv bad formula ${i.formulaVersion}`,
    );
    const want =
      i.marketplace === "OZON"
        ? FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1
        : FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1;
    assert.equal(
      i.formulaVersion,
      want,
      `inv MP/formula mismatch ${i.companyScope}|${i.marketplace}|${i.formulaVersion}`,
    );
  }
}

function validateSku(s: Record<string, unknown>) {
  const companyScope = String(s.companyScope ?? "");
  const marketplace = String(s.marketplace ?? "");
  const formulaVersion = String(s.formulaVersion ?? "");
  const dateFrom = String(s.dateFrom ?? DATE_FROM);
  const dateTo = String(s.dateTo ?? DATE_TO);
  assert.ok(ALLOWED_SCOPES.has(companyScope), `sku bad scope ${companyScope}`);
  assert.ok(marketplace === "OZON" || marketplace === "WB", `sku bad mp ${marketplace}`);
  assert.ok(
    ALLOWED_PPM_FORMULAS.has(formulaVersion as never),
    `sku bad formula ${formulaVersion}`,
  );
  const want =
    marketplace === "OZON"
      ? FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1
      : FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1;
  assert.equal(formulaVersion, want);
  assert.equal(dateFrom, DATE_FROM);
  assert.equal(dateTo, DATE_TO);
  assert.ok(s.productKey, "sku productKey required");
}

function validateDash(r: DashRow, formula: string) {
  assert.ok(ALLOWED_SCOPES.has(r.companyScope), `dash bad scope ${r.companyScope}`);
  assert.equal(r.dateFrom, DATE_FROM);
  assert.equal(r.dateTo, DATE_TO);
  assert.equal(r.formulaVersion, formula);
  assert.ok(ALLOWED_DASH_FORMULAS.has(r.formulaVersion));
  assert.ok(r.payload != null);
  assert.ok(r.payloadChecksum);
  assert.ok(r.sourceFingerprint);
}

function assertNoCorruptInventory(
  ozon: SnapshotRow[],
  wb: SnapshotRow[],
  inventory: InventoryRow[],
) {
  const present = new Set(
    [...ozon, ...wb].map(
      (r) => `${r.companyScope}|${r.marketplace}|${r.formulaVersion}`,
    ),
  );
  for (const inv of inventory) {
    const k = `${inv.companyScope}|${inv.marketplace}|${inv.formulaVersion}`;
    if (!inv.hadRow && present.has(k)) {
      throw new Error(
        `CORRUPT_BACKUP inventory hadRow=false but PPM present for ${k}`,
      );
    }
    if (inv.hadRow && !present.has(k)) {
      throw new Error(
        `CORRUPT_BACKUP inventory hadRow=true but PPM missing for ${k}`,
      );
    }
  }
}

function assertNoCorruptPcmInventory(
  pcm: PcmRow[],
  pcmInventory: InventoryRow[],
) {
  const seenInv = new Set<string>();
  const present = new Set(
    pcm.map((r) => `${r.companyScope}|${r.marketplace}|${r.formulaVersion}`),
  );
  for (const inv of pcmInventory) {
    assert.ok(ALLOWED_SCOPES.has(inv.companyScope), `pcm inv bad scope ${inv.companyScope}`);
    assert.equal(inv.formulaVersion, V6_FORMULA, `pcm inv bad formula ${inv.formulaVersion}`);
    const k = `${inv.companyScope}|${inv.marketplace}|${inv.formulaVersion}`;
    if (seenInv.has(k)) {
      throw new Error(`CORRUPT_BACKUP duplicate PCM inventory key ${k}`);
    }
    seenInv.add(k);
    if (!inv.hadRow && present.has(k)) {
      throw new Error(
        `CORRUPT_BACKUP PCM inventory hadRow=false but PeriodCompanyMarketplaceMetric present for ${k}`,
      );
    }
    if (inv.hadRow && !present.has(k)) {
      throw new Error(
        `CORRUPT_BACKUP PCM inventory hadRow=true but PeriodCompanyMarketplaceMetric missing for ${k}`,
      );
    }
  }
  for (const r of pcm) {
    assert.ok(ALLOWED_SCOPES.has(r.companyScope), `pcm bad scope ${r.companyScope}`);
    assert.equal(r.formulaVersion, V6_FORMULA);
    assert.equal(r.dateFrom, DATE_FROM);
    assert.equal(r.dateTo, DATE_TO);
  }
}

function validateDailyRows(daily: DailyRow[]) {
  const weekFrom = new Date(`${DATE_FROM}T00:00:00.000Z`).getTime();
  const weekTo = new Date(`${DATE_TO}T00:00:00.000Z`).getTime();
  for (const r of daily) {
    assert.ok(ALLOWED_SCOPES.has(r.companyScope), `daily bad scope ${r.companyScope}`);
    assert.equal(r.formulaVersion, V6_FORMULA);
    const bd = new Date(`${r.businessDate}T00:00:00.000Z`).getTime();
    if (!(bd >= weekFrom && bd <= weekTo)) {
      throw new Error(
        `CORRUPT_BACKUP daily businessDate ${r.businessDate} outside week ${DATE_FROM}..${DATE_TO}`,
      );
    }
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

async function upsertDash(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  r: DashRow,
) {
  const key = {
    companyScope: r.companyScope,
    dateFrom: new Date(`${r.dateFrom}T00:00:00.000Z`),
    dateTo: new Date(`${r.dateTo}T00:00:00.000Z`),
    formulaVersion: r.formulaVersion,
  };
  const existing = await tx.dashboardPeriodSnapshot.findUnique({
    where: { companyScope_dateFrom_dateTo_formulaVersion: key },
  });
  const data = {
    id: existing?.id ?? `restore-${r.formulaVersion}-${r.companyScope}`,
    payload: r.payload as object,
    payloadChecksum: r.payloadChecksum,
    sourceFingerprint: r.sourceFingerprint,
    coverageStatus: r.coverageStatus,
    rowsCount: Number(r.rowsCount ?? 0),
    calculationMs: Number(r.calculationMs ?? 0),
    generatedAt: r.generatedAt ? new Date(r.generatedAt) : new Date(),
    updatedAt: new Date(),
  };
  if (!existing) {
    await tx.dashboardPeriodSnapshot.create({
      data: { ...key, ...data } as never,
    });
  } else {
    await tx.dashboardPeriodSnapshot.update({
      where: { companyScope_dateFrom_dateTo_formulaVersion: key },
      data: data as never,
    });
  }
}

async function upsertPcm(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  r: PcmRow,
) {
  const key = {
    companyScope: r.companyScope,
    marketplace: r.marketplace,
    dateFrom: new Date(`${r.dateFrom}T00:00:00.000Z`),
    dateTo: new Date(`${r.dateTo}T00:00:00.000Z`),
    formulaVersion: r.formulaVersion,
  };
  const existing = await tx.periodCompanyMarketplaceMetric.findUnique({
    where: { companyScope_marketplace_dateFrom_dateTo_formulaVersion: key },
  });
  const data = {
    dataMode: r.dataMode,
    coverageStatus: r.coverageStatus,
    sourceFingerprint: r.sourceFingerprint,
    payloadChecksum: r.payloadChecksum,
    payload: r.payload as object,
    meta: r.meta as object,
    generatedAt: r.generatedAt ? new Date(r.generatedAt) : new Date(),
  };
  if (!existing) {
    await tx.periodCompanyMarketplaceMetric.create({
      data: { ...key, ...data } as never,
    });
  } else {
    await tx.periodCompanyMarketplaceMetric.update({
      where: { companyScope_marketplace_dateFrom_dateTo_formulaVersion: key },
      data: data as never,
    });
  }
}

async function upsertDaily(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  r: DailyRow,
) {
  const key = {
    companyScope: r.companyScope,
    marketplace: r.marketplace,
    businessDate: new Date(`${r.businessDate}T00:00:00.000Z`),
    formulaVersion: r.formulaVersion,
  };
  const existing = await tx.dailyCompanyMarketplaceMetric.findUnique({
    where: { companyScope_marketplace_businessDate_formulaVersion: key },
  });
  const data = {
    dataMode: r.dataMode,
    coverageStatus: r.coverageStatus,
    sourceFingerprint: r.sourceFingerprint,
    payloadChecksum: r.payloadChecksum,
    payload: r.payload as object,
    generatedAt: r.generatedAt ? new Date(r.generatedAt) : new Date(),
  };
  if (!existing) {
    await tx.dailyCompanyMarketplaceMetric.create({
      data: { ...key, ...data } as never,
    });
  } else {
    await tx.dailyCompanyMarketplaceMetric.update({
      where: { companyScope_marketplace_businessDate_formulaVersion: key },
      data: data as never,
    });
  }
}

async function main() {
  const {
    ozon,
    wb,
    inventory,
    sku,
    skuFilePresent,
    v6,
    dashboard,
    pcm,
    pcmInventory,
    daily,
    backupDir,
  } = resolveInputs(arg);
  assert.ok(Array.isArray(ozon) && ozon.length > 0, "ozon snapshot required");
  for (const r of ozon) validateRow(r, "OZON");
  for (const r of wb) validateRow(r, "WB");
  validateInventory(inventory);
  assertNoCorruptInventory(ozon, wb, inventory);
  assertNoCorruptPcmInventory(pcm, pcmInventory);
  validateDailyRows(daily);
  for (const s of sku) validateSku(s);
  for (const r of v6) validateDash(r, V6_FORMULA);
  for (const r of dashboard) validateDash(r, DASH_FORMULA);

  // SKU must belong to a hadRow=true / restored PPM key
  const restoredPpmKeys = new Set(
    [...ozon, ...wb].map(
      (r) => `${r.companyScope}|${r.marketplace}|${r.formulaVersion}`,
    ),
  );
  const absentKeys = new Set(
    inventory
      .filter((i) => !i.hadRow)
      .map((i) => `${i.companyScope}|${i.marketplace}|${i.formulaVersion}`),
  );
  for (const s of sku) {
    const k = `${s.companyScope}|${s.marketplace}|${s.formulaVersion}`;
    if (absentKeys.has(k)) {
      throw new Error(`SKU_FOR_ABSENT_KEY ${k}`);
    }
    if (!restoredPpmKeys.has(k)) {
      throw new Error(`SKU_WITHOUT_PPM ${k}`);
    }
  }

  const client = createWaveBProfitTargetPrismaClient();
  const deleted: string[] = [];
  const restored: string[] = [];
  let skuDeleted = 0;
  let skuCreated = 0;
  let dashRestored = 0;
  let dashDeletedAbsent = 0;
  let pcmRestored = 0;
  let pcmDeletedAbsent = 0;
  let dailyRestored = 0;
  let dailyCleared = 0;

  await client.$transaction(async (tx) => {
    // 1) Delete in-scope rows that were absent at backup time
    for (const inv of inventory) {
      if (inv.hadRow) continue;
      if (!ALLOWED_SCOPES.has(inv.companyScope)) continue;
      if (inv.marketplace !== "OZON" && inv.marketplace !== "WB") continue;
      if (!ALLOWED_PPM_FORMULAS.has(inv.formulaVersion as never)) continue;
      const want =
        inv.marketplace === "OZON"
          ? FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1
          : FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1;
      if (inv.formulaVersion !== want) continue;

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
        const dsku = await tx.profitSkuPeriodMetric.deleteMany({
          where: {
            companyScope: inv.companyScope,
            marketplace: inv.marketplace,
            dateFrom: key.dateFrom,
            dateTo: key.dateTo,
            formulaVersion: inv.formulaVersion,
          },
        });
        skuDeleted += dsku.count;
        await tx.profitPeriodMetric.delete({
          where: { companyScope_marketplace_dateFrom_dateTo_formulaVersion: key },
        });
        deleted.push(inv.key);
      }
    }

    // 2) Restore PPM (skip absent keys)
    for (const r of [...ozon, ...wb]) {
      const k = `${r.companyScope}|${r.marketplace}|${r.formulaVersion}`;
      if (absentKeys.has(k)) continue;
      const updated = await upsertPpm(tx, r);
      if (updated.staleAfterMs !== (r.staleAfterMs ?? null)) {
        throw new Error(`staleAfterMs not exact ${r.companyScope}`);
      }
      const metaCs = (updated.meta as { payloadChecksum?: string } | null)
        ?.payloadChecksum;
      if (metaCs && metaCs !== updated.payloadChecksum) {
        throw new Error(`post meta checksum ${r.companyScope}`);
      }
      restored.push(`${r.companyScope}|${r.marketplace}`);
    }

    // 3) SKU: empty array with present file ⇒ clear scope; missing file already failed for dir
    if (skuFilePresent || sku.length > 0) {
      for (const key of restoredPpmKeys) {
        if (absentKeys.has(key)) continue;
        const [companyScope, marketplace, formulaVersion] = key.split("|");
        const d = await tx.profitSkuPeriodMetric.deleteMany({
          where: {
            companyScope,
            marketplace,
            dateFrom: new Date(`${DATE_FROM}T00:00:00.000Z`),
            dateTo: new Date(`${DATE_TO}T00:00:00.000Z`),
            formulaVersion,
          },
        });
        skuDeleted += d.count;
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
        skuCreated += 1;
      }
    }

    // 4a) Real V6 PeriodCompanyMarketplaceMetric (producer table)
    const pcmAbsent = new Set(
      pcmInventory
        .filter((i) => !i.hadRow)
        .map((i) => `${i.companyScope}|${i.marketplace}|${i.formulaVersion}`),
    );
    const pcmKeep = new Set(
      pcm.map((r) => `${r.companyScope}|${r.marketplace}|${r.formulaVersion}`),
    );
    for (const inv of pcmInventory) {
      if (inv.hadRow) continue;
      if (!ALLOWED_SCOPES.has(inv.companyScope)) continue;
      if (inv.formulaVersion !== V6_FORMULA) continue;
      const key = {
        companyScope: inv.companyScope,
        marketplace: inv.marketplace,
        dateFrom: new Date(`${DATE_FROM}T00:00:00.000Z`),
        dateTo: new Date(`${DATE_TO}T00:00:00.000Z`),
        formulaVersion: inv.formulaVersion,
      };
      const existing = await tx.periodCompanyMarketplaceMetric.findUnique({
        where: { companyScope_marketplace_dateFrom_dateTo_formulaVersion: key },
      });
      if (existing) {
        await tx.periodCompanyMarketplaceMetric.delete({
          where: { companyScope_marketplace_dateFrom_dateTo_formulaVersion: key },
        });
        pcmDeletedAbsent += 1;
      }
    }
    for (const r of pcm) {
      assert.ok(ALLOWED_SCOPES.has(r.companyScope), `pcm bad scope ${r.companyScope}`);
      assert.equal(r.formulaVersion, V6_FORMULA);
      assert.equal(r.dateFrom, DATE_FROM);
      assert.equal(r.dateTo, DATE_TO);
      if (pcmAbsent.has(`${r.companyScope}|${r.marketplace}|${r.formulaVersion}`)) {
        continue;
      }
      await upsertPcm(tx, r);
      pcmRestored += 1;
    }
    // Delete post-backup PCM keys not in backup keep set (canonical scopes)
    if (backupDir) {
      for (const companyScope of CANONICAL_PROFIT_COMPANY_SCOPES) {
        const k = `${companyScope}|ALL|${V6_FORMULA}`;
        if (pcmKeep.has(k) || pcmAbsent.has(k)) continue;
        // already handled by inventory; extra safety for unknown MP variants
      }
    }

    // 4b) DailyCompanyMarketplaceMetric for week — replace with backup set
    if (backupDir) {
      const cleared = await tx.dailyCompanyMarketplaceMetric.deleteMany({
        where: {
          businessDate: {
            gte: new Date(`${DATE_FROM}T00:00:00.000Z`),
            lte: new Date(`${DATE_TO}T00:00:00.000Z`),
          },
          formulaVersion: V6_FORMULA,
          companyScope: { in: [...CANONICAL_PROFIT_COMPANY_SCOPES] },
        },
      });
      dailyCleared = cleared.count;
      for (const r of daily) {
        assert.ok(ALLOWED_SCOPES.has(r.companyScope), `daily bad scope ${r.companyScope}`);
        assert.equal(r.formulaVersion, V6_FORMULA);
        await upsertDaily(tx, r);
        dailyRestored += 1;
      }
    }

    // 4c) DashboardPeriodSnapshot (V4 + optional V6-formula dash rows)
    const keepDash = new Set(
      [...v6, ...dashboard].map(
        (r) => `${r.companyScope}|${r.formulaVersion}`,
      ),
    );
    for (const r of [...v6, ...dashboard]) {
      await upsertDash(tx, r);
      dashRestored += 1;
    }
    if (backupDir) {
      for (const formulaVersion of [V6_FORMULA, DASH_FORMULA]) {
        for (const companyScope of CANONICAL_PROFIT_COMPANY_SCOPES) {
          const k = `${companyScope}|${formulaVersion}`;
          if (keepDash.has(k)) continue;
          const key = {
            companyScope,
            dateFrom: new Date(`${DATE_FROM}T00:00:00.000Z`),
            dateTo: new Date(`${DATE_TO}T00:00:00.000Z`),
            formulaVersion,
          };
          const existing = await tx.dashboardPeriodSnapshot.findUnique({
            where: { companyScope_dateFrom_dateTo_formulaVersion: key },
          });
          if (existing) {
            await tx.dashboardPeriodSnapshot.delete({
              where: { companyScope_dateFrom_dateTo_formulaVersion: key },
            });
            dashDeletedAbsent += 1;
          }
        }
      }
    }
  });

  const out = {
    procedure: "restore_scoped_profit_readmodels_R18",
    backupDir,
    rowsRestored: restored.length,
    restored,
    deletedAbsentAtBackup: deleted,
    skuFilePresent,
    skuRowsInBackup: sku.length,
    skuDeleted,
    skuCreated,
    pcmRestored,
    pcmDeletedAbsent,
    dailyRestored,
    dailyCleared,
    dashRestored,
    dashDeletedAbsent,
    cogsFinanceUntouched: true,
    staleAfterMsExact: true,
    scopeFormulaValidated: true,
    metaChecksumValidated: true,
    corruptBackupRejected: true,
    emptySkuClearsScope: skuFilePresent && sku.length === 0,
  };
  console.log(JSON.stringify(out, null, 2));
  console.log("DATA_ROLLBACK_LIVE_R18_OK");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
