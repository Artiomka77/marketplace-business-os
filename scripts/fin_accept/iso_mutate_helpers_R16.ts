/**
 * Isolation-only mutators. Usage:
 *   node --import tsx scripts/fin_accept/iso_mutate_helpers_R16.ts <op>
 * ops: bad_checksum | restore_checksum | prelim | restore_final | mutate_after_backup
 */
import { prisma } from "@/lib/prisma";
import {
  FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
  FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
} from "@/lib/profitReadModel/contract";

const op = process.argv[2] || "";

async function main() {
  if (op === "bad_checksum") {
    const row = await prisma.profitPeriodMetric.findFirst({
      where: {
        companyScope: "ALL",
        marketplace: "OZON",
        formulaVersion: FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
      },
    });
    if (!row) throw new Error("missing ALL OZON");
    await prisma.profitPeriodMetric.update({
      where: { id: row.id },
      data: {
        meta: { ...(row.meta as object), payloadChecksum: "WRONG" } as never,
      },
    });
    console.log("MUTATED_BAD_CHECKSUM");
    return;
  }
  if (op === "restore_checksum") {
    const row = await prisma.profitPeriodMetric.findFirst({
      where: {
        companyScope: "ALL",
        marketplace: "OZON",
        formulaVersion: FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
      },
    });
    await prisma.profitPeriodMetric.update({
      where: { id: row!.id },
      data: {
        meta: {
          ...(row!.meta as object),
          payloadChecksum: row!.payloadChecksum,
        } as never,
      },
    });
    console.log("RESTORED_CHECKSUM");
    return;
  }
  if (op === "prelim") {
    const row = await prisma.profitPeriodMetric.findFirst({
      where: {
        companyScope: "ALL",
        marketplace: "WB",
        formulaVersion: FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
      },
    });
    await prisma.profitPeriodMetric.update({
      where: { id: row!.id },
      data: {
        dataMode: "PRELIMINARY",
        coverageStatus: "PARTIAL",
        generatedAt: new Date("2020-01-01T00:00:00.000Z"),
      },
    });
    console.log("MUTATED_PRELIMINARY");
    return;
  }
  if (op === "restore_final") {
    const row = await prisma.profitPeriodMetric.findFirst({
      where: {
        companyScope: "ALL",
        marketplace: "WB",
        formulaVersion: FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
      },
    });
    await prisma.profitPeriodMetric.update({
      where: { id: row!.id },
      data: {
        dataMode: "FINAL",
        coverageStatus: "COMPLETE",
        generatedAt: new Date("2026-10-26T12:00:00.000Z"),
      },
    });
    console.log("RESTORED_FINAL");
    return;
  }
  if (op === "stale_fingerprint") {
    const row = await prisma.profitPeriodMetric.findFirst({
      where: {
        companyScope: "ALL",
        marketplace: "OZON",
        formulaVersion: FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
      },
    });
    if (!row) throw new Error("missing ALL OZON");
    await prisma.profitPeriodMetric.update({
      where: { id: row.id },
      data: {
        sourceFingerprint: "OLD_STALE",
        meta: {
          ...(row.meta as object),
          sourceFingerprint: "OLD_STALE",
          payloadChecksum: row.payloadChecksum,
          companyScope: "ALL",
          marketplace: "OZON",
        } as never,
      },
    });
    console.log("MUTATED_STALE_FINGERPRINT");
    return;
  }
  if (op === "mutate_after_backup") {
    const row = await prisma.profitPeriodMetric.findFirst({
      where: {
        companyScope: "ALL",
        marketplace: "OZON",
        formulaVersion: FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
      },
    });
    const totals = {
      ...(row!.totals as object),
      netProfitAfterTax: 1,
      netOzonExpenses: 1,
    };
    await prisma.profitPeriodMetric.update({
      where: { id: row!.id },
      data: {
        totals: totals as never,
        analyticsPayload: { totals } as never,
        payloadChecksum: "mutated",
        meta: {
          ...(row!.meta as object),
          payloadChecksum: "mutated",
        } as never,
        staleAfterMs: 999,
      },
    });
    console.log("MUTATED_AFTER_BACKUP");
    return;
  }
  throw new Error(`unknown op ${op}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
