/**
 * Exact SKU monetary components from Ozon /by-day RAW.
 * Dedup by accrual_id + sku + sourceKind + typeId + ordinal.
 * Uses service-level accrued amounts — never also total_accrued of the same event.
 * TYPE_CATEGORY / TYPE71 pairing come from shared ozonAccrualTypeCategory
 * (same canon as accrualByDay).
 */

import {
  OZON_ACCRUAL_TYPE_CATEGORY,
  ozonType71GroupKey,
  resolveOzonType71Categories,
  type OzonAccrualFinancialCategory,
  type OzonType71Component,
} from "@/lib/ozon/ozonAccrualTypeCategory";

export type OzonExactSkuFeeBucket = {
  sku: string;
  revenue: number;
  discountPoints: number;
  partnerPrograms: number;
  commission: number;
  logistics: number;
  partnerServices: number;
  otherServices: number;
  compensation: number;
  eventCount: number;
  sourceAccrualIds: string[];
};

export type OzonExactSkuFeeLedger = {
  bySku: Map<string, OzonExactSkuFeeBucket>;
  accountResidual: {
    commission: number;
    logistics: number;
    partnerServices: number;
    otherServices: number;
    compensation: number;
    unclassified: number;
  };
  eventKeys: string[];
};

type UnknownRecord = Record<string, unknown>;

