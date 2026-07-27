export type FinanceProfitTreatment =
  | "AUTO"
  | "INCLUDE_IN_NET_PROFIT"
  | "CASH_ONLY"
  | "CREDIT_PRINCIPAL"
  | "CREDIT_INTEREST"
  | "CREDIT_RECEIVED"
  | "OWNER_WITHDRAWAL"
  | "IGNORE";

export type FinanceCategoryForMetrics = {
  name: string;
  categoryType: string;
  parentName?: string | null;
  profitTreatment?: string | null;
};

export type FinanceTransactionForMetrics = {
  operationType: string;
  category: string;
  amount: unknown;
  subcategory?: string | null;
  isInternalTransfer?: boolean | null;
  transferDirection?: string | null;
};

export type FinanceMetricsResult = {
  cashIncome: number;
  cashOutflow: number;
  netCashFlow: number;

  transferTotal: number;

  netProfitIncome: number;
  netProfitExpense: number;
  netProfitImpact: number;

  cashOnlyTotal: number;

  creditReceived: number;
  creditPrincipal: number;
  creditInterest: number;

  ownerWithdrawals: number;

  ignoredTotal: number;
};

export type FinanceTreatmentInfo = {
  treatment: FinanceProfitTreatment;
  label: string;
  description: string;
  className: string;
};

const treatmentLabels: Record<FinanceProfitTreatment, string> = {
  AUTO: "Авто",
  INCLUDE_IN_NET_PROFIT: "Чистая прибыль",
  CASH_ONLY: "Только ДДС",
  CREDIT_PRINCIPAL: "Тело кредита",
  CREDIT_INTEREST: "Проценты кредита",
  CREDIT_RECEIVED: "Получение кредита",
  OWNER_WITHDRAWAL: "Вывод собственника",
  IGNORE: "Не учитывать",
};

const treatmentDescriptions: Record<FinanceProfitTreatment, string> = {
  AUTO: "Роль определяется автоматически.",
  INCLUDE_IN_NET_PROFIT: "Участвует в ДДС и чистой прибыли.",
  CASH_ONLY: "Участвует только в ДДС, не влияет на чистую прибыль.",
  CREDIT_PRINCIPAL: "Тело кредита: участвует в ДДС, не влияет на прибыль.",
  CREDIT_INTEREST: "Проценты: участвует в ДДС и уменьшает чистую прибыль.",
  CREDIT_RECEIVED:
    "Получение кредита или займа: увеличивает ДДС, но не является прибылью.",
  OWNER_WITHDRAWAL:
    "Вывод собственника: участвует в ДДС и показателе после вывода.",
  IGNORE: "Не участвует в расчётах.",
};

const treatmentClassNames: Record<FinanceProfitTreatment, string> = {
  AUTO: "bg-slate-50 text-slate-600 ring-slate-200",
  INCLUDE_IN_NET_PROFIT: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  CASH_ONLY: "bg-cyan-50 text-cyan-700 ring-cyan-200",
  CREDIT_PRINCIPAL: "bg-blue-50 text-blue-700 ring-blue-200",
  CREDIT_INTEREST: "bg-violet-50 text-violet-700 ring-violet-200",
  CREDIT_RECEIVED: "bg-sky-50 text-sky-700 ring-sky-200",
  OWNER_WITHDRAWAL: "bg-amber-50 text-amber-700 ring-amber-200",
  IGNORE: "bg-slate-100 text-slate-500 ring-slate-200",
};

function safeNumber(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function normalizeText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/\s+/g, " ")
    .trim();
}

function makeCategoryKey(categoryType: string, categoryName: string) {
  return `${normalizeText(categoryType)}::${normalizeText(categoryName)}`;
}

function isAllowedTreatment(value: unknown): value is FinanceProfitTreatment {
  return (
    value === "AUTO" ||
    value === "INCLUDE_IN_NET_PROFIT" ||
    value === "CASH_ONLY" ||
    value === "CREDIT_PRINCIPAL" ||
    value === "CREDIT_INTEREST" ||
    value === "CREDIT_RECEIVED" ||
    value === "OWNER_WITHDRAWAL" ||
    value === "IGNORE"
  );
}

