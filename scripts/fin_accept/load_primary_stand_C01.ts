/**
 * Load CONTINUE_C01 primary_sources into a disposable Postgres for real workers.
 * Maps normalized_weekly (+ productCost + finance) → current Prisma schema.
 * Does NOT invent financial rows or source finality.
 *
 *   PRIMARY_C01_ROOT=... DATABASE_URL=... node --import tsx \
 *     scripts/fin_accept/load_primary_stand_C01.ts
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";

const root =
  process.env.PRIMARY_C01_ROOT ||
  path.join(process.cwd(), "scripts/fin_accept/fixtures/primary_c01");

function refuseProdUrl(url: string) {
  const u = url.toLowerCase();
  if (
    /72\.56\.4\.62/.test(u) ||
    /ardelo\.su/.test(u) ||
    /@[^/]*prod/.test(u) ||
    process.env.AVOROFIN_ALLOW_PRIMARY_LOAD_ON_NON_DISPOSABLE === "1"
  ) {
    if (process.env.AVOROFIN_ALLOW_PRIMARY_LOAD_ON_NON_DISPOSABLE === "1") return;
    console.error("REFUSE production-looking DATABASE_URL");
    process.exit(3);
  }
}

function requireDisposable(url: string) {
  refuseProdUrl(url);
  // Positive identity: ephemeral stand names used by R18 isolation / local fixtures.
  const ok =
    /finaccept/i.test(url) ||
    /127\.0\.0\.1|localhost|postgres:/.test(url) ||
    process.env.PRIMARY_STAND_DISPOSABLE_OK === "1";
  if (!ok) {
    console.error(
      "REFUSE: DATABASE_URL is not a recognized disposable stand (finaccept/localhost). Set PRIMARY_STAND_DISPOSABLE_OK=1 only for a verified ephemeral target.",
    );
    process.exit(3);
  }
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(2);
}
requireDisposable(process.env.DATABASE_URL);

function loadJson<T>(rel: string): T {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) throw new Error(`missing ${p}`);
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

function d(v: unknown): Date | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  const raw = String(v).trim();
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const x = new Date(raw);
    return Number.isNaN(x.getTime()) ? null : x;
  }
  const m = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?)?$/,
  );
  if (m) {
    const ms = m[7] ? Number(String(m[7]).padEnd(3, "0").slice(0, 3)) : 0;
    return new Date(
      Date.UTC(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4] ?? 0),
        Number(m[5] ?? 0),
        Number(m[6] ?? 0),
        ms,
      ),
    );
  }
  const x = new Date(raw);
  return Number.isNaN(x.getTime()) ? null : x;
}

function n(v: unknown): number | null {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function stripService(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith("_")) continue;
    out[k] = v;
  }
  return out;
}

async function createBatches(
  label: string,
  rows: Record<string, unknown>[],
  write: (batch: Record<string, unknown>[]) => Promise<unknown>,
  batchSize = 400,
) {
  let ok = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize).map((r) => stripService(r));
    await write(batch);
    ok += batch.length;
  }
  console.log(`LOADED ${label}=${ok}`);
  return ok;
}

async function main() {
  if (!fs.existsSync(root)) throw new Error(`PRIMARY_C01_ROOT missing: ${root}`);
  const counts: Record<string, number> = {};
  const nw = "normalized_weekly";

  // Order: clear derived consumers first, then marketplace inputs we own for the stand.
  await prisma.dashboardPeriodSnapshotJob.deleteMany({});
  await prisma.dashboardPeriodSnapshot.deleteMany({});
  await prisma.profitSkuPeriodMetric.deleteMany({});
  await prisma.profitPeriodMetric.deleteMany({});

  const companies = loadJson<Record<string, unknown>[]>(`${nw}/companies.json`);
  await prisma.company.deleteMany({});
  for (const c of companies) {
    await prisma.company.create({
      data: {
        id: String(c.id),
        name: String(c.name),
        taxSystem: (c.taxSystem as string | null) ?? null,
        usnRate: n(c.usnRate ?? c.incomeTaxRate),
        vatRate: n(c.vatRate),
        isActive: c.isActive !== false,
        createdAt: d(c.createdAt) ?? new Date(),
        updatedAt: d(c.updatedAt) ?? new Date(),
      } as never,
    });
  }
  counts.companies = companies.length;

  await prisma.importSession.deleteMany({});
  const sessions = loadJson<Record<string, unknown>[]>(
    `${nw}/import_sessions_wb_by_sale.json`,
  );
  for (const s of sessions) {
    await prisma.importSession.create({
      data: {
        id: String(s.id),
        fileName: String(s.fileName ?? s.id),
        reportType: String(s.reportType ?? "WB_SALES"),
        marketplace: String(s.marketplace ?? "WILDBERRIES"),
        companyName: (s.companyName as string | null) ?? null,
        rowsCount: Number(s.rowsCount ?? 0),
        previewJson: (s.previewJson as object | null) ?? null,
        status: String(s.status ?? "SUCCESS"),
        createdAt: d(s.createdAt) ?? new Date(),
      } as never,
    });
  }
  counts.importSessions = sessions.length;

  // Official WbFinance ImportSession metadata (provenance)
  const officialPath = path.join(root, "OFFICIAL_WB_FINANCE_PRIMARY.json");
  if (fs.existsSync(officialPath)) {
    const official = JSON.parse(fs.readFileSync(officialPath, "utf8")) as {
      sessions?: Record<string, unknown>[];
    };
    for (const s of official.sessions || []) {
      const id = String(s.id);
      const exists = await prisma.importSession.findUnique({ where: { id } });
      if (exists) continue;
      await prisma.importSession.create({
        data: {
          id,
          fileName: String(s.fileName ?? id),
          reportType: String(s.reportType ?? "WB_FINANCE"),
          marketplace: "WILDBERRIES",
          companyName: (s.companyName as string | null) ?? null,
          rowsCount: Number(s.rowsCount ?? 0),
          previewJson: null,
          status: String(s.status ?? "SUCCESS"),
          createdAt: d(s.createdAt) ?? new Date(),
        } as never,
      });
      counts.importSessions += 1;
    }
  }

  await prisma.wbSale.deleteMany({});
  const wbSales = loadJson<Record<string, unknown>[]>(`${nw}/wb_sale_week.json`);
  counts.wbSale = await createBatches("wbSale", wbSales, async (batch) => {
    await prisma.wbSale.createMany({
      data: batch.map((r) => ({
        id: String(r.id),
        importSessionId: (r.importSessionId as string | null) ?? null,
        companyName: (r.companyName as string | null) ?? null,
        reportNumber: (r.reportNumber as string | null) ?? null,
        supplyNumber: (r.supplyNumber as string | null) ?? null,
        brand: (r.brand as string | null) ?? null,
        subject: (r.subject as string | null) ?? null,
        productName: (r.productName as string | null) ?? null,
        size: (r.size as string | null) ?? null,
        nmId: r.nmId != null ? String(r.nmId) : null,
        vendorCode: (r.vendorCode as string | null) ?? null,
        barcode: (r.barcode as string | null) ?? null,
        paymentReason: (r.paymentReason as string | null) ?? null,
        documentType: (r.documentType as string | null) ?? null,
        saleDate: d(r.saleDate),
        quantity: n(r.quantity) != null ? Math.trunc(Number(r.quantity)) : null,
        retailPrice: n(r.retailPrice),
        retailPriceWithDiscount: n(r.retailPriceWithDiscount),
        wbRealizedAmount: n(r.wbRealizedAmount),
        sellerPayout: n(r.sellerPayout),
        sppDiscountAmount: n(r.sppDiscountAmount),
        platformDiscountPercent: n(r.platformDiscountPercent),
        commissionPercentBase: n(r.commissionPercentBase),
        commissionPercentFinal: n(r.commissionPercentFinal),
        wbReward: n(r.wbReward),
        wbRewardVat: n(r.wbRewardVat),
        wbRewardTotal: n(r.wbRewardTotal),
        deliveriesCount:
          n(r.deliveriesCount) != null ? Math.trunc(Number(r.deliveriesCount)) : null,
        returnsCount:
          n(r.returnsCount) != null ? Math.trunc(Number(r.returnsCount)) : null,
        logisticsCost: n(r.logisticsCost),
        storageCost: n(r.storageCost),
        acceptanceCost: n(r.acceptanceCost),
        deductions: n(r.deductions),
        deductionReason: (r.deductionReason as string | null) ?? null,
        penaltiesAmount: n(r.penaltiesAmount),
        paymentServiceCost: n(r.paymentServiceCost),
        pvzCompensation: n(r.pvzCompensation),
        transportCompensation: n(r.transportCompensation),
        wbRewardCorrection: n(r.wbRewardCorrection),
        loyaltyDiscountCompensation: n(r.loyaltyDiscountCompensation),
        loyaltyParticipationCost: n(r.loyaltyParticipationCost),
        loyaltyPointsAmount: n(r.loyaltyPointsAmount),
        createdAt: d(r.createdAt) ?? new Date(),
      })) as never,
      skipDuplicates: true,
    });
  });

  await prisma.wbFinance.deleteMany({});
  const wbFin = loadJson<Record<string, unknown>[]>(`${nw}/wb_finance_week.json`);
  counts.wbFinance = await createBatches("wbFinance", wbFin, async (batch) => {
    await prisma.wbFinance.createMany({
      data: batch.map((r) => ({
        id: String(r.id),
        importSessionId: (r.importSessionId as string | null) ?? null,
        companyName: (r.companyName as string | null) ?? null,
        reportNumber: (r.reportNumber as string | null) ?? null,
        legalEntity: (r.legalEntity as string | null) ?? null,
        dateFrom: d(r.dateFrom),
        dateTo: d(r.dateTo),
        reportTypeName: (r.reportTypeName as string | null) ?? null,
        salesAmount: n(r.salesAmount),
        payoutAmount: n(r.payoutAmount),
        logisticsCost: n(r.logisticsCost),
        storageCost: n(r.storageCost),
        acceptanceCost: n(r.acceptanceCost),
        otherDeductions: n(r.otherDeductions),
        penaltiesAmount: n(r.penaltiesAmount),
        totalToPay: n(r.totalToPay),
        createdAt: d(r.createdAt) ?? new Date(),
      })) as never,
      skipDuplicates: true,
    });
  });

  await prisma.wbAds.deleteMany({});
  const ads = loadJson<Record<string, unknown>[]>(`${nw}/wb_ads_week.json`);
  counts.wbAds = await createBatches("wbAds", ads, async (batch) => {
    await prisma.wbAds.createMany({
      data: batch.map((r) => ({
        id: String(r.id),
        importSessionId: (r.importSessionId as string | null) ?? null,
        companyName: (r.companyName as string | null) ?? null,
        campaignId: (r.campaignId as string | null) ?? null,
        campaignName: (r.campaignName as string | null) ?? null,
        dateFrom: d(r.dateFrom),
        dateTo: d(r.dateTo),
        impressions: n(r.impressions) != null ? Math.trunc(Number(r.impressions)) : null,
        clicks: n(r.clicks) != null ? Math.trunc(Number(r.clicks)) : null,
        ctr: n(r.ctr),
        cpc: n(r.cpc),
        spend: n(r.spend),
        createdAt: d(r.createdAt) ?? new Date(),
      })) as never,
      skipDuplicates: true,
    });
  });

  await prisma.adCampaignMap.deleteMany({});
  const maps = loadJson<Record<string, unknown>[]>(`${nw}/ad_campaign_map_wb.json`);
  counts.adCampaignMap = await createBatches("adCampaignMap", maps, async (batch) => {
    await prisma.adCampaignMap.createMany({
      data: batch.map((r) => ({
        id: String(r.id),
        marketplace: String(r.marketplace ?? "WILDBERRIES"),
        companyName: (r.companyName as string | null) ?? null,
        campaignName: String(r.campaignName ?? ""),
        vendorCode: String(r.vendorCode ?? ""),
        createdAt: d(r.createdAt) ?? new Date(),
        updatedAt: d(r.updatedAt) ?? new Date(),
      })) as never,
      skipDuplicates: true,
    });
  });

  await prisma.ozonFinancialCategoryFact.deleteMany({});
  const facts = loadJson<Record<string, unknown>[]>(
    `${nw}/ozon_financial_category_fact_week.json`,
  );
  counts.ozonFinancialCategoryFact = await createBatches(
    "ozonFinancialCategoryFact",
    facts,
    async (batch) => {
      await prisma.ozonFinancialCategoryFact.createMany({
        data: batch.map((r) => ({
          id: String(r.id),
          importSessionId: (r.importSessionId as string | null) ?? null,
          companyName: (r.companyName as string | null) ?? null,
          operationDate: d(r.operationDate),
          dateFrom: d(r.dateFrom),
          dateTo: d(r.dateTo),
          source: String(r.source ?? "ACCRUAL"),
          sourceOperationType: (r.sourceOperationType as string | null) ?? null,
          sourceOperationCode: (r.sourceOperationCode as string | null) ?? null,
          sourceServiceName: (r.sourceServiceName as string | null) ?? null,
          category: String(r.category),
          amount: n(r.amount) ?? 0,
          includeInProfit: Boolean(r.includeInProfit),
          isCashFlowOnly: Boolean(r.isCashFlowOnly),
          isCompensation: Boolean(r.isCompensation),
          createdAt: d(r.createdAt) ?? new Date(),
        })) as never,
        skipDuplicates: true,
      });
    },
  );

  await prisma.ozonRealizationSummary.deleteMany({});
  const reals = loadJson<Record<string, unknown>[]>(
    `${nw}/ozon_realization_summary_week.json`,
  );
  counts.ozonRealizationSummary = await createBatches(
    "ozonRealizationSummary",
    reals,
    async (batch) => {
      await prisma.ozonRealizationSummary.createMany({
        data: batch.map((r) => ({
          id: String(r.id),
          importSessionId: (r.importSessionId as string | null) ?? null,
          companyName: (r.companyName as string | null) ?? null,
          dateFrom: d(r.dateFrom) ?? new Date("2026-10-19T00:00:00.000Z"),
          dateTo: d(r.dateTo) ?? new Date("2026-10-25T00:00:00.000Z"),
          reportNumber: (r.reportNumber as string | null) ?? null,
          contractNumber: (r.contractNumber as string | null) ?? null,
          sourceFileName: (r.sourceFileName as string | null) ?? null,
          realizedAmount: n(r.realizedAmount),
          returnedAmount: n(r.returnedAmount),
          taxableRevenue: n(r.taxableRevenue),
          partnerProgramsAmount: n(r.partnerProgramsAmount),
          rowsCount: Number(r.rowsCount ?? 0),
          createdAt: d(r.createdAt) ?? new Date(),
        })) as never,
        skipDuplicates: true,
      });
    },
  );

  await prisma.ozonDiscountPointsSummary.deleteMany({});
  const disc = loadJson<Record<string, unknown>[]>(
    `${nw}/ozon_discount_points_summary_week.json`,
  );
  counts.ozonDiscountPointsSummary = await createBatches(
    "ozonDiscountPointsSummary",
    disc,
    async (batch) => {
      await prisma.ozonDiscountPointsSummary.createMany({
        data: batch.map((r) => ({
          id: String(r.id),
          importSessionId: (r.importSessionId as string | null) ?? null,
          companyName: (r.companyName as string | null) ?? null,
          dateFrom: d(r.dateFrom) ?? new Date("2026-10-19T00:00:00.000Z"),
          dateTo: d(r.dateTo) ?? new Date("2026-10-25T00:00:00.000Z"),
          sourceFileName: (r.sourceFileName as string | null) ?? null,
          pointsAccrued: n(r.pointsAccrued),
          pointsWrittenOff: n(r.pointsWrittenOff),
          commissionPaidByPoints: n(r.commissionPaidByPoints),
          logisticsPaidByPoints: n(r.logisticsPaidByPoints),
          fboPaidByPoints: n(r.fboPaidByPoints),
          advertisingPaidByPoints: n(r.advertisingPaidByPoints),
          otherPaidByPoints: n(r.otherPaidByPoints),
          totalPaidByPoints: n(r.totalPaidByPoints),
          createdAt: d(r.createdAt) ?? new Date(),
        })) as never,
        skipDuplicates: true,
      });
    },
  );

  await prisma.productCost.deleteMany({});
  const costsPath = path.join(
    root,
    "WEEK_FINAL/raw/extract/RAW_PRODUCT_COST.json",
  );
  if (fs.existsSync(costsPath)) {
    const costs = JSON.parse(fs.readFileSync(costsPath, "utf8")) as Record<
      string,
      unknown
    >[];
    counts.productCost = await createBatches("productCost", costs, async (batch) => {
      await prisma.productCost.createMany({
        data: batch.map((r) => ({
          id: String(r.id),
          vendorCode: String(r.vendorCode ?? ""),
          nmId: r.nmId != null && String(r.nmId) !== "" ? String(r.nmId) : null,
          costPrice: n(r.costPrice ?? r.cost) ?? 0,
          name: (r.name as string | null) ?? null,
          costDate: d(r.costDate),
          createdAt: d(r.createdAt) ?? new Date(),
        })) as never,
        skipDuplicates: true,
      });
    });
  }

  // Ozon SKU alias map from extract when present (exact company+sku)
  const skuPath = path.join(root, "WEEK_FINAL/raw/extract/21_OZON_SKU.json");
  if (fs.existsSync(skuPath)) {
    try {
      const skuRows = JSON.parse(fs.readFileSync(skuPath, "utf8")) as Record<
        string,
        unknown
      >[];
      let alias = 0;
      for (const r of skuRows) {
        const companyName = String(r.company ?? r.companyName ?? "");
        const ozonSku = String(r.sku ?? "");
        const vendorCode = String(r.vendorCode ?? "");
        if (!companyName || !ozonSku || !vendorCode) continue;
        await prisma.ozonSpecialSkuAlias.upsert({
          where: { companyName_ozonSku: { companyName, ozonSku } },
          create: {
            companyName,
            ozonSku,
            canonicalVendorCode: vendorCode,
            baseNmId: r.nmId ? String(r.nmId) : null,
            mappingEvidence: "PRIMARY_C01_21_OZON_SKU",
            source: "PRIMARY_STAND_C01",
          },
          update: {
            canonicalVendorCode: vendorCode,
            baseNmId: r.nmId ? String(r.nmId) : null,
            mappingEvidence: "PRIMARY_C01_21_OZON_SKU",
          },
        });
        alias += 1;
      }
      counts.ozonSpecialSkuAlias = alias;
    } catch (e) {
      console.log("SKIP ozonSpecialSkuAlias", e instanceof Error ? e.message : e);
    }
  }

  const finAdapter = path.join(root, "finance/FINANCE_ADAPTER_ROWS.json");
  const finFallback = path.join(
    process.cwd(),
    "scripts/fin_accept/fixtures/FINANCE_ADAPTER_ROWS.json",
  );
  const finPath = fs.existsSync(finAdapter) ? finAdapter : finFallback;
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/fin_accept/load_finance_fixture_R17.ts", finPath],
    { env: process.env, encoding: "utf8" },
  );
  process.stdout.write(r.stdout || "");
  process.stderr.write(r.stderr || "");
  if (r.status !== 0) throw new Error(`finance load failed exit=${r.status}`);
  counts.financeAdapter = 1;

  const dumpCountsPath = path.join(root, `${nw}/DUMP_COUNTS.json`);
  const dumpCounts = fs.existsSync(dumpCountsPath)
    ? JSON.parse(fs.readFileSync(dumpCountsPath, "utf8"))
    : null;

  const out = {
    ok: true,
    root,
    counts,
    dumpCounts,
    disposableOnly: true,
    ozonPrimaryOnDisk: fs.existsSync(
      path.join(root, "WEEK_FINAL/raw/ozon_primary"),
    ),
  };
  console.log(JSON.stringify(out, null, 2));
  console.log("LOAD_PRIMARY_STAND_C01_OK");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
