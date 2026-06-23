import OpenAI from "openai";

type AiAnalysisResult = {
  text: string | null;
  error: string | null;
};

function toSafeNumber(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
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

function compactReportForAi(report: any) {
  return {
    dateLabel: String(report?.dateLabel ?? ""),
    periodLabel: String(report?.periodLabel ?? ""),
    totals: {
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
    },
    warnings: Array.isArray(report?.warnings) ? report.warnings : [],
    companies: Array.isArray(report?.companies)
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
      : [],
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