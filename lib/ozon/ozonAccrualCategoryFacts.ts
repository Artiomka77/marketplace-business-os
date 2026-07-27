import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type InputRow = Record<string, unknown>;

type OzonFinancialCategory =
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

type OzonAccrualFact = {
  id: string;
  importSessionId: string;
  companyName: string | null;
  operationDate: string;
  dateFrom: string;
  dateTo: string;
  sourceOperationType: string | null;
  sourceOperationCode: string | null;
  sourceServiceName: string | null;
  category: OzonFinancialCategory;
  amount: number;
  includeInProfit: boolean;
  isCashFlowOnly: boolean;
  isCompensation: boolean;
};

const DAY_MS = 86_400_000;
const INSERT_CHUNK_SIZE = 1_000;

function normalizeText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[–—−]/g, "-")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHeader(value: unknown) {
  return normalizeText(value)
    .replace(/[.,:;]/g, "")
    .trim();
}

function findValue(
  row: InputRow,
  aliases: string[],
  fallbackIndex: number,
) {
  const normalizedAliases = aliases.map(normalizeHeader);

  for (const [key, value] of Object.entries(row)) {
    if (
      normalizedAliases.includes(normalizeHeader(key)) &&
      value !== undefined &&
      value !== null &&
      String(value).trim() !== ""
    ) {
      return value;
    }
  }

  return Object.values(row)[fallbackIndex];
}

function parseMoney(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  const normalized = String(value ?? "")
    .replace(/\u00a0/g, "")
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : 0;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseDateKey(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(
      Date.UTC(1899, 11, 30) + Math.round(value * DAY_MS),
    )
      .toISOString()
      .slice(0, 10);
  }

  const text = String(value ?? "").trim();
  let match = text.match(/^(\d{2})[.\-/](\d{2})[.\-/](\d{4})/);

  if (match) {
    return `${match[3]}-${match[2]}-${match[1]}`;
  }

  match = text.match(/^(\d{4})[.\-/](\d{2})[.\-/](\d{2})/);

  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toISOString().slice(0, 10);
}

function hasAnyToken(value: string, tokens: string[]) {
  return tokens.some((token) => value.includes(token));
}

function isEconomicComponent(group: string, operationType: string) {
  return (
    (group === "продажи" || group === "возвраты") &&
    (
      operationType === "выручка" ||
      operationType === "возврат выручки" ||
      operationType === "баллы за скидки" ||
      operationType === "программы партнеров"
    )
  );
}

function classifyAccrualFact(
  groupValue: unknown,
  operationTypeValue: unknown,
): OzonFinancialCategory | null {
  const group = normalizeText(groupValue);
  const operationType = normalizeText(operationTypeValue);
  const combined = `${group} ${operationType}`;

  if (!group && !operationType) {
    return null;
  }

  if (isEconomicComponent(group, operationType)) {
    return null;
  }

  if (
    hasAnyToken(combined, [
      "займ",
      "заем",
      "фактор",
      "loan",
      "factoring",
      "seller finance",
    ])
  ) {
    return "EXCLUDED_LOANS_FACTORING";
  }

  if (
    hasAnyToken(combined, [
      "кредит",
      "финансирован",
      "credit",
      "financing",
    ])
  ) {
    return "EXCLUDED_CREDIT";
  }

  if (
    hasAnyToken(combined, [
      "перевод",
      "перечисление",
      "transfer",
    ])
  ) {
    return "EXCLUDED_TRANSFER";
  }

  if (
    group.includes("компенсац") ||
    operationType.includes("компенсац")
  ) {
    return "OZON_COMPENSATION";
  }

  if (
    group.includes("вознаграждение ozon") ||
    operationType.includes("вознаграждение") ||
    operationType.includes("комисс")
  ) {
    return "OZON_COMMISSION";
  }

  if (
    group.includes("продвижение") ||
    group.includes("реклам") ||
    operationType.includes("реклам") ||
    operationType.includes("клик") ||
    operationType.includes("продвиж")
  ) {
    return "OZON_ADVERTISING";
  }

  if (
    group.includes("услуги доставки") ||
    operationType.includes("логист") ||
    operationType.includes("достав")
  ) {
    return "OZON_DELIVERY";
  }

  if (
    group.includes("услуги fbo") ||
    group.includes("услуги фбо") ||
    operationType.includes("fbo") ||
    operationType.includes("фбо") ||
    operationType.includes("склад") ||
    operationType.includes("хранен") ||
    operationType.includes("кросс-док")
  ) {
    return "OZON_FBO";
  }

  if (
    group.includes("услуги партнер") ||
    operationType.includes("партнер")
  ) {
    return "OZON_PARTNER_SERVICES";
  }

  return "OZON_OTHER_SERVICES";
}

