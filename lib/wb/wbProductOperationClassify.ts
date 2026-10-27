export type CanonicalWbProductOperation = "SALE" | "RETURN" | "OTHER";

export function normalizeWbOperationText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[–—−]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyCanonicalWbProductOperation(input: {
  paymentReason: unknown;
  documentType?: unknown;
}): CanonicalWbProductOperation {
  const paymentReason = normalizeWbOperationText(input.paymentReason);
  const documentType = normalizeWbOperationText(input.documentType);

  if (paymentReason === "сторно возвратов" || documentType === "сторно возвратов") {
    return "SALE";
  }

  if (
    documentType === "продажа" &&
    (paymentReason.includes("возмещение") ||
      paymentReason.includes("выдачу") ||
      paymentReason.includes("компенсац"))
  ) {
    return "OTHER";
  }

  if (paymentReason === "возврат" || documentType === "возврат") {
    return "RETURN";
  }

  if (
    (paymentReason.includes("возврат") && documentType !== "продажа") ||
    documentType.includes("возврат")
  ) {
    return "RETURN";
  }

  if (paymentReason === "продажа" || documentType === "продажа") {
    return "SALE";
  }

  return "OTHER";
}

export function wbPreliminaryEconomicKey(row: {
  companyName?: string | null;
  saleDate?: Date | string | null;
  nmId?: string | number | null;
  vendorCode?: string | null;
  quantity?: unknown;
  retailPriceWithDiscount?: unknown;
  retailPrice?: unknown;
  paymentReason?: string | null;
  documentType?: string | null;
  barcode?: string | null;
  size?: string | null;
  productName?: string | null;
  wbRealizedAmount?: unknown;
  sellerPayout?: unknown;
}): string {
  const day =
    row.saleDate instanceof Date
      ? row.saleDate.toISOString().slice(0, 10)
      : String(row.saleDate ?? "").slice(0, 10);
  const num = (value: unknown) => {
    if (value && typeof value === "object" && "toNumber" in value) {
      return Number((value as { toNumber: () => number }).toNumber()) || 0;
    }
    return Number(value ?? 0) || 0;
  };
  return [
    normalizeWbOperationText(row.companyName),
    day,
    String(row.nmId ?? ""),
    normalizeWbOperationText(row.vendorCode),
    String(num(row.quantity)),
    String(num(row.retailPriceWithDiscount)),
    String(num(row.retailPrice)),
    normalizeWbOperationText(row.paymentReason),
    normalizeWbOperationText(row.documentType),
    String(row.barcode ?? ""),
    String(row.size ?? ""),
    normalizeWbOperationText(row.productName),
    String(num(row.wbRealizedAmount)),
    String(num(row.sellerPayout)),
  ].join("|");
}

/**
 * Keep every DAILY row (distinct real sales may share money/SKU fingerprint).
 * OPERATIONAL rows that share an economic fingerprint with DAILY are treated as
 * cross-source overlap and suppressed. Distinct OPERATIONAL sales with the same
 * fingerprint are NOT collapsed — SKU+price+day is not event identity.
 */
export function mergePreliminaryWbSaleRowsByEconomicKey<T>(params: {
  dailyRows: T[];
  operationalRows: T[];
  keyOf: (row: T) => string;
}): T[] {
  const out: T[] = [...params.dailyRows];
  const claimedByDaily = new Set(
    params.dailyRows.map((row) => params.keyOf(row)),
  );
  for (const row of params.operationalRows) {
    const key = params.keyOf(row);
    if (claimedByDaily.has(key)) continue;
    out.push(row);
  }
  return out;
}
