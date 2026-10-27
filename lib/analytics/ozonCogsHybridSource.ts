/**
 * Authoritative Ozon physical COGS quantity helpers.
 * Physical movements and monetary finance rows have separate ownership.
 * Pure — no DB.
 */

export type OzonCogsProductRow = {
  companyName: string | null;
  sku: string | null;
  vendorCode: string | null;
  productName?: string | null;
  realizedQty: number;
  returnedQty: number;
  netQty?: number;
  realizedAmount: number;
  returnedAmount: number;
  taxableRevenue?: number;
  partnerProgramsAmount?: number;
  dateFrom: Date;
  dateTo: Date;
  /** Stable event identity (accrual_id|sku|unit). Dedupes re-imports. */
  eventId?: string | null;
  sessionId?: string | null;
  /** Operation calendar day YYYY-MM-DD (source timezone documented as UTC date key). */
  operationDay?: string | null;
  quantityKnown?: boolean;
  /** Source attested this company+day product universe is complete. */
  authorityCompleteForDay?: boolean;
};

export type OzonCogsAuthorityDay = {
  companyName: string;
  day: string;
  complete: boolean;
  confirmedZeroProductSales?: boolean;
};

export type OzonCogsFinanceLikeRow = {
  companyName?: string | null;
  sku?: string | null;
  vendorCode?: string | null;
  quantity?: number | null;
  salesAmount?: number | null;
  totalAmount?: number | null;
  ozonCommission?: number | null;
  logisticsCost?: number | null;
  reverseLogisticsCost?: number | null;
  accrualDate?: Date | null;
  operationType?: string | null;
  importSessionId?: string | null;
  createdAt?: Date | null;
  eventId?: string | null;
  /** Explicit physical sale/return when money may be zero. */
  physicalMovement?: "SALE" | "RETURN" | null;
  quantityUnknown?: boolean;
};