function looksLikeCreditReceived(params: {
  operationType: string;
  category: string;
  subcategory?: string | null;
  parentName?: string | null;
}) {
  const operationType = normalizeText(params.operationType);
  const text = normalizeText(
    `${params.category} ${params.subcategory ?? ""} ${params.parentName ?? ""}`
  );

  if (
    text.includes("получение кредита") ||
    text.includes("получение займа") ||
    text.includes("получение заема") ||
    text.includes("поступление кредита") ||
    text.includes("поступление займа") ||
    text.includes("поступление заема") ||
    text.includes("кредит получен") ||
    text.includes("займ получен") ||
    text.includes("заем получен")
  ) {
    return true;
  }

  if (
    operationType === "income" &&
    (text.includes("кредит") || text.includes("займ") || text.includes("заем"))
  ) {
    return true;
  }

  return false;
}

function fallbackTreatment(params: {
  operationType: string;
  category: string;
  subcategory?: string | null;
  parentName?: string | null;
}): FinanceProfitTreatment {
  const operationType = normalizeText(params.operationType);
  const text = normalizeText(
    `${params.category} ${params.subcategory ?? ""} ${params.parentName ?? ""}`
  );

  if (operationType === "transfer") return "IGNORE";

  if (looksLikeCreditReceived(params)) {
    return "CREDIT_RECEIVED";
  }

  if (
    operationType === "personal" ||
    text.includes("личн") ||
    text.includes("собственник") ||
    text.includes("вывод") ||
    text.includes("дивиденд")
  ) {
    return "OWNER_WITHDRAWAL";
  }

  if (
    text.includes("процент") &&
    (text.includes("кредит") || text.includes("займ") || text.includes("заем"))
  ) {
    return "CREDIT_INTEREST";
  }

  if (
    text.includes("тело кредита") ||
    text.includes("основной долг") ||
    text.includes("погашение кредита") ||
    text.includes("погашение займа") ||
    text.includes("погашение заема")
  ) {
    return "CREDIT_PRINCIPAL";
  }

  if (operationType === "financing") return "CREDIT_PRINCIPAL";

  if (
    text.includes("фулфил") ||
    text.includes("fulfill") ||
    text.includes("закуп") ||
    text.includes("товар") ||
    text.includes("упаков") ||
    text.includes("доставка до склада") ||
    text.includes("логистика до склада") ||
    text.includes("переупаков") ||
    text.includes("проверка") ||
    text.includes("брак") ||
    text.includes("себестоим") ||
    text.includes("налог") ||
    text.includes("усн") ||
    text.includes("ндс")
  ) {
    return "CASH_ONLY";
  }

  if (
    operationType === "income" &&
    (text.includes("wb") ||
      text.includes("wildberries") ||
      text.includes("вайлдбер") ||
      text.includes("озон") ||
      text.includes("ozon") ||
      text.includes("маркетплейс"))
  ) {
    return "CASH_ONLY";
  }

  if (
    text.includes("банк") ||
    text.includes("комисс") ||
    text.includes("эквайр") ||
    text.includes("обслуживание счета") ||
    text.includes("обслуживание счёта")
  ) {
    return "INCLUDE_IN_NET_PROFIT";
  }

  if (operationType === "expense") return "INCLUDE_IN_NET_PROFIT";
  if (operationType === "income") return "INCLUDE_IN_NET_PROFIT";

  return "AUTO";
}

export function buildFinanceCategoryTreatmentIndex(
  categories: FinanceCategoryForMetrics[]
) {
  const byTypeAndName = new Map<string, FinanceCategoryForMetrics>();
  const byName = new Map<string, FinanceCategoryForMetrics>();

  for (const category of categories) {
    byTypeAndName.set(
      makeCategoryKey(category.categoryType, category.name),
      category
    );

    if (!byName.has(normalizeText(category.name))) {
      byName.set(normalizeText(category.name), category);
    }
  }

  return {
    byTypeAndName,
    byName,
  };
}

export function getFinanceTreatmentInfo(
  treatment: FinanceProfitTreatment
): FinanceTreatmentInfo {
  return {
    treatment,
    label: treatmentLabels[treatment],
    description: treatmentDescriptions[treatment],
    className: treatmentClassNames[treatment],
  };
}

