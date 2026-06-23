import OpenAI from "openai";

type AiAnalysisResult = {
  text: string | null;
  error: string | null;
};

type DrrZone = "no_data" | "working" | "control" | "check";

function toSafeNumber(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function classifyDrrByOrders(params: {
  ordersAmount: number;
  adSpend: number;
  drrByOrders: number;
}): DrrZone {
  if (params.ordersAmount <= 0 || params.adSpend <= 0) return "no_data";
  if (params.drrByOrders <= 7) return "working";
  if (params.drrByOrders <= 10) return "control";
  return "check";
}

function compactMarketplace(metrics: any) {
  return {
    marketplace: String(metrics?.marketplace ?? ""),
    ordersQty: toSafeNumber(metrics?.ordersQty),
    ordersAmount: toSafeNumber(metrics?.ordersAmount),
    ordersDataMissing: Boolean(metrics?.ordersDataMissing),
    ordersDataMissingReason: metrics?.ordersDataMissingReason ?? null,
    salesQty: toSafeNumber(metrics?.salesQty),
    salesAmount: toSafeNumber(metrics?.salesAmount),
    salesLabel: String(metrics?.salesLabel ?? ""),
    salesQtyIsReliable: Boolean(metrics?.salesQtyIsReliable),
    salesDataMissing: Boolean(metrics?.salesDataMissing),
    salesDataMissingReason: metrics?.salesDataMissingReason ?? null,
    adSpend: toSafeNumber(metrics?.adSpend),
    adSpendSource: String(metrics?.adSpendSource ?? ""),
    adDataMissing: Boolean(metrics?.adDataMissing),
    adDataMissingReason: metrics?.adDataMissingReason ?? null,
    drrByOrders: toSafeNumber(metrics?.drrByOrders),
    drrBySales: toSafeNumber(metrics?.drrBySales),
    stockQty: toSafeNumber(metrics?.stockQty),
  };
}

function buildMarketplaceAiFacts(report: any) {
  const items: Array<{
    label: string;
    marketplace: string;
    ordersAmount: number;
    salesAmount: number;
    adSpend: number;
    drrByOrders: number;
    drrBySales: number;
    drrZone: DrrZone;
    salesLabel: string;
    salesQtyIsReliable: boolean;
  }> = [];

  for (const company of Array.isArray(report?.companies) ? report.companies : []) {
    const companyName = String(company?.companyName ?? "");

    for (const [label, metrics] of [
      ["WB", company?.wb],
      ["Ozon", company?.ozon],
    ] as const) {
      const compact = compactMarketplace(metrics);
      const drrZone = classifyDrrByOrders({
        ordersAmount: compact.ordersAmount,
        adSpend: compact.adSpend,
        drrByOrders: compact.drrByOrders,
      });

      items.push({
        label: `${companyName} ${label}`,
        marketplace: compact.marketplace,
        ordersAmount: compact.ordersAmount,
        salesAmount: compact.salesAmount,
        adSpend: compact.adSpend,
        drrByOrders: compact.drrByOrders,
        drrBySales: compact.drrBySales,
        drrZone,
        salesLabel: compact.salesLabel,
        salesQtyIsReliable: compact.salesQtyIsReliable,
      });
    }
  }

  const withOrdersAndAds = items.filter(
    (item) => item.ordersAmount > 0 && item.adSpend > 0
  );

  const highestDrrByOrders =
    withOrdersAndAds.length > 0
      ? [...withOrdersAndAds].sort((a, b) => b.drrByOrders - a.drrByOrders)[0]
      : null;

  const highestDrrBySales =
    items.filter((item) => item.salesAmount > 0 && item.adSpend > 0).length > 0
      ? [...items]
          .filter((item) => item.salesAmount > 0 && item.adSpend > 0)
          .sort((a, b) => b.drrBySales - a.drrBySales)[0]
      : null;

  const advertisingItemsToCheck = withOrdersAndAds.filter(
    (item) => item.drrZone === "check"
  );

  const advertisingItemsToControl = withOrdersAndAds.filter(
    (item) => item.drrZone === "control"
  );

  const advertisingItemsInWorkingZone = withOrdersAndAds.filter(
    (item) => item.drrZone === "working"
  );

  return {
    marketplaceDrrZones: items.map((item) => ({
      label: item.label,
      drrByOrders: item.drrByOrders,
      drrBySales: item.drrBySales,
      drrZone: item.drrZone,
      salesLabel: item.salesLabel,
      salesQtyIsReliable: item.salesQtyIsReliable,
    })),
    highestDrrByOrders,
    highestDrrBySales,
    advertisingItemsToCheck,
    advertisingItemsToControl,
    advertisingItemsInWorkingZone,
  };
}

function compactReportForAi(report: any) {
  const totals = {
    ordersQty: toSafeNumber(report?.totals?.ordersQty),
    ordersAmount: toSafeNumber(report?.totals?.ordersAmount),
    salesQty: toSafeNumber(report?.totals?.salesQty),
    salesAmount: toSafeNumber(report?.totals?.salesAmount),
    adSpend: toSafeNumber(report?.totals?.adSpend),
    drrByOrders: toSafeNumber(report?.totals?.drrByOrders),
    drrBySales: toSafeNumber(report?.totals?.drrBySales),
    stockQty: toSafeNumber(report?.totals?.stockQty),
    cashIncome: toSafeNumber(report?.totals?.cashIncome),
    cashOutflow: toSafeNumber(report?.totals?.cashOutflow),
    netCashFlow: toSafeNumber(report?.totals?.netCashFlow),
    netProfitImpact: toSafeNumber(report?.totals?.netProfitImpact),
    ownerWithdrawals: toSafeNumber(report?.totals?.ownerWithdrawals),
  };

  const companies = Array.isArray(report?.companies)
    ? report.companies.map((company: any) => ({
        companyName: String(company?.companyName ?? ""),
        wb: compactMarketplace(company?.wb),
        ozon: compactMarketplace(company?.ozon),
        finance: {
          cashIncome: toSafeNumber(company?.finance?.cashIncome),
          cashOutflow: toSafeNumber(company?.finance?.cashOutflow),
          netCashFlow: toSafeNumber(company?.finance?.netCashFlow),
          netProfitImpact: toSafeNumber(company?.finance?.netProfitImpact),
          ownerWithdrawals: toSafeNumber(company?.finance?.ownerWithdrawals),
        },
      }))
    : [];

  const compactReport = {
    dateLabel: String(report?.dateLabel ?? ""),
    periodLabel: String(report?.periodLabel ?? ""),
    totals,
    warnings: Array.isArray(report?.warnings) ? report.warnings : [],
    companies,
  };

  return {
    ...compactReport,
    aiFacts: {
      cashFlowIsNegative: totals.netCashFlow < 0,
      profitImpactIsNegative: totals.netProfitImpact < 0,
      ownerWithdrawalsDuringNegativeCashFlow:
        totals.ownerWithdrawals > 0 && totals.netCashFlow < 0,
      salesToOrdersRatio:
        totals.ordersAmount > 0
          ? (totals.salesAmount / totals.ordersAmount) * 100
          : 0,
      drrRules: {
        working: "ДРР от заказов до 7% — рабочая зона",
        control: "ДРР от заказов больше 7% и до 10% — требует контроля",
        check: "ДРР от заказов выше 10% — нужно проверить рекламу",
      },
      ozonSalesQtyNote:
        "Для Ozon salesQty может быть 0, потому что в отчёте используется показатель 'Начисления', а не надёжное количество продаж.",
      ...buildMarketplaceAiFacts(compactReport),
    },
  };
}

function cleanAiText(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error ?? "Unknown OpenAI error");
}