function utcDay(value: Date | string | null | undefined): string {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function companyKey(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function isFinanceProductSaleRow(row: OzonCogsFinanceLikeRow): boolean {
  const sales = Number(row.salesAmount ?? 0);
  return Number.isFinite(sales) && sales !== 0;
}

function isFinanceServiceOrAdRow(row: OzonCogsFinanceLikeRow): boolean {
  return !isFinanceProductSaleRow(row);
}

/**
 * Days with proven product authority for a company.
 * Interval spanning dateFrom..dateTo alone is NOT sufficient — requires
 * operationDay or authorityDays metadata / authorityCompleteForDay.
 */
export function buildAuthoritativeOzonProductDays(params: {
  productRows: OzonCogsProductRow[];
  authorityDays?: OzonCogsAuthorityDay[];
}): Map<string, Set<string>> {
  const byCompany = new Map<string, Set<string>>();
  const add = (company: string, day: string) => {
    if (!company || !day) return;
    const set = byCompany.get(company) ?? new Set<string>();
    set.add(day);
    byCompany.set(company, set);
  };

  for (const day of params.authorityDays ?? []) {
    if (day.complete) add(companyKey(day.companyName), utcDay(day.day));
  }

  for (const row of params.productRows) {
    if (row.authorityCompleteForDay === false) continue;
    const company = companyKey(row.companyName);
    const day = utcDay(row.operationDay ?? row.dateFrom);
    // Single-day grain only: multi-day interval without operationDay does not
    // claim authority for every calendar day in the span.
    const end = utcDay(row.dateTo);
    if (row.operationDay || (day && end && day === end)) {
      add(company, day);
    }
  }
  return byCompany;
}

/** Deduplicate product rows by eventId; distinct events kept even if same SKU/amount. */
export function dedupeOzonProductRowsByEventId(
  productRows: OzonCogsProductRow[],
): OzonCogsProductRow[] {
  const out: OzonCogsProductRow[] = [];
  const seen = new Set<string>();
  let anon = 0;
  for (const row of productRows) {
    const id = String(row.eventId ?? "").trim();
    const key = id
      ? id
      : `anon:${anon++}:${companyKey(row.companyName)}:${utcDay(row.operationDay ?? row.dateFrom)}:${row.sku}:${row.realizedQty}:${row.returnedQty}:${row.realizedAmount}:${row.returnedAmount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * Map product-grain movement into finance-shaped rows for COGS.
 * Never fabricates quantity=1 or salesAmount=1.
 */
export function mapOzonProductRowToFinanceLike(
  row: OzonCogsProductRow,
): OzonCogsFinanceLikeRow[] {
  const out: OzonCogsFinanceLikeRow[] = [];
  const day = row.operationDay
    ? new Date(`${utcDay(row.operationDay)}T00:00:00.000Z`)
    : row.dateFrom;
  const realizedQty = Math.abs(Number(row.realizedQty) || 0);
  const returnedQty = Math.abs(Number(row.returnedQty) || 0);
  const realizedAmount = Number(row.realizedAmount) || 0;
  const returnedAmount = Number(row.returnedAmount) || 0;
  const qtyKnown = row.quantityKnown !== false;

  if (realizedQty > 0 && qtyKnown) {
    out.push({
      companyName: row.companyName,
      sku: row.sku,
      vendorCode: row.vendorCode,
      quantity: realizedQty,
      salesAmount: realizedAmount,
      totalAmount: realizedAmount,
      ozonCommission: 0,
      logisticsCost: 0,
      reverseLogisticsCost: 0,
      accrualDate: day,
      operationType: "OZON_ACCRUAL_BY_DAY_PRODUCT",
      eventId: row.eventId,
      importSessionId: row.sessionId,
      physicalMovement: "SALE",
      quantityUnknown: false,
    });
  } else if (realizedAmount !== 0 && (!qtyKnown || realizedQty === 0)) {
    out.push({
      companyName: row.companyName,
      sku: row.sku,
      vendorCode: row.vendorCode,
      quantity: 0,
      salesAmount: realizedAmount,
      totalAmount: realizedAmount,
      ozonCommission: 0,
      logisticsCost: 0,
      reverseLogisticsCost: 0,
      accrualDate: day,
      operationType: "OZON_ACCRUAL_BY_DAY_PRODUCT",
      eventId: row.eventId,
      importSessionId: row.sessionId,
      physicalMovement: null,
      quantityUnknown: true,
    });
  }

  if (returnedQty > 0 && qtyKnown) {
    out.push({
      companyName: row.companyName,
      sku: row.sku,
      vendorCode: row.vendorCode,
      quantity: returnedQty,
      salesAmount: -Math.abs(returnedAmount),
      totalAmount: -Math.abs(returnedAmount),
      ozonCommission: 0,
      logisticsCost: 0,
      reverseLogisticsCost: 0,
      accrualDate: day,
      operationType: "OZON_ACCRUAL_BY_DAY_PRODUCT",
      eventId: row.eventId,
      importSessionId: row.sessionId,
      physicalMovement: "RETURN",
      quantityUnknown: false,
    });
  } else if (returnedAmount !== 0 && (!qtyKnown || returnedQty === 0)) {
    out.push({
      companyName: row.companyName,
      sku: row.sku,
      vendorCode: row.vendorCode,
      quantity: 0,
      salesAmount: -Math.abs(returnedAmount),
      totalAmount: -Math.abs(returnedAmount),
      ozonCommission: 0,
      logisticsCost: 0,
      reverseLogisticsCost: 0,
      accrualDate: day,
      operationType: "OZON_ACCRUAL_BY_DAY_PRODUCT",
      eventId: row.eventId,
      importSessionId: row.sessionId,
      physicalMovement: null,
      quantityUnknown: true,
    });
  }

  return out;
}

/**
 * Hybrid COGS universe:
 * - Product movements (deduped) drive physical COGS.
 * - Finance service/ad rows are ALWAYS kept (never dropped by product days).
 * - Finance product-sale rows are suppressed only for (company, day) with
 *   proven complete product authority.
 */
export function buildHybridOzonCogsSourceRows(params: {
  productRows: OzonCogsProductRow[];
  financeRows: OzonCogsFinanceLikeRow[];
  authorityDays?: OzonCogsAuthorityDay[];
}): OzonCogsFinanceLikeRow[] {
  const productRows = dedupeOzonProductRowsByEventId(params.productRows);
  const authority = buildAuthoritativeOzonProductDays({
    productRows,
    authorityDays: params.authorityDays,
  });
  const fromProducts = productRows.flatMap(mapOzonProductRowToFinanceLike);
  const productEventIds = new Set(
    fromProducts
      .map((row) => String(row.eventId ?? "").trim())
      .filter(Boolean),
  );

  const fromFinance = params.financeRows.filter((row) => {
    const eventId = String(row.eventId ?? "").trim();
    // Same confirmed physical event must not be counted twice (partial + finance).
    if (eventId && productEventIds.has(eventId)) return false;
    if (isFinanceServiceOrAdRow(row)) return true;
    const company = companyKey(row.companyName);
    const day = utcDay(row.accrualDate ?? null);
    if (!day) return true;
    const covered = authority.get(company);
    if (covered?.has(day)) return false;
    return true;
  });

  return [...fromProducts, ...fromFinance];
}

export function summarizeOzonCogsCoverage(params: {
  productRows: OzonCogsProductRow[];
  financeRows: OzonCogsFinanceLikeRow[];
  periodDays: string[];
  authorityDays?: OzonCogsAuthorityDay[];
  companyName?: string | null;
}): {
  coveredDays: string[];
  missingProductDays: string[];
  quantityCoverageComplete: boolean;
  costCoverageIncomplete: boolean;
  unknownQuantityRows: number;
  authorityEmpty: boolean;
} {
  const companyFilter = companyKey(params.companyName);
  const productRows = dedupeOzonProductRowsByEventId(params.productRows).filter(
    (row) => !companyFilter || companyKey(row.companyName) === companyFilter,
  );
  const authority = buildAuthoritativeOzonProductDays({
    productRows,
    authorityDays: (params.authorityDays ?? []).filter(
      (d) => !companyFilter || companyKey(d.companyName) === companyFilter,
    ),
  });

  const covered = new Set<string>();
  if (companyFilter) {
    for (const d of authority.get(companyFilter) ?? []) covered.add(d);
  } else {
    for (const set of authority.values()) for (const d of set) covered.add(d);
  }

  const coveredDays = params.periodDays.filter((d) => covered.has(d));
  const missingProductDays = params.periodDays.filter((d) => !covered.has(d));
  const unknownQuantityRows = productRows.filter(
    (r) =>
      r.quantityKnown === false ||
      ((Math.abs(r.realizedQty) <= 0 && Math.abs(r.realizedAmount) > 0) ||
        (Math.abs(r.returnedQty) <= 0 && Math.abs(r.returnedAmount) > 0)),
  ).length;

  const authorityEmpty =
    productRows.length === 0 &&
    (params.authorityDays ?? []).filter(
      (d) => d.complete && (!companyFilter || companyKey(d.companyName) === companyFilter),
    ).length === 0;

  const quantityCoverageComplete =
    !authorityEmpty &&
    missingProductDays.length === 0 &&
    unknownQuantityRows === 0;

  return {
    coveredDays,
    missingProductDays,
    quantityCoverageComplete,
    costCoverageIncomplete: !quantityCoverageComplete,
    unknownQuantityRows,
    authorityEmpty,
  };
}

/** @deprecated Prefer buildAuthoritativeOzonProductDays — interval ≠ complete. */
export function buildOzonRealizationProductCoverageDays(
  productRows: Array<{ dateFrom: Date; dateTo: Date; operationDay?: string | null; authorityCompleteForDay?: boolean; companyName?: string | null }>,
): Set<string> {
  const map = buildAuthoritativeOzonProductDays({
    productRows: productRows as OzonCogsProductRow[],
  });
  const days = new Set<string>();
  for (const set of map.values()) for (const d of set) days.add(d);
  return days;
}