export function getFinanceTransactionTreatment(
  transaction: FinanceTransactionForMetrics,
  categoryIndex: ReturnType<typeof buildFinanceCategoryTreatmentIndex>
): FinanceTreatmentInfo {
  if (transaction.isInternalTransfer || transaction.operationType === "TRANSFER") {
    return getFinanceTreatmentInfo("IGNORE");
  }

  const category =
    categoryIndex.byTypeAndName.get(
      makeCategoryKey(transaction.operationType, transaction.category)
    ) ?? categoryIndex.byName.get(normalizeText(transaction.category));

  const fallback = fallbackTreatment({
    operationType: transaction.operationType,
    category: transaction.category,
    subcategory: transaction.subcategory,
    parentName: category?.parentName,
  });

  if (fallback === "CREDIT_RECEIVED") {
    return getFinanceTreatmentInfo("CREDIT_RECEIVED");
  }

  const explicitTreatment = category?.profitTreatment;

  const treatment =
    isAllowedTreatment(explicitTreatment) && explicitTreatment !== "AUTO"
      ? explicitTreatment
      : fallback;

  return getFinanceTreatmentInfo(treatment);
}

export function getFinanceTransactionCashEffect(
  transaction: FinanceTransactionForMetrics,
  categoryIndex: ReturnType<typeof buildFinanceCategoryTreatmentIndex>
) {
  if (transaction.isInternalTransfer || transaction.operationType === "TRANSFER") {
    return 0;
  }

  const treatment = getFinanceTransactionTreatment(
    transaction,
    categoryIndex
  ).treatment;

  if (treatment === "IGNORE") return 0;

  const amount = Math.abs(safeNumber(transaction.amount));

  if (
    transaction.operationType === "INCOME" ||
    treatment === "CREDIT_RECEIVED"
  ) {
    return amount;
  }

  return -amount;
}

export function getFinanceTransactionAccountEffect(
  transaction: FinanceTransactionForMetrics,
  categoryIndex: ReturnType<typeof buildFinanceCategoryTreatmentIndex>
) {
  const amount = Math.abs(safeNumber(transaction.amount));

  if (transaction.isInternalTransfer || transaction.operationType === "TRANSFER") {
    if (transaction.transferDirection === "TRANSFER_IN") return amount;
    if (transaction.transferDirection === "TRANSFER_OUT") return -amount;
    return 0;
  }

  return getFinanceTransactionCashEffect(transaction, categoryIndex);
}

export function calculateFinanceMetricsForRows(params: {
  transactions: FinanceTransactionForMetrics[];
  categories: FinanceCategoryForMetrics[];
}): FinanceMetricsResult {
  const categoryIndex = buildFinanceCategoryTreatmentIndex(params.categories);

  const result: FinanceMetricsResult = {
    cashIncome: 0,
    cashOutflow: 0,
    netCashFlow: 0,

    transferTotal: 0,

    netProfitIncome: 0,
    netProfitExpense: 0,
    netProfitImpact: 0,

    cashOnlyTotal: 0,

    creditReceived: 0,
    creditPrincipal: 0,
    creditInterest: 0,

    ownerWithdrawals: 0,

    ignoredTotal: 0,
  };

  for (const transaction of params.transactions) {
    const amount = Math.abs(safeNumber(transaction.amount));

    if (transaction.isInternalTransfer || transaction.operationType === "TRANSFER") {
      result.transferTotal += amount;
      continue;
    }

    const treatment = getFinanceTransactionTreatment(
      transaction,
      categoryIndex
    ).treatment;

    if (treatment === "IGNORE") {
      result.ignoredTotal += amount;
      continue;
    }

    const isIncome =
      transaction.operationType === "INCOME" || treatment === "CREDIT_RECEIVED";

    if (isIncome) {
      result.cashIncome += amount;

      if (treatment === "INCLUDE_IN_NET_PROFIT") {
        result.netProfitIncome += amount;
      }

      if (treatment === "CREDIT_RECEIVED") {
        result.creditReceived += amount;
      }

      continue;
    }

    result.cashOutflow += amount;

    if (treatment === "INCLUDE_IN_NET_PROFIT") {
      result.netProfitExpense += amount;
      continue;
    }

    if (treatment === "CASH_ONLY") {
      result.cashOnlyTotal += amount;
      continue;
    }

    if (treatment === "CREDIT_PRINCIPAL") {
      result.creditPrincipal += amount;
      continue;
    }

    if (treatment === "CREDIT_INTEREST") {
      result.creditInterest += amount;
      result.netProfitExpense += amount;
      continue;
    }

    if (treatment === "OWNER_WITHDRAWAL") {
      result.ownerWithdrawals += amount;
      continue;
    }

    if (treatment === "AUTO") {
      result.cashOnlyTotal += amount;
    }
  }

  result.netCashFlow = result.cashIncome - result.cashOutflow;
  result.netProfitImpact = result.netProfitIncome - result.netProfitExpense;

  return result;
}