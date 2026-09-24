/**
 * WB accountant tax-input boundary (Tax Formula Parity V1.1 / V1.2).
 *
 * Maps WB sale rows into shared calculator inputs without redefining P&L
 * taxableRevenue / marketplaceTaxTopUp / economicTurnover.
 *
 * V1.2: report-kind resolution is fail-closed for taxable SALE/RETURN rows.
 */

import {
  calculateMarketplaceTotalTax,
  roundLegalEntityTaxLiability,
  sumRoundedLegalEntityTaxLiabilities,
} from "@/lib/finance/marketplaceTax";

export type WbFinanceTaxReportKind = "ordinary" | "buyout";

export type WbProductTaxOperation = "SALE" | "RETURN" | "OTHER";

export type WbAccountantTaxContribution = {
  ordinarySalesVatInclusiveDelta: number;
  separateVatTaxableAmountDelta: number;
  taxAmountDelta: number;
};

export class WbTaxReportKindError extends Error {
  readonly code: "WB_TAX_REPORT_KIND_UNRESOLVED" | "WB_TAX_REPORT_KIND_AMBIGUOUS";

  constructor(
    code: "WB_TAX_REPORT_KIND_UNRESOLVED" | "WB_TAX_REPORT_KIND_AMBIGUOUS",
    message: string
  ) {
    super(message);
    this.name = "WbTaxReportKindError";
    this.code = code;
  }
}

