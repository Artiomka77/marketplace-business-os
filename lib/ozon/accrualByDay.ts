export type OzonFinancialCategory =
  | "OZON_COMMISSION"
  | "OZON_DELIVERY"
  | "OZON_FBO"
  | "OZON_ADVERTISING"
  | "OZON_PARTNER_SERVICES"
  | "OZON_OTHER_SERVICES"
  | "OZON_COMPENSATION"
  | "EXCLUDED_LOANS_FACTORING"
  | "EXCLUDED_CREDIT"
  | "EXCLUDED_TRANSFER";

export type OzonAccrualTypeDefinition = {
  id: number;
  name: string | null;
  description: string | null;
};

export type OzonAccrualApiCredentials = {
  clientId: string;
  apiKey: string;
};

export type OzonAccrualApiCallLog = {
  endpoint: string;
  requestBody: Record<string, unknown>;
  attempt: number;
  httpStatus: number | null;
  ok: boolean;
  retryAfter: string | null;
  responseBodySha256: string;
  responseBodyBytes: number;
};

export type OzonAccrualByDayFact = {
  eventKey: string;
  accrualId: number;
  date: string;
  unitNumber: string | null;
  sku: string | null;
  sourceKind: "ITEM_FEE" | "NON_ITEM_FEE" | "POSTING_DELIVERY" | "COMMISSION";
  sourceTypeId: number | null;
  sourceTypeName: string | null;
  sourceTypeDescription: string | null;
  category: OzonFinancialCategory;
  amount: number;
  includeInProfit: boolean;
  isCashFlowOnly: boolean;
  isCompensation: boolean;
};

export type OzonAccrualByDayDailyResult = {
  date: string;
  totalReportAmount: number;
  economicTurnover: number;
  taxableRevenue: number;
  discountPointsAmount: number;
  partnerProgramsAmount: number;
  grossOzonExpenses: number;
  categoryAmounts: Record<string, number>;
  factsRows: number;
};

export type OzonAccrualApiDayEnvelope = {
  date: string;
  httpOk: boolean;
  pages: number;
  paginationComplete: boolean;
  rawAccrualCount: number;
  explicitZeroDayEvidence: boolean;
};

export type OzonAccrualApiCoverage = {
  envelopeComplete: boolean;
  coverageComplete: boolean;
  emptyUnconfirmedDates: string[];
  missingEvidence: string[];
};

export type OzonAccrualByDayResult = {
  mapperComplete: boolean;
  coverageComplete: boolean;
  days: OzonAccrualByDayDailyResult[];
  totals: OzonAccrualByDayDailyResult;
  facts: OzonAccrualByDayFact[];
  diagnostics: {
    accrualRows: number;
    factsRows: number;
    ignoredZeroComponents: number;
    type71Rows: number;
    type71Groups: number;
    type71PairedGroups: number;
    type71SingleGroups: number;
    unresolvedType71Groups: Array<{
      key: string;
      accrualIds: number[];
      amounts: number[];
    }>;
    unknownMeaningfulTypeIds: Array<{
      typeId: number;
      rows: number;
      amount: number;
      name: string | null;
      description: string | null;
    }>;
    grossExpenseDifference: number;
    dailyGrossExpenseDifferences: Array<{ date: string; difference: number }>;
    apiCoverage: OzonAccrualApiCoverage | null;
  };
};

