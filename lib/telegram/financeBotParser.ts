export type FinanceBotCompany = {
  name: string;
};

export type FinanceBotCategory = {
  name: string;
  categoryType: string;
  profitTreatment?: string | null;
};

export type FinanceBotAccount = {
  name: string;
  companyName: string;
};

export type FinanceBotContext = {
  companies: FinanceBotCompany[];
  categories: FinanceBotCategory[];
  accounts: FinanceBotAccount[];
};

export type ParsedFinanceOperation = {
  companyName: string;
  operationDate: string;
  operationType: string;
  category: string;
  amount: number;
  bankAccount: string | null;
  comment: string | null;
  project: string | null;
  counterparty: string | null;
  isInternalTransfer: boolean;
  rawText: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  warnings: string[];
};

export type FinanceBotParseResult =
  | {
      ok: true;
      operation: ParsedFinanceOperation;
    }
  | {
      ok: false;
      message: string;
      examples: string[];
    };

const OPERATION_TYPE_BY_CATEGORY_TYPE: Record<string, string> = {
  INCOME: "INCOME",
  EXPENSE: "EXPENSE",
  TRANSFER: "TRANSFER",
  FINANCING: "FINANCING",
  PERSONAL: "PERSONAL",
};

function normalize(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}\s.,-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCompact(value: unknown) {
  return normalize(value).replace(/\s+/g, "");
}

function formatTodayIso() {
  const now = new Date();

  return new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0)
  ).toISOString();
}

function parseAmount(text: string) {
  const matches = Array.from(
    text.matchAll(/(^|\s)(\d[\d\s]*(?:[,.]\d{1,2})?)(?=\s|₽|руб|р\.|$)/gi)
  );

  const amounts = matches
    .map((match) => {
      const raw = match[2];
      const number = Number(
        raw
          .replace(/\s/g, "")
          .replace(",", ".")
          .replace(/[^\d.-]/g, "")
      );

      return {
        raw,
        number,
      };
    })
    .filter((item) => Number.isFinite(item.number) && item.number > 0);

  if (amounts.length === 0) {
    return null;
  }

  // Берём самую крупную числовую величину: это безопаснее, если в тексте случайно есть дата.
  return amounts.sort((a, b) => b.number - a.number)[0];
}

function detectCompany(text: string, companies: FinanceBotCompany[]) {
  const normalizedText = normalize(text);

  for (const company of companies) {
    const companyName = normalize(company.name);
    const companyWithoutIp = companyName.replace(/^ип\s+/, "");

    if (
      normalizedText.includes(companyName) ||
      (companyWithoutIp && normalizedText.includes(companyWithoutIp))
    ) {
      return company.name;
    }
  }

  if (normalizedText.includes("петров")) {
    return (
      companies.find((company) => normalize(company.name).includes("петров"))
        ?.name ?? companies[0]?.name
    );
  }

  if (normalizedText.includes("лебед")) {
    return (
      companies.find((company) => normalize(company.name).includes("лебед"))
        ?.name ?? companies[0]?.name
    );
  }

  return companies[0]?.name ?? "ИП Петров";
}

function detectOperationType(text: string) {
  const normalizedText = normalize(text);

  if (
    normalizedText.includes("перевод") ||
    normalizedText.includes("между счет")
  ) {
    return "TRANSFER";
  }

  if (
    normalizedText.includes("вывод") ||
    normalizedText.includes("личн") ||
    normalizedText.includes("собственник")
  ) {
    return "PERSONAL";
  }

  if (
    normalizedText.includes("тело кредит") ||
    normalizedText.includes("погашение кредит") ||
    normalizedText.includes("получение кредит") ||
    normalizedText.includes("получил кредит") ||
    normalizedText.includes("займ") ||
    normalizedText.includes("заем")
  ) {
    return "FINANCING";
  }

  if (
    normalizedText.includes("поступ") ||
    normalizedText.includes("пришло") ||
    normalizedText.includes("приход") ||
    normalizedText.includes("выручк") ||
    normalizedText.includes("оплата от покуп")
  ) {
    return "INCOME";
  }

  if (
    normalizedText.includes("расход") ||
    normalizedText.includes("оплат") ||
    normalizedText.includes("закуп") ||
    normalizedText.includes("реклам") ||
    normalizedText.includes("фулф") ||
    normalizedText.includes("упаков") ||
    normalizedText.includes("аренд") ||
    normalizedText.includes("налог") ||
    normalizedText.includes("интернет") ||
    normalizedText.includes("связь") ||
    normalizedText.includes("процент")
  ) {
    return "EXPENSE";
  }

  return "EXPENSE";
}

function categoryTypeMatchesOperationType(
  category: FinanceBotCategory,
  operationType: string
) {
  return OPERATION_TYPE_BY_CATEGORY_TYPE[category.categoryType] === operationType;
}

