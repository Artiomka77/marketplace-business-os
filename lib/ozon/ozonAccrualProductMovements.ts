/**
 * Pure parser: Ozon /by-day ImportSession RAW → product-grain physical movements.
 * Identity = accrual_id + sku + unit_number. No DB. No fabricated qty/money.
 */

export type OzonAccrualProductMovement = {
  eventId: string;
  sessionId: string | null;
  companyName: string;
  operationDay: string;
  sku: string;
  vendorCode: string | null;
  unitNumber: string | null;
  quantity: number;
  salePriceAmount: number;
  saleAmount: number;
  kind: "SALE" | "RETURN";
  quantityKnown: boolean;
};

export type OzonAccrualAuthorityDay = {
  companyName: string;
  day: string;
  sessionId: string;
  complete: boolean;
  confirmedZeroProductSales: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function moneyAmount(container: unknown, key: string): number | null {
  if (!isRecord(container)) return null;
  const raw = container[key];
  if (raw == null) return null;
  if (typeof raw === "object" && raw !== null && "amount" in raw) {
    const n = Number((raw as { amount: unknown }).amount);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function dayKey(value: unknown): string {
  return String(value ?? "").trim().slice(0, 10);
}

/**
 * Extract physical sale/return movements from one RAW accrual payload.
 * Only products with commission.sale_price (realization bridge). Delivery-only
 * products without commission are not COGS movements.
 */
export function extractOzonAccrualProductMovements(params: {
  companyName: string;
  sessionId?: string | null;
  rawAccruals: unknown[];
  dateFrom?: string | null;
  dateTo?: string | null;
}): OzonAccrualProductMovement[] {
  const from = params.dateFrom ? dayKey(params.dateFrom) : null;
  const to = params.dateTo ? dayKey(params.dateTo) : null;
  const out: OzonAccrualProductMovement[] = [];
  const seen = new Set<string>();

  for (const value of params.rawAccruals) {
    if (!isRecord(value)) continue;
    const day = dayKey(value.date);
    if (!day) continue;
    if (from && day < from) continue;
    if (to && day > to) continue;

    const accrualId = String(value.accrual_id ?? "").trim();
    const unitNumber = value.unit_number != null ? String(value.unit_number) : null;
    const posting = isRecord(value.posting) ? value.posting : null;
    const products = Array.isArray(posting?.products) ? posting.products : [];

    for (const productValue of products) {
      if (!isRecord(productValue)) continue;
      const commission = isRecord(productValue.commission)
        ? productValue.commission
        : null;
      if (!commission) continue;

      const salePrice = moneyAmount(commission, "sale_price");
      if (salePrice == null) continue;

      const sku = String(productValue.sku ?? "").trim();
      if (!sku) continue;

      const qtyRaw = productValue.quantity;
      const quantityKnown =
        qtyRaw !== null && qtyRaw !== undefined && String(qtyRaw).trim() !== "";
      const quantity = quantityKnown ? Math.abs(Number(qtyRaw) || 0) : 0;
      const saleAmount = moneyAmount(commission, "sale_amount") ?? 0;
      const kind: "SALE" | "RETURN" = salePrice >= 0 ? "SALE" : "RETURN";
      const eventId = [accrualId || "no-accrual", sku, unitNumber ?? ""].join("|");
      if (seen.has(eventId)) continue;
      seen.add(eventId);

      out.push({
        eventId,
        sessionId: params.sessionId ?? null,
        companyName: params.companyName,
        operationDay: day,
        sku,
        vendorCode: null,
        unitNumber,
        quantity,
        salePriceAmount: salePrice,
        saleAmount,
        kind,
        quantityKnown,
      });
    }
  }

  return out;
}

/** Authority days from a successful /by-day RAW session (requestedDates). */
export function buildOzonAccrualAuthorityDays(params: {
  companyName: string;
  sessionId: string;
  requestedDates: string[];
  movements: OzonAccrualProductMovement[];
  coverageComplete?: boolean;
}): OzonAccrualAuthorityDay[] {
  const soldByDay = new Set(
    params.movements
      .filter((m) => m.companyName === params.companyName)
      .map((m) => m.operationDay),
  );
  return params.requestedDates.map((day) => {
    const d = dayKey(day);
    return {
      companyName: params.companyName,
      day: d,
      sessionId: params.sessionId,
      complete: params.coverageComplete !== false,
      confirmedZeroProductSales: params.coverageComplete !== false && !soldByDay.has(d),
    };
  });
}

export function mapMovementsToCogsProductRows(
  movements: OzonAccrualProductMovement[],
  vendorCodeBySku?: Map<string, string>,
): Array<{
  companyName: string;
  sku: string;
  vendorCode: string | null;
  realizedQty: number;
  returnedQty: number;
  realizedAmount: number;
  returnedAmount: number;
  dateFrom: Date;
  dateTo: Date;
  eventId: string;
  sessionId: string | null;
  operationDay: string;
  quantityKnown: boolean;
  authorityCompleteForDay: boolean;
}> {
  return movements.map((m) => {
    const dayDate = new Date(`${m.operationDay}T00:00:00.000Z`);
    const vendor =
      m.vendorCode ||
      vendorCodeBySku?.get(m.sku) ||
      vendorCodeBySku?.get(String(m.sku)) ||
      null;
    const qty = m.quantityKnown ? m.quantity : 0;
    const amount = Math.abs(m.salePriceAmount);
    return {
      companyName: m.companyName,
      sku: m.sku,
      vendorCode: vendor,
      realizedQty: m.kind === "SALE" ? qty : 0,
      returnedQty: m.kind === "RETURN" ? qty : 0,
      realizedAmount: m.kind === "SALE" ? amount : 0,
      returnedAmount: m.kind === "RETURN" ? amount : 0,
      dateFrom: dayDate,
      dateTo: dayDate,
      eventId: m.eventId,
      sessionId: m.sessionId,
      operationDay: m.operationDay,
      quantityKnown: m.quantityKnown,
      authorityCompleteForDay: true,
    };
  });
}
