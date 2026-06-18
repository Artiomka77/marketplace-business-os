export type FinanceProfitTreatment =
  | "AUTO"
  | "INCLUDE_IN_NET_PROFIT"
  | "CASH_ONLY"
  | "CREDIT_PRINCIPAL"
  | "CREDIT_INTEREST"
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
  isInternalTransfer?: boolean | null;
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
  OWNER_WITHDRAWAL: "Вывод собственника",
  IGNORE: "Не учитывать",
};

const treatmentDescriptions: Record<FinanceProfitTreatment, string> = {
  AUTO: "Роль определяется автоматически.",
  INCLUDE_IN_NET_PROFIT: "Участвует в ДДС и чистой прибыли.",
  CASH_ONLY: "Участвует только в ДДС, не влияет на чистую прибыль.",
  CREDIT_PRINCIPAL: "Тело кредита: участвует в ДДС, не влияет на прибыль.",
  CREDIT_INTEREST: "Проценты: участвует в ДДС и уменьшает чистую прибыль.",
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
    value === "OWNER_WITHDRAWAL" ||
    value === "IGNORE"
  );
}

function fallbackTreatment(params: {
  operationType: string;
  category: string;
  parentName?: string | null;
}) {
  const operationType = normalizeText(params.operationType);
  const text = normalizeText(`${params.category} ${params.parentName ?? ""}`);

  if (operationType === "transfer") return "IGNORE";

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
    text.includes("погашение займа")
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

  const explicitTreatment = category?.profitTreatment;

  const treatment =
    isAllowedTreatment(explicitTreatment) && explicitTreatment !== "AUTO"
      ? explicitTreatment
      : fallbackTreatment({
          operationType: transaction.operationType,
          category: transaction.category,
          parentName: category?.parentName,
        });

  return getFinanceTreatmentInfo(treatment);
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

    creditPrincipal: 0,
    creditInterest: 0,

    ownerWithdrawals: 0,

    ignoredTotal: 0,
  };

  for (const transaction of params.transactions) {
    const amount = Math.abs(safeNumber(transaction.amount));
    const operationType = transaction.operationType;
    const treatment = getFinanceTransactionTreatment(
      transaction,
      categoryIndex
    ).treatment;

    if (transaction.isInternalTransfer || operationType === "TRANSFER") {
      result.transferTotal += amount;
      continue;
    }

    if (treatment === "IGNORE") {
      result.ignoredTotal += amount;
      continue;
    }

    const isIncome = operationType === "INCOME";

    if (isIncome) {
      result.cashIncome += amount;

      if (treatment === "INCLUDE_IN_NET_PROFIT") {
        result.netProfitIncome += amount;
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