import { prisma } from "@/lib/prisma";

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;

  if (typeof value === "object" && "toNumber" in value) {
    return (value as { toNumber: () => number }).toNumber();
  }

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[–—−]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function startOfDay(value: string | Date) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function nextDayStart(value: string | Date) {
  const date = startOfDay(value);
  date.setDate(date.getDate() + 1);
  return date;
}

function getMoscowDateKey(value: unknown) {
  if (!value) return "unknown";

  const date = value instanceof Date ? value : new Date(String(value));

  if (Number.isNaN(date.getTime())) return "unknown";

  return new Date(date.getTime() + 3 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function isSaleOperation(reason: string) {
  const value = normalizeText(reason);
  return value === "продажа" || value === "сторно возвратов";
}

function clampRate(value: unknown, allowedRates: number[], fallback: number) {
  const rate = toNumber(value);
  return allowedRates.includes(rate) ? rate : fallback;
}

function calculateVatTax(revenue: number, vatRate: number) {
  if (vatRate <= 0) return 0;
  return revenue * (vatRate / (100 + vatRate));
}

const WB_COMMISSION_VAT_RATE_FALLBACK = 0.22;

function calculateWbCommissionVatFallback(
  commissionBeforeVat: number,
  savedCommissionVat: unknown
) {
  const savedVat = toNumber(savedCommissionVat);

  if (savedVat !== 0) {
    return savedVat;
  }

  // Старые уже загруженные WB Sales строки были импортированы до появления
  // отдельной колонки «НДС с Вознаграждения WB». Чтобы Dashboard, Telegram
  // и /profit-wb считали одинаково, для таких строк восстанавливаем НДС
  // как 22% от вознаграждения WB без НДС. Новые загрузки берут НДС из отчёта.
  if (commissionBeforeVat !== 0) {
    return commissionBeforeVat * WB_COMMISSION_VAT_RATE_FALLBACK;
  }

  return 0;
}

function calculatePreviousPeriod(dateFrom?: string | null, dateTo?: string | null) {
  if (!dateFrom || !dateTo) return null;

  const from = startOfDay(dateFrom);
  const to = startOfDay(dateTo);
  const diffMs = to.getTime() - from.getTime();
  const days = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)) + 1);

  const previousTo = new Date(from);
  previousTo.setDate(previousTo.getDate() - 1);

  const previousFrom = new Date(previousTo);
  previousFrom.setDate(previousFrom.getDate() - (days - 1));

  return {
    dateFrom: previousFrom,
    dateTo: previousTo,
  };
}

function createDateFilterFromStrings(dateFrom?: string | null, dateTo?: string | null) {
  return dateFrom || dateTo
    ? {
        OR: [
          {
            dateFrom: {
              ...(dateFrom ? { gte: startOfDay(dateFrom) } : {}),
              ...(dateTo ? { lt: nextDayStart(dateTo) } : {}),
            },
          },
          {
            dateTo: {
              ...(dateFrom ? { gte: startOfDay(dateFrom) } : {}),
              ...(dateTo ? { lt: nextDayStart(dateTo) } : {}),
            },
          },
        ],
      }
    : {};
}

function createDateFilterFromDates(dateFrom?: Date | null, dateTo?: Date | null) {
  if (!dateFrom || !dateTo) return {};

  const toExclusive = new Date(dateTo);
  toExclusive.setDate(toExclusive.getDate() + 1);

  return {
    OR: [
      {
        dateFrom: {
          gte: dateFrom,
          lt: toExclusive,
        },
      },
      {
        dateTo: {
          gte: dateFrom,
          lt: toExclusive,
        },
      },
    ],
  };
}

function getInclusiveDateDiff(from: Date, to: Date) {
  const fromStart = startOfDay(from);
  const toStart = startOfDay(to);
  const diff = Math.round((toStart.getTime() - fromStart.getTime()) / 86_400_000) + 1;
  return Math.max(1, diff);
}

function getMaxDate(left: Date, right: Date) {
  return left.getTime() >= right.getTime() ? left : right;
}

function getMinDate(left: Date, right: Date) {
  return left.getTime() <= right.getTime() ? left : right;
}

function prorateSpendByPeriod(
  spend: unknown,
  rowDateFrom: Date | null,
  rowDateTo: Date | null,
  periodFrom: Date,
  periodTo: Date
) {
  const rowFrom = startOfDay(rowDateFrom ?? rowDateTo ?? periodFrom);
  const rowTo = startOfDay(rowDateTo ?? rowDateFrom ?? periodTo);
  const overlapFrom = getMaxDate(rowFrom, periodFrom);
  const overlapTo = getMinDate(rowTo, periodTo);

  if (overlapTo.getTime() < overlapFrom.getTime()) return 0;

  const fullDays = getInclusiveDateDiff(rowFrom, rowTo);
  const overlapDays = getInclusiveDateDiff(overlapFrom, overlapTo);

  return toNumber(spend) * (overlapDays / fullDays);
}

