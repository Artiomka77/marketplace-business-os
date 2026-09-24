import { calculateMarketplaceTotalTax } from "@/lib/finance/marketplaceTax";

export type WbV6RevenueInput = {
  retailPrice: unknown;
  retailPriceWithDiscount: unknown;
  wbRealizedAmount: unknown;
  sellerPayout: unknown;
};

export type WbV6RevenueComponents = {
  economicTurnover: number;
  buyerPaid: number;
  sellerPayout: number;
  marketplaceTaxTopUp: number;
  taxableRevenue: number;
  platformDiscount: number;
  prePayoutBridge: number;
  canonicalInputsComplete: boolean;
  missingCanonicalInputs: Array<
    "retailPriceWithDiscount" | "wbRealizedAmount" | "sellerPayout"
  >;
};

export type WbDeductionReconciliation = {
  officialOtherDeductionsTotal: number;
  classifiedAdsDeduction: number;
  classifiedCreditDeduction: number;
  classifiedOperatingDeduction: number;
  classifiedUnknownDeduction: number;
  classifiedTotal: number;
  unreconciledOfficialDeduction: number;
  isFullyReconciled: boolean;
};

export type WbCanonicalSettlementInput = {
  sellerPayout: number;
  officialLogistics: number;
  officialStorage: number;
  officialAcceptance: number;
  officialPenalties: number;
  classifiedPnlAds: number;
  classifiedPnlOperating: number;
  provenPnlAdjustments?: number;
};

export type WbClosedWeekSettlement = {
  officialCashSettlement: number;
  canonicalPnlSettlement: number;
  cashVsPnlDelta: number;
};

function toFiniteNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;

  if (typeof value === "object" && "toNumber" in value) {
    const number = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(number) ? number : 0;
  }

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");
  const number = Number(normalized);

  return Number.isFinite(number) ? number : 0;
}

function readFiniteNumber(value: unknown) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return { available: false, value: 0 };
  }
  const numeric =
    typeof value === "object" && "toNumber" in value
      ? Number((value as { toNumber: () => number }).toNumber())
      : Number(
          String(value)
            .replace(/\s/g, "")
            .replace(",", ".")
        );
  return {
    available: Number.isFinite(numeric),
    value: Number.isFinite(numeric) ? numeric : 0,
  };
}

/**
 * Financial Core V6 WB row contract.
 *
 * `retailPriceWithDiscount` is the seller's net price before the
 * WB-funded platform discount. It is already the economic turnover and
 * must never have SPP added to it again.
 */
export function calculateWbV6RevenueComponents(
  input: WbV6RevenueInput
): WbV6RevenueComponents {
  const canonicalEconomicTurnover = readFiniteNumber(
    input.retailPriceWithDiscount
  );
  const canonicalBuyerPaid = readFiniteNumber(input.wbRealizedAmount);
  const canonicalSellerPayout = readFiniteNumber(input.sellerPayout);
  const missingCanonicalInputs: WbV6RevenueComponents["missingCanonicalInputs"] =
    [];
  if (!canonicalEconomicTurnover.available) {
    missingCanonicalInputs.push("retailPriceWithDiscount");
  }
  if (!canonicalBuyerPaid.available) {
    missingCanonicalInputs.push("wbRealizedAmount");
  }
  if (!canonicalSellerPayout.available) {
    missingCanonicalInputs.push("sellerPayout");
  }

  const economicTurnover = Math.abs(
    canonicalEconomicTurnover.available
      ? canonicalEconomicTurnover.value
      : toFiniteNumber(input.retailPrice)
  );
  const buyerPaid = canonicalBuyerPaid.available
    ? Math.abs(canonicalBuyerPaid.value)
    : 0;
  const sellerPayout = canonicalSellerPayout.available
    ? Math.abs(canonicalSellerPayout.value)
    : 0;
  const marketplaceTaxTopUp =
    canonicalBuyerPaid.available && canonicalSellerPayout.available
      ? Math.max(0, sellerPayout - buyerPaid)
      : 0;
  const taxableRevenue = buyerPaid + marketplaceTaxTopUp;

  return {
    economicTurnover,
    buyerPaid,
    sellerPayout,
    marketplaceTaxTopUp,
    taxableRevenue,
    platformDiscount: Math.max(0, economicTurnover - buyerPaid),
    prePayoutBridge: economicTurnover - sellerPayout,
    canonicalInputsComplete: missingCanonicalInputs.length === 0,
    missingCanonicalInputs,
  };
}