export function evaluateOzonAccrualCoverage(input: {
  requestedDates: string[];
  dayEnvelopes: OzonAccrualApiDayEnvelope[];
  mapperComplete: boolean;
}): OzonAccrualApiCoverage {
  const missingEvidence: string[] = [];
  const emptyUnconfirmedDates: string[] = [];
  const byDate = new Map(input.dayEnvelopes.map((day) => [day.date, day]));

  for (const date of input.requestedDates) {
    const envelope = byDate.get(date);
    if (!envelope) {
      missingEvidence.push(`MISSING_API_ENVELOPE:${date}`);
      continue;
    }
    if (!envelope.httpOk) missingEvidence.push(`API_HTTP_NOT_OK:${date}`);
    if (envelope.pages < 1) missingEvidence.push(`NO_API_PAGES:${date}`);
    if (!envelope.paginationComplete) {
      missingEvidence.push(`PAGINATION_INCOMPLETE:${date}`);
    }
    if (envelope.rawAccrualCount === 0 && !envelope.explicitZeroDayEvidence) {
      emptyUnconfirmedDates.push(date);
      missingEvidence.push(`EMPTY_DAY_UNCONFIRMED:${date}`);
    }
  }

  const envelopeComplete = missingEvidence.length === 0;
  return {
    envelopeComplete,
    coverageComplete: input.mapperComplete && envelopeComplete,
    emptyUnconfirmedDates,
    missingEvidence,
  };
}

type UnknownRecord = Record<string, unknown>;

type FeeComponent = {
  accrualId: number;
  date: string;
  unitNumber: string | null;
  sku: string | null;
  sourceKind: "ITEM_FEE" | "NON_ITEM_FEE" | "POSTING_DELIVERY";
  typeId: number;
  amountCents: number;
  ordinal: number;
};

type InternalDay = {
  date: string;
  totalReportCents: number;
  economicTurnoverCents: number;
  taxableRevenueCents: number;
  discountPointsCents: number;
  partnerProgramsCents: number;
  categoryCents: Map<string, number>;
  factsRows: number;
};

const API_BASE = "https://api-seller.ozon.ru";
const MIN_MEANINGFUL_CENTS = 1;
const DEFAULT_MIN_CALL_INTERVAL_MS = 12_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_MAX_PAGES_PER_DAY = 20;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const BACKOFF_MS = [15_000, 30_000, 60_000, 90_000, 120_000, 150_000];

// Mapping proven against official Ozon accrual Excel for 03-09.08.2026 and
// historical SellerReturns samples from June-July 2026. Text descriptions
// from /types are retained as audit metadata; type_id is the primary key.
const TYPE_CATEGORY = new Map<number, OzonFinancialCategory>([
  [41, "OZON_ADVERTISING"],
  // typeId 48 = PremiumCashbackIndividualPoints («Бонусы продавца»).
  // Exact Petrov event accrual_id=61738770292 / 2026-09-02 / -15.39 RUB / sku=1852662537.
  // Legacy OzonFinance EXACT_MATCH operationType=«Бонусы продавца». Official Premium*
  // family siblings 52/54 already map to OZON_ADVERTISING. Evidence:
  // AVOROFIN_OZON_TYPE48_SEMANTIC_CLOSURE + this preprod package.
  [48, "OZON_ADVERTISING"],
  [54, "OZON_ADVERTISING"],
  [1, "OZON_PARTNER_SERVICES"],
  [39, "OZON_PARTNER_SERVICES"],
  [45, "OZON_PARTNER_SERVICES"],
  [74, "OZON_PARTNER_SERVICES"],
  [79, "OZON_PARTNER_SERVICES"],
  [15, "OZON_OTHER_SERVICES"],
  [18, "OZON_OTHER_SERVICES"],
  [20, "OZON_OTHER_SERVICES"],
  [38, "OZON_OTHER_SERVICES"],
  [78, "OZON_OTHER_SERVICES"],
  // typeId 76 = PRODUCT_INSURANCE («Страхование товара от массовых повреждений»).
  // Amount policy: DYNAMIC_SOURCE_AMOUNT. Ingest the exact Ozon operation/day
  // amount. Never hardcode a premium, never compute from stock/goods value,
  // and never treat Seller UI rounding as the source of truth.
  // Evidence: Petrov Insurance page 2026-08-23 UI-rounds the premium to 1,912 RUB
  // while raw Excel/API may keep kopecks (historical charge −1,911.55). 2026-08-24
  // UI premium 1,918 RUB shows the charge is dynamic. Economics grouped cards
  // (e.g. «Иные услуги и штрафы») are supporting evidence only and must not be
  // forced to equal the insurance premium. Canonical category remains
  // OZON_OTHER_SERVICES: not advertising, commission, logistics, or taxable
  // revenue. Unknown meaningful type IDs stay fail-closed.
  [76, "OZON_OTHER_SERVICES"],
  [52, "OZON_ADVERTISING"],
  [12, "OZON_FBO"],
  [46, "OZON_FBO"],
  [77, "OZON_FBO"],
  [29, "OZON_DELIVERY"],
  [32, "OZON_DELIVERY"],
  [59, "OZON_DELIVERY"],
  [98, "OZON_DELIVERY"],
  // typeId 17 = Drop-Off Agent («Обработка отправления Drop-off партнёрами»).
  // Live /v1/finance/accrual/types + Petrov 2026-09-06: 100% posting.delivery.services
  // (POSTING_DELIVERY_SERVICE), FBS. Same structural channel as Logistic/LastMile.
  // Canonical: OZON_DELIVERY. Evidence package: ozon-type-17-94-semantic-20260907.
  [17, "OZON_DELIVERY"],
  // typeId 94 = DefectFineShipmentDelayRate («Отгрузка в нерекомендованный слот»).
  // Live /types + Petrov 2026-09-06: 100% NON_ITEM_FEE seller defect fine.
  // Canonical: OZON_OTHER_SERVICES (fines/misc with 15/76/78). Not ads/commission/tax.
  [94, "OZON_OTHER_SERVICES"],
  [25, "OZON_COMPENSATION"],
]);