export async function generateDailyReportAiAnalysis(
  report: unknown
): Promise<AiAnalysisResult> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return {
      text: "🤖 AI-анализ:\nНе выполнен: не найден OPENAI_API_KEY в переменных окружения.",
      error: "OPENAI_API_KEY is missing",
    };
  }

  const model = process.env.OPENAI_DAILY_REPORT_MODEL ?? "gpt-5.4-mini";

  const client = new OpenAI({
    apiKey,
    timeout: 25_000,
  });

  const compactReport = compactReportForAi(report);

  try {
    const response = await client.responses.create({
      model,
      store: false,
      max_output_tokens: 900,
      instructions: [
        "Ты AI-аналитик для собственника бизнеса на маркетплейсах Wildberries и Ozon.",
        "Пиши на русском языке, коротко и по делу.",
        "Ты получаешь только агрегированный JSON отчёта. Не проси сырые строки, не придумывай SKU, кампании, причины и цифры, которых нет в JSON.",
        "Цифры уже посчитала система. Не пересчитывай их как источник истины. Можно сравнивать и делать выводы только на основании переданных значений.",
        "Используй блок aiFacts как приоритетные подсказки для выводов.",
        "Не называй рекламный расход проблемой только потому, что сумма рекламы большая. Оценивай рекламу через ДРР.",
        "Если drrZone = working, не называй эту связку рекламной проблемой.",
        "Если drrZone = control, пиши: реклама требует контроля.",
        "Если drrZone = check, пиши: рекламу нужно проверить.",
        "Не связывай отрицательный ДДС с рекламой, если в JSON нет прямого подтверждения, что именно реклама стала причиной кассового минуса.",
        "Если ДДС отрицательный и есть вывод собственника, главным риском считай кассовый разрыв и вывод денег при минусовой кассе.",
        "Приоритетно выделяй самую слабую связку по ДРР от заказов и по ДРР от продаж/начислений.",
        "Учитывай, что Ozon salesQty может быть 0, потому что для Ozon сейчас используется показатель 'Начисления', а не надёжное количество продаж.",
        "Если данных недостаточно или есть признаки неполной загрузки, прямо напиши: нужно проверить источник данных.",
        "Не давай общие советы вроде 'улучшить продажи'. Давай управленческие действия на сегодня.",
        "Формат ответа строго такой:",
        "🤖 AI-анализ:",
        "1. Что произошло: ...",
        "2. Главный риск: ...",
        "3. Что проверить: ...",
        "4. Что сделать сегодня: ...",
        "5. Где возможная проблема в данных: ...",
        "Каждый пункт — 1 короткое предложение. Максимум 900 символов всего.",
      ].join("\n"),
      input: JSON.stringify(compactReport, null, 2),
    });

    const text = cleanAiText(response.output_text ?? "");

    if (!text) {
      return {
        text: "🤖 AI-анализ:\nНе выполнен: OpenAI вернул пустой ответ.",
        error: "OpenAI returned empty output_text",
      };
    }

    return {
      text,
      error: null,
    };
  } catch (error) {
    const message = getErrorMessage(error);

    return {
      text: `🤖 AI-анализ:\nНе выполнен: ${message}`,
      error: message,
    };
  }
}