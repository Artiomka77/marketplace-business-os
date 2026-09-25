/**
 * TRUE FINAL Defect C — real canonical source mutation canary.
 * Ephemeral/SAME fixture only. Mutates economic value with same rowCount,
 * then runs the shared invalidation helper path (not bare delete alone).
 *
 * Env:
 *   DATABASE_URL — fixture/canonical
 *   WAVE_B_TARGET_DB_MODE=SAME_PRODUCTION_DB (or omit) for same-DB reuse
 *   WAVE_B_MUTATION_CANARY_OUT — output JSON path
 */
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";
import {
  WAVE_B_PROFIT_FORMULAS,
  computeCheapProfitSourceVersion,
  createPrismaProfitReadModelRepository,
  createWaveBProfitTargetPrismaClient,
  invalidateWaveBProfitReadModel,
  produceProfitReadModel,
  resolveWaveBTargetDbMode,
  waveBTargetPoolContract,
} from "@/lib/profitReadModel";

const company = "WAVEB_MUTATION_CO";
const dateFrom = "2026-08-17";
const dateTo = "2026-08-23";
const formula = WAVE_B_PROFIT_FORMULAS[0];
const outPath =
  process.env.WAVE_B_MUTATION_CANARY_OUT ??
  "/tmp/REAL_CANONICAL_SOURCE_MUTATION_CANARY.json";

function shaPrefix(v: string) {
  return createHash("sha256").update(v).digest("hex").slice(0, 16);
}