let lastApiCallAt = 0;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(String(value ?? ""));
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
  return parsed;
}

function toText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function decimalToCents(value: unknown): number {
  const raw = isRecord(value) ? value.amount : value;

  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return 0;
    return Math.round(raw * 100);
  }

  let text = String(raw ?? "").trim().replace(/\s+/g, "").replace(",", ".");
  if (!text) return 0;

  let sign = 1;
  if (text.startsWith("-")) {
    sign = -1;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }

  if (!/^\d+(?:\.\d+)?$/.test(text)) return 0;

  const [whole, fraction = ""] = text.split(".");
  const firstThree = `${fraction}000`.slice(0, 3);
  let cents = Number(whole) * 100 + Number(firstThree.slice(0, 2));
  if (Number(firstThree[2]) >= 5) cents += 1;
  return sign * cents;
}

function centsToMoney(cents: number): number {
  return cents / 100;
}

function getMoney(record: UnknownRecord, key: string): number {
  return decimalToCents(record[key]);
}

/**
 * Settlement-consistent economic turnover for gross expense reconciliation.
 *
 * Ozon /by-day commission objects expose:
 * - sale_amount: settlement basis (matches sale_price + bonus + coinvestment;
 *   commission_ratio applies to this base)
 * - seller_price: may diverge from sale_amount on rare rows
 *
 * API gross expenses are economicTurnover - total_amount. Using seller_price
 * when it understates sale_amount creates a false positive overmap
 * (Petrov 2026-09-06: seller_price 7413 vs sale_amount 14826 -> +7413
 * grossExpenseDifference while categorized fee/commission facts still match
 * settlement). Prefer sale_amount; else reconstruct from components.
 */
function settlementTurnoverCents(commission: UnknownRecord): number {
  if (commission.sale_amount != null) {
    return getMoney(commission, "sale_amount");
  }
  return (
    getMoney(commission, "sale_price") +
    getMoney(commission, "bonus") +
    getMoney(commission, "coinvestment")
  );
}

function categoryFlags(category: OzonFinancialCategory) {
  const excluded = category.startsWith("EXCLUDED_");
  return {
    includeInProfit: !excluded,
    isCashFlowOnly: excluded,
    isCompensation: category === "OZON_COMPENSATION",
  };
}

function add(map: Map<string, number>, key: string, cents: number) {
  map.set(key, (map.get(key) ?? 0) + cents);
}

function groupKey(component: FeeComponent) {
  return `${component.date}\u001f${component.unitNumber ?? ""}\u001f${component.sku ?? ""}`;
}

