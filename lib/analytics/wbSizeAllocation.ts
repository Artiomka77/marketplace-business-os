import { classifyCanonicalWbProductOperation } from "@/lib/wb/sourceOwnership";

export type CanonicalWbSizeMetric = {
  size: string;
  barcode: string;
  economicTurnover: number;
  salesQty: number;
  returnsQty: number;
  netSalesQty: number;
};

type WbSizeOperationInput = {
  paymentReason: unknown;
  documentType?: unknown;
  quantity: unknown;
  retailPrice: unknown;
  retailPriceWithDiscount: unknown;
};

function finiteNumber(value: unknown) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "object" && "toNumber" in value) {
    const numeric = Number((value as { toNumber: () => number }).toNumber());
    return Number.isFinite(numeric) ? numeric : 0;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function applyCanonicalWbSizeOperation(
  metric: CanonicalWbSizeMetric,
  row: WbSizeOperationInput
) {
  const operation = classifyCanonicalWbProductOperation(row);
  const sign = operation === "SALE" ? 1 : operation === "RETURN" ? -1 : 0;
  if (sign === 0) return metric;

  const quantity = Math.abs(finiteNumber(row.quantity));
  const canonicalTurnover = finiteNumber(row.retailPriceWithDiscount);
  const economicTurnover = Math.abs(
    canonicalTurnover !== 0
      ? canonicalTurnover
      : finiteNumber(row.retailPrice)
  );

  if (sign > 0) metric.salesQty += quantity;
  else metric.returnsQty += quantity;
  metric.netSalesQty += sign * quantity;
  metric.economicTurnover += sign * economicTurnover;
  return metric;
}

export function allocateCanonicalWbSizeMetrics(params: {
  sizes: CanonicalWbSizeMetric[];
  productEconomicTurnover: number;
  productExpenses: number;
  productNetProfitAfterTax: number;
}) {
  const sizes = params.sizes.filter(
    (size) =>
      size.salesQty !== 0 ||
      size.returnsQty !== 0 ||
      size.netSalesQty !== 0 ||
      size.economicTurnover !== 0
  );
  const signedTurnoverTotal = sizes.reduce(
    (sum, size) => sum + size.economicTurnover,
    0
  );
  const signedQtyTotal = sizes.reduce(
    (sum, size) => sum + size.netSalesQty,
    0
  );

  const shareFor = (size: CanonicalWbSizeMetric) => {
    if (Math.abs(signedTurnoverTotal) > 0.000001) {
      return size.economicTurnover / signedTurnoverTotal;
    }
    if (Math.abs(signedQtyTotal) > 0.000001) {
      return size.netSalesQty / signedQtyTotal;
    }
    return 1 / Math.max(1, sizes.length);
  };

  return sizes.map((size) => {
    const share = shareFor(size);
    const rawTurnoverReconciles =
      Math.abs(signedTurnoverTotal - params.productEconomicTurnover) <= 0.01;

    return {
      ...size,
      allocationShare: share,
      allocatedEconomicTurnover: rawTurnoverReconciles
        ? size.economicTurnover
        : params.productEconomicTurnover * share,
      allocatedExpenses: params.productExpenses * share,
      allocatedNetProfitAfterTax: params.productNetProfitAfterTax * share,
    };
  });
}