function createComparison(current: number, previous: number) {
  const diff = current - previous;

  return {
    current,
    previous,
    diff,
    diffPercent: previous !== 0 ? (diff / previous) * 100 : 0,
  };
}

function isWbAdsDeductionReason(value: unknown) {
  const text = normalizeText(value);

  return (
    text.includes("wb продвиж") ||
    text.includes("продвиж") ||
    text.includes("реклам") ||
    text.includes("advert") ||
    text.includes("promotion")
  );
}

function isWbCreditDeductionReason(value: unknown) {
  const text = normalizeText(value);

  return (
    text.includes("кредит") ||
    text.includes("заем") ||
    text.includes("заём") ||
    text.includes("заемщик") ||
    text.includes("заёмщик") ||
    text.includes("счет требований") ||
    text.includes("счёт требований")
  );
}

function classifyWbDeductionReason(value: unknown): "ADS" | "CREDIT" | "OPERATING" | "UNKNOWN" {
  const text = normalizeText(value);

  if (!text) return "UNKNOWN";
  if (isWbAdsDeductionReason(text)) return "ADS";
  if (isWbCreditDeductionReason(text)) return "CREDIT";

  return "OPERATING";
}

export type ProfitAnalyticsRow = {
  nmId: string;
  vendorCode: string;
  subject: string;

  salesQty: number;
  returnsQty: number;
  netSalesQty: number;

  revenue: number;
  revenueSharePercent: number;

  sellerRetailAmount: number;
  sppDiscountAmount: number;

  sellerPayout: number;

  wbCommission: number;
  wbCommissionBeforeVat: number;
  wbCommissionVat: number;

  logisticsCost: number;
  storageCost: number;
  acceptanceCost: number;

  penaltiesAmount: number;
  deductions: number;
  wbAdsDeduction: number;
  wbCreditDeduction: number;
  wbUnknownDeduction: number;
  wbRawDeduction: number;

  paymentServiceCost: number;
  pvzCompensation: number;
  transportCompensation: number;
  loyaltyDiscountCompensation: number;
  loyaltyParticipationCost: number;
  loyaltyPointsAmount: number;

  adsCost: number;
  drrPercent: number;

  costPrice: number;
  totalCost: number;

  marginProfit: number;
  marginProfitPercent: number;

  taxesAmount: number;

  netProfitAfterTax: number;
  marginAfterTaxPercent: number;

  abcByProfit: "A" | "B" | "C";
};

export type ProfitTotals = {
  salesQty: number;
  returnsQty: number;
  netSalesQty: number;

  revenue: number;

  sellerRetailAmount: number;
  sppDiscountAmount: number;

  sellerPayout: number;

  wbCommission: number;
  wbCommissionBeforeVat: number;
  wbCommissionVat: number;

  logisticsCost: number;
  storageCost: number;
  acceptanceCost: number;

  penaltiesAmount: number;
  deductions: number;
  wbAdsDeduction: number;
  wbCreditDeduction: number;
  wbUnknownDeduction: number;
  wbRawDeduction: number;

  paymentServiceCost: number;
  pvzCompensation: number;
  transportCompensation: number;
  loyaltyDiscountCompensation: number;
  loyaltyParticipationCost: number;
  loyaltyPointsAmount: number;

  adsCost: number;
  drrPercent: number;
  undistributedAdsCost: number;

  totalCost: number;

  marginProfit: number;
  marginProfitPercent: number;

  taxesAmount: number;

  netProfitAfterTax: number;
  marginAfterTaxPercent: number;

  usnRate: number;
  vatRate: number;
};

type CostRecord = {
  vendorCode: string;
  costPrice: unknown;
};

type AdMapRecord = {
  campaignName: string;
  vendorCode: string;
};

type WbSaleRecord = {
  nmId: string | null;
  vendorCode: string | null;
  subject: string | null;
  paymentReason: string | null;
  quantity: number | null;

  retailPrice: unknown;
  retailPriceWithDiscount: unknown;
  wbRealizedAmount: unknown;
  sellerPayout: unknown;
  sppDiscountAmount: unknown;

  wbReward: unknown;
  wbRewardVat: unknown;
  wbRewardTotal: unknown;

  logisticsCost: unknown;
  storageCost: unknown;
  acceptanceCost: unknown;

  penaltiesAmount: unknown;
  deductions: unknown;
  deductionReason: string | null;

  paymentServiceCost: unknown;
  pvzCompensation: unknown;
  transportCompensation: unknown;
  loyaltyDiscountCompensation: unknown;
  loyaltyParticipationCost: unknown;
  loyaltyPointsAmount: unknown;
};

type WbAdsRecord = {
  campaignName: string | null;
  spend: unknown;
};