function extractFeeComponents(accrual: UnknownRecord): FeeComponent[] {
  const accrualId = toInteger(accrual.accrual_id);
  const date = toText(accrual.date);
  if (accrualId === null || !date) return [];

  const unitNumber = toText(accrual.unit_number);
  const result: FeeComponent[] = [];
  let ordinal = 0;

  const itemFees = isRecord(accrual.item_fees) ? accrual.item_fees : null;
  for (const itemValue of toArray(itemFees?.fees)) {
    if (!isRecord(itemValue)) continue;
    const sku = toText(itemValue.sku);
    for (const feeValue of toArray(itemValue.fees)) {
      if (!isRecord(feeValue)) continue;
      const typeId = toInteger(feeValue.type_id);
      if (typeId === null) continue;
      result.push({
        accrualId,
        date,
        unitNumber,
        sku,
        sourceKind: "ITEM_FEE",
        typeId,
        amountCents: decimalToCents(feeValue.accrued),
        ordinal: ordinal++,
      });
    }
  }

  const nonItemFee = isRecord(accrual.non_item_fee) ? accrual.non_item_fee : null;
  if (nonItemFee) {
    const directTypeId = toInteger(nonItemFee.type_id);
    if (directTypeId !== null) {
      result.push({
        accrualId,
        date,
        unitNumber,
        sku: null,
        sourceKind: "NON_ITEM_FEE",
        typeId: directTypeId,
        amountCents: decimalToCents(nonItemFee.accrued),
        ordinal: ordinal++,
      });
    } else {
      for (const feeValue of toArray(nonItemFee.fees)) {
        if (!isRecord(feeValue)) continue;
        const typeId = toInteger(feeValue.type_id);
        if (typeId === null) continue;
        result.push({
          accrualId,
          date,
          unitNumber,
          sku: null,
          sourceKind: "NON_ITEM_FEE",
          typeId,
          amountCents: decimalToCents(feeValue.accrued),
          ordinal: ordinal++,
        });
      }
    }
  }

  const posting = isRecord(accrual.posting) ? accrual.posting : null;
  for (const productValue of toArray(posting?.products)) {
    if (!isRecord(productValue)) continue;
    const sku = toText(productValue.sku);
    const delivery = isRecord(productValue.delivery) ? productValue.delivery : null;
    for (const serviceValue of toArray(delivery?.services)) {
      if (!isRecord(serviceValue)) continue;
      const typeId = toInteger(serviceValue.type_id);
      if (typeId === null) continue;
      result.push({
        accrualId,
        date,
        unitNumber,
        sku,
        sourceKind: "POSTING_DELIVERY",
        typeId,
        amountCents: decimalToCents(serviceValue.accrued),
        ordinal: ordinal++,
      });
    }
  }

  return result;
}

function createFact(params: {
  component: FeeComponent;
  category: OzonFinancialCategory;
  typeDefinitions: Map<number, OzonAccrualTypeDefinition>;
}): OzonAccrualByDayFact {
  const { component, category, typeDefinitions } = params;
  const type = typeDefinitions.get(component.typeId);
  const signedExpenseCents =
    category === "OZON_COMPENSATION"
      ? component.amountCents
      : -component.amountCents;

  return {
    eventKey: `${component.accrualId}:${component.sourceKind}:${component.typeId}:${component.ordinal}`,
    accrualId: component.accrualId,
    date: component.date,
    unitNumber: component.unitNumber,
    sku: component.sku,
    sourceKind: component.sourceKind,
    sourceTypeId: component.typeId,
    sourceTypeName: toText(type?.name),
    sourceTypeDescription: toText(type?.description),
    category,
    amount: centsToMoney(signedExpenseCents),
    ...categoryFlags(category),
  };
}

function emptyDay(date: string): InternalDay {
  return {
    date,
    totalReportCents: 0,
    economicTurnoverCents: 0,
    taxableRevenueCents: 0,
    discountPointsCents: 0,
    partnerProgramsCents: 0,
    categoryCents: new Map<string, number>(),
    factsRows: 0,
  };
}