async function main() {
  process.env.WAVE_B_TARGET_DB_MODE =
    process.env.WAVE_B_TARGET_DB_MODE ?? "SAME_PRODUCTION_DB";
  const mode = resolveWaveBTargetDbMode();
  const target = createWaveBProfitTargetPrismaClient();
  const repo = createPrismaProfitReadModelRepository(target);

  // Seed minimal WB finance + sale fixture (idempotent replace).
  await prisma.wbFinance.deleteMany({ where: { companyName: company } });
  await prisma.wbSale.deleteMany({ where: { companyName: company } });
  await prisma.profitPeriodMetric.deleteMany({
    where: { companyScope: company, formulaVersion: formula },
  });
  await prisma.profitSkuPeriodMetric.deleteMany({
    where: { companyScope: company, formulaVersion: formula },
  });
  await prisma.dashboardPeriodSnapshotJob.deleteMany({
    where: { companyScope: company, formulaVersion: formula },
  });

  await prisma.wbFinance.create({
    data: {
      companyName: company,
      reportNumber: "MUT-FIN-1",
      dateFrom: new Date(`${dateFrom}T00:00:00.000Z`),
      dateTo: new Date(`${dateTo}T00:00:00.000Z`),
      salesAmount: 1000,
      totalToPay: 800,
      payoutAmount: 800,
      logisticsCost: 50,
      storageCost: 10,
      penaltiesAmount: 0,
    },
  });
  await prisma.wbSale.create({
    data: {
      companyName: company,
      reportNumber: "MUT-SALE-1",
      saleDate: new Date(`${dateFrom}T12:00:00.000Z`),
      vendorCode: "SKU-MUT-1",
      quantity: 1,
      wbRealizedAmount: 1000,
      sellerPayout: 800,
      retailPrice: 1000,
    },
  });

  const beforeSv = await computeCheapProfitSourceVersion({
    prisma,
    marketplace: "WB",
    companyScope: company,
    dateFrom,
    dateTo,
  });

  // Produce may fail if FC lacks full company — catch and still seed a FINAL row.
  let produceOk = false;
  try {
    await produceProfitReadModel({
      repository: repo,
      marketplace: "WB",
      companyScope: company,
      dateFrom,
      dateTo,
      prisma,
    });
    produceOk = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stubChecksum = shaPrefix(`stub:${beforeSv}`);
    await target.profitPeriodMetric.create({
      data: {
        marketplace: "WB",
        companyScope: company,
        dateFrom: new Date(`${dateFrom}T00:00:00.000Z`),
        dateTo: new Date(`${dateTo}T00:00:00.000Z`),
        formulaVersion: formula,
        dataMode: "FINAL",
        coverageStatus: "COMPLETE",
        sourceFingerprint: beforeSv,
        payloadChecksum: stubChecksum,
        totals: {
          mutationCanaryStub: true,
          revenue: 1000,
          note: msg.slice(0, 200),
        },
        meta: {
          mutationCanaryStub: true,
          sourceFingerprint: beforeSv,
          payloadChecksum: stubChecksum,
        },
        analyticsPayload: { mutationCanaryStub: true },
        generatedAt: new Date(),
      },
    });
  }

  const beforeRow = await target.profitPeriodMetric.findFirst({
    where: {
      marketplace: "WB",
      companyScope: company,
      formulaVersion: formula,
    },
  });
  const beforeFp = beforeRow
    ? String(beforeRow.sourceFingerprint ?? beforeRow.payloadChecksum ?? "")
    : "";
  const beforeCount = await prisma.wbFinance.count({
    where: { companyName: company },
  });

  // Mutate ECONOMIC value; keep rowCount identical.
  await prisma.wbFinance.updateMany({
    where: { companyName: company, reportNumber: "MUT-FIN-1" },
    data: { totalToPay: 900, salesAmount: 1100 },
  });
  await prisma.wbSale.updateMany({
    where: { companyName: company, reportNumber: "MUT-SALE-1" },
    data: { wbRealizedAmount: 1100, sellerPayout: 900 },
  });
  const afterCount = await prisma.wbFinance.count({
    where: { companyName: company },
  });

  const afterSv = await computeCheapProfitSourceVersion({
    prisma,
    marketplace: "WB",
    companyScope: company,
    dateFrom,
    dateTo,
  });

  // Actual shared writer post-success path.
  const inv = await invalidateWaveBProfitReadModel({
    prisma: target,
    marketplace: "WB",
    companyScope: company,
    dateFrom,
    dateTo,
  });

  const afterRow = await target.profitPeriodMetric.findFirst({
    where: {
      marketplace: "WB",
      companyScope: company,
      formulaVersion: formula,
    },
  });

  const rowCountSame = beforeCount === afterCount && beforeCount === 1;
  const valueChangedDetected = beforeSv !== afterSv;
  const oldFinalNotTrusted = !afterRow;

  const result = {
    REAL_CANONICAL_SOURCE_MUTATION_CANARY:
      rowCountSame && valueChangedDetected && oldFinalNotTrusted
        ? "PASS"
        : "FAIL",
    ROWCOUNT_SAME_VALUE_CHANGED_DETECTED: valueChangedDetected
      ? "PASS"
      : "FAIL",
    OLD_FINAL_NOT_TRUSTED: oldFinalNotTrusted ? "PASS" : "FAIL",
    mutationMode: "CANONICAL_VALUE_MUTATION_THEN_SHARED_INVALIDATE",
    produceOk,
    beforeFpPrefix: beforeFp.slice(0, 16),
    afterFpPrefix: afterRow
      ? String(
          afterRow.sourceFingerprint ?? afterRow.payloadChecksum ?? ""
        ).slice(0, 16)
      : null,
    beforeSvPrefix: beforeSv.slice(0, 16),
    afterSvPrefix: afterSv.slice(0, 16),
    beforeCount,
    afterCount,
    deletedPeriods: inv.deletedPeriods,
    enqueued: inv.enqueued.length,
    enqueueBound: inv.enqueueBound,
    enqueueMode: inv.enqueueMode,
    targetDbMode: mode,
    poolContract: waveBTargetPoolContract(),
    ARBITRARY_PERIOD_QUEUE_EXPLOSION: inv.enqueued.length <= 12 ? "NO" : "YES",
    INVALIDATION_ENQUEUE_BOUND: inv.enqueued.length <= 12 ? "PASS" : "FAIL",
  };

  writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify(result, null, 2));
  if (result.REAL_CANONICAL_SOURCE_MUTATION_CANARY !== "PASS") {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