export function buildWbRevenueCompatibilityFields(
  components: Pick<
    WbV6RevenueComponents,
    "economicTurnover" | "taxableRevenue"
  >
) {
  return {
    revenue: components.economicTurnover,
    economicTurnover: components.economicTurnover,
    taxableRevenue: components.taxableRevenue,
  };
}

export function calculateWbTaxes(
  taxableRevenue: number,
  usnRate: number,
  vatRate: number
) {
  // Tax Formula Parity V1: USN on ex-VAT ordinary base; VAT 5/105 on inclusive.
  return calculateMarketplaceTotalTax({
    ordinarySalesVatInclusive: taxableRevenue,
    separateVatTaxableAmount: 0,
    usnRate,
    vatRate,
  });
}

export function buildWbDeductionReconciliation(input: {
  officialOtherDeductionsTotal: number;
  classifiedAdsDeduction: number;
  classifiedCreditDeduction: number;
  classifiedOperatingDeduction: number;
  classifiedUnknownDeduction: number;
}): WbDeductionReconciliation {
  const officialOtherDeductionsTotal = Math.abs(
    toFiniteNumber(input.officialOtherDeductionsTotal)
  );
  const classifiedAdsDeduction = Math.abs(
    toFiniteNumber(input.classifiedAdsDeduction)
  );
  const classifiedCreditDeduction = Math.abs(
    toFiniteNumber(input.classifiedCreditDeduction)
  );
  const classifiedOperatingDeduction = Math.abs(
    toFiniteNumber(input.classifiedOperatingDeduction)
  );
  const classifiedUnknownDeduction = Math.abs(
    toFiniteNumber(input.classifiedUnknownDeduction)
  );
  const classifiedTotal =
    classifiedAdsDeduction +
    classifiedCreditDeduction +
    classifiedOperatingDeduction +
    classifiedUnknownDeduction;
  const unreconciledOfficialDeduction =
    officialOtherDeductionsTotal - classifiedTotal;

  return {
    officialOtherDeductionsTotal,
    classifiedAdsDeduction,
    classifiedCreditDeduction,
    classifiedOperatingDeduction,
    classifiedUnknownDeduction,
    classifiedTotal,
    unreconciledOfficialDeduction,
    isFullyReconciled:
      Math.abs(unreconciledOfficialDeduction) <= 0.01 &&
      classifiedUnknownDeduction <= 0.01,
  };
}

export function calculateCanonicalWbPnlSettlement(
  input: WbCanonicalSettlementInput
) {
  return (
    toFiniteNumber(input.sellerPayout) -
    Math.abs(toFiniteNumber(input.officialLogistics)) -
    Math.abs(toFiniteNumber(input.officialStorage)) -
    Math.abs(toFiniteNumber(input.officialAcceptance)) -
    Math.abs(toFiniteNumber(input.officialPenalties)) -
    Math.abs(toFiniteNumber(input.classifiedPnlAds)) -
    Math.abs(toFiniteNumber(input.classifiedPnlOperating)) +
    toFiniteNumber(input.provenPnlAdjustments)
  );
}

export function buildWbClosedWeekSettlement(input: {
  officialCashSettlement: number;
  canonical: WbCanonicalSettlementInput;
}): WbClosedWeekSettlement {
  const officialCashSettlement = toFiniteNumber(
    input.officialCashSettlement
  );
  const canonicalPnlSettlement = calculateCanonicalWbPnlSettlement(
    input.canonical
  );

  return {
    officialCashSettlement,
    canonicalPnlSettlement,
    cashVsPnlDelta: officialCashSettlement - canonicalPnlSettlement,
  };
}

export function selectWbOfficialCashDisplay(input: {
  officialCashSettlement: number;
  officialCashSettlementAvailable: boolean;
  canonicalPnlSettlement: number;
}) {
  return input.officialCashSettlementAvailable
    ? input.officialCashSettlement
    : input.canonicalPnlSettlement;
}

export function calculateClosedWeekWbProfit(input: {
  canonicalPnlSettlement: number;
  canonicalCogs: number;
  taxes: number;
  externalPnlCosts?: number;
}) {
  return (
    input.canonicalPnlSettlement -
    input.canonicalCogs -
    input.taxes -
    (input.externalPnlCosts ?? 0)
  );
}
