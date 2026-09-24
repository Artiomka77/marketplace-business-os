/**
 * TRUE FINAL Defect D — source-version payload coverage canary.
 * Mutates payload-affecting fields with stable rowCounts and asserts token change.
 */
import { writeFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import {
  SOURCE_VERSION_DB_PARALLELISM,
  computeCheapProfitSourceVersion,
} from "@/lib/profitReadModel";

const outPath =
  process.env.WAVE_B_SV_CANARY_OUT ??
  "/tmp/SOURCE_VERSION_PAYLOAD_COVERAGE.json";
const company = "WAVEB_SV_CO";
const dateFrom = "2026-08-17";
const dateTo = "2026-08-23";

async function main() {
  await prisma.wbSale.deleteMany({ where: { companyName: company } });
  await prisma.adCampaignMap.deleteMany({ where: { companyName: company } });
  await prisma.ozonProduct.deleteMany({ where: { companyName: company } });

  await prisma.wbSale.create({
    data: {
      companyName: company,
      saleDate: new Date(`${dateFrom}T12:00:00.000Z`),
      vendorCode: "SV-1",
      quantity: 1,
      wbRealizedAmount: 100,
      sellerPayout: 80,
    },
  });
  await prisma.adCampaignMap.create({
    data: {
      marketplace: "WB",
      companyName: company,
      campaignName: "SV-CAMP",
      vendorCode: "SV-1",
    },
  });
  await prisma.ozonProduct.create({
    data: {
      companyName: company,
      vendorCode: "OZ-SV-1",
      sku: "111",
      productName: "before",
    },
  });

  const wbBefore = await computeCheapProfitSourceVersion({
    prisma,
    marketplace: "WB",
    companyScope: company,
    dateFrom,
    dateTo,
  });
  await prisma.wbSale.updateMany({
    where: { companyName: company },
    data: { wbRealizedAmount: 999 },
  });
  const wbAfterSale = await computeCheapProfitSourceVersion({
    prisma,
    marketplace: "WB",
    companyScope: company,
    dateFrom,
    dateTo,
  });
  await prisma.adCampaignMap.updateMany({
    where: { companyName: company },
    data: { vendorCode: "SV-2" },
  });
  const wbAfterMap = await computeCheapProfitSourceVersion({
    prisma,
    marketplace: "WB",
    companyScope: company,
    dateFrom,
    dateTo,
  });

  const ozBefore = await computeCheapProfitSourceVersion({
    prisma,
    marketplace: "OZON",
    companyScope: company,
    dateFrom,
    dateTo,
  });
  await prisma.ozonProduct.updateMany({
    where: { companyName: company },
    data: { productName: "after-name", imageUpdatedAt: new Date() },
  });
  const ozAfter = await computeCheapProfitSourceVersion({
    prisma,
    marketplace: "OZON",
    companyScope: company,
    dateFrom,
    dateTo,
  });

  const result = {
    SOURCE_VERSION_COVERS_WB_PAYLOAD_INPUTS:
      wbBefore !== wbAfterSale && wbAfterSale !== wbAfterMap ? "PASS" : "FAIL",
    SOURCE_VERSION_COVERS_OZON_PAYLOAD_INPUTS:
      ozBefore !== ozAfter ? "PASS" : "FAIL",
    SOURCE_VERSION_DB_PARALLELISM,
    wbSaleValueChangeDetected: wbBefore !== wbAfterSale,
    adCampaignMapChangeDetected: wbAfterSale !== wbAfterMap,
    ozonProductChangeDetected: ozBefore !== ozAfter,
    notes:
      "Cheap aggregates only; AdCampaignMap uses updatedAt; OzonProduct uses imageUpdatedAt/count",
  };

  writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify(result, null, 2));
  if (
    result.SOURCE_VERSION_COVERS_WB_PAYLOAD_INPUTS !== "PASS" ||
    result.SOURCE_VERSION_COVERS_OZON_PAYLOAD_INPUTS !== "PASS"
  ) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
