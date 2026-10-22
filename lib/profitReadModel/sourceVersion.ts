/**
 * Cheap canonical source-version tokens for Wave B Profit read-model.
 * Must change when Profit-relevant inputs change; no heavy Financial Core.
 * Sequential DB acquisition only — safe under pool max=1.
 */
import type { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { sequentialAll } from "@/lib/db/sequentialAll";
import type { ProfitMarketplace } from "./contract";
import { isoDateOnly } from "./fingerprint";

function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function dateOnly(iso: string): Date {
  return new Date(`${isoDateOnly(iso)}T00:00:00.000Z`);
}

/** Documented contract: never Promise.all DB fanout on HTTP. */
export const SOURCE_VERSION_DB_PARALLELISM = 0 as const;

export async function computeCheapProfitSourceVersion(params: {
  prisma: PrismaClient;
  marketplace: ProfitMarketplace;
  companyScope: string;
  dateFrom: string;
  dateTo: string;
}): Promise<string> {
  const dateFrom = dateOnly(params.dateFrom);
  const dateTo = dateOnly(params.dateTo);
  const company =
    params.companyScope === "ALL" ? null : params.companyScope;
  const dateFromIso = isoDateOnly(params.dateFrom);
  const dateToIso = isoDateOnly(params.dateTo);

  if (params.marketplace === "WB") {
    const [finance, sales, ads, adMaps, costs, companyTax] = await sequentialAll([
      () =>
        params.prisma.wbFinance.aggregate({
          where: {
            dateFrom: { lte: dateTo },
            dateTo: { gte: dateFrom },
            ...(company ? { companyName: company } : {}),
          },
          _count: { _all: true },
          _sum: {
            totalToPay: true,
            salesAmount: true,
            logisticsCost: true,
            storageCost: true,
            penaltiesAmount: true,
            payoutAmount: true,
          },
          _max: { createdAt: true },
        }),
      () =>
        params.prisma.wbSale.aggregate({
          where: {
            saleDate: { gte: dateFrom, lte: dateTo },
            ...(company ? { companyName: company } : {}),
          },
          _count: { _all: true },
          _sum: {
            quantity: true,
            wbRealizedAmount: true,
            sellerPayout: true,
            retailPrice: true,
            logisticsCost: true,
          },
          _max: { createdAt: true },
        }),
      () =>
        params.prisma.wbAds.aggregate({
          where: {
            dateFrom: { lte: dateTo },
            dateTo: { gte: dateFrom },
            ...(company ? { companyName: company } : {}),
          },
          _count: { _all: true },
          _sum: { spend: true },
          _max: { createdAt: true },
        }),
      () =>
        params.prisma.adCampaignMap.aggregate({
          ...(company ? { where: { companyName: company } } : {}),
          _count: { _all: true },
          _max: { updatedAt: true, createdAt: true },
        }),
      () =>
        params.prisma.productCost.aggregate({
          _count: { _all: true },
          _sum: { costPrice: true },
          _max: { createdAt: true, costDate: true },
        }),
      () =>
        company
          ? params.prisma.company.findFirst({
              where: { name: company },
              select: { usnRate: true, vatRate: true, updatedAt: true },
            })
          : params.prisma.company.findMany({
              select: {
                name: true,
                usnRate: true,
                vatRate: true,
                updatedAt: true,
              },
              orderBy: { name: "asc" },
            }),
    ]);

    return sha({
      marketplace: "WB",
      companyScope: params.companyScope,
      dateFrom: dateFromIso,
      dateTo: dateToIso,
      finance,
      sales,
      ads,
      adMaps,
      costs,
      companyTax,
    });
  }

  const [
    ozonFin,
    ozonAds,
    days,
    products,
    stocks,
    realization,
    costs,
    companyTax,
  ] = await sequentialAll([
    () =>
      params.prisma.ozonFinance.aggregate({
        where: {
          accrualDate: { gte: dateFrom, lte: dateTo },
          ...(company ? { companyName: company } : {}),
        },
        _count: { _all: true },
        _sum: { totalAmount: true, salesAmount: true },
        _max: { createdAt: true },
      }),
    () =>
      params.prisma.ozonAds.aggregate({
        where: {
          reportDate: { gte: dateFrom, lte: dateTo },
          ...(company ? { companyName: company } : {}),
        },
        _count: { _all: true },
        _sum: { spend: true },
        _max: { createdAt: true },
      }),
    () =>
      params.prisma.ozonAccrualDayStatus.findMany({
        where: {
          date: { gte: dateFromIso, lte: dateToIso },
          ...(company ? { companyName: company } : {}),
        },
        select: {
          companyName: true,
          date: true,
          dataMode: true,
          coverageComplete: true,
          quarantineCount: true,
          payloadSha256: true,
          updatedAt: true,
        },
        orderBy: [{ companyName: "asc" }, { date: "asc" }],
        take: 400,
      }),
    () =>
      params.prisma.ozonProduct.aggregate({
        where: company ? { companyName: company } : {},
        _count: { _all: true },
        _max: { createdAt: true, imageUpdatedAt: true },
      }),
    () =>
      params.prisma.ozonStock.aggregate({
        where: company ? { companyName: company } : {},
        _count: { _all: true },
        _sum: {
          availableQty: true,
          preparingQty: true,
          supplyQty: true,
          inTransitQty: true,
        },
        _max: { createdAt: true },
      }),
    () =>
      params.prisma.ozonRealizationSummary.aggregate({
        where: {
          dateFrom: { lte: dateTo },
          dateTo: { gte: dateFrom },
          ...(company ? { companyName: company } : {}),
        },
        _count: { _all: true },
        _sum: {
          realizedAmount: true,
          returnedAmount: true,
          taxableRevenue: true,
        },
        _max: { createdAt: true },
      }),
    () =>
      params.prisma.productCost.aggregate({
        _count: { _all: true },
        _sum: { costPrice: true },
        _max: { createdAt: true, costDate: true },
      }),
    () =>
      company
        ? params.prisma.company.findFirst({
            where: { name: company },
            select: { usnRate: true, vatRate: true, updatedAt: true },
          })
        : params.prisma.company.findMany({
            select: {
              name: true,
              usnRate: true,
              vatRate: true,
              updatedAt: true,
            },
            orderBy: { name: "asc" },
          }),
  ]);

  return sha({
    marketplace: "OZON",
    companyScope: params.companyScope,
    dateFrom: dateFromIso,
    dateTo: dateToIso,
    ozonFin,
    ozonAds,
    days,
    products,
    stocks,
    realization,
    costs,
    companyTax,
  });
}