function getFlags(category: OzonFinancialCategory) {
  const excluded = category.startsWith("EXCLUDED_");

  return {
    includeInProfit: !excluded,
    isCashFlowOnly: excluded,
    isCompensation: category === "OZON_COMPENSATION",
  };
}

function chunk<T>(rows: T[], size: number) {
  const result: T[][] = [];

  for (let index = 0; index < rows.length; index += size) {
    result.push(rows.slice(index, index + size));
  }

  return result;
}

async function insertFacts(
  tx: Prisma.TransactionClient,
  facts: OzonAccrualFact[],
) {
  for (const part of chunk(facts, INSERT_CHUNK_SIZE)) {
    await tx.$executeRawUnsafe(
      `
        INSERT INTO "OzonFinancialCategoryFact" (
          "id",
          "importSessionId",
          "companyName",
          "operationDate",
          "dateFrom",
          "dateTo",
          "source",
          "sourceOperationType",
          "sourceOperationCode",
          "sourceServiceName",
          "category",
          "amount",
          "includeInProfit",
          "isCashFlowOnly",
          "isCompensation"
        )
        SELECT
          x."id",
          x."importSessionId",
          x."companyName",
          x."operationDate"::timestamptz,
          x."dateFrom"::timestamptz,
          x."dateTo"::timestamptz,
          'OZON_ACCRUAL_REPORT',
          x."sourceOperationType",
          x."sourceOperationCode",
          x."sourceServiceName",
          x."category",
          x."amount"::numeric,
          x."includeInProfit",
          x."isCashFlowOnly",
          x."isCompensation"
        FROM jsonb_to_recordset($1::jsonb) AS x(
          "id" text,
          "importSessionId" text,
          "companyName" text,
          "operationDate" text,
          "dateFrom" text,
          "dateTo" text,
          "sourceOperationType" text,
          "sourceOperationCode" text,
          "sourceServiceName" text,
          "category" text,
          "amount" numeric,
          "includeInProfit" boolean,
          "isCashFlowOnly" boolean,
          "isCompensation" boolean
        )
      `,
      JSON.stringify(part),
    );
  }
}