type WbFinanceExpenseTotals = {
  hasRows: boolean;
  revenue: number;
  sellerPayout: number;
  storageCost: number;
  acceptanceCost: number;
  penaltiesAmount: number;
  logisticsCost: number;
  deductions: number;
};

function buildCostByVendorCode(costs: CostRecord[]) {
  const costByVendorCode = new Map<string, number>();

  for (const cost of costs) {
    const vendorCode = normalizeText(cost.vendorCode);
    if (!vendorCode) continue;

    if (!costByVendorCode.has(vendorCode)) {
      costByVendorCode.set(vendorCode, toNumber(cost.costPrice));
    }
  }

  return costByVendorCode;
}

function buildVendorCodesByCampaign(adMaps: AdMapRecord[]) {
  const vendorCodesByCampaign = new Map<string, Set<string>>();

  for (const map of adMaps) {
    const campaignName = normalizeText(map.campaignName);
    const vendorCode = normalizeText(map.vendorCode);

    if (!campaignName || !vendorCode) continue;

    const current = vendorCodesByCampaign.get(campaignName) ?? new Set<string>();
    current.add(vendorCode);
    vendorCodesByCampaign.set(campaignName, current);
  }

  return vendorCodesByCampaign;
}

function buildAdsCostByVendorCode(
  adsRows: WbAdsRecord[],
  vendorCodesByCampaign: Map<string, Set<string>>
) {
  const adsCostByVendorCode = new Map<string, number>();
  let undistributedAdsCost = 0;

  for (const ad of adsRows) {
    const campaignName = normalizeText(ad.campaignName);
    const spend = toNumber(ad.spend);

    if (!campaignName || spend === 0) continue;

    const vendorCodes = Array.from(vendorCodesByCampaign.get(campaignName) ?? []);

    if (vendorCodes.length === 0) {
      undistributedAdsCost += spend;
      continue;
    }

    const spendPerVendorCode = spend / vendorCodes.length;

    for (const vendorCode of vendorCodes) {
      adsCostByVendorCode.set(
        vendorCode,
        (adsCostByVendorCode.get(vendorCode) ?? 0) + spendPerVendorCode
      );
    }
  }

  return {
    adsCostByVendorCode,
    undistributedAdsCost,
  };
}

function createEmptyTotals(
  usnRate: number,
  vatRate: number,
  undistributedAdsCost = 0
): ProfitTotals {
  return {
    salesQty: 0,
    returnsQty: 0,
    netSalesQty: 0,

    revenue: 0,
    sellerRetailAmount: 0,
    sppDiscountAmount: 0,
    sellerPayout: 0,
    wbCommission: 0,
    wbCommissionBeforeVat: 0,
    wbCommissionVat: 0,

    logisticsCost: 0,
    storageCost: 0,
    acceptanceCost: 0,

    penaltiesAmount: 0,
    deductions: 0,
    wbAdsDeduction: 0,
    wbCreditDeduction: 0,
    wbUnknownDeduction: 0,
    wbRawDeduction: 0,
    paymentServiceCost: 0,
    pvzCompensation: 0,
    transportCompensation: 0,
    loyaltyDiscountCompensation: 0,
    loyaltyParticipationCost: 0,
    loyaltyPointsAmount: 0,

    adsCost: 0,
    drrPercent: 0,
    undistributedAdsCost,

    totalCost: 0,

    marginProfit: 0,
    marginProfitPercent: 0,

    taxesAmount: 0,

    netProfitAfterTax: 0,
    marginAfterTaxPercent: 0,

    usnRate,
    vatRate,
  };
}

function calculateAbcByProfit(rows: ProfitAnalyticsRow[]) {
  const totalPositiveProfit = rows.reduce(
    (sum, row) => sum + Math.max(0, row.marginProfit),
    0
  );

  if (totalPositiveProfit <= 0) {
    for (const row of rows) {
      row.abcByProfit = "C";
    }
    return;
  }

  let cumulativeProfit = 0;

  for (const row of rows) {
    const positiveProfit = Math.max(0, row.marginProfit);

    if (positiveProfit <= 0) {
      row.abcByProfit = "C";
      continue;
    }

    const shareBefore = cumulativeProfit / totalPositiveProfit;
    cumulativeProfit += positiveProfit;

    if (shareBefore < 0.8) {
      row.abcByProfit = "A";
    } else if (shareBefore < 0.95) {
      row.abcByProfit = "B";
    } else {
      row.abcByProfit = "C";
    }
  }
}