export function mapOzonAccrualByDay(params: {
  accruals: unknown[];
  accrualTypes?: OzonAccrualTypeDefinition[];
  requestedDates?: string[];
  dayEnvelopes?: OzonAccrualApiDayEnvelope[];
}): OzonAccrualByDayResult {
  const accrualTypes = params.accrualTypes ?? [];
  const typeDefinitions = new Map<number, OzonAccrualTypeDefinition>(
    accrualTypes.map((item) => [item.id, item])
  );
  const days = new Map<string, InternalDay>();
  const components: FeeComponent[] = [];
  const commissionFacts: OzonAccrualByDayFact[] = [];
  let ignoredZeroComponents = 0;

  for (const value of params.accruals) {
    if (!isRecord(value)) continue;
    const accrualId = toInteger(value.accrual_id);
    const date = toText(value.date);
    if (accrualId === null || !date) continue;

    const day = days.get(date) ?? emptyDay(date);
    days.set(date, day);
    day.totalReportCents += decimalToCents(value.total_amount);
    components.push(...extractFeeComponents(value));

    const posting = isRecord(value.posting) ? value.posting : null;
    for (const productValue of toArray(posting?.products)) {
      if (!isRecord(productValue)) continue;
      const commission = isRecord(productValue.commission)
        ? productValue.commission
        : null;
      if (!commission) continue;

      day.economicTurnoverCents += settlementTurnoverCents(commission);
      day.taxableRevenueCents += getMoney(commission, "sale_price");
      day.discountPointsCents += getMoney(commission, "bonus");
      day.partnerProgramsCents += getMoney(commission, "coinvestment");

      const commissionCents = getMoney(commission, "commission");
      if (Math.abs(commissionCents) < MIN_MEANINGFUL_CENTS) {
        ignoredZeroComponents += 1;
        continue;
      }

      commissionFacts.push({
        eventKey: `${accrualId}:COMMISSION:${toText(productValue.sku) ?? ""}`,
        accrualId,
        date,
        unitNumber: toText(value.unit_number),
        sku: toText(productValue.sku),
        sourceKind: "COMMISSION",
        sourceTypeId: null,
        sourceTypeName: "SaleCommission",
        sourceTypeDescription: "Вознаграждение за продажу",
        category: "OZON_COMMISSION",
        amount: centsToMoney(-commissionCents),
        ...categoryFlags("OZON_COMMISSION"),
      });
    }
  }

  const meaningfulComponents = components.filter((component) => {
    if (Math.abs(component.amountCents) < MIN_MEANINGFUL_CENTS) {
      ignoredZeroComponents += 1;
      return false;
    }
    return true;
  });

  const type71 = meaningfulComponents.filter((component) => component.typeId === 71);
  const type71Groups = new Map<string, FeeComponent[]>();
  for (const component of type71) {
    const key = groupKey(component);
    const group = type71Groups.get(key) ?? [];
    group.push(component);
    type71Groups.set(key, group);
  }

  const type71Category = new Map<string, OzonFinancialCategory>();
  const unresolvedType71Groups: Array<{
    key: string;
    accrualIds: number[];
    amounts: number[];
  }> = [];
  let type71PairedGroups = 0;
  let type71SingleGroups = 0;

  for (const [key, group] of type71Groups) {
    if (group.length === 1) {
      type71SingleGroups += 1;
      const item = group[0];
      type71Category.set(`${item.accrualId}:${item.ordinal}`, "OZON_DELIVERY");
      continue;
    }

    const distinctIds = new Set(group.map((item) => item.accrualId));
    if (group.length === 2 && distinctIds.size === 2) {
      type71PairedGroups += 1;
      const ordered = [...group].sort((left, right) => left.accrualId - right.accrualId);
      type71Category.set(`${ordered[0].accrualId}:${ordered[0].ordinal}`, "OZON_FBO");
      type71Category.set(`${ordered[1].accrualId}:${ordered[1].ordinal}`, "OZON_DELIVERY");
      continue;
    }

    unresolvedType71Groups.push({
      key,
      accrualIds: group.map((item) => item.accrualId),
      amounts: group.map((item) => centsToMoney(item.amountCents)),
    });
  }

  const unknownByType = new Map<number, { rows: number; cents: number }>();
  const feeFacts: OzonAccrualByDayFact[] = [];

  for (const component of meaningfulComponents) {
    const category =
      component.typeId === 71
        ? type71Category.get(`${component.accrualId}:${component.ordinal}`)
        : TYPE_CATEGORY.get(component.typeId);

    if (!category) {
      const unknown = unknownByType.get(component.typeId) ?? { rows: 0, cents: 0 };
      unknown.rows += 1;
      unknown.cents += component.amountCents;
      unknownByType.set(component.typeId, unknown);
      continue;
    }

    feeFacts.push(createFact({ component, category, typeDefinitions }));
  }

  const facts = [...feeFacts, ...commissionFacts];
  for (const fact of facts) {
    const day = days.get(fact.date) ?? emptyDay(fact.date);
    days.set(fact.date, day);
    add(day.categoryCents, fact.category, Math.round(fact.amount * 100));
    day.factsRows += 1;
  }

  const dayResults: OzonAccrualByDayDailyResult[] = [];
  const dailyGrossExpenseDifferences: Array<{ date: string; difference: number }> = [];

  for (const day of [...days.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    const grossFromCategories = [...day.categoryCents.entries()].reduce(
      (sum, [category, cents]) =>
        sum + (category === "OZON_COMPENSATION" ? -cents : cents),
      0
    );
    const canonicalGross = day.economicTurnoverCents - day.totalReportCents;
    const difference = grossFromCategories - canonicalGross;
    if (Math.abs(difference) >= MIN_MEANINGFUL_CENTS) {
      dailyGrossExpenseDifferences.push({
        date: day.date,
        difference: centsToMoney(difference),
      });
    }

    dayResults.push({
      date: day.date,
      totalReportAmount: centsToMoney(day.totalReportCents),
      economicTurnover: centsToMoney(day.economicTurnoverCents),
      taxableRevenue: centsToMoney(day.taxableRevenueCents),
      discountPointsAmount: centsToMoney(day.discountPointsCents),
      partnerProgramsAmount: centsToMoney(day.partnerProgramsCents),
      grossOzonExpenses: centsToMoney(canonicalGross),
      categoryAmounts: Object.fromEntries(
        [...day.categoryCents.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, cents]) => [key, centsToMoney(cents)])
      ),
      factsRows: day.factsRows,
    });
  }

  const totalCategoryCents = new Map<string, number>();
  let totalReportCents = 0;
  let economicTurnoverCents = 0;
  let taxableRevenueCents = 0;
  let discountPointsCents = 0;
  let partnerProgramsCents = 0;
  let factsRows = 0;

  for (const day of days.values()) {
    totalReportCents += day.totalReportCents;
    economicTurnoverCents += day.economicTurnoverCents;
    taxableRevenueCents += day.taxableRevenueCents;
    discountPointsCents += day.discountPointsCents;
    partnerProgramsCents += day.partnerProgramsCents;
    factsRows += day.factsRows;
    for (const [category, cents] of day.categoryCents) {
      add(totalCategoryCents, category, cents);
    }
  }

  const grossOzonExpensesCents = economicTurnoverCents - totalReportCents;
  const grossFromFactsCents = [...totalCategoryCents.entries()].reduce(
    (sum, [category, cents]) =>
      sum + (category === "OZON_COMPENSATION" ? -cents : cents),
    0
  );
  const grossExpenseDifferenceCents = grossFromFactsCents - grossOzonExpensesCents;

  const unknownMeaningfulTypeIds = [...unknownByType.entries()]
    .sort(([left], [right]) => left - right)
    .map(([typeId, value]) => ({
      typeId,
      rows: value.rows,
      amount: centsToMoney(value.cents),
      name: toText(typeDefinitions.get(typeId)?.name),
      description: toText(typeDefinitions.get(typeId)?.description),
    }));

  const mapperComplete =
    unresolvedType71Groups.length === 0 &&
    unknownMeaningfulTypeIds.length === 0 &&
    dailyGrossExpenseDifferences.length === 0 &&
    Math.abs(grossExpenseDifferenceCents) < MIN_MEANINGFUL_CENTS;

  const apiCoverage =
    params.dayEnvelopes || params.requestedDates
      ? evaluateOzonAccrualCoverage({
          requestedDates: params.requestedDates ?? [...days.keys()].sort(),
          dayEnvelopes: params.dayEnvelopes ?? [],
          mapperComplete,
        })
      : null;

  const coverageComplete = apiCoverage
    ? apiCoverage.coverageComplete
    : mapperComplete;

  return {
    mapperComplete,
    coverageComplete,
    days: dayResults,
    totals: {
      date: "TOTAL",
      totalReportAmount: centsToMoney(totalReportCents),
      economicTurnover: centsToMoney(economicTurnoverCents),
      taxableRevenue: centsToMoney(taxableRevenueCents),
      discountPointsAmount: centsToMoney(discountPointsCents),
      partnerProgramsAmount: centsToMoney(partnerProgramsCents),
      grossOzonExpenses: centsToMoney(grossOzonExpensesCents),
      categoryAmounts: Object.fromEntries(
        [...totalCategoryCents.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, cents]) => [key, centsToMoney(cents)])
      ),
      factsRows,
    },
    facts,
    diagnostics: {
      accrualRows: params.accruals.length,
      factsRows,
      ignoredZeroComponents,
      type71Rows: type71.length,
      type71Groups: type71Groups.size,
      type71PairedGroups,
      type71SingleGroups,
      unresolvedType71Groups,
      unknownMeaningfulTypeIds,
      grossExpenseDifference: centsToMoney(grossExpenseDifferenceCents),
      dailyGrossExpenseDifferences,
      apiCoverage,
    },
  };
}