export async function replaceOzonAccrualCategoryFacts(params: {
  data: InputRow[];
  importSessionId: string;
  companyName: string | null;
  expectedGrossExpense?: number;
}) {
  const reportRows = params.data
    .map((row) => {
      const date = parseDateKey(
        findValue(
          row,
          ["Дата начисления", "Дата операции", "operation_date"],
          1,
        ),
      );
      const groupValue = findValue(row, ["Группа услуг"], 2);
      const operationTypeValue = findValue(
        row,
        ["Тип начисления"],
        3,
      );
      const sourceAmount = parseMoney(
        findValue(
          row,
          ["Сумма итого, руб.", "Сумма итого", "Итого, руб."],
          15,
        ),
      );

      if (!date) {
        return null;
      }

      const group = normalizeText(groupValue);
      const operationType = normalizeText(operationTypeValue);
      const category = classifyAccrualFact(
        groupValue,
        operationTypeValue,
      );

      return {
        date,
        group:
          String(groupValue ?? "").trim() || null,
        operationType:
          String(operationTypeValue ?? "").trim() || null,
        sourceAmount,
        isEconomic: isEconomicComponent(group, operationType),
        category,
      };
    })
    .filter(
      (
        row,
      ): row is {
        date: string;
        group: string | null;
        operationType: string | null;
        sourceAmount: number;
        isEconomic: boolean;
        category: OzonFinancialCategory | null;
      } => Boolean(row),
    );

  if (reportRows.length === 0) {
    throw new Error(
      "Отчёт начислений Ozon не содержит строк с датами для финансовой сверки",
    );
  }

  const parsedRows = reportRows
    .filter(
      (
        row,
      ): row is typeof row & {
        category: OzonFinancialCategory;
      } =>
        Boolean(row.category) &&
        Math.abs(row.sourceAmount) >= 0.005,
    )
    .map((row) => ({
      date: row.date,
      group: row.group,
      operationType: row.operationType,
      category: row.category,
      amount: roundMoney(
        row.category === "OZON_COMPENSATION"
          ? row.sourceAmount
          : -row.sourceAmount,
      ),
    }));

  if (parsedRows.length === 0) {
    throw new Error(
      "Отчёт начислений Ozon не содержит строк расходов для финансовой сверки",
    );
  }

  const dates = reportRows.map((row) => row.date).sort();
  const dateFrom = dates[0];
  const dateTo = dates[dates.length - 1];

  const facts: OzonAccrualFact[] = parsedRows.map((row) => {
    const flags = getFlags(row.category);

    return {
      id: `ozac_${randomUUID()}`,
      importSessionId: params.importSessionId,
      companyName: params.companyName,
      operationDate: `${row.date}T12:00:00.000Z`,
      dateFrom: `${dateFrom}T00:00:00.000Z`,
      dateTo: `${dateTo}T23:59:59.999Z`,
      sourceOperationType: row.operationType,
      sourceOperationCode: row.group,
      sourceServiceName: row.operationType,
      category: row.category,
      amount: row.amount,
      ...flags,
    };
  });

  const economicTurnover = roundMoney(
    reportRows
      .filter((row) => row.isEconomic)
      .reduce((sum, row) => sum + row.sourceAmount, 0),
  );
  const reportSettlement = roundMoney(
    reportRows.reduce(
      (sum, row) => sum + row.sourceAmount,
      0,
    ),
  );
  const excludedCashFlow = roundMoney(
    reportRows
      .filter(
        (row) =>
          row.category?.startsWith("EXCLUDED_") ?? false,
      )
      .reduce((sum, row) => sum + row.sourceAmount, 0),
  );
  const canonicalGrossExpense = roundMoney(
    economicTurnover -
      (reportSettlement - excludedCashFlow),
  );
  const grossExpense = roundMoney(
    facts
      .filter((fact) => fact.includeInProfit)
      .reduce(
        (sum, fact) =>
          sum +
          (fact.category === "OZON_COMPENSATION"
            ? -fact.amount
            : fact.amount),
        0,
      ),
  );

  if (
    Math.abs(grossExpense - canonicalGrossExpense) > 0.01
  ) {
    throw new Error(
      `Контроль расходов Ozon не пройден: факты ` +
        `${grossExpense.toFixed(2)} ₽, финансовый баланс отчёта ` +
        `${canonicalGrossExpense.toFixed(2)} ₽`,
    );
  }

  if (
    params.expectedGrossExpense !== undefined &&
    (
      Math.abs(
        grossExpense - params.expectedGrossExpense,
      ) > 0.01 ||
      Math.abs(
        canonicalGrossExpense -
          params.expectedGrossExpense,
      ) > 0.01
    )
  ) {
    throw new Error(
      `Контроль расходов Ozon не пройден: ` +
        `${grossExpense.toFixed(2)} ₽ вместо ` +
        `${params.expectedGrossExpense.toFixed(2)} ₽`,
    );
  }

  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        `
          DELETE FROM "OzonFinancialCategoryFact"
          WHERE "companyName" IS NOT DISTINCT FROM $1
            AND "operationDate" >= $2::date
            AND "operationDate" < ($3::date + INTERVAL '1 day')
        `,
        params.companyName,
        dateFrom,
        dateTo,
      );

      await insertFacts(tx, facts);
    },
    {
      maxWait: 10_000,
      timeout: 120_000,
    },
  );

  return {
    savedFacts: facts.length,
    sourceRows: reportRows.length,
    dateFrom,
    dateTo,
    economicTurnover,
    reportSettlement,
    excludedCashFlow,
    canonicalGrossExpense,
    grossExpense,
  };
}