function calculateRowsAndTotals({
  wbRows,
  costs,
  adsRows,
  adMaps,
  usnRate,
  vatRate,
}: {
  wbRows: WbSaleRecord[];
  costs: CostRecord[];
  adsRows: WbAdsRecord[];
  adMaps: AdMapRecord[];
  usnRate: number;
  vatRate: number;
}) {
  const costByVendorCode = buildCostByVendorCode(costs);
  const vendorCodesByCampaign = buildVendorCodesByCampaign(adMaps);

  const { adsCostByVendorCode, undistributedAdsCost } = buildAdsCostByVendorCode(
    adsRows,
    vendorCodesByCampaign
  );

  const grouped = new Map<string, ProfitAnalyticsRow>();

  for (const wbRow of wbRows) {
    const vendorCodeKey = normalizeText(wbRow.vendorCode);
    if (!vendorCodeKey) continue;

    const current =
      grouped.get(vendorCodeKey) ??
      {
        nmId: wbRow.nmId ?? "",
        vendorCode: wbRow.vendorCode ?? "",
        subject: wbRow.subject ?? "",

        salesQty: 0,
        returnsQty: 0,
        netSalesQty: 0,

        revenue: 0,
        revenueSharePercent: 0,

        sellerRetailAmount: 0,
        sppDiscountAmount: 0,

        sellerPayout: 0,
        wbCommission: 0,
        wbCommissionBeforeVat: 0,
        wbCommissionVat: 0,

        logisticsCost: 0,
        storageCost: 0,
        acceptanceCost: 0,

        penaltiesAmount: 0,
        deductions: 0,
        wbAdsDeduction: 0,
        wbCreditDeduction: 0,
        wbUnknownDeduction: 0,
        wbRawDeduction: 0,
        paymentServiceCost: 0,
        pvzCompensation: 0,
        transportCompensation: 0,
        loyaltyDiscountCompensation: 0,
        loyaltyParticipationCost: 0,
        loyaltyPointsAmount: 0,

        adsCost: adsCostByVendorCode.get(vendorCodeKey) ?? 0,
        drrPercent: 0,

        costPrice: costByVendorCode.get(vendorCodeKey) ?? 0,
        totalCost: 0,

        marginProfit: 0,
        marginProfitPercent: 0,

        taxesAmount: 0,

        netProfitAfterTax: 0,
        marginAfterTaxPercent: 0,

        abcByProfit: "C" as const,
      };

    const paymentReason = normalizeText(wbRow.paymentReason);
    const quantity = Math.abs(toNumber(wbRow.quantity));

    const sellerRetailAmount =
      toNumber(wbRow.retailPriceWithDiscount) || toNumber(wbRow.retailPrice);
    const realizedAmount = toNumber(wbRow.wbRealizedAmount);
    const sellerPayout = toNumber(wbRow.sellerPayout);
    const sppDiscountAmount =
      toNumber(wbRow.sppDiscountAmount) || sellerRetailAmount - realizedAmount;

    const wbCommissionBeforeVat = toNumber(wbRow.wbReward);
    const wbCommissionVat = calculateWbCommissionVatFallback(
      wbCommissionBeforeVat,
      wbRow.wbRewardVat
    );
    const wbCommissionTotalRaw = toNumber(wbRow.wbRewardTotal);
    const wbCommissionTotal =
      wbCommissionTotalRaw !== 0
        ? wbCommissionTotalRaw
        : wbCommissionBeforeVat + wbCommissionVat;

    if (isSaleOperation(paymentReason)) {
      current.salesQty += quantity;
      current.netSalesQty += quantity;

      current.sellerRetailAmount += sellerRetailAmount;
      current.revenue += realizedAmount;
      current.sppDiscountAmount += sppDiscountAmount;
      current.sellerPayout += sellerPayout;
      current.wbCommissionBeforeVat += wbCommissionBeforeVat;
      current.wbCommissionVat += wbCommissionVat;
      current.wbCommission += wbCommissionTotal;
      current.totalCost += current.costPrice * quantity;
    }

    if (paymentReason === "возврат") {
      current.returnsQty += quantity;
      current.netSalesQty -= quantity;

      current.sellerRetailAmount -= sellerRetailAmount;
      current.revenue -= realizedAmount;
      current.sppDiscountAmount -= sppDiscountAmount;
      current.sellerPayout -= sellerPayout;
      current.wbCommissionBeforeVat -= wbCommissionBeforeVat;
      current.wbCommissionVat -= wbCommissionVat;
      current.wbCommission -= wbCommissionTotal;
      current.totalCost -= current.costPrice * quantity;
    }

    current.logisticsCost += Math.abs(toNumber(wbRow.logisticsCost));
    current.storageCost += Math.abs(toNumber(wbRow.storageCost));
    current.acceptanceCost += Math.abs(toNumber(wbRow.acceptanceCost));

    current.penaltiesAmount += toNumber(wbRow.penaltiesAmount);

    const rawDeduction = Math.abs(toNumber(wbRow.deductions));
    const deductionClass = classifyWbDeductionReason(wbRow.deductionReason);

    current.wbRawDeduction += rawDeduction;

    if (deductionClass === "ADS") {
      current.wbAdsDeduction += rawDeduction;
    } else if (deductionClass === "CREDIT") {
      current.wbCreditDeduction += rawDeduction;
    } else if (deductionClass === "OPERATING") {
      current.deductions += rawDeduction;
    } else {
      // Если вид удержания не сохранён, не вычитаем его в unit-экономике автоматически.
      // Иначе можно задвоить WB Продвижение или кредит.
      current.wbUnknownDeduction += rawDeduction;
    }

    current.paymentServiceCost += Math.abs(toNumber(wbRow.paymentServiceCost));
    current.pvzCompensation += Math.abs(toNumber(wbRow.pvzCompensation));
    current.transportCompensation += Math.abs(toNumber(wbRow.transportCompensation));
    current.loyaltyDiscountCompensation += toNumber(
      wbRow.loyaltyDiscountCompensation
    );
    current.loyaltyParticipationCost += Math.abs(
      toNumber(wbRow.loyaltyParticipationCost)
    );
    current.loyaltyPointsAmount += Math.abs(toNumber(wbRow.loyaltyPointsAmount));

    // Для управленческой прибыли берём официальное «к перечислению продавцу»
    // и уже от него вычитаем себестоимость, логистику, хранение, удержания, рекламу и налоги.
    // Комиссия/компенсация WB, СПП, платёжные услуги и ПВЗ показываются отдельно как расшифровка
    // перехода от цены продавца к выплате, но не вычитаются второй раз.
    current.marginProfit =
      current.sellerPayout -
      current.totalCost -
      current.logisticsCost -
      current.storageCost -
      current.acceptanceCost -
      current.penaltiesAmount -
      current.deductions -
      current.adsCost;

    current.marginProfitPercent =
      current.revenue > 0 ? (current.marginProfit / current.revenue) * 100 : 0;

    current.drrPercent =
      current.revenue > 0 ? (current.adsCost / current.revenue) * 100 : 0;

    const usnTax = current.revenue > 0 ? current.revenue * (usnRate / 100) : 0;
    const vatTax =
      current.revenue > 0 ? calculateVatTax(current.revenue, vatRate) : 0;

    current.taxesAmount = usnTax + vatTax;
    current.netProfitAfterTax = current.marginProfit - current.taxesAmount;

    current.marginAfterTaxPercent =
      current.revenue > 0
        ? (current.netProfitAfterTax / current.revenue) * 100
        : 0;

    grouped.set(vendorCodeKey, current);
  }

  const rows = Array.from(grouped.values())
    .filter((row) => row.salesQty > 0 || row.revenue > 0)
    .sort((a, b) => b.marginProfit - a.marginProfit);

  calculateAbcByProfit(rows);

  const totalRevenue = rows.reduce((sum, row) => sum + row.revenue, 0);

  rows.forEach((row) => {
    row.revenueSharePercent =
      totalRevenue > 0 ? (row.revenue / totalRevenue) * 100 : 0;
  });

  const totals = rows.reduce(
    (acc, row) => {
      acc.salesQty += row.salesQty;
      acc.returnsQty += row.returnsQty;
      acc.netSalesQty += row.netSalesQty;

      acc.revenue += row.revenue;
      acc.sellerRetailAmount += row.sellerRetailAmount;
      acc.sppDiscountAmount += row.sppDiscountAmount;
      acc.sellerPayout += row.sellerPayout;
      acc.wbCommission += row.wbCommission;
      acc.wbCommissionBeforeVat += row.wbCommissionBeforeVat;
      acc.wbCommissionVat += row.wbCommissionVat;

      acc.logisticsCost += row.logisticsCost;
      acc.storageCost += row.storageCost;
      acc.acceptanceCost += row.acceptanceCost;

      acc.penaltiesAmount += row.penaltiesAmount;
      acc.deductions += row.deductions;
      acc.wbAdsDeduction += row.wbAdsDeduction;
      acc.wbCreditDeduction += row.wbCreditDeduction;
      acc.wbUnknownDeduction += row.wbUnknownDeduction;
      acc.wbRawDeduction += row.wbRawDeduction;
      acc.paymentServiceCost += row.paymentServiceCost;
      acc.pvzCompensation += row.pvzCompensation;
      acc.transportCompensation += row.transportCompensation;
      acc.loyaltyDiscountCompensation += row.loyaltyDiscountCompensation;
      acc.loyaltyParticipationCost += row.loyaltyParticipationCost;
      acc.loyaltyPointsAmount += row.loyaltyPointsAmount;

      acc.adsCost += row.adsCost;
      acc.totalCost += row.totalCost;
      acc.marginProfit += row.marginProfit;
      acc.taxesAmount += row.taxesAmount;
      acc.netProfitAfterTax += row.netProfitAfterTax;

      return acc;
    },
    createEmptyTotals(usnRate, vatRate, undistributedAdsCost)
  );

  if (totals.undistributedAdsCost > 0) {
    totals.adsCost += totals.undistributedAdsCost;
    totals.marginProfit -= totals.undistributedAdsCost;
    totals.netProfitAfterTax -= totals.undistributedAdsCost;
  }

  if (totals.wbAdsDeduction > 0) {
    const adsDifference = totals.wbAdsDeduction - totals.adsCost;

    totals.adsCost = totals.wbAdsDeduction;
    totals.marginProfit -= adsDifference;
    totals.netProfitAfterTax -= adsDifference;
  }

  totals.marginProfitPercent =
    totals.revenue > 0 ? (totals.marginProfit / totals.revenue) * 100 : 0;

  totals.marginAfterTaxPercent =
    totals.revenue > 0
      ? (totals.netProfitAfterTax / totals.revenue) * 100
      : 0;

  totals.drrPercent =
    totals.revenue > 0 ? (totals.adsCost / totals.revenue) * 100 : 0;

  return {
    rows,
    totals,
  };
}