function dateList(dateFrom: string, dateTo: string) {
  const result: string[] = [];
  let current = new Date(`${dateFrom}T00:00:00.000Z`);
  const end = new Date(`${dateTo}T00:00:00.000Z`);

  if (Number.isNaN(current.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("Invalid Ozon accrual date range");
  }
  if (current.getTime() > end.getTime()) {
    throw new Error("Ozon accrual dateFrom cannot be after dateTo");
  }

  while (current <= end) {
    result.push(current.toISOString().slice(0, 10));
    current = new Date(current.getTime() + 86_400_000);
  }
  return result;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response: Response | null) {
  const header = response?.headers.get("retry-after");
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

async function sha256Text(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function beforeApiCall(minCallIntervalMs: number) {
  const wait = Math.max(0, lastApiCallAt + minCallIntervalMs - Date.now());
  if (wait > 0) await sleep(wait);
}

async function apiPost(params: {
  credentials: OzonAccrualApiCredentials;
  endpoint: string;
  body: Record<string, unknown>;
  minCallIntervalMs: number;
  requestTimeoutMs: number;
  maxAttempts: number;
  retryBackoffMs: number[];
  onCall?: (call: OzonAccrualApiCallLog) => void;
}) {
  let lastStatus: number | null = null;
  let lastError = "";

  for (let attempt = 1; attempt <= params.maxAttempts; attempt += 1) {
    await beforeApiCall(params.minCallIntervalMs);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), params.requestTimeoutMs);
    let response: Response | null = null;
    let bodyText = "";
    let parsed: unknown = null;
    let error = "";

    try {
      response = await fetch(`${API_BASE}${params.endpoint}`, {
        method: "POST",
        headers: {
          "Client-Id": params.credentials.clientId,
          "Api-Key": params.credentials.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(params.body),
        cache: "no-store",
        signal: controller.signal,
      });
      bodyText = await response.text();
      try {
        parsed = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        parsed = null;
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      clearTimeout(timeout);
      lastApiCallAt = Date.now();
    }

    const status = response?.status ?? null;
    lastStatus = status;
    lastError = error || bodyText.slice(0, 1000);

    const call: OzonAccrualApiCallLog = {
      endpoint: params.endpoint,
      requestBody: params.body,
      attempt,
      httpStatus: status,
      ok: Boolean(response?.ok && parsed !== null),
      retryAfter: response?.headers.get("retry-after") ?? null,
      responseBodySha256: await sha256Text(bodyText),
      responseBodyBytes: new TextEncoder().encode(bodyText).byteLength,
    };
    params.onCall?.(call);

    if (call.ok) return parsed;

    const retryable = Boolean(error) || RETRYABLE_STATUS.has(status ?? 0);
    if (!retryable || attempt === params.maxAttempts) break;

    const wait = Math.max(
      retryAfterMs(response),
      params.retryBackoffMs[Math.min(attempt - 1, params.retryBackoffMs.length - 1)]
    );
    await sleep(wait);
  }

  throw new Error(
    `Ozon accrual API failed: ${params.endpoint} HTTP ${lastStatus ?? "network"} ${lastError}`.slice(
      0,
      1600
    )
  );
}

export async function fetchOzonAccrualByDayRange(params: {
  credentials: OzonAccrualApiCredentials;
  dateFrom: string;
  dateTo: string;
  minCallIntervalMs?: number;
  requestTimeoutMs?: number;
  maxAttempts?: number;
  maxPagesPerDay?: number;
  retryBackoffMs?: number[];
  onCall?: (call: OzonAccrualApiCallLog) => void;
}) {
  const minCallIntervalMs = params.minCallIntervalMs ?? DEFAULT_MIN_CALL_INTERVAL_MS;
  const requestTimeoutMs = params.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxAttempts = params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxPagesPerDay = params.maxPagesPerDay ?? DEFAULT_MAX_PAGES_PER_DAY;
  const retryBackoffMs =
    params.retryBackoffMs && params.retryBackoffMs.length > 0
      ? params.retryBackoffMs
      : BACKOFF_MS;

  const accruals: unknown[] = [];
  const pagesByDay: Record<string, number> = {};
  const requestedDates = dateList(params.dateFrom, params.dateTo);
  const dayEnvelopes: OzonAccrualApiDayEnvelope[] = [];

  for (const date of requestedDates) {
    let lastId: string | null = null;
    let page = 0;
    const seen = new Set<string>();
    const startCount = accruals.length;

    while (page < maxPagesPerDay) {
      page += 1;
      const body: Record<string, unknown> = lastId ? { date, last_id: lastId } : { date };
      const rawPage = await apiPost({
        credentials: params.credentials,
        endpoint: "/v1/finance/accrual/by-day",
        body,
        minCallIntervalMs,
        requestTimeoutMs,
        maxAttempts,
        retryBackoffMs,
        onCall: params.onCall,
      });
      const pageRecord = isRecord(rawPage) ? rawPage : {};
      const rows = toArray(pageRecord.accruals);
      accruals.push(...rows);

      const next = toText(pageRecord.last_id);
      if (!next || rows.length === 0) {
        lastId = null;
        break;
      }
      if (seen.has(next) || next === lastId) {
        throw new Error(`Ozon accrual pagination repeated last_id for ${date}: ${next}`);
      }
      seen.add(next);
      lastId = next;
    }

    if (page >= maxPagesPerDay && lastId) {
      throw new Error(`Ozon accrual pagination limit exceeded for ${date}`);
    }
    pagesByDay[date] = page;
    dayEnvelopes.push({
      date,
      httpOk: true,
      pages: page,
      paginationComplete: lastId === null,
      rawAccrualCount: accruals.length - startCount,
      explicitZeroDayEvidence: false,
    });
  }

  return {
    accruals,
    pagesByDay,
    requestedDates,
    dayEnvelopes,
  };
}