type PendingFee = {
  sku: string | null;
  category: OzonAccrualFinancialCategory | null;
  typeId: number;
  accrualId: number;
  ordinal: number;
  accrued: number;
  eventKey: string;
  unitNumber: string | null;
  day: string;
};

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function money(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "object" && value !== null && "amount" in value) {
    return money((value as { amount: unknown }).amount);
  }
  const n = Number(String(value).replace(",", ".").replace(/\s/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function dayKey(value: unknown): string {
  return String(value ?? "").trim().slice(0, 10);
}

function emptyBucket(sku: string): OzonExactSkuFeeBucket {
  return {
    sku,
    revenue: 0,
    discountPoints: 0,
    partnerPrograms: 0,
    commission: 0,
    logistics: 0,
    partnerServices: 0,
    otherServices: 0,
    compensation: 0,
    eventCount: 0,
    sourceAccrualIds: [],
  };
}

function ensureBucket(map: Map<string, OzonExactSkuFeeBucket>, sku: string) {
  let bucket = map.get(sku);
  if (!bucket) {
    bucket = emptyBucket(sku);
    map.set(sku, bucket);
  }
  return bucket;
}

/** Signed accrued charge → positive management expense. */
function expenseFromAccrued(accrued: number): number {
  return -accrued;
}

function addExpense(
  bucket: OzonExactSkuFeeBucket | null,
  residual: OzonExactSkuFeeLedger["accountResidual"],
  category: string,
  accrued: number,
) {
  const expense = expenseFromAccrued(accrued);
  if (Math.abs(expense) < 0.0005) return;
  const target = bucket;
  if (!target) {
    if (category === "OZON_COMMISSION") residual.commission += expense;
    else if (category === "OZON_DELIVERY" || category === "OZON_FBO")
      residual.logistics += expense;
    else if (category === "OZON_PARTNER_SERVICES")
      residual.partnerServices += expense;
    else if (category === "OZON_COMPENSATION") residual.compensation += expense;
    else if (category === "OZON_OTHER_SERVICES") residual.otherServices += expense;
    else residual.unclassified += expense;
    return;
  }
  if (category === "OZON_COMMISSION") target.commission += expense;
  else if (category === "OZON_DELIVERY" || category === "OZON_FBO")
    target.logistics += expense;
  else if (category === "OZON_PARTNER_SERVICES")
    target.partnerServices += expense;
  else if (category === "OZON_COMPENSATION") target.compensation += expense;
  else if (category === "OZON_OTHER_SERVICES") target.otherServices += expense;
  else residual.unclassified += expense;
}

/**
 * Extract exact per-SKU monetary components from owned RAW accruals.
 * Dedupes repeated sessions/events by stable event key.
 */
export function extractOzonExactSkuFeesFromRaw(params: {
  rawAccruals: unknown[];
  dateFrom?: string | null;
  dateTo?: string | null;
  seenEventKeys?: Set<string>;
}): OzonExactSkuFeeLedger {
  const from = params.dateFrom ? dayKey(params.dateFrom) : null;
  const to = params.dateTo ? dayKey(params.dateTo) : null;
  const seen = params.seenEventKeys ?? new Set<string>();
  const bySku = new Map<string, OzonExactSkuFeeBucket>();
  const accountResidual = {
    commission: 0,
    logistics: 0,
    partnerServices: 0,
    otherServices: 0,
    compensation: 0,
    unclassified: 0,
  };
  const eventKeys: string[] = [];
  const pendingFees: PendingFee[] = [];
  const type71Components: OzonType71Component[] = [];

  for (const value of params.rawAccruals) {
    if (!isRecord(value)) continue;
    const day = dayKey(value.date);
    if (!day) continue;
    if (from && day < from) continue;
    if (to && day > to) continue;

    const accrualIdRaw = Number(value.accrual_id);
    const accrualId = String(value.accrual_id ?? "").trim();
    if (!accrualId || !Number.isFinite(accrualIdRaw)) continue;
    const unitNumber =
      value.unit_number == null ? null : String(value.unit_number).trim() || null;

    const posting = isRecord(value.posting) ? value.posting : null;
    let ordinal = 0;

    for (const productValue of toArray(posting?.products)) {
      if (!isRecord(productValue)) continue;
      const sku = String(productValue.sku ?? "").trim();
      if (!sku) continue;
      const bucket = ensureBucket(bySku, sku);

      const commission = isRecord(productValue.commission)
        ? productValue.commission
        : null;
      if (commission) {
        const saleEvent = `${accrualId}:COMMISSION_SALE:${sku}`;
        if (!seen.has(saleEvent)) {
          seen.add(saleEvent);
          eventKeys.push(saleEvent);
          bucket.revenue += money(commission.sale_price);
          bucket.discountPoints += money(commission.bonus);
          bucket.partnerPrograms += money(commission.coinvestment);
          const commAccrued =
            money(commission.commission) || money(commission.sale_commission);
          bucket.commission += expenseFromAccrued(commAccrued);
          bucket.eventCount += 1;
          if (!bucket.sourceAccrualIds.includes(accrualId)) {
            bucket.sourceAccrualIds.push(accrualId);
          }
        }
      }

      const delivery = isRecord(productValue.delivery)
        ? productValue.delivery
        : null;
      for (const serviceValue of toArray(delivery?.services)) {
        if (!isRecord(serviceValue)) continue;
        const typeId = Number(serviceValue.type_id);
        if (!Number.isFinite(typeId)) continue;
        const eventKey = `${accrualId}:POSTING_DELIVERY:${typeId}:${ordinal}:${sku}`;
        const thisOrdinal = ordinal;
        ordinal += 1;
        if (seen.has(eventKey)) continue;
        seen.add(eventKey);
        eventKeys.push(eventKey);
        const accrued = money(serviceValue.accrued);
        if (typeId === 71) {
          type71Components.push({
            accrualId: accrualIdRaw,
            ordinal: thisOrdinal,
            groupKey: ozonType71GroupKey({ date: day, unitNumber, sku }),
          });
          pendingFees.push({
            sku,
            category: null,
            typeId,
            accrualId: accrualIdRaw,
            ordinal: thisOrdinal,
            accrued,
            eventKey,
            unitNumber,
            day,
          });
        } else {
          const category =
            OZON_ACCRUAL_TYPE_CATEGORY.get(typeId) ??
            "OZON_UNCLASSIFIED_ADJUSTMENT";
          pendingFees.push({
            sku,
            category,
            typeId,
            accrualId: accrualIdRaw,
            ordinal: thisOrdinal,
            accrued,
            eventKey,
            unitNumber,
            day,
          });
        }
      }
    }

    const itemFees = isRecord(value.item_fees) ? value.item_fees : null;
    for (const itemValue of toArray(itemFees?.fees)) {
      if (!isRecord(itemValue)) continue;
      const sku = String(itemValue.sku ?? "").trim() || null;
      for (const feeValue of toArray(itemValue.fees)) {
        if (!isRecord(feeValue)) continue;
        const typeId = Number(feeValue.type_id);
        if (!Number.isFinite(typeId)) continue;
        const eventKey = `${accrualId}:ITEM_FEE:${typeId}:${ordinal}:${sku ?? ""}`;
        const thisOrdinal = ordinal;
        ordinal += 1;
        if (seen.has(eventKey)) continue;
        seen.add(eventKey);
        eventKeys.push(eventKey);
        const accrued = money(feeValue.accrued);
        if (typeId === 71) {
          type71Components.push({
            accrualId: accrualIdRaw,
            ordinal: thisOrdinal,
            groupKey: ozonType71GroupKey({ date: day, unitNumber, sku }),
          });
          pendingFees.push({
            sku,
            category: null,
            typeId,
            accrualId: accrualIdRaw,
            ordinal: thisOrdinal,
            accrued,
            eventKey,
            unitNumber,
            day,
          });
        } else {
          const category =
            OZON_ACCRUAL_TYPE_CATEGORY.get(typeId) ??
            "OZON_UNCLASSIFIED_ADJUSTMENT";
          pendingFees.push({
            sku,
            category,
            typeId,
            accrualId: accrualIdRaw,
            ordinal: thisOrdinal,
            accrued,
            eventKey,
            unitNumber,
            day,
          });
        }
      }
    }

    const nonItem = isRecord(value.non_item_fee) ? value.non_item_fee : null;
    if (nonItem) {
      const directTypeId = Number(nonItem.type_id);
      if (Number.isFinite(directTypeId)) {
        const eventKey = `${accrualId}:NON_ITEM_FEE:${directTypeId}:0:`;
        if (!seen.has(eventKey)) {
          seen.add(eventKey);
          eventKeys.push(eventKey);
          const category =
            OZON_ACCRUAL_TYPE_CATEGORY.get(directTypeId) ??
            "OZON_UNCLASSIFIED_ADJUSTMENT";
          pendingFees.push({
            sku: null,
            category,
            typeId: directTypeId,
            accrualId: accrualIdRaw,
            ordinal: 0,
            accrued: money(nonItem.accrued),
            eventKey,
            unitNumber,
            day,
          });
        }
      } else {
        for (const feeValue of toArray(nonItem.fees)) {
          if (!isRecord(feeValue)) continue;
          const typeId = Number(feeValue.type_id);
          if (!Number.isFinite(typeId)) continue;
          const eventKey = `${accrualId}:NON_ITEM_FEE:${typeId}:${ordinal}:`;
          const thisOrdinal = ordinal;
          ordinal += 1;
          if (seen.has(eventKey)) continue;
          seen.add(eventKey);
          eventKeys.push(eventKey);
          const category =
            OZON_ACCRUAL_TYPE_CATEGORY.get(typeId) ??
            "OZON_UNCLASSIFIED_ADJUSTMENT";
          pendingFees.push({
            sku: null,
            category,
            typeId,
            accrualId: accrualIdRaw,
            ordinal: thisOrdinal,
            accrued: money(feeValue.accrued),
            eventKey,
            unitNumber,
            day,
          });
        }
      }
    }
  }

  const type71Cats = resolveOzonType71Categories(type71Components);

  for (const fee of pendingFees) {
    let category = fee.category;
    if (fee.typeId === 71) {
      category =
        type71Cats.get(`${fee.accrualId}:${fee.ordinal}`) ??
        "OZON_UNCLASSIFIED_ADJUSTMENT";
    }
    if (!category) category = "OZON_UNCLASSIFIED_ADJUSTMENT";
    const bucket = fee.sku ? ensureBucket(bySku, fee.sku) : null;
    addExpense(bucket, accountResidual, category, fee.accrued);
    if (bucket) {
      bucket.eventCount += 1;
      const id = String(fee.accrualId);
      if (!bucket.sourceAccrualIds.includes(id)) bucket.sourceAccrualIds.push(id);
    }
  }

  return { bySku, accountResidual, eventKeys };
}

export function mergeOzonExactSkuFeeLedgers(
  ledgers: OzonExactSkuFeeLedger[],
): OzonExactSkuFeeLedger {
  const seen = new Set<string>();
  const bySku = new Map<string, OzonExactSkuFeeBucket>();
  const accountResidual = {
    commission: 0,
    logistics: 0,
    partnerServices: 0,
    otherServices: 0,
    compensation: 0,
    unclassified: 0,
  };
  const eventKeys: string[] = [];

  for (const ledger of ledgers) {
    for (const key of ledger.eventKeys) {
      if (seen.has(key)) continue;
      seen.add(key);
      eventKeys.push(key);
    }
    for (const [sku, bucket] of ledger.bySku) {
      const target = ensureBucket(bySku, sku);
      target.revenue += bucket.revenue;
      target.discountPoints += bucket.discountPoints;
      target.partnerPrograms += bucket.partnerPrograms;
      target.commission += bucket.commission;
      target.logistics += bucket.logistics;
      target.partnerServices += bucket.partnerServices;
      target.otherServices += bucket.otherServices;
      target.compensation += bucket.compensation;
      target.eventCount += bucket.eventCount;
      for (const id of bucket.sourceAccrualIds) {
        if (!target.sourceAccrualIds.includes(id)) target.sourceAccrualIds.push(id);
      }
    }
    accountResidual.commission += ledger.accountResidual.commission;
    accountResidual.logistics += ledger.accountResidual.logistics;
    accountResidual.partnerServices += ledger.accountResidual.partnerServices;
    accountResidual.otherServices += ledger.accountResidual.otherServices;
    accountResidual.compensation += ledger.accountResidual.compensation;
    accountResidual.unclassified += ledger.accountResidual.unclassified;
  }

  return { bySku, accountResidual, eventKeys };
}