export function classifyWbFinanceReportTypeName(
  reportTypeName: unknown
): WbFinanceTaxReportKind | "unknown" {
  const raw = String(reportTypeName ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("ё", "е");
  if (!raw) return "unknown";
  if (raw === "2" || raw.includes("выкуп")) return "buyout";
  if (raw === "1" || raw.includes("основн")) return "ordinary";
  return "unknown";
}

export function wbFinanceTaxReportKindLookupKey(
  companyName: unknown,
  reportNumber: unknown
): string {
  return `${String(companyName ?? "").trim()}__${String(reportNumber ?? "").trim()}`;
}

/**
 * Build durable report-kind map.
 * Conflicting ordinary vs buyout for the same key → ambiguous sentinel (fail-closed at resolve).
 * Unknown mixed with exactly one valid kind keeps the valid kind.
 */
export function collectWbSalesTaxReportKindKeys(
  salesRows: Array<{
    companyName?: string | null;
    reportNumber?: string | null;
  }>
): Set<string> {
  const keys = new Set<string>();

  for (const row of salesRows) {
    const reportNumber = String(row.reportNumber ?? "").trim();
    if (!reportNumber) continue;
    keys.add(wbFinanceTaxReportKindLookupKey(row.companyName, reportNumber));
  }

  return keys;
}

/**
 * Limit finance report-kind evidence to keys referenced by effective WB sales rows.
 */
export function buildWbFinanceTaxReportKindByKeyForRelevantSales(
  financeRows: Array<{
    companyName?: string | null;
    reportNumber?: string | null;
    reportTypeName?: string | null;
  }>,
  salesRows: Array<{
    companyName?: string | null;
    reportNumber?: string | null;
  }>
): Map<string, WbFinanceTaxReportKind | "ambiguous"> {
  const relevantKeys = collectWbSalesTaxReportKindKeys(salesRows);
  const scoped = financeRows.filter((row) => {
    const reportNumber = String(row.reportNumber ?? "").trim();
    if (!reportNumber) return false;
    return relevantKeys.has(
      wbFinanceTaxReportKindLookupKey(row.companyName, reportNumber)
    );
  });
  return buildWbFinanceTaxReportKindByKey(scoped);
}

export function buildWbFinanceTaxReportKindByKey(
  rows: Array<{
    companyName?: string | null;
    reportNumber?: string | null;
    reportTypeName?: string | null;
  }>
): Map<string, WbFinanceTaxReportKind | "ambiguous"> {
  const map = new Map<string, WbFinanceTaxReportKind | "ambiguous">();

  for (const row of rows) {
    const reportNumber = String(row.reportNumber ?? "").trim();
    if (!reportNumber) continue;

    const key = wbFinanceTaxReportKindLookupKey(row.companyName, reportNumber);
    const kind = classifyWbFinanceReportTypeName(row.reportTypeName);
    if (kind === "unknown") continue;

    const previous = map.get(key);
    if (previous == null) {
      map.set(key, kind);
      continue;
    }
    if (previous === "ambiguous") continue;
    if (previous !== kind) {
      map.set(key, "ambiguous");
    }
  }

  return map;
}

export function resolveWbSaleTaxReportKind(input: {
  companyName?: string | null;
  reportNumber?: string | null;
  kindByKey: Map<string, WbFinanceTaxReportKind | "ambiguous">;
  /** When true (default for taxable callers), missing/unknown kinds throw. */
  requireResolved?: boolean;
}): WbFinanceTaxReportKind | null {
  const requireResolved = input.requireResolved === true;
  const reportNumber = String(input.reportNumber ?? "").trim();
  if (!reportNumber) {
    if (requireResolved) {
      throw new WbTaxReportKindError(
        "WB_TAX_REPORT_KIND_UNRESOLVED",
        "WB taxable row missing reportNumber for accountant tax classification"
      );
    }
    return null;
  }

  const key = wbFinanceTaxReportKindLookupKey(
    input.companyName,
    reportNumber
  );
  const kind = input.kindByKey.get(key);

  if (kind === "ambiguous") {
    throw new WbTaxReportKindError(
      "WB_TAX_REPORT_KIND_AMBIGUOUS",
      `WB finance reportTypeName conflict for ${key}`
    );
  }

  if (kind === "ordinary" || kind === "buyout") {
    return kind;
  }

  if (requireResolved) {
    throw new WbTaxReportKindError(
      "WB_TAX_REPORT_KIND_UNRESOLVED",
      `WB taxable row has unresolved reportTypeName for ${key}`
    );
  }

  return null;
}

export function calculateWbAccountantTaxContribution(input: {
  buyerPaid: number;
  operation: WbProductTaxOperation;
  reportKind: WbFinanceTaxReportKind | null;
  usnRate: number;
  vatRate: number;
  /** When true, SALE/RETURN with buyerPaid>0 require a resolved ordinary/buyout kind. */
  requireResolvedKind?: boolean;
}): WbAccountantTaxContribution {
  if (input.operation === "OTHER") {
    return {
      ordinarySalesVatInclusiveDelta: 0,
      separateVatTaxableAmountDelta: 0,
      taxAmountDelta: 0,
    };
  }

  const buyerPaid = Math.abs(Number(input.buyerPaid) || 0);
  if (buyerPaid === 0) {
    return {
      ordinarySalesVatInclusiveDelta: 0,
      separateVatTaxableAmountDelta: 0,
      taxAmountDelta: 0,
    };
  }

  const requireResolved = input.requireResolvedKind !== false;
  if (requireResolved && input.reportKind == null) {
    throw new WbTaxReportKindError(
      "WB_TAX_REPORT_KIND_UNRESOLVED",
      "WB taxable SALE/RETURN requires resolved ordinary/buyout report kind"
    );
  }

  const signed = input.operation === "RETURN" ? -1 : 1;
  const isBuyout = input.reportKind === "buyout";
  const ordinarySalesVatInclusive = isBuyout ? 0 : buyerPaid;
  const separateVatTaxableAmount = isBuyout ? buyerPaid : 0;
  const taxAbs = calculateMarketplaceTotalTax({
    ordinarySalesVatInclusive,
    separateVatTaxableAmount,
    usnOtherIncomeBaseExVat: 0,
    usnRate: input.usnRate,
    vatRate: input.vatRate,
  });

  return {
    ordinarySalesVatInclusiveDelta:
      ordinarySalesVatInclusive === 0 ? 0 : signed * ordinarySalesVatInclusive,
    separateVatTaxableAmountDelta:
      separateVatTaxableAmount === 0 ? 0 : signed * separateVatTaxableAmount,
    taxAmountDelta: taxAbs === 0 ? 0 : signed * taxAbs,
  };
}

export function summarizeWbAccountantTaxBases(
  contributions: WbAccountantTaxContribution[]
) {
  return contributions.reduce(
    (acc, row) => {
      acc.ordinarySalesVatInclusive += row.ordinarySalesVatInclusiveDelta;
      acc.separateVatTaxableAmount += row.separateVatTaxableAmountDelta;
      acc.totalTax += row.taxAmountDelta;
      return acc;
    },
    {
      ordinarySalesVatInclusive: 0,
      separateVatTaxableAmount: 0,
      totalTax: 0,
    }
  );
}

/** Round full-precision entity tax liability once (runtime contract). */
export function finalizeLegalEntityWbTaxLiability(
  fullPrecisionTaxAmount: number
): number {
  return roundLegalEntityTaxLiability(fullPrecisionTaxAmount);
}

/** ALL / multi-company: sum rounded entity liabilities (runtime contract). */
export function aggregateRoundedWbTaxLiabilities(
  entityFullPrecisionTaxes: number[]
): number {
  return sumRoundedLegalEntityTaxLiabilities(
    entityFullPrecisionTaxes.map(roundLegalEntityTaxLiability)
  );
}

/**
 * Telegram / fallback WB tax using the same accountant mapper + entity rounding.
 * Throws WbTaxReportKindError on unresolved taxable rows (fail-closed).
 */
export function calculateWbFallbackAccountantTaxLiability(input: {
  rows: Array<{
    companyName?: string | null;
    reportNumber?: string | null;
    paymentReason?: string | null;
    documentType?: string | null;
    wbRealizedAmount?: unknown;
  }>;
  kindByKey: Map<string, WbFinanceTaxReportKind | "ambiguous">;
  usnRate: number;
  vatRate: number;
}): number {
  const taxesByCompany = new Map<string, number>();

  for (const row of input.rows) {
    const payment = String(row.paymentReason ?? "")
      .toLowerCase()
      .replaceAll("ё", "е")
      .trim();
    const doc = String(row.documentType ?? "")
      .toLowerCase()
      .replaceAll("ё", "е")
      .trim();
    const isStorno =
      payment === "сторно возвратов" || doc === "сторно возвратов";
    const isReturn =
      !isStorno &&
      (payment === "возврат" ||
        payment.includes("возврат") ||
        doc === "возврат" ||
        doc.includes("возврат"));
    const isSale =
      !isReturn &&
      (payment === "продажа" || doc === "продажа" || isStorno);

    let operation: WbProductTaxOperation = "OTHER";
    if (isSale) operation = "SALE";
    if (isReturn) operation = "RETURN";

    const buyerPaidRaw = row.wbRealizedAmount;
    const buyerPaid =
      typeof buyerPaidRaw === "object" &&
      buyerPaidRaw &&
      "toNumber" in buyerPaidRaw
        ? Math.abs(
            Number(
              (buyerPaidRaw as { toNumber: () => number }).toNumber()
            ) || 0
          )
        : Math.abs(Number(buyerPaidRaw ?? 0) || 0);

    const reportKind = resolveWbSaleTaxReportKind({
      companyName: row.companyName,
      reportNumber: row.reportNumber,
      kindByKey: input.kindByKey,
      requireResolved: operation !== "OTHER" && buyerPaid > 0,
    });
    const delta = calculateWbAccountantTaxContribution({
      buyerPaid,
      operation,
      reportKind,
      usnRate: input.usnRate,
      vatRate: input.vatRate,
    }).taxAmountDelta;

    const companyKey = String(row.companyName ?? "").trim() || "__unknown__";
    taxesByCompany.set(
      companyKey,
      (taxesByCompany.get(companyKey) ?? 0) + delta
    );
  }

  return aggregateRoundedWbTaxLiabilities([...taxesByCompany.values()]);
}