function categoryScore(text: string, category: FinanceBotCategory) {
  const normalizedText = normalize(text);
  const categoryName = normalize(category.name);

  if (!categoryName) return 0;
  if (normalizedText.includes(categoryName)) return 100;

  const tokens = categoryName
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);

  return tokens.reduce((score, token) => {
    return normalizedText.includes(token) ? score + 10 : score;
  }, 0);
}

function findCategoryByIncludes(
  categories: FinanceBotCategory[],
  operationType: string,
  variants: string[]
) {
  const byOperationType = categories.filter((category) =>
    categoryTypeMatchesOperationType(category, operationType)
  );

  const searchIn = byOperationType.length > 0 ? byOperationType : categories;

  for (const variant of variants) {
    const normalizedVariant = normalize(variant);

    const found = searchIn.find((category) =>
      normalize(category.name).includes(normalizedVariant)
    );

    if (found) return found.name;
  }

  return null;
}

function detectCategory(
  text: string,
  operationType: string,
  categories: FinanceBotCategory[]
) {
  const normalizedText = normalize(text);
  const categoriesForType = categories.filter((category) =>
    categoryTypeMatchesOperationType(category, operationType)
  );

  const scored = categoriesForType
    .map((category) => ({
      category,
      score: categoryScore(text, category),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored[0]) {
    return {
      name: scored[0].category.name,
      confidence: scored[0].score >= 20 ? "HIGH" : "MEDIUM",
    } as const;
  }

  if (normalizedText.includes("закуп")) {
    const name = findCategoryByIncludes(categories, operationType, ["закуп"]);
    if (name) return { name, confidence: "HIGH" } as const;
  }

  if (normalizedText.includes("реклам")) {
    const name = findCategoryByIncludes(categories, operationType, ["реклам"]);
    if (name) return { name, confidence: "HIGH" } as const;
  }

  if (normalizedText.includes("фулф")) {
    const name = findCategoryByIncludes(categories, operationType, ["фулф"]);
    if (name) return { name, confidence: "HIGH" } as const;
  }

  if (normalizedText.includes("упаков")) {
    const name = findCategoryByIncludes(categories, operationType, ["упаков"]);
    if (name) return { name, confidence: "HIGH" } as const;
  }

  if (normalizedText.includes("связь") || normalizedText.includes("интернет")) {
    const name = findCategoryByIncludes(categories, operationType, [
      "связь",
      "интернет",
    ]);
    if (name) return { name, confidence: "HIGH" } as const;
  }

  if (normalizedText.includes("аренд")) {
    const name = findCategoryByIncludes(categories, operationType, ["аренд"]);
    if (name) return { name, confidence: "HIGH" } as const;
  }

  if (normalizedText.includes("бухгалт")) {
    const name = findCategoryByIncludes(categories, operationType, ["бухгалт"]);
    if (name) return { name, confidence: "HIGH" } as const;
  }

  if (normalizedText.includes("налог") || normalizedText.includes("взнос")) {
    const name = findCategoryByIncludes(categories, operationType, [
      "налог",
      "взнос",
    ]);
    if (name) return { name, confidence: "HIGH" } as const;
  }

  if (
    normalizedText.includes("тело кредит") ||
    normalizedText.includes("погашение кредит")
  ) {
    const name = findCategoryByIncludes(categories, operationType, [
      "тело кредита",
      "оплата тела",
      "погашение",
    ]);
    if (name) return { name, confidence: "HIGH" } as const;
  }

  if (normalizedText.includes("процент") && normalizedText.includes("кредит")) {
    const name = findCategoryByIncludes(categories, operationType, [
      "проценты",
      "процент",
    ]);
    if (name) return { name, confidence: "HIGH" } as const;
  }

  if (normalizedText.includes("получ") && normalizedText.includes("кредит")) {
    const name = findCategoryByIncludes(categories, operationType, [
      "получение кредита",
      "кредит",
    ]);
    if (name) return { name, confidence: "MEDIUM" } as const;
  }

  if (
    normalizedText.includes("поступ") ||
    normalizedText.includes("пришло") ||
    normalizedText.includes("выруч")
  ) {
    const name = findCategoryByIncludes(categories, operationType, [
      "поступ",
      "пришло",
      "выруч",
      "продаж",
    ]);
    if (name) return { name, confidence: "MEDIUM" } as const;
  }

  if (normalizedText.includes("вывод")) {
    const name = findCategoryByIncludes(categories, operationType, ["вывод"]);
    if (name) return { name, confidence: "HIGH" } as const;
  }

  if (normalizedText.includes("перевод")) {
    const name = findCategoryByIncludes(categories, operationType, ["перевод"]);
    if (name) return { name, confidence: "HIGH" } as const;
  }

  const fallback = categoriesForType[0] ?? categories[0];

  return {
    name: fallback?.name ?? "Без статьи",
    confidence: "LOW",
  } as const;
}

function detectBankAccount(
  text: string,
  companyName: string,
  accounts: FinanceBotAccount[]
) {
  const normalizedText = normalize(text);
  const normalizedCompactText = normalizeCompact(text);

  const companyAccounts = accounts.filter(
    (account) => normalize(account.companyName) === normalize(companyName)
  );

  const searchIn = companyAccounts.length > 0 ? companyAccounts : accounts;

  for (const account of searchIn) {
    const accountName = normalize(account.name);
    const accountCompactName = normalizeCompact(account.name);

    if (
      accountName &&
      (normalizedText.includes(accountName) ||
        normalizedCompactText.includes(accountCompactName))
    ) {
      return account.name;
    }
  }

  const aliasChecks: { alias: string; includes: string[] }[] = [
    { alias: "сбер", includes: ["сбер"] },
    { alias: "озон", includes: ["озон", "ozon"] },
    { alias: "альфа", includes: ["альфа", "alfa"] },
    { alias: "тиньк", includes: ["тиньк", "tink"] },
    { alias: "нал", includes: ["нал", "касс"] },
  ];

  for (const check of aliasChecks) {
    if (!check.includes.some((alias) => normalizedText.includes(alias))) {
      continue;
    }

    const account = searchIn.find((item) => {
      const accountName = normalize(item.name);
      return check.includes.some((alias) => accountName.includes(alias));
    });

    if (account) return account.name;
  }

  return searchIn[0]?.name ?? null;
}

function detectProject(text: string) {
  const normalizedText = normalize(text);

  if (normalizedText.includes("озон") || normalizedText.includes("ozon")) {
    return "Ozon";
  }

  if (normalizedText.includes("wb") || normalizedText.includes("вайлд")) {
    return "WB";
  }

  if (normalizedText.includes("кредит")) {
    return "Кредиты";
  }

  return null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeWords(text: string, words: string[]) {
  let result = ` ${text} `;

  for (const word of words) {
    const normalizedWord = normalize(word);

    if (!normalizedWord) continue;

    const tokens = normalizedWord
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length >= 3);

    for (const token of tokens) {
      result = result.replace(new RegExp(`\\b${escapeRegExp(token)}\\b`, "giu"), " ");
    }
  }

  return result.replace(/\s+/g, " ").trim();
}

function buildComment(params: {
  originalText: string;
  amountRaw: string;
  companyName: string;
  categoryName: string;
  bankAccount: string | null;
}) {
  const operationWords = [
    "закуп",
    "расход",
    "поступило",
    "поступление",
    "пришло",
    "выручка",
    "вывод",
    "перевод",
    "тело",
    "кредит",
    "проценты",
    "оплата",
    "петров",
    "лебедева",
    "ип",
    "сбер",
    "сбербанк",
    "карта",
    "озон",
    "ozon",
    "wb",
    "альфа",
    "нал",
    "касса",
  ];

  const withoutAmount = params.originalText.replace(params.amountRaw, " ");
  const cleaned = removeWords(withoutAmount, [
    params.companyName,
    params.categoryName,
    params.bankAccount ?? "",
    ...operationWords,
  ]);

  return cleaned || null;
}

export function parseTelegramFinanceMessage(
  text: string,
  context: FinanceBotContext
): FinanceBotParseResult {
  const cleanedText = text.replace(/^\/\w+\s*/g, "").trim();

  if (!cleanedText) {
    return {
      ok: false,
      message: "Напишите операцию обычным текстом.",
      examples: [
        "закуп 15000 петров сбер упаковка",
        "поступило 4881996 лебедева ozon выручка",
        "вывод 50000 продукты сбер",
      ],
    };
  }

  const amount = parseAmount(cleanedText);

  if (!amount) {
    return {
      ok: false,
      message: "Не вижу сумму. Напишите сумму числом.",
      examples: [
        "закуп 15000",
        "реклама 5000 петров",
        "проценты кредит 4229 альфа",
      ],
    };
  }

  const companyName = detectCompany(cleanedText, context.companies);
  const operationType = detectOperationType(cleanedText);
  const category = detectCategory(
    cleanedText,
    operationType,
    context.categories
  );
  const bankAccount = detectBankAccount(
    cleanedText,
    companyName,
    context.accounts
  );
  const project = detectProject(cleanedText);
  const comment = buildComment({
    originalText: cleanedText,
    amountRaw: amount.raw,
    companyName,
    categoryName: category.name,
    bankAccount,
  });

  const warnings: string[] = [];

  if (category.confidence === "LOW") {
    warnings.push("Статья определена неуверенно. Проверьте перед сохранением.");
  }

  if (!bankAccount) {
    warnings.push("Счёт не найден. Операция сохранится без счёта.");
  }

  const isInternalTransfer =
    operationType === "TRANSFER" || normalize(category.name).includes("перевод");

  return {
    ok: true,
    operation: {
      companyName,
      operationDate: formatTodayIso(),
      operationType,
      category: category.name,
      amount: Math.abs(amount.number),
      bankAccount,
      comment: comment || null,
      project,
      counterparty: null,
      isInternalTransfer,
      rawText: text,
      confidence: category.confidence,
      warnings,
    },
  };
}