async function findLatestWbSaleRowsBySaleDate(params?: {
  dateFrom?: string | null;
  dateTo?: string | null;
  companyName?: string | null;
  reportTypes?: string[];
}) {
  const saleDateWhere =
    params?.dateFrom || params?.dateTo
      ? {
          ...(params?.dateFrom ? { gte: startOfDay(params.dateFrom) } : {}),
          ...(params?.dateTo ? { lt: nextDayStart(params.dateTo) } : {}),
        }
      : undefined;

  const importSessions = await prisma.importSession.findMany({
    where: {
      ...(params?.companyName ? { companyName: params.companyName } : {}),
      reportType: {
        in: params?.reportTypes ?? ["WB_SALES_DAILY"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  const latestSessionByFileName = new Map<string, string>();

  for (const session of importSessions) {
    if (!latestSessionByFileName.has(session.fileName)) {
      latestSessionByFileName.set(session.fileName, session.id);
    }
  }

  const latestImportSessionIds = Array.from(latestSessionByFileName.values());

  if (latestImportSessionIds.length === 0) {
    return [];
  }

  return prisma.wbSale.findMany({
    where: {
      ...(params?.companyName ? { companyName: params.companyName } : {}),
      ...(saleDateWhere ? { saleDate: saleDateWhere } : {}),
      importSessionId: {
        in: latestImportSessionIds,
      },
    },
    orderBy: {
      saleDate: "desc",
    },
  });
}

async function findPreferredWbSaleRowsBySaleDate(params?: {
  dateFrom?: string | null;
  dateTo?: string | null;
  companyName?: string | null;
}) {
  const detailedRows = await findLatestWbSaleRowsBySaleDate({
    ...params,
    reportTypes: ["WB_SALES_OPERATIONAL", "WB_SALES"],
  });

  const dailyRows = await findLatestWbSaleRowsBySaleDate({
    ...params,
    reportTypes: ["WB_SALES_DAILY"],
  });

  if (detailedRows.length === 0) {
    return dailyRows;
  }

  if (dailyRows.length === 0) {
    return detailedRows;
  }

  const detailedKeys = new Set(
    detailedRows.map((row) =>
      [row.companyName ?? params?.companyName ?? "", getMoscowDateKey(row.saleDate)].join("__")
    )
  );

  return [
    ...detailedRows,
    ...dailyRows.filter((row) => {
      const key = [row.companyName ?? params?.companyName ?? "", getMoscowDateKey(row.saleDate)].join("__");

      return !detailedKeys.has(key);
    }),
  ];
}

async function findWbSaleRowsByPeriod(params?: {
  dateFrom?: string | null;
  dateTo?: string | null;
  companyName?: string | null;
}) {
  const financeRows = await prisma.wbFinance.findMany({
    where: {
      ...(params?.companyName ? { companyName: params.companyName } : {}),
      ...(params?.dateFrom || params?.dateTo
        ? createDateFilterFromStrings(params?.dateFrom, params?.dateTo)
        : {}),
    },
  });

  const reportNumbers = Array.from(
    new Set(
      financeRows
        .map((row) => String(row.reportNumber ?? "").trim())
        .filter(Boolean)
    )
  );

  if (reportNumbers.length > 0) {
    const importSessions = await prisma.importSession.findMany({
      where: {
        ...(params?.companyName ? { companyName: params.companyName } : {}),
        reportType: {
          in: ["WB_SALES", "WB_SALES_OPERATIONAL"],
        },
        OR: reportNumbers.map((reportNumber) => ({
          fileName: {
            contains: reportNumber,
          },
        })),
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const latestSessionByFileName = new Map<string, string>();

    for (const session of importSessions) {
      if (!latestSessionByFileName.has(session.fileName)) {
        latestSessionByFileName.set(session.fileName, session.id);
      }
    }

    const latestImportSessionIds = Array.from(latestSessionByFileName.values());

    if (latestImportSessionIds.length > 0) {
      const rows = await prisma.wbSale.findMany({
        where: {
          ...(params?.companyName ? { companyName: params.companyName } : {}),
          importSessionId: {
            in: latestImportSessionIds,
          },
        },
        orderBy: {
          saleDate: "desc",
        },
      });

      if (rows.length > 0) {
        return rows;
      }
    }
  }

  return findPreferredWbSaleRowsBySaleDate(params);
}

async function findAdsRowsByPeriod(params?: {
  dateFrom?: string | null;
  dateTo?: string | null;
  companyName?: string | null;
}) {
  const from = params?.dateFrom ? startOfDay(params.dateFrom) : null;
  const toExclusive = params?.dateTo ? nextDayStart(params.dateTo) : null;
  const toInclusive = params?.dateTo ? startOfDay(params.dateTo) : null;

  const dateOverlapFilter =
    from && toExclusive
      ? {
          AND: [
            {
              dateFrom: {
                lt: toExclusive,
              },
            },
            {
              dateTo: {
                gte: from,
              },
            },
          ],
        }
      : from
        ? {
            dateTo: {
              gte: from,
            },
          }
        : toExclusive
          ? {
              dateFrom: {
                lt: toExclusive,
              },
            }
          : {};

  const rows = await prisma.wbAds.findMany({
    where: {
      ...dateOverlapFilter,
      ...(params?.companyName ? { companyName: params.companyName } : {}),
    },
  });

  if (!from || !toInclusive) return rows;

  return rows.map((row) => ({
    ...row,
    spend: prorateSpendByPeriod(row.spend, row.dateFrom, row.dateTo, from, toInclusive),
  }));
}

async function findWbFinanceExpenseTotalsByPeriod(params?: {
  dateFrom?: string | null;
  dateTo?: string | null;
  companyName?: string | null;
}): Promise<WbFinanceExpenseTotals> {
  const dateFilter = createDateFilterFromStrings(params?.dateFrom, params?.dateTo);

  const rows = await prisma.wbFinance.findMany({
    where: {
      ...dateFilter,
      ...(params?.companyName ? { companyName: params.companyName } : {}),
    },
    select: {
      salesAmount: true,
      payoutAmount: true,
      logisticsCost: true,
      storageCost: true,
      acceptanceCost: true,
      penaltiesAmount: true,
      otherDeductions: true,
    },
  });

  return rows.reduce(
    (acc, row) => {
      acc.revenue += toNumber(row.salesAmount);
      acc.sellerPayout += toNumber(row.payoutAmount);
      acc.logisticsCost += toNumber(row.logisticsCost);
      acc.storageCost += toNumber(row.storageCost);
      acc.acceptanceCost += toNumber(row.acceptanceCost);
      acc.penaltiesAmount += toNumber(row.penaltiesAmount);
      acc.deductions += toNumber(row.otherDeductions);

      return acc;
    },
    {
      hasRows: rows.length > 0,
      revenue: 0,
      sellerPayout: 0,
      logisticsCost: 0,
      storageCost: 0,
      acceptanceCost: 0,
      penaltiesAmount: 0,
      deductions: 0,
    }
  );
}

function applyWbFinanceExpenseTotals(
  result: {
    rows: ProfitAnalyticsRow[];
    totals: ProfitTotals;
  },
  financeExpenses: WbFinanceExpenseTotals
) {
  result.totals.revenue = financeExpenses.revenue;
  result.totals.sellerPayout = financeExpenses.sellerPayout;
  result.totals.logisticsCost = financeExpenses.logisticsCost;
  result.totals.storageCost = financeExpenses.storageCost;
  result.totals.acceptanceCost = financeExpenses.acceptanceCost;
  result.totals.penaltiesAmount = financeExpenses.penaltiesAmount;

  // Важно: WbFinance.otherDeductions НЕ подставляем целиком в прибыль.
  // В этой сумме могут быть WB Продвижение и WB-кредит, которые нельзя задваивать.
  // Операционные удержания берём из WbSale после классификации deductionReason.

  if (result.totals.sellerRetailAmount > 0) {
    result.totals.sppDiscountAmount =
      result.totals.sellerRetailAmount - result.totals.revenue;
  }

  if (result.totals.wbAdsDeduction > 0) {
    result.totals.adsCost = result.totals.wbAdsDeduction;
  }

  result.totals.marginProfit =
    result.totals.sellerPayout -
    result.totals.totalCost -
    result.totals.logisticsCost -
    result.totals.storageCost -
    result.totals.acceptanceCost -
    result.totals.penaltiesAmount -
    result.totals.deductions -
    result.totals.adsCost;

  result.totals.taxesAmount =
    result.totals.revenue > 0
      ? result.totals.revenue * (result.totals.usnRate / 100) +
        calculateVatTax(result.totals.revenue, result.totals.vatRate)
      : 0;

  result.totals.netProfitAfterTax =
    result.totals.marginProfit - result.totals.taxesAmount;

  result.totals.marginProfitPercent =
    result.totals.revenue > 0
      ? (result.totals.marginProfit / result.totals.revenue) * 100
      : 0;

  result.totals.marginAfterTaxPercent =
    result.totals.revenue > 0
      ? (result.totals.netProfitAfterTax / result.totals.revenue) * 100
      : 0;

  result.totals.drrPercent =
    result.totals.revenue > 0
      ? (result.totals.adsCost / result.totals.revenue) * 100
      : 0;

  return result;
}

export async function getProfitAnalytics(params?: {
  dateFrom?: string | null;
  dateTo?: string | null;
  companyName?: string | null;
}) {
  const companyName =
    params?.companyName && params.companyName !== "ALL"
      ? params.companyName
      : null;

  const companySettings = companyName
    ? await prisma.company.findFirst({
        where: {
          name: companyName,
        },
      })
    : null;

  const usnRate = clampRate(companySettings?.usnRate, [0, 1, 2, 3, 4, 5, 6], 1);
  const vatRate = clampRate(companySettings?.vatRate, [0, 5, 7], 5);

  const costs = await prisma.productCost.findMany({
    orderBy: {
      costDate: "desc",
    },
  });

  const adMaps = await prisma.adCampaignMap.findMany({
    where: {
      marketplace: "WB",
      ...(companyName ? { companyName } : {}),
    },
  });

  const currentSalesRows = await findWbSaleRowsByPeriod({
    dateFrom: params?.dateFrom,
    dateTo: params?.dateTo,
    companyName,
  });

  const previousPeriod = calculatePreviousPeriod(
    params?.dateFrom,
    params?.dateTo
  );

  const currentAdsRows = await findAdsRowsByPeriod({
    dateFrom: params?.dateFrom,
    dateTo: params?.dateTo,
    companyName,
  });

  const currentFinanceExpenses = await findWbFinanceExpenseTotalsByPeriod({
    dateFrom: params?.dateFrom,
    dateTo: params?.dateTo,
    companyName,
  });

  const previousAdsRows = previousPeriod
    ? await findAdsRowsByPeriod({
        dateFrom: previousPeriod.dateFrom.toISOString().slice(0, 10),
        dateTo: previousPeriod.dateTo.toISOString().slice(0, 10),
        companyName,
      })
    : [];

  const previousFinanceExpenses = previousPeriod
    ? await findWbFinanceExpenseTotalsByPeriod({
        dateFrom: previousPeriod.dateFrom.toISOString().slice(0, 10),
        dateTo: previousPeriod.dateTo.toISOString().slice(0, 10),
        companyName,
      })
    : {
        hasRows: false,
        revenue: 0,
        sellerPayout: 0,
        logisticsCost: 0,
        storageCost: 0,
        acceptanceCost: 0,
        penaltiesAmount: 0,
        deductions: 0,
      };

  const currentBase = calculateRowsAndTotals({
    wbRows: currentSalesRows,
    costs,
    adsRows: currentAdsRows,
    adMaps,
    usnRate,
    vatRate,
  });

  const current = currentFinanceExpenses.hasRows
    ? applyWbFinanceExpenseTotals(currentBase, currentFinanceExpenses)
    : currentBase;

  const previousSalesRows = previousPeriod
    ? await findWbSaleRowsByPeriod({
        dateFrom: previousPeriod.dateFrom.toISOString().slice(0, 10),
        dateTo: previousPeriod.dateTo.toISOString().slice(0, 10),
        companyName,
      })
    : [];

  const previousBase = calculateRowsAndTotals({
    wbRows: previousSalesRows,
    costs,
    adsRows: previousAdsRows,
    adMaps,
    usnRate,
    vatRate,
  });

  const previous = previousFinanceExpenses.hasRows
    ? applyWbFinanceExpenseTotals(previousBase, previousFinanceExpenses)
    : previousBase;

  const comparison = {
    revenue: createComparison(current.totals.revenue, previous.totals.revenue),

    sellerPayout: createComparison(
      current.totals.sellerPayout,
      previous.totals.sellerPayout
    ),

    totalCost: createComparison(
      current.totals.totalCost,
      previous.totals.totalCost
    ),

    wbCommission: createComparison(
      current.totals.wbCommission,
      previous.totals.wbCommission
    ),

    logisticsCost: createComparison(
      current.totals.logisticsCost,
      previous.totals.logisticsCost
    ),

    adsCost: createComparison(current.totals.adsCost, previous.totals.adsCost),

    taxesAmount: createComparison(
      current.totals.taxesAmount,
      previous.totals.taxesAmount
    ),

    marginProfit: createComparison(
      current.totals.marginProfit,
      previous.totals.marginProfit
    ),

    netProfitAfterTax: createComparison(
      current.totals.netProfitAfterTax,
      previous.totals.netProfitAfterTax
    ),
  };

  return {
    rows: current.rows,
    totals: current.totals,

    previousRows: previous.rows,
    previousTotals: previous.totals,

    comparison,
  };
}