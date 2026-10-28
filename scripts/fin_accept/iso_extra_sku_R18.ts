import { prisma } from "@/lib/prisma";
import { FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1 } from "@/lib/profitReadModel/contract";

async function main() {
  await prisma.profitSkuPeriodMetric.create({
    data: {
      companyScope: "ALL",
      marketplace: "OZON",
      dateFrom: new Date("2026-10-19T00:00:00.000Z"),
      dateTo: new Date("2026-10-25T00:00:00.000Z"),
      formulaVersion: FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
      productKey: "post-backup-sku",
      payload: { x: 1 },
      generatedAt: new Date(),
    },
  });
  console.log("EXTRA_SKU_CREATED");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
